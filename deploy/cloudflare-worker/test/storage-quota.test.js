import assert from "node:assert/strict";
import test from "node:test";

import * as worker from "../src/index.js";


function memoryStorage() {
  const values = new Map();
  const storage = {
    async get(key) {
      if (Array.isArray(key)) {
        return new Map(key.filter(item => values.has(item)).map(item => [item, values.get(item)]));
      }
      return values.get(key);
    },
    async put(key, value) {
      if (typeof key === "object" && value === undefined) {
        for (const [itemKey, itemValue] of Object.entries(key)) values.set(itemKey, itemValue);
      } else {
        values.set(key, value);
      }
    },
    async delete(key) {
      return values.delete(key);
    },
    async transaction(callback) {
      return callback(storage);
    },
  };
  return storage;
}


function quotaObject(overrides = {}) {
  return new worker.ShareGuardStorageQuota(
    { storage: memoryStorage() },
    {
      MEDIA_GLOBAL_DAILY_OBJECTS: "2",
      MEDIA_GLOBAL_ACTIVE_BYTES: "10",
      MEDIA_RETENTION_DAYS: "7",
      ...overrides,
    },
  );
}


async function command(object, path, payload) {
  return object.fetch(new Request(`https://shareguard-storage-quota.internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }));
}


test("storage quota reservations are idempotent and enforce global object and byte limits", async () => {
  const object = quotaObject();
  const firstId = `sg_ver_${"a".repeat(32)}`;
  const secondId = `sg_ver_${"b".repeat(32)}`;
  const thirdId = `sg_ver_${"c".repeat(32)}`;

  const first = await command(object, "/reserve", {
    reservation_id: firstId,
    bytes: 4,
  });
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).usage, {
    objects: 1,
    bytes: 4,
    max_objects: 2,
    max_bytes: 10,
  });

  const repeated = await command(object, "/reserve", {
    reservation_id: firstId,
    bytes: 4,
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).usage.objects, 1);

  assert.equal((await command(object, "/reserve", {
    reservation_id: secondId,
    bytes: 6,
  })).status, 200);

  const objectBlocked = await command(object, "/reserve", {
    reservation_id: thirdId,
    bytes: 1,
  });
  assert.equal(objectBlocked.status, 507);
  assert.equal((await objectBlocked.json()).reason, "objects");

  const released = await command(object, "/release", {
    reservation_id: secondId,
  });
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, true);

  const stillObjectBlocked = await command(object, "/reserve", {
    reservation_id: thirdId,
    bytes: 7,
  });
  assert.equal(stillObjectBlocked.status, 507);
  assert.equal((await stillObjectBlocked.json()).reason, "objects");
});


test("storage quota rejects reservations above the rolling active-byte ceiling", async () => {
  const object = quotaObject({ MEDIA_GLOBAL_DAILY_OBJECTS: "100" });
  assert.equal((await command(object, "/reserve", {
    reservation_id: `sg_ver_${"f".repeat(32)}`,
    bytes: 4,
  })).status, 200);

  const blocked = await command(object, "/reserve", {
    reservation_id: `sg_ver_${"0".repeat(32)}`,
    bytes: 7,
  });
  assert.equal(blocked.status, 507);
  assert.equal((await blocked.json()).reason, "bytes");
});


test("releasing stored bytes does not reset the cumulative UTC-day object limit", async () => {
  const object = quotaObject({ MEDIA_GLOBAL_DAILY_OBJECTS: "1" });
  const firstId = `sg_ver_${"d".repeat(32)}`;
  const secondId = `sg_ver_${"e".repeat(32)}`;

  assert.equal((await command(object, "/reserve", {
    reservation_id: firstId,
    bytes: 1,
  })).status, 200);
  assert.equal((await command(object, "/release", {
    reservation_id: firstId,
  })).status, 200);

  const blocked = await command(object, "/reserve", {
    reservation_id: secondId,
    bytes: 1,
  });
  assert.equal(blocked.status, 507);
  assert.equal((await blocked.json()).reason, "objects");
});


test("expired retention metadata stays counted until R2 deletion is confirmed", async () => {
  const storage = memoryStorage();
  await storage.put("mediaReservations", [{
    reservation_id: `sg_ver_${"1".repeat(32)}`,
    bytes: 4,
    reserved_at: Date.now() - 691_200_000,
    day_bucket: Math.floor((Date.now() - 691_200_000) / 86_400_000),
    expires_at: Date.now() - 86_400_000,
  }]);
  const object = new worker.ShareGuardStorageQuota(
    { storage },
    {
      MEDIA_GLOBAL_DAILY_OBJECTS: "100",
      MEDIA_GLOBAL_ACTIVE_BYTES: "10",
      MEDIA_RETENTION_DAYS: "7",
    },
  );

  const blocked = await command(object, "/reserve", {
    reservation_id: `sg_ver_${"2".repeat(32)}`,
    bytes: 7,
  });
  assert.equal(blocked.status, 507);
  assert.equal((await blocked.json()).reason, "bytes");
});
