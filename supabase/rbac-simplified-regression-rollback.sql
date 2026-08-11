-- Recette RBAC simplifiee pour une branche Supabase de developpement.
-- Prerequis : rbac-simplified-roles.sql applique.
-- Toutes les donnees fictives sont annulees par ROLLBACK.

begin;

select set_config('pp.rbac.org',gen_random_uuid()::text,true);
select set_config('pp.rbac.site_a',gen_random_uuid()::text,true);
select set_config('pp.rbac.site_b',gen_random_uuid()::text,true);
select set_config('pp.rbac.owner',gen_random_uuid()::text,true);
select set_config('pp.rbac.admin_a',gen_random_uuid()::text,true);
select set_config('pp.rbac.admin_b',gen_random_uuid()::text,true);
select set_config('pp.rbac.manager',gen_random_uuid()::text,true);
select set_config('pp.rbac.supervisor',gen_random_uuid()::text,true);
select set_config('pp.rbac.employee',gen_random_uuid()::text,true);
select set_config('pp.rbac.employee_a',gen_random_uuid()::text,true);
select set_config('pp.rbac.employee_b',gen_random_uuid()::text,true);

insert into auth.users(
  id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,
  created_at,updated_at,is_sso_user,is_anonymous
)
select id,'authenticated','authenticated',id||'@example.invalid',now(),
  '{"provider":"email","providers":["email"]}','{}',now(),now(),false,false
from unnest(array[
  current_setting('pp.rbac.owner')::uuid,current_setting('pp.rbac.admin_a')::uuid,
  current_setting('pp.rbac.admin_b')::uuid,current_setting('pp.rbac.manager')::uuid,
  current_setting('pp.rbac.supervisor')::uuid,current_setting('pp.rbac.employee')::uuid
]) as u(id);

insert into public.profiles(id,email,full_name)
select id,id||'@example.invalid','RBAC regression'
from unnest(array[
  current_setting('pp.rbac.owner')::uuid,current_setting('pp.rbac.admin_a')::uuid,
  current_setting('pp.rbac.admin_b')::uuid,current_setting('pp.rbac.manager')::uuid,
  current_setting('pp.rbac.supervisor')::uuid,current_setting('pp.rbac.employee')::uuid
]) as u(id)
on conflict(id) do update set
  email=excluded.email,
  full_name=excluded.full_name;

insert into public.organizations(id,name,slug,created_by) values(
  current_setting('pp.rbac.org')::uuid,'RBAC rollback company',
  'rbac-rollback-'||replace(current_setting('pp.rbac.org'),'-',''),current_setting('pp.rbac.owner')::uuid
);
select public.seed_organization_roles(current_setting('pp.rbac.org')::uuid);

insert into public.establishments(id,organization_id,legacy_id,name) values
  (current_setting('pp.rbac.site_a')::uuid,current_setting('pp.rbac.org')::uuid,'rbac-a','Etablissement A'),
  (current_setting('pp.rbac.site_b')::uuid,current_setting('pp.rbac.org')::uuid,'rbac-b','Etablissement B');

insert into public.employees(id,organization_id,establishment_id,legacy_id,first_name,last_name) values
  (current_setting('pp.rbac.employee_a')::uuid,current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'rbac-employee-a','Employe','A'),
  (current_setting('pp.rbac.employee_b')::uuid,current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_b')::uuid,'rbac-employee-b','Employe','B');

insert into public.organization_members(
  organization_id,user_id,role_id,status,primary_establishment_id,employee_id,activated_at
)
select current_setting('pp.rbac.org')::uuid,v.user_id,r.id,'active',v.site_id,v.employee_id,now()
from (values
  (current_setting('pp.rbac.owner')::uuid,'owner',current_setting('pp.rbac.site_a')::uuid,null::uuid),
  (current_setting('pp.rbac.admin_a')::uuid,'administrator',current_setting('pp.rbac.site_a')::uuid,null::uuid),
  (current_setting('pp.rbac.admin_b')::uuid,'administrator',current_setting('pp.rbac.site_b')::uuid,null::uuid),
  (current_setting('pp.rbac.manager')::uuid,'manager',current_setting('pp.rbac.site_a')::uuid,null::uuid),
  (current_setting('pp.rbac.supervisor')::uuid,'supervisor',current_setting('pp.rbac.site_a')::uuid,null::uuid),
  (current_setting('pp.rbac.employee')::uuid,'employee',current_setting('pp.rbac.site_a')::uuid,current_setting('pp.rbac.employee_a')::uuid)
) v(user_id,role_key,site_id,employee_id)
join public.roles r on r.organization_id=current_setting('pp.rbac.org')::uuid and r.key=v.role_key;

-- L'owner technique est administrateur de toute l'organisation.
insert into public.member_establishment_roles(organization_id,member_id,establishment_id,role_id,is_primary,created_by)
select current_setting('pp.rbac.org')::uuid,om.id,current_setting('pp.rbac.site_b')::uuid,r.id,false,current_setting('pp.rbac.owner')::uuid
from public.organization_members om join public.roles r on r.organization_id=om.organization_id and r.key='owner'
where om.organization_id=current_setting('pp.rbac.org')::uuid and om.user_id=current_setting('pp.rbac.owner')::uuid
on conflict(member_id,establishment_id) do nothing;

insert into public.business_records(organization_id,establishment_id,employee_id,record_type,legacy_id,payload) values
  (current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,current_setting('pp.rbac.employee_a')::uuid,'shift','rbac-shift-a','{"date":"2026-08-10"}'),
  (current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_b')::uuid,current_setting('pp.rbac.employee_b')::uuid,'shift','rbac-shift-b','{"date":"2026-08-10"}');

set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);

-- Administrateur : complet sur A, sans acces implicite a B.
select set_config('request.jwt.claim.sub',current_setting('pp.rbac.admin_a'),true);
do $$ begin
  if not public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'settings.update') then
    raise exception 'Administrator lacks settings.update on site A'; end if;
  if public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_b')::uuid,'planning.view') then
    raise exception 'Administrator crossed establishment isolation'; end if;
end $$;

-- Manager : operations autorisees, securite et donnees sensibles refusees.
select set_config('request.jwt.claim.sub',current_setting('pp.rbac.manager'),true);
do $$ declare changed integer:=0; begin
  if not public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'planning.publish')
     or not public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'pointage.correct') then
    raise exception 'Manager operational permissions missing'; end if;
  if public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'users.manage_roles')
     or public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'employees.view_sensitive')
     or public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_b')::uuid,'planning.view') then
    raise exception 'Manager received forbidden permission'; end if;
  update public.member_establishment_roles set role_id=(select id from public.roles
    where organization_id=current_setting('pp.rbac.org')::uuid and key='administrator')
  where member_id=(select id from public.organization_members where organization_id=current_setting('pp.rbac.org')::uuid
    and user_id=current_setting('pp.rbac.manager')::uuid);
  get diagnostics changed=row_count;
  if changed<>0 then raise exception 'Manager self-promoted through direct API'; end if;
end $$;

-- Superviseur : terrain oui, options sensibles non par defaut.
select set_config('request.jwt.claim.sub',current_setting('pp.rbac.supervisor'),true);
do $$ begin
  if not public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'planning.move') then
    raise exception 'Supervisor cannot organize planning'; end if;
  if public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'planning.publish')
     or public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'pointage.correct')
     or public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'employees.view_sensitive') then
    raise exception 'Supervisor received an optional or sensitive permission by default'; end if;
end $$;

-- Employe : donnees propres et badgeage uniquement.
select set_config('request.jwt.claim.sub',current_setting('pp.rbac.employee'),true);
do $$ begin
  if not public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'pointage.badge') then
    raise exception 'Employee cannot use time clock'; end if;
  if public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'pointage.correct')
     or public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'planning.update') then
    raise exception 'Employee can correct time or planning'; end if;
  if exists(select 1 from public.employees where id=current_setting('pp.rbac.employee_b')::uuid) then
    raise exception 'Employee A reads employee B'; end if;
  if exists(select 1 from public.business_records where legacy_id='rbac-shift-b') then
    raise exception 'Employee A reads planning B'; end if;
end $$;

-- Une exception Superviseur est accordee uniquement par l'Administrateur A.
select set_config('request.jwt.claim.sub',current_setting('pp.rbac.admin_a'),true);
select public.set_member_establishment_exceptions(
  (select mer.id from public.member_establishment_roles mer join public.organization_members om on om.id=mer.member_id
   where om.user_id=current_setting('pp.rbac.supervisor')::uuid and mer.establishment_id=current_setting('pp.rbac.site_a')::uuid),
  '[{"permission_key":"planning.publish","effect":"grant"}]'::jsonb
);
select set_config('request.jwt.claim.sub',current_setting('pp.rbac.supervisor'),true);
do $$ begin
  if not public.has_permission_at(current_setting('pp.rbac.org')::uuid,current_setting('pp.rbac.site_a')::uuid,'planning.publish') then
    raise exception 'Supervisor exception was not applied'; end if;
end $$;

-- Le site B ne peut perdre son unique Administrateur metier.
reset role;
delete from public.member_establishment_roles
where member_id=(select id from public.organization_members where organization_id=current_setting('pp.rbac.org')::uuid
  and user_id=current_setting('pp.rbac.owner')::uuid)
  and establishment_id=current_setting('pp.rbac.site_b')::uuid;
do $$ begin
  begin
    delete from public.member_establishment_roles
    where member_id=(select id from public.organization_members where organization_id=current_setting('pp.rbac.org')::uuid
      and user_id=current_setting('pp.rbac.admin_b')::uuid)
      and establishment_id=current_setting('pp.rbac.site_b')::uuid;
    raise exception 'Last establishment administrator was removed';
  exception when raise_exception then
    if sqlerrm='Last establishment administrator was removed' then raise; end if;
  end;
end $$;

rollback;
