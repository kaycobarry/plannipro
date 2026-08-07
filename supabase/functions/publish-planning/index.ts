import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { buildEmployeePlanningPdf, buildGlobalPlanningPdf, type PlanningSnapshot } from "../_shared/planning-pdf.ts";

type Body = {
  action?: "publish" | "retry";
  organization_id?: string;
  establishment_id?: string;
  week_start?: string;
  content_hash?: string;
  snapshot?: PlanningSnapshot;
  options?: Record<string, unknown>;
  idempotency_key?: string;
  recipient_ids?: string[];
  publication_id?: string;
};

const BUCKET = "planning-publications";
const EMAIL_PATTERN = /^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$/i;

function base64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

function safeSegment(value: unknown) {
  return String(value ?? "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 100);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(request) });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, request);
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401, request);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendKey = Deno.env.get("RESEND_API_KEY");
  const resendFrom = Deno.env.get("PLANNING_EMAIL_FROM") ?? Deno.env.get("RESEND_FROM");
  const resendReplyTo = Deno.env.get("PLANNING_EMAIL_REPLY_TO");
  if (!supabaseUrl || !publishableKey || !serviceKey) return json({ error: "Function configuration is incomplete" }, 500, request);

  let body: Body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400, request); }

  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData.user) return json({ error: "Invalid or expired session" }, 401, request);

  let publicationId = body.publication_id;
  let reused = false;
  if ((body.action ?? "publish") === "publish") {
    if (!body.organization_id || !body.establishment_id || !body.week_start || !body.content_hash
      || !body.snapshot || !body.idempotency_key) {
      return json({ error: "Missing publication fields" }, 400, request);
    }
    const { data, error } = await userClient.rpc("create_planning_publication", {
      p_organization_id: body.organization_id,
      p_establishment_id: body.establishment_id,
      p_week_start: body.week_start,
      p_content_hash: body.content_hash,
      p_snapshot: body.snapshot,
      p_options: body.options ?? {},
      p_idempotency_key: body.idempotency_key,
      p_recipient_ids: body.recipient_ids?.length ? body.recipient_ids : null,
    });
    if (error || !data?.id) return json({ error: error?.message ?? "Publication refused" }, 403, request);
    publicationId = data.id;
    reused = Boolean(data.reused);
  }
  if (!publicationId) return json({ error: "publication_id is required" }, 400, request);

  // Reading through the caller client is an intentional second RLS/RBAC check,
  // including for retries. The privileged client is used only after this check.
  const allowed = await userClient.from("planning_publications").select("id").eq("id", publicationId).maybeSingle();
  if (allowed.error || !allowed.data) return json({ error: "Publication access denied" }, 403, request);

  const publicationResult = await service.from("planning_publications").select("*").eq("id", publicationId).single();
  if (publicationResult.error || !publicationResult.data) return json({ error: "Publication not found" }, 404, request);
  const publication = publicationResult.data;
  const snapshot = {
    ...(publication.snapshot as PlanningSnapshot),
    publication_version: publication.version,
    publication_date: new Date().toISOString().slice(0, 10),
  };
  const logEvent = async (eventType: string, details: Record<string, unknown> = {}, recipientId?: string) => {
    await service.from("planning_publication_events").insert({
      publication_id: publication.id, recipient_id: recipientId ?? null,
      organization_id: publication.organization_id, actor_user_id: userData.user.id,
      event_type: eventType, details,
    });
  };
  if ((body.action ?? "publish") === "retry") await logEvent("publication.retry_started");
  if (reused && ["published", "partially_sent", "send_failed"].includes(publication.status)) {
    return json({ publication_id: publication.id, status: publication.status, reused: true }, 200, request);
  }

  const prefix = `${publication.organization_id}/${publication.establishment_id}/${publication.week_start}/v${publication.version}`;
  const globalPath = `${prefix}/global.pdf`;
  const globalPdf = buildGlobalPlanningPdf(snapshot);
  const globalUpload = await service.storage.from(BUCKET).upload(globalPath, globalPdf, {
    contentType: "application/pdf", upsert: false, cacheControl: "private, max-age=0",
  });
  if (globalUpload.error && !/already exists|duplicate/i.test(globalUpload.error.message)) {
    await service.from("planning_publication_events").insert({
      publication_id: publication.id, organization_id: publication.organization_id,
      actor_user_id: userData.user.id, event_type: "pdf.global_failed", details: { message: globalUpload.error.message },
    });
    return json({ error: "Global PDF storage failed" }, 502, request);
  }
  await service.from("planning_publications").update({ global_pdf_path: globalPath, updated_at: new Date().toISOString() }).eq("id", publication.id);
  await logEvent("pdf.global_stored", { storage_path: globalPath, bytes: globalPdf.byteLength });

  const recipientsResult = await service.from("planning_publication_recipients").select("*")
    .eq("publication_id", publication.id).in("status", ["pending", "failed", "sending"]);
  if (recipientsResult.error) return json({ error: "Recipients cannot be loaded" }, 500, request);

  let sent = 0, failed = 0;
  for (const recipient of recipientsResult.data ?? []) {
    const email = String(recipient.email ?? "").trim();
    if (!EMAIL_PATTERN.test(email)) {
      await service.from("planning_publication_recipients").update({
        status: email ? "invalid_email" : "missing_email", updated_at: new Date().toISOString(),
      }).eq("id", recipient.id);
      continue;
    }
    const employee = snapshot.employees.find((item) => item.employee_id === recipient.employee_id);
    if (!employee) {
      failed++;
      await service.from("planning_publication_recipients").update({
        status: "failed", error_code: "snapshot_employee_missing", error_message: "Employee is missing from the immutable snapshot",
        attempts: recipient.attempts + 1, updated_at: new Date().toISOString(),
      }).eq("id", recipient.id);
      continue;
    }
    const pdf = buildEmployeePlanningPdf(snapshot, employee);
    const employeePath = `${prefix}/employees/${recipient.employee_id}.pdf`;
    const upload = await service.storage.from(BUCKET).upload(employeePath, pdf, {
      contentType: "application/pdf", upsert: false, cacheControl: "private, max-age=0",
    });
    if (upload.error && !/already exists|duplicate/i.test(upload.error.message)) {
      failed++;
      await service.from("planning_publication_recipients").update({
        status: "failed", error_code: "pdf_storage_failed", error_message: upload.error.message,
        attempts: recipient.attempts + 1, updated_at: new Date().toISOString(),
      }).eq("id", recipient.id);
      await logEvent("pdf.individual_failed", { message: upload.error.message }, recipient.id);
      continue;
    }
    await logEvent("pdf.individual_stored", { storage_path: employeePath, bytes: pdf.byteLength }, recipient.id);
    await service.from("planning_publication_recipients").update({
      status: "sending", individual_pdf_path: employeePath, attempts: recipient.attempts + 1,
      error_code: null, error_message: null, updated_at: new Date().toISOString(),
    }).eq("id", recipient.id);

    if (!resendKey || !resendFrom) {
      failed++;
      await service.from("planning_publication_recipients").update({
        status: "failed", error_code: "email_provider_unconfigured",
        error_message: "Resend is not configured; no e-mail was sent", updated_at: new Date().toISOString(),
      }).eq("id", recipient.id);
      await logEvent("email.failed", { code: "email_provider_unconfigured" }, recipient.id);
      continue;
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json", "Idempotency-Key": `${publication.id}:${recipient.id}` },
      body: JSON.stringify({
        from: resendFrom, to: [email],
        subject: publication.version > 1
          ? `Mise à jour de votre planning PlanniPro - semaine du ${publication.week_start}`
          : `Votre planning PlanniPro - semaine du ${publication.week_start}`,
        reply_to: resendReplyTo || undefined,
        html: `<p>Bonjour ${safeSegment(employee.name)},</p><p>Votre planning pour la semaine du <strong>${publication.week_start}</strong> est joint à cet e-mail.</p>${publication.version > 1 ? `<p><strong>Version ${publication.version} :</strong> ce planning modifié remplace la version précédente.</p>` : ''}<p>Document individuel confidentiel.</p>`,
        attachments: [{ filename: `planning-${safeSegment(employee.name)}-${publication.week_start}.pdf`, content: base64(pdf) }],
      }),
    });
    let provider: { id?: string; message?: string } = {};
    try { provider = await response.json(); } catch { /* The status remains authoritative. */ }
    if (!response.ok || !provider.id) {
      failed++;
      await service.from("planning_publication_recipients").update({
        status: "failed", error_code: `resend_${response.status}`,
        error_message: provider.message ?? "E-mail provider rejected the request", updated_at: new Date().toISOString(),
      }).eq("id", recipient.id);
      await logEvent("email.failed", { code: `resend_${response.status}`, message: provider.message ?? "Provider rejected request" }, recipient.id);
      continue;
    }
    sent++;
    await service.from("planning_publication_recipients").update({
      status: "sent", provider_message_id: provider.id, sent_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq("id", recipient.id);
    await service.from("planning_publication_events").insert({
      publication_id: publication.id, recipient_id: recipient.id, organization_id: publication.organization_id,
      actor_user_id: userData.user.id, event_type: "email.accepted", details: { provider: "resend", provider_message_id: provider.id },
    });
  }

  const allRecipients = await service.from("planning_publication_recipients").select("status").eq("publication_id", publication.id);
  const statuses = (allRecipients.data ?? []).map((row) => row.status);
  const successCount = statuses.filter((status) => status === "sent").length;
  const failureCount = statuses.filter((status) => status === "failed").length;
  const problemCount = statuses.filter((status) => status !== "sent").length;
  const finalStatus = problemCount === 0 ? "published" : successCount > 0 ? "partially_sent" : "send_failed";
  await service.from("planning_publications").update({
    status: finalStatus, published_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", publication.id);
  await service.from("planning_publication_events").insert({
    publication_id: publication.id, organization_id: publication.organization_id,
    actor_user_id: userData.user.id, event_type: "publication.completed",
    details: { status: finalStatus, sent: successCount, failed: failureCount, skipped: statuses.length - successCount - failureCount },
  });

  return json({ publication_id: publication.id, status: finalStatus, sent, failed, reused }, 200, request);
});
