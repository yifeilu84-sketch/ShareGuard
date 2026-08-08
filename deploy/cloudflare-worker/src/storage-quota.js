const VERSION_ID_PATTERN = /^sg_ver_[0-9a-f]{32}$/;
const DAY_MS = 86_400_000;
const LEDGER_KEY = "mediaReservations";
const DAY_BUCKET_KEY = "mediaDayBucket";
const DAY_COUNT_KEY = "mediaDayCount";


function positiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}


function limits(env) {
  const maxObjects = positiveInteger(env.MEDIA_GLOBAL_DAILY_OBJECTS);
  const maxBytes = positiveInteger(env.MEDIA_GLOBAL_ACTIVE_BYTES);
  const retentionDays = positiveInteger(env.MEDIA_RETENTION_DAYS);
  if (!maxObjects || !maxBytes || !retentionDays) {
    throw new Error("storage quota configuration unavailable");
  }
  return { maxObjects, maxBytes, retentionDays };
}


function activeReservations(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => (
    item &&
    VERSION_ID_PATTERN.test(String(item.reservation_id || "")) &&
    Number.isSafeInteger(item.bytes) &&
    item.bytes > 0 &&
    Number.isFinite(item.reserved_at) &&
    Number.isFinite(item.expires_at)
  ));
}


function usage(reservations, dayCount, configured) {
  return {
    objects: dayCount,
    bytes: reservations.reduce((total, item) => total + item.bytes, 0),
    max_objects: configured.maxObjects,
    max_bytes: configured.maxBytes,
  };
}


function retryAfter(now, reason) {
  if (reason === "bytes") return 86_400;
  const target = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
  return Math.max(1, Math.min(86_400, Math.ceil((target - now) / 1000)));
}


function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}


async function requestPayload(request) {
  try {
    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("invalid payload");
    }
    return payload;
  } catch {
    return null;
  }
}


export class ShareGuardStorageQuota {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || !new Set(["/reserve", "/release"]).has(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    const payload = await requestPayload(request);
    if (!payload || !VERSION_ID_PATTERN.test(String(payload.reservation_id || ""))) {
      return json({ error: "invalid storage quota request" }, 400);
    }
    let configured;
    try {
      configured = limits(this.env);
    } catch {
      return json({ error: "storage quota configuration unavailable" }, 503);
    }
    const now = Date.now();
    const dayBucket = Math.floor(now / DAY_MS);

    if (url.pathname === "/release") {
      const outcome = await this.state.storage.transaction(async transaction => {
        const stored = Object.fromEntries(await transaction.get([
          LEDGER_KEY,
          DAY_BUCKET_KEY,
          DAY_COUNT_KEY,
        ]));
        const current = activeReservations(stored[LEDGER_KEY]);
        const dayCount = stored[DAY_BUCKET_KEY] === dayBucket &&
          Number.isSafeInteger(stored[DAY_COUNT_KEY]) && stored[DAY_COUNT_KEY] >= 0
          ? stored[DAY_COUNT_KEY]
          : 0;
        const remaining = current.filter(
          item => item.reservation_id !== payload.reservation_id,
        );
        await transaction.put({
          [LEDGER_KEY]: remaining,
          [DAY_BUCKET_KEY]: dayBucket,
          [DAY_COUNT_KEY]: dayCount,
        });
        return {
          released: remaining.length !== current.length,
          usage: usage(remaining, dayCount, configured),
        };
      });
      return json(outcome);
    }

    const bytes = positiveInteger(payload.bytes);
    if (!bytes) return json({ error: "invalid storage quota request" }, 400);
    const outcome = await this.state.storage.transaction(async transaction => {
      const stored = Object.fromEntries(await transaction.get([
        LEDGER_KEY,
        DAY_BUCKET_KEY,
        DAY_COUNT_KEY,
      ]));
      const current = activeReservations(stored[LEDGER_KEY]);
      const dayCount = stored[DAY_BUCKET_KEY] === dayBucket &&
        Number.isSafeInteger(stored[DAY_COUNT_KEY]) && stored[DAY_COUNT_KEY] >= 0
        ? stored[DAY_COUNT_KEY]
        : 0;
      const existing = current.find(item => item.reservation_id === payload.reservation_id);
      if (existing) {
        if (existing.bytes !== bytes) {
          return { conflict: true };
        }
        await transaction.put({
          [LEDGER_KEY]: current,
          [DAY_BUCKET_KEY]: dayBucket,
          [DAY_COUNT_KEY]: dayCount,
        });
        return {
          allowed: true,
          reservation: existing,
          usage: usage(current, dayCount, configured),
        };
      }
      const currentUsage = usage(current, dayCount, configured);
      if (currentUsage.objects >= configured.maxObjects) {
        await transaction.put({
          [LEDGER_KEY]: current,
          [DAY_BUCKET_KEY]: dayBucket,
          [DAY_COUNT_KEY]: dayCount,
        });
        return {
          allowed: false,
          reason: "objects",
          retry_after: retryAfter(now, "objects"),
          usage: currentUsage,
        };
      }
      if (currentUsage.bytes + bytes > configured.maxBytes) {
        await transaction.put({
          [LEDGER_KEY]: current,
          [DAY_BUCKET_KEY]: dayBucket,
          [DAY_COUNT_KEY]: dayCount,
        });
        return {
          allowed: false,
          reason: "bytes",
          retry_after: retryAfter(now, "bytes"),
          usage: currentUsage,
        };
      }
      const reservation = {
        reservation_id: payload.reservation_id,
        bytes,
        reserved_at: now,
        day_bucket: dayBucket,
        expires_at: now + (configured.retentionDays * DAY_MS),
      };
      const next = [...current, reservation];
      const nextDayCount = dayCount + 1;
      await transaction.put({
        [LEDGER_KEY]: next,
        [DAY_BUCKET_KEY]: dayBucket,
        [DAY_COUNT_KEY]: nextDayCount,
      });
      return {
        allowed: true,
        reservation,
        usage: usage(next, nextDayCount, configured),
      };
    });

    if (outcome.conflict) {
      return json({ error: "storage quota reservation conflict" }, 409);
    }
    return json(outcome, outcome.allowed ? 200 : 507);
  }
}
