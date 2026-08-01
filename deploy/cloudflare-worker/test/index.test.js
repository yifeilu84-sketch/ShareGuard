import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "../src/index.js";


const env = {
  ALLOWED_ORIGIN: "https://shareguard.systems",
  MODAL_ORIGIN: "https://private-example.modal.run",
};


function allowedReadyRequest() {
  return new Request("https://api.shareguard.systems/v1/ready", {
    headers: { Origin: env.ALLOWED_ORIGIN },
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
        Authorization: "Basic dGVzdDp0ZXN0",
        "Content-Type": "image/jpeg",
        "Cf-Access-Authenticated-User-Email": "spoof@example.com",
        "Cf-Access-Jwt-Assertion": "spoofed-token",
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
