import { canonicalJson, verifyEventChain } from "./case-store.js";


const PACKAGE_SCHEMA = "shareguard.sgd.v3";
const LEGACY_PACKAGE_SCHEMA = "shareguard.sgd.v2";
const SIGNATURE_ALGORITHM = "ECDSA_P256_SHA256";
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{3,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EMBEDDED_MEDIA_BYTES = 8 * 1024 * 1024;


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


async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}


function signedPayload(evidencePackage) {
  const payload = {
    schema: evidencePackage.schema,
    issuer: evidencePackage.issuer,
    key_id: evidencePackage.key_id,
    signed_at: evidencePackage.signed_at,
    signature_algorithm: evidencePackage.signature_algorithm,
    case: evidencePackage.case,
  };
  if (evidencePackage.schema === PACKAGE_SCHEMA) {
    payload.media_manifest = evidencePackage.media_manifest;
  }
  return payload;
}


function mediaEntryBytes(entry) {
  const bytes = entry?.bytes;
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new Error("Evidence media bytes are invalid.");
}


async function buildMediaManifest(caseRecord, mediaEntries) {
  const supplied = new Map();
  for (const entry of Array.isArray(mediaEntries) ? mediaEntries : []) {
    const versionId = String(entry?.version_id || "");
    if (!/^sg_ver_[0-9a-f]{32}$/.test(versionId) || supplied.has(versionId)) {
      throw new Error("Evidence media version is invalid.");
    }
    supplied.set(versionId, entry);
  }
  return Promise.all((caseRecord.versions || []).map(async version => {
    const entry = supplied.get(version.version_id);
    const base = {
      version_id: version.version_id,
      media_sha256: version.media_sha256,
      file_name: String(version.file_name || "media"),
      content_type: String(version.media_custody?.content_type || ""),
      byte_size: Number.isSafeInteger(version.media_custody?.byte_size)
        ? version.media_custody.byte_size
        : null,
    };
    if (!entry) {
      return { ...base, inclusion: "detached_digest_only" };
    }
    const bytes = mediaEntryBytes(entry);
    if (!bytes.length || bytes.length > MAX_EMBEDDED_MEDIA_BYTES) {
      return { ...base, inclusion: "detached_digest_only" };
    }
    const digest = await sha256Bytes(bytes);
    if (digest !== version.media_sha256) {
      throw new Error("Evidence media digest does not match the case version.");
    }
    return {
      ...base,
      content_type: String(entry.content_type || base.content_type || "application/octet-stream"),
      file_name: String(entry.file_name || base.file_name),
      byte_size: bytes.length,
      inclusion: "embedded",
      content_base64url: base64UrlEncode(bytes),
    };
  }));
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


export async function signEvidence(caseRecord, env, mediaEntries = []) {
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
    media_manifest: await buildMediaManifest(caseRecord, mediaEntries),
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
    !new Set([PACKAGE_SCHEMA, LEGACY_PACKAGE_SCHEMA]).has(evidencePackage.schema) ||
    evidencePackage.signature_algorithm !== SIGNATURE_ALGORITHM ||
    !evidencePackage.case ||
    typeof evidencePackage.signature !== "string" ||
    !SHA256_PATTERN.test(String(evidencePackage.payload_sha256 || ""))
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

  if (evidencePackage.schema === PACKAGE_SCHEMA) {
    if (!Array.isArray(evidencePackage.media_manifest)) {
      return verificationResult(evidencePackage, false, true, "invalid_media_manifest");
    }
    const versions = new Map((evidencePackage.case.versions || []).map(version => (
      [version.version_id, version]
    )));
    if (evidencePackage.media_manifest.length !== versions.size) {
      return verificationResult(evidencePackage, false, true, "invalid_media_manifest");
    }
    const seen = new Set();
    for (const entry of evidencePackage.media_manifest) {
      const version = versions.get(entry?.version_id);
      if (
        !version ||
        seen.has(entry.version_id) ||
        entry.media_sha256 !== version.media_sha256 ||
        !new Set(["embedded", "detached_digest_only"]).has(entry.inclusion)
      ) {
        return verificationResult(evidencePackage, false, true, "invalid_media_manifest");
      }
      seen.add(entry.version_id);
      if (entry.inclusion === "embedded") {
        try {
          const bytes = base64UrlDecode(entry.content_base64url);
          if (
            bytes.length !== entry.byte_size ||
            bytes.length > MAX_EMBEDDED_MEDIA_BYTES ||
            await sha256Bytes(bytes) !== entry.media_sha256
          ) {
            return verificationResult(
              evidencePackage,
              false,
              true,
              "embedded_media_digest_mismatch",
            );
          }
        } catch {
          return verificationResult(
            evidencePackage,
            false,
            true,
            "embedded_media_digest_mismatch",
          );
        }
      }
    }
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
