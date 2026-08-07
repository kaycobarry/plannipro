import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.2";
import { corsHeaders, json } from "../_shared/cors.ts";

type CreateCompanyRequest = {
  organization_name?: string;
  establishment_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  password?: string;
};

const clean = (value: unknown) => String(value ?? "").trim();

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishableKey || !serviceRoleKey) {
    return json({ error: "Missing required Edge Function secrets" }, 500, request);
  }

  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ error: "Authentication required" }, 401, request);
  }

  let payload: CreateCompanyRequest;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }

  const organizationName = clean(payload.organization_name);
  const establishmentName = clean(payload.establishment_name);
  const firstName = clean(payload.first_name);
  const lastName = clean(payload.last_name);
  const email = clean(payload.email).toLowerCase();
  const password = String(payload.password ?? "");

  if (organizationName.length < 2 || organizationName.length > 120
      || establishmentName.length < 2 || establishmentName.length > 120
      || firstName.length < 1 || firstName.length > 80
      || lastName.length < 1 || lastName.length > 80
      || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || password.length < 10 || password.length > 128) {
    return json({ error: "Invalid company or administrator information" }, 400, request);
  }

  // The platform validates the JWT before the handler runs. The scoped client
  // then performs the independent platform-administrator authorization check.
  const callerClient = createClient(url, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const token = authorization.slice("Bearer ".length).trim();
  const { data: caller, error: callerError } = await callerClient.auth.getUser(token);
  if (callerError || !caller.user) return json({ error: "Authentication required" }, 401, request);

  const { data: platformAdministrator, error: authorizationError } =
    await callerClient.rpc("is_platform_administrator");
  if (authorizationError || platformAdministrator !== true) {
    return json({ error: "Only the PlanniPro platform administrator can create a company" }, 403, request);
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Auth users are created through the server administration API, so disabling
  // public Supabase signups does not block this controlled provisioning flow.
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `${firstName} ${lastName}` },
    app_metadata: {
      plannipro_company_creator: true,
      plannipro_company_setup: {
        organization_name: organizationName,
        establishment_name: establishmentName,
        first_name: firstName,
        last_name: lastName,
      },
    },
  });
  if (createError || !created.user) {
    const status = /already|registered|exists/i.test(createError?.message ?? "") ? 409 : 400;
    return json({ error: status === 409
      ? "This email cannot be used to create a new company"
      : "Unable to create the company administrator" }, status, request);
  }

  return json({
    created: true,
    confirmation_required: false,
  }, 201, request);
});
