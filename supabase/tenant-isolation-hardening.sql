begin;

-- Kiosk operations and device administration go exclusively through the
-- credential-checking SECURITY DEFINER RPCs. Direct Data API access is not
-- needed and would add a second, unnecessary authorization surface.
revoke all on table public.time_clock_devices
  from public, anon, authenticated;
revoke all on table public.employee_time_clock_credentials
  from public, anon, authenticated;
revoke all on table public.time_clock_events
  from public, anon, authenticated;
grant select on table public.time_clock_events to authenticated;

-- This view already runs as the caller so the RLS policies of documents,
-- categories and employees remain effective. Remove platform-default grants
-- and expose only the read privilege required by the authenticated vault UI.
alter view public.hr_document_alerts set (security_invoker = true);
revoke all on table public.hr_document_alerts
  from public, anon, authenticated;
grant select on table public.hr_document_alerts to authenticated;

commit;
