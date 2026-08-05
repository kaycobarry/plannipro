import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
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
  const appUrl = Deno.env.get("APP_URL");
  if (!url || !publishableKey || !serviceRoleKey || !appUrl) {
    return json({ error: "Missing required Edge Function secrets" }, 500, request);
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
      || password.length < 8 || password.length > 128) {
    return json({ error: "Invalid company or administrator information" }, 400, request);
  }

  // Auth signup provides Supabase's e-mail confirmation and rate limiting. The
  // privileged client is used only afterwards to set immutable app_metadata;
  // neither its key nor the Auth tokens are ever returned to the browser.
  const signupClient = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signup, error: signupError } = await signupClient.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: appUrl,
      data: { full_name: `${firstName} ${lastName}` },
    },
  });
  if (signupError) return json({ error: signupError.message }, 400, request);

  // Supabase can deliberately return an obfuscated user for an existing e-mail.
  // An empty identities array must never be promoted to company creator.
  if (!signup.user || signup.user.identities?.length === 0) {
    return json({ error: "This email cannot be used to create a new company" }, 409, request);
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: metadataError } = await admin.auth.admin.updateUserById(signup.user.id, {
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
  if (metadataError) {
    // The account was created during this request and has no application data.
    // Best-effort cleanup prevents an unusable orphan Auth account.
    await admin.auth.admin.deleteUser(signup.user.id, false);
    return json({ error: "Unable to authorize company creation" }, 500, request);
  }

  return json({
    created: true,
    confirmation_required: !signup.session,
  }, 201, request);
});
