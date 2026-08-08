const ACTOR_ID_PATTERN = /^sg_actor_[0-9a-f]{32}$/;
const CASE_ID_PATTERN = /^sg_case_[0-9a-f]{32}$/;
const VERSION_ID_PATTERN = /^sg_ver_[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 30;


function requiredId(value, pattern, field) {
  const normalized = String(value || "");
  if (!pattern.test(normalized)) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}


function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("media bytes are invalid");
}


function base64UrlEncode(bytes) {
  let binary = "";
  const value = bytesFrom(bytes);
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}


function decodeBase64(value) {
  const normalized = String(value || "").trim().replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("media encryption key is invalid");
  }
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}


async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytesFrom(bytes));
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}


async function encryptionKey(env) {
  const keyBytes = decodeBase64(env.MEDIA_ENCRYPTION_KEY_B64);
  if (keyBytes.length !== 32) {
    throw new Error("media encryption key must contain 32 bytes");
  }
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}


function retentionDays(value) {
  const parsed = Number.parseInt(String(value || DEFAULT_RETENTION_DAYS), 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RETENTION_DAYS) {
    throw new Error("media retention configuration is invalid");
  }
  return parsed;
}


function metadataAad({ actorId, caseId, versionId, digest, contentType, keyVersion }) {
  return new TextEncoder().encode([
    "shareguard.private-media.v1",
    actorId,
    caseId,
    versionId,
    digest,
    contentType,
    keyVersion,
  ].join("\n"));
}


export function mediaObjectKey(actorId, caseId, versionId) {
  return [
    "v1",
    requiredId(actorId, ACTOR_ID_PATTERN, "actor_id"),
    requiredId(caseId, CASE_ID_PATTERN, "case_id"),
    `${requiredId(versionId, VERSION_ID_PATTERN, "version_id")}.sgm`,
  ].join("/");
}


export function privateMediaReady(env) {
  return Boolean(
    env?.MEDIA_BUCKET &&
    typeof env.MEDIA_BUCKET.put === "function" &&
    typeof env.MEDIA_BUCKET.get === "function" &&
    String(env.MEDIA_ENCRYPTION_KEY_B64 || "").trim(),
  );
}


export async function storePrivateMedia(env, options) {
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.put !== "function") {
    throw new Error("private media bucket is unavailable");
  }
  const actorId = requiredId(options.actorId, ACTOR_ID_PATTERN, "actor_id");
  const caseId = requiredId(options.caseId, CASE_ID_PATTERN, "case_id");
  const versionId = requiredId(options.versionId, VERSION_ID_PATTERN, "version_id");
  const bytes = bytesFrom(options.bytes);
  if (!bytes.length) throw new Error("media bytes are empty");
  const contentType = String(options.contentType || "application/octet-stream").toLowerCase();
  if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(contentType)) {
    throw new Error("media content type is unsupported");
  }
  const fileName = String(options.fileName || "upload").trim().slice(0, 255) || "upload";
  const digest = await sha256Hex(bytes);
  const expected = String(options.expectedSha256 || "").toLowerCase();
  if (expected && (!SHA256_PATTERN.test(expected) || expected !== digest)) {
    throw new Error("media digest does not match inference result");
  }
  const keyVersion = String(env.MEDIA_ENCRYPTION_KEY_VERSION || "media-v1").trim();
  if (!keyVersion || keyVersion.length > 64) {
    throw new Error("media encryption key version is invalid");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(env);
  const ciphertext = await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv,
    additionalData: metadataAad({ actorId, caseId, versionId, digest, contentType, keyVersion }),
    tagLength: 128,
  }, key, bytes);
  const now = new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("media timestamp is invalid");
  const retentionUntil = new Date(now);
  retentionUntil.setUTCDate(retentionUntil.getUTCDate() + retentionDays(env.MEDIA_RETENTION_DAYS));
  const custody = {
    status: "encrypted_private",
    plaintext_sha256: digest,
    byte_size: bytes.length,
    content_type: contentType,
    file_name: fileName,
    stored_at: now.toISOString(),
    retention_until: retentionUntil.toISOString(),
    encryption: {
      algorithm: "AES-256-GCM",
      key_version: keyVersion,
      iv: base64UrlEncode(iv),
    },
  };
  await env.MEDIA_BUCKET.put(mediaObjectKey(actorId, caseId, versionId), ciphertext, {
    customMetadata: {
      schema: "shareguard.private-media.v1",
      digest,
      content_type: contentType,
      key_version: keyVersion,
      iv: custody.encryption.iv,
    },
  });
  return custody;
}


export async function readPrivateMedia(env, options) {
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.get !== "function") {
    throw new Error("private media bucket is unavailable");
  }
  const actorId = requiredId(options.actorId, ACTOR_ID_PATTERN, "actor_id");
  const caseId = requiredId(options.caseId, CASE_ID_PATTERN, "case_id");
  const versionId = requiredId(options.versionId, VERSION_ID_PATTERN, "version_id");
  const custody = options.custody || {};
  if (custody.status !== "encrypted_private") {
    throw new Error("private media is not available");
  }
  const stored = await env.MEDIA_BUCKET.get(mediaObjectKey(actorId, caseId, versionId));
  if (!stored) throw new Error("private media object is missing");
  const ciphertext = new Uint8Array(await new Response(stored.body).arrayBuffer());
  const iv = decodeBase64(custody.encryption?.iv);
  if (iv.length !== 12 || custody.encryption?.algorithm !== "AES-256-GCM") {
    throw new Error("private media encryption metadata is invalid");
  }
  const digest = String(custody.plaintext_sha256 || "");
  const contentType = String(custody.content_type || "application/octet-stream");
  const keyVersion = String(custody.encryption?.key_version || "");
  try {
    const key = await encryptionKey(env);
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv,
      additionalData: metadataAad({ actorId, caseId, versionId, digest, contentType, keyVersion }),
      tagLength: 128,
    }, key, ciphertext);
    const bytes = new Uint8Array(plaintext);
    if (await sha256Hex(bytes) !== digest) {
      throw new Error("private media integrity check failed");
    }
    return {
      bytes,
      contentType,
      fileName: String(custody.file_name || "media"),
      sha256: digest,
    };
  } catch (error) {
    if (String(error?.message || "").includes("integrity")) throw error;
    throw new Error("private media could not be decrypted or failed integrity validation");
  }
}


export async function deletePrivateMedia(env, options) {
  if (!env?.MEDIA_BUCKET || typeof env.MEDIA_BUCKET.delete !== "function") return;
  await env.MEDIA_BUCKET.delete(mediaObjectKey(
    options.actorId,
    options.caseId,
    options.versionId,
  ));
}
