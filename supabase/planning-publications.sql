-- PlanniPro - publications hebdomadaires immuables, PDF privés et suivi e-mail.
-- Migration transactionnelle et idempotente. Aucune donnée métier existante n'est modifiée.
begin;

create extension if not exists pgcrypto;

alter table public.employee_self_service
  add column if not exists planning_notification_email text,
  add column if not exists planning_email_enabled boolean not null default true;

create table if not exists public.planning_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  week_start date not null,
  version integer not null check (version > 0),
  status text not null default 'publishing' check (status in (
    'draft','publishing','published','modified_after_publication','partially_sent','send_failed'
  )),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  options jsonb not null default '{}'::jsonb check (jsonb_typeof(options) = 'object'),
  idempotency_key text not null check (length(idempotency_key) between 16 and 160),
  global_pdf_path text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, establishment_id, week_start, version),
  unique (organization_id, idempotency_key)
);

create table if not exists public.planning_publication_recipients (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.planning_publications(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  email text,
  status text not null default 'pending' check (status in (
    'pending','sending','sent','failed','missing_email','invalid_email','disabled','skipped'
  )),
  individual_pdf_path text,
  provider_message_id text,
  error_code text,
  error_message text,
  attempts integer not null default 0 check (attempts >= 0),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (publication_id, employee_id)
);

create table if not exists public.planning_publication_events (
  id bigint generated always as identity primary key,
  publication_id uuid not null references public.planning_publications(id) on delete cascade,
  recipient_id uuid references public.planning_publication_recipients(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_user_id uuid references public.profiles(id) on delete set null,
  event_type text not null check (event_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists planning_publications_scope_idx
  on public.planning_publications (organization_id, establishment_id, week_start desc, version desc);
create index if not exists planning_publications_hash_idx
  on public.planning_publications (organization_id, establishment_id, week_start, content_hash);
create index if not exists planning_publications_establishment_idx
  on public.planning_publications (establishment_id);
create index if not exists planning_publications_created_by_idx
  on public.planning_publications (created_by);
create index if not exists planning_recipients_employee_idx
  on public.planning_publication_recipients (organization_id, employee_id, updated_at desc);
create index if not exists planning_recipients_establishment_idx
  on public.planning_publication_recipients (establishment_id);
create index if not exists planning_recipients_employee_fk_idx
  on public.planning_publication_recipients (employee_id);
create index if not exists planning_recipients_retry_idx
  on public.planning_publication_recipients (publication_id, status) where status in ('pending','failed');
create index if not exists planning_events_publication_idx
  on public.planning_publication_events (publication_id, created_at desc);
create index if not exists planning_events_recipient_idx
  on public.planning_publication_events (recipient_id, created_at desc) where recipient_id is not null;
create index if not exists planning_events_organization_idx
  on public.planning_publication_events (organization_id);
create index if not exists planning_events_actor_idx
  on public.planning_publication_events (actor_user_id);

create or replace function public.protect_planning_publication_snapshot()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.organization_id <> old.organization_id
    or new.establishment_id <> old.establishment_id
    or new.week_start <> old.week_start
    or new.version <> old.version
    or new.content_hash <> old.content_hash
    or new.snapshot <> old.snapshot
    or new.options <> old.options
    or new.idempotency_key <> old.idempotency_key
    or new.created_by <> old.created_by
    or new.created_at <> old.created_at
    or (old.global_pdf_path is not null and new.global_pdf_path is distinct from old.global_pdf_path) then
    raise exception 'A published planning snapshot is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists planning_publication_snapshot_immutable on public.planning_publications;
create trigger planning_publication_snapshot_immutable before update on public.planning_publications
for each row execute function public.protect_planning_publication_snapshot();

create or replace function public.can_publish_planning(
  p_organization_id uuid,
  p_establishment_id uuid
) returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.has_permission(p_organization_id, 'planning.publish')
    and exists (
      select 1
      from public.organization_members om
      where om.organization_id = p_organization_id
        and om.user_id = (select auth.uid())
        and om.status = 'active'
        and (
          public.is_owner(p_organization_id)
          or om.primary_establishment_id = p_establishment_id
          or public.member_in_scope(p_organization_id, p_establishment_id, null, null, null)
        )
    )
    and exists (
      select 1 from public.establishments e
      where e.id = p_establishment_id and e.organization_id = p_organization_id
    );
$$;

create or replace function public.can_read_planning_publication(p_publication_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.planning_publications p
    where p.id = p_publication_id
      and (
        public.can_publish_planning(p.organization_id, p.establishment_id)
        or exists (
          select 1 from public.planning_publication_recipients r
          where r.publication_id = p.id
            and r.employee_id = public.current_employee_id(p.organization_id)
        )
      )
  );
$$;

create or replace function public.preview_planning_publication_recipients(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_employee_ids uuid[] default null
) returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  if not public.can_publish_planning(p_organization_id, p_establishment_id) then
    raise exception 'Planning publication is not allowed' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'total', count(*),
    'ready', count(*) filter (where coalesce(ess.planning_email_enabled, true)
      and trim(coalesce(ess.planning_notification_email, ess.personal_email, '')) ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'),
    'missing_email', count(*) filter (where coalesce(ess.planning_email_enabled, true) and nullif(trim(coalesce(ess.planning_notification_email, ess.personal_email, '')), '') is null),
    'invalid_email', count(*) filter (where coalesce(ess.planning_email_enabled, true) and nullif(trim(coalesce(ess.planning_notification_email, ess.personal_email, '')), '') is not null
      and trim(coalesce(ess.planning_notification_email, ess.personal_email, '')) !~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$'),
    'disabled', count(*) filter (where coalesce(ess.planning_email_enabled, true) = false)
  ) into v_result
  from public.employees e
  left join public.employee_self_service ess on ess.employee_id = e.id
  where e.organization_id = p_organization_id and e.establishment_id = p_establishment_id
    and e.employment_status = 'active' and (p_employee_ids is null or e.id = any(p_employee_ids));
  return v_result;
end;
$$;

create or replace function public.create_planning_publication(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_week_start date,
  p_content_hash text,
  p_snapshot jsonb,
  p_options jsonb,
  p_idempotency_key text,
  p_recipient_ids uuid[] default null
) returns jsonb
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
declare
  v_publication public.planning_publications%rowtype;
  v_version integer;
  v_invalid integer;
begin
  if not public.can_publish_planning(p_organization_id, p_establishment_id) then
    raise exception 'Planning publication is not allowed' using errcode = '42501';
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception 'week_start must be a Monday';
  end if;
  if p_content_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'Invalid publication snapshot';
  end if;

  select * into v_publication
  from public.planning_publications
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;
  if found then
    if v_publication.establishment_id <> p_establishment_id
       or v_publication.week_start <> p_week_start
       or v_publication.content_hash <> p_content_hash then
      raise exception 'Idempotency key was already used for another publication';
    end if;
    return jsonb_build_object('id', v_publication.id, 'version', v_publication.version,
      'status', v_publication.status, 'reused', true);
  end if;

  select count(*) into v_invalid
  from jsonb_array_elements(coalesce(p_snapshot->'employees', '[]'::jsonb)) item
  where not exists (
    select 1 from public.employees e
    where e.id = nullif(item->>'employee_id','')::uuid
      and e.organization_id = p_organization_id
      and e.establishment_id = p_establishment_id
      and e.employment_status = 'active'
  );
  if v_invalid > 0 then raise exception 'Snapshot contains an employee outside the publication scope'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':' || p_establishment_id::text || ':' || p_week_start::text, 0));
  select * into v_publication
  from public.planning_publications
  where organization_id = p_organization_id and idempotency_key = p_idempotency_key;
  if found then
    if v_publication.establishment_id <> p_establishment_id
       or v_publication.week_start <> p_week_start
       or v_publication.content_hash <> p_content_hash then
      raise exception 'Idempotency key was already used for another publication';
    end if;
    return jsonb_build_object('id', v_publication.id, 'version', v_publication.version,
      'status', v_publication.status, 'reused', true);
  end if;
  select coalesce(max(version), 0) + 1 into v_version
  from public.planning_publications
  where organization_id = p_organization_id
    and establishment_id = p_establishment_id
    and week_start = p_week_start;

  insert into public.planning_publications (
    organization_id, establishment_id, week_start, version, status,
    content_hash, snapshot, options, idempotency_key, created_by
  ) values (
    p_organization_id, p_establishment_id, p_week_start, v_version, 'publishing',
    p_content_hash, p_snapshot, coalesce(p_options, '{}'::jsonb), p_idempotency_key, auth.uid()
  ) returning * into v_publication;

  insert into public.planning_publication_recipients (
    publication_id, organization_id, establishment_id, employee_id, email, status
  )
  select v_publication.id, p_organization_id, p_establishment_id, e.id,
    nullif(trim(coalesce(ess.planning_notification_email, ess.personal_email, '')), ''),
    case
      when coalesce(ess.planning_email_enabled, true) = false then 'disabled'
      when nullif(trim(coalesce(ess.planning_notification_email, ess.personal_email, '')), '') is null then 'missing_email'
      when trim(coalesce(ess.planning_notification_email, ess.personal_email, '')) !~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$' then 'invalid_email'
      else 'pending'
    end
  from public.employees e
  left join public.employee_self_service ess on ess.employee_id = e.id
  where e.organization_id = p_organization_id
    and e.establishment_id = p_establishment_id
    and e.employment_status = 'active'
    and exists (
      select 1 from jsonb_array_elements(coalesce(p_snapshot->'employees', '[]'::jsonb)) item
      where item->>'employee_id' = e.id::text
    )
    and (p_recipient_ids is null or e.id = any(p_recipient_ids));

  insert into public.planning_publication_events (
    publication_id, organization_id, actor_user_id, event_type, details
  ) values (
    v_publication.id, p_organization_id, auth.uid(), 'publication.created',
    jsonb_build_object('version', v_version, 'week_start', p_week_start, 'content_hash', p_content_hash)
  );

  insert into public.audit_logs (
    organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata
  ) values (
    p_organization_id, p_establishment_id, auth.uid(), 'planning.publish',
    'planning_publication', v_publication.id::text,
    jsonb_build_object('week_start', p_week_start, 'version', v_version, 'content_hash', p_content_hash)
  );

  return jsonb_build_object('id', v_publication.id, 'version', v_version,
    'status', v_publication.status, 'reused', false);
end;
$$;

create or replace function public.can_read_planning_publication_object(p_path text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.planning_publications p
    where p.global_pdf_path = p_path and public.can_publish_planning(p.organization_id, p.establishment_id)
  ) or exists (
    select 1 from public.planning_publication_recipients r
    where r.individual_pdf_path = p_path
      and (
        public.can_publish_planning(r.organization_id, r.establishment_id)
        or r.employee_id = public.current_employee_id(r.organization_id)
      )
  );
$$;

alter table public.planning_publications enable row level security;
alter table public.planning_publication_recipients enable row level security;
alter table public.planning_publication_events enable row level security;

drop policy if exists planning_publications_select on public.planning_publications;
create policy planning_publications_select on public.planning_publications for select to authenticated
using (public.can_read_planning_publication(id));

drop policy if exists planning_recipients_select on public.planning_publication_recipients;
create policy planning_recipients_select on public.planning_publication_recipients for select to authenticated
using (
  public.can_publish_planning(organization_id, establishment_id)
  or employee_id = public.current_employee_id(organization_id)
);

drop policy if exists planning_events_select on public.planning_publication_events;
create policy planning_events_select on public.planning_publication_events for select to authenticated
using (
  public.can_read_planning_publication(publication_id)
  and (
    recipient_id is null
    or exists (
      select 1 from public.planning_publication_recipients r
      where r.id = recipient_id
        and (public.can_publish_planning(r.organization_id, r.establishment_id)
          or r.employee_id = public.current_employee_id(r.organization_id))
    )
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('planning-publications', 'planning-publications', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists planning_publications_storage_select on storage.objects;
create policy planning_publications_storage_select on storage.objects for select to authenticated
using (bucket_id = 'planning-publications' and public.can_read_planning_publication_object(name));
-- Aucune politique INSERT/UPDATE/DELETE navigateur : seule l'Edge Function de publication écrit les PDF.

revoke all on public.planning_publications, public.planning_publication_recipients,
  public.planning_publication_events from public, anon;
revoke insert, update, delete on public.planning_publications, public.planning_publication_recipients,
  public.planning_publication_events from authenticated;
grant select on public.planning_publications, public.planning_publication_recipients,
  public.planning_publication_events to authenticated;
revoke all on function public.can_publish_planning(uuid, uuid),
  public.can_read_planning_publication(uuid),
  public.preview_planning_publication_recipients(uuid, uuid, uuid[]),
  public.create_planning_publication(uuid, uuid, date, text, jsonb, jsonb, text, uuid[]),
  public.can_read_planning_publication_object(text) from public, anon;
grant execute on function public.can_publish_planning(uuid, uuid),
  public.can_read_planning_publication(uuid),
  public.preview_planning_publication_recipients(uuid, uuid, uuid[]),
  public.create_planning_publication(uuid, uuid, date, text, jsonb, jsonb, text, uuid[]),
  public.can_read_planning_publication_object(text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'planning_publications'
  ) then
    alter publication supabase_realtime add table public.planning_publications;
  end if;
end $$;

comment on table public.planning_publications is 'Instantanés immuables des versions publiées du planning hebdomadaire.';
comment on table public.planning_publication_recipients is 'Suivi réel et idempotent des PDF/e-mails individuels.';
comment on table public.planning_publication_events is 'Journal append-only des opérations de publication et de livraison.';

commit;
