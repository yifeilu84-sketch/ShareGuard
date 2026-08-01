import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { consumeQuotaState, handleRequest } from "../src/index.js";


function allowAllLimiter() {
  const keys = [];
  return {
    keys,
    binding: {
      idFromName(key) {
        keys.push(key);
        return key;
      },
      get() {
        return {
          fetch: async () => new Response(
            JSON.stringify({ allowed: true }),
            { status: 200 },
          ),
        };
      },
    },
  };
}


const defaultLimiter = allowAllLimiter();
const EDGE_SHARED_SECRET = "edge-secret-for-tests";
const AUTHORIZATION = "Basic dGVzdDp0ZXN0";
const env = {
  ALLOWED_ORIGIN: "https://shareguard.systems",
  MODAL_ORIGIN: "https://private-upstream.example",
  EDGE_SHARED_SECRET,
  EDGE_AUTH_HMAC: createHmac("sha256", EDGE_SHARED_SECRET)
    .update(AUTHORIZATION)
    .digest("hex"),
  RATE_LIMITER: defaultLimiter.binding,
};


function allowedReadyRequest() {
  return new Request("https://api.shareguard.systems/v1/ready", {
    headers: {
      Origin: env.ALLOWED_ORIGIN,
      Authorization: AUTHORIZATION,
      "CF-Connecting-IP": "203.0.113.7",
    },
  });
}


test("rejects an unapproved browser origin", async () => {
  let called = false;
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/ready", {
      headers: { Origin: "https://example.com" },
    }),
    env,
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );

  assert.equal(response.status, 403);
  assert.equal(called, false);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});


test("rejects paths and methods outside the public API", async () => {
  const badPath = await handleRequest(
    new Request("https://api.shareguard.systems/internal/config"),
    env,
    async () => new Response("unexpected"),
  );
  const badMethod = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "GET",
    }),
    env,
    async () => new Response("unexpected"),
  );

  assert.equal(badPath.status, 404);
  assert.equal(badMethod.status, 405);
});


test("forwards approved requests and strips spoofable identity headers", async () => {
  let forwarded;
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze?case=demo", {
      method: "POST",
      headers: {
        Origin: env.ALLOWED_ORIGIN,
        Authorization: AUTHORIZATION,
        "Content-Type": "image/jpeg",
        "CF-Connecting-IP": "203.0.113.7",
        "Cf-Access-Authenticated-User-Email": "spoof@example.com",
        "Cf-Access-Jwt-Assertion": "spoofed-token",
        "X-Forwarded-For": "198.51.100.10",
        "X-ShareGuard-Client-Id": "spoofed-client",
        "X-ShareGuard-Edge-Secret": "spoofed-secret",
        "X-ShareGuard-Edge-Timestamp": "1",
        "X-ShareGuard-Edge-Signature": "0".repeat(64),
      },
      body: new Uint8Array([1, 2, 3]),
    }),
    env,
    async request => {
      forwarded = request;
      return new Response('{"status":"ok"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(
    forwarded.headers.get("Authorization"),
    "Basic dGVzdDp0ZXN0",
  );
  assert.equal(
    forwarded.headers.get("Cf-Access-Authenticated-User-Email"),
    null,
  );
  assert.equal(forwarded.headers.get("Cf-Access-Jwt-Assertion"), null);
  assert.equal(forwarded.headers.get("CF-Connecting-IP"), null);
  assert.equal(forwarded.headers.get("X-Forwarded-For"), null);
  assert.equal(forwarded.headers.get("X-ShareGuard-Edge-Secret"), null);
  assert.match(
    forwarded.headers.get("X-ShareGuard-Client-Id"),
    /^[0-9a-f]{64}$/,
  );
  assert.match(
    forwarded.headers.get("X-ShareGuard-Edge-Timestamp"),
    /^\d{10}$/,
  );
  assert.match(
    forwarded.headers.get("X-ShareGuard-Edge-Signature"),
    /^[0-9a-f]{64}$/,
  );
  const canonical = [
    forwarded.headers.get("X-ShareGuard-Edge-Timestamp"),
    "POST",
    "/v1/analyze",
    forwarded.headers.get("X-ShareGuard-Client-Id"),
  ].join("\n");
  assert.equal(
    forwarded.headers.get("X-ShareGuard-Edge-Signature"),
    createHmac("sha256", EDGE_SHARED_SECRET).update(canonical).digest("hex"),
  );
  assert.deepEqual(defaultLimiter.keys, [
    forwarded.headers.get("X-ShareGuard-Client-Id"),
  ]);
  assert.equal(new URL(forwarded.url).origin, env.MODAL_ORIGIN);
  assert.equal(new URL(forwarded.url).pathname, "/v1/analyze");
  assert.equal(new URL(forwarded.url).search, "?case=demo");
  assert.deepEqual(
    [...new Uint8Array(await forwarded.arrayBuffer())],
    [1, 2, 3],
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});


test("returns stable JSON when Modal is unavailable", async () => {
  const response = await handleRequest(
    allowedReadyRequest(),
    env,
    async () => {
      throw new Error("network down");
    },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "upstream_unavailable",
      message: "Inference service is temporarily unavailable.",
    },
  });
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    env.ALLOWED_ORIGIN,
  );
});


test("rejects an unsafe Modal origin without sending a request", async () => {
  let called = false;
  const response = await handleRequest(
    allowedReadyRequest(),
    { ...env, MODAL_ORIGIN: "http://localhost:7860/private" },
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );

  assert.equal(response.status, 503);
  assert.equal(called, false);
});


test("fails closed when the durable quota rejects a client", async () => {
  let called = false;
  const blockedLimiter = {
    idFromName: key => key,
    get: () => ({
      fetch: async () => new Response(
        JSON.stringify({ allowed: false, retry_after: 42 }),
        { status: 429 },
      ),
    }),
  };
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Origin: env.ALLOWED_ORIGIN,
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.8",
        "Content-Type": "image/png",
      },
      body: new Uint8Array([1]),
    }),
    { ...env, RATE_LIMITER: blockedLimiter },
    async () => {
      called = true;
      return new Response("unexpected");
    },
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "42");
  assert.equal(called, false);
});


test("rejects invalid credentials before consuming durable quota", async () => {
  let quotaCalled = false;
  let upstreamCalled = false;
  const limiter = {
    idFromName: key => key,
    get: () => ({
      fetch: async () => {
        quotaCalled = true;
        return new Response(JSON.stringify({ allowed: true }), { status: 200 });
      },
    }),
  };
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Origin: env.ALLOWED_ORIGIN,
        Authorization: "Basic aW52YWxpZDppbnZhbGlk",
        "CF-Connecting-IP": "203.0.113.9",
        "Content-Type": "image/png",
      },
      body: new Uint8Array([1]),
    }),
    { ...env, RATE_LIMITER: limiter },
    async () => {
      upstreamCalled = true;
      return new Response("unexpected");
    },
  );

  assert.equal(response.status, 401);
  assert.equal(quotaCalled, false);
  assert.equal(upstreamCalled, false);
});


test("fails closed when edge identity secrets or bindings are missing", async () => {
  for (const overrides of [
    { EDGE_SHARED_SECRET: "" },
    { RATE_LIMITER: undefined },
  ]) {
    const response = await handleRequest(
      allowedReadyRequest(),
      { ...env, ...overrides },
      async () => new Response("unexpected"),
    );
    assert.equal(response.status, 503);
  }
});


test("durable quota state survives minute windows and enforces the day cap", () => {
  const start = Date.UTC(2026, 7, 1, 12, 0, 0);
  const limits = { perMinute: 1, perDay: 2 };

  const first = consumeQuotaState({}, start, limits);
  const minuteBlocked = consumeQuotaState(first.state, start + 1_000, limits);
  const secondMinute = consumeQuotaState(
    first.state,
    start + 61_000,
    limits,
  );
  const dayBlocked = consumeQuotaState(
    secondMinute.state,
    start + 122_000,
    limits,
  );

  assert.equal(first.allowed, true);
  assert.equal(minuteBlocked.allowed, false);
  assert.equal(minuteBlocked.reason, "minute");
  assert.equal(secondMinute.allowed, true);
  assert.equal(dayBlocked.allowed, false);
  assert.equal(dayBlocked.reason, "day");
  assert.ok(dayBlocked.retryAfter > 60);
});
