import { reviewGrantIsActive, ShareGuardCaseStore } from "./case-store.js";
import {
  assertSigningReady,
  publicTrustRoot,
  signEvidence,
} from "./evidence.js";
import {
  deletePrivateMedia,
  privateMediaReady,
  readPrivateMedia,
  storePrivateMedia,
} from "./media-store.js";
import { issueReviewToken, verifyReviewToken } from "./review-access.js";

export { ShareGuardCaseStore };


const STATIC_ROUTES = new Map([
  ["/v1/health", { kind: "health", methods: new Set(["GET"]) }],
  ["/v1/ready", { kind: "ready", methods: new Set(["GET"]) }],
  ["/v1/analyze", { kind: "analyze", methods: new Set(["POST"]) }],
  ["/v1/trust-root", { kind: "trust_root", methods: new Set(["GET"]) }],
  ["/v1/cases", { kind: "case_store", methods: new Set(["GET"]) }],
  ["/v1/metrics", { kind: "case_store", methods: new Set(["GET"]) }],
]);
const CASE_ROUTE = /^\/v1\/cases\/(sg_case_[0-9a-f]{32})(?:\/(decision|annotations|provenance|feedback|workflow|comments|seal))?$/;
const CASE_MEDIA_ROUTE = /^\/v1\/cases\/(sg_case_[0-9a-f]{32})\/versions\/(sg_ver_[0-9a-f]{32})\/media$/;
const CASE_REVIEW_GRANT_ROUTE = /^\/v1\/cases\/(sg_case_[0-9a-f]{32})\/review-grants(?:\/(sg_grant_[0-9a-f]{32})\/revoke)?$/;
const REVIEW_MEDIA_ROUTE = /^\/v1\/review\/media\/(sg_ver_[0-9a-f]{32})$/;
const REVIEW_ROUTES = new Map([
  ["/v1/review/case", new Set(["GET"])],
  ["/v1/review/comments", new Set(["POST"])],
  ["/v1/review/annotations", new Set(["POST"])],
]);

const EDGE_CLIENT_ID_HEADER = "X-ShareGuard-Client-Id";
const LEGACY_EDGE_SECRET_HEADER = "X-ShareGuard-Edge-Secret";
const EDGE_TIMESTAMP_HEADER = "X-ShareGuard-Edge-Timestamp";
const EDGE_SIGNATURE_HEADER = "X-ShareGuard-Edge-Signature";
const CASE_ID_HEADER = "X-ShareGuard-Case-Id";
const VERSION_ROLE_HEADER = "X-ShareGuard-Version-Role";
const CASE_TITLE_HEADER = "X-ShareGuard-Case-Title";
const CASE_TITLE_B64_HEADER = "X-ShareGuard-Case-Title-B64";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;


function corsHeaders(origin, env) {
  if (!origin || origin !== env.ALLOWED_ORIGIN) {
    return {};
  }

  return {
    "Access-Control-Allow-Headers": (
      "Authorization, Content-Type, X-File-Name, X-ShareGuard-Case-Id, " +
      "X-ShareGuard-Version-Role, X-ShareGuard-Case-Title, " +
      "X-ShareGuard-Case-Title-B64"
    ),
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}


function jsonResponse(
  status,
  code,
  message,
  origin,
  env,
  extraHeaders = {},
) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders(origin, env),
        ...extraHeaders,
      },
    },
  );
}


function jsonPayloadResponse(payload, status, origin, env, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin, env),
      ...extraHeaders,
    },
  });
}


function routeFor(pathname) {
  const staticRoute = STATIC_ROUTES.get(pathname);
  if (staticRoute) {
    return staticRoute;
  }
  if (CASE_MEDIA_ROUTE.test(pathname)) {
    return { kind: "media", methods: new Set(["GET"]) };
  }
  const grantMatch = pathname.match(CASE_REVIEW_GRANT_ROUTE);
  if (grantMatch) {
    return { kind: "review_grant", methods: new Set(["POST"]) };
  }
  const reviewMethods = REVIEW_ROUTES.get(pathname);
  if (reviewMethods) {
    return { kind: "review", methods: reviewMethods };
  }
  if (REVIEW_MEDIA_ROUTE.test(pathname)) {
    return { kind: "review", methods: new Set(["GET"]) };
  }
  const match = pathname.match(CASE_ROUTE);
  if (!match) {
    return null;
  }
  return {
    kind: "case_store",
    methods: new Set([match[2] ? "POST" : "GET", ...(match[2] ? [] : ["DELETE"])]),
  };
}


function randomOpaqueId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}


function mediaCustodyRequired(env) {
  return String(env.MEDIA_CUSTODY_REQUIRED || "").toLowerCase() === "true";
}


async function uploadedMedia(request, env, fileName) {
  const contentTypeHeader = String(request.headers.get("Content-Type") || "");
  let blob;
  if (contentTypeHeader.toLowerCase().startsWith("multipart/form-data")) {
    const form = await request.formData();
    blob = form.get("image");
    if (!(blob instanceof Blob)) {
      throw new Error("media upload is missing");
    }
  } else {
    blob = await request.blob();
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const configuredMax = Number.parseInt(String(env.MEDIA_MAX_BYTES || "8388608"), 10);
  const maxBytes = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? configuredMax
    : 8_388_608;
  if (!bytes.length || bytes.length > maxBytes) {
    throw new Error("media upload size is invalid");
  }
  const contentType = String(blob.type || contentTypeHeader.split(";", 1)[0]).toLowerCase();
  return {
    bytes,
    contentType,
    fileName: String(blob.name || fileName || "upload"),
  };
}


function decodeBasicUsername(headerValue) {
  const [scheme, encoded, ...rest] = String(headerValue || "").split(" ");
  if (scheme.toLowerCase() !== "basic" || !encoded || rest.length) {
    return "";
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(":");
    return separator > 0 ? decoded.slice(0, separator).trim().toLowerCase() : "";
  } catch {
    return "";
  }
}


function decodeCaseTitle(headers) {
  const encoded = String(headers.get(CASE_TITLE_B64_HEADER) || "").trim();
  if (encoded) {
    if (encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new Error("invalid encoded case title");
    }
    const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  }
  return String(headers.get(CASE_TITLE_HEADER) || "").trim();
}


function parseModalOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    return null;
  }

  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    return null;
  }

  return origin;
}


function positiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}


function retryAfterSeconds(now, bucket, windowMs) {
  return Math.max(1, Math.ceil((((bucket + 1) * windowMs) - now) / 1000));
}


export function consumeQuotaState(previous, now, limits) {
  const minuteBucket = Math.floor(now / MINUTE_MS);
  const dayBucket = Math.floor(now / DAY_MS);
  const minuteCount = previous.minuteBucket === minuteBucket
    ? Number(previous.minuteCount || 0)
    : 0;
  const dayCount = previous.dayBucket === dayBucket
    ? Number(previous.dayCount || 0)
    : 0;

  if (dayCount >= limits.perDay) {
    return {
      allowed: false,
      reason: "day",
      retryAfter: retryAfterSeconds(now, dayBucket, DAY_MS),
      state: previous,
    };
  }
  if (minuteCount >= limits.perMinute) {
    return {
      allowed: false,
      reason: "minute",
      retryAfter: retryAfterSeconds(now, minuteBucket, MINUTE_MS),
      state: previous,
    };
  }

  return {
    allowed: true,
    reason: null,
    retryAfter: 0,
    state: {
      minuteBucket,
      minuteCount: minuteCount + 1,
      dayBucket,
      dayCount: dayCount + 1,
    },
  };
}


export class ShareGuardRateLimiter {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/consume") {
      return new Response("Not found", { status: 404 });
    }

    const perMinute = positiveInteger(this.env.EDGE_RATE_LIMIT_PER_MINUTE);
    const perDay = positiveInteger(this.env.EDGE_DAILY_QUOTA);
    if (!perMinute || !perDay) {
      return new Response("Quota configuration unavailable", { status: 503 });
    }

    const outcome = await this.state.storage.transaction(async transaction => {
      const stored = await transaction.get([
        "minuteBucket",
        "minuteCount",
        "dayBucket",
        "dayCount",
      ]);
      const previous = Object.fromEntries(stored);
      const result = consumeQuotaState(previous, Date.now(), {
        perMinute,
        perDay,
      });
      if (result.allowed) {
        await transaction.put(result.state);
      }
      return result;
    });

    return new Response(
      JSON.stringify({
        allowed: outcome.allowed,
        retry_after: outcome.retryAfter,
      }),
      {
        status: outcome.allowed ? 200 : 429,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "application/json; charset=utf-8",
        },
      },
    );
  }
}


async function hmacHex(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(message),
  );
  return [...new Uint8Array(signature)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}


function hmacClientId(secret, clientAddress) {
  return hmacHex(secret, `shareguard-client:${clientAddress}`);
}


function hexBytes(value) {
  if (!/^[0-9a-f]{64}$/.test(String(value))) {
    return null;
  }
  return Uint8Array.from(
    String(value).match(/.{2}/g),
    byte => Number.parseInt(byte, 16),
  );
}


async function edgeAuthorizationIsValid(request, env) {
  const expected = hexBytes(env.EDGE_AUTH_HMAC);
  if (!env.EDGE_SHARED_SECRET || !expected) {
    throw new Error("edge authentication unavailable");
  }
  const presented = request.headers.get("Authorization") || "";
  if (!presented || presented.length > 1024) {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.EDGE_SHARED_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    encoder.encode(presented),
  );
}


async function edgeClientId(request, env) {
  if (!env.EDGE_SHARED_SECRET || !env.RATE_LIMITER) {
    throw new Error("edge configuration unavailable");
  }
  const clientAddress = request.headers.get("CF-Connecting-IP")?.trim();
  if (!clientAddress || clientAddress.length > 128 || /\s/.test(clientAddress)) {
    throw new Error("client identity unavailable");
  }
  return hmacClientId(env.EDGE_SHARED_SECRET, clientAddress);
}


async function authenticatedActorId(request, env) {
  if (!env.EDGE_SHARED_SECRET) {
    throw new Error("edge configuration unavailable");
  }
  const authorization = request.headers.get("Authorization") || "";
  const username = decodeBasicUsername(authorization);
  const subject = username || authorization;
  if (!subject) {
    throw new Error("authenticated subject unavailable");
  }
  const digest = await hmacHex(
    env.EDGE_SHARED_SECRET,
    `shareguard-actor:${subject}`,
  );
  return `sg_actor_${digest.slice(0, 32)}`;
}


function caseStoreStub(env, namespaceId) {
  if (!env.CASE_STORE) {
    throw new Error("case store unavailable");
  }
  const objectId = env.CASE_STORE.idFromName(namespaceId);
  return env.CASE_STORE.get(objectId);
}


async function callCaseStore(
  env,
  namespaceId,
  path,
  { method = "GET", payload = null, actorId = namespaceId, accessRole = "owner" } = {},
) {
  const init = { method };
  if (payload !== null) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({
      ...payload,
      actor_id: actorId,
      access_role: accessRole,
    });
  }
  return caseStoreStub(env, namespaceId).fetch(
    `https://shareguard-case-store.internal${path}`,
    init,
  );
}


async function proxyCaseStore(request, env, actorId, origin) {
  const requestUrl = new URL(request.url);
  const internalPath = (
    (requestUrl.pathname.replace(/^\/v1/, "") || "/") + requestUrl.search
  );
  let payload = null;
  if (request.method === "POST") {
    const contentLength = Number.parseInt(
      request.headers.get("Content-Length") || "0",
      10,
    );
    if (Number.isFinite(contentLength) && contentLength > 32_768) {
      return jsonResponse(
        413,
        "payload_too_large",
        "Case command exceeds the allowed size.",
        origin,
        env,
      );
    }
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(
        400,
        "invalid_json",
        "Request body must be valid JSON.",
        origin,
        env,
      );
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonResponse(
        400,
        "invalid_json",
        "Request body must be a JSON object.",
        origin,
        env,
      );
    }
    delete payload.actor_id;
    delete payload.access_role;
  }

  const response = await callCaseStore(env, actorId, internalPath, {
    method: request.method,
    payload,
  });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(corsHeaders(origin, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


function bearerToken(request) {
  const header = String(request.headers.get("Authorization") || "");
  const match = header.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/);
  return match?.[1] || "";
}


function sanitizedReviewCase(record, claims) {
  const output = structuredClone(record);
  delete output.review_grants;
  output.reviewer_context = {
    role: "reviewer",
    reviewer_name: claims.reviewer_name,
    grant_id: claims.grant_id,
    expires_at: new Date(claims.exp * 1000).toISOString(),
  };
  return output;
}


async function activeReviewContext(request, env) {
  const token = bearerToken(request);
  if (!token) throw new Error("review token is required");
  const claims = await verifyReviewToken(env, token);
  const stored = await callCaseStore(env, claims.owner_id, `/cases/${claims.case_id}`);
  if (!stored.ok) throw new Error("review case is unavailable");
  const payload = await stored.json();
  if (!payload.case || !reviewGrantIsActive(payload.case, claims)) {
    throw new Error("review grant is inactive");
  }
  return { claims, record: payload.case };
}


async function handleReviewRequest(request, env, origin) {
  let context;
  try {
    context = await activeReviewContext(request, env);
  } catch {
    return jsonResponse(
      401,
      "review_access_denied",
      "This review link is invalid, expired, or revoked.",
      origin,
      env,
    );
  }
  const { claims, record } = context;
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname === "/v1/review/case") {
    return jsonPayloadResponse({ case: sanitizedReviewCase(record, claims) }, 200, origin, env);
  }
  const mediaMatch = pathname.match(REVIEW_MEDIA_ROUTE);
  if (request.method === "GET" && mediaMatch) {
    const versionId = mediaMatch[1];
    const version = record.versions?.find(item => item.version_id === versionId);
    if (!version) {
      return jsonResponse(404, "version_not_found", "Version not found.", origin, env);
    }
    try {
      const media = await readPrivateMedia(env, {
        actorId: claims.owner_id,
        caseId: claims.case_id,
        versionId,
        custody: version.media_custody,
      });
      return new Response(media.bytes, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Type": media.contentType,
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.fileName)}`,
          "X-Content-Type-Options": "nosniff",
          "X-ShareGuard-Media-SHA256": media.sha256,
          ...corsHeaders(origin, env),
        },
      });
    } catch {
      return jsonResponse(409, "media_not_available", "Private media is unavailable.", origin, env);
    }
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, "invalid_json", "Request body must be valid JSON.", origin, env);
  }
  const command = pathname === "/v1/review/comments" ? "comments" : "annotations";
  const stored = await callCaseStore(
    env,
    claims.owner_id,
    `/cases/${claims.case_id}/${command}`,
    {
      method: "POST",
      payload,
      actorId: claims.reviewer_actor_id,
      accessRole: "reviewer",
    },
  );
  const result = await stored.json();
  if (!stored.ok || !result.case) {
    return jsonPayloadResponse(result, stored.status || 503, origin, env);
  }
  return jsonPayloadResponse({
    case: sanitizedReviewCase(result.case, claims),
  }, 200, origin, env);
}


async function manageReviewGrant(request, env, actorId, origin) {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(CASE_REVIEW_GRANT_ROUTE);
  if (!match) return jsonResponse(404, "not_found", "Route not found.", origin, env);
  const [, caseId, grantId] = match;
  if (grantId) {
    return proxyCaseStore(request, env, actorId, origin);
  }
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, "invalid_json", "Request body must be valid JSON.", origin, env);
  }
  const existing = await callCaseStore(env, actorId, `/cases/${caseId}`);
  if (!existing.ok) {
    return jsonPayloadResponse(await existing.json(), existing.status, origin, env);
  }
  const issued = await issueReviewToken(env, {
    ownerId: actorId,
    caseId,
    reviewerName: payload.reviewer_name,
    expiresInSeconds: payload.expires_in_seconds,
  });
  const stored = await callCaseStore(env, actorId, `/cases/${caseId}/review-grants`, {
    method: "POST",
    payload: issued.grant,
  });
  const result = await stored.json();
  if (!stored.ok || !result.case) {
    return jsonPayloadResponse(result, stored.status || 503, origin, env);
  }
  return jsonPayloadResponse({
    grant: issued.grant,
    token: issued.token,
    review_url: `${env.ALLOWED_ORIGIN}/#review_token=${encodeURIComponent(issued.token)}`,
    case: result.case,
  }, 201, origin, env);
}


async function sealCase(request, env, actorId, origin) {
  const trustRoot = await assertSigningReady(env);
  const requestUrl = new URL(request.url);
  const internalPath = requestUrl.pathname.replace(/^\/v1/, "");
  const stored = await callCaseStore(env, actorId, internalPath, {
    method: "POST",
    payload: { key_id: trustRoot.key_id },
  });
  let payload;
  try {
    payload = await stored.json();
  } catch {
    return jsonResponse(
      503,
      "case_store_unavailable",
      "Case could not be sealed.",
      origin,
      env,
    );
  }
  if (!stored.ok || !payload.case) {
    return jsonPayloadResponse(payload, stored.status || 503, origin, env);
  }
  const configuredMax = Number.parseInt(String(env.SGD_EMBED_MEDIA_MAX_BYTES || "8388608"), 10);
  const embedMax = Number.isSafeInteger(configuredMax) && configuredMax > 0
    ? configuredMax
    : 8_388_608;
  const mediaEntries = [];
  for (const version of payload.case.versions || []) {
    if (
      version.media_custody?.status === "encrypted_private" &&
      Number(version.media_custody.byte_size) <= embedMax
    ) {
      const media = await readPrivateMedia(env, {
        actorId,
        caseId: payload.case.case_id,
        versionId: version.version_id,
        custody: version.media_custody,
      });
      mediaEntries.push({
        version_id: version.version_id,
        bytes: media.bytes,
        content_type: media.contentType,
        file_name: media.fileName,
      });
    }
  }
  const evidencePackage = await signEvidence(payload.case, env, mediaEntries);
  return jsonPayloadResponse(evidencePackage, 200, origin, env, {
    "Content-Disposition": (
      `attachment; filename="${payload.case.case_id}.sgd"`
    ),
  });
}


async function servePrivateMedia(request, env, actorId, origin) {
  const match = new URL(request.url).pathname.match(CASE_MEDIA_ROUTE);
  if (!match) {
    return jsonResponse(404, "not_found", "Route not found.", origin, env);
  }
  const [, caseId, versionId] = match;
  const stored = await callCaseStore(env, actorId, `/cases/${caseId}`);
  const payload = await stored.json();
  if (!stored.ok || !payload.case) {
    return jsonPayloadResponse(payload, stored.status || 503, origin, env);
  }
  const version = payload.case.versions?.find(item => item.version_id === versionId);
  if (!version) {
    return jsonResponse(404, "version_not_found", "Version not found.", origin, env);
  }
  if (version.media_custody?.status !== "encrypted_private") {
    return jsonResponse(
      409,
      "media_not_available",
      "This case version contains a detached digest only.",
      origin,
      env,
    );
  }
  const media = await readPrivateMedia(env, {
    actorId,
    caseId,
    versionId,
    custody: version.media_custody,
  });
  return new Response(media.bytes, {
    status: 200,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": media.contentType,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(media.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "X-ShareGuard-Media-SHA256": media.sha256,
      ...corsHeaders(origin, env),
    },
  });
}


async function deleteCaseAndMedia(request, env, actorId, origin) {
  const requestUrl = new URL(request.url);
  const internalPath = requestUrl.pathname.replace(/^\/v1/, "");
  const deleted = await callCaseStore(env, actorId, internalPath, { method: "DELETE" });
  let payload;
  try {
    payload = await deleted.json();
  } catch {
    return jsonResponse(503, "case_store_unavailable", "Case could not be deleted.", origin, env);
  }
  if (!deleted.ok || !payload.deleted) {
    return jsonPayloadResponse(payload, deleted.status || 503, origin, env);
  }
  for (const version of payload.media_versions || []) {
    if (version.custody_status === "encrypted_private") {
      await deletePrivateMedia(env, {
        actorId,
        caseId: payload.case_id,
        versionId: version.version_id,
      });
    }
  }
  return jsonPayloadResponse(payload, 200, origin, env);
}


async function consumeDurableQuota(env, clientId) {
  const objectId = env.RATE_LIMITER.idFromName(clientId);
  const response = await env.RATE_LIMITER.get(objectId).fetch(
    "https://shareguard-rate-limit.internal/consume",
    { method: "POST" },
  );
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("invalid quota response");
  }

  if (response.status === 429 && payload.allowed === false) {
    return {
      allowed: false,
      retryAfter: Math.max(
        1,
        Math.min(86_400, Number(payload.retry_after) || 60),
      ),
    };
  }
  if (!response.ok || payload.allowed !== true) {
    throw new Error("quota service unavailable");
  }
  return { allowed: true, retryAfter: 0 };
}


function upstreamRequest(request, modalOrigin, edgeIdentity) {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(requestUrl.pathname + requestUrl.search, modalOrigin);
  const forwarded = new Request(targetUrl.toString(), request);

  for (const key of [...forwarded.headers.keys()]) {
    const normalized = key.toLowerCase();
    if (
      normalized.startsWith("cf-access-") ||
      normalized === "cf-connecting-ip" ||
      normalized === "forwarded" ||
      normalized === "x-forwarded-for" ||
      normalized === EDGE_CLIENT_ID_HEADER.toLowerCase() ||
      normalized === LEGACY_EDGE_SECRET_HEADER.toLowerCase() ||
      normalized === EDGE_TIMESTAMP_HEADER.toLowerCase() ||
      normalized === EDGE_SIGNATURE_HEADER.toLowerCase() ||
      normalized === CASE_ID_HEADER.toLowerCase() ||
      normalized === VERSION_ROLE_HEADER.toLowerCase() ||
      normalized === CASE_TITLE_HEADER.toLowerCase() ||
      normalized === CASE_TITLE_B64_HEADER.toLowerCase()
    ) {
      forwarded.headers.delete(key);
    }
  }
  forwarded.headers.set(EDGE_CLIENT_ID_HEADER, edgeIdentity.clientId);
  forwarded.headers.set(EDGE_TIMESTAMP_HEADER, edgeIdentity.timestamp);
  forwarded.headers.set(EDGE_SIGNATURE_HEADER, edgeIdentity.signature);

  return forwarded;
}


function proxiedResponse(response, origin, env) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  for (const [key, value] of Object.entries(corsHeaders(origin, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


async function persistAnalysis(request, mediaRequest, response, env, actorId, origin, caseTitle) {
  if (!response.ok) {
    return proxiedResponse(response, origin, env);
  }
  let analysis;
  try {
    analysis = await response.json();
  } catch {
    return jsonResponse(
      503,
      "invalid_upstream_response",
      "Inference service returned an invalid response.",
      origin,
      env,
    );
  }

  const requestedCaseId = String(
    request.headers.get(CASE_ID_HEADER) || "",
  ).trim().toLowerCase();
  const requestedRole = String(
    request.headers.get(VERSION_ROLE_HEADER) || "",
  ).trim().toLowerCase();
  const versionRole = requestedRole || (
    requestedCaseId ? "observed_variant" : "original"
  );
  const title = String(caseTitle || "").trim();
  const fileName = String(
    request.headers.get("X-File-Name") ||
    analysis.report?.subject?.file_name ||
    "upload",
  ).trim();
  const caseId = requestedCaseId || randomOpaqueId("sg_case");
  const versionId = randomOpaqueId("sg_ver");
  let mediaCustody = null;
  if (privateMediaReady(env)) {
    try {
      const media = await uploadedMedia(mediaRequest, env, fileName);
      mediaCustody = await storePrivateMedia(env, {
        actorId,
        caseId,
        versionId,
        bytes: media.bytes,
        contentType: media.contentType,
        fileName: media.fileName,
        expectedSha256: analysis.media_sha256,
      });
    } catch {
      return jsonResponse(
        503,
        "media_custody_unavailable",
        "Private media could not be validated and stored.",
        origin,
        env,
      );
    }
  } else if (mediaCustodyRequired(env)) {
    return jsonResponse(
      503,
      "media_custody_unavailable",
      "Private media custody is temporarily unavailable.",
      origin,
      env,
    );
  }

  const stored = await callCaseStore(env, actorId, "/ingest", {
    method: "POST",
    payload: {
      analysis,
      case_id: requestedCaseId || null,
      new_case_id: requestedCaseId ? null : caseId,
      version_id: versionId,
      version_role: versionRole,
      title,
      file_name: fileName,
      media_custody: mediaCustody,
    },
  });
  let storedPayload;
  try {
    storedPayload = await stored.json();
  } catch {
    return jsonResponse(
      503,
      "case_store_unavailable",
      "Analysis could not be persisted.",
      origin,
      env,
    );
  }
  if (!stored.ok || !storedPayload.case) {
    if (mediaCustody) {
      await deletePrivateMedia(env, { actorId, caseId, versionId });
    }
    return jsonPayloadResponse(
      storedPayload,
      stored.status || 503,
      origin,
      env,
    );
  }
  const record = storedPayload.case;
  const version = record.versions?.at(-1);
  if (!version?.version_id || !record.case_id) {
    return jsonResponse(
      503,
      "case_store_unavailable",
      "Analysis could not be persisted.",
      origin,
      env,
    );
  }

  const extraHeaders = {};
  const demoHeader = response.headers.get("X-ShareGuard-Demo");
  if (demoHeader) {
    extraHeaders["X-ShareGuard-Demo"] = demoHeader;
  }
  return jsonPayloadResponse({
    ...analysis,
    case_id: record.case_id,
    version_id: version.version_id,
    case_status: record.status,
    chain_head: record.chain_head,
    case: record,
  }, 200, origin, env, extraHeaders);
}


export async function handleRequest(request, env, fetchImpl = fetch) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  const route = routeFor(requestUrl.pathname);

  if (!route) {
    return jsonResponse(404, "not_found", "Route not found.", origin, env);
  }

  if (origin && origin !== env.ALLOWED_ORIGIN) {
    return jsonResponse(403, "origin_forbidden", "Origin is not allowed.", null, env);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        ...corsHeaders(origin, env),
      },
    });
  }

  if (!route.methods.has(request.method)) {
    return jsonResponse(405, "method_not_allowed", "Method not allowed.", origin, env);
  }

  if (route.kind === "health") {
    return jsonPayloadResponse({
      status: "ok",
      gateway: "ready",
      case_store: env.CASE_STORE ? "ready" : "unavailable",
      private_media: privateMediaReady(env) ? "ready" : "unavailable",
      private_media_required: mediaCustodyRequired(env),
      inference: "check_v1_ready",
    }, 200, origin, env);
  }

  if (route.kind === "review") {
    return handleReviewRequest(request, env, origin);
  }

  try {
    if (!await edgeAuthorizationIsValid(request, env)) {
      return jsonResponse(
        401,
        "authentication_required",
        "Authentication is required for this protected service.",
        origin,
        env,
        { "WWW-Authenticate": 'Basic realm="ShareGuard"' },
      );
    }
    const actorId = await authenticatedActorId(request, env);
    if (route.kind === "trust_root") {
      return jsonPayloadResponse(publicTrustRoot(env), 200, origin, env);
    }
    if (route.kind === "media") {
      return await servePrivateMedia(request, env, actorId, origin);
    }
    if (route.kind === "review_grant") {
      return await manageReviewGrant(request, env, actorId, origin);
    }
    if (route.kind === "review_grant") {
      return jsonResponse(
        503,
        "review_access_unavailable",
        "Review access is temporarily unavailable.",
        origin,
        env,
      );
    }
    if (route.kind === "media") {
      return jsonResponse(
        503,
        "media_custody_unavailable",
        "Private media is temporarily unavailable.",
        origin,
        env,
      );
    }
    if (route.kind === "case_store") {
      if (requestUrl.pathname.endsWith("/seal")) {
        return await sealCase(request, env, actorId, origin);
      }
      if (request.method === "DELETE") {
        return await deleteCaseAndMedia(request, env, actorId, origin);
      }
      return await proxyCaseStore(request, env, actorId, origin);
    }

    const modalOrigin = parseModalOrigin(env.MODAL_ORIGIN);
    if (!modalOrigin) {
      return jsonResponse(
        503,
        "upstream_unavailable",
        "Inference service is temporarily unavailable.",
        origin,
        env,
      );
    }
    const clientId = await edgeClientId(request, env);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmacHex(
      env.EDGE_SHARED_SECRET,
      [timestamp, request.method, requestUrl.pathname, clientId].join("\n"),
    );
    let caseTitle = "";
    if (route.kind === "analyze") {
      try {
        caseTitle = decodeCaseTitle(request.headers);
      } catch {
        return jsonResponse(
          400,
          "invalid_case_title",
          "Case title encoding is invalid.",
          origin,
          env,
        );
      }
      const quota = await consumeDurableQuota(env, clientId);
      if (!quota.allowed) {
        return jsonResponse(
          429,
          "rate_limited",
          "Request quota exceeded. Please try again later.",
          origin,
          env,
          { "Retry-After": String(quota.retryAfter) },
        );
      }
    }

    const mediaRequest = route.kind === "analyze" ? request.clone() : null;
    const response = await fetchImpl(
      upstreamRequest(request, modalOrigin, { clientId, timestamp, signature }),
    );
    if (route.kind === "analyze") {
      return await persistAnalysis(
        request,
        mediaRequest,
        response,
        env,
        actorId,
        origin,
        caseTitle,
      );
    }
    return proxiedResponse(response, origin, env);
  } catch {
    if (requestUrl.pathname.endsWith("/seal")) {
      return jsonResponse(
        503,
        "signing_unavailable",
        "Evidence signing is temporarily unavailable.",
        origin,
        env,
      );
    }
    if (route.kind === "case_store") {
      return jsonResponse(
        503,
        "case_store_unavailable",
        "Case service is temporarily unavailable.",
        origin,
        env,
      );
    }
    return jsonResponse(
      503,
      "upstream_unavailable",
      "Inference service is temporarily unavailable.",
      origin,
      env,
    );
  }
}


export default {
  fetch(request, env) {
    return handleRequest(request, env, fetch);
  },
};
