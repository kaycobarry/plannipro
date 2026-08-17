-- PlanniPro - expiration d'acces par etablissement.
-- Migration transactionnelle et idempotente. Les etablissements existants
-- restent en acces illimite (access_expires_at = null).
begin;

alter table public.establishments
  add column if not exists access_starts_at timestamptz not null default now(),
  add column if not exists access_expires_at timestamptz,
  add column if not exists access_suspended_at timestamptz,
  add column if not exists access_suspension_reason text,
  add column if not exists access_version bigint not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.establishments'::regclass
      and conname = 'establishments_access_dates_valid'
  ) then
    alter table public.establishments
      add constraint establishments_access_dates_valid
      check (access_expires_at is null or access_expires_at > access_starts_at);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.establishments'::regclass
      and conname = 'establishments_access_suspension_reason_length'
  ) then
    alter table public.establishments
      add constraint establishments_access_suspension_reason_length
      check (access_suspension_reason is null or char_length(access_suspension_reason) <= 500);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.establishments'::regclass
      and conname = 'establishments_access_suspension_reason_required'
  ) then
    alter table public.establishments
      add constraint establishments_access_suspension_reason_required
      check (access_suspended_at is null or nullif(btrim(access_suspension_reason),'') is not null);
  end if;
end $$;

create index if not exists establishments_access_window_idx
  on public.establishments (organization_id, access_expires_at)
  where access_expires_at is not null;
create index if not exists establishments_access_suspended_idx
  on public.establishments (organization_id, access_suspended_at)
  where access_suspended_at is not null;

create table if not exists public.establishment_access_events (
  id uuid primary key default gen_random_uuid(),
  -- Identifiants volontairement sans cascade ni FK : le journal reste lisible
  -- même si l'établissement est ultérieurement supprimé.
  organization_id uuid not null,
  establishment_id uuid not null,
  action text not null check (action in ('created','scheduled','limited','extended','made_unlimited','suspended','reactivated','window_changed')),
  old_starts_at timestamptz,
  new_starts_at timestamptz,
  old_expires_at timestamptz,
  new_expires_at timestamptz,
  old_suspended_at timestamptz,
  new_suspended_at timestamptz,
  actor_user_id uuid,
  reason text,
  access_version bigint not null,
  created_at timestamptz not null default now()
);

create index if not exists establishment_access_events_scope_idx
  on public.establishment_access_events (organization_id, establishment_id, created_at desc);

create or replace function public.establishment_access_status_at(
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_suspended_at timestamptz,
  p_reference_at timestamptz default statement_timestamp()
)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when p_suspended_at is not null then 'suspended'
    when p_starts_at > p_reference_at then 'scheduled'
    when p_expires_at is not null and p_reference_at >= p_expires_at then 'expired'
    when p_expires_at is not null and p_expires_at <= p_reference_at + interval '30 days' then 'expiring_soon'
    else 'active'
  end;
$$;

create or replace function public.establishment_access_alert_days_at(
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_suspended_at timestamptz,
  p_reference_at timestamptz default statement_timestamp()
)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when public.establishment_access_status_at(p_starts_at,p_expires_at,p_suspended_at,p_reference_at) <> 'expiring_soon' then null
    when p_expires_at <= p_reference_at + interval '1 day' then 1
    when p_expires_at <= p_reference_at + interval '7 days' then 7
    else 30
  end;
$$;

create or replace function public.establishment_business_access_allowed(
  p_organization_id uuid,
  p_establishment_id uuid,
  p_reference_at timestamptz default statement_timestamp()
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.establishments e
    where e.id = p_establishment_id
      and e.organization_id = p_organization_id
      and e.access_suspended_at is null
      and e.access_starts_at <= p_reference_at
      and (e.access_expires_at is null or p_reference_at < e.access_expires_at)
  );
$$;

create or replace function public.assert_establishment_business_access(
  p_organization_id uuid,
  p_establishment_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_state text;
begin
  if public.establishment_business_access_allowed(p_organization_id,p_establishment_id) then return; end if;
  select public.establishment_access_status_at(access_starts_at,access_expires_at,access_suspended_at)
    into v_state from public.establishments
    where id=p_establishment_id and organization_id=p_organization_id;
  raise exception using
    errcode='P0001',
    message='STORE_ACCESS_EXPIRED',
    detail=coalesce(v_state,'unavailable');
end;
$$;

create or replace function public.can_administer_establishment_access(
  p_organization_id uuid,
  p_establishment_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.member_establishment_roles mer on mer.member_id=om.id and mer.organization_id=om.organization_id
    join public.roles r on r.id=mer.role_id and r.organization_id=om.organization_id and r.is_active
    where om.organization_id=p_organization_id
      and om.user_id=(select auth.uid())
      and om.status='active'
      and (
        r.key='owner'
        or (r.key='administrator' and mer.establishment_id=p_establishment_id)
      )
      and exists (
        select 1 from public.establishments e
        where e.id=p_establishment_id and e.organization_id=p_organization_id
      )
  );
$$;

create or replace function public.can_create_establishment(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organization_members om
    join public.member_establishment_roles mer on mer.member_id=om.id and mer.organization_id=om.organization_id
    join public.roles r on r.id=mer.role_id and r.organization_id=om.organization_id and r.is_active
    where om.organization_id=p_organization_id
      and om.user_id=(select auth.uid())
      and om.status='active'
      and r.key in ('owner','administrator')
  );
$$;

-- Le controle temporel est centralise avant toute evaluation de permission.
create or replace function public.has_permission_at(
  p_organization_id uuid,p_establishment_id uuid,p_permission_key text
)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_assignment uuid; v_role uuid;
begin
  if p_establishment_id is null
     or not public.establishment_business_access_allowed(p_organization_id,p_establishment_id)
     or not public.is_active_member(p_organization_id) then return false; end if;
  select mer.id,mer.role_id into v_assignment,v_role
  from public.organization_members om
  join public.member_establishment_roles mer on mer.member_id=om.id
  join public.roles r on r.id=mer.role_id and r.is_active
  where om.organization_id=p_organization_id and om.user_id=auth.uid()
    and om.status='active' and mer.organization_id=p_organization_id
    and mer.establishment_id=p_establishment_id limit 1;
  if v_assignment is null then return false; end if;
  if exists(select 1 from public.member_establishment_permissions
            where assignment_id=v_assignment and permission_key=p_permission_key and effect='revoke') then return false; end if;
  if exists(select 1 from public.member_establishment_permissions
            where assignment_id=v_assignment and permission_key=p_permission_key and effect='grant') then return true; end if;
  if exists(select 1 from public.user_permissions where organization_id=p_organization_id
            and user_id=auth.uid() and permission_key=p_permission_key and effect='revoke') then return false; end if;
  if exists(select 1 from public.user_permissions where organization_id=p_organization_id
            and user_id=auth.uid() and permission_key=p_permission_key and effect='grant') then return true; end if;
  return exists(select 1 from public.role_permissions where role_id=v_role and permission_key=p_permission_key);
end;
$$;

create or replace function public.member_in_scope(
  p_organization_id uuid,p_establishment_id uuid default null,p_employee_id uuid default null,
  p_team_id text default null,p_service_id text default null
)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_member uuid; v_employee uuid; v_role text;
begin
  if p_establishment_id is null and p_employee_id is not null then
    select establishment_id into p_establishment_id from public.employees
    where id=p_employee_id and organization_id=p_organization_id;
  end if;
  if p_establishment_id is null
     or not public.establishment_business_access_allowed(p_organization_id,p_establishment_id) then return false; end if;
  select om.id,om.employee_id,r.key into v_member,v_employee,v_role
  from public.organization_members om
  join public.member_establishment_roles mer on mer.member_id=om.id and mer.establishment_id=p_establishment_id
  join public.roles r on r.id=mer.role_id and r.is_active
  where om.organization_id=p_organization_id and om.user_id=auth.uid() and om.status='active' limit 1;
  if v_member is null then return false; end if;
  if v_role='employee' then return p_employee_id is not null and p_employee_id=v_employee; end if;
  return true;
end;
$$;

create or replace function public.can_access_establishment(
  p_organization_id uuid,p_establishment_id uuid,p_action text
)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select case
    when p_action in ('view','update') and public.can_administer_establishment_access(p_organization_id,p_establishment_id)
      then true
    else public.has_permission_at(p_organization_id,p_establishment_id,'establishments.'||p_action)
      and public.member_in_scope(p_organization_id,p_establishment_id,null,null,null)
  end;
$$;

create or replace function public.can_access_self_service(
  p_organization_id uuid,p_employee_id uuid,p_action text
)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists (
    select 1 from public.employees e
    where e.id=p_employee_id and e.organization_id=p_organization_id
      and public.establishment_business_access_allowed(p_organization_id,e.establishment_id)
      and (
        (public.current_employee_id(p_organization_id)=p_employee_id and p_action in ('view','update'))
        or (
          public.has_permission_at(p_organization_id,e.establishment_id,'employees.'||p_action)
          and public.member_in_scope(p_organization_id,e.establishment_id,e.id,e.team_id,e.service_id)
        )
      )
  );
$$;

create or replace function public.can_access_hr_employee(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,p_action text default 'view'
)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.establishment_business_access_allowed(p_organization_id,p_establishment_id)
    and public.is_active_member(p_organization_id)
    and public.has_hr_document_action(p_organization_id,p_action)
    and (
      public.current_employee_id(p_organization_id)=p_employee_id
      or public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,null,null)
    );
$$;

create or replace function public.can_access_hr_document_values(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,
  p_employee_visible boolean,p_manager_visible boolean,p_deleted_at timestamptz,p_action text
)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_own boolean;
begin
  if not public.establishment_business_access_allowed(p_organization_id,p_establishment_id)
     or not public.is_active_member(p_organization_id)
     or not public.has_hr_document_action(p_organization_id,p_action) then return false; end if;
  if p_deleted_at is not null and p_action in ('view','download','audit')
     and not public.has_hr_document_action(p_organization_id,'restore') then return false; end if;
  v_own := public.current_employee_id(p_organization_id)=p_employee_id;
  if v_own then
    if p_action in ('view','download','audit') then return coalesce(p_employee_visible,false); end if;
    return true;
  end if;
  if not public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,null,null) then return false; end if;
  if public.has_permission_at(p_organization_id,p_establishment_id,'documents.view_sensitive')
     or public.has_permission_at(p_organization_id,p_establishment_id,'documents.manage') then return true; end if;
  if p_action in ('view','download','audit') then return coalesce(p_manager_visible,false); end if;
  return true;
end;
$$;

create or replace function public.can_read_planning_publication(p_publication_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists (
    select 1 from public.planning_publications p
    where p.id=p_publication_id
      and public.establishment_business_access_allowed(p.organization_id,p.establishment_id)
      and (
        public.can_publish_planning(p.organization_id,p.establishment_id)
        or exists (
          select 1 from public.planning_publication_recipients r
          where r.publication_id=p.id
            and r.employee_id=public.current_employee_id(p.organization_id)
        )
      )
  );
$$;

create or replace function public.can_publish_planning(p_organization_id uuid,p_establishment_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.establishment_business_access_allowed(p_organization_id,p_establishment_id)
    and public.has_permission_at(p_organization_id,p_establishment_id,'planning.publish')
    and public.member_in_scope(p_organization_id,p_establishment_id,null,null,null)
    and exists (
      select 1 from public.establishments e
      where e.id=p_establishment_id and e.organization_id=p_organization_id
    );
$$;

create or replace function public.can_manage_clock_device(
  p_organization_id uuid,p_establishment_id uuid,p_permission_key text
)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select p_permission_key=any(array[
      'clock_devices.view','clock_devices.create','clock_devices.update','clock_devices.disable','clock_devices.delete'
    ])
    and public.establishment_business_access_allowed(p_organization_id,p_establishment_id)
    and public.has_permission_at(p_organization_id,p_establishment_id,p_permission_key)
    and public.member_in_scope(p_organization_id,p_establishment_id,null,null,null);
$$;

create or replace function public.can_manage_time_clock(
  p_organization_id uuid,p_establishment_id uuid
)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select public.establishment_business_access_allowed(p_organization_id,p_establishment_id)
    and public.member_in_scope(p_organization_id,p_establishment_id,null,null,null)
    and (
      public.has_permission_at(p_organization_id,p_establishment_id,'pointage.edit_schedule')
      or public.has_permission_at(p_organization_id,p_establishment_id,'pointage.suspend_device')
      or public.has_permission_at(p_organization_id,p_establishment_id,'pointage.reactivate_device')
    );
$$;

create or replace function public.can_read_planning_publication_object(p_path text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select exists (
    select 1 from public.planning_publications p
    where p.global_pdf_path=p_path
      and public.establishment_business_access_allowed(p.organization_id,p.establishment_id)
      and public.can_publish_planning(p.organization_id,p.establishment_id)
  ) or exists (
    select 1 from public.planning_publication_recipients r
    where r.individual_pdf_path=p_path
      and public.establishment_business_access_allowed(r.organization_id,r.establishment_id)
      and (
        public.can_publish_planning(r.organization_id,r.establishment_id)
        or r.employee_id=public.current_employee_id(r.organization_id)
      )
  );
$$;

create or replace function public.get_establishment_access_state(p_establishment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare v_result jsonb;
begin
  select jsonb_build_object(
    'organization_id',e.organization_id,
    'establishment_id',e.id,
    'establishment_name',e.name,
    'access_starts_at',e.access_starts_at,
    'access_expires_at',e.access_expires_at,
    'access_suspended_at',e.access_suspended_at,
    'access_suspension_reason',e.access_suspension_reason,
    'access_version',e.access_version,
    'access_status',public.establishment_access_status_at(e.access_starts_at,e.access_expires_at,e.access_suspended_at),
    'alert_days',public.establishment_access_alert_days_at(e.access_starts_at,e.access_expires_at,e.access_suspended_at),
    'server_now',statement_timestamp(),
    'can_administer_access',public.can_administer_establishment_access(e.organization_id,e.id)
  ) into v_result
  from public.establishments e
  where e.id=p_establishment_id
    and (
      public.can_administer_establishment_access(e.organization_id,e.id)
      or exists (
        select 1 from public.organization_members om
        join public.member_establishment_roles mer on mer.member_id=om.id
        where om.organization_id=e.organization_id and om.user_id=auth.uid()
          and om.status='active' and mer.establishment_id=e.id
      )
    );
  if v_result is null then raise exception 'Not authorized to view establishment access'; end if;
  return v_result;
end;
$$;

create or replace function public.get_access_context()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id',om.organization_id,'organization_name',o.name,'member_id',om.id,
    'status',om.status,'role_id',primary_role.id,'role_key',primary_role.key,
    'role_label',case when primary_role.key='owner' then 'Administrateur' else primary_role.label end,
    'role_rank',primary_role.rank,'role_is_active',primary_role.is_active,
    'is_read_only',primary_role.is_read_only,'primary_establishment_id',primary_assignment.establishment_id,
    'employee_id',om.employee_id,
    'access_status',public.establishment_access_status_at(primary_establishment.access_starts_at,primary_establishment.access_expires_at,primary_establishment.access_suspended_at),
    'access_starts_at',primary_establishment.access_starts_at,
    'access_expires_at',primary_establishment.access_expires_at,
    'access_suspended_at',primary_establishment.access_suspended_at,
    'access_suspension_reason',primary_establishment.access_suspension_reason,
    'access_version',primary_establishment.access_version,
    'access_server_now',statement_timestamp(),
    'can_administer_access',public.can_administer_establishment_access(om.organization_id,primary_assignment.establishment_id),
    'permissions',coalesce((select jsonb_agg(jsonb_build_object(
      'key',p.key,'allowed',public.has_permission_at(om.organization_id,primary_assignment.establishment_id,p.key)
    )) from public.permissions p),'[]'::jsonb),
    'establishment_access',coalesce((select jsonb_agg(jsonb_build_object(
      'assignment_id',mer.id,'establishment_id',mer.establishment_id,'establishment_name',e.name,'role_id',r.id,
      'role_key',r.key,'role_label',case when r.key='owner' then 'Administrateur' else r.label end,
      'role_rank',r.rank,'is_primary',mer.is_primary,
      'access_status',public.establishment_access_status_at(e.access_starts_at,e.access_expires_at,e.access_suspended_at),
      'access_starts_at',e.access_starts_at,'access_expires_at',e.access_expires_at,
      'access_suspended_at',e.access_suspended_at,'access_suspension_reason',e.access_suspension_reason,
      'access_version',e.access_version,
      'alert_days',public.establishment_access_alert_days_at(e.access_starts_at,e.access_expires_at,e.access_suspended_at),
      'can_administer_access',public.can_administer_establishment_access(om.organization_id,e.id),
      'permissions',coalesce((select jsonb_agg(jsonb_build_object(
        'key',permission.key,'allowed',public.has_permission_at(om.organization_id,mer.establishment_id,permission.key)
      )) from public.permissions permission),'[]'::jsonb)
    ) order by mer.is_primary desc,e.name)
      from public.member_establishment_roles mer join public.roles r on r.id=mer.role_id and r.is_active
      join public.establishments e on e.id=mer.establishment_id where mer.member_id=om.id),'[]'::jsonb)
  )),'[]'::jsonb)
  from public.organization_members om join public.organizations o on o.id=om.organization_id
  join lateral (
    select mer.* from public.member_establishment_roles mer where mer.member_id=om.id
    order by (mer.establishment_id=om.primary_establishment_id) desc,mer.is_primary desc,mer.created_at,mer.id limit 1
  ) primary_assignment on true
  join public.establishments primary_establishment on primary_establishment.id=primary_assignment.establishment_id
  join public.roles primary_role on primary_role.id=primary_assignment.role_id and primary_role.is_active
  where om.user_id=auth.uid() and om.status='active';
$$;

create or replace function public.guard_establishment_access_fields()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if new.access_starts_at is distinct from old.access_starts_at
     or new.access_expires_at is distinct from old.access_expires_at
     or new.access_suspended_at is distinct from old.access_suspended_at
     or new.access_suspension_reason is distinct from old.access_suspension_reason then
    if not public.can_administer_establishment_access(old.organization_id,old.id) then
      raise exception using errcode='P0001',message='STORE_ACCESS_ADMIN_REQUIRED';
    end if;
    if new.access_expires_at is not null and new.access_expires_at <= new.access_starts_at then
      raise exception using errcode='22007',message='STORE_ACCESS_INVALID_RANGE';
    end if;
    new.access_version := old.access_version + 1;
  else
    new.access_version := old.access_version;
  end if;
  -- Une fois l'accès fermé, le contournement administrateur ne sert qu'à
  -- prolonger/réactiver l'accès. Il ne permet pas de modifier silencieusement
  -- les autres données du magasin.
  if not public.establishment_business_access_allowed(old.organization_id,old.id)
     and (to_jsonb(new) - array[
       'access_starts_at','access_expires_at','access_suspended_at',
       'access_suspension_reason','access_version','updated_at','updated_by'
     ]) is distinct from (to_jsonb(old) - array[
       'access_starts_at','access_expires_at','access_suspended_at',
       'access_suspension_reason','access_version','updated_at','updated_by'
     ]) then
    raise exception using errcode='P0001',message='STORE_ACCESS_EXPIRED';
  end if;
  return new;
end;
$$;

create or replace function public.audit_establishment_access_change()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_action text;
begin
  if tg_op='INSERT' then
    v_action := 'created';
  elsif new.access_suspended_at is not null and old.access_suspended_at is null then
    v_action := 'suspended';
  elsif new.access_suspended_at is null and old.access_suspended_at is not null then
    v_action := 'reactivated';
  elsif new.access_expires_at is null and old.access_expires_at is not null then
    v_action := 'made_unlimited';
  elsif old.access_expires_at is not null and new.access_expires_at > old.access_expires_at then
    v_action := 'extended';
  elsif new.access_starts_at > statement_timestamp() then
    v_action := 'scheduled';
  elsif new.access_expires_at is not null then
    v_action := 'limited';
  else
    v_action := 'window_changed';
  end if;
  insert into public.establishment_access_events(
    organization_id,establishment_id,action,
    old_starts_at,new_starts_at,old_expires_at,new_expires_at,
    old_suspended_at,new_suspended_at,actor_user_id,reason,access_version
  ) values(
    new.organization_id,new.id,v_action,
    case when tg_op='UPDATE' then old.access_starts_at end,new.access_starts_at,
    case when tg_op='UPDATE' then old.access_expires_at end,new.access_expires_at,
    case when tg_op='UPDATE' then old.access_suspended_at end,new.access_suspended_at,
    auth.uid(),new.access_suspension_reason,new.access_version
  );
  return new;
end;
$$;

drop trigger if exists establishments_guard_access_fields on public.establishments;
create trigger establishments_guard_access_fields
before update
on public.establishments for each row execute function public.guard_establishment_access_fields();

drop trigger if exists establishments_audit_access_insert on public.establishments;
create trigger establishments_audit_access_insert
after insert on public.establishments for each row execute function public.audit_establishment_access_change();

drop trigger if exists establishments_audit_access_update on public.establishments;
create trigger establishments_audit_access_update
after update of access_starts_at,access_expires_at,access_suspended_at,access_suspension_reason
on public.establishments for each row
when (
  old.access_starts_at is distinct from new.access_starts_at
  or old.access_expires_at is distinct from new.access_expires_at
  or old.access_suspended_at is distinct from new.access_suspended_at
  or old.access_suspension_reason is distinct from new.access_suspension_reason
)
execute function public.audit_establishment_access_change();

create or replace function public.set_establishment_access(
  p_establishment_id uuid,
  p_access_starts_at timestamptz,
  p_access_expires_at timestamptz default null,
  p_suspended boolean default false,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_establishment public.establishments%rowtype;
begin
  select * into v_establishment from public.establishments where id=p_establishment_id for update;
  if not found or not public.can_administer_establishment_access(v_establishment.organization_id,v_establishment.id) then
    raise exception using errcode='P0001',message='STORE_ACCESS_ADMIN_REQUIRED';
  end if;
  if p_access_starts_at is null or (p_access_expires_at is not null and p_access_expires_at <= p_access_starts_at) then
    raise exception using errcode='22007',message='STORE_ACCESS_INVALID_RANGE';
  end if;
  if p_suspended and nullif(trim(coalesce(p_reason,'')),'') is null then
    raise exception using errcode='22023',message='STORE_ACCESS_SUSPENSION_REASON_REQUIRED';
  end if;
  update public.establishments set
    access_starts_at=p_access_starts_at,
    access_expires_at=p_access_expires_at,
    access_suspended_at=case when p_suspended then coalesce(access_suspended_at,statement_timestamp()) else null end,
    access_suspension_reason=case when p_suspended then left(trim(p_reason),500) else null end,
    updated_by=auth.uid(),updated_at=statement_timestamp()
  where id=p_establishment_id;
  return public.get_establishment_access_state(p_establishment_id);
end;
$$;

-- Toute ecriture faite par une RPC SECURITY DEFINER reste soumise a l'etat du magasin.
create or replace function public.enforce_establishment_business_write()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_org uuid; v_establishment uuid; v_old jsonb;
begin
  v_org := case when tg_op='DELETE' then old.organization_id else new.organization_id end;
  v_establishment := case when tg_op='DELETE' then old.establishment_id else new.establishment_id end;
  -- La purge interne des codes expirés reste possible sans rouvrir le magasin.
  if tg_table_name='time_clock_device_activation_codes' and tg_op='DELETE' then
    v_old := to_jsonb(old);
    if v_old->>'used_at' is null
       and (v_old->>'expires_at')::timestamptz < statement_timestamp() - interval '1 day' then
      return old;
    end if;
  end if;
  perform public.assert_establishment_business_access(v_org,v_establishment);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'business_records','employees','employee_document_folders','documents',
    'planning_publications','planning_publication_recipients',
    'time_clock_device_activation_codes','time_clock_devices','time_clock_events'
  ] loop
    if to_regclass('public.'||v_table) is not null then
      execute format('drop trigger if exists %I on public.%I','enforce_store_access_write',v_table);
      execute format(
        'create trigger %I before insert or update or delete on public.%I for each row execute function public.enforce_establishment_business_write()',
        'enforce_store_access_write',v_table
      );
    end if;
  end loop;
end $$;

alter table public.establishment_access_events enable row level security;
drop policy if exists establishment_access_events_select on public.establishment_access_events;
create policy establishment_access_events_select on public.establishment_access_events
for select to authenticated using (
  public.can_administer_establishment_access(organization_id,establishment_id)
);

drop policy if exists establishments_select on public.establishments;
create policy establishments_select on public.establishments for select to authenticated using (
  public.can_access_establishment(organization_id,id,'view')
);
drop policy if exists establishments_insert on public.establishments;
create policy establishments_insert on public.establishments for insert to authenticated with check (
  public.can_create_establishment(organization_id)
);
drop policy if exists establishments_update on public.establishments;
create policy establishments_update on public.establishments for update to authenticated using (
  public.can_access_establishment(organization_id,id,'update')
) with check (
  public.can_access_establishment(organization_id,id,'update')
);

-- Les politiques restrictives ne peuvent pas etre annulees par une politique
-- permissive historique. Elles constituent une seconde barriere RLS explicite.
drop policy if exists store_access_business_records on public.business_records;
create policy store_access_business_records on public.business_records as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_employees on public.employees;
create policy store_access_employees on public.employees as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_employee_document_folders on public.employee_document_folders;
create policy store_access_employee_document_folders on public.employee_document_folders as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_documents on public.documents;
create policy store_access_documents on public.documents as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_planning_publications on public.planning_publications;
create policy store_access_planning_publications on public.planning_publications as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_planning_recipients on public.planning_publication_recipients;
create policy store_access_planning_recipients on public.planning_publication_recipients as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_time_clock_events on public.time_clock_events;
create policy store_access_time_clock_events on public.time_clock_events as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_time_clock_devices on public.time_clock_devices;
create policy store_access_time_clock_devices on public.time_clock_devices as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_time_clock_activation_codes on public.time_clock_device_activation_codes;
create policy store_access_time_clock_activation_codes on public.time_clock_device_activation_codes as restrictive
for all to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
) with check (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_document_audit_logs on public.document_audit_logs;
create policy store_access_document_audit_logs on public.document_audit_logs as restrictive
for select to authenticated using (
  public.establishment_business_access_allowed(organization_id,establishment_id)
);
drop policy if exists store_access_audit_logs on public.audit_logs;
create policy store_access_audit_logs on public.audit_logs as restrictive
for select to authenticated using (
  establishment_id is not null
  and public.establishment_business_access_allowed(organization_id,establishment_id)
);

revoke all on public.establishment_access_events from public,anon,authenticated;
grant select on public.establishment_access_events to authenticated;

revoke all on function public.establishment_business_access_allowed(uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.assert_establishment_business_access(uuid,uuid) from public,anon,authenticated;
revoke all on function public.can_administer_establishment_access(uuid,uuid) from public,anon,authenticated;
revoke all on function public.can_create_establishment(uuid) from public,anon,authenticated;
revoke all on function public.get_establishment_access_state(uuid) from public,anon,authenticated;
revoke all on function public.set_establishment_access(uuid,timestamptz,timestamptz,boolean,text) from public,anon,authenticated;
revoke all on function public.guard_establishment_access_fields() from public,anon,authenticated;
revoke all on function public.audit_establishment_access_change() from public,anon,authenticated;
revoke all on function public.enforce_establishment_business_write() from public,anon,authenticated;
grant execute on function public.establishment_business_access_allowed(uuid,uuid,timestamptz) to authenticated;
grant execute on function public.can_administer_establishment_access(uuid,uuid) to authenticated;
grant execute on function public.get_establishment_access_state(uuid) to authenticated;
grant execute on function public.set_establishment_access(uuid,timestamptz,timestamptz,boolean,text) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='establishments'
  ) then
    alter publication supabase_realtime add table public.establishments;
  end if;
end $$;

comment on column public.establishments.access_expires_at is 'NULL signifie un acces sans echeance.';
comment on table public.establishment_access_events is 'Journal append-only des changements de fenetre d acces des etablissements.';
comment on function public.establishment_business_access_allowed(uuid,uuid,timestamptz) is 'Barriere temporelle centrale des donnees metier par etablissement.';

commit;
