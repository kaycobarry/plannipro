function allowedOrigins() {
  // Origins have no path. Keep APP_URL separate: it is used only for e-mail
  // links. APP_ORIGIN is supported for an existing installation, while the
  // comma-separated APP_ORIGINS allows the protected local test origin too.
  const raw = Deno.env.get("APP_ORIGINS")
    ?? Deno.env.get("APP_ORIGIN")
    ?? "https://kaycobarry.github.io";
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

export function corsHeaders(request?: Request) {
  const origins = allowedOrigins();
  const requestOrigin = request?.headers.get("Origin") ?? "";
  // Returning the first configured origin for a non-browser request keeps
  // dashboard/API diagnostics usable. A browser whose Origin is not listed
  // still rejects the response because it does not receive its own origin.
  const origin = origins.includes(requestOrigin) ? requestOrigin : origins[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status = 200, request?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(request), "Content-Type": "application/json; charset=utf-8" },
  });
}
