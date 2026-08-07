-- PlanniPro · extension Pointeuse tablette (à exécuter APRÈS schema.sql)
--
-- Cette migration ajoute une pointeuse indépendante, sans jamais exposer de
-- clé service_role dans le navigateur. Les badges sont reçus par une RPC
-- restreinte : secret d'appareil + code salarié ou preuve hors ligne.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Types et tables : appareil, code salarié et événements bruts immuables.
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.time_clock_device_status as enum ('active', 'suspended', 'revoked');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.time_clock_event_type as enum ('clock_in', 'break_start', 'break_end', 'clock_out');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.time_clock_verification_mode as enum ('online_pin', 'offline_proof');
exception when duplicate_object then null;
end $$;

create table if not exists public.time_clock_devices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 80),
  -- Empreinte SHA-256 d'un secret aléatoire de 256 bits conservé uniquement
  -- dans IndexedDB de la tablette. Le secret brut n'est jamais envoyé à une table.
  device_secret_hash text not null check (device_secret_hash ~ '^[a-f0-9]{64}$'),
  timezone text not null default 'Europe/Paris' check (char_length(timezone) between 1 and 64),
  status public.time_clock_device_status not null default 'active',
  failed_attempts smallint not null default 0 check (failed_attempts between 0 and 20),
  locked_until timestamptz,
  last_seen_at timestamptz,
  cache_version integer not null default 1 check (cache_version > 0),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, establishment_id, name)
);

create table if not exists public.employee_time_clock_credentials (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Code de six chiffres protégé côté serveur avec bcrypt/pgcrypto.
  pin_hash text not null,
  -- Le vérificateur PBKDF2 permet une validation temporaire hors connexion.
  -- Ce n'est ni le code, ni son hash bcrypt et il n'est jamais renvoyé par
  -- les écrans RH ; seulement à une tablette déjà enregistrée.
  offline_salt text not null check (char_length(offline_salt) between 20 and 160),
  offline_hash text not null check (char_length(offline_hash) between 40 and 180),
  offline_iterations integer not null default 310000 check (offline_iterations between 200000 and 500000),
  previous_offline_salt text,
  previous_offline_hash text,
  previous_offline_iterations integer,
  previous_offline_valid_until timestamptz,
  credential_version integer not null default 1 check (credential_version > 0),
  active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.time_clock_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  device_id uuid not null references public.time_clock_devices(id) on delete restrict,
  event_type public.time_clock_event_type not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  client_event_id uuid not null,
  verification_mode public.time_clock_verification_mode not null,
  metadata jsonb not null default '{}'::jsonb,
  unique (device_id, client_event_id)
);

create index if not exists time_clock_devices_org_establishment_idx
  on public.time_clock_devices (organization_id, establishment_id, status);
create index if not exists employee_time_clock_credentials_org_idx
  on public.employee_time_clock_credentials (organization_id, active);
create index if not exists time_clock_events_employee_idx
  on public.time_clock_events (organization_id, employee_id, occurred_at desc);
create index if not exists time_clock_events_establishment_idx
  on public.time_clock_events (organization_id, establishment_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Cohérence, horodatage et journal d'audit sans exposer les codes ni secrets.
-- ---------------------------------------------------------------------------

drop trigger if exists time_clock_devices_prevent_org_change on public.time_clock_devices;
create trigger time_clock_devices_prevent_org_change
  before update on public.time_clock_devices
  for each row execute function public.prevent_organization_change();
drop trigger if exists employee_time_clock_credentials_prevent_org_change on public.employee_time_clock_credentials;
create trigger employee_time_clock_credentials_prevent_org_change
  before update on public.employee_time_clock_credentials
  for each row execute function public.prevent_organization_change();
drop trigger if exists time_clock_events_prevent_org_change on public.time_clock_events;
create trigger time_clock_events_prevent_org_change
  before update on public.time_clock_events
  for each row execute function public.prevent_organization_change();

drop trigger if exists time_clock_devices_validate_org_links on public.time_clock_devices;
create trigger time_clock_devices_validate_org_links
  before insert or update on public.time_clock_devices
  for each row execute function public.validate_organization_links();
drop trigger if exists employee_time_clock_credentials_validate_org_links on public.employee_time_clock_credentials;
create trigger employee_time_clock_credentials_validate_org_links
  before insert or update on public.employee_time_clock_credentials
  for each row execute function public.validate_organization_links();
drop trigger if exists time_clock_events_validate_org_links on public.time_clock_events;
create trigger time_clock_events_validate_org_links
  before insert or update on public.time_clock_events
  for each row execute function public.validate_organization_links();

drop trigger if exists time_clock_devices_set_updated_at on public.time_clock_devices;
create trigger time_clock_devices_set_updated_at
  before update on public.time_clock_devices
  for each row execute function public.set_updated_at();
drop trigger if exists employee_time_clock_credentials_set_updated_at on public.employee_time_clock_credentials;
create trigger employee_time_clock_credentials_set_updated_at
  before update on public.employee_time_clock_credentials
  for each row execute function public.set_updated_at();
drop trigger if exists time_clock_devices_stamp_actor on public.time_clock_devices;
create trigger time_clock_devices_stamp_actor
  before insert or update on public.time_clock_devices
  for each row execute function public.stamp_actor();
drop trigger if exists employee_time_clock_credentials_stamp_actor on public.employee_time_clock_credentials;
create trigger employee_time_clock_credentials_stamp_actor
  before insert or update on public.employee_time_clock_credentials
  for each row execute function public.stamp_actor();

create or replace function public.audit_time_clock_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_org_id uuid;
  v_establishment_id uuid;
  v_resource_id text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    v_old := null;
  elsif tg_op = 'UPDATE' then
    v_new := to_jsonb(new);
    v_old := to_jsonb(old);
  else
    v_new := null;
    v_old := to_jsonb(old);
  end if;

  v_org_id := nullif(coalesce(v_new ->> 'organization_id', v_old ->> 'organization_id'), '')::uuid;
  v_establishment_id := nullif(coalesce(v_new ->> 'establishment_id', v_old ->> 'establishment_id'), '')::uuid;
  v_resource_id := coalesce(v_new ->> 'id', v_old ->> 'id', v_new ->> 'employee_id', v_old ->> 'employee_id');

  -- Les rafraîchissements de cache et le compteur anti-bruteforce ne sont pas
  -- des actions métier à journaliser. Surtout, aucun hash n'est jamais audité.
  if tg_table_name = 'time_clock_devices' and tg_op = 'UPDATE'
     and (to_jsonb(new) - array['failed_attempts', 'locked_until', 'last_seen_at', 'updated_at', 'updated_by'])
         = (to_jsonb(old) - array['failed_attempts', 'locked_until', 'last_seen_at', 'updated_at', 'updated_by']) then
    return new;
  end if;

  if tg_table_name = 'employee_time_clock_credentials' then
    v_old := case when v_old is null then null else jsonb_build_object(
      'employee_id', v_old ->> 'employee_id', 'active', v_old ->> 'active',
      'credential_version', v_old ->> 'credential_version', 'changed', true
    ) end;
    v_new := case when v_new is null then null else jsonb_build_object(
      'employee_id', v_new ->> 'employee_id', 'active', v_new ->> 'active',
      'credential_version', v_new ->> 'credential_version', 'changed', true
    ) end;
  elsif tg_table_name = 'time_clock_devices' then
    if v_old is not null then v_old := v_old - array['device_secret_hash', 'failed_attempts', 'locked_until']; end if;
    if v_new is not null then v_new := v_new - array['device_secret_hash', 'failed_attempts', 'locked_until']; end if;
  end if;

  if v_org_id is not null then
    insert into public.audit_logs (
      organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, old_value, new_value
    ) values (
      v_org_id, v_establishment_id, auth.uid(), 'time_clock.' || lower(tg_table_name) || '.' || lower(tg_op),
      tg_table_name, v_resource_id, v_old, v_new
    );
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists time_clock_devices_audit_change on public.time_clock_devices;
create trigger time_clock_devices_audit_change
  after insert or update or delete on public.time_clock_devices
  for each row execute function public.audit_time_clock_change();
drop trigger if exists employee_time_clock_credentials_audit_change on public.employee_time_clock_credentials;
create trigger employee_time_clock_credentials_audit_change
  after insert or update or delete on public.employee_time_clock_credentials
  for each row execute function public.audit_time_clock_change();
drop trigger if exists time_clock_events_audit_change on public.time_clock_events;

-- ---------------------------------------------------------------------------
-- Autorisations et fonctions réservées au gérant / manager habilité.
-- ---------------------------------------------------------------------------

create or replace function public.can_manage_time_clock(
  p_organization_id uuid,
  p_establishment_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_primary_establishment_id uuid;
begin
  if p_organization_id is null or p_establishment_id is null
     or not (
       public.has_permission(p_organization_id, 'pointage.edit_schedule')
       or public.has_permission(p_organization_id, 'pointage.suspend_device')
       or public.has_permission(p_organization_id, 'pointage.reactivate_device')
       or public.has_permission(p_organization_id, 'pointage.manage_settings')
     ) then
    return false;
  end if;
  if public.is_owner(p_organization_id) then return true; end if;
  select primary_establishment_id into v_primary_establishment_id
  from public.organization_members
  where organization_id = p_organization_id
    and user_id = auth.uid()
    and status = 'active'
  limit 1;
  return v_primary_establishment_id = p_establishment_id
    or public.member_in_scope(p_organization_id, p_establishment_id, null, null, null);
end;
$$;

create or replace function public.register_time_clock_device(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_name text,
  p_device_secret_hash text,
  p_timezone text default 'Europe/Paris'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.time_clock_devices%rowtype;
begin
  if not public.can_manage_time_clock(p_organization_id, p_establishment_id)
     or not (public.has_permission(p_organization_id, 'pointage.edit_schedule')
             or public.has_permission(p_organization_id, 'pointage.manage_settings')) then
    raise exception 'Not authorized to configure this time clock';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 2 and 80
     or coalesce(p_device_secret_hash, '') !~ '^[a-f0-9]{64}$'
     or char_length(trim(coalesce(p_timezone, ''))) not between 1 and 64 then
    raise exception 'Invalid time clock configuration';
  end if;
  if exists (
    select 1 from public.time_clock_devices
    where organization_id = p_organization_id
      and establishment_id = p_establishment_id
      and lower(name) = lower(trim(p_name))
  ) then
    raise exception 'A time clock with this name already exists for this establishment';
  end if;
  insert into public.time_clock_devices (
    organization_id, establishment_id, name, device_secret_hash, timezone, created_by, updated_by
  ) values (
    p_organization_id, p_establishment_id, trim(p_name), p_device_secret_hash, trim(p_timezone), auth.uid(), auth.uid()
  ) returning * into v_device;
  insert into public.audit_logs (organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_device.organization_id, v_device.establishment_id, auth.uid(), 'time_clock.device_registered', 'time_clock_device', v_device.id::text,
    jsonb_build_object('name', v_device.name));
  return jsonb_build_object('id', v_device.id, 'name', v_device.name, 'status', v_device.status);
end;
$$;

create or replace function public.list_time_clock_devices(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_member(p_organization_id)
     or not (
       public.has_permission(p_organization_id, 'pointage.edit_schedule')
       or public.has_permission(p_organization_id, 'pointage.suspend_device')
       or public.has_permission(p_organization_id, 'pointage.reactivate_device')
       or public.has_permission(p_organization_id, 'pointage.manage_settings')
     ) then
    raise exception 'Not authorized to view time clocks';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'establishment_id', d.establishment_id, 'name', d.name,
      'establishment_name', e.name,
      'timezone', d.timezone, 'status', d.status, 'last_seen_at', d.last_seen_at,
      'created_at', d.created_at, 'cache_version', d.cache_version
    ) order by d.created_at desc)
    from public.time_clock_devices d
    join public.establishments e on e.id = d.establishment_id
    where d.organization_id = p_organization_id
      and public.can_manage_time_clock(d.organization_id, d.establishment_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.set_time_clock_device_status(
  p_device_id uuid,
  p_status public.time_clock_device_status
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.time_clock_devices%rowtype;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id for update;
  if not found or not public.can_manage_time_clock(v_device.organization_id, v_device.establishment_id)
     or not (
       (p_status = 'active' and (public.has_permission(v_device.organization_id, 'pointage.reactivate_device') or public.has_permission(v_device.organization_id, 'pointage.manage_settings')))
       or (p_status <> 'active' and (public.has_permission(v_device.organization_id, 'pointage.suspend_device') or public.has_permission(v_device.organization_id, 'pointage.manage_settings')))
     ) then
    raise exception 'Not authorized to change this time clock';
  end if;
  update public.time_clock_devices
  set status = p_status,
      failed_attempts = case when p_status = 'active' then 0 else failed_attempts end,
      locked_until = case when p_status = 'active' then null else locked_until end,
      cache_version = cache_version + 1,
      updated_by = auth.uid()
  where id = p_device_id
  returning * into v_device;
  insert into public.audit_logs (organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_device.organization_id, v_device.establishment_id, auth.uid(), 'time_clock.device_status_changed', 'time_clock_device', v_device.id::text,
    jsonb_build_object('status', v_device.status));
  return jsonb_build_object('id', v_device.id, 'status', v_device.status);
end;
$$;

create or replace function public.list_time_clock_employees(
  p_organization_id uuid,
  p_establishment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.can_manage_time_clock(p_organization_id, p_establishment_id)
     or not (public.has_permission(p_organization_id, 'pointage.edit_schedule')
             or public.has_permission(p_organization_id, 'pointage.manage_settings')) then
    raise exception 'Not authorized to manage employee codes';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'employee_id', e.id,
      'display_name', e.display_name,
      'employee_number', e.employee_number,
      'has_pin', c.employee_id is not null and c.active,
      'credential_version', c.credential_version,
      'updated_at', c.updated_at
    ) order by e.display_name)
    from public.employees e
    left join public.employee_time_clock_credentials c on c.employee_id = e.id
    where e.organization_id = p_organization_id
      and e.establishment_id = p_establishment_id
      and e.employment_status = 'active'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.set_employee_time_clock_pin(
  p_organization_id uuid,
  p_employee_id uuid,
  p_pin text,
  p_offline_salt text,
  p_offline_hash text,
  p_offline_iterations integer default 310000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees%rowtype;
  v_credential public.employee_time_clock_credentials%rowtype;
begin
  select * into v_employee
  from public.employees
  where id = p_employee_id and organization_id = p_organization_id and employment_status = 'active';
  if not found or not public.can_manage_time_clock(p_organization_id, v_employee.establishment_id)
     or not (public.has_permission(p_organization_id, 'pointage.edit_schedule')
             or public.has_permission(p_organization_id, 'pointage.manage_settings')) then
    raise exception 'Not authorized to manage this employee code';
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{6}$'
     or char_length(coalesce(p_offline_salt, '')) not between 20 and 160
     or char_length(coalesce(p_offline_hash, '')) not between 40 and 180
     or coalesce(p_offline_iterations, 0) not between 200000 and 500000 then
    raise exception 'A time clock code must contain exactly six digits';
  end if;

  insert into public.employee_time_clock_credentials (
    employee_id, organization_id, pin_hash, offline_salt, offline_hash, offline_iterations,
    created_by, updated_by
  ) values (
    p_employee_id, p_organization_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
    p_offline_salt, p_offline_hash, p_offline_iterations, auth.uid(), auth.uid()
  )
  on conflict (employee_id) do update set
    pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
    previous_offline_salt = public.employee_time_clock_credentials.offline_salt,
    previous_offline_hash = public.employee_time_clock_credentials.offline_hash,
    previous_offline_iterations = public.employee_time_clock_credentials.offline_iterations,
    previous_offline_valid_until = now() + interval '7 days',
    offline_salt = excluded.offline_salt,
    offline_hash = excluded.offline_hash,
    offline_iterations = excluded.offline_iterations,
    credential_version = public.employee_time_clock_credentials.credential_version + 1,
    active = true,
    updated_by = auth.uid()
  returning * into v_credential;

  insert into public.audit_logs (organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_organization_id, v_employee.establishment_id, auth.uid(), 'time_clock.pin_changed', 'employee_time_clock_credential', p_employee_id::text,
    jsonb_build_object('credential_version', v_credential.credential_version));
  return jsonb_build_object('employee_id', p_employee_id, 'credential_version', v_credential.credential_version);
end;
$$;

-- Message canonique signé pour un badge hors ligne. Il lie la preuve à la
-- tablette, au salarié, au type de badge, à l'heure et à l'identifiant unique.
create or replace function public.time_clock_proof_message(
  p_device_id uuid,
  p_employee_id uuid,
  p_event_type public.time_clock_event_type,
  p_occurred_at timestamptz,
  p_client_event_id uuid
)
returns text
language sql
immutable
strict
set search_path = public
as $$
  select p_device_id::text || '|' || p_employee_id::text || '|' || p_event_type::text || '|' ||
    to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') || '|' || p_client_event_id::text;
$$;

create or replace function public.get_time_clock_device_cache(
  p_device_id uuid,
  p_device_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.time_clock_devices%rowtype;
  v_employees jsonb;
begin
  select * into v_device
  from public.time_clock_devices
  where id = p_device_id;
  if not found or v_device.device_secret_hash <> encode(extensions.digest(coalesce(p_device_secret, ''), 'sha256'), 'hex') then
    raise exception 'Time clock not authorized';
  end if;
  if v_device.status <> 'active' then
    raise exception 'This time clock is no longer active';
  end if;

  update public.time_clock_devices set last_seen_at = now() where id = v_device.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'employee_id', e.id,
    'display_name', e.display_name,
    'employee_number', e.employee_number,
    'offline_salt', c.offline_salt,
    'offline_hash', c.offline_hash,
    'offline_iterations', c.offline_iterations,
    'credential_version', c.credential_version,
    'last_event_type', last_event.event_type,
    'last_event_at', last_event.occurred_at
  ) order by e.display_name), '[]'::jsonb)
  into v_employees
  from public.employees e
  join public.employee_time_clock_credentials c
    on c.employee_id = e.id and c.organization_id = e.organization_id and c.active
  left join lateral (
    select event_type, occurred_at
    from public.time_clock_events
    where organization_id = e.organization_id and employee_id = e.id
    order by occurred_at desc, received_at desc
    limit 1
  ) last_event on true
  where e.organization_id = v_device.organization_id
    and e.establishment_id = v_device.establishment_id
    and e.employment_status = 'active';

  return jsonb_build_object(
    'device', jsonb_build_object(
      'id', v_device.id, 'organization_id', v_device.organization_id,
      'establishment_id', v_device.establishment_id, 'name', v_device.name,
      'timezone', v_device.timezone, 'status', v_device.status,
      'cache_version', v_device.cache_version
    ),
    'employees', v_employees,
    'generated_at', now()
  );
end;
$$;

-- Reconstruit le récapitulatif journalier visible dans la vue Pointage à
-- partir des événements immuables. Une correction manager est préservée dans
-- payload.adjustment, les badges bruts ne sont jamais remplacés.
create or replace function public.rebuild_time_clock_day_summary(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees%rowtype;
  v_event record;
  v_in timestamptz;
  v_out timestamptz;
  v_break_started timestamptz;
  v_pause_seconds numeric := 0;
  v_pause_minutes integer := 0;
  v_duration numeric := 0;
  v_event_count integer := 0;
  v_legacy_id text;
  v_existing_payload jsonb;
  v_payload jsonb;
begin
  select * into v_employee
  from public.employees
  where id = p_employee_id and organization_id = p_organization_id;
  if not found then raise exception 'Employee not found'; end if;

  for v_event in
    select event_type, occurred_at
    from public.time_clock_events
    where organization_id = p_organization_id
      and establishment_id = p_establishment_id
      and employee_id = p_employee_id
      and (occurred_at at time zone p_timezone)::date = p_work_date
    order by occurred_at, received_at, id
  loop
    v_event_count := v_event_count + 1;
    if v_event.event_type = 'clock_in' and v_in is null then
      v_in := v_event.occurred_at;
    elsif v_event.event_type = 'break_start' and v_in is not null and v_break_started is null then
      v_break_started := v_event.occurred_at;
    elsif v_event.event_type = 'break_end' and v_break_started is not null then
      v_pause_seconds := v_pause_seconds + greatest(0, extract(epoch from v_event.occurred_at - v_break_started));
      v_break_started := null;
    elsif v_event.event_type = 'clock_out' and v_in is not null then
      if v_break_started is not null then
        v_pause_seconds := v_pause_seconds + greatest(0, extract(epoch from v_event.occurred_at - v_break_started));
        v_break_started := null;
      end if;
      v_out := v_event.occurred_at;
    end if;
  end loop;

  v_pause_minutes := floor(v_pause_seconds / 60.0)::integer;
  if v_in is not null and v_out is not null then
    v_duration := greatest(0, round((extract(epoch from v_out - v_in) / 3600.0 - v_pause_minutes / 60.0)::numeric, 2));
  end if;
  v_legacy_id := 'time-clock:' || coalesce(v_employee.legacy_id, v_employee.id::text) || ':' || p_work_date::text;
  select payload into v_existing_payload
  from public.business_records
  where organization_id = p_organization_id and record_type = 'punch' and legacy_id = v_legacy_id
  limit 1;

  v_payload := jsonb_build_object(
    'id', v_legacy_id,
    'empId', coalesce(v_employee.legacy_id, v_employee.id::text),
    'date', p_work_date::text,
    'in', case when v_in is null then '' else to_char(v_in at time zone p_timezone, 'HH24:MI') end,
    'out', case when v_out is null then '' else to_char(v_out at time zone p_timezone, 'HH24:MI') end,
    'pauseMin', v_pause_minutes,
    'dur', v_duration,
    'source', 'external-time-clock',
    'rawIn', case when v_in is null then '' else to_char(v_in at time zone p_timezone, 'HH24:MI') end,
    'rawOut', case when v_out is null then '' else to_char(v_out at time zone p_timezone, 'HH24:MI') end,
    'rawPauseMin', v_pause_minutes,
    'rawEventCount', v_event_count,
    'updatedAt', now()
  );
  if v_existing_payload ? 'adjustment' then
    v_payload := v_payload || jsonb_build_object('adjustment', v_existing_payload -> 'adjustment');
  end if;

  perform set_config('app.plannipro_time_clock_rebuild', 'on', true);
  insert into public.business_records (
    organization_id, establishment_id, employee_id, record_type, legacy_id, payload, deleted_at
  ) values (
    p_organization_id, p_establishment_id, p_employee_id, 'punch', v_legacy_id, v_payload, null
  )
  on conflict (organization_id, record_type, legacy_id) do update set
    establishment_id = excluded.establishment_id,
    employee_id = excluded.employee_id,
    payload = excluded.payload,
    deleted_at = null;
  perform set_config('app.plannipro_time_clock_rebuild', 'off', true);

  return v_payload;
end;
$$;

create or replace function public.time_clock_badge(
  p_device_id uuid,
  p_device_secret text,
  p_employee_id uuid,
  p_event_type public.time_clock_event_type,
  p_occurred_at timestamptz,
  p_client_event_id uuid,
  p_offline_proof text default null,
  p_pin text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device public.time_clock_devices%rowtype;
  v_employee public.employees%rowtype;
  v_credential public.employee_time_clock_credentials%rowtype;
  v_existing public.time_clock_events%rowtype;
  v_last_type public.time_clock_event_type;
  v_last_at timestamptz;
  v_expected_proof text;
  v_verification public.time_clock_verification_mode;
  v_work_date date;
  v_summary jsonb;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id for update;
  if not found or v_device.device_secret_hash <> encode(extensions.digest(coalesce(p_device_secret, ''), 'sha256'), 'hex') then
    raise exception 'Time clock not authorized';
  end if;
  if v_device.status <> 'active' then raise exception 'This time clock is no longer active'; end if;
  if v_device.locked_until is not null and v_device.locked_until > now() then
    raise exception 'This time clock is temporarily locked';
  end if;
  if p_occurred_at is null or p_client_event_id is null
     or p_occurred_at < now() - interval '7 days'
     or p_occurred_at > now() + interval '10 minutes' then
    raise exception 'Invalid badge timestamp';
  end if;

  -- Un envoi rejoué après une perte de réseau ne crée jamais un second badge.
  select * into v_existing
  from public.time_clock_events
  where device_id = p_device_id and client_event_id = p_client_event_id;
  if found then
    return jsonb_build_object('event_id', v_existing.id, 'duplicate', true, 'event_type', v_existing.event_type, 'occurred_at', v_existing.occurred_at);
  end if;

  select * into v_employee
  from public.employees
  where id = p_employee_id
    and organization_id = v_device.organization_id
    and establishment_id = v_device.establishment_id
    and employment_status = 'active';
  if not found then raise exception 'Employee not authorized for this time clock'; end if;
  select * into v_credential
  from public.employee_time_clock_credentials
  where employee_id = p_employee_id and organization_id = v_device.organization_id and active;
  if not found then raise exception 'No active time clock code for this employee'; end if;

  if nullif(p_pin, '') is not null then
    if p_pin !~ '^[0-9]{6}$' or extensions.crypt(p_pin, v_credential.pin_hash) <> v_credential.pin_hash then
      update public.time_clock_devices
      set failed_attempts = least(failed_attempts + 1, 20),
          locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else locked_until end
      where id = v_device.id;
      return jsonb_build_object('error', 'Invalid time clock code');
    end if;
    v_verification := 'online_pin';
  else
    v_expected_proof := encode(extensions.hmac(
      convert_to(public.time_clock_proof_message(p_device_id, p_employee_id, p_event_type, p_occurred_at, p_client_event_id), 'UTF8'),
      decode(v_credential.offline_hash, 'base64'), 'sha256'
    ), 'hex');
    if coalesce(p_offline_proof, '') = v_expected_proof then
      v_verification := 'offline_proof';
    elsif v_credential.previous_offline_hash is not null
      and v_credential.previous_offline_valid_until > now()
      and coalesce(p_offline_proof, '') = encode(extensions.hmac(
        convert_to(public.time_clock_proof_message(p_device_id, p_employee_id, p_event_type, p_occurred_at, p_client_event_id), 'UTF8'),
        decode(v_credential.previous_offline_hash, 'base64'), 'sha256'
      ), 'hex') then
      v_verification := 'offline_proof';
    else
      update public.time_clock_devices
      set failed_attempts = least(failed_attempts + 1, 20),
          locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else locked_until end
      where id = v_device.id;
      return jsonb_build_object('error', 'Offline badge proof is invalid');
    end if;
  end if;

  select event_type, occurred_at into v_last_type, v_last_at
  from public.time_clock_events
  where organization_id = v_device.organization_id and employee_id = p_employee_id
  order by occurred_at desc, received_at desc
  limit 1;
  if v_last_at is not null and p_occurred_at < v_last_at then
    raise exception 'Badge timestamp is older than the latest badge';
  end if;
  if (p_event_type = 'clock_in' and v_last_type is not null and v_last_type <> 'clock_out')
     or (p_event_type = 'break_start' and coalesce(v_last_type::text, '') not in ('clock_in', 'break_end'))
     or (p_event_type = 'break_end' and coalesce(v_last_type::text, '') <> 'break_start')
     or (p_event_type = 'clock_out' and coalesce(v_last_type::text, '') not in ('clock_in', 'break_end')) then
    raise exception 'This badge is not allowed for the current attendance state';
  end if;

  insert into public.time_clock_events (
    organization_id, establishment_id, employee_id, device_id, event_type,
    occurred_at, client_event_id, verification_mode, metadata
  ) values (
    v_device.organization_id, v_device.establishment_id, p_employee_id, v_device.id, p_event_type,
    p_occurred_at, p_client_event_id, v_verification,
    jsonb_build_object('source', 'tablet', 'timezone', v_device.timezone, 'offline', v_verification = 'offline_proof')
  ) returning * into v_existing;

  update public.time_clock_devices
  set failed_attempts = 0, locked_until = null, last_seen_at = now()
  where id = v_device.id;

  v_work_date := (p_occurred_at at time zone v_device.timezone)::date;
  v_summary := public.rebuild_time_clock_day_summary(
    v_device.organization_id, v_device.establishment_id, p_employee_id, v_work_date, v_device.timezone
  );
  insert into public.audit_logs (organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (
    v_device.organization_id, v_device.establishment_id, null, 'time_clock.badge', 'time_clock_event', v_existing.id::text,
    jsonb_build_object('device_id', v_device.id, 'employee_id', p_employee_id, 'event_type', p_event_type,
      'verification_mode', v_verification, 'occurred_at', p_occurred_at)
  );
  return jsonb_build_object(
    'event_id', v_existing.id, 'duplicate', false, 'event_type', v_existing.event_type,
    'occurred_at', v_existing.occurred_at, 'summary', v_summary
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS : les tables sensibles ne sont pas accessibles directement depuis la
-- tablette. Seule la lecture des événements suit les permissions Pointage.
-- ---------------------------------------------------------------------------

alter table public.time_clock_devices enable row level security;
alter table public.employee_time_clock_credentials enable row level security;
alter table public.time_clock_events enable row level security;

-- Pas de politique directe sur appareils ou identifiants : la gestion passe
-- uniquement par les RPC SECURITY DEFINER ci-dessus, qui masquent les secrets.
drop policy if exists time_clock_events_select on public.time_clock_events;
create policy time_clock_events_select on public.time_clock_events
  for select to authenticated using (
    public.can_access_record(organization_id, 'punch', establishment_id, employee_id, null, null, 'view')
  );

revoke all on function public.can_manage_time_clock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.audit_time_clock_change() from public, anon, authenticated;
revoke all on function public.register_time_clock_device(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.list_time_clock_devices(uuid) from public, anon, authenticated;
revoke all on function public.set_time_clock_device_status(uuid, public.time_clock_device_status) from public, anon, authenticated;
revoke all on function public.list_time_clock_employees(uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_employee_time_clock_pin(uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.time_clock_proof_message(uuid, uuid, public.time_clock_event_type, timestamptz, uuid) from public, anon, authenticated;
revoke all on function public.get_time_clock_device_cache(uuid, text) from public, anon, authenticated;
revoke all on function public.rebuild_time_clock_day_summary(uuid, uuid, uuid, date, text) from public, anon, authenticated;
revoke all on function public.time_clock_badge(uuid, text, uuid, public.time_clock_event_type, timestamptz, uuid, text, text) from public, anon, authenticated;

grant execute on function public.can_manage_time_clock(uuid, uuid) to authenticated;
grant execute on function public.register_time_clock_device(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.list_time_clock_devices(uuid) to authenticated;
grant execute on function public.set_time_clock_device_status(uuid, public.time_clock_device_status) to authenticated;
grant execute on function public.list_time_clock_employees(uuid, uuid) to authenticated;
grant execute on function public.set_employee_time_clock_pin(uuid, uuid, text, text, text, integer) to authenticated;
-- La tablette n'a pas de session salarié : ces deux RPC exigent néanmoins le
-- secret d'appareil, le code ou la preuve cryptographique de badge.
grant execute on function public.get_time_clock_device_cache(uuid, text) to anon, authenticated;
grant execute on function public.time_clock_badge(uuid, text, uuid, public.time_clock_event_type, timestamptz, uuid, text, text) to anon, authenticated;

comment on table public.time_clock_devices is 'Tablettes de pointage enregistrées ; le secret brut reste uniquement dans IndexedDB de la tablette.';
comment on table public.employee_time_clock_credentials is 'Codes de pointage salariés, jamais exposés ni journalisés en clair.';
comment on table public.time_clock_events is 'Événements de badge immuables, synchronisés dans business_records pour la vue Pointage.';
