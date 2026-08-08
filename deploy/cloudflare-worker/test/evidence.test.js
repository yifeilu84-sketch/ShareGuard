import assert from "node:assert/strict";
import test from "node:test";

import { applyCaseCommand, createCase } from "../src/case-store.js";
import {
  publicTrustRoot,
  signEvidence,
  verifyEvidencePackage,
} from "../src/evidence.js";


async function signingEnvironment(keyId = "sg-signing-2026-01") {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    SGD_SIGNING_KEY_ID: keyId,
    SGD_SIGNING_ISSUER: "https://shareguard.systems",
    SGD_SIGNING_PRIVATE_JWK: JSON.stringify(privateJwk),
    SGD_SIGNING_PUBLIC_JWK: JSON.stringify(publicJwk),
  };
}


async function sealedCase(keyId = "sg-signing-2026-01", mediaSha256 = "d".repeat(64)) {
  const actorId = `sg_actor_${"c".repeat(32)}`;
  const created = await createCase({
    request_id: "sg_req_test",
    media_sha256: mediaSha256,
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
    payload: { key_id: keyId },
  }, { actorId, now: "2026-08-08T04:02:00.000Z" });
}


test("server evidence is signed by the configured ShareGuard trust root", async () => {
  const env = await signingEnvironment();
  const record = await sealedCase();

  const evidencePackage = await signEvidence(record, env);
  const trustRoot = publicTrustRoot(env);
  const verification = await verifyEvidencePackage(evidencePackage, [trustRoot]);

  assert.equal(evidencePackage.schema, "shareguard.sgd.v3");
  assert.equal(evidencePackage.issuer, "https://shareguard.systems");
  assert.equal(evidencePackage.key_id, "sg-signing-2026-01");
  assert.equal(evidencePackage.signed_at, record.sealed_at);
  assert.equal(evidencePackage.case.case_id, record.case_id);
  assert.match(evidencePackage.payload_sha256, /^[0-9a-f]{64}$/);
  assert.match(evidencePackage.signature, /^[A-Za-z0-9_-]+$/);
  assert.equal("public_key" in evidencePackage, false);
  assert.equal(evidencePackage.media_manifest.length, 1);
  assert.equal(evidencePackage.media_manifest[0].inclusion, "detached_digest_only");
  assert.deepEqual(verification, {
    valid: true,
    trusted: true,
    reason: "valid_trusted",
    key_id: "sg-signing-2026-01",
    issuer: "https://shareguard.systems",
  });
});


test("v3 evidence embeds eligible media and detects byte tampering", async () => {
  const env = await signingEnvironment();
  const bytes = new TextEncoder().encode("original camera evidence");
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  const record = await sealedCase("sg-signing-2026-01", digest);
  const version = record.versions[0];
  const evidencePackage = await signEvidence(record, env, [{
    version_id: version.version_id,
    bytes,
    content_type: "image/jpeg",
    file_name: "camera.jpg",
  }]);

  assert.equal(evidencePackage.media_manifest[0].inclusion, "embedded");
  assert.equal(evidencePackage.media_manifest[0].byte_size, bytes.length);
  assert.equal(
    (await verifyEvidencePackage(evidencePackage, [publicTrustRoot(env)])).valid,
    true,
  );

  const encoded = evidencePackage.media_manifest[0].content_base64url;
  evidencePackage.media_manifest[0].content_base64url = `${encoded.slice(0, -1)}${encoded.endsWith("a") ? "b" : "a"}`;
  const tampered = await verifyEvidencePackage(evidencePackage, [publicTrustRoot(env)]);
  assert.equal(tampered.valid, false);
  assert.equal(tampered.reason, "embedded_media_digest_mismatch");
});


test("an attacker-supplied package key is ignored", async () => {
  const trustedEnv = await signingEnvironment("trusted-key");
  const attackerEnv = await signingEnvironment("attacker-key");
  const attackerCase = await sealedCase("attacker-key");
  const attackerPackage = await signEvidence(attackerCase, attackerEnv);
  attackerPackage.public_key = JSON.parse(attackerEnv.SGD_SIGNING_PUBLIC_JWK);

  const verification = await verifyEvidencePackage(
    attackerPackage,
    [publicTrustRoot(trustedEnv)],
  );

  assert.deepEqual(verification, {
    valid: false,
    trusted: false,
    reason: "untrusted_issuer_key",
    key_id: "attacker-key",
    issuer: "https://shareguard.systems",
  });
});


test("tampering with a signed case invalidates the package", async () => {
  const env = await signingEnvironment();
  const evidencePackage = await signEvidence(await sealedCase(), env);
  evidencePackage.case.human_decision.action = "allow";

  const verification = await verifyEvidencePackage(
    evidencePackage,
    [publicTrustRoot(env)],
  );

  assert.equal(verification.valid, false);
  assert.equal(verification.trusted, true);
  assert.equal(verification.reason, "payload_digest_mismatch");
});


test("signing fails closed for missing or mismatched keys", async () => {
  const env = await signingEnvironment();
  const other = await signingEnvironment();
  const record = await sealedCase();

  await assert.rejects(
    signEvidence(record, { ...env, SGD_SIGNING_PRIVATE_JWK: "" }),
    /private/i,
  );
  await assert.rejects(
    signEvidence(record, {
      ...env,
      SGD_SIGNING_PUBLIC_JWK: other.SGD_SIGNING_PUBLIC_JWK,
    }),
    /matching key pair/i,
  );
});
