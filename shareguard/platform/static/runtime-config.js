"use strict";

window.ShareGuardRuntime = Object.freeze({
  apiBaseUrl: "https://api.shareguard.systems",
  allowedPageOrigin: "https://shareguard.systems",
  credentialPersistence: "memory-only",
  evidencePackageSchema: "shareguard.sgd.v2",
  trustRoots: Object.freeze([
    Object.freeze({
      schema: "shareguard.trust-root.v1",
      issuer: "https://shareguard.systems",
      key_id: "sg-signing-2026-01",
      algorithm: "ECDSA_P256_SHA256",
      public_jwk: Object.freeze({
        key_ops: ["verify"],
        ext: true,
        kty: "EC",
        x: "YnqOieTlmC91Zd0SVXW3kJsEOlbw4Cx_dM2UwtaKc5E",
        y: "brPg1atNkAnWEIAO2WJvBaJKujfV-LirWa3O0RF9XnM",
        crv: "P-256"
      })
    })
  ])
});
