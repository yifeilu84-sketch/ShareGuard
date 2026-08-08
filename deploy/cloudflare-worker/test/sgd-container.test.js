import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = globalThis;
await import("../../../shareguard/platform/static/sgd-container.js");


const evidencePackage = {
  schema: "shareguard.sgd.v3",
  issuer: "https://shareguard.systems",
  key_id: "test-key",
  case: { case_id: `sg_case_${"a".repeat(32)}` },
  media_manifest: [],
  signature: "test",
};


test("SGD3 containers gzip the signed payload and restore it exactly", async () => {
  const bytes = await ShareGuardSgd.pack(evidencePackage);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "SGD3\n");
  assert.equal(new TextDecoder().decode(bytes).includes(evidencePackage.case.case_id), false);

  const parsed = await ShareGuardSgd.unpack(bytes);
  assert.deepEqual(parsed.package, evidencePackage);
  assert.equal(parsed.encrypted, false);
  assert.equal(parsed.header.compression, "gzip");
});


test("SGD3 passphrase encryption is local, authenticated, and rejects a wrong passphrase", async () => {
  const bytes = await ShareGuardSgd.pack(evidencePackage, {
    passphrase: "correct horse battery staple",
  });
  const text = new TextDecoder().decode(bytes);
  assert.equal(text.includes(evidencePackage.case.case_id), false);
  const parsed = await ShareGuardSgd.unpack(bytes, {
    passphrase: "correct horse battery staple",
  });
  assert.deepEqual(parsed.package, evidencePackage);
  assert.equal(parsed.encrypted, true);
  assert.equal(parsed.header.encryption.algorithm, "AES-256-GCM");
  assert.equal(parsed.header.encryption.kdf, "PBKDF2-SHA256");

  await assert.rejects(
    ShareGuardSgd.unpack(bytes, { passphrase: "wrong passphrase" }),
    /decrypt|passphrase|integrity/i,
  );
});


test("legacy JSON evidence remains readable", async () => {
  const legacy = { ...evidencePackage, schema: "shareguard.sgd.v2" };
  const parsed = await ShareGuardSgd.unpack(
    new TextEncoder().encode(JSON.stringify(legacy)),
  );
  assert.deepEqual(parsed.package, legacy);
  assert.equal(parsed.legacy, true);
});
