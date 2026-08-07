import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.2";
import { corsHeaders, json } from "../_shared/cors.ts";

type SessionRequest = {
  member_id: string;
  status: "suspended" | "disabled" | "active";
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401, request);

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishableKey || !serviceRoleKey) return json({ error: "Missing required Edge Function secrets" }, 500, request);

  let payload: SessionRequest;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, request);
  }
  if (!payload.member_id || !["suspended", "disabled", "active"].includes(payload.status)) {
    return json({ error: "member_id and a valid status are required" }, 400, request);
  }

  // RLS on organization_members proves that the caller may manage this exact
  // account. The server-only admin client then bans/unbans the Auth account.
  // RLS remains the immediate enforcement point: an already-issued JWT cannot
  // read or modify data after the membership status changes.
  const userClient = createClient(url, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: caller, error: callerError } = await userClient.auth.getUser();
  if (callerError || !caller.user) return json({ error: "Invalid or expired session" }, 401, request);

  const change: Record<string, string | null> = {
    status: payload.status,
    suspended_at: payload.status === "active" ? null : new Date().toISOString(),
  };
  const { data: member, error: memberError } = await userClient
    .from("organization_members")
    .update(change)
    .eq("id", payload.member_id)
    .select("id, user_id, organization_id, status")
    .single();

  if (memberError || !member) return json({ error: memberError?.message ?? "Not authorized" }, 403, request);

  const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: accessError } = await admin.auth.admin.updateUserById(member.user_id, {
    ban_duration: payload.status === "active" ? "none" : "876000h",
  });
  if (accessError) return json({ error: accessError.message }, 502, request);

  return json({ member }, 200, request);
});
