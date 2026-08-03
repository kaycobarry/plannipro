-- PlanniPro · Schéma Supabase sécurisé (Auth, RBAC, RLS, audit et synchronisation)
--
-- À exécuter une seule fois dans le SQL Editor d'un nouveau projet Supabase.
-- La clé service_role n'est jamais utilisée dans le navigateur. Les fonctions
-- Edge Functions l'utilisent uniquement côté serveur pour les invitations et
-- la révocation globale de sessions.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Types contrôlés
-- ---------------------------------------------------------------------------

do $$ begin
  create type public.member_status as enum ('invited', 'active', 'suspended', 'disabled', 'expired');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.permission_effect as enum ('grant', 'revoke');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.scope_type as enum ('organization', 'establishment', 'team', 'service', 'employee');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.invitation_status as enum ('sent', 'accepted', 'expired', 'cancelled');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Tables principales
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,80}$'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.establishments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  legacy_id text,
  name text not null check (char_length(trim(name)) between 2 and 120),
  code text,
  address text,
  city text,
  postal_code text,
  country_code text not null default 'FR' check (country_code ~ '^[A-Z]{2}$'),
  is_active boolean not null default true,
  data jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, legacy_id)
);

create table if not exists public.roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  label text not null check (char_length(trim(label)) between 2 and 80),
  rank smallint not null check (rank between 1 and 100),
  is_system boolean not null default false,
  is_read_only boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

create table if not exists public.permissions (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$'),
  module text not null,
  action text not null,
  label text not null,
  is_sensitive boolean not null default false,
  unique (module, action)
);

create table if not exists public.role_permissions (
  role_id uuid not null references public.roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_key)
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid references public.establishments(id) on delete set null,
  legacy_id text,
  employee_number text,
  first_name text not null default '',
  last_name text not null default '',
  display_name text generated always as (trim(first_name || ' ' || last_name)) stored,
  team_id text,
  service_id text,
  employment_status text not null default 'active' check (employment_status in ('active', 'archived', 'left')),
  public_data jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, legacy_id)
);

-- Données RH particulièrement sensibles, isolées de la table salariés pour
-- ne jamais être chargées par un manager non autorisé ni un salarié.
create table if not exists public.employee_private_data (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Espace réservé aux coordonnées modifiables par le salarié lui-même.
create table if not exists public.employee_self_service (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  phone text,
  personal_email text,
  address text,
  emergency_contact jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  status public.member_status not null default 'invited',
  primary_establishment_id uuid references public.establishments(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  invited_at timestamptz,
  activated_at timestamptz,
  suspended_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists public.user_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  effect public.permission_effect not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, permission_key)
);

-- Le périmètre est volontairement séparé des permissions : un manager peut
-- posséder planning.update, tout en étant limité à un seul établissement.
create table if not exists public.manager_scopes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid not null references public.organization_members(id) on delete cascade,
  scope_type public.scope_type not null,
  establishment_id uuid references public.establishments(id) on delete cascade,
  team_id text,
  service_id text,
  employee_id uuid references public.employees(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (
    (scope_type = 'organization' and establishment_id is null and team_id is null and service_id is null and employee_id is null)
    or (scope_type = 'establishment' and establishment_id is not null and team_id is null and service_id is null and employee_id is null)
    or (scope_type = 'team' and team_id is not null and service_id is null and employee_id is null)
    or (scope_type = 'service' and service_id is not null and team_id is null and employee_id is null)
    or (scope_type = 'employee' and employee_id is not null and establishment_id is null and team_id is null and service_id is null)
  )
);

create table if not exists public.business_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid references public.establishments(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  team_id text,
  service_id text,
  record_type text not null check (record_type in ('shift', 'absence', 'punch', 'timesheet', 'register', 'erp', 'setting', 'report', 'notification')),
  legacy_id text not null,
  payload jsonb not null default '{}'::jsonb,
  revision integer not null default 1 check (revision > 0),
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (organization_id, record_type, legacy_id)
);

-- Les fichiers RH sont privés dans le bucket Storage `plannipro-documents`.
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid references public.establishments(id) on delete set null,
  employee_id uuid references public.employees(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  content_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  category text not null default 'other',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (position('@' in email) > 1),
  role_id uuid not null references public.roles(id) on delete restrict,
  primary_establishment_id uuid references public.establishments(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  scopes jsonb not null default '[]'::jsonb,
  permission_overrides jsonb not null default '[]'::jsonb,
  token_hash text not null unique,
  status public.invitation_status not null default 'sent',
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid references public.establishments(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  old_value jsonb,
  new_value jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Index utiles aux règles RLS, au chargement par établissement et au sync.
-- ---------------------------------------------------------------------------

create index if not exists establishments_org_idx on public.establishments (organization_id);
create index if not exists roles_org_idx on public.roles (organization_id);
create index if not exists employees_org_establishment_idx on public.employees (organization_id, establishment_id);
create index if not exists employees_org_team_idx on public.employees (organization_id, team_id);
create index if not exists employee_private_data_org_idx on public.employee_private_data (organization_id);
create index if not exists organization_members_user_idx on public.organization_members (user_id, organization_id, status);
create index if not exists organization_members_org_role_idx on public.organization_members (organization_id, role_id, status);
create index if not exists user_permissions_user_idx on public.user_permissions (organization_id, user_id);
create index if not exists manager_scopes_member_idx on public.manager_scopes (member_id, organization_id);
create index if not exists business_records_sync_idx on public.business_records (organization_id, record_type, updated_at desc);
create index if not exists business_records_scope_idx on public.business_records (organization_id, establishment_id, employee_id);
create index if not exists documents_org_employee_idx on public.documents (organization_id, employee_id);
create index if not exists invitations_org_email_idx on public.invitations (organization_id, lower(email));
create index if not exists audit_logs_org_created_idx on public.audit_logs (organization_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Horodatage et protections d'intégrité
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.prevent_organization_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception 'organization_id is immutable';
  end if;
  return new;
end;
$$;

-- Les clés étrangères seules ne garantissent pas que les références appartiennent
-- à la même entreprise. Ce déclencheur ferme toute possibilité d'accès croisé.
create or replace function public.validate_organization_links()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_org_id uuid := nullif(v_row ->> 'organization_id', '')::uuid;
  v_establishment_id uuid := nullif(v_row ->> 'establishment_id', '')::uuid;
  v_employee_id uuid := nullif(v_row ->> 'employee_id', '')::uuid;
  v_role_id uuid := nullif(v_row ->> 'role_id', '')::uuid;
  v_member_id uuid := nullif(v_row ->> 'member_id', '')::uuid;
  v_user_id uuid := nullif(v_row ->> 'user_id', '')::uuid;
begin
  if v_org_id is null then return new; end if;
  if v_establishment_id is not null and not exists (select 1 from public.establishments where id = v_establishment_id and organization_id = v_org_id) then
    raise exception 'establishment must belong to organization';
  end if;
  if v_employee_id is not null and not exists (select 1 from public.employees where id = v_employee_id and organization_id = v_org_id) then
    raise exception 'employee must belong to organization';
  end if;
  if v_role_id is not null and not exists (select 1 from public.roles where id = v_role_id and organization_id = v_org_id) then
    raise exception 'role must belong to organization';
  end if;
  if tg_table_name = 'organization_members' and exists (select 1 from public.roles where id = v_role_id and key = 'employee') and v_employee_id is null then
    raise exception 'an employee membership must be linked to an employee record';
  end if;
  if v_member_id is not null and not exists (select 1 from public.organization_members where id = v_member_id and organization_id = v_org_id) then
    raise exception 'member must belong to organization';
  end if;
  if tg_table_name = 'user_permissions' and v_user_id is not null and not exists (select 1 from public.organization_members where organization_id = v_org_id and user_id = v_user_id) then
    raise exception 'user must belong to organization before permissions are assigned';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at before update on public.organizations for each row execute function public.set_updated_at();
drop trigger if exists establishments_set_updated_at on public.establishments;
create trigger establishments_set_updated_at before update on public.establishments for each row execute function public.set_updated_at();
drop trigger if exists roles_set_updated_at on public.roles;
create trigger roles_set_updated_at before update on public.roles for each row execute function public.set_updated_at();
drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at before update on public.employees for each row execute function public.set_updated_at();
drop trigger if exists employee_private_data_set_updated_at on public.employee_private_data;
create trigger employee_private_data_set_updated_at before update on public.employee_private_data for each row execute function public.set_updated_at();
drop trigger if exists employee_self_service_set_updated_at on public.employee_self_service;
create trigger employee_self_service_set_updated_at before update on public.employee_self_service for each row execute function public.set_updated_at();
drop trigger if exists organization_members_set_updated_at on public.organization_members;
create trigger organization_members_set_updated_at before update on public.organization_members for each row execute function public.set_updated_at();
drop trigger if exists documents_set_updated_at on public.documents;
create trigger documents_set_updated_at before update on public.documents for each row execute function public.set_updated_at();
drop trigger if exists invitations_set_updated_at on public.invitations;
create trigger invitations_set_updated_at before update on public.invitations for each row execute function public.set_updated_at();

drop trigger if exists establishments_prevent_org_change on public.establishments;
create trigger establishments_prevent_org_change before update on public.establishments for each row execute function public.prevent_organization_change();
drop trigger if exists roles_prevent_org_change on public.roles;
create trigger roles_prevent_org_change before update on public.roles for each row execute function public.prevent_organization_change();

-- Les identifiants et rangs des rôles système font partie des garanties RLS.
-- Un rôle owner/manager/employee ne peut donc pas être transformé en rôle
-- personnalisé pour contourner la protection du dernier gérant.
create or replace function public.protect_system_role()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' and old.is_system then
    raise exception 'System roles cannot be deleted';
  end if;
  if tg_op = 'UPDATE' and old.is_system and (
    new.key is distinct from old.key
    or new.rank is distinct from old.rank
    or new.is_system is distinct from old.is_system
  ) then
    raise exception 'System role key, rank and system status are immutable';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists roles_protect_system on public.roles;
create trigger roles_protect_system before update or delete on public.roles for each row execute function public.protect_system_role();

drop trigger if exists employees_prevent_org_change on public.employees;
create trigger employees_prevent_org_change before update on public.employees for each row execute function public.prevent_organization_change();
drop trigger if exists employee_private_data_prevent_org_change on public.employee_private_data;
create trigger employee_private_data_prevent_org_change before update on public.employee_private_data for each row execute function public.prevent_organization_change();
drop trigger if exists organization_members_prevent_org_change on public.organization_members;
create trigger organization_members_prevent_org_change before update on public.organization_members for each row execute function public.prevent_organization_change();
drop trigger if exists business_records_prevent_org_change on public.business_records;
create trigger business_records_prevent_org_change before update on public.business_records for each row execute function public.prevent_organization_change();
drop trigger if exists documents_prevent_org_change on public.documents;
create trigger documents_prevent_org_change before update on public.documents for each row execute function public.prevent_organization_change();
drop trigger if exists invitations_prevent_org_change on public.invitations;
create trigger invitations_prevent_org_change before update on public.invitations for each row execute function public.prevent_organization_change();
drop trigger if exists employee_self_service_prevent_org_change on public.employee_self_service;
create trigger employee_self_service_prevent_org_change before update on public.employee_self_service for each row execute function public.prevent_organization_change();
drop trigger if exists user_permissions_prevent_org_change on public.user_permissions;
create trigger user_permissions_prevent_org_change before update on public.user_permissions for each row execute function public.prevent_organization_change();
drop trigger if exists manager_scopes_prevent_org_change on public.manager_scopes;
create trigger manager_scopes_prevent_org_change before update on public.manager_scopes for each row execute function public.prevent_organization_change();

drop trigger if exists employees_validate_org_links on public.employees;
create trigger employees_validate_org_links before insert or update on public.employees for each row execute function public.validate_organization_links();
drop trigger if exists employee_private_data_validate_org_links on public.employee_private_data;
create trigger employee_private_data_validate_org_links before insert or update on public.employee_private_data for each row execute function public.validate_organization_links();
drop trigger if exists employee_self_service_validate_org_links on public.employee_self_service;
create trigger employee_self_service_validate_org_links before insert or update on public.employee_self_service for each row execute function public.validate_organization_links();
drop trigger if exists organization_members_validate_org_links on public.organization_members;
create trigger organization_members_validate_org_links before insert or update on public.organization_members for each row execute function public.validate_organization_links();
drop trigger if exists user_permissions_validate_org_links on public.user_permissions;
create trigger user_permissions_validate_org_links before insert or update on public.user_permissions for each row execute function public.validate_organization_links();
drop trigger if exists manager_scopes_validate_org_links on public.manager_scopes;
create trigger manager_scopes_validate_org_links before insert or update on public.manager_scopes for each row execute function public.validate_organization_links();
drop trigger if exists business_records_validate_org_links on public.business_records;
create trigger business_records_validate_org_links before insert or update on public.business_records for each row execute function public.validate_organization_links();
drop trigger if exists documents_validate_org_links on public.documents;
create trigger documents_validate_org_links before insert or update on public.documents for each row execute function public.validate_organization_links();
drop trigger if exists invitations_validate_org_links on public.invitations;
create trigger invitations_validate_org_links before insert or update on public.invitations for each row execute function public.validate_organization_links();

create or replace function public.bump_record_revision()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.revision = old.revision + 1;
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists business_records_bump_revision on public.business_records;
create trigger business_records_bump_revision before update on public.business_records for each row execute function public.bump_record_revision();

-- Aucun client ne peut attribuer un faux auteur à une ligne synchronisée.
create or replace function public.stamp_actor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by = auth.uid();
    end if;
    new.updated_by = auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists establishments_stamp_actor on public.establishments;
create trigger establishments_stamp_actor before insert or update on public.establishments for each row execute function public.stamp_actor();
drop trigger if exists employees_stamp_actor on public.employees;
create trigger employees_stamp_actor before insert or update on public.employees for each row execute function public.stamp_actor();
drop trigger if exists employee_private_data_stamp_actor on public.employee_private_data;
create trigger employee_private_data_stamp_actor before insert or update on public.employee_private_data for each row execute function public.stamp_actor();
drop trigger if exists business_records_stamp_actor on public.business_records;
create trigger business_records_stamp_actor before insert or update on public.business_records for each row execute function public.stamp_actor();
drop trigger if exists documents_stamp_actor on public.documents;
create trigger documents_stamp_actor before insert or update on public.documents for each row execute function public.stamp_actor();

-- Il doit toujours rester au moins un gérant actif dans une organisation.
create or replace function public.protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_was_owner boolean;
  v_stays_owner boolean;
begin
  if tg_op = 'DELETE' then v_org_id := old.organization_id; else v_org_id := new.organization_id; end if;
  if tg_op = 'INSERT' then
    return new;
  end if;

  select exists (
    select 1 from public.roles r
    where r.id = old.role_id and r.organization_id = v_org_id and r.key = 'owner'
  ) into v_was_owner;

  if not v_was_owner then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'UPDATE' then
    select exists (
      select 1 from public.roles r
      where r.id = new.role_id and r.organization_id = v_org_id and r.key = 'owner'
    ) and new.status = 'active' into v_stays_owner;
    if v_stays_owner then
      return new;
    end if;
  end if;

  if not exists (
    select 1
    from public.organization_members om
    join public.roles r on r.id = om.role_id
    where om.organization_id = v_org_id
      and om.id <> old.id
      and om.status = 'active'
      and r.key = 'owner'
  ) then
    raise exception 'An organization must keep at least one active owner';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists organization_members_protect_last_owner on public.organization_members;
create trigger organization_members_protect_last_owner
  before update or delete on public.organization_members
  for each row execute function public.protect_last_owner();

-- Création automatique du profil à chaque inscription Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name),
        avatar_url = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Catalogue de permissions et rôles par défaut
-- ---------------------------------------------------------------------------

insert into public.permissions (key, module, action, label, is_sensitive)
select
  modules.module || '.' || actions.action,
  modules.module,
  actions.action,
  modules.label || ' · ' || actions.label,
  modules.is_sensitive
from (
  values
    ('dashboard', 'Tableau de bord', false),
    ('planning', 'Planning', false),
    ('team', 'Équipe', false),
    ('employees', 'Salariés', false),
    ('pointage', 'Pointage', false),
    ('timesheets', 'Feuilles de temps', false),
    ('leaves', 'Congés et absences', false),
    ('register', 'Registre du personnel', true),
    ('documents', 'Documents', true),
    ('reports', 'Rapports mensuels', false),
    ('exports', 'Exports', true),
    ('settings', 'Paramètres', true),
    ('users', 'Utilisateurs et droits', true),
    ('establishments', 'Établissements', false),
    ('financial', 'Données financières ou salariales', true),
    ('audit', 'Journal d''activité', true)
) as modules(module, label, is_sensitive)
cross join (
  values
    ('view', 'Voir'),
    ('create', 'Créer'),
    ('update', 'Modifier'),
    ('delete', 'Supprimer'),
    ('validate', 'Valider'),
    ('refuse', 'Refuser'),
    ('export', 'Exporter'),
    ('print', 'Imprimer'),
    ('manage_settings', 'Gérer les paramètres'),
    ('manage_users', 'Gérer les comptes utilisateurs')
) as actions(action, label)
on conflict (key) do update
  set module = excluded.module,
      action = excluded.action,
      label = excluded.label,
      is_sensitive = excluded.is_sensitive;

-- Permissions additionnelles pour isoler contrat, paie et pièces RH du simple
-- droit de consulter une fiche salarié.
insert into public.permissions (key, module, action, label, is_sensitive)
values
  ('employees.view_sensitive', 'employees', 'view_sensitive', 'Salariés · Voir les données sensibles', true),
  ('employees.create_sensitive', 'employees', 'create_sensitive', 'Salariés · Créer les données sensibles', true),
  ('employees.update_sensitive', 'employees', 'update_sensitive', 'Salariés · Modifier les données sensibles', true),
  ('employees.delete_sensitive', 'employees', 'delete_sensitive', 'Salariés · Supprimer les données sensibles', true)
on conflict (key) do update
  set module = excluded.module,
      action = excluded.action,
      label = excluded.label,
      is_sensitive = excluded.is_sensitive;

create or replace function public.seed_organization_roles(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  owner_role_id uuid;
  manager_role_id uuid;
  employee_role_id uuid;
begin
  insert into public.roles (organization_id, key, label, rank, is_system, is_read_only)
  values
    (p_organization_id, 'owner', 'Gérant / Super administrateur', 100, true, false),
    (p_organization_id, 'manager', 'Manager', 60, true, false),
    (p_organization_id, 'employee', 'Salarié', 10, true, false),
    (p_organization_id, 'readonly', 'Lecture seule', 20, true, true)
  on conflict (organization_id, key) do nothing;

  select id into owner_role_id from public.roles where organization_id = p_organization_id and key = 'owner';
  select id into manager_role_id from public.roles where organization_id = p_organization_id and key = 'manager';
  select id into employee_role_id from public.roles where organization_id = p_organization_id and key = 'employee';

  -- Le gérant est traité comme omnipotent par has_permission(), mais conserver
  -- les lignes rend la matrice lisible dans l'interface et les exports SQL.
  insert into public.role_permissions (role_id, permission_key)
  select owner_role_id, key from public.permissions
  on conflict do nothing;

  insert into public.role_permissions (role_id, permission_key)
  select manager_role_id, key
  from public.permissions
  where key = any (array[
    'dashboard.view',
    'planning.view', 'planning.create', 'planning.update', 'planning.validate', 'planning.print',
    'team.view',
    'employees.view',
    'pointage.view', 'pointage.create', 'pointage.update', 'pointage.validate',
    'timesheets.view',
    'leaves.view', 'leaves.create', 'leaves.update', 'leaves.validate', 'leaves.refuse',
    'reports.view',
    'establishments.view'
  ])
  on conflict do nothing;

  insert into public.role_permissions (role_id, permission_key)
  select employee_role_id, key
  from public.permissions
  where key = any (array[
    'dashboard.view',
    'planning.view',
    'employees.view',
    'establishments.view',
    'pointage.view', 'pointage.create', 'pointage.update',
    'timesheets.view',
    'leaves.view', 'leaves.create',
    'documents.view'
  ])
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fonctions d'autorisation : elles s'exécutent côté base, pas dans le client.
-- ---------------------------------------------------------------------------

create or replace function public.is_active_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    where om.organization_id = p_organization_id
      and om.user_id = auth.uid()
      and om.status = 'active'
  );
$$;

create or replace function public.current_member_id(p_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select om.id
  from public.organization_members om
  where om.organization_id = p_organization_id
    and om.user_id = auth.uid()
    and om.status = 'active'
  limit 1;
$$;

create or replace function public.current_employee_id(p_organization_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select om.employee_id
  from public.organization_members om
  where om.organization_id = p_organization_id
    and om.user_id = auth.uid()
    and om.status = 'active'
  limit 1;
$$;

create or replace function public.current_role_rank(p_organization_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select r.rank
  from public.organization_members om
  join public.roles r on r.id = om.role_id
  where om.organization_id = p_organization_id
    and om.user_id = auth.uid()
    and om.status = 'active'
  limit 1;
$$;

create or replace function public.is_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.roles r on r.id = om.role_id
    where om.organization_id = p_organization_id
      and om.user_id = auth.uid()
      and om.status = 'active'
      and r.key = 'owner'
  );
$$;

create or replace function public.has_permission(p_organization_id uuid, p_permission_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role_id uuid;
begin
  if not public.is_active_member(p_organization_id) then
    return false;
  end if;

  if public.is_owner(p_organization_id) then
    return true;
  end if;

  -- Une révocation individuelle l'emporte toujours sur le rôle.
  if exists (
    select 1 from public.user_permissions up
    where up.organization_id = p_organization_id
      and up.user_id = auth.uid()
      and up.permission_key = p_permission_key
      and up.effect = 'revoke'
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.user_permissions up
    where up.organization_id = p_organization_id
      and up.user_id = auth.uid()
      and up.permission_key = p_permission_key
      and up.effect = 'grant'
  ) then
    return true;
  end if;

  select om.role_id into v_role_id
  from public.organization_members om
  where om.organization_id = p_organization_id
    and om.user_id = auth.uid()
    and om.status = 'active'
  limit 1;

  return exists (
    select 1 from public.role_permissions rp
    where rp.role_id = v_role_id
      and rp.permission_key = p_permission_key
  );
end;
$$;

create or replace function public.member_in_scope(
  p_organization_id uuid,
  p_establishment_id uuid default null,
  p_employee_id uuid default null,
  p_team_id text default null,
  p_service_id text default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member_id uuid;
  v_employee_id uuid;
  v_role_key text;
begin
  if public.is_owner(p_organization_id) then
    return true;
  end if;

  select om.id, om.employee_id, r.key into v_member_id, v_employee_id, v_role_key
  from public.organization_members om
  join public.roles r on r.id = om.role_id
  where om.organization_id = p_organization_id
    and om.user_id = auth.uid()
    and om.status = 'active'
  limit 1;

  if v_member_id is null then
    return false;
  end if;

  -- Un salarié n'accède jamais aux lignes d'un autre salarié.
  if v_role_key = 'employee' then
    return p_employee_id is not null and p_employee_id = v_employee_id;
  end if;

  return exists (
    select 1
    from public.manager_scopes ms
    where ms.organization_id = p_organization_id
      and ms.member_id = v_member_id
      and (
        ms.scope_type = 'organization'
        or (ms.scope_type = 'establishment' and ms.establishment_id = p_establishment_id)
        or (ms.scope_type = 'team' and ms.team_id = p_team_id and (ms.establishment_id is null or ms.establishment_id = p_establishment_id))
        or (ms.scope_type = 'service' and ms.service_id = p_service_id and (ms.establishment_id is null or ms.establishment_id = p_establishment_id))
        or (ms.scope_type = 'employee' and ms.employee_id = p_employee_id)
      )
  );
end;
$$;

create or replace function public.can_access_establishment(p_organization_id uuid, p_establishment_id uuid, p_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_primary_establishment uuid;
begin
  if not public.has_permission(p_organization_id, 'establishments.' || p_action) then
    return false;
  end if;
  if public.is_owner(p_organization_id) then
    return true;
  end if;
  select primary_establishment_id into v_primary_establishment
  from public.organization_members
  where organization_id = p_organization_id and user_id = auth.uid() and status = 'active'
  limit 1;
  return v_primary_establishment = p_establishment_id
     or public.member_in_scope(p_organization_id, p_establishment_id, null, null, null);
end;
$$;

create or replace function public.can_access_employee(p_organization_id uuid, p_establishment_id uuid, p_employee_id uuid, p_team_id text, p_service_id text, p_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_member(p_organization_id) then
    return false;
  end if;
  if public.current_employee_id(p_organization_id) = p_employee_id then
    return p_action = 'view' and public.has_permission(p_organization_id, 'employees.view');
  end if;
  return public.has_permission(p_organization_id, 'employees.' || p_action)
     and public.member_in_scope(p_organization_id, p_establishment_id, p_employee_id, p_team_id, p_service_id);
end;
$$;

create or replace function public.record_module(p_record_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_record_type
    when 'shift' then 'planning'
    when 'absence' then 'leaves'
    when 'punch' then 'pointage'
    when 'timesheet' then 'timesheets'
    when 'register' then 'register'
    when 'erp' then 'financial'
    when 'setting' then 'settings'
    when 'report' then 'reports'
    when 'notification' then 'dashboard'
    else 'settings'
  end;
$$;

create or replace function public.can_access_record(
  p_organization_id uuid,
  p_record_type text,
  p_establishment_id uuid,
  p_employee_id uuid,
  p_team_id text,
  p_service_id text,
  p_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_module text;
begin
  v_module := public.record_module(p_record_type);
  if not public.has_permission(p_organization_id, v_module || '.' || p_action) then
    return false;
  end if;
  if public.is_owner(p_organization_id) then
    return true;
  end if;
  -- Paramètres, ERP et rapports ne peuvent pas être lus par défaut par un
  -- salarié : l'absence d'employee_id doit correspondre à un périmètre manager.
  return public.member_in_scope(p_organization_id, p_establishment_id, p_employee_id, p_team_id, p_service_id);
end;
$$;

create or replace function public.can_assign_role(p_organization_id uuid, p_target_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.roles target
    where target.id = p_target_role_id
      and target.organization_id = p_organization_id
      and (
        public.is_owner(p_organization_id)
        or (
          public.has_permission(p_organization_id, 'users.manage_users')
          and coalesce(public.current_role_rank(p_organization_id), 0) > target.rank
        )
      )
  );
$$;

-- Vérifie un périmètre cible sans accorder, à lui seul, aucun droit.  Les
-- fonctions appelantes ajoutent ensuite users.view ou users.manage_users.
create or replace function public.target_in_scope(
  p_organization_id uuid,
  p_primary_establishment_id uuid default null,
  p_employee_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_employee public.employees%rowtype;
begin
  if not public.is_active_member(p_organization_id) then return false; end if;
  if public.is_owner(p_organization_id) then return true; end if;
  if p_employee_id is not null then
    select * into v_employee
    from public.employees
    where id = p_employee_id and organization_id = p_organization_id;
    if not found then return false; end if;
    return public.member_in_scope(p_organization_id, v_employee.establishment_id, v_employee.id, v_employee.team_id, v_employee.service_id);
  end if;
  if p_primary_establishment_id is null then return false; end if;
  return public.member_in_scope(p_organization_id, p_primary_establishment_id, null, null, null);
end;
$$;

create or replace function public.can_manage_target_scope(
  p_organization_id uuid,
  p_primary_establishment_id uuid default null,
  p_employee_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission(p_organization_id, 'users.manage_users')
     and public.target_in_scope(p_organization_id, p_primary_establishment_id, p_employee_id);
$$;

create or replace function public.can_assign_permission(p_organization_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.permissions where key = p_permission_key)
     and (public.is_owner(p_organization_id) or public.has_permission(p_organization_id, p_permission_key));
$$;

create or replace function public.can_grant_scope(
  p_organization_id uuid,
  p_scope_type public.scope_type,
  p_establishment_id uuid default null,
  p_team_id text default null,
  p_service_id text default null,
  p_employee_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.is_owner(p_organization_id) then return true; end if;
  if not public.has_permission(p_organization_id, 'users.manage_users') then return false; end if;
  if p_scope_type = 'organization' then return false; end if;
  if p_scope_type = 'employee' then
    return public.target_in_scope(p_organization_id, null, p_employee_id);
  end if;
  return public.member_in_scope(p_organization_id, p_establishment_id, null, p_team_id, p_service_id);
end;
$$;

create or replace function public.valid_scope_payload(p_organization_id uuid, p_scopes jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scope jsonb;
  v_type public.scope_type;
  v_establishment_id uuid;
  v_employee_id uuid;
begin
  if jsonb_typeof(coalesce(p_scopes, '[]'::jsonb)) <> 'array' then return false; end if;
  for v_scope in select value from jsonb_array_elements(coalesce(p_scopes, '[]'::jsonb)) loop
    begin
      v_type := (v_scope ->> 'scope_type')::public.scope_type;
      v_establishment_id := nullif(v_scope ->> 'establishment_id', '')::uuid;
      v_employee_id := nullif(v_scope ->> 'employee_id', '')::uuid;
    exception when others then
      return false;
    end;
    if (v_type = 'organization' and (v_establishment_id is not null or nullif(v_scope ->> 'team_id', '') is not null or nullif(v_scope ->> 'service_id', '') is not null or v_employee_id is not null))
       or (v_type = 'establishment' and (v_establishment_id is null or nullif(v_scope ->> 'team_id', '') is not null or nullif(v_scope ->> 'service_id', '') is not null or v_employee_id is not null))
       or (v_type = 'team' and (nullif(v_scope ->> 'team_id', '') is null or nullif(v_scope ->> 'service_id', '') is not null or v_employee_id is not null))
       or (v_type = 'service' and (nullif(v_scope ->> 'service_id', '') is null or nullif(v_scope ->> 'team_id', '') is not null or v_employee_id is not null))
       or (v_type = 'employee' and (v_employee_id is null or v_establishment_id is not null or nullif(v_scope ->> 'team_id', '') is not null or nullif(v_scope ->> 'service_id', '') is not null)) then
      return false;
    end if;
    if not public.can_grant_scope(
      p_organization_id,
      v_type,
      v_establishment_id,
      nullif(v_scope ->> 'team_id', ''),
      nullif(v_scope ->> 'service_id', ''),
      v_employee_id
    ) then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function public.valid_permission_overrides(p_organization_id uuid, p_overrides jsonb)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_override jsonb;
  v_effect text;
  v_permission_key text;
begin
  if jsonb_typeof(coalesce(p_overrides, '[]'::jsonb)) <> 'array' then return false; end if;
  for v_override in select value from jsonb_array_elements(coalesce(p_overrides, '[]'::jsonb)) loop
    v_permission_key := nullif(v_override ->> 'permission_key', '');
    v_effect := nullif(v_override ->> 'effect', '');
    if v_permission_key is null or v_effect not in ('grant', 'revoke')
       or not public.can_assign_permission(p_organization_id, v_permission_key) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Initialisation sécurisée et invitations
-- ---------------------------------------------------------------------------

create or replace function public.bootstrap_organization(p_name text, p_establishment_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_establishment_id uuid;
  v_owner_role_id uuid;
  v_slug_base text;
  v_slug text;
  v_counter integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if exists (select 1 from public.organization_members where user_id = auth.uid()) then
    raise exception 'This account already belongs to an organization';
  end if;
  if char_length(trim(p_name)) < 2 or char_length(trim(p_establishment_name)) < 2 then
    raise exception 'Organization and establishment names are required';
  end if;

  insert into public.profiles (id, email)
  values (auth.uid(), lower(coalesce(auth.jwt() ->> 'email', '')))
  on conflict (id) do nothing;

  v_slug_base := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
  if v_slug_base = '' then v_slug_base := 'plannipro'; end if;
  v_slug := left(v_slug_base, 72);
  while exists (select 1 from public.organizations where slug = v_slug) loop
    v_counter := v_counter + 1;
    v_slug := left(v_slug_base, 68) || '-' || v_counter::text;
  end loop;

  insert into public.organizations (name, slug, created_by)
  values (trim(p_name), v_slug, auth.uid())
  returning id into v_org_id;

  perform public.seed_organization_roles(v_org_id);
  select id into v_owner_role_id from public.roles where organization_id = v_org_id and key = 'owner';

  insert into public.establishments (organization_id, name, created_by, updated_by)
  values (v_org_id, trim(p_establishment_name), auth.uid(), auth.uid())
  returning id into v_establishment_id;

  insert into public.organization_members (
    organization_id, user_id, role_id, status, primary_establishment_id, invited_at, activated_at
  ) values (
    v_org_id, auth.uid(), v_owner_role_id, 'active', v_establishment_id, now(), now()
  );

  return jsonb_build_object('organization_id', v_org_id, 'establishment_id', v_establishment_id, 'role', 'owner');
end;
$$;

create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email text,
  p_role_id uuid,
  p_primary_establishment_id uuid default null,
  p_employee_id uuid default null,
  p_scopes jsonb default '[]'::jsonb,
  p_permission_overrides jsonb default '[]'::jsonb,
  p_expires_at timestamptz default (now() + interval '7 days')
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_token text;
  v_invitation_id uuid;
begin
  v_org_id := p_organization_id;

  if v_org_id is null or not public.has_permission(v_org_id, 'users.manage_users') then
    raise exception 'Not authorized to invite users';
  end if;
  if not public.can_assign_role(v_org_id, p_role_id) then
    raise exception 'Cannot assign this role';
  end if;
  if exists (select 1 from public.roles where id = p_role_id and key = 'employee') then
    if p_employee_id is null then
      raise exception 'An employee invitation must be linked to an employee record';
    end if;
    if p_primary_establishment_id is null then
      select establishment_id into p_primary_establishment_id
      from public.employees
      where id = p_employee_id and organization_id = v_org_id;
    end if;
  end if;
  if not public.can_manage_target_scope(v_org_id, p_primary_establishment_id, p_employee_id) then
    raise exception 'The target user is outside your permitted scope';
  end if;
  if not public.valid_scope_payload(v_org_id, p_scopes) then
    raise exception 'One or more requested scopes exceed your permissions';
  end if;
  if not public.valid_permission_overrides(v_org_id, p_permission_overrides) then
    raise exception 'One or more requested permissions exceed your permissions';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '90 days' then
    raise exception 'Invitation expiry must be between now and 90 days';
  end if;
  if exists (select 1 from public.organization_members om join public.profiles p on p.id = om.user_id where om.organization_id = v_org_id and lower(p.email) = lower(trim(p_email))) then
    raise exception 'This email already belongs to the organization';
  end if;

  update public.invitations
  set status = 'cancelled'
  where organization_id = v_org_id and lower(email) = lower(trim(p_email)) and status = 'sent';

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.invitations (
    organization_id, email, role_id, primary_establishment_id, employee_id,
    scopes, permission_overrides, token_hash, expires_at, created_by
  ) values (
    v_org_id, lower(trim(p_email)), p_role_id, p_primary_establishment_id, p_employee_id,
    coalesce(p_scopes, '[]'::jsonb), coalesce(p_permission_overrides, '[]'::jsonb),
    encode(extensions.digest(v_token, 'sha256'), 'hex'), p_expires_at, auth.uid()
  ) returning id into v_invitation_id;

  return jsonb_build_object('invitation_id', v_invitation_id, 'token', v_token, 'organization_id', v_org_id, 'expires_at', p_expires_at);
end;
$$;

create or replace function public.claim_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invitations%rowtype;
  v_member_id uuid;
  v_scope jsonb;
  v_permission jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_inv
  from public.invitations
  where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and status = 'sent'
  for update;

  if not found then
    raise exception 'Invitation not found or already used';
  end if;
  if v_inv.expires_at <= now() then
    update public.invitations set status = 'expired' where id = v_inv.id;
    raise exception 'Invitation expired';
  end if;
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> lower(v_inv.email) then
    raise exception 'This invitation was issued for another email address';
  end if;
  if exists (select 1 from public.roles where id = v_inv.role_id and key = 'employee') and v_inv.employee_id is null then
    raise exception 'An employee invitation must be linked to an employee record';
  end if;

  insert into public.profiles (id, email)
  values (auth.uid(), lower(v_inv.email))
  on conflict (id) do nothing;

  insert into public.organization_members (
    organization_id, user_id, role_id, status, primary_establishment_id, employee_id, invited_at, activated_at
  ) values (
    v_inv.organization_id, auth.uid(), v_inv.role_id, 'active', v_inv.primary_establishment_id, v_inv.employee_id, now(), now()
  )
  on conflict (organization_id, user_id) do update
    set role_id = excluded.role_id,
        status = 'active',
        primary_establishment_id = excluded.primary_establishment_id,
        employee_id = excluded.employee_id,
        activated_at = now()
  returning id into v_member_id;

  for v_scope in select value from jsonb_array_elements(coalesce(v_inv.scopes, '[]'::jsonb)) loop
    insert into public.manager_scopes (organization_id, member_id, scope_type, establishment_id, team_id, service_id, employee_id, created_by)
    values (
      v_inv.organization_id,
      v_member_id,
      (v_scope ->> 'scope_type')::public.scope_type,
      nullif(v_scope ->> 'establishment_id', '')::uuid,
      nullif(v_scope ->> 'team_id', ''),
      nullif(v_scope ->> 'service_id', ''),
      nullif(v_scope ->> 'employee_id', '')::uuid,
      v_inv.created_by
    ) on conflict do nothing;
  end loop;

  for v_permission in select value from jsonb_array_elements(coalesce(v_inv.permission_overrides, '[]'::jsonb)) loop
    insert into public.user_permissions (organization_id, user_id, permission_key, effect, created_by)
    values (
      v_inv.organization_id,
      auth.uid(),
      v_permission ->> 'permission_key',
      coalesce((v_permission ->> 'effect')::public.permission_effect, 'grant'),
      v_inv.created_by
    ) on conflict (organization_id, user_id, permission_key) do update set effect = excluded.effect, created_by = excluded.created_by;
  end loop;

  update public.invitations set status = 'accepted', accepted_at = now() where id = v_inv.id;

  insert into public.audit_logs (organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_inv.organization_id, v_inv.primary_establishment_id, auth.uid(), 'invitation.accepted', 'invitation', v_inv.id::text, jsonb_build_object('email', v_inv.email));

  return jsonb_build_object('organization_id', v_inv.organization_id, 'member_id', v_member_id, 'role_id', v_inv.role_id);
end;
$$;

create or replace function public.touch_member_session()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.organization_members%rowtype;
begin
  for v_member in
    update public.organization_members
    set last_seen_at = now()
    where user_id = auth.uid() and status = 'active'
    returning *
  loop
    insert into public.audit_logs (organization_id, establishment_id, actor_user_id, action, resource_type, resource_id)
    values (v_member.organization_id, v_member.primary_establishment_id, auth.uid(), 'auth.login', 'organization_member', v_member.id::text);
  end loop;
end;
$$;

create or replace function public.get_access_context()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id', om.organization_id,
    'organization_name', o.name,
    'member_id', om.id,
    'status', om.status,
    'role_id', r.id,
    'role_key', r.key,
    'role_label', r.label,
    'role_rank', r.rank,
    'is_read_only', r.is_read_only,
    'primary_establishment_id', om.primary_establishment_id,
    'employee_id', om.employee_id,
    'permissions', coalesce((
      select jsonb_agg(jsonb_build_object('key', p.key, 'allowed', public.has_permission(om.organization_id, p.key)))
      from public.permissions p
    ), '[]'::jsonb),
    'scopes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'scope_type', ms.scope_type,
        'establishment_id', ms.establishment_id,
        'team_id', ms.team_id,
        'service_id', ms.service_id,
        'employee_id', ms.employee_id
      )) from public.manager_scopes ms where ms.member_id = om.id
    ), '[]'::jsonb)
  )), '[]'::jsonb)
  from public.organization_members om
  join public.organizations o on o.id = om.organization_id
  join public.roles r on r.id = om.role_id
  where om.user_id = auth.uid()
    and om.status = 'active';
$$;

create or replace function public.log_audit_event(
  p_organization_id uuid,
  p_action text,
  p_resource_type text,
  p_resource_id text default null,
  p_establishment_id uuid default null,
  p_old_value jsonb default null,
  p_new_value jsonb default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_module text := split_part(p_action, '.', 1);
begin
  if not public.is_active_member(p_organization_id) then
    raise exception 'Not authorized';
  end if;
  if p_action like '%.export%' and not public.has_permission(p_organization_id, v_module || '.export') then
    raise exception 'Not authorized to export';
  elsif p_action like '%.print%' and not public.has_permission(p_organization_id, v_module || '.print') then
    raise exception 'Not authorized to print';
  elsif p_action like 'invitation.%' and not public.has_permission(p_organization_id, 'users.manage_users') then
    raise exception 'Not authorized to manage invitations';
  elsif p_action not like '%.export%' and p_action not like '%.print%' and p_action not like 'invitation.%' then
    raise exception 'Unsupported client audit action';
  end if;
  insert into public.audit_logs (
    organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, old_value, new_value, metadata
  ) values (
    p_organization_id, p_establishment_id, auth.uid(), left(p_action, 120), left(p_resource_type, 80), left(p_resource_id, 160),
    p_old_value, p_new_value, coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- Fonctions d'accès aux données RH privées, aux documents et aux membres.
create or replace function public.can_access_private_employee_data(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_employee_id uuid,
  p_team_id text default null,
  p_service_id text default null,
  p_action text default 'view'
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission(p_organization_id, 'employees.' || p_action || '_sensitive')
     and public.member_in_scope(p_organization_id, p_establishment_id, p_employee_id, p_team_id, p_service_id);
$$;

create or replace function public.can_access_document(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_employee_id uuid,
  p_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_active_member(p_organization_id) then
    return false;
  end if;
  if p_employee_id is not null and public.current_employee_id(p_organization_id) = p_employee_id then
    return p_action = 'view' and public.has_permission(p_organization_id, 'documents.view');
  end if;
  return public.has_permission(p_organization_id, 'documents.' || p_action)
    and public.member_in_scope(p_organization_id, p_establishment_id, p_employee_id, null, null);
end;
$$;

create or replace function public.can_manage_user(p_organization_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_target_rank integer;
  v_primary_establishment_id uuid;
  v_employee_id uuid;
begin
  if public.is_owner(p_organization_id) then return true; end if;
  if p_user_id is null or p_user_id = auth.uid()
     or not public.has_permission(p_organization_id, 'users.manage_users') then
    return false;
  end if;
  select r.rank, om.primary_establishment_id, om.employee_id
  into v_target_rank, v_primary_establishment_id, v_employee_id
  from public.organization_members om
  join public.roles r on r.id = om.role_id
  where om.organization_id = p_organization_id and om.user_id = p_user_id
  limit 1;
  if v_target_rank is null or coalesce(public.current_role_rank(p_organization_id), 0) <= v_target_rank then
    return false;
  end if;
  return public.target_in_scope(p_organization_id, v_primary_establishment_id, v_employee_id);
end;
$$;

create or replace function public.can_manage_member(p_organization_id uuid, p_member_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_owner(p_organization_id)
      or exists (
        select 1
        from public.organization_members om
        where om.id = p_member_id
          and om.organization_id = p_organization_id
          and public.can_manage_user(p_organization_id, om.user_id)
      );
$$;

create or replace function public.can_access_self_service(p_organization_id uuid, p_employee_id uuid, p_action text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
    public.current_employee_id(p_organization_id) = p_employee_id
    and p_action in ('view', 'update')
  ) or exists (
    select 1 from public.employees e
    where e.id = p_employee_id
      and e.organization_id = p_organization_id
      and public.has_permission(p_organization_id, 'employees.' || p_action)
      and public.member_in_scope(p_organization_id, e.establishment_id, e.id, e.team_id, e.service_id)
  );
$$;

-- Les listes d'utilisateurs, invitations et journaux doivent respecter le
-- périmètre établissement/équipe du manager, pas seulement son module Users.
create or replace function public.can_view_user(p_organization_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_primary_establishment_id uuid;
  v_employee_id uuid;
begin
  if not public.is_active_member(p_organization_id) then return false; end if;
  if p_user_id = auth.uid() or public.is_owner(p_organization_id) then return true; end if;
  if not public.has_permission(p_organization_id, 'users.view') then return false; end if;
  select primary_establishment_id, employee_id
  into v_primary_establishment_id, v_employee_id
  from public.organization_members
  where organization_id = p_organization_id and user_id = p_user_id
  limit 1;
  return public.target_in_scope(p_organization_id, v_primary_establishment_id, v_employee_id);
end;
$$;

create or replace function public.can_view_invitation(
  p_organization_id uuid,
  p_primary_establishment_id uuid,
  p_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission(p_organization_id, 'users.view')
     and public.target_in_scope(p_organization_id, p_primary_establishment_id, p_employee_id);
$$;

create or replace function public.can_manage_invitation(
  p_organization_id uuid,
  p_role_id uuid,
  p_primary_establishment_id uuid,
  p_employee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.can_assign_role(p_organization_id, p_role_id)
     and public.can_manage_target_scope(p_organization_id, p_primary_establishment_id, p_employee_id);
$$;

create or replace function public.can_access_audit_log(p_organization_id uuid, p_establishment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission(p_organization_id, 'audit.view')
     and (public.is_owner(p_organization_id)
       or (p_establishment_id is not null and public.member_in_scope(p_organization_id, p_establishment_id, null, null, null)));
$$;

-- ---------------------------------------------------------------------------
-- Journal d'activité : les déclencheurs enregistrent les modifications même
-- si elles arrivent par une requête directe PostgREST plutôt que par l'UI.
-- ---------------------------------------------------------------------------

create or replace function public.audit_change()
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

  -- Ne stockons pas dans le journal la totalité d'un contrat ou d'une paie.
  if tg_table_name = 'employee_private_data' then
    v_old := case when v_old is null then null else jsonb_build_object('changed', true) end;
    v_new := case when v_new is null then null else jsonb_build_object('changed', true) end;
  else
    if v_old is not null then v_old := v_old - array['created_by', 'updated_by']; end if;
    if v_new is not null then v_new := v_new - array['created_by', 'updated_by']; end if;
  end if;

  if v_org_id is not null then
    insert into public.audit_logs (
      organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, old_value, new_value
    ) values (
      v_org_id, v_establishment_id, auth.uid(), lower(tg_table_name) || '.' || lower(tg_op), tg_table_name, v_resource_id, v_old, v_new
    );
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create or replace function public.audit_role_permission_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_id uuid;
  v_org_id uuid;
begin
  if tg_op = 'DELETE' then v_role_id := old.role_id; else v_role_id := new.role_id; end if;
  select organization_id into v_org_id from public.roles where id = v_role_id;
  if v_org_id is not null then
    insert into public.audit_logs (organization_id, actor_user_id, action, resource_type, resource_id, old_value, new_value)
    values (
      v_org_id,
      auth.uid(),
      'role_permissions.' || lower(tg_op),
      'role_permission',
      v_role_id::text,
      case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      case when tg_op = 'DELETE' then null else to_jsonb(new) end
    );
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists roles_audit_change on public.roles;
create trigger roles_audit_change after insert or update or delete on public.roles for each row execute function public.audit_change();
drop trigger if exists role_permissions_audit_change on public.role_permissions;
create trigger role_permissions_audit_change after insert or update or delete on public.role_permissions for each row execute function public.audit_role_permission_change();

drop trigger if exists employees_audit_change on public.employees;
create trigger employees_audit_change after insert or update or delete on public.employees for each row execute function public.audit_change();
drop trigger if exists employee_private_data_audit_change on public.employee_private_data;
create trigger employee_private_data_audit_change after insert or update or delete on public.employee_private_data for each row execute function public.audit_change();
drop trigger if exists organization_members_audit_change on public.organization_members;
create trigger organization_members_audit_change after insert or update or delete on public.organization_members for each row execute function public.audit_change();
drop trigger if exists user_permissions_audit_change on public.user_permissions;
create trigger user_permissions_audit_change after insert or update or delete on public.user_permissions for each row execute function public.audit_change();
drop trigger if exists manager_scopes_audit_change on public.manager_scopes;
create trigger manager_scopes_audit_change after insert or update or delete on public.manager_scopes for each row execute function public.audit_change();
drop trigger if exists business_records_audit_change on public.business_records;
create trigger business_records_audit_change after insert or update or delete on public.business_records for each row execute function public.audit_change();
drop trigger if exists documents_audit_change on public.documents;
create trigger documents_audit_change after insert or update or delete on public.documents for each row execute function public.audit_change();
drop trigger if exists invitations_audit_change on public.invitations;
create trigger invitations_audit_change after insert or update or delete on public.invitations for each row execute function public.audit_change();

-- ---------------------------------------------------------------------------
-- Row Level Security. Toutes les politiques appellent les fonctions ci-dessus,
-- exécutées côté PostgreSQL avec auth.uid(), jamais une variable du navigateur.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.establishments enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.employees enable row level security;
alter table public.employee_private_data enable row level security;
alter table public.employee_self_service enable row level security;
alter table public.organization_members enable row level security;
alter table public.user_permissions enable row level security;
alter table public.manager_scopes enable row level security;
alter table public.business_records enable row level security;
alter table public.documents enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.organization_members mine
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and public.can_view_user(mine.organization_id, profiles.id)
  )
);
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations for select to authenticated using (public.is_active_member(id));
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations for update to authenticated using (public.is_owner(id)) with check (public.is_owner(id));

drop policy if exists establishments_select on public.establishments;
create policy establishments_select on public.establishments for select to authenticated using (
  public.can_access_establishment(organization_id, id, 'view')
);
drop policy if exists establishments_insert on public.establishments;
create policy establishments_insert on public.establishments for insert to authenticated with check (
  public.has_permission(organization_id, 'establishments.create')
  and public.member_in_scope(organization_id, null, null, null, null)
);
drop policy if exists establishments_update on public.establishments;
create policy establishments_update on public.establishments for update to authenticated using (
  public.can_access_establishment(organization_id, id, 'update')
) with check (
  public.can_access_establishment(organization_id, id, 'update')
);
drop policy if exists establishments_delete on public.establishments;
create policy establishments_delete on public.establishments for delete to authenticated using (
  public.can_access_establishment(organization_id, id, 'delete')
);

drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated using (
  public.has_permission(organization_id, 'users.view')
  or public.has_permission(organization_id, 'users.manage_users')
);
drop policy if exists roles_insert on public.roles;
create policy roles_insert on public.roles for insert to authenticated with check (public.is_owner(organization_id));
drop policy if exists roles_update on public.roles;
create policy roles_update on public.roles for update to authenticated using (public.is_owner(organization_id)) with check (public.is_owner(organization_id));
drop policy if exists roles_delete on public.roles;
create policy roles_delete on public.roles for delete to authenticated using (public.is_owner(organization_id) and not is_system);

drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions for select to authenticated using (true);

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated using (
  exists (select 1 from public.roles r where r.id = role_permissions.role_id and (
    public.has_permission(r.organization_id, 'users.view') or public.has_permission(r.organization_id, 'users.manage_users')
  ))
);
drop policy if exists role_permissions_insert on public.role_permissions;
create policy role_permissions_insert on public.role_permissions for insert to authenticated with check (
  exists (select 1 from public.roles r where r.id = role_permissions.role_id and public.is_owner(r.organization_id))
);
drop policy if exists role_permissions_delete on public.role_permissions;
create policy role_permissions_delete on public.role_permissions for delete to authenticated using (
  exists (select 1 from public.roles r where r.id = role_permissions.role_id and public.is_owner(r.organization_id))
);

drop policy if exists employees_select on public.employees;
create policy employees_select on public.employees for select to authenticated using (
  public.can_access_employee(organization_id, establishment_id, id, team_id, service_id, 'view')
);
drop policy if exists employees_insert on public.employees;
create policy employees_insert on public.employees for insert to authenticated with check (
  public.has_permission(organization_id, 'employees.create')
  and public.member_in_scope(organization_id, establishment_id, null, team_id, service_id)
);
drop policy if exists employees_update on public.employees;
create policy employees_update on public.employees for update to authenticated using (
  public.can_access_employee(organization_id, establishment_id, id, team_id, service_id, 'update')
) with check (
  public.can_access_employee(organization_id, establishment_id, id, team_id, service_id, 'update')
);
drop policy if exists employees_delete on public.employees;
create policy employees_delete on public.employees for delete to authenticated using (
  public.can_access_employee(organization_id, establishment_id, id, team_id, service_id, 'delete')
);

drop policy if exists employee_private_data_select on public.employee_private_data;
create policy employee_private_data_select on public.employee_private_data for select to authenticated using (
  exists (
    select 1 from public.employees e
    where e.id = employee_private_data.employee_id
      and public.can_access_private_employee_data(employee_private_data.organization_id, e.establishment_id, e.id, e.team_id, e.service_id, 'view')
  )
);
drop policy if exists employee_private_data_insert on public.employee_private_data;
create policy employee_private_data_insert on public.employee_private_data for insert to authenticated with check (
  exists (
    select 1 from public.employees e
    where e.id = employee_private_data.employee_id
      and public.can_access_private_employee_data(employee_private_data.organization_id, e.establishment_id, e.id, e.team_id, e.service_id, 'create')
  )
);
drop policy if exists employee_private_data_update on public.employee_private_data;
create policy employee_private_data_update on public.employee_private_data for update to authenticated using (
  exists (
    select 1 from public.employees e
    where e.id = employee_private_data.employee_id
      and public.can_access_private_employee_data(employee_private_data.organization_id, e.establishment_id, e.id, e.team_id, e.service_id, 'update')
  )
) with check (
  exists (
    select 1 from public.employees e
    where e.id = employee_private_data.employee_id
      and public.can_access_private_employee_data(employee_private_data.organization_id, e.establishment_id, e.id, e.team_id, e.service_id, 'update')
  )
);
drop policy if exists employee_private_data_delete on public.employee_private_data;
create policy employee_private_data_delete on public.employee_private_data for delete to authenticated using (
  exists (
    select 1 from public.employees e
    where e.id = employee_private_data.employee_id
      and public.can_access_private_employee_data(employee_private_data.organization_id, e.establishment_id, e.id, e.team_id, e.service_id, 'delete')
  )
);

drop policy if exists employee_self_service_select on public.employee_self_service;
create policy employee_self_service_select on public.employee_self_service for select to authenticated using (
  public.can_access_self_service(organization_id, employee_id, 'view')
);
drop policy if exists employee_self_service_insert on public.employee_self_service;
create policy employee_self_service_insert on public.employee_self_service for insert to authenticated with check (
  public.can_access_self_service(organization_id, employee_id, 'update')
);
drop policy if exists employee_self_service_update on public.employee_self_service;
create policy employee_self_service_update on public.employee_self_service for update to authenticated using (
  public.can_access_self_service(organization_id, employee_id, 'update')
) with check (
  public.can_access_self_service(organization_id, employee_id, 'update')
);

drop policy if exists organization_members_select on public.organization_members;
create policy organization_members_select on public.organization_members for select to authenticated using (
  user_id = auth.uid() or public.can_view_user(organization_id, user_id)
);
drop policy if exists organization_members_insert on public.organization_members;
-- Les rattachements sont créés exclusivement par claim_invitation(), qui
-- vérifie l'e-mail, l'expiration, le rôle et le périmètre. Aucune insertion
-- directe depuis la console ou PostgREST n'est autorisée.
drop policy if exists organization_members_update on public.organization_members;
create policy organization_members_update on public.organization_members for update to authenticated using (
  public.can_manage_user(organization_id, user_id)
) with check (
  public.can_manage_user(organization_id, user_id)
  and public.can_assign_role(organization_id, role_id)
  and public.can_manage_target_scope(organization_id, primary_establishment_id, employee_id)
);
drop policy if exists organization_members_delete on public.organization_members;
create policy organization_members_delete on public.organization_members for delete to authenticated using (
  public.can_manage_user(organization_id, user_id)
);

drop policy if exists user_permissions_select on public.user_permissions;
create policy user_permissions_select on public.user_permissions for select to authenticated using (
  user_id = auth.uid() or public.can_manage_user(organization_id, user_id)
);
drop policy if exists user_permissions_insert on public.user_permissions;
create policy user_permissions_insert on public.user_permissions for insert to authenticated with check (
  public.can_manage_user(organization_id, user_id)
  and public.can_assign_permission(organization_id, permission_key)
);
drop policy if exists user_permissions_update on public.user_permissions;
create policy user_permissions_update on public.user_permissions for update to authenticated using (
  public.can_manage_user(organization_id, user_id)
  and public.can_assign_permission(organization_id, permission_key)
) with check (
  public.can_manage_user(organization_id, user_id)
  and public.can_assign_permission(organization_id, permission_key)
);
drop policy if exists user_permissions_delete on public.user_permissions;
create policy user_permissions_delete on public.user_permissions for delete to authenticated using (
  public.can_manage_user(organization_id, user_id)
  and public.can_assign_permission(organization_id, permission_key)
);

drop policy if exists manager_scopes_select on public.manager_scopes;
create policy manager_scopes_select on public.manager_scopes for select to authenticated using (
  member_id = public.current_member_id(organization_id) or public.can_manage_member(organization_id, member_id)
);
drop policy if exists manager_scopes_insert on public.manager_scopes;
create policy manager_scopes_insert on public.manager_scopes for insert to authenticated with check (
  public.can_manage_member(organization_id, member_id)
  and public.can_grant_scope(organization_id, scope_type, establishment_id, team_id, service_id, employee_id)
);
drop policy if exists manager_scopes_update on public.manager_scopes;
create policy manager_scopes_update on public.manager_scopes for update to authenticated using (
  public.can_manage_member(organization_id, member_id)
) with check (
  public.can_manage_member(organization_id, member_id)
  and public.can_grant_scope(organization_id, scope_type, establishment_id, team_id, service_id, employee_id)
);
drop policy if exists manager_scopes_delete on public.manager_scopes;
create policy manager_scopes_delete on public.manager_scopes for delete to authenticated using (
  public.can_manage_member(organization_id, member_id)
);

drop policy if exists business_records_select on public.business_records;
create policy business_records_select on public.business_records for select to authenticated using (
  deleted_at is null and public.can_access_record(organization_id, record_type, establishment_id, employee_id, team_id, service_id, 'view')
);
drop policy if exists business_records_insert on public.business_records;
create policy business_records_insert on public.business_records for insert to authenticated with check (
  deleted_at is null and public.can_access_record(organization_id, record_type, establishment_id, employee_id, team_id, service_id, 'create')
);
drop policy if exists business_records_update on public.business_records;
create policy business_records_update on public.business_records for update to authenticated using (
  public.can_access_record(organization_id, record_type, establishment_id, employee_id, team_id, service_id, 'update')
) with check (
  public.can_access_record(organization_id, record_type, establishment_id, employee_id, team_id, service_id, 'update')
);
drop policy if exists business_records_delete on public.business_records;
create policy business_records_delete on public.business_records for delete to authenticated using (
  public.can_access_record(organization_id, record_type, establishment_id, employee_id, team_id, service_id, 'delete')
);

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated using (
  public.can_access_document(organization_id, establishment_id, employee_id, 'view')
);
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents for insert to authenticated with check (
  public.can_access_document(organization_id, establishment_id, employee_id, 'create')
);
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents for update to authenticated using (
  public.can_access_document(organization_id, establishment_id, employee_id, 'update')
) with check (public.can_access_document(organization_id, establishment_id, employee_id, 'update'));
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents for delete to authenticated using (
  public.can_access_document(organization_id, establishment_id, employee_id, 'delete')
);

drop policy if exists invitations_select on public.invitations;
create policy invitations_select on public.invitations for select to authenticated using (
  public.can_view_invitation(organization_id, primary_establishment_id, employee_id)
);
drop policy if exists invitations_update on public.invitations;
-- Une invitation est créée, renouvelée, acceptée ou annulée uniquement par
-- les RPC/Edge Functions dédiées. Cela évite de modifier directement un jeton,
-- un rôle ou un statut depuis PostgREST.
drop policy if exists invitations_delete on public.invitations;
create policy invitations_delete on public.invitations for delete to authenticated using (
  status = 'sent'
  and public.can_manage_invitation(organization_id, role_id, primary_establishment_id, employee_id)
);

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated using (
  public.can_access_audit_log(organization_id, establishment_id)
);

-- ---------------------------------------------------------------------------
-- Documents : bucket privé et politiques Storage reliées au même RBAC.
-- Chemin obligatoire : {organization_id}/{employee_id ou general}/{uuid-fichier}
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('plannipro-documents', 'plannipro-documents', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

create or replace function public.can_access_document_path(p_path text, p_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_employee_id uuid;
  v_establishment_id uuid;
begin
  v_org_id := nullif(split_part(p_path, '/', 1), '')::uuid;
  if split_part(p_path, '/', 2) <> 'general' then
    v_employee_id := nullif(split_part(p_path, '/', 2), '')::uuid;
  end if;
  select establishment_id into v_establishment_id from public.employees where id = v_employee_id;
  return public.can_access_document(v_org_id, v_establishment_id, v_employee_id, p_action);
exception when invalid_text_representation then
  return false;
end;
$$;

drop policy if exists plannipro_documents_select on storage.objects;
create policy plannipro_documents_select on storage.objects for select to authenticated using (
  bucket_id = 'plannipro-documents' and public.can_access_document_path(name, 'view')
);
drop policy if exists plannipro_documents_insert on storage.objects;
create policy plannipro_documents_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'plannipro-documents' and public.can_access_document_path(name, 'create')
);
drop policy if exists plannipro_documents_update on storage.objects;
create policy plannipro_documents_update on storage.objects for update to authenticated using (
  bucket_id = 'plannipro-documents' and public.can_access_document_path(name, 'update')
) with check (
  bucket_id = 'plannipro-documents' and public.can_access_document_path(name, 'update')
);
drop policy if exists plannipro_documents_delete on storage.objects;
create policy plannipro_documents_delete on storage.objects for delete to authenticated using (
  bucket_id = 'plannipro-documents' and public.can_access_document_path(name, 'delete')
);

-- ---------------------------------------------------------------------------
-- Realtime et droits PostgREST.
-- ---------------------------------------------------------------------------

do $$ begin
  alter publication supabase_realtime add table public.employees;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.business_records;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.organization_members;
exception when duplicate_object then null;
end $$;

revoke all on all tables in schema public from anon;
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.profiles, public.organizations, public.establishments, public.roles, public.permissions, public.role_permissions, public.employees, public.employee_private_data, public.employee_self_service, public.organization_members, public.user_permissions, public.manager_scopes, public.business_records, public.documents, public.invitations, public.audit_logs to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Les fonctions SECURITY DEFINER ne sont jamais exécutables via PUBLIC. Les
-- fonctions ci-dessous sont les seules nécessaires aux politiques RLS ou à
-- l'application authentifiée. Les fonctions de trigger et de seed restent
-- inaccessibles depuis PostgREST, même si un utilisateur ouvre la console.
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated;
grant execute on function public.is_active_member(uuid) to authenticated;
grant execute on function public.current_member_id(uuid) to authenticated;
grant execute on function public.current_employee_id(uuid) to authenticated;
grant execute on function public.current_role_rank(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
grant execute on function public.has_permission(uuid, text) to authenticated;
grant execute on function public.member_in_scope(uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.can_access_establishment(uuid, uuid, text) to authenticated;
grant execute on function public.can_access_employee(uuid, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.record_module(text) to authenticated;
grant execute on function public.can_access_record(uuid, text, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.can_assign_role(uuid, uuid) to authenticated;
grant execute on function public.target_in_scope(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_manage_target_scope(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_assign_permission(uuid, text) to authenticated;
grant execute on function public.can_grant_scope(uuid, public.scope_type, uuid, text, text, uuid) to authenticated;
grant execute on function public.valid_scope_payload(uuid, jsonb) to authenticated;
grant execute on function public.valid_permission_overrides(uuid, jsonb) to authenticated;
grant execute on function public.can_access_private_employee_data(uuid, uuid, uuid, text, text, text) to authenticated;
grant execute on function public.can_access_document(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.can_manage_user(uuid, uuid) to authenticated;
grant execute on function public.can_manage_member(uuid, uuid) to authenticated;
grant execute on function public.can_access_self_service(uuid, uuid, text) to authenticated;
grant execute on function public.can_view_user(uuid, uuid) to authenticated;
grant execute on function public.can_view_invitation(uuid, uuid, uuid) to authenticated;
grant execute on function public.can_manage_invitation(uuid, uuid, uuid, uuid) to authenticated;
grant execute on function public.can_access_audit_log(uuid, uuid) to authenticated;
grant execute on function public.bootstrap_organization(text, text) to authenticated;
grant execute on function public.create_invitation(uuid, text, uuid, uuid, uuid, jsonb, jsonb, timestamptz) to authenticated;
grant execute on function public.claim_invitation(text) to authenticated;
grant execute on function public.touch_member_session() to authenticated;
grant execute on function public.get_access_context() to authenticated;
grant execute on function public.log_audit_event(uuid, text, text, text, uuid, jsonb, jsonb, jsonb) to authenticated;
grant execute on function public.can_access_document_path(text, text) to authenticated;

comment on table public.employee_private_data is 'Données RH sensibles séparées et protégées par employees.view_sensitive.';
comment on table public.manager_scopes is 'Périmètres établissement, équipe, service ou salarié pour les managers et rôles personnalisés.';
comment on table public.business_records is 'Synchronisation des plannings, pointages, absences et autres données métier PlanniPro.';
comment on table public.audit_logs is 'Journal d''activité en écriture via déclencheurs ou RPC seulement.';
