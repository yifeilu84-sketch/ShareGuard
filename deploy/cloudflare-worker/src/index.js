import { ShareGuardCaseStore } from "./case-store.js";

export { ShareGuardCaseStore };


const STATIC_ROUTES = new Map([
  ["/v1/health", { kind: "health", methods: new Set(["GET"]) }],
  ["/v1/ready", { kind: "ready", methods: new Set(["GET"]) }],
  ["/v1/analyze", { kind: "analyze", methods: new Set(["POST"]) }],
  ["/v1/cases", { kind: "case_store", methods: new Set(["GET"]) }],
  ["/v1/metrics", { kind: "case_store", methods: new Set(["GET"]) }],
]);
const CASE_ROUTE = /^\/v1\/cases\/(sg_case_[0-9a-f]{32})(?:\/(decision|annotations|provenance|feedback))?$/;

const EDGE_CLIENT_ID_HEADER = "X-ShareGuard-Client-Id";
const LEGACY_EDGE_SECRET_HEADER = "X-ShareGuard-Edge-Secret";
const EDGE_TIMESTAMP_HEADER = "X-ShareGuard-Edge-Timestamp";
const EDGE_SIGNATURE_HEADER = "X-ShareGuard-Edge-Signature";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;


function corsHeaders(origin, env) {
  if (!origin || origin !== env.ALLOWED_ORIGIN) {
    return {};
  }

  return {
    "Access-Control-Allow-Headers": (
      "Authorization, Content-Type, X-File-Name, X-ShareGuard-Case-Id, " +
      "X-ShareGuard-Version-Role, X-ShareGuard-Case-Title"
    ),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
  const match = pathname.match(CASE_ROUTE);
  if (!match) {
    return null;
  }
  return {
    kind: "case_store",
    methods: new Set([match[2] ? "POST" : "GET", ...(match[2] ? [] : ["DELETE"])]),
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


function caseStoreStub(env, actorId) {
  if (!env.CASE_STORE) {
    throw new Error("case store unavailable");
  }
  const objectId = env.CASE_STORE.idFromName(actorId);
  return env.CASE_STORE.get(objectId);
}


async function callCaseStore(
  env,
  actorId,
  path,
  { method = "GET", payload = null } = {},
) {
  const init = { method };
  if (payload !== null) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({ ...payload, actor_id: actorId });
  }
  return caseStoreStub(env, actorId).fetch(
    `https://shareguard-case-store.internal${path}`,
    init,
  );
}


async function proxyCaseStore(request, env, actorId, origin) {
  const requestUrl = new URL(request.url);
  const internalPath = requestUrl.pathname.replace(/^\/v1/, "") || "/";
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
      normalized === EDGE_SIGNATURE_HEADER.toLowerCase()
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


async function persistAnalysis(request, response, env, actorId, origin) {
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
    request.headers.get("X-ShareGuard-Case-Id") || "",
  ).trim().toLowerCase();
  const requestedRole = String(
    request.headers.get("X-ShareGuard-Version-Role") || "",
  ).trim().toLowerCase();
  const versionRole = requestedRole || (
    requestedCaseId ? "observed_variant" : "original"
  );
  const title = String(
    request.headers.get("X-ShareGuard-Case-Title") || "",
  ).trim();
  const fileName = String(
    request.headers.get("X-File-Name") ||
    analysis.report?.subject?.file_name ||
    "upload",
  ).trim();

  const stored = await callCaseStore(env, actorId, "/ingest", {
    method: "POST",
    payload: {
      analysis,
      case_id: requestedCaseId || null,
      version_role: versionRole,
      title,
      file_name: fileName,
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
      inference: "check_v1_ready",
    }, 200, origin, env);
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
    if (route.kind === "case_store") {
      return proxyCaseStore(request, env, actorId, origin);
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
    if (route.kind === "analyze") {
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

    const response = await fetchImpl(
      upstreamRequest(request, modalOrigin, { clientId, timestamp, signature }),
    );
    if (route.kind === "analyze") {
      return persistAnalysis(request, response, env, actorId, origin);
    }
    return proxiedResponse(response, origin, env);
  } catch {
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
