const ROUTES = new Map([
  ["/v1/ready", "GET"],
  ["/v1/analyze", "POST"],
]);


function corsHeaders(origin, env) {
  if (!origin || origin !== env.ALLOWED_ORIGIN) {
    return {};
  }

  return {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}


function jsonResponse(status, code, message, origin, env) {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders(origin, env),
      },
    },
  );
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


function upstreamRequest(request, modalOrigin) {
  const requestUrl = new URL(request.url);
  const targetUrl = new URL(requestUrl.pathname + requestUrl.search, modalOrigin);
  const forwarded = new Request(targetUrl.toString(), request);

  for (const key of [...forwarded.headers.keys()]) {
    if (key.toLowerCase().startsWith("cf-access-")) {
      forwarded.headers.delete(key);
    }
  }

  return forwarded;
}


export async function handleRequest(request, env, fetchImpl = fetch) {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get("Origin");
  const requiredMethod = ROUTES.get(requestUrl.pathname);

  if (!requiredMethod) {
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

  if (request.method !== requiredMethod) {
    return jsonResponse(405, "method_not_allowed", "Method not allowed.", origin, env);
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

  try {
    const response = await fetchImpl(upstreamRequest(request, modalOrigin));
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
  } catch {
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
