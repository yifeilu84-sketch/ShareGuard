import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { consumeQuotaState, handleRequest } from "../src/index.js";
import { applyCaseCommand, createCase } from "../src/case-store.js";
import { publicTrustRoot, verifyEvidencePackage } from "../src/evidence.js";


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


function persistentCaseStore() {
  const keys = [];
  const calls = [];
  const caseId = `sg_case_${"a".repeat(32)}`;
  const versionId = `sg_ver_${"b".repeat(32)}`;
  return {
    keys,
    calls,
    binding: {
      idFromName(key) {
        keys.push(key);
        return key;
      },
      get() {
        return {
          async fetch(input, init) {
            const request = input instanceof Request
              ? input
              : new Request(input, init);
            const url = new URL(request.url);
            let payload = null;
            if (request.method === "POST") {
              payload = await request.json();
            }
            calls.push({ method: request.method, path: url.pathname + url.search, payload });
            if (url.pathname === "/ingest") {
              return new Response(JSON.stringify({
                case: {
                  case_id: caseId,
                  status: "open",
                  chain_head: "c".repeat(64),
                  versions: [{ version_id: versionId }],
                },
              }), { status: 201 });
            }
            if (url.pathname === "/cases") {
              return new Response(JSON.stringify({
                cases: [{ case_id: caseId, status: "open" }],
              }));
            }
            return new Response(JSON.stringify({
              case: { case_id: caseId, status: "open" },
            }));
          },
        };
      },
    },
  };
}


function mediaAwareCaseStore() {
  let record = null;
  return {
    binding: {
      idFromName: key => key,
      get: () => ({
        async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname === "/ingest") {
            const payload = await request.json();
            record = {
              case_id: payload.new_case_id,
              status: "awaiting_review",
              chain_head: "c".repeat(64),
              versions: [{
                version_id: payload.version_id,
                media_sha256: payload.analysis.media_sha256,
                media_custody: payload.media_custody,
              }],
            };
            return new Response(JSON.stringify({ case: record }), { status: 201 });
          }
          if (request.method === "GET" && url.pathname === `/cases/${record?.case_id}`) {
            return new Response(JSON.stringify({ case: record }));
          }
          if (request.method === "DELETE" && url.pathname === `/cases/${record?.case_id}`) {
            return new Response(JSON.stringify({
              deleted: true,
              case_id: record.case_id,
              media_versions: record.versions.map(version => ({
                version_id: version.version_id,
                custody_status: version.media_custody.status,
              })),
            }));
          }
          return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
        },
      }),
    },
  };
}


function memoryMediaBucket() {
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
      const object = objects.get(key);
      return object ? { body: object.bytes, customMetadata: object.customMetadata } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}


async function signingEnvironment() {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  return {
    SGD_SIGNING_KEY_ID: "sg-signing-test",
    SGD_SIGNING_ISSUER: "https://shareguard.systems",
    SGD_SIGNING_PRIVATE_JWK: JSON.stringify(
      await crypto.subtle.exportKey("jwk", pair.privateKey),
    ),
    SGD_SIGNING_PUBLIC_JWK: JSON.stringify(
      await crypto.subtle.exportKey("jwk", pair.publicKey),
    ),
  };
}


async function sealedRecord() {
  const actorId = `sg_actor_${"c".repeat(32)}`;
  const created = await createCase({
    request_id: "sg_req_test",
    media_sha256: "d".repeat(64),
    engine_release: "shareguard-screening-2026.08",
    detector_engine: "shareguard-protected-screening-engine",
    decision_layer: "shareguard-editorial-policy-v2",
    machine_recommendation: "review",
    decision_label: "需要人工复核",
    risk_level: "high",
    model_score: 0.91,
    score_kind: "uncalibrated_ai_generation_score",
    decision_margin: 0.82,
    latency_ms: 512,
    image: { width: 1600, height: 900, format: "JPEG" },
    report: { report_id: "SG-TEST" },
  }, {
    caseId: `sg_case_${"a".repeat(32)}`,
    versionId: `sg_ver_${"b".repeat(32)}`,
    actorId,
    now: "2026-08-08T04:00:00.000Z",
  });
  const decided = await applyCaseCommand(created, {
    type: "decision",
    payload: { action: "hold", reason_code: "source_unverified" },
  }, { actorId, now: "2026-08-08T04:01:00.000Z" });
  return applyCaseCommand(decided, {
    type: "seal",
    payload: { key_id: "sg-signing-test" },
  }, { actorId, now: "2026-08-08T04:02:00.000Z" });
}


function sealingCaseStore(record) {
  const calls = [];
  return {
    calls,
    binding: {
      idFromName: key => key,
      get: () => ({
        async fetch(input, init) {
          const request = input instanceof Request
            ? input
            : new Request(input, init);
          calls.push(new URL(request.url).pathname);
          return new Response(JSON.stringify({ case: record }));
        },
      }),
    },
  };
}


const defaultLimiter = allowAllLimiter();
const defaultCaseStore = persistentCaseStore();
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
  CASE_STORE: defaultCaseStore.binding,
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


test("approved browser preflight permits deleting an unsealed case", async () => {
  const caseId = `sg_case_${"a".repeat(32)}`;
  const response = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${caseId}`, {
      method: "OPTIONS",
      headers: {
        Origin: env.ALLOWED_ORIGIN,
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    }),
    env,
    async () => new Response("unexpected"),
  );

  assert.equal(response.status, 204);
  assert.match(response.headers.get("Access-Control-Allow-Methods"), /DELETE/);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), env.ALLOWED_ORIGIN);
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


test("health reports the control plane without waking Modal", async () => {
  let upstreamCalled = false;
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/health", {
      headers: { Origin: env.ALLOWED_ORIGIN },
    }),
    env,
    async () => {
      upstreamCalled = true;
      return new Response("unexpected");
    },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalled, false);
  assert.deepEqual(await response.json(), {
    status: "ok",
    gateway: "ready",
    case_store: "ready",
    private_media: "unavailable",
    private_media_required: false,
    inference: "check_v1_ready",
  });
});


test("production analysis stores encrypted media and serves it only through the case route", async () => {
  const bytes = new TextEncoder().encode("private camera bytes");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/jpeg" }), "camera.jpg");
  const bucket = memoryMediaBucket();
  const store = mediaAwareCaseStore();
  const runtime = {
    ...env,
    CASE_STORE: store.binding,
    MEDIA_BUCKET: bucket,
    MEDIA_CUSTODY_REQUIRED: "true",
    MEDIA_ENCRYPTION_KEY_B64: Buffer.alloc(32, 9).toString("base64"),
    MEDIA_ENCRYPTION_KEY_VERSION: "media-test",
    MEDIA_RETENTION_DAYS: "7",
  };
  const analyzeResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
        "X-File-Name": "camera.jpg",
      },
      body: form,
    }),
    runtime,
    async () => new Response(JSON.stringify({
      request_id: "sg_req_media",
      media_sha256: digest,
      engine_release: "shareguard-screening-2026.08",
      detector_engine: "shareguard-protected-screening-engine",
      decision_layer: "shareguard-editorial-policy-v2",
      machine_recommendation: "review",
      decision_label: "需要人工复核",
      risk_level: "high",
      model_score: 0.8,
      score_kind: "uncalibrated_ai_generation_score",
      decision_margin: 0.6,
      latency_ms: 300,
      image: { width: 10, height: 10, format: "JPEG" },
      report: { report_id: "SG-MEDIA" },
    }), { headers: { "Content-Type": "application/json" } }),
  );

  assert.equal(analyzeResponse.status, 200);
  const analyzed = await analyzeResponse.json();
  assert.equal(analyzed.case.versions[0].media_custody.status, "encrypted_private");
  assert.equal(bucket.objects.size, 1);
  const mediaResponse = await handleRequest(
    new Request(
      `https://api.shareguard.systems/v1/cases/${analyzed.case_id}/versions/${analyzed.version_id}/media`,
      {
        headers: {
          Authorization: AUTHORIZATION,
          "CF-Connecting-IP": "198.51.100.91",
        },
      },
    ),
    runtime,
  );
  assert.equal(mediaResponse.status, 200);
  assert.equal(mediaResponse.headers.get("X-ShareGuard-Media-SHA256"), digest);
  assert.deepEqual(new Uint8Array(await mediaResponse.arrayBuffer()), bytes);

  const deleteResponse = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${analyzed.case_id}`, {
      method: "DELETE",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
      },
    }),
    runtime,
  );
  assert.equal(deleteResponse.status, 200);
  assert.equal(bucket.objects.size, 0);
});


test("trust root and sealing are served without waking Modal", async () => {
  const signing = await signingEnvironment();
  const record = await sealedRecord();
  const store = sealingCaseStore(record);
  const runtime = { ...env, ...signing, CASE_STORE: store.binding };
  let upstreamCalled = false;
  const headers = {
    Origin: env.ALLOWED_ORIGIN,
    Authorization: AUTHORIZATION,
    "CF-Connecting-IP": "203.0.113.70",
  };

  const trustResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/trust-root", { headers }),
    runtime,
    async () => {
      upstreamCalled = true;
      return new Response("unexpected");
    },
  );
  const sealResponse = await handleRequest(
    new Request(
      `https://api.shareguard.systems/v1/cases/${record.case_id}/seal`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
      },
    ),
    runtime,
    async () => {
      upstreamCalled = true;
      return new Response("unexpected");
    },
  );

  assert.equal(trustResponse.status, 200);
  assert.deepEqual(await trustResponse.json(), publicTrustRoot(runtime));
  assert.equal(sealResponse.status, 200);
  const evidencePackage = await sealResponse.json();
  assert.equal(
    (await verifyEvidencePackage(evidencePackage, [publicTrustRoot(runtime)])).valid,
    true,
  );
  assert.equal(upstreamCalled, false);
  assert.deepEqual(store.calls, [`/cases/${record.case_id}/seal`]);
});


test("sealing fails before changing case state when signing key is unavailable", async () => {
  const signing = await signingEnvironment();
  const record = await sealedRecord();
  const store = sealingCaseStore(record);
  const response = await handleRequest(
    new Request(
      `https://api.shareguard.systems/v1/cases/${record.case_id}/seal`,
      {
        method: "POST",
        headers: {
          Authorization: AUTHORIZATION,
          "CF-Connecting-IP": "203.0.113.71",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ),
    {
      ...env,
      ...signing,
      SGD_SIGNING_PRIVATE_JWK: "",
      CASE_STORE: store.binding,
    },
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "signing_unavailable");
  assert.equal(store.calls.length, 0);
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
      return new Response(JSON.stringify({
        request_id: "sg_req_test",
        media_sha256: "d".repeat(64),
        engine_release: "shareguard-screening-2026.08",
        detector_engine: "shareguard-protected-screening-engine",
        decision_layer: "shareguard-editorial-policy-v2",
        machine_recommendation: "review",
        decision_label: "需要人工复核",
        risk_level: "high",
        model_score: 0.91,
        score_kind: "uncalibrated_ai_generation_score",
        decision_margin: 0.82,
        latency_ms: 512,
        image: { width: 1, height: 1, format: "JPEG" },
        report: { report_id: "SG-TEST" },
      }), {
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
  assert.equal(
    defaultLimiter.keys.at(-1),
    forwarded.headers.get("X-ShareGuard-Client-Id"),
  );
  assert.equal(new URL(forwarded.url).origin, env.MODAL_ORIGIN);
  assert.equal(new URL(forwarded.url).pathname, "/v1/analyze");
  assert.equal(new URL(forwarded.url).search, "?case=demo");
  assert.deepEqual(
    [...new Uint8Array(await forwarded.arrayBuffer())],
    [1, 2, 3],
  );
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const payload = await response.json();
  assert.match(payload.case_id, /^sg_case_[0-9a-f]{32}$/);
  assert.match(payload.version_id, /^sg_ver_[0-9a-f]{32}$/);
  assert.equal(payload.case_status, "open");
  assert.equal(payload.chain_head, "c".repeat(64));
  const ingest = defaultCaseStore.calls.at(-1);
  assert.equal(ingest.path, "/ingest");
  assert.equal(ingest.payload.analysis.request_id, "sg_req_test");
  assert.match(ingest.payload.actor_id, /^sg_actor_[0-9a-f]{32}$/);
  assert.equal(ingest.payload.actor_id.includes("test"), false);
});


test("decodes a UTF-8 case title without forwarding case metadata upstream", async () => {
  const store = persistentCaseStore();
  let forwarded;
  const title = "用户导入影像核验";
  const encodedTitle = Buffer.from(title, "utf8").toString("base64url");
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Origin: env.ALLOWED_ORIGIN,
        Authorization: AUTHORIZATION,
        "Content-Type": "image/jpeg",
        "CF-Connecting-IP": "203.0.113.72",
        "X-ShareGuard-Case-Title-B64": encodedTitle,
        "X-ShareGuard-Version-Role": "original",
      },
      body: new Uint8Array([1]),
    }),
    { ...env, CASE_STORE: store.binding },
    async request => {
      forwarded = request;
      return new Response(JSON.stringify({ request_id: "sg_req_title" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );

  assert.equal(response.status, 200);
  const ingest = store.calls.find(call => call.path === "/ingest");
  assert.equal(ingest.payload.title, title);
  assert.equal(forwarded.headers.get("X-ShareGuard-Case-Title-B64"), null);
  assert.equal(forwarded.headers.get("X-ShareGuard-Version-Role"), null);
});


test("case reads use persistent storage and never call Modal", async () => {
  let upstreamCalled = false;
  const response = await handleRequest(
    new Request("https://api.shareguard.systems/v1/cases", {
      headers: {
        Origin: env.ALLOWED_ORIGIN,
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.55",
      },
    }),
    env,
    async () => {
      upstreamCalled = true;
      return new Response("unexpected");
    },
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalled, false);
  const payload = await response.json();
  assert.equal(payload.cases.length, 1);
  assert.equal(defaultCaseStore.calls.at(-1).path, "/cases");
});


test("case queue filters and workflow commands reach the persistent control plane", async () => {
  const store = persistentCaseStore();
  const caseId = `sg_case_${"a".repeat(32)}`;
  const listResponse = await handleRequest(
    new Request(
      "https://api.shareguard.systems/v1/cases?status=awaiting_review&priority=urgent&limit=10",
      {
        headers: {
          Authorization: AUTHORIZATION,
          "CF-Connecting-IP": "203.0.113.81",
        },
      },
    ),
    { ...env, CASE_STORE: store.binding },
  );
  const workflowResponse = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${caseId}/workflow`, {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.81",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ priority: "urgent", assignee: "Night editor" }),
    }),
    { ...env, CASE_STORE: store.binding },
  );

  assert.equal(listResponse.status, 200);
  assert.equal(workflowResponse.status, 200);
  assert.equal(
    store.calls[0].path,
    "/cases?status=awaiting_review&priority=urgent&limit=10",
  );
  assert.equal(store.calls[1].path, `/cases/${caseId}/workflow`);
  assert.equal(store.calls[1].payload.priority, "urgent");
});


test("case namespace follows authenticated subject instead of public IP", async () => {
  const store = persistentCaseStore();
  const first = new Request("https://api.shareguard.systems/v1/cases", {
    headers: {
      Authorization: AUTHORIZATION,
      "CF-Connecting-IP": "203.0.113.60",
    },
  });
  const second = new Request("https://api.shareguard.systems/v1/cases", {
    headers: {
      Authorization: AUTHORIZATION,
      "CF-Connecting-IP": "198.51.100.60",
    },
  });

  await handleRequest(first, { ...env, CASE_STORE: store.binding });
  await handleRequest(second, { ...env, CASE_STORE: store.binding });

  assert.equal(store.keys.length, 2);
  assert.equal(store.keys[0], store.keys[1]);
  assert.match(store.keys[0], /^sg_actor_[0-9a-f]{32}$/);
});


test("case commands ignore a client-supplied actor identity", async () => {
  const store = persistentCaseStore();
  const caseId = `sg_case_${"a".repeat(32)}`;
  const response = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${caseId}/decision`, {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.61",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actor_id: `sg_actor_${"f".repeat(32)}`,
        action: "hold",
        reason_code: "source_unverified",
      }),
    }),
    { ...env, CASE_STORE: store.binding },
  );

  assert.equal(response.status, 200);
  const command = store.calls.at(-1);
  assert.equal(command.path, `/cases/${caseId}/decision`);
  assert.notEqual(command.payload.actor_id, `sg_actor_${"f".repeat(32)}`);
  assert.match(command.payload.actor_id, /^sg_actor_[0-9a-f]{32}$/);
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
