const OWNER_PATTERN = /^sg_actor_[0-9a-f]{32}$/;
const CASE_PATTERN = /^sg_case_[0-9a-f]{32}$/;
const GRANT_PATTERN = /^sg_grant_[0-9a-f]{32}$/;
const REVIEWER_PATTERN = /^sg_actor_[0-9a-f]{32}$/;
const MIN_EXPIRY_SECONDS = 300;
const MAX_EXPIRY_SECONDS = 30 * 24 * 60 * 60;


function base64UrlEncode(bytes) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}


function base64UrlDecode(value) {
  const normalized = String(value || "").replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error("review token is invalid");
  }
}


function tokenSecret(env) {
  const secret = String(env?.REVIEW_TOKEN_SECRET || "");
  if (secret.length < 32 || secret.length > 4096) {
    throw new Error("review token configuration is unavailable");
  }
  return secret;
}


async function hmacKey(env) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(tokenSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}


async function hmacBytes(env, value) {
  return new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env),
    new TextEncoder().encode(value),
  ));
}


function required(value, pattern, field) {
  const normalized = String(value || "");
  if (!pattern.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}


function timestamp(value) {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) throw new Error("review token timestamp is invalid");
  return parsed;
}


function boundedName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 120) throw new Error("reviewer name is invalid");
  return name;
}


function parseTokenPayload(bytes) {
  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("review token is invalid");
  }
  if (
    !payload ||
    payload.schema !== "shareguard.review-token.v1" ||
    payload.role !== "reviewer" ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp)
  ) {
    throw new Error("review token is invalid");
  }
  required(payload.owner_id, OWNER_PATTERN, "owner_id");
  required(payload.case_id, CASE_PATTERN, "case_id");
  required(payload.grant_id, GRANT_PATTERN, "grant_id");
  required(payload.reviewer_actor_id, REVIEWER_PATTERN, "reviewer_actor_id");
  boundedName(payload.reviewer_name);
  return payload;
}


export async function issueReviewToken(env, options) {
  tokenSecret(env);
  const ownerId = required(options.ownerId, OWNER_PATTERN, "owner_id");
  const caseId = required(options.caseId, CASE_PATTERN, "case_id");
  const reviewerName = boundedName(options.reviewerName);
  const expiresInSeconds = Number.parseInt(String(options.expiresInSeconds || 3600), 10);
  if (
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < MIN_EXPIRY_SECONDS ||
    expiresInSeconds > MAX_EXPIRY_SECONDS
  ) {
    throw new Error("review token expiry is invalid");
  }
  const now = timestamp(options.now);
  const issuedAt = Math.floor(now.getTime() / 1000);
  const grantId = `sg_grant_${crypto.randomUUID().replaceAll("-", "")}`;
  const reviewerDigest = await hmacBytes(env, `shareguard-reviewer:${grantId}`);
  const reviewerActorId = `sg_actor_${[...reviewerDigest.subarray(0, 16)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  const payload = {
    schema: "shareguard.review-token.v1",
    owner_id: ownerId,
    case_id: caseId,
    grant_id: grantId,
    reviewer_actor_id: reviewerActorId,
    reviewer_name: reviewerName,
    role: "reviewer",
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
  };
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmacBytes(env, encodedPayload));
  return {
    token: `${encodedPayload}.${signature}`,
    grant: {
      grant_id: grantId,
      reviewer_actor_id: reviewerActorId,
      reviewer_name: reviewerName,
      role: "reviewer",
      issued_at: now.toISOString(),
      expires_at: new Date((issuedAt + expiresInSeconds) * 1000).toISOString(),
    },
  };
}


export async function verifyReviewToken(env, token, options = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("review token is invalid");
  }
  const signature = base64UrlDecode(parts[1]);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env),
    signature,
    new TextEncoder().encode(parts[0]),
  );
  if (!valid) throw new Error("review token signature is invalid");
  const payload = parseTokenPayload(base64UrlDecode(parts[0]));
  const nowSeconds = Math.floor(timestamp(options.now).getTime() / 1000);
  if (payload.exp <= nowSeconds) throw new Error("review token has expired");
  if (payload.iat > nowSeconds + 60 || payload.exp - payload.iat > MAX_EXPIRY_SECONDS) {
    throw new Error("review token timing is invalid");
  }
  return payload;
}
