-- Recette RLS de production sans résidu : toutes les créations sont annulées.
begin;

select set_config('plannipro.test.org', (select id::text from public.organizations order by created_at limit 1), true);
select set_config('plannipro.test.site_allowed', (select id::text from public.establishments where organization_id = current_setting('plannipro.test.org')::uuid order by created_at limit 1), true);
select set_config('plannipro.test.site_forbidden', gen_random_uuid()::text, true);
select set_config('plannipro.test.manager_user', gen_random_uuid()::text, true);
select set_config('plannipro.test.employee_user', gen_random_uuid()::text, true);
select set_config('plannipro.test.employee_allowed', gen_random_uuid()::text, true);
select set_config('plannipro.test.employee_forbidden', gen_random_uuid()::text, true);
select set_config('plannipro.test.manager_member', gen_random_uuid()::text, true);
select set_config('plannipro.test.employee_member', gen_random_uuid()::text, true);
select set_config('plannipro.test.record_allowed', gen_random_uuid()::text, true);
select set_config('plannipro.test.record_forbidden', gen_random_uuid()::text, true);
select set_config('plannipro.test.owner_role', (select id::text from public.roles where organization_id = current_setting('plannipro.test.org')::uuid and key = 'owner'), true);
select set_config('plannipro.test.owner_user', (
  select om.user_id::text
  from public.organization_members om
  join public.roles r on r.id = om.role_id
  where om.organization_id = current_setting('plannipro.test.org')::uuid
    and om.status = 'active' and r.key = 'owner'
  order by om.created_at limit 1
), true);

do $$
begin
  if nullif(current_setting('plannipro.test.org', true), '') is null
     or nullif(current_setting('plannipro.test.site_allowed', true), '') is null then
    raise exception 'RLS regression requires one existing organization and establishment';
  end if;
end
$$;

insert into auth.users (
  id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, is_sso_user, is_anonymous
) values
  (current_setting('plannipro.test.manager_user')::uuid, 'authenticated', 'authenticated',
   current_setting('plannipro.test.manager_user') || '@example.invalid', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), false, false),
  (current_setting('plannipro.test.employee_user')::uuid, 'authenticated', 'authenticated',
   current_setting('plannipro.test.employee_user') || '@example.invalid', now(),
   '{"provider":"email","providers":["email"]}', '{}', now(), now(), false, false);

insert into public.establishments (id, organization_id, legacy_id, name)
values (
  current_setting('plannipro.test.site_forbidden')::uuid,
  current_setting('plannipro.test.org')::uuid,
  'rls-rollback-site',
  'RLS rollback site'
);

insert into public.employees (id, organization_id, establishment_id, legacy_id, first_name, last_name)
values
  (current_setting('plannipro.test.employee_allowed')::uuid,
   current_setting('plannipro.test.org')::uuid,
   current_setting('plannipro.test.site_allowed')::uuid,
   'rls-rollback-allowed', 'RLS', 'Allowed'),
  (current_setting('plannipro.test.employee_forbidden')::uuid,
   current_setting('plannipro.test.org')::uuid,
   current_setting('plannipro.test.site_forbidden')::uuid,
   'rls-rollback-forbidden', 'RLS', 'Forbidden');

insert into public.employee_private_data (employee_id, organization_id, data)
values
  (current_setting('plannipro.test.employee_allowed')::uuid, current_setting('plannipro.test.org')::uuid, '{"marker":"allowed"}'),
  (current_setting('plannipro.test.employee_forbidden')::uuid, current_setting('plannipro.test.org')::uuid, '{"marker":"forbidden"}');

insert into public.organization_members (
  id, organization_id, user_id, role_id, status, primary_establishment_id, employee_id, activated_at
) values
  (current_setting('plannipro.test.manager_member')::uuid,
   current_setting('plannipro.test.org')::uuid,
   current_setting('plannipro.test.manager_user')::uuid,
   (select id from public.roles where organization_id = current_setting('plannipro.test.org')::uuid and key = 'manager'),
   'active', current_setting('plannipro.test.site_allowed')::uuid, null, now()),
  (current_setting('plannipro.test.employee_member')::uuid,
   current_setting('plannipro.test.org')::uuid,
   current_setting('plannipro.test.employee_user')::uuid,
   (select id from public.roles where organization_id = current_setting('plannipro.test.org')::uuid and key = 'employee'),
   'active', current_setting('plannipro.test.site_allowed')::uuid,
   current_setting('plannipro.test.employee_allowed')::uuid, now());

insert into public.manager_scopes (organization_id, member_id, scope_type, establishment_id)
values (
  current_setting('plannipro.test.org')::uuid,
  current_setting('plannipro.test.manager_member')::uuid,
  'establishment',
  current_setting('plannipro.test.site_allowed')::uuid
);

insert into public.business_records (
  id, organization_id, establishment_id, employee_id, record_type, legacy_id, payload
) values
  (current_setting('plannipro.test.record_allowed')::uuid,
   current_setting('plannipro.test.org')::uuid,
   current_setting('plannipro.test.site_allowed')::uuid,
   current_setting('plannipro.test.employee_allowed')::uuid,
   'shift', 'rls-rollback-record-allowed', '{"marker":"allowed"}'),
  (current_setting('plannipro.test.record_forbidden')::uuid,
   current_setting('plannipro.test.org')::uuid,
   current_setting('plannipro.test.site_forbidden')::uuid,
   current_setting('plannipro.test.employee_forbidden')::uuid,
   'shift', 'rls-rollback-record-forbidden', '{"marker":"forbidden"}');

set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', current_setting('plannipro.test.manager_user'), true);

do $$
declare affected integer := 0;
declare manager_write_accepted boolean := false;
begin
  if not exists (select 1 from public.employees where id = current_setting('plannipro.test.employee_allowed')::uuid) then
    raise exception 'manager cannot read allowed employee';
  end if;
  if exists (select 1 from public.employees where id = current_setting('plannipro.test.employee_forbidden')::uuid) then
    raise exception 'manager can read forbidden establishment';
  end if;
  if exists (select 1 from public.business_records where id = current_setting('plannipro.test.record_forbidden')::uuid) then
    raise exception 'manager can read forbidden business record';
  end if;
  if exists (select 1 from public.employee_private_data where employee_id in (
    current_setting('plannipro.test.employee_allowed')::uuid,
    current_setting('plannipro.test.employee_forbidden')::uuid
  )) then
    raise exception 'manager can read confidential employee data';
  end if;

  begin
    update public.organization_members
    set role_id = current_setting('plannipro.test.owner_role')::uuid
    where id = current_setting('plannipro.test.manager_member')::uuid;
    get diagnostics affected = row_count;
  exception when others then
    null;
  end;
  if affected <> 0 then raise exception 'manager elevated its own role'; end if;

  begin
    insert into public.business_records (organization_id, establishment_id, employee_id, record_type, legacy_id, payload)
    values (current_setting('plannipro.test.org')::uuid,
            current_setting('plannipro.test.site_forbidden')::uuid,
            current_setting('plannipro.test.employee_forbidden')::uuid,
            'shift', 'rls-rollback-manager-write', '{}');
    manager_write_accepted := true;
  exception when others then
    null;
  end;
  if manager_write_accepted then raise exception 'manager wrote outside its scope'; end if;
end
$$;

select set_config('request.jwt.claim.sub', current_setting('plannipro.test.employee_user'), true);

do $$
declare employee_write_accepted boolean := false;
begin
  if not exists (select 1 from public.employees where id = current_setting('plannipro.test.employee_allowed')::uuid) then
    raise exception 'employee cannot read own employee row';
  end if;
  if exists (select 1 from public.employees where id <> current_setting('plannipro.test.employee_allowed')::uuid) then
    raise exception 'employee can read another employee';
  end if;
  if exists (select 1 from public.business_records where id = current_setting('plannipro.test.record_forbidden')::uuid) then
    raise exception 'employee can read another employee record';
  end if;
  if exists (select 1 from public.audit_logs) then
    raise exception 'employee can read audit logs';
  end if;

  begin
    insert into public.business_records (organization_id, establishment_id, employee_id, record_type, legacy_id, payload)
    values (current_setting('plannipro.test.org')::uuid,
            current_setting('plannipro.test.site_allowed')::uuid,
            current_setting('plannipro.test.employee_allowed')::uuid,
            'shift', 'rls-rollback-employee-write', '{}');
    employee_write_accepted := true;
  exception when others then
    null;
  end;
  if employee_write_accepted then raise exception 'employee created a planning record'; end if;
end
$$;

reset role;
select set_config('request.jwt.claim.sub', current_setting('plannipro.test.owner_user'), true);
update public.organization_members
set status = 'suspended', suspended_at = now()
where id = current_setting('plannipro.test.manager_member')::uuid;

set local role authenticated;
select set_config('request.jwt.claim.sub', current_setting('plannipro.test.manager_user'), true);

do $$
begin
  if exists (select 1 from public.organizations where id = current_setting('plannipro.test.org')::uuid)
     or exists (select 1 from public.employees)
     or exists (select 1 from public.business_records) then
    raise exception 'suspended manager still reads tenant data';
  end if;
  if public.get_access_context() <> '[]'::jsonb then
    raise exception 'suspended manager still receives an access context';
  end if;
end
$$;

reset role;
rollback;
