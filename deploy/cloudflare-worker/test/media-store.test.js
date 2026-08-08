import assert from "node:assert/strict";
import test from "node:test";

import {
  deletePrivateMedia,
  mediaObjectKey,
  readPrivateMedia,
  storePrivateMedia,
} from "../src/media-store.js";


const ACTOR_ID = `sg_actor_${"a".repeat(32)}`;
const CASE_ID = `sg_case_${"b".repeat(32)}`;
const VERSION_ID = `sg_ver_${"c".repeat(32)}`;
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");


function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options = {}) {
      objects.set(key, {
        bytes: new Uint8Array(await new Response(value).arrayBuffer()),
        customMetadata: options.customMetadata || {},
      });
    },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        body: stored.bytes,
        customMetadata: stored.customMetadata,
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}


test("private media is encrypted at the application layer and round trips exactly", async () => {
  const bucket = memoryBucket();
  const plain = new TextEncoder().encode("real newsroom image bytes");
  const env = {
    MEDIA_BUCKET: bucket,
    MEDIA_ENCRYPTION_KEY_B64: KEY_B64,
    MEDIA_ENCRYPTION_KEY_VERSION: "media-2026-01",
    MEDIA_RETENTION_DAYS: "7",
  };

  const custody = await storePrivateMedia(env, {
    actorId: ACTOR_ID,
    caseId: CASE_ID,
    versionId: VERSION_ID,
    bytes: plain,
    contentType: "image/jpeg",
    fileName: "camera.jpg",
    expectedSha256: "0481362557ef98f3cbfb6c083a7b88788887fcbf35daaaf428478cd98d95bd15",
    now: "2026-08-08T04:00:00.000Z",
  });

  assert.equal(custody.status, "encrypted_private");
  assert.equal(custody.encryption.algorithm, "AES-256-GCM");
  assert.equal(custody.retention_until, "2026-08-15T04:00:00.000Z");
  const stored = bucket.objects.get(mediaObjectKey(ACTOR_ID, CASE_ID, VERSION_ID));
  assert.notDeepEqual(stored.bytes, plain);
  assert.equal(new TextDecoder().decode(stored.bytes).includes("newsroom"), false);

  const recovered = await readPrivateMedia(env, {
    actorId: ACTOR_ID,
    caseId: CASE_ID,
    versionId: VERSION_ID,
    custody,
  });
  assert.deepEqual(recovered.bytes, plain);
  assert.equal(recovered.contentType, "image/jpeg");
  assert.equal(recovered.fileName, "camera.jpg");

  await deletePrivateMedia(env, { actorId: ACTOR_ID, caseId: CASE_ID, versionId: VERSION_ID });
  assert.equal(bucket.objects.size, 0);
});


test("private media storage rejects digest mismatch and missing encryption configuration", async () => {
  const bucket = memoryBucket();
  const bytes = new Uint8Array([1, 2, 3]);

  await assert.rejects(
    storePrivateMedia({ MEDIA_BUCKET: bucket, MEDIA_ENCRYPTION_KEY_B64: KEY_B64 }, {
      actorId: ACTOR_ID,
      caseId: CASE_ID,
      versionId: VERSION_ID,
      bytes,
      contentType: "image/png",
      fileName: "test.png",
      expectedSha256: "0".repeat(64),
    }),
    /digest/i,
  );
  await assert.rejects(
    storePrivateMedia({ MEDIA_BUCKET: bucket }, {
      actorId: ACTOR_ID,
      caseId: CASE_ID,
      versionId: VERSION_ID,
      bytes,
      contentType: "image/png",
      fileName: "test.png",
    }),
    /encryption/i,
  );
});


test("private media refuses tampered ciphertext", async () => {
  const bucket = memoryBucket();
  const env = {
    MEDIA_BUCKET: bucket,
    MEDIA_ENCRYPTION_KEY_B64: KEY_B64,
    MEDIA_ENCRYPTION_KEY_VERSION: "media-2026-01",
  };
  const custody = await storePrivateMedia(env, {
    actorId: ACTOR_ID,
    caseId: CASE_ID,
    versionId: VERSION_ID,
    bytes: new Uint8Array([4, 5, 6]),
    contentType: "image/webp",
    fileName: "test.webp",
  });
  const key = mediaObjectKey(ACTOR_ID, CASE_ID, VERSION_ID);
  bucket.objects.get(key).bytes[0] ^= 0xff;

  await assert.rejects(
    readPrivateMedia(env, { actorId: ACTOR_ID, caseId: CASE_ID, versionId: VERSION_ID, custody }),
    /decrypt|integrity/i,
  );
});
