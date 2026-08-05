import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";

type InviteRequest = {
  organization_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  role_id?: string;
  primary_establishment_id?: string | null;
  employee_id?: string | null;
  scopes?: Array<Record<string, unknown>>;
  permission_overrides?: Array<{ permission_key: string; effect: "grant" | "revoke" }>;
  expires_at?: string;
  resend_invitation_id?: string;
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401, request);

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const appUrl = Deno.env.get("APP_URL");
  if (!url || !publishableKey || !serviceRoleKey || !appUrl) {
    return json({ error: "Missing required Edge Function secrets" }, 500, request);
  }

  let payload: InviteRequest;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }

  // This client carries the caller's JWT. PostgreSQL RLS and create_invitation()
  // therefore check the caller's effective role and prevent privilege escalation.
  const userClient = createClient(url, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401, request);

  let invitationInput: {
    organization_id: string;
    email: string;
    first_name: string;
    last_name: string;
    role_id: string;
    primary_establishment_id: string | null;
    employee_id: string | null;
    scopes: Array<Record<string, unknown>>;
    permission_overrides: Array<{ permission_key: string; effect: "grant" | "revoke" }>;
    expires_at?: string;
  };

  if (payload.resend_invitation_id) {
    // The client only supplies an opaque invitation id. Its role, scope and
    // e-mail are re-read under RLS instead of trusting editable browser data.
    const { data: previous, error: previousError } = await userClient
      .from("invitations")
      .select("organization_id,email,first_name,last_name,role_id,primary_establishment_id,employee_id,scopes,permission_overrides,status")
      .eq("id", payload.resend_invitation_id)
      .maybeSingle();
    if (previousError || !previous || previous.status === "accepted" || previous.status === "cancelled") {
      return json({ error: "Invitation unavailable or not authorized" }, 403, request);
    }
    invitationInput = {
      organization_id: previous.organization_id,
      email: previous.email,
      first_name: previous.first_name ?? "",
      last_name: previous.last_name ?? "",
      role_id: previous.role_id,
      primary_establishment_id: previous.primary_establishment_id,
      employee_id: previous.employee_id,
      scopes: Array.isArray(previous.scopes) ? previous.scopes : [],
      permission_overrides: Array.isArray(previous.permission_overrides) ? previous.permission_overrides : [],
      expires_at: payload.expires_at ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  } else {
    if (!payload.organization_id || !payload.email || !payload.first_name || !payload.last_name || !payload.role_id) {
      return json({ error: "organization_id, first_name, last_name, email and role_id are required" }, 400, request);
    }
    invitationInput = {
      organization_id: payload.organization_id,
      email: payload.email.trim().toLowerCase(),
      first_name: payload.first_name.trim(),
      last_name: payload.last_name.trim(),
      role_id: payload.role_id,
      primary_establishment_id: payload.primary_establishment_id ?? null,
      employee_id: payload.employee_id ?? null,
      scopes: payload.scopes ?? [],
      permission_overrides: payload.permission_overrides ?? [],
      expires_at: payload.expires_at,
    };
  }

  const invitationArgs = {
    p_organization_id: invitationInput.organization_id,
    p_email: invitationInput.email,
    p_role_id: invitationInput.role_id,
    p_primary_establishment_id: invitationInput.primary_establishment_id,
    p_employee_id: invitationInput.employee_id,
    p_scopes: invitationInput.scopes,
    p_permission_overrides: invitationInput.permission_overrides,
    p_expires_at: invitationInput.expires_at ?? undefined,
  };
  // Pending invitations created before company-administration.sql have no
  // identity columns. They remain resendable through the original secured RPC;
  // every newly created invitation uses the identity-aware RPC.
  const invitationRequest = invitationInput.first_name && invitationInput.last_name
    ? userClient.rpc("create_company_invitation", {
        ...invitationArgs,
        p_first_name: invitationInput.first_name,
        p_last_name: invitationInput.last_name,
      })
    : userClient.rpc("create_invitation", invitationArgs);
  const { data: invitation, error: invitationError } = await invitationRequest;
  if (invitationError || !invitation) {
    return json({ error: invitationError?.message ?? "Unable to create invitation" }, 403, request);
  }

  const token = invitation.token as string;
  const acceptUrl = `${appUrl.replace(/\/$/, "")}/?invite=${encodeURIComponent(token)}`;
  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Supabase sends the account invitation. If the recipient already has an
  // account, the manager can securely copy the same one-time PlanniPro link.
  const { error: emailError } = await admin.auth.admin.inviteUserByEmail(invitationInput.email, {
    redirectTo: acceptUrl,
    data: {
      plannipro_invitation_id: invitation.invitation_id,
      first_name: invitationInput.first_name,
      last_name: invitationInput.last_name,
      full_name: `${invitationInput.first_name} ${invitationInput.last_name}`.trim(),
    },
  });

  return json({
    invitation_id: invitation.invitation_id,
    expires_at: invitation.expires_at,
    emailed: !emailError,
    accept_url: emailError ? acceptUrl : undefined,
    warning: emailError ? "The account may already exist. Ask the recipient to sign in, then use the secure link." : undefined,
  }, 200, request);
});
