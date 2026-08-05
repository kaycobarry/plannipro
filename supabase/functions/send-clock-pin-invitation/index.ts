import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

type RequestBody = { organization_id?: string; employee_id?: string };

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401, request);

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const appUrl = Deno.env.get("APP_URL");
  if (!url || !publishableKey || !appUrl) return json({ error: "Missing required function configuration" }, 500, request);

  let body: RequestBody;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400, request); }
  if (!body.organization_id || !body.employee_id) return json({ error: "organization_id and employee_id are required" }, 400, request);

  const userClient = createClient(url, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401, request);

  // The caller-scoped client invokes the SECURITY DEFINER RPC. The RPC checks
  // RBAC, tenant and establishment scope before returning the one-time token.
  const { data, error } = await userClient.rpc("create_employee_time_clock_pin_invitation", {
    p_organization_id: body.organization_id,
    p_employee_id: body.employee_id,
  });
  if (error || !data?.token) return json({ error: error?.message ?? "Unable to create invitation" }, 403, request);

  const link = new URL("pointeuse.html", appUrl.endsWith("/") ? appUrl : `${appUrl}/`);
  link.searchParams.set("clock-pin", data.token);
  const email = typeof data.employee_email === "string" ? data.employee_email.trim() : "";
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const resendFrom = Deno.env.get("RESEND_FROM");

  if (!email || !resendKey || !resendFrom) {
    return json({
      invitation_id: data.invitation_id,
      expires_at: data.expires_at,
      emailed: false,
      accept_url: link.href,
      warning: !email ? "Employee has no e-mail address" : "E-mail provider is not configured",
    }, 200, request);
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: resendFrom,
      to: [email],
      subject: "Votre code personnel de pointage PlanniPro",
      html: `<p>Bonjour,</p><p>Un code personnel de pointage a été créé pour vous.</p><p><a href="${link.href}">Consulter ou définir mon code</a></p><p>Ce lien est personnel, utilisable une seule fois et expirera dans 24 heures.</p><p>Ne communiquez jamais votre code à un autre collaborateur.</p>`,
    }),
  });
  if (!response.ok) {
    return json({ invitation_id: data.invitation_id, expires_at: data.expires_at, emailed: false, accept_url: link.href, warning: "E-mail delivery failed" }, 200, request);
  }
  return json({ invitation_id: data.invitation_id, expires_at: data.expires_at, emailed: true }, 200, request);
});
