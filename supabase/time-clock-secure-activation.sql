-- PlanniPro - activation volontaire et securisation des terminaux de pointage.
-- A executer apres schema.sql, time-clock.sql et rbac-advanced.sql.
-- Migration transactionnelle, idempotente et sans suppression de pointages.

begin;

alter table public.time_clock_devices add column if not exists location text;
alter table public.time_clock_devices add column if not exists description text;
alter table public.time_clock_devices add column if not exists activated_at timestamptz;
alter table public.time_clock_devices add column if not exists activated_by uuid references public.profiles(id) on delete set null;
alter table public.time_clock_devices add column if not exists last_user_agent text;
alter table public.time_clock_devices add column if not exists app_version text;
alter table public.time_clock_devices add column if not exists revoked_at timestamptz;
alter table public.time_clock_devices add column if not exists revoked_by uuid references public.profiles(id) on delete set null;
alter table public.time_clock_devices add column if not exists revocation_reason text;
alter table public.time_clock_devices add column if not exists deleted_at timestamptz;
alter table public.time_clock_devices add column if not exists deleted_by uuid references public.profiles(id) on delete set null;
alter table public.time_clock_devices add column if not exists attempt_window_started_at timestamptz;
alter table public.time_clock_devices add column if not exists lock_level smallint not null default 0;

update public.time_clock_devices
set activated_at = coalesce(activated_at, created_at),
    activated_by = coalesce(activated_by, created_by)
where activated_at is null;

alter table public.employee_time_clock_credentials alter column offline_salt drop not null;
alter table public.employee_time_clock_credentials alter column offline_hash drop not null;
alter table public.employee_time_clock_credentials add column if not exists pin_status text not null default 'active';
alter table public.employee_time_clock_credentials add column if not exists pin_updated_at timestamptz;
alter table public.employee_time_clock_credentials add column if not exists pin_failed_attempts integer not null default 0;
alter table public.employee_time_clock_credentials add column if not exists pin_locked_until timestamptz;
alter table public.employee_time_clock_credentials add column if not exists last_used_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'employee_time_clock_credentials_pin_status_check'
      and conrelid = 'public.employee_time_clock_credentials'::regclass
  ) then
    alter table public.employee_time_clock_credentials
      add constraint employee_time_clock_credentials_pin_status_check
      check (pin_status in ('active', 'blocked', 'revoked'));
  end if;
end $$;

create table if not exists public.time_clock_device_activation_codes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_device_id uuid references public.time_clock_devices(id) on delete set null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create unique index if not exists time_clock_activation_code_hash_idx
  on public.time_clock_device_activation_codes(code_hash);
create index if not exists time_clock_activation_active_idx
  on public.time_clock_device_activation_codes(organization_id, establishment_id, expires_at)
  where used_at is null;

create index if not exists time_clock_devices_archive_idx
  on public.time_clock_devices(organization_id, establishment_id, deleted_at);

create table if not exists public.employee_time_clock_pin_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create unique index if not exists employee_clock_pin_invitation_hash_idx
  on public.employee_time_clock_pin_invitations(token_hash);
create index if not exists employee_clock_pin_invitation_employee_idx
  on public.employee_time_clock_pin_invitations(organization_id, employee_id, expires_at)
  where used_at is null;

alter table public.time_clock_device_activation_codes enable row level security;
alter table public.employee_time_clock_pin_invitations enable row level security;
revoke all on public.time_clock_device_activation_codes from anon, authenticated;
revoke all on public.employee_time_clock_pin_invitations from anon, authenticated;

insert into public.permissions(key, module, action, label, is_sensitive)
values
  ('clock_devices.view', 'clock_devices', 'view', 'Pointeuses - Consulter', true),
  ('clock_devices.create', 'clock_devices', 'create', 'Pointeuses - Activer', true),
  ('clock_devices.update', 'clock_devices', 'update', 'Pointeuses - Modifier', true),
  ('clock_devices.disable', 'clock_devices', 'disable', 'Pointeuses - Desactiver', true),
  ('clock_devices.delete', 'clock_devices', 'delete', 'Pointeuses - Supprimer ou archiver', true),
  ('clock_pin.generate', 'clock_pin', 'generate', 'Codes de pointage - Generer', true),
  ('clock_pin.reset', 'clock_pin', 'reset', 'Codes de pointage - Reinitialiser', true),
  ('clock_pin.block', 'clock_pin', 'block', 'Codes de pointage - Bloquer', true),
  ('clock_records.correct', 'clock_records', 'correct', 'Pointages - Corriger', true)
on conflict (key) do update set
  module = excluded.module,
  action = excluded.action,
  label = excluded.label,
  is_sensitive = excluded.is_sensitive;

insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key in ('owner', 'administrator')
  and p.key in (
    'clock_devices.view','clock_devices.create','clock_devices.update','clock_devices.disable','clock_devices.delete',
    'clock_pin.generate','clock_pin.reset','clock_pin.block','clock_records.correct'
  )
on conflict do nothing;

insert into public.role_permissions(role_id, permission_key)
select r.id, p.key
from public.roles r
cross join public.permissions p
where r.key = 'hr_manager'
  and p.key in ('clock_devices.view','clock_pin.generate','clock_pin.reset','clock_pin.block','clock_records.correct')
on conflict do nothing;

create or replace function public.can_manage_clock_device(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_organization_id is not null
    and p_establishment_id is not null
    and p_permission_key = any(array[
      'clock_devices.view','clock_devices.create','clock_devices.update','clock_devices.disable','clock_devices.delete'
    ])
    and public.has_permission(p_organization_id, p_permission_key)
    and (
      public.is_owner(p_organization_id)
      or public.can_access_establishment(p_organization_id, p_establishment_id, 'view')
    );
$$;

create or replace function public.create_time_clock_activation_code(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_ttl_minutes integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_hash text;
  v_id uuid;
  v_expires timestamptz;
begin
  if not public.can_manage_clock_device(p_organization_id, p_establishment_id, 'clock_devices.create') then
    raise exception 'Not authorized to activate a time clock';
  end if;
  if coalesce(p_ttl_minutes, 0) < 1 or p_ttl_minutes > 10 then
    raise exception 'Activation validity must be between one and ten minutes';
  end if;

  delete from public.time_clock_device_activation_codes
  where organization_id = p_organization_id
    and used_at is null and expires_at < now() - interval '1 day';

  loop
    select string_agg(
      substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(random_bytes, idx) % 32) + 1, 1),
      '' order by idx
    ) into v_code
    from (select extensions.gen_random_bytes(8) as random_bytes) source,
      generate_series(0, 7) as positions(idx);
    v_hash := encode(extensions.digest(v_code, 'sha256'), 'hex');
    exit when not exists (
      select 1 from public.time_clock_device_activation_codes where code_hash = v_hash
    );
  end loop;
  v_expires := now() + make_interval(mins => p_ttl_minutes);
  insert into public.time_clock_device_activation_codes(
    organization_id, establishment_id, code_hash, expires_at, created_by
  ) values (
    p_organization_id, p_establishment_id, v_hash, v_expires, auth.uid()
  ) returning id into v_id;
  insert into public.audit_logs(
    organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata
  ) values (
    p_organization_id, p_establishment_id, auth.uid(), 'time_clock.activation_requested',
    'time_clock_device_activation', v_id::text, jsonb_build_object('expires_at', v_expires)
  );
  return jsonb_build_object(
    'activation_id', v_id,
    'code', substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4),
    'expires_at', v_expires
  );
end;
$$;

create or replace function public.activate_time_clock_device(
  p_activation_code text,
  p_device_token text,
  p_name text,
  p_location text default null,
  p_description text default null,
  p_user_agent text default null,
  p_app_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code_hash text;
  v_activation public.time_clock_device_activation_codes%rowtype;
  v_device public.time_clock_devices%rowtype;
begin
  if coalesce(p_device_token, '') !~ '^[A-Za-z0-9_-]{32,160}$'
     or char_length(trim(coalesce(p_name, ''))) not between 2 and 80
     or char_length(coalesce(p_location, '')) > 160
     or char_length(coalesce(p_description, '')) > 500 then
    raise exception 'Invalid time clock activation request';
  end if;
  v_code_hash := encode(extensions.digest(upper(regexp_replace(coalesce(p_activation_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
  select * into v_activation
  from public.time_clock_device_activation_codes
  where code_hash = v_code_hash
  for update;
  if not found or v_activation.used_at is not null or v_activation.expires_at <= now() then
    raise exception 'Activation code is invalid, expired or already used';
  end if;

  insert into public.time_clock_devices(
    organization_id, establishment_id, name, location, description, device_secret_hash,
    timezone, status, activated_at, activated_by, last_seen_at, last_user_agent,
    app_version, created_by, updated_by
  ) values (
    v_activation.organization_id, v_activation.establishment_id, trim(p_name),
    nullif(trim(coalesce(p_location, '')), ''), nullif(trim(coalesce(p_description, '')), ''),
    encode(extensions.digest(p_device_token, 'sha256'), 'hex'), 'Europe/Paris', 'active',
    now(), v_activation.created_by, now(), left(p_user_agent, 500), left(p_app_version, 40),
    v_activation.created_by, v_activation.created_by
  ) returning * into v_device;

  update public.time_clock_device_activation_codes
  set used_at = now(), used_device_id = v_device.id
  where id = v_activation.id;
  insert into public.audit_logs(
    organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata
  ) values (
    v_device.organization_id, v_device.establishment_id, v_activation.created_by,
    'time_clock.device_activated', 'time_clock_device', v_device.id::text,
    jsonb_build_object('name', v_device.name, 'activation_id', v_activation.id)
  );
  return jsonb_build_object(
    'id', v_device.id, 'organization_id', v_device.organization_id,
    'establishment_id', v_device.establishment_id, 'name', v_device.name,
    'location', v_device.location, 'status', v_device.status,
    'activated_at', v_device.activated_at
  );
end;
$$;

create or replace function public.get_time_clock_device_cache(
  p_device_id uuid,
  p_device_secret text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.time_clock_devices%rowtype;
  v_establishment_name text;
begin
  select * into v_device
  from public.time_clock_devices
  where id = p_device_id;
  if not found or v_device.device_secret_hash <> encode(extensions.digest(coalesce(p_device_secret, ''), 'sha256'), 'hex') then
    raise exception 'Time clock not authorized';
  end if;
  if v_device.deleted_at is not null or v_device.status <> 'active' then
    raise exception 'This time clock is no longer active';
  end if;
  select name into v_establishment_name from public.establishments where id = v_device.establishment_id;
  update public.time_clock_devices
  set last_seen_at = now(), last_user_agent = left(coalesce(
    (coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'user-agent'),
    last_user_agent
  ), 500)
  where id = v_device.id;
  return jsonb_build_object(
    'device', jsonb_build_object(
      'id', v_device.id, 'organization_id', v_device.organization_id,
      'establishment_id', v_device.establishment_id, 'establishment_name', v_establishment_name,
      'name', v_device.name, 'location', v_device.location, 'description', v_device.description,
      'timezone', v_device.timezone, 'status', v_device.status,
      'activated_at', v_device.activated_at, 'cache_version', v_device.cache_version
    ),
    'generated_at', now()
  );
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
set search_path = ''
as $$
begin
  if not public.is_active_member(p_organization_id)
     or not (
       public.has_permission(p_organization_id, 'clock_pin.generate')
       or public.has_permission(p_organization_id, 'clock_pin.reset')
       or public.has_permission(p_organization_id, 'clock_pin.block')
     )
     or not public.can_access_establishment(p_organization_id, p_establishment_id, 'view') then
    raise exception 'Not authorized to manage employee codes';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'employee_id', e.id, 'display_name', e.display_name,
      'employee_number', e.employee_number,
      'has_pin', c.employee_id is not null and c.active and c.pin_status = 'active',
      'pin_status', coalesce(c.pin_status, 'unconfigured'),
      'credential_version', c.credential_version,
      'pin_updated_at', c.pin_updated_at,
      'last_used_at', c.last_used_at
    ) order by e.display_name)
    from public.employees e
    left join public.employee_time_clock_credentials c on c.employee_id = e.id
    where e.organization_id = p_organization_id
      and e.establishment_id = p_establishment_id
      and e.employment_status = 'active'
      and public.can_access_employee(p_organization_id, e.establishment_id, e.id, e.team_id, e.service_id, 'view')
  ), '[]'::jsonb);
end;
$$;

create or replace function public.list_time_clock_device_history(p_device_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_device public.time_clock_devices%rowtype;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id;
  if not found or not public.can_manage_clock_device(v_device.organization_id, v_device.establishment_id, 'clock_devices.view') then
    raise exception 'Not authorized to view this time clock history';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'action', a.action, 'created_at', a.created_at,
      'actor_user_id', a.actor_user_id, 'metadata', a.metadata
    ) order by a.created_at desc)
    from public.audit_logs a
    where a.organization_id = v_device.organization_id
      and a.resource_id = p_device_id::text
      and a.action like 'time_clock.%'
  ), '[]'::jsonb);
end;
$$;

create or replace function public.list_time_clock_devices(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_active_member(p_organization_id)
     or not public.has_permission(p_organization_id, 'clock_devices.view') then
    raise exception 'Not authorized to view time clocks';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'establishment_id', d.establishment_id, 'name', d.name,
      'establishment_name', e.name, 'location', d.location, 'description', d.description,
      'timezone', d.timezone, 'status', case when d.deleted_at is not null then 'archived' else d.status::text end,
      'activated_at', d.activated_at, 'activated_by', d.activated_by,
      'last_seen_at', d.last_seen_at, 'last_user_agent', d.last_user_agent,
      'app_version', d.app_version, 'revoked_at', d.revoked_at,
      'revocation_reason', d.revocation_reason, 'deleted_at', d.deleted_at,
      'event_count', (select count(*) from public.time_clock_events ev where ev.device_id = d.id)
    ) order by d.deleted_at nulls first, d.created_at desc)
    from public.time_clock_devices d
    join public.establishments e on e.id = d.establishment_id
    where d.organization_id = p_organization_id
      and public.can_manage_clock_device(d.organization_id, d.establishment_id, 'clock_devices.view')
  ), '[]'::jsonb);
end;
$$;

create or replace function public.update_time_clock_device(
  p_device_id uuid,
  p_name text,
  p_location text default null,
  p_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_device public.time_clock_devices%rowtype;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id for update;
  if not found or not public.can_manage_clock_device(v_device.organization_id, v_device.establishment_id, 'clock_devices.update') then
    raise exception 'Not authorized to update this time clock';
  end if;
  if char_length(trim(coalesce(p_name, ''))) not between 2 and 80
     or char_length(coalesce(p_location, '')) > 160
     or char_length(coalesce(p_description, '')) > 500 then
    raise exception 'Invalid time clock configuration';
  end if;
  update public.time_clock_devices
  set name = trim(p_name), location = nullif(trim(coalesce(p_location, '')), ''),
      description = nullif(trim(coalesce(p_description, '')), ''),
      cache_version = cache_version + 1, updated_by = auth.uid()
  where id = p_device_id returning * into v_device;
  insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values(v_device.organization_id, v_device.establishment_id, auth.uid(), 'time_clock.device_updated', 'time_clock_device', v_device.id::text,
    jsonb_build_object('name', v_device.name, 'location', v_device.location));
  return jsonb_build_object('id', v_device.id, 'name', v_device.name, 'location', v_device.location, 'description', v_device.description);
end;
$$;

create or replace function public.set_time_clock_device_status(
  p_device_id uuid,
  p_status public.time_clock_device_status,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_device public.time_clock_devices%rowtype;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id for update;
  if not found or v_device.deleted_at is not null then raise exception 'Time clock unavailable'; end if;
  if p_status = 'active' then
    if not public.can_manage_clock_device(v_device.organization_id, v_device.establishment_id, 'clock_devices.update') then
      raise exception 'Not authorized to reactivate this time clock';
    end if;
  elsif not public.can_manage_clock_device(v_device.organization_id, v_device.establishment_id, 'clock_devices.disable') then
    raise exception 'Not authorized to disable this time clock';
  end if;
  update public.time_clock_devices
  set status = p_status,
      failed_attempts = case when p_status = 'active' then 0 else failed_attempts end,
      locked_until = case when p_status = 'active' then null else locked_until end,
      revoked_at = case when p_status = 'revoked' then now() when p_status = 'active' then null else revoked_at end,
      revoked_by = case when p_status = 'revoked' then auth.uid() when p_status = 'active' then null else revoked_by end,
      revocation_reason = case when p_status = 'revoked' then left(nullif(trim(coalesce(p_reason, '')), ''), 500) when p_status = 'active' then null else revocation_reason end,
      cache_version = cache_version + 1, updated_by = auth.uid()
  where id = p_device_id returning * into v_device;
  insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values(v_device.organization_id, v_device.establishment_id, auth.uid(), 'time_clock.device_status_changed', 'time_clock_device', v_device.id::text,
    jsonb_build_object('status', v_device.status, 'reason', v_device.revocation_reason));
  return jsonb_build_object('id', v_device.id, 'status', v_device.status, 'revoked_at', v_device.revoked_at);
end;
$$;

create or replace function public.delete_or_archive_time_clock_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.time_clock_devices%rowtype;
  v_count bigint;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id for update;
  if not found or not public.can_manage_clock_device(v_device.organization_id, v_device.establishment_id, 'clock_devices.delete') then
    raise exception 'Not authorized to remove this time clock';
  end if;
  select count(*) into v_count from public.time_clock_events where device_id = p_device_id;
  if v_count = 0 then
    delete from public.time_clock_devices where id = p_device_id;
    insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
    values(v_device.organization_id, v_device.establishment_id, auth.uid(), 'time_clock.device_deleted', 'time_clock_device', p_device_id::text,
      jsonb_build_object('name', v_device.name, 'event_count', 0));
    return jsonb_build_object('id', p_device_id, 'result', 'deleted', 'event_count', 0);
  end if;
  update public.time_clock_devices
  set status = 'revoked', revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, auth.uid()),
      revocation_reason = coalesce(revocation_reason, 'Archived by administrator'),
      deleted_at = now(), deleted_by = auth.uid(), cache_version = cache_version + 1, updated_by = auth.uid()
  where id = p_device_id;
  insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values(v_device.organization_id, v_device.establishment_id, auth.uid(), 'time_clock.device_archived', 'time_clock_device', p_device_id::text,
    jsonb_build_object('name', v_device.name, 'event_count', v_count));
  return jsonb_build_object('id', p_device_id, 'result', 'archived', 'event_count', v_count);
end;
$$;

create or replace function public.secure_six_digit_pin()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_bytes bytea;
  v_value bigint;
  v_pin text;
begin
  loop
    v_bytes := extensions.gen_random_bytes(4);
    v_value := (get_byte(v_bytes, 0)::bigint << 24)
      + (get_byte(v_bytes, 1)::bigint << 16)
      + (get_byte(v_bytes, 2)::bigint << 8)
      + get_byte(v_bytes, 3)::bigint;
    if v_value < 4294800000 then
      v_pin := (100000 + (v_value % 900000))::text;
      if v_pin not in ('000000','111111','222222','333333','444444','555555','666666','777777','888888','999999',
        '012345','123456','234567','345678','456789','987654','876543','765432','654321') then
        return v_pin;
      end if;
    end if;
  end loop;
end;
$$;

create or replace function public.generate_employee_time_clock_pin(
  p_organization_id uuid,
  p_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
  v_pin text;
  v_conflict boolean;
  v_version integer;
begin
  select * into v_employee from public.employees
  where id = p_employee_id and organization_id = p_organization_id and employment_status = 'active';
  if not found or not public.has_permission(p_organization_id, 'clock_pin.generate')
     or not public.can_access_employee(p_organization_id, v_employee.establishment_id, v_employee.id, v_employee.team_id, v_employee.service_id, 'update') then
    raise exception 'Not authorized to generate this employee code';
  end if;
  loop
    v_pin := public.secure_six_digit_pin();
    select exists(
      select 1 from public.employee_time_clock_credentials c
      where c.organization_id = p_organization_id and c.active and c.pin_status = 'active'
        and extensions.crypt(v_pin, c.pin_hash) = c.pin_hash
    ) into v_conflict;
    exit when not v_conflict;
  end loop;
  insert into public.employee_time_clock_credentials(
    employee_id, organization_id, pin_hash, offline_salt, offline_hash,
    active, pin_status, pin_updated_at, pin_failed_attempts, pin_locked_until,
    created_by, updated_by
  ) values (
    p_employee_id, p_organization_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 12)), null, null,
    true, 'active', now(), 0, null, auth.uid(), auth.uid()
  ) on conflict (employee_id) do update set
    pin_hash = extensions.crypt(v_pin, extensions.gen_salt('bf', 12)),
    offline_salt = null, offline_hash = null, previous_offline_salt = null,
    previous_offline_hash = null, previous_offline_iterations = null,
    previous_offline_valid_until = null, credential_version = public.employee_time_clock_credentials.credential_version + 1,
    active = true, pin_status = 'active', pin_updated_at = now(), pin_failed_attempts = 0,
    pin_locked_until = null, updated_by = auth.uid()
  returning credential_version into v_version;
  insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values(p_organization_id, v_employee.establishment_id, auth.uid(), 'time_clock.pin_generated', 'employee_time_clock_credential', p_employee_id::text,
    jsonb_build_object('credential_version', v_version));
  return jsonb_build_object('employee_id', p_employee_id, 'pin', v_pin, 'credential_version', v_version, 'visible_once', true);
end;
$$;

create or replace function public.create_employee_time_clock_pin_invitation(
  p_organization_id uuid,
  p_employee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee public.employees%rowtype;
  v_token text;
  v_id uuid;
  v_email text;
  v_expires timestamptz := now() + interval '24 hours';
begin
  select * into v_employee from public.employees where id = p_employee_id and organization_id = p_organization_id;
  if not found or not public.has_permission(p_organization_id, 'clock_pin.reset')
     or not public.can_access_employee(p_organization_id, v_employee.establishment_id, v_employee.id, v_employee.team_id, v_employee.service_id, 'update') then
    raise exception 'Not authorized to invite this employee';
  end if;
  -- L'adresse configurée par l'équipe pour les notifications de planning est
  -- prioritaire. Le repli sur l'e-mail personnel conserve la compatibilité
  -- avec les fiches renseignées par le salarié lui-même. to_jsonb permet à ce
  -- script de rester rejouable avant ou après la migration Publications.
  select coalesce(
    nullif(trim(to_jsonb(s) ->> 'planning_notification_email'), ''),
    nullif(trim(s.personal_email), '')
  ) into v_email
  from public.employee_self_service s
  where s.employee_id = p_employee_id and s.organization_id = p_organization_id;
  update public.employee_time_clock_pin_invitations set used_at = now()
  where organization_id = p_organization_id and employee_id = p_employee_id and used_at is null;
  v_token := replace(replace(replace(encode(extensions.gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'), '=', '');
  insert into public.employee_time_clock_pin_invitations(organization_id, employee_id, token_hash, expires_at, created_by)
  values(p_organization_id, p_employee_id, encode(extensions.digest(v_token, 'sha256'), 'hex'), v_expires, auth.uid())
  returning id into v_id;
  insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values(p_organization_id, v_employee.establishment_id, auth.uid(), 'time_clock.pin_invitation_created', 'employee_time_clock_pin_invitation', v_id::text,
    jsonb_build_object('employee_id', p_employee_id, 'expires_at', v_expires));
  return jsonb_build_object('invitation_id', v_id, 'token', v_token, 'expires_at', v_expires, 'employee_email', v_email);
end;
$$;

create or replace function public.consume_employee_time_clock_pin_invitation(p_token text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.employee_time_clock_pin_invitations%rowtype;
  v_conflict boolean;
  v_employee public.employees%rowtype;
begin
  if coalesce(p_pin, '') !~ '^[0-9]{6}$'
     or p_pin in ('000000','111111','222222','333333','444444','555555','666666','777777','888888','999999',
       '012345','123456','234567','345678','456789','987654','876543','765432','654321') then
    raise exception 'The selected code is not allowed';
  end if;
  select * into v_invitation from public.employee_time_clock_pin_invitations
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if not found or v_invitation.used_at is not null or v_invitation.expires_at <= now() then
    raise exception 'Invitation is invalid, expired or already used';
  end if;
  select * into v_employee from public.employees where id = v_invitation.employee_id and employment_status = 'active';
  if not found then raise exception 'Employee unavailable'; end if;
  select exists(
    select 1 from public.employee_time_clock_credentials c
    where c.organization_id = v_invitation.organization_id and c.employee_id <> v_invitation.employee_id
      and c.active and c.pin_status = 'active' and extensions.crypt(p_pin, c.pin_hash) = c.pin_hash
  ) into v_conflict;
  if v_conflict then raise exception 'The selected code is unavailable'; end if;
  insert into public.employee_time_clock_credentials(
    employee_id, organization_id, pin_hash, offline_salt, offline_hash, active, pin_status,
    pin_updated_at, pin_failed_attempts, created_by, updated_by
  ) values (
    v_invitation.employee_id, v_invitation.organization_id, extensions.crypt(p_pin, extensions.gen_salt('bf', 12)),
    null, null, true, 'active', now(), 0, v_invitation.created_by, v_invitation.created_by
  ) on conflict (employee_id) do update set
    pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 12)), offline_salt = null, offline_hash = null,
    credential_version = public.employee_time_clock_credentials.credential_version + 1,
    active = true, pin_status = 'active', pin_updated_at = now(), pin_failed_attempts = 0, pin_locked_until = null;
  update public.employee_time_clock_pin_invitations set used_at = now() where id = v_invitation.id;
  insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values(v_invitation.organization_id, v_employee.establishment_id, null, 'time_clock.pin_invitation_used', 'employee_time_clock_pin_invitation', v_invitation.id::text,
    jsonb_build_object('employee_id', v_invitation.employee_id));
  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.verify_time_clock_pin(
  p_device_id uuid,
  p_device_token text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.time_clock_devices%rowtype;
  v_match record;
  v_matched boolean := false;
  v_attempts integer;
  v_level integer;
  v_last_type public.time_clock_event_type;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id for update;
  if not found or v_device.device_secret_hash <> encode(extensions.digest(coalesce(p_device_token, ''), 'sha256'), 'hex') then
    raise exception 'Time clock not authorized';
  end if;
  if v_device.deleted_at is not null or v_device.status <> 'active' then
    raise exception 'This time clock is no longer active';
  end if;
  if v_device.locked_until is not null and v_device.locked_until > now() then
    return jsonb_build_object('error', 'Code incorrect ou indisponible', 'locked_until', v_device.locked_until);
  end if;
  if coalesce(p_pin, '') ~ '^[0-9]{6}$' then
    select e.id employee_id, e.first_name, e.display_name, c.credential_version
    into v_match
    from public.employees e
    join public.employee_time_clock_credentials c on c.employee_id = e.id and c.organization_id = e.organization_id
    where e.organization_id = v_device.organization_id
      and e.establishment_id = v_device.establishment_id
      and e.employment_status = 'active' and c.active and c.pin_status = 'active'
      and (c.pin_locked_until is null or c.pin_locked_until <= now())
      and extensions.crypt(p_pin, c.pin_hash) = c.pin_hash
    limit 1;
    v_matched := found;
  end if;
  if not v_matched then
    v_attempts := case when v_device.attempt_window_started_at is null or v_device.attempt_window_started_at < now() - interval '5 minutes'
      then 1 else least(v_device.failed_attempts + 1, 20) end;
    v_level := case when v_attempts >= 5 then least(v_device.lock_level + 1, 6) else v_device.lock_level end;
    update public.time_clock_devices set
      failed_attempts = v_attempts,
      attempt_window_started_at = case when v_attempts = 1 then now() else coalesce(attempt_window_started_at, now()) end,
      lock_level = v_level,
      locked_until = case when v_attempts >= 5 then now() + make_interval(mins => least(5 * (2 ^ greatest(v_level - 1, 0))::integer, 320)) else null end,
      last_seen_at = now()
    where id = v_device.id;
    insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
    values(v_device.organization_id, v_device.establishment_id, null, 'time_clock.pin_failed', 'time_clock_device', v_device.id::text,
      jsonb_build_object('attempts_in_window', v_attempts, 'locked', v_attempts >= 5));
    return jsonb_build_object('error', 'Code incorrect ou indisponible');
  end if;
  update public.time_clock_devices set failed_attempts = 0, locked_until = null, attempt_window_started_at = null, last_seen_at = now() where id = v_device.id;
  update public.employee_time_clock_credentials set pin_failed_attempts = 0, pin_locked_until = null, last_used_at = now() where employee_id = v_match.employee_id;
  select event_type into v_last_type from public.time_clock_events
  where organization_id = v_device.organization_id and employee_id = v_match.employee_id
  order by occurred_at desc, received_at desc limit 1;
  return jsonb_build_object(
    'employee_id', v_match.employee_id,
    'first_name', left(coalesce(v_match.first_name, ''), 80),
    'display_name', left(coalesce(v_match.display_name, ''), 120),
    'last_event_type', v_last_type,
    'allowed_actions', case
      when v_last_type is null or v_last_type = 'clock_out' then jsonb_build_array('clock_in')
      when v_last_type = 'break_start' then jsonb_build_array('break_end')
      else jsonb_build_array('break_start', 'clock_out') end
  );
end;
$$;

-- L'ancienne preuve hors ligne est volontairement desactivee. Un nouveau badge
-- exige toujours le PIN et une verification serveur ; aucun hash n'est distribue.
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
set search_path = ''
as $$
declare
  v_device public.time_clock_devices%rowtype;
  v_employee public.employees%rowtype;
  v_credential public.employee_time_clock_credentials%rowtype;
  v_existing public.time_clock_events%rowtype;
  v_last_type public.time_clock_event_type;
  v_last_at timestamptz;
  v_work_date date;
  v_summary jsonb;
begin
  select * into v_device from public.time_clock_devices where id = p_device_id for update;
  if not found or v_device.device_secret_hash <> encode(extensions.digest(coalesce(p_device_secret, ''), 'sha256'), 'hex') then
    raise exception 'Time clock not authorized';
  end if;
  if v_device.deleted_at is not null or v_device.status <> 'active' then raise exception 'This time clock is no longer active'; end if;
  if v_device.locked_until is not null and v_device.locked_until > now() then return jsonb_build_object('error', 'Code incorrect ou indisponible'); end if;
  if p_offline_proof is not null or p_pin is null then return jsonb_build_object('error', 'Connexion requise pour pointer'); end if;
  if p_occurred_at is null or p_client_event_id is null or p_occurred_at < now() - interval '10 minutes' or p_occurred_at > now() + interval '10 minutes' then
    raise exception 'Invalid badge timestamp';
  end if;
  select * into v_existing from public.time_clock_events where device_id = p_device_id and client_event_id = p_client_event_id;
  if found then return jsonb_build_object('event_id', v_existing.id, 'duplicate', true, 'event_type', v_existing.event_type, 'occurred_at', v_existing.occurred_at); end if;
  select * into v_employee from public.employees where id = p_employee_id and organization_id = v_device.organization_id
    and establishment_id = v_device.establishment_id and employment_status = 'active';
  if not found then return jsonb_build_object('error', 'Code incorrect ou indisponible'); end if;
  select * into v_credential from public.employee_time_clock_credentials where employee_id = p_employee_id
    and organization_id = v_device.organization_id and active and pin_status = 'active';
  if not found or p_pin !~ '^[0-9]{6}$' or extensions.crypt(p_pin, v_credential.pin_hash) <> v_credential.pin_hash then
    update public.time_clock_devices set failed_attempts = least(failed_attempts + 1, 20),
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else locked_until end where id = v_device.id;
    return jsonb_build_object('error', 'Code incorrect ou indisponible');
  end if;
  select event_type, occurred_at into v_last_type, v_last_at from public.time_clock_events
  where organization_id = v_device.organization_id and employee_id = p_employee_id order by occurred_at desc, received_at desc limit 1;
  if v_last_at is not null and p_occurred_at < v_last_at then raise exception 'Badge timestamp is older than the latest badge'; end if;
  if (p_event_type = 'clock_in' and v_last_type is not null and v_last_type <> 'clock_out')
     or (p_event_type = 'break_start' and coalesce(v_last_type::text, '') not in ('clock_in','break_end'))
     or (p_event_type = 'break_end' and coalesce(v_last_type::text, '') <> 'break_start')
     or (p_event_type = 'clock_out' and coalesce(v_last_type::text, '') not in ('clock_in','break_end')) then
    raise exception 'This badge is not allowed for the current attendance state';
  end if;
  insert into public.time_clock_events(organization_id, establishment_id, employee_id, device_id, event_type, occurred_at, client_event_id, verification_mode, metadata)
  values(v_device.organization_id, v_device.establishment_id, p_employee_id, v_device.id, p_event_type, p_occurred_at, p_client_event_id,
    'online_pin', jsonb_build_object('source','tablet','timezone',v_device.timezone,'offline',false)) returning * into v_existing;
  update public.time_clock_devices set failed_attempts=0, locked_until=null, attempt_window_started_at=null, last_seen_at=now() where id=v_device.id;
  update public.employee_time_clock_credentials set last_used_at=now(), pin_failed_attempts=0, pin_locked_until=null where employee_id=p_employee_id;
  v_work_date := (p_occurred_at at time zone v_device.timezone)::date;
  v_summary := public.rebuild_time_clock_day_summary(v_device.organization_id, v_device.establishment_id, p_employee_id, v_work_date, v_device.timezone);
  insert into public.audit_logs(organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values(v_device.organization_id, v_device.establishment_id, null, 'time_clock.badge', 'time_clock_event', v_existing.id::text,
    jsonb_build_object('device_id',v_device.id,'employee_id',p_employee_id,'event_type',p_event_type,'verification_mode','online_pin','occurred_at',p_occurred_at));
  return jsonb_build_object('event_id',v_existing.id,'duplicate',false,'event_type',v_existing.event_type,'occurred_at',v_existing.occurred_at,'summary',v_summary);
end;
$$;

-- L'ancien enregistrement direct reste present uniquement pour la compatibilite
-- du catalogue PostgreSQL, mais n'est plus executable par un utilisateur.
revoke all on function public.register_time_clock_device(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.set_employee_time_clock_pin(uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.set_time_clock_device_status(uuid,public.time_clock_device_status) from public,anon,authenticated;

revoke all on function public.can_manage_clock_device(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.create_time_clock_activation_code(uuid,uuid,integer) from public,anon,authenticated;
revoke all on function public.activate_time_clock_device(text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.get_time_clock_device_cache(uuid,text) from public,anon,authenticated;
revoke all on function public.list_time_clock_devices(uuid) from public,anon,authenticated;
revoke all on function public.list_time_clock_employees(uuid,uuid) from public,anon,authenticated;
revoke all on function public.list_time_clock_device_history(uuid) from public,anon,authenticated;
revoke all on function public.update_time_clock_device(uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.set_time_clock_device_status(uuid,public.time_clock_device_status,text) from public,anon,authenticated;
revoke all on function public.delete_or_archive_time_clock_device(uuid) from public,anon,authenticated;
revoke all on function public.secure_six_digit_pin() from public,anon,authenticated;
revoke all on function public.generate_employee_time_clock_pin(uuid,uuid) from public,anon,authenticated;
revoke all on function public.create_employee_time_clock_pin_invitation(uuid,uuid) from public,anon,authenticated;
revoke all on function public.consume_employee_time_clock_pin_invitation(text,text) from public,anon,authenticated;
revoke all on function public.verify_time_clock_pin(uuid,text,text) from public,anon,authenticated;
revoke all on function public.time_clock_badge(uuid,text,uuid,public.time_clock_event_type,timestamptz,uuid,text,text) from public,anon,authenticated;

grant execute on function public.can_manage_clock_device(uuid,uuid,text) to authenticated;
grant execute on function public.create_time_clock_activation_code(uuid,uuid,integer) to authenticated;
grant execute on function public.activate_time_clock_device(text,text,text,text,text,text,text) to anon,authenticated;
grant execute on function public.get_time_clock_device_cache(uuid,text) to anon,authenticated;
grant execute on function public.list_time_clock_devices(uuid) to authenticated;
grant execute on function public.list_time_clock_employees(uuid,uuid) to authenticated;
grant execute on function public.list_time_clock_device_history(uuid) to authenticated;
grant execute on function public.update_time_clock_device(uuid,text,text,text) to authenticated;
grant execute on function public.set_time_clock_device_status(uuid,public.time_clock_device_status,text) to authenticated;
grant execute on function public.delete_or_archive_time_clock_device(uuid) to authenticated;
grant execute on function public.generate_employee_time_clock_pin(uuid,uuid) to authenticated;
grant execute on function public.create_employee_time_clock_pin_invitation(uuid,uuid) to authenticated;
grant execute on function public.consume_employee_time_clock_pin_invitation(text,text) to anon,authenticated;
grant execute on function public.verify_time_clock_pin(uuid,text,text) to anon,authenticated;
grant execute on function public.time_clock_badge(uuid,text,uuid,public.time_clock_event_type,timestamptz,uuid,text,text) to anon,authenticated;

comment on table public.time_clock_device_activation_codes is 'Codes d activation hashés, liés à un établissement, valables dix minutes et utilisables une seule fois.';
comment on table public.employee_time_clock_pin_invitations is 'Liens à usage unique permettant au salarié de définir son PIN sans le communiquer au responsable.';

commit;
