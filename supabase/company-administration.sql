-- PlanniPro — création d'entreprise administrée et rattachement sur invitation.
-- À exécuter après schema.sql et rbac-advanced.sql.
-- Migration transactionnelle, idempotente et sans modification des données métier.

begin;

alter table public.invitations
  add column if not exists first_name text;
alter table public.invitations
  add column if not exists last_name text;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'invitations_first_name_length'
      and conrelid = 'public.invitations'::regclass
  ) then
    alter table public.invitations
      add constraint invitations_first_name_length
      check (first_name is null or pg_catalog.char_length(pg_catalog.btrim(first_name)) between 1 and 80);
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'invitations_last_name_length'
      and conrelid = 'public.invitations'::regclass
  ) then
    alter table public.invitations
      add constraint invitations_last_name_length
      check (last_name is null or pg_catalog.char_length(pg_catalog.btrim(last_name)) between 1 and 80);
  end if;
end
$$;

-- Seule l'Edge Function create-company peut poser ce marqueur dans
-- auth.users.raw_app_meta_data. Les métadonnées utilisateur modifiables depuis
-- le navigateur ne sont jamais utilisées pour autoriser la création.
create or replace function public.bootstrap_company()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users%rowtype;
  v_setup jsonb;
  v_organization_name text;
  v_establishment_name text;
  v_first_name text;
  v_last_name text;
  v_full_name text;
  v_org_id uuid;
  v_establishment_id uuid;
  v_owner_role_id uuid;
  v_slug_base text;
  v_slug text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 0));

  select * into v_user
  from auth.users
  where id = auth.uid()
  for update;

  if not found or v_user.email_confirmed_at is null then
    raise exception 'Email confirmation required';
  end if;
  if coalesce((v_user.raw_app_meta_data ->> 'plannipro_company_creator')::boolean, false) is not true then
    raise exception 'Company creation was not authorized by the server';
  end if;

  v_setup := v_user.raw_app_meta_data -> 'plannipro_company_setup';
  if pg_catalog.jsonb_typeof(v_setup) is distinct from 'object' then
    raise exception 'Company setup is missing';
  end if;

  v_organization_name := pg_catalog.btrim(coalesce(v_setup ->> 'organization_name', ''));
  v_establishment_name := pg_catalog.btrim(coalesce(v_setup ->> 'establishment_name', ''));
  v_first_name := pg_catalog.btrim(coalesce(v_setup ->> 'first_name', ''));
  v_last_name := pg_catalog.btrim(coalesce(v_setup ->> 'last_name', ''));
  v_full_name := pg_catalog.btrim(pg_catalog.concat_ws(' ', v_first_name, v_last_name));

  if pg_catalog.char_length(v_organization_name) not between 2 and 120
     or pg_catalog.char_length(v_establishment_name) not between 2 and 120
     or pg_catalog.char_length(v_first_name) not between 1 and 80
     or pg_catalog.char_length(v_last_name) not between 1 and 80 then
    raise exception 'Invalid company setup';
  end if;
  if coalesce(v_user.email, '') = '' then
    raise exception 'A confirmed email address is required';
  end if;
  if exists (select 1 from public.organization_members where user_id = auth.uid())
     or exists (select 1 from public.organizations where created_by = auth.uid()) then
    raise exception 'This account already belongs to or created an organization';
  end if;

  insert into public.profiles (id, email, full_name)
  values (auth.uid(), pg_catalog.lower(v_user.email), v_full_name)
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name;

  v_slug_base := pg_catalog.btrim(
    pg_catalog.regexp_replace(pg_catalog.lower(v_organization_name), '[^a-z0-9]+', '-', 'g'),
    '-'
  );
  if pg_catalog.char_length(v_slug_base) < 2 then v_slug_base := 'plannipro'; end if;
  v_slug := pg_catalog.left(v_slug_base, 71) || '-' ||
    pg_catalog.left(pg_catalog.replace(auth.uid()::text, '-', ''), 8);

  insert into public.organizations (name, slug, created_by)
  values (v_organization_name, v_slug, auth.uid())
  returning id into v_org_id;

  perform public.seed_organization_roles(v_org_id);
  select id into v_owner_role_id
  from public.roles
  where organization_id = v_org_id and key = 'owner' and coalesce(is_active, true)
  limit 1;
  if v_owner_role_id is null then raise exception 'Default owner role was not created'; end if;

  insert into public.establishments (organization_id, name, created_by, updated_by)
  values (v_org_id, v_establishment_name, auth.uid(), auth.uid())
  returning id into v_establishment_id;

  insert into public.organization_members (
    organization_id, user_id, role_id, status, primary_establishment_id, invited_at, activated_at
  ) values (
    v_org_id, auth.uid(), v_owner_role_id, 'active', v_establishment_id, pg_catalog.now(), pg_catalog.now()
  );

  insert into public.audit_logs (
    organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata
  ) values (
    v_org_id, v_establishment_id, auth.uid(), 'organization.created', 'organization', v_org_id::text,
    pg_catalog.jsonb_build_object('creation_mode', 'company_administration')
  );

  update auth.users
  set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
    - 'plannipro_company_creator' - 'plannipro_company_setup'
  where id = auth.uid();

  return pg_catalog.jsonb_build_object(
    'organization_id', v_org_id,
    'establishment_id', v_establishment_id,
    'role', 'owner'
  );
end;
$$;

-- Compatibilité de signature : un ancien client ne peut plus initialiser une
-- organisation sans l'autorisation serveur, et ses libellés ne sont pas crus.
create or replace function public.bootstrap_organization(p_name text, p_establishment_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.bootstrap_company();
end;
$$;

-- Enveloppe de l'ancien RPC RBAC : elle conserve tous ses contrôles de rôle et
-- de périmètre, puis ajoute l'identité officielle choisie par l'administrateur.
create or replace function public.create_company_invitation(
  p_organization_id uuid,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_role_id uuid,
  p_primary_establishment_id uuid default null,
  p_employee_id uuid default null,
  p_scopes jsonb default '[]'::jsonb,
  p_permission_overrides jsonb default '[]'::jsonb,
  p_expires_at timestamptz default (pg_catalog.now() + interval '7 days')
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_invitation_id uuid;
begin
  if pg_catalog.char_length(pg_catalog.btrim(coalesce(p_first_name, ''))) not between 1 and 80
     or pg_catalog.char_length(pg_catalog.btrim(coalesce(p_last_name, ''))) not between 1 and 80 then
    raise exception 'First name and last name are required';
  end if;

  v_result := public.create_invitation(
    p_organization_id,
    p_email,
    p_role_id,
    p_primary_establishment_id,
    p_employee_id,
    coalesce(p_scopes, '[]'::jsonb),
    coalesce(p_permission_overrides, '[]'::jsonb),
    p_expires_at
  );
  v_invitation_id := (v_result ->> 'invitation_id')::uuid;

  update public.invitations
  set first_name = pg_catalog.btrim(p_first_name),
      last_name = pg_catalog.btrim(p_last_name)
  where id = v_invitation_id;

  return v_result;
end;
$$;

-- Validation sans effet de bord, exécutée avant que l'invité choisisse son mot
-- de passe. Un jeton expiré, consommé, falsifié ou destiné à un autre e-mail
-- est donc refusé avant toute modification du compte Auth.
create or replace function public.validate_invitation(p_token text)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_auth_email text;
  v_organization_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if pg_catalog.char_length(coalesce(p_token, '')) < 32 then raise exception 'Invalid invitation'; end if;

  select pg_catalog.lower(coalesce(email, '')) into v_auth_email
  from auth.users where id = auth.uid();

  select i.* into v_inv
  from public.invitations i
  where i.token_hash = pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex')
    and i.status = 'sent';

  if not found then raise exception 'Invitation not found or already used'; end if;
  if v_inv.expires_at <= pg_catalog.now() then raise exception 'Invitation expired'; end if;
  if v_auth_email <> pg_catalog.lower(v_inv.email) then
    raise exception 'This invitation was issued for another email address';
  end if;
  if not exists (
    select 1 from public.roles r
    where r.id = v_inv.role_id and r.organization_id = v_inv.organization_id and coalesce(r.is_active, true)
  ) then raise exception 'Invitation role is unavailable'; end if;

  select name into v_organization_name from public.organizations where id = v_inv.organization_id;
  return pg_catalog.jsonb_build_object(
    'invitation_id', v_inv.id,
    'organization_name', v_organization_name,
    'first_name', v_inv.first_name,
    'last_name', v_inv.last_name,
    'expires_at', v_inv.expires_at
  );
end;
$$;

create or replace function public.claim_invitation(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations%rowtype;
  v_member_id uuid;
  v_scope jsonb;
  v_permission jsonb;
  v_auth_email text;
  v_email_confirmed_at timestamptz;
  v_encrypted_password text;
  v_full_name text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if pg_catalog.char_length(coalesce(p_token, '')) < 32 then raise exception 'Invalid invitation'; end if;

  select pg_catalog.lower(coalesce(email, '')), email_confirmed_at, encrypted_password
  into v_auth_email, v_email_confirmed_at, v_encrypted_password
  from auth.users
  where id = auth.uid()
  for update;

  if not found or v_email_confirmed_at is null then raise exception 'Email confirmation required'; end if;
  if coalesce(v_encrypted_password, '') = '' then raise exception 'Password setup required'; end if;

  select i.* into v_inv
  from public.invitations i
  where i.token_hash = pg_catalog.encode(extensions.digest(p_token, 'sha256'), 'hex')
    and i.status = 'sent'
  for update;

  if not found then raise exception 'Invitation not found or already used'; end if;
  if v_inv.expires_at <= pg_catalog.now() then raise exception 'Invitation expired'; end if;
  if v_auth_email <> pg_catalog.lower(v_inv.email) then
    raise exception 'This invitation was issued for another email address';
  end if;
  if not exists (
    select 1 from public.roles r
    where r.id = v_inv.role_id and r.organization_id = v_inv.organization_id and coalesce(r.is_active, true)
  ) then raise exception 'Invitation role is unavailable'; end if;
  if exists (select 1 from public.roles where id = v_inv.role_id and key = 'employee')
     and v_inv.employee_id is null then
    raise exception 'An employee invitation must be linked to an employee record';
  end if;

  v_full_name := pg_catalog.btrim(pg_catalog.concat_ws(' ', v_inv.first_name, v_inv.last_name));
  insert into public.profiles (id, email, full_name)
  values (auth.uid(), v_auth_email, nullif(v_full_name, ''))
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, public.profiles.full_name);

  insert into public.organization_members (
    organization_id, user_id, role_id, status, primary_establishment_id, employee_id, invited_at, activated_at
  ) values (
    v_inv.organization_id, auth.uid(), v_inv.role_id, 'active', v_inv.primary_establishment_id,
    v_inv.employee_id, pg_catalog.now(), pg_catalog.now()
  )
  on conflict (organization_id, user_id) do update
    set role_id = excluded.role_id,
        status = 'active',
        primary_establishment_id = excluded.primary_establishment_id,
        employee_id = excluded.employee_id,
        activated_at = pg_catalog.now()
  returning id into v_member_id;

  delete from public.manager_scopes where member_id = v_member_id;
  delete from public.user_permissions
  where organization_id = v_inv.organization_id and user_id = auth.uid();

  for v_scope in select value from pg_catalog.jsonb_array_elements(coalesce(v_inv.scopes, '[]'::jsonb)) loop
    insert into public.manager_scopes (
      organization_id, member_id, scope_type, establishment_id, team_id, service_id, employee_id, created_by
    ) values (
      v_inv.organization_id,
      v_member_id,
      (v_scope ->> 'scope_type')::public.scope_type,
      nullif(v_scope ->> 'establishment_id', '')::uuid,
      nullif(v_scope ->> 'team_id', ''),
      nullif(v_scope ->> 'service_id', ''),
      nullif(v_scope ->> 'employee_id', '')::uuid,
      v_inv.created_by
    );
  end loop;

  for v_permission in select value from pg_catalog.jsonb_array_elements(coalesce(v_inv.permission_overrides, '[]'::jsonb)) loop
    insert into public.user_permissions (organization_id, user_id, permission_key, effect, created_by)
    values (
      v_inv.organization_id,
      auth.uid(),
      v_permission ->> 'permission_key',
      coalesce((v_permission ->> 'effect')::public.permission_effect, 'grant'),
      v_inv.created_by
    );
  end loop;

  update public.invitations
  set status = 'accepted', accepted_at = pg_catalog.now()
  where id = v_inv.id and status = 'sent';

  insert into public.audit_logs (
    organization_id, establishment_id, actor_user_id, action, resource_type, resource_id, metadata
  ) values (
    v_inv.organization_id, v_inv.primary_establishment_id, auth.uid(), 'invitation.accepted',
    'invitation', v_inv.id::text, pg_catalog.jsonb_build_object('email', v_inv.email)
  );

  return pg_catalog.jsonb_build_object(
    'organization_id', v_inv.organization_id,
    'member_id', v_member_id,
    'role_id', v_inv.role_id
  );
end;
$$;

revoke all on function public.bootstrap_company() from public, anon, authenticated;
revoke all on function public.bootstrap_organization(text, text) from public, anon, authenticated;
revoke all on function public.create_company_invitation(uuid, text, text, text, uuid, uuid, uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.validate_invitation(text) from public, anon, authenticated;
revoke all on function public.claim_invitation(text) from public, anon, authenticated;

grant execute on function public.bootstrap_company() to authenticated;
grant execute on function public.bootstrap_organization(text, text) to authenticated;
grant execute on function public.create_company_invitation(uuid, text, text, text, uuid, uuid, uuid, jsonb, jsonb, timestamptz) to authenticated;
grant execute on function public.validate_invitation(text) to authenticated;
grant execute on function public.claim_invitation(text) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.invitations;
exception when duplicate_object then null;
end
$$;

comment on function public.bootstrap_company() is
  'Crée une organisation uniquement pour un compte confirmé autorisé par app_metadata serveur.';
comment on function public.create_company_invitation(uuid, text, text, text, uuid, uuid, uuid, jsonb, jsonb, timestamptz) is
  'Crée une invitation administrée avec identité, rôle, périmètres et permissions complémentaires.';

commit;
