import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import { consumeQuotaState, handleRequest } from "../src/index.js";
import { applyCaseCommand, createCase, ShareGuardCaseStore } from "../src/case-store.js";
import { publicTrustRoot, verifyEvidencePackage } from "../src/evidence.js";
import { mediaObjectKey } from "../src/media-store.js";


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
                  case_id: payload.new_case_id || payload.case_id || caseId,
                  status: "open",
                  chain_head: "c".repeat(64),
                  versions: [{ version_id: payload.version_id || versionId }],
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
  let tombstone = null;
  let deleteCalls = 0;
  let reservationCalls = 0;
  let abandonCalls = 0;
  let failCommit = false;
  let failIngest = false;
  let failRelease = false;
  let corruptCommittedResponse = false;
  let corruptReservationResponse = false;
  const reservations = new Map();
  const deletionId = `sg_delete_${"d".repeat(32)}`;
  return {
    get deleteCalls() {
      return deleteCalls;
    },
    get reservationCalls() {
      return reservationCalls;
    },
    get abandonCalls() {
      return abandonCalls;
    },
    get reservationCount() {
      return reservations.size;
    },
    setCommitFailure(value) {
      failCommit = Boolean(value);
    },
    setIngestFailure(value) {
      failIngest = Boolean(value);
    },
    setReleaseFailure(value) {
      failRelease = Boolean(value);
    },
    setCorruptCommittedResponse(value) {
      corruptCommittedResponse = Boolean(value);
    },
    setCorruptReservationResponse(value) {
      corruptReservationResponse = Boolean(value);
    },
    binding: {
      idFromName: key => key,
      get: () => ({
        async fetch(input, init) {
          const request = input instanceof Request ? input : new Request(input, init);
          const url = new URL(request.url);
          if (request.method === "POST" && url.pathname === "/ingest") {
            const payload = await request.json();
            const version = {
                version_id: payload.version_id,
                media_sha256: payload.analysis.media_sha256,
                media_custody: payload.media_custody,
            };
            if (payload.case_id) {
              assert.equal(payload.reservation_id, payload.version_id);
              assert.equal(reservations.get(payload.version_id), "active");
              if (failIngest) {
                return new Response(JSON.stringify({
                  error: { code: "case_store_unavailable", message: "simulated ingest failure" },
                }), { status: 503 });
              }
              reservations.delete(payload.version_id);
              record.versions.push(version);
              if (corruptCommittedResponse) {
                return new Response("{", {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                });
              }
            } else {
              record = {
                case_id: payload.new_case_id,
                status: "awaiting_review",
                chain_head: "c".repeat(64),
                versions: [version],
              };
              if (corruptCommittedResponse) {
                return new Response("{", {
                  status: 201,
                  headers: { "Content-Type": "application/json" },
                });
              }
            }
            return new Response(JSON.stringify({ case: record }), { status: 201 });
          }
          if (request.method === "GET" && url.pathname === `/cases/${record?.case_id}`) {
            return new Response(JSON.stringify({ case: record }));
          }
          if (
            request.method === "POST" &&
            url.pathname === `/cases/${record?.case_id}/ingest-reservations`
          ) {
            const payload = await request.json();
            reservationCalls += 1;
            reservations.set(payload.version_id, "active");
            if (corruptReservationResponse) {
              return new Response("{", {
                status: 201,
                headers: { "Content-Type": "application/json" },
              });
            }
            return new Response(JSON.stringify({
              reservation: { version_id: payload.version_id, status: "active" },
            }), { status: 201 });
          }
          const reservationMatch = url.pathname.match(
            new RegExp(`^/cases/${record?.case_id}/ingest-reservations/(sg_ver_[0-9a-f]{32})/(release|abandon)$`),
          );
          if (request.method === "POST" && reservationMatch) {
            const committedVersion = record?.versions?.find(
              version => version.version_id === reservationMatch[1],
            );
            if (committedVersion) {
              return new Response(JSON.stringify({
                committed: true,
                version_id: reservationMatch[1],
                case: record,
              }));
            }
            if (reservationMatch[2] === "abandon") {
              abandonCalls += 1;
              reservations.set(reservationMatch[1], "cleanup_required");
              return new Response(JSON.stringify({
                reservation: { version_id: reservationMatch[1], status: "cleanup_required" },
              }));
            }
            if (failRelease) {
              return new Response(JSON.stringify({
                error: { code: "case_store_unavailable", message: "simulated release failure" },
              }), { status: 503 });
            }
            reservations.delete(reservationMatch[1]);
            return new Response(JSON.stringify({ released: true, version_id: reservationMatch[1] }));
          }
          if (request.method === "POST" && url.pathname === `/cases/${record?.case_id}/delete-plan`) {
            if ([...reservations.values()].some(status => status === "active")) {
              return new Response(JSON.stringify({
                error: { code: "case_ingest_in_progress", message: "simulated active ingest" },
              }), { status: 409 });
            }
            record.deletion ||= {
              status: "pending",
              deletion_id: deletionId,
            };
            return new Response(JSON.stringify({
              deletion_id: record.deletion.deletion_id,
              case_id: record.case_id,
              media_versions: [
                ...record.versions.map(version => ({
                  version_id: version.version_id,
                  custody_status: version.media_custody.status,
                })),
                ...[...reservations]
                  .filter(([, status]) => status === "cleanup_required")
                  .map(([versionId]) => ({
                    version_id: versionId,
                    custody_status: "encrypted_private",
                  })),
              ],
            }));
          }
          if (
            request.method === "POST" &&
            tombstone &&
            url.pathname === `/cases/${tombstone.case_id}/delete-plan`
          ) {
            return new Response(JSON.stringify(tombstone));
          }
          if (request.method === "POST" && url.pathname === `/cases/${record?.case_id}/delete-commit`) {
            const payload = await request.json();
            if (failCommit) {
              return new Response(JSON.stringify({
                error: { code: "case_store_unavailable", message: "simulated commit failure" },
              }), { status: 503 });
            }
            assert.equal(payload.deletion_id, deletionId);
            deleteCalls += 1;
            const deletedRecord = record;
            tombstone = {
              deleted: true,
              case_id: deletedRecord.case_id,
              deletion_id: deletionId,
            };
            record = null;
            return new Response(JSON.stringify(tombstone));
          }
          return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
        },
      }),
    },
  };
}


function memoryMediaBucket() {
  const objects = new Map();
  let failDelete = false;
  return {
    objects,
    setDeleteFailure(value) {
      failDelete = Boolean(value);
    },
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
      if (failDelete) throw new Error("simulated R2 delete failure");
      objects.delete(key);
    },
  };
}


function realCaseStoreBinding(ownerId, initialRecord) {
  const values = new Map([[`case:${initialRecord.case_id}`, initialRecord]]);
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
    async list(options = {}) {
      return new Map([...values].filter(([key]) => key.startsWith(options.prefix || "")));
    },
    async transaction(callback) {
      return callback(storage);
    },
  };
  const object = new ShareGuardCaseStore({ storage }, {});
  return {
    binding: {
      idFromName(key) {
        assert.equal(key, ownerId);
        return key;
      },
      get() {
        return { fetch: (input, init) => object.fetch(input instanceof Request ? input : new Request(input, init)) };
      },
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
  assert.match(response.headers.get("Access-Control-Expose-Headers"), /X-ShareGuard-Media-SHA256/);
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
  store.setCorruptCommittedResponse(true);
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
  store.setCorruptCommittedResponse(false);

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

  store.setCorruptReservationResponse(true);
  const reservationLossForm = new FormData();
  reservationLossForm.append(
    "image",
    new Blob([new Uint8Array([2, 4, 6, 8])], { type: "image/jpeg" }),
    "reservation-loss.jpg",
  );
  const reservationLossResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
        "X-File-Name": "reservation-loss.jpg",
        "X-ShareGuard-Case-Id": analyzed.case_id,
        "X-ShareGuard-Version-Role": "observed_variant",
      },
      body: reservationLossForm,
    }),
    runtime,
    async () => new Response(JSON.stringify({
      request_id: "sg_req_reservation_loss",
      media_sha256: createHash("sha256").update(new Uint8Array([2, 4, 6, 8])).digest("hex"),
      engine_release: "shareguard-screening-2026.08",
      detector_engine: "shareguard-protected-screening-engine",
      decision_layer: "shareguard-editorial-policy-v2",
      machine_recommendation: "review",
      decision_label: "needs_review",
      risk_level: "medium",
      model_score: 0.57,
      score_kind: "uncalibrated_ai_generation_score",
      decision_margin: 0.14,
      latency_ms: 225,
      image: { width: 10, height: 10, format: "JPEG" },
      report: { report_id: "SG-RESERVATION-LOSS" },
    }), { headers: { "Content-Type": "application/json" } }),
  );
  store.setCorruptReservationResponse(false);
  assert.equal(reservationLossResponse.status, 503);
  assert.equal(store.reservationCount, 0);
  assert.equal(bucket.objects.size, 1);

  const observedBytes = new Uint8Array([9, 8, 7, 6]);
  const observedDigest = createHash("sha256").update(observedBytes).digest("hex");
  const observedForm = new FormData();
  observedForm.append("image", new Blob([observedBytes], { type: "image/jpeg" }), "observed.jpg");
  const observedResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
        "X-File-Name": "observed.jpg",
        "X-ShareGuard-Case-Id": analyzed.case_id,
        "X-ShareGuard-Version-Role": "observed_variant",
      },
      body: observedForm,
    }),
    runtime,
    async () => new Response(JSON.stringify({
      request_id: "sg_req_observed",
      media_sha256: observedDigest,
      engine_release: "shareguard-screening-2026.08",
      detector_engine: "shareguard-protected-screening-engine",
      decision_layer: "shareguard-editorial-policy-v2",
      machine_recommendation: "review",
      decision_label: "needs_review",
      risk_level: "medium",
      model_score: 0.6,
      score_kind: "uncalibrated_ai_generation_score",
      decision_margin: 0.2,
      latency_ms: 240,
      image: { width: 10, height: 10, format: "JPEG" },
      report: { report_id: "SG-OBSERVED" },
    }), { headers: { "Content-Type": "application/json" } }),
  );
  assert.equal(observedResponse.status, 200);
  assert.equal(store.reservationCalls, 2);
  assert.equal((await observedResponse.json()).case.versions.length, 2);
  assert.equal(bucket.objects.size, 2);

  store.setCorruptCommittedResponse(true);
  const recoveredBytes = new Uint8Array([1, 3, 5, 7, 9]);
  const recoveredDigest = createHash("sha256").update(recoveredBytes).digest("hex");
  const recoveredForm = new FormData();
  recoveredForm.append("image", new Blob([recoveredBytes], { type: "image/jpeg" }), "recovered.jpg");
  const recoveredResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
        "X-File-Name": "recovered.jpg",
        "X-ShareGuard-Case-Id": analyzed.case_id,
        "X-ShareGuard-Version-Role": "observed_variant",
      },
      body: recoveredForm,
    }),
    runtime,
    async () => new Response(JSON.stringify({
      request_id: "sg_req_recovered_ingest",
      media_sha256: recoveredDigest,
      engine_release: "shareguard-screening-2026.08",
      detector_engine: "shareguard-protected-screening-engine",
      decision_layer: "shareguard-editorial-policy-v2",
      machine_recommendation: "review",
      decision_label: "needs_review",
      risk_level: "medium",
      model_score: 0.58,
      score_kind: "uncalibrated_ai_generation_score",
      decision_margin: 0.16,
      latency_ms: 230,
      image: { width: 10, height: 10, format: "JPEG" },
      report: { report_id: "SG-RECOVERED-INGEST" },
    }), { headers: { "Content-Type": "application/json" } }),
  );
  store.setCorruptCommittedResponse(false);
  assert.equal(recoveredResponse.status, 200);
  assert.equal((await recoveredResponse.json()).case.versions.length, 3);
  assert.equal(bucket.objects.size, 3);

  store.setIngestFailure(true);
  store.setReleaseFailure(true);
  const failedBytes = new Uint8Array([5, 4, 3, 2, 1]);
  const failedDigest = createHash("sha256").update(failedBytes).digest("hex");
  const failedForm = new FormData();
  failedForm.append("image", new Blob([failedBytes], { type: "image/jpeg" }), "failed.jpg");
  const failedIngestResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/analyze", {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
        "X-File-Name": "failed.jpg",
        "X-ShareGuard-Case-Id": analyzed.case_id,
        "X-ShareGuard-Version-Role": "observed_variant",
      },
      body: failedForm,
    }),
    runtime,
    async () => new Response(JSON.stringify({
      request_id: "sg_req_failed_ingest",
      media_sha256: failedDigest,
      engine_release: "shareguard-screening-2026.08",
      detector_engine: "shareguard-protected-screening-engine",
      decision_layer: "shareguard-editorial-policy-v2",
      machine_recommendation: "review",
      decision_label: "needs_review",
      risk_level: "medium",
      model_score: 0.55,
      score_kind: "uncalibrated_ai_generation_score",
      decision_margin: 0.1,
      latency_ms: 220,
      image: { width: 10, height: 10, format: "JPEG" },
      report: { report_id: "SG-FAILED-INGEST" },
    }), { headers: { "Content-Type": "application/json" } }),
  );
  assert.equal(failedIngestResponse.status, 503);
  assert.equal(store.reservationCalls, 4);
  assert.equal(store.abandonCalls, 2);
  assert.equal(bucket.objects.size, 3);
  store.setIngestFailure(false);
  store.setReleaseFailure(false);
  bucket.setDeleteFailure(true);

  const failedDeleteResponse = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${analyzed.case_id}`, {
      method: "DELETE",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
      },
    }),
    runtime,
  );
  assert.equal(failedDeleteResponse.status, 503);
  assert.equal((await failedDeleteResponse.json()).error.code, "media_custody_unavailable");
  assert.equal(store.deleteCalls, 0);
  assert.equal(bucket.objects.size, 3);
  bucket.setDeleteFailure(false);

  store.setCommitFailure(true);
  const failedCommitResponse = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${analyzed.case_id}`, {
      method: "DELETE",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
      },
    }),
    runtime,
  );
  assert.equal(failedCommitResponse.status, 503);
  assert.equal((await failedCommitResponse.json()).error.code, "case_store_unavailable");
  assert.equal(store.deleteCalls, 0);
  assert.equal(bucket.objects.size, 0);
  store.setCommitFailure(false);

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
  assert.equal(store.deleteCalls, 1);
  assert.equal(bucket.objects.size, 0);

  const idempotentDeleteResponse = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${analyzed.case_id}`, {
      method: "DELETE",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.91",
      },
    }),
    runtime,
  );
  assert.equal(idempotentDeleteResponse.status, 200);
  assert.equal((await idempotentDeleteResponse.json()).deleted, true);
  assert.equal(store.deleteCalls, 1);
});


test("case-scoped reviewer links permit comments but not owner routes and revoke immediately", async () => {
  const ownerId = `sg_actor_${createHmac("sha256", EDGE_SHARED_SECRET)
    .update("shareguard-actor:test")
    .digest("hex")
    .slice(0, 32)}`;
  const record = await createCase({
    request_id: "sg_req_review",
    media_sha256: "d".repeat(64),
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
    report: { report_id: "SG-REVIEW" },
  }, {
    caseId: `sg_case_${"7".repeat(32)}`,
    versionId: `sg_ver_${"8".repeat(32)}`,
    actorId: ownerId,
  });
  const store = realCaseStoreBinding(ownerId, record);
  const runtime = {
    ...env,
    CASE_STORE: store.binding,
    REVIEW_TOKEN_SECRET: "review-secret-with-at-least-thirty-two-bytes",
  };
  const issueResponse = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${record.case_id}/review-grants`, {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.92",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reviewer_name: "External counsel", expires_in_seconds: 3600 }),
    }),
    runtime,
  );
  assert.equal(issueResponse.status, 201);
  const issued = await issueResponse.json();
  assert.match(issued.review_url, /#review_token=/);
  assert.equal(JSON.stringify(issued.case).includes(issued.token), false);

  const reviewCaseResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/review/case", {
      headers: { Authorization: `Bearer ${issued.token}`, Origin: env.ALLOWED_ORIGIN },
    }),
    runtime,
  );
  assert.equal(reviewCaseResponse.status, 200);
  const reviewCase = await reviewCaseResponse.json();
  assert.equal(reviewCase.case.case_id, record.case_id);
  assert.equal(reviewCase.case.review_grants, undefined);
  assert.equal(reviewCase.case.ingest_reservations, undefined);
  assert.equal(reviewCase.case.reviewer_context.role, "reviewer");

  const commentResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/review/comments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issued.token}`,
        Origin: env.ALLOWED_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: "Independent review completed." }),
    }),
    runtime,
  );
  assert.equal(commentResponse.status, 200);
  assert.equal((await commentResponse.json()).case.comments.length, 1);

  const forbiddenOwnerRoute = await handleRequest(
    new Request("https://api.shareguard.systems/v1/cases", {
      headers: { Authorization: `Bearer ${issued.token}`, "CF-Connecting-IP": "203.0.113.92" },
    }),
    runtime,
  );
  assert.equal(forbiddenOwnerRoute.status, 401);

  const revokeResponse = await handleRequest(
    new Request(
      `https://api.shareguard.systems/v1/cases/${record.case_id}/review-grants/${issued.grant.grant_id}/revoke`,
      {
        method: "POST",
        headers: {
          Authorization: AUTHORIZATION,
          "CF-Connecting-IP": "203.0.113.92",
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    ),
    runtime,
  );
  assert.equal(revokeResponse.status, 200);
  const revokedResponse = await handleRequest(
    new Request("https://api.shareguard.systems/v1/review/case", {
      headers: { Authorization: `Bearer ${issued.token}`, Origin: env.ALLOWED_ORIGIN },
    }),
    runtime,
  );
  assert.equal(revokedResponse.status, 401);
});


test("review grant issuance fails closed when the review signing secret is unavailable", async () => {
  const ownerId = `sg_actor_${createHmac("sha256", EDGE_SHARED_SECRET)
    .update("shareguard-actor:test")
    .digest("hex")
    .slice(0, 32)}`;
  const record = await createCase({
    request_id: "sg_req_review_secret",
    media_sha256: "e".repeat(64),
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
    report: { report_id: "SG-REVIEW-SECRET" },
  }, {
    caseId: `sg_case_${"9".repeat(32)}`,
    versionId: `sg_ver_${"a".repeat(32)}`,
    actorId: ownerId,
  });
  const store = realCaseStoreBinding(ownerId, record);
  const response = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${record.case_id}/review-grants`, {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.93",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reviewer_name: "External counsel", expires_in_seconds: 3600 }),
    }),
    { ...env, CASE_STORE: store.binding },
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "review_access_unavailable");
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
  assert.deepEqual(store.calls, [
    `/cases/${record.case_id}`,
    `/cases/${record.case_id}/seal`,
  ]);
});


test("sealing cleans failed private-media ingests before committing the evidence package", async () => {
  const signing = await signingEnvironment();
  const ownerId = `sg_actor_${createHmac("sha256", EDGE_SHARED_SECRET)
    .update("shareguard-actor:test")
    .digest("hex")
    .slice(0, 32)}`;
  const created = await createCase({
    request_id: "sg_req_seal_cleanup",
    media_sha256: "7".repeat(64),
    engine_release: "shareguard-screening-2026.08",
    detector_engine: "shareguard-protected-screening-engine",
    decision_layer: "shareguard-editorial-policy-v2",
    machine_recommendation: "review",
    decision_label: "review",
    risk_level: "high",
    model_score: 0.82,
    score_kind: "uncalibrated_ai_generation_score",
    decision_margin: 0.64,
    latency_ms: 410,
    image: { width: 1200, height: 800, format: "JPEG" },
    report: { report_id: "SG-SEAL-CLEANUP" },
  }, {
    caseId: `sg_case_${"6".repeat(32)}`,
    versionId: `sg_ver_${"5".repeat(32)}`,
    actorId: ownerId,
    now: "2026-08-08T05:00:00.000Z",
  });
  const record = await applyCaseCommand(created, {
    type: "decision",
    payload: { action: "hold", reason_code: "source_unverified" },
  }, { actorId: ownerId, now: "2026-08-08T05:01:00.000Z" });
  const failedVersionId = `sg_ver_${"4".repeat(32)}`;
  record.ingest_reservations.push({
    version_id: failedVersionId,
    status: "cleanup_required",
    reserved_at: "2026-08-08T05:02:00.000Z",
    updated_at: "2026-08-08T05:03:00.000Z",
  });
  const bucket = memoryMediaBucket();
  const orphanKey = mediaObjectKey(ownerId, record.case_id, failedVersionId);
  await bucket.put(orphanKey, new TextEncoder().encode("failed encrypted ingest"));
  const store = realCaseStoreBinding(ownerId, record);
  const runtime = {
    ...env,
    ...signing,
    CASE_STORE: store.binding,
    MEDIA_BUCKET: bucket,
  };

  bucket.setDeleteFailure(true);
  const failedResponse = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${record.case_id}/seal`, {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.72",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    runtime,
  );
  assert.equal(failedResponse.status, 503);
  assert.equal((await failedResponse.json()).error.code, "media_cleanup_unavailable");
  assert.equal(bucket.objects.has(orphanKey), true);
  bucket.setDeleteFailure(false);

  const response = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${record.case_id}/seal`, {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.72",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    runtime,
  );

  assert.equal(response.status, 200);
  assert.equal(bucket.objects.has(orphanKey), false);
  const evidencePackage = await response.json();
  assert.equal(
    (await verifyEvidencePackage(evidencePackage, [publicTrustRoot(runtime)])).valid,
    true,
  );
});


test("an owner can recover an orphaned active ingest reservation without database access", async () => {
  const ownerId = `sg_actor_${createHmac("sha256", EDGE_SHARED_SECRET)
    .update("shareguard-actor:test")
    .digest("hex")
    .slice(0, 32)}`;
  const record = await createCase({
    request_id: "sg_req_ingest_recovery",
    media_sha256: "6".repeat(64),
    engine_release: "shareguard-screening-2026.08",
    detector_engine: "shareguard-protected-screening-engine",
    decision_layer: "shareguard-editorial-policy-v2",
    machine_recommendation: "review",
    decision_label: "review",
    risk_level: "medium",
    model_score: 0.61,
    score_kind: "uncalibrated_ai_generation_score",
    decision_margin: 0.22,
    latency_ms: 280,
    image: { width: 900, height: 600, format: "JPEG" },
    report: { report_id: "SG-INGEST-RECOVERY" },
  }, {
    caseId: `sg_case_${"3".repeat(32)}`,
    versionId: `sg_ver_${"2".repeat(32)}`,
    actorId: ownerId,
    now: "2026-08-08T06:00:00.000Z",
  });
  const orphanVersionId = `sg_ver_${"1".repeat(32)}`;
  record.ingest_reservations.push({
    version_id: orphanVersionId,
    status: "active",
    reserved_at: "2026-08-08T06:01:00.000Z",
    updated_at: "2026-08-08T06:01:00.000Z",
  });
  const bucket = memoryMediaBucket();
  const orphanKey = mediaObjectKey(ownerId, record.case_id, orphanVersionId);
  await bucket.put(orphanKey, new TextEncoder().encode("ambiguous upload"));
  const store = realCaseStoreBinding(ownerId, record);
  const runtime = { ...env, CASE_STORE: store.binding, MEDIA_BUCKET: bucket };

  const response = await handleRequest(
    new Request(`https://api.shareguard.systems/v1/cases/${record.case_id}/ingest-recovery`, {
      method: "POST",
      headers: {
        Authorization: AUTHORIZATION,
        "CF-Connecting-IP": "203.0.113.73",
        "Content-Type": "application/json",
      },
      body: "{}",
    }),
    runtime,
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.recovered, 1);
  assert.deepEqual(payload.case.ingest_reservations, []);
  assert.equal(bucket.objects.has(orphanKey), false);
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
