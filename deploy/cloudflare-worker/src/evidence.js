import { canonicalJson, verifyEventChain } from "./case-store.js";


const PACKAGE_SCHEMA = "shareguard.sgd.v2";
const SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256";
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{3,128}$/;


function parseJwk(value, label, { privateKey = false } = {}) {
  if (!value) {
    throw new Error(`Signing ${label} key is unavailable.`);
  }
  let jwk;
  try {
    jwk = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
  } catch {
    throw new Error(`Signing ${label} key is invalid.`);
  }
  if (
    !jwk ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    (privateKey && typeof jwk.d !== "string") ||
    (!privateKey && "d" in jwk)
  ) {
    throw new Error(`Signing ${label} key is invalid.`);
  }
  return jwk;
}


function signingIdentity(env) {
  const keyId = String(env.SGD_SIGNING_KEY_ID || "").trim();
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Signing key id is invalid.");
  }
  const issuer = String(env.SGD_SIGNING_ISSUER || "").trim();
  let parsed;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error("Signing issuer is invalid.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Signing issuer is invalid.");
  }
  return { keyId, issuer: parsed.toString().replace(/\/$/, "") };
}


function base64UrlEncode(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}


function base64UrlDecode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ""))) {
    throw new Error("Signature encoding is invalid.");
  }
  const normalized = String(value)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}


async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}


function signedPayload(evidencePackage) {
  return {
    schema: evidencePackage.schema,
    issuer: evidencePackage.issuer,
    key_id: evidencePackage.key_id,
    signed_at: evidencePackage.signed_at,
    signature_algorithm: evidencePackage.signature_algorithm,
    case: evidencePackage.case,
  };
}


export function publicTrustRoot(env) {
  const { keyId, issuer } = signingIdentity(env);
  const publicJwk = parseJwk(env.SGD_SIGNING_PUBLIC_JWK, "public");
  return {
    schema: "shareguard.trust-root.v1",
    issuer,
    key_id: keyId,
    algorithm: SIGNATURE_ALGORITHM,
    public_jwk: publicJwk,
  };
}


export async function assertSigningReady(env) {
  const trustRoot = publicTrustRoot(env);
  const privateJwk = parseJwk(
    env.SGD_SIGNING_PRIVATE_JWK,
    "private",
    { privateKey: true },
  );
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    trustRoot.public_jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const challenge = new TextEncoder().encode(
    `shareguard-signing-check:${trustRoot.issuer}:${trustRoot.key_id}`,
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    challenge,
  );
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    challenge,
  )) {
    throw new Error("Signing keys are not a matching key pair.");
  }
  return trustRoot;
}


export async function signEvidence(caseRecord, env) {
  const trustRoot = publicTrustRoot(env);
  const privateJwk = parseJwk(
    env.SGD_SIGNING_PRIVATE_JWK,
    "private",
    { privateKey: true },
  );
  if (
    !caseRecord ||
    caseRecord.status !== "sealed" ||
    !caseRecord.sealed_at ||
    !caseRecord.human_decision
  ) {
    throw new Error("Only a decided and sealed case can be signed.");
  }
  if (!await verifyEventChain(caseRecord.events)) {
    throw new Error("Case event chain is invalid.");
  }
  if (caseRecord.chain_head !== caseRecord.events.at(-1)?.event_hash) {
    throw new Error("Case chain head is invalid.");
  }
  const sealEvent = caseRecord.events.at(-1);
  if (
    sealEvent.event_type !== "case_sealed" ||
    sealEvent.payload?.key_id !== trustRoot.key_id
  ) {
    throw new Error("Case sealing key does not match the active key.");
  }

  const evidencePackage = {
    schema: PACKAGE_SCHEMA,
    issuer: trustRoot.issuer,
    key_id: trustRoot.key_id,
    signed_at: caseRecord.sealed_at,
    signature_algorithm: SIGNATURE_ALGORITHM,
    case: structuredClone(caseRecord),
  };
  const canonical = canonicalJson(signedPayload(evidencePackage));
  const encoded = new TextEncoder().encode(canonical);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    trustRoot.public_jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoded,
  );
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signature,
    encoded,
  )) {
    throw new Error("Signing keys are not a matching key pair.");
  }
  return {
    ...evidencePackage,
    payload_sha256: await sha256Hex(canonical),
    signature: base64UrlEncode(signature),
  };
}


function verificationResult(evidencePackage, valid, trusted, reason) {
  return {
    valid,
    trusted,
    reason,
    key_id: String(evidencePackage?.key_id || ""),
    issuer: String(evidencePackage?.issuer || ""),
  };
}


export async function verifyEvidencePackage(evidencePackage, trustRoots) {
  if (
    !evidencePackage ||
    evidencePackage.schema !== PACKAGE_SCHEMA ||
    evidencePackage.signature_algorithm !== SIGNATURE_ALGORITHM ||
    !evidencePackage.case ||
    typeof evidencePackage.signature !== "string" ||
    !/^[0-9a-f]{64}$/.test(String(evidencePackage.payload_sha256 || ""))
  ) {
    return verificationResult(evidencePackage, false, false, "invalid_package_shape");
  }
  const trustRoot = (Array.isArray(trustRoots) ? trustRoots : []).find(root => (
    root?.issuer === evidencePackage.issuer &&
    root?.key_id === evidencePackage.key_id &&
    root?.algorithm === SIGNATURE_ALGORITHM
  ));
  if (!trustRoot) {
    return verificationResult(evidencePackage, false, false, "untrusted_issuer_key");
  }
  if (
    !await verifyEventChain(evidencePackage.case.events) ||
    evidencePackage.case.chain_head !== evidencePackage.case.events.at(-1)?.event_hash
  ) {
    return verificationResult(evidencePackage, false, true, "invalid_event_chain");
  }

  const canonical = canonicalJson(signedPayload(evidencePackage));
  if (await sha256Hex(canonical) !== evidencePackage.payload_sha256) {
    return verificationResult(evidencePackage, false, true, "payload_digest_mismatch");
  }
  try {
    const publicJwk = parseJwk(trustRoot.public_jwk, "public");
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlDecode(evidencePackage.signature),
      new TextEncoder().encode(canonical),
    );
    return verificationResult(
      evidencePackage,
      valid,
      true,
      valid ? "valid_trusted" : "invalid_signature",
    );
  } catch {
    return verificationResult(evidencePackage, false, true, "invalid_signature");
  }
}
