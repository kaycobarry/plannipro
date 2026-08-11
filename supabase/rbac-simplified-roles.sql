-- PlanniPro - profils metier simplifies et autorisations par etablissement.
-- A executer apres schema.sql et rbac-advanced.sql.
-- Migration transactionnelle, idempotente et sans suppression de donnees metier.

begin;

-- Les roles historiques restent disponibles pour la compatibilite et l'audit.
-- L'interface courante n'expose plus que administrator, manager, supervisor et
-- employee. owner et time_clock restent des roles techniques non attribuables.
insert into public.roles (
  organization_id, key, label, rank, is_system, is_read_only, is_active,
  permissions_initialized_at
)
select o.id, 'supervisor', 'Superviseur', 40, true, false, true, now()
from public.organizations o
on conflict (organization_id, key) do update
set label='Superviseur', rank=40, is_system=true, is_read_only=false, is_active=true;

update public.roles set label='Administrateur'
where key='administrator' and label is distinct from 'Administrateur';
update public.roles set label='Manager'
where key='manager' and label is distinct from 'Manager';
update public.roles set label='Employe'
where key='employee' and label is distinct from 'Employe';

-- Matrices standards lisibles. owner conserve sa matrice technique complete.
delete from public.role_permissions rp
using public.roles r
where r.id=rp.role_id and r.key in ('administrator','manager','supervisor','employee');

insert into public.role_permissions(role_id,permission_key)
select r.id,p.key
from public.roles r
join public.permissions p on true
where r.key='administrator'
  and p.key not in ('pointage.manage_settings','users.manage_users')
on conflict do nothing;

insert into public.role_permissions(role_id,permission_key)
select r.id,p.key
from public.roles r
join public.permissions p on p.key=any(array[
  'dashboard.view','planning.view','planning.create','planning.update','planning.move',
  'planning.copy','planning.delete','planning.publish','planning.lock','planning.unlock',
  'planning.export','planning.print','employees.view','employees.create','employees.update',
  'team.view','pointage.view','pointage.correct','pointage.validate','timesheets.view',
  'timesheets.update','leaves.view','leaves.update','leaves.validate','leaves.refuse',
  'register.view','register.export','reports.view','reports.export','establishments.view',
  'users.view'
])
where r.key='manager'
on conflict do nothing;

insert into public.role_permissions(role_id,permission_key)
select r.id,p.key
from public.roles r
join public.permissions p on p.key=any(array[
  'dashboard.view','planning.view','planning.create','planning.update','planning.move',
  'planning.copy','planning.print','employees.view','team.view','pointage.view',
  'pointage.validate','timesheets.view','leaves.view','leaves.update','reports.view',
  'establishments.view'
])
where r.key='supervisor'
on conflict do nothing;

insert into public.role_permissions(role_id,permission_key)
select r.id,p.key
from public.roles r
join public.permissions p on p.key=any(array[
  'dashboard.view','planning.view','employees.view','establishments.view','pointage.view',
  'pointage.badge','timesheets.view','leaves.view','leaves.request','leaves.cancel',
  'documents.view'
])
where r.key='employee'
on conflict do nothing;

create table if not exists public.member_establishment_roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  member_id uuid not null references public.organization_members(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete cascade,
  role_id uuid not null references public.roles(id) on delete restrict,
  is_primary boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(member_id,establishment_id)
);

create table if not exists public.member_establishment_permissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  assignment_id uuid not null references public.member_establishment_roles(id) on delete cascade,
  permission_key text not null references public.permissions(key) on delete cascade,
  effect public.permission_effect not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(assignment_id,permission_key)
);

-- Le trigger est recréé après la copie des exceptions historiques. Le retirer
-- ici rend également une seconde exécution de la migration idempotente.
drop trigger if exists member_establishment_permissions_validate on public.member_establishment_permissions;

create index if not exists member_establishment_roles_lookup_idx
  on public.member_establishment_roles(organization_id,establishment_id,member_id);
create index if not exists member_establishment_roles_role_idx
  on public.member_establishment_roles(role_id);
create index if not exists member_establishment_permissions_assignment_idx
  on public.member_establishment_permissions(assignment_id,permission_key,effect);

create or replace function public.validate_member_establishment_role()
returns trigger language plpgsql set search_path=public as $$
declare v_member_org uuid; v_establishment_org uuid; v_role_org uuid; v_role_key text;
begin
  select organization_id into v_member_org from public.organization_members where id=new.member_id;
  select organization_id into v_establishment_org from public.establishments where id=new.establishment_id;
  select organization_id,key into v_role_org,v_role_key from public.roles where id=new.role_id and is_active;
  if v_member_org is null or v_member_org<>new.organization_id
     or v_establishment_org is null or v_establishment_org<>new.organization_id
     or v_role_org is null or v_role_org<>new.organization_id then
    raise exception 'Affectation inter-organisation interdite';
  end if;
  if v_role_key not in ('owner','administrator','manager','supervisor','employee','time_clock') then
    raise exception 'Ce role historique ne peut pas etre attribue a un etablissement';
  end if;
  return new;
end;
$$;

drop trigger if exists member_establishment_roles_validate on public.member_establishment_roles;
create trigger member_establishment_roles_validate before insert or update
on public.member_establishment_roles for each row
execute function public.validate_member_establishment_role();

-- Conversion deterministe des anciens roles. Les droits differents de la
-- matrice cible sont recopies ensuite sous forme d'exceptions afin qu'aucun
-- utilisateur existant ne gagne ou ne perde un droit pendant la migration.
drop table if exists pg_temp.pp_role_mapping;
create temporary table pp_role_mapping on commit drop as
select legacy.id legacy_role_id, target.id target_role_id
from public.roles legacy
join public.roles target on target.organization_id=legacy.organization_id
 and target.key=case
   when legacy.key in ('owner','administrator','manager','employee','time_clock') then legacy.key
   when legacy.key in ('hr_manager','store_manager') then 'manager'
   when legacy.key='readonly' then 'employee'
   when legacy.rank>=60 then 'manager'
   when legacy.rank>=30 then 'supervisor'
   else 'employee'
 end;

-- owner conserve son perimetre organisationnel historique. Les autres membres
-- recoivent leur etablissement principal et les etablissements deja scopes.
insert into public.member_establishment_roles(
  organization_id,member_id,establishment_id,role_id,is_primary,created_by
)
select om.organization_id,om.id,e.id,m.target_role_id,
       (e.id=om.primary_establishment_id),om.user_id
from public.organization_members om
join public.roles legacy on legacy.id=om.role_id
join pp_role_mapping m on m.legacy_role_id=om.role_id
join public.establishments e on e.organization_id=om.organization_id
where legacy.key='owner'
   or e.id=om.primary_establishment_id
   or exists(
     select 1 from public.manager_scopes ms
     where ms.member_id=om.id and (
       ms.scope_type='organization'
       or (ms.scope_type in ('establishment','team','service') and ms.establishment_id=e.id)
     )
   )
on conflict(member_id,establishment_id) do nothing;

-- Une organisation historique sans etablissement n'est pas inventee ici. Une
-- organisation avec etablissements mais sans primary recoit le premier site.
insert into public.member_establishment_roles(
  organization_id,member_id,establishment_id,role_id,is_primary,created_by
)
select om.organization_id,om.id,e.id,m.target_role_id,true,om.user_id
from public.organization_members om
join pp_role_mapping m on m.legacy_role_id=om.role_id
join lateral (
  select id from public.establishments
  where organization_id=om.organization_id order by created_at,id limit 1
) e on true
where not exists(select 1 from public.member_establishment_roles mer where mer.member_id=om.id)
on conflict(member_id,establishment_id) do nothing;

-- Preserve exactement la matrice historique des roles remappes.
insert into public.member_establishment_permissions(
  organization_id,assignment_id,permission_key,effect,created_by
)
select mer.organization_id,mer.id,p.key,
       case when legacy_permission.permission_key is not null then 'grant'::public.permission_effect
            else 'revoke'::public.permission_effect end,
       om.user_id
from public.member_establishment_roles mer
join public.organization_members om on om.id=mer.member_id
join pp_role_mapping m on m.legacy_role_id=om.role_id and m.target_role_id=mer.role_id
join public.permissions p on true
left join public.role_permissions legacy_permission
  on legacy_permission.role_id=m.legacy_role_id and legacy_permission.permission_key=p.key
left join public.role_permissions target_permission
  on target_permission.role_id=m.target_role_id and target_permission.permission_key=p.key
where m.legacy_role_id<>m.target_role_id
  and ((legacy_permission.permission_key is null)<>(target_permission.permission_key is null))
on conflict(assignment_id,permission_key) do nothing;

-- Les rares exceptions individuelles historiques etaient organisationnelles.
-- Elles sont figees sur chaque affectation existante pour conserver le resultat
-- anterieur sans creer une union de droits entre etablissements.
insert into public.member_establishment_permissions(
  organization_id,assignment_id,permission_key,effect,created_by,created_at
)
select mer.organization_id,mer.id,up.permission_key,up.effect,up.created_by,up.created_at
from public.member_establishment_roles mer
join public.organization_members om on om.id=mer.member_id
join public.user_permissions up on up.organization_id=om.organization_id and up.user_id=om.user_id
on conflict(assignment_id,permission_key) do update set effect=excluded.effect;

-- Toute creation future (bootstrap ou invitation) obtient immediatement son
-- affectation principale. La fonction de validation garantit le tenant.
create or replace function public.sync_member_primary_establishment_role()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_target_role uuid;
begin
  if new.primary_establishment_id is null then return new; end if;
  select target.id into v_target_role
  from public.roles legacy
  join public.roles target on target.organization_id=legacy.organization_id
    and target.key=case
      when legacy.key in ('owner','administrator','manager','employee','time_clock','supervisor') then legacy.key
      when legacy.key in ('hr_manager','store_manager') then 'manager'
      when legacy.key='readonly' then 'employee'
      when legacy.rank>=60 then 'manager'
      when legacy.rank>=30 then 'supervisor'
      else 'employee'
    end
  where legacy.id=new.role_id;
  if v_target_role is null then raise exception 'Aucun profil standard compatible'; end if;
  insert into public.member_establishment_roles(
    organization_id,member_id,establishment_id,role_id,is_primary,created_by,updated_at
  ) values(
    new.organization_id,new.id,new.primary_establishment_id,v_target_role,true,new.user_id,now()
  ) on conflict(member_id,establishment_id) do update
    set is_primary=true,updated_at=now();
  update public.member_establishment_roles set is_primary=false
  where member_id=new.id and establishment_id<>new.primary_establishment_id and is_primary;
  return new;
end;
$$;

drop trigger if exists organization_members_sync_primary_role on public.organization_members;
create trigger organization_members_sync_primary_role after insert or update of primary_establishment_id
on public.organization_members for each row
execute function public.sync_member_primary_establishment_role();

create or replace function public.sync_owner_role_to_new_establishment()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.member_establishment_roles(
    organization_id,member_id,establishment_id,role_id,is_primary,created_by
  )
  select new.organization_id,om.id,new.id,r.id,false,om.user_id
  from public.organization_members om join public.roles r on r.id=om.role_id and r.key='owner'
  where om.organization_id=new.organization_id and om.status='active'
  on conflict(member_id,establishment_id) do nothing;
  return new;
end;
$$;

drop trigger if exists establishments_sync_owner_role on public.establishments;
create trigger establishments_sync_owner_role after insert on public.establishments
for each row execute function public.sync_owner_role_to_new_establishment();

create or replace function public.current_establishment_role_rank(
  p_organization_id uuid,p_establishment_id uuid
)
returns integer language sql stable security definer set search_path=public as $$
  select r.rank
  from public.organization_members om
  join public.member_establishment_roles mer on mer.member_id=om.id
    and mer.organization_id=om.organization_id and mer.establishment_id=p_establishment_id
  join public.roles r on r.id=mer.role_id and r.is_active
  where om.organization_id=p_organization_id and om.user_id=auth.uid() and om.status='active'
  limit 1;
$$;

create or replace function public.current_role_rank(p_organization_id uuid)
returns integer language sql stable security definer set search_path=public as $$
  select r.rank
  from public.organization_members om
  join lateral (
    select role_id from public.member_establishment_roles mer
    where mer.member_id=om.id
    order by (mer.establishment_id=om.primary_establishment_id) desc,mer.is_primary desc,mer.created_at,mer.id limit 1
  ) primary_assignment on true
  join public.roles r on r.id=primary_assignment.role_id and r.is_active
  where om.organization_id=p_organization_id and om.user_id=auth.uid() and om.status='active' limit 1;
$$;

create or replace function public.has_permission_at(
  p_organization_id uuid,p_establishment_id uuid,p_permission_key text
)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare v_assignment uuid; v_role uuid;
begin
  if p_establishment_id is null or not public.is_active_member(p_organization_id) then return false; end if;
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
  -- Compatibilite des invitations et exceptions creees avant cette migration.
  if exists(select 1 from public.user_permissions where organization_id=p_organization_id
            and user_id=auth.uid() and permission_key=p_permission_key and effect='revoke') then return false; end if;
  if exists(select 1 from public.user_permissions where organization_id=p_organization_id
            and user_id=auth.uid() and permission_key=p_permission_key and effect='grant') then return true; end if;
  return exists(select 1 from public.role_permissions where role_id=v_role and permission_key=p_permission_key);
end;
$$;

-- Les anciens appels sans cible explicite restent compatibles s'il existe au
-- moins une affectation qui porte le droit. Chaque lecture/ecriture metier et
-- chaque RPC sensible avec une cible utilise has_permission_at et ne fait donc
-- jamais d'union de privileges entre etablissements.
create or replace function public.has_permission(p_organization_id uuid,p_permission_key text)
returns boolean language plpgsql stable security definer set search_path=public as $$
begin
  if p_permission_key in ('pointage.manage_settings','users.manage_users') then return false; end if;
  return exists(
    select 1 from public.organization_members om
    join public.member_establishment_roles mer on mer.member_id=om.id
    where om.organization_id=p_organization_id and om.user_id=auth.uid() and om.status='active'
      and public.has_permission_at(p_organization_id,mer.establishment_id,p_permission_key)
  );
end;
$$;

create or replace function public.member_in_scope(
  p_organization_id uuid,p_establishment_id uuid default null,p_employee_id uuid default null,
  p_team_id text default null,p_service_id text default null
)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare v_member uuid; v_employee uuid; v_role text;
begin
  if p_establishment_id is null and p_employee_id is not null then
    select establishment_id into p_establishment_id from public.employees
    where id=p_employee_id and organization_id=p_organization_id;
  end if;
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
returns boolean language sql stable security definer set search_path=public as $$
  select public.has_permission_at(p_organization_id,p_establishment_id,'establishments.'||p_action)
     and public.member_in_scope(p_organization_id,p_establishment_id,null,null,null);
$$;

create or replace function public.can_access_employee(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,p_team_id text,p_service_id text,p_action text
)
returns boolean language plpgsql stable security definer set search_path=public as $$
begin
  if public.current_employee_id(p_organization_id)=p_employee_id then
    return p_action='view' and public.has_permission_at(p_organization_id,p_establishment_id,'employees.view');
  end if;
  return public.has_permission_at(p_organization_id,p_establishment_id,'employees.'||p_action)
     and public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,p_team_id,p_service_id);
end;
$$;

create or replace function public.can_access_record(
  p_organization_id uuid,p_record_type text,p_establishment_id uuid,p_employee_id uuid,
  p_team_id text,p_service_id text,p_action text
)
returns boolean language sql stable security definer set search_path=public as $$
  select public.has_permission_at(p_organization_id,p_establishment_id,public.record_module(p_record_type)||'.'||p_action)
     and public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,p_team_id,p_service_id);
$$;

create or replace function public.can_access_document(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,p_action text
)
returns boolean language plpgsql stable security definer set search_path=public as $$
begin
  if p_employee_id is not null and public.current_employee_id(p_organization_id)=p_employee_id then
    return p_action='view' and public.has_permission_at(p_organization_id,p_establishment_id,'documents.view');
  end if;
  return (public.has_permission_at(p_organization_id,p_establishment_id,'documents.'||p_action)
      or (p_action in ('create','update','delete')
          and public.has_permission_at(p_organization_id,p_establishment_id,'documents.manage')))
    and public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,null,null);
end;
$$;

create or replace function public.can_access_private_employee_data(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,
  p_team_id text default null,p_service_id text default null,p_action text default 'view'
)
returns boolean language sql stable security definer set search_path=public as $$
  select public.has_permission_at(p_organization_id,p_establishment_id,'employees.'||p_action||'_sensitive')
     and public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,p_team_id,p_service_id);
$$;

create or replace function public.can_access_self_service(
  p_organization_id uuid,p_employee_id uuid,p_action text
)
returns boolean language sql stable security definer set search_path=public as $$
  select (public.current_employee_id(p_organization_id)=p_employee_id and p_action in ('view','update'))
    or exists(select 1 from public.employees e where e.id=p_employee_id and e.organization_id=p_organization_id
      and public.has_permission_at(p_organization_id,e.establishment_id,'employees.'||p_action)
      and public.member_in_scope(p_organization_id,e.establishment_id,e.id,e.team_id,e.service_id));
$$;

create or replace function public.can_view_user(p_organization_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select p_user_id=auth.uid() or exists(
    select 1 from public.organization_members target_member
    join public.member_establishment_roles target_assignment on target_assignment.member_id=target_member.id
    where target_member.organization_id=p_organization_id and target_member.user_id=p_user_id
      and public.has_permission_at(p_organization_id,target_assignment.establishment_id,'users.view')
      and public.member_in_scope(p_organization_id,target_assignment.establishment_id,target_member.employee_id,null,null)
  );
$$;

create or replace function public.can_manage_user(p_organization_id uuid,p_user_id uuid)
returns boolean language plpgsql stable security definer set search_path=public as $$
begin
  if p_user_id is null or p_user_id=auth.uid() or not public.is_active_member(p_organization_id) then return false; end if;
  if public.is_owner(p_organization_id) then return true; end if;
  return exists(
    select 1 from public.organization_members target where target.organization_id=p_organization_id and target.user_id=p_user_id
  ) and not exists(
    select 1 from public.organization_members target
    join public.member_establishment_roles target_assignment on target_assignment.member_id=target.id
    join public.roles target_role on target_role.id=target_assignment.role_id
    where target.organization_id=p_organization_id and target.user_id=p_user_id and (
      not (
        public.has_permission_at(p_organization_id,target_assignment.establishment_id,'users.disable')
        or public.has_permission_at(p_organization_id,target_assignment.establishment_id,'users.reactivate')
        or public.has_permission_at(p_organization_id,target_assignment.establishment_id,'users.delete')
      )
      or public.current_establishment_role_rank(p_organization_id,target_assignment.establishment_id)<=target_role.rank
    )
  );
end;
$$;

create or replace function public.can_assign_establishment_role(
  p_organization_id uuid,p_establishment_id uuid,p_target_role_id uuid
)
returns boolean language sql stable security definer set search_path=public as $$
  select public.has_permission_at(p_organization_id,p_establishment_id,'users.manage_roles')
     and exists(
       select 1 from public.roles target
       where target.id=p_target_role_id and target.organization_id=p_organization_id
         and target.key in ('administrator','manager','supervisor','employee') and target.is_active
         and public.current_establishment_role_rank(p_organization_id,p_establishment_id)>=target.rank
     );
$$;

create or replace function public.can_manage_invitation(
  p_organization_id uuid,p_role_id uuid,p_primary_establishment_id uuid,p_employee_id uuid
)
returns boolean language sql stable security definer set search_path=public as $$
  select p_primary_establishment_id is not null
    and public.has_permission_at(p_organization_id,p_primary_establishment_id,'users.invite')
    and public.can_assign_establishment_role(p_organization_id,p_primary_establishment_id,p_role_id)
    and public.target_in_scope(p_organization_id,p_primary_establishment_id,p_employee_id);
$$;

create or replace function public.can_view_invitation(
  p_organization_id uuid,p_primary_establishment_id uuid,p_employee_id uuid
)
returns boolean language sql stable security definer set search_path=public as $$
  select p_primary_establishment_id is not null
    and public.has_permission_at(p_organization_id,p_primary_establishment_id,'users.view')
    and public.target_in_scope(p_organization_id,p_primary_establishment_id,p_employee_id);
$$;

create or replace function public.can_access_audit_log(p_organization_id uuid,p_establishment_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select p_establishment_id is not null
    and public.has_permission_at(p_organization_id,p_establishment_id,'audit.view')
    and public.member_in_scope(p_organization_id,p_establishment_id,null,null,null);
$$;

create or replace function public.can_write_record(
  p_organization_id uuid,p_record_type text,p_establishment_id uuid,p_employee_id uuid,
  p_team_id text,p_service_id text,p_action text,p_payload jsonb default '{}'::jsonb
)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare v_permission text; v_allowed boolean:=false;
begin
  if p_record_type='shift' then
    if p_action='create' and nullif(p_payload->>'copiedFrom','') is not null then v_permission:='planning.copy';
    elsif p_action='update' then
      v_allowed:=public.has_permission_at(p_organization_id,p_establishment_id,'planning.update')
        or public.has_permission_at(p_organization_id,p_establishment_id,'planning.move');
    else v_permission:='planning.'||p_action; end if;
  elsif p_record_type='absence' then
    v_permission:=case p_action when 'create' then 'leaves.request' when 'delete' then 'leaves.cancel' else 'leaves.'||p_action end;
  elsif p_record_type='punch' then
    v_permission:=case p_action when 'create' then 'pointage.badge' when 'update' then 'pointage.correct' else 'pointage.'||p_action end;
  elsif p_record_type='register' and p_action<>'view' then v_permission:='register.manage';
  elsif p_record_type='setting' and p_action='update' then
    v_allowed:=public.has_permission_at(p_organization_id,p_establishment_id,'settings.update')
      or public.has_permission_at(p_organization_id,p_establishment_id,'planning.update')
      or public.has_permission_at(p_organization_id,p_establishment_id,'planning.lock')
      or public.has_permission_at(p_organization_id,p_establishment_id,'planning.unlock');
  else v_permission:=public.record_module(p_record_type)||'.'||p_action; end if;
  if v_permission is not null then v_allowed:=public.has_permission_at(p_organization_id,p_establishment_id,v_permission); end if;
  return v_allowed and public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,p_team_id,p_service_id);
end;
$$;

create or replace function public.enforce_business_record_permission()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_added_lock boolean:=false; v_removed_lock boolean:=false; v_shift_moved boolean:=false;
begin
  if new.record_type is distinct from old.record_type or new.legacy_id is distinct from old.legacy_id then
    raise exception 'Record identity is immutable';
  end if;
  if new.record_type='shift' then
    v_shift_moved:=new.establishment_id is distinct from old.establishment_id
      or new.employee_id is distinct from old.employee_id or new.team_id is distinct from old.team_id
      or new.service_id is distinct from old.service_id or new.payload->>'date' is distinct from old.payload->>'date';
    if v_shift_moved and (
      not public.has_permission_at(old.organization_id,old.establishment_id,'planning.move')
      or not public.has_permission_at(new.organization_id,new.establishment_id,'planning.move')
    ) then raise exception 'planning.move is required'; end if;
    if ((new.payload-'date') is distinct from (old.payload-'date') or new.deleted_at is distinct from old.deleted_at)
      and not public.has_permission_at(old.organization_id,old.establishment_id,'planning.update') then
      raise exception 'planning.update is required';
    end if;
  elsif new.record_type='absence'
    and not public.has_permission_at(old.organization_id,old.establishment_id,'leaves.update') then
    raise exception 'leaves.update is required';
  elsif new.record_type='punch'
    and not public.has_permission_at(old.organization_id,old.establishment_id,'pointage.correct') then
    raise exception 'pointage.correct is required';
  elsif new.record_type='register'
    and not public.has_permission_at(old.organization_id,old.establishment_id,'register.manage') then
    raise exception 'register.manage is required';
  elsif new.record_type='setting' then
    if coalesce(new.payload->'locks','{}'::jsonb) is distinct from coalesce(old.payload->'locks','{}'::jsonb) then
      select exists(
        select 1 from jsonb_each(coalesce(new.payload#>'{locks,week}','{}'::jsonb)) n
        where not coalesce(old.payload#>'{locks,week}','{}'::jsonb) ? n.key
        union all
        select 1 from jsonb_each(coalesce(new.payload#>'{locks,day}','{}'::jsonb)) n
        where not coalesce(old.payload#>'{locks,day}','{}'::jsonb) ? n.key
      ) into v_added_lock;
      select exists(
        select 1 from jsonb_each(coalesce(old.payload#>'{locks,week}','{}'::jsonb)) o
        where not coalesce(new.payload#>'{locks,week}','{}'::jsonb) ? o.key
        union all
        select 1 from jsonb_each(coalesce(old.payload#>'{locks,day}','{}'::jsonb)) o
        where not coalesce(new.payload#>'{locks,day}','{}'::jsonb) ? o.key
      ) into v_removed_lock;
      if v_added_lock and not public.has_permission_at(old.organization_id,old.establishment_id,'planning.lock') then raise exception 'planning.lock is required'; end if;
      if v_removed_lock and not public.has_permission_at(old.organization_id,old.establishment_id,'planning.unlock') then raise exception 'planning.unlock is required'; end if;
    end if;
    if coalesce(new.payload->'templates','[]'::jsonb) is distinct from coalesce(old.payload->'templates','[]'::jsonb)
      and not public.has_permission_at(old.organization_id,old.establishment_id,'planning.update') then
      raise exception 'planning.update is required for templates';
    end if;
    if (new.payload-'locks'-'templates'-'weekStart'-'meta') is distinct from (old.payload-'locks'-'templates'-'weekStart'-'meta')
      and not public.has_permission_at(old.organization_id,old.establishment_id,'settings.update') then
      raise exception 'settings.update is required';
    end if;
  elsif not public.has_permission_at(
    old.organization_id,old.establishment_id,public.record_module(new.record_type)||'.update'
  ) then raise exception 'Update permission is required'; end if;
  return new;
end;
$$;

create or replace function public.can_assign_role(p_organization_id uuid,p_target_role_id uuid)
returns boolean language sql stable security definer set search_path=public as $$
  select public.has_permission(p_organization_id,'users.manage_roles')
     and exists(
       select 1 from public.roles target where target.id=p_target_role_id
         and target.organization_id=p_organization_id and target.is_active
         and target.key in ('administrator','manager','supervisor','employee')
         and public.current_role_rank(p_organization_id)>=target.rank
     );
$$;

create or replace function public.can_assign_permission(p_organization_id uuid,p_permission_key text)
returns boolean language sql stable security definer set search_path=public as $$
  select public.has_permission(p_organization_id,'users.manage_permissions')
    and p_permission_key in (
      'planning.publish','pointage.correct','leaves.validate','leaves.refuse',
      'employees.view_sensitive','financial.view'
    )
    and (public.is_owner(p_organization_id) or public.has_permission(p_organization_id,p_permission_key));
$$;

create or replace function public.protect_last_establishment_administrator()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_old_admin boolean; v_new_admin boolean:=false; v_active boolean;
begin
  select r.key in ('owner','administrator'),om.status='active'
    into v_old_admin,v_active
  from public.roles r join public.organization_members om on om.id=old.member_id where r.id=old.role_id;
  if tg_op='UPDATE' then
    select key in ('owner','administrator') into v_new_admin from public.roles where id=new.role_id;
  end if;
  if v_old_admin and v_active and (tg_op='DELETE' or not v_new_admin) then
    perform pg_advisory_xact_lock(hashtextextended(old.organization_id::text||old.establishment_id::text,0));
    if not exists(
      select 1 from public.member_establishment_roles other
      join public.organization_members om on om.id=other.member_id and om.status='active'
      join public.roles r on r.id=other.role_id and r.key in ('owner','administrator') and r.is_active
      where other.organization_id=old.organization_id and other.establishment_id=old.establishment_id
        and other.id<>old.id
    ) then
      raise exception 'Impossible de retirer cet Administrateur : l’établissement doit conserver au moins un Administrateur actif.';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists member_establishment_roles_last_admin on public.member_establishment_roles;
create trigger member_establishment_roles_last_admin before update or delete
on public.member_establishment_roles for each row
execute function public.protect_last_establishment_administrator();

create or replace function public.protect_member_last_establishment_administrator()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if old.status='active' and (tg_op='DELETE' or new.status<>'active') and exists(
    select 1 from public.member_establishment_roles mer join public.roles r on r.id=mer.role_id
    where mer.member_id=old.id and r.key in ('owner','administrator')
  ) then
    if exists(
      select 1 from public.member_establishment_roles mine
      join public.roles mine_role on mine_role.id=mine.role_id and mine_role.key in ('owner','administrator')
      where mine.member_id=old.id and not exists(
        select 1 from public.member_establishment_roles other
        join public.organization_members om on om.id=other.member_id and om.status='active'
        join public.roles r on r.id=other.role_id and r.key in ('owner','administrator') and r.is_active
        where other.establishment_id=mine.establishment_id and other.organization_id=mine.organization_id
          and other.member_id<>old.id
      )
    ) then raise exception 'Impossible de retirer cet Administrateur : l’établissement doit conserver au moins un Administrateur actif.'; end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists organization_members_last_establishment_admin on public.organization_members;
create trigger organization_members_last_establishment_admin before update or delete
on public.organization_members for each row
execute function public.protect_member_last_establishment_administrator();

create or replace function public.set_member_establishment_role(
  p_member_id uuid,p_establishment_id uuid,p_role_id uuid
)
returns public.member_establishment_roles
language plpgsql security definer set search_path=public as $$
declare v_member public.organization_members%rowtype; v_result public.member_establishment_roles; v_previous_role uuid;
begin
  select * into v_member from public.organization_members where id=p_member_id for update;
  if not found or v_member.user_id=auth.uid()
     or not public.can_assign_establishment_role(v_member.organization_id,p_establishment_id,p_role_id) then
    raise exception 'Attribution de role interdite';
  end if;
  if exists(
    select 1 from public.member_establishment_roles current_assignment
    join public.roles assigned_role on assigned_role.id=current_assignment.role_id
    where current_assignment.member_id=p_member_id
      and current_assignment.establishment_id=p_establishment_id
      and assigned_role.rank>public.current_establishment_role_rank(v_member.organization_id,p_establishment_id)
      and not public.is_owner(v_member.organization_id)
  ) then raise exception 'Un profil de niveau superieur ne peut pas etre modifie'; end if;
  select role_id into v_previous_role from public.member_establishment_roles
  where member_id=p_member_id and establishment_id=p_establishment_id;
  insert into public.member_establishment_roles(
    organization_id,member_id,establishment_id,role_id,is_primary,created_by,updated_at
  ) values(
    v_member.organization_id,p_member_id,p_establishment_id,p_role_id,
    p_establishment_id=v_member.primary_establishment_id,auth.uid(),now()
  ) on conflict(member_id,establishment_id) do update
    set role_id=excluded.role_id,updated_at=now()
  returning * into v_result;
  insert into public.audit_logs(
    organization_id,establishment_id,actor_user_id,action,resource_type,resource_id,old_value,new_value,metadata
  ) values(
    v_member.organization_id,p_establishment_id,auth.uid(),'user.establishment_role_changed',
    'organization_member',p_member_id::text,jsonb_build_object('role_id',v_previous_role),
    jsonb_build_object('role_id',p_role_id),jsonb_build_object('assignment_id',v_result.id)
  );
  return v_result;
end;
$$;

create or replace function public.set_member_establishment_exceptions(
  p_assignment_id uuid,p_exceptions jsonb default '[]'::jsonb
)
returns integer language plpgsql security definer set search_path=public as $$
declare v_assignment public.member_establishment_roles%rowtype; v_item jsonb; v_count integer; v_previous jsonb;
begin
  select * into v_assignment from public.member_establishment_roles where id=p_assignment_id for update;
  if not found or not public.has_permission_at(v_assignment.organization_id,v_assignment.establishment_id,'users.manage_permissions') then
    raise exception 'Modification des exceptions interdite';
  end if;
  if exists(
    select 1 from public.roles target where target.id=v_assignment.role_id
      and target.rank>public.current_establishment_role_rank(v_assignment.organization_id,v_assignment.establishment_id)
      and not public.is_owner(v_assignment.organization_id)
  ) then raise exception 'Les exceptions d''un profil superieur ne peuvent pas etre modifiees'; end if;
  if exists(select 1 from jsonb_array_elements(coalesce(p_exceptions,'[]'::jsonb)) as x(value)
            where x.value->>'permission_key' not in ('planning.publish','pointage.correct','leaves.validate','leaves.refuse','employees.view_sensitive','financial.view')
               or x.value->>'effect' not in ('grant','revoke')) then
    raise exception 'Cette exception ne fait pas partie des autorisations avancees disponibles';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('permission_key',permission_key,'effect',effect)),'[]'::jsonb)
    into v_previous from public.member_establishment_permissions where assignment_id=p_assignment_id;
  delete from public.member_establishment_permissions where assignment_id=p_assignment_id;
  for v_item in select value from jsonb_array_elements(coalesce(p_exceptions,'[]'::jsonb)) loop
    insert into public.member_establishment_permissions(
      organization_id,assignment_id,permission_key,effect,created_by
    ) values(
      v_assignment.organization_id,p_assignment_id,v_item->>'permission_key',
      (v_item->>'effect')::public.permission_effect,auth.uid()
    );
  end loop;
  select count(*)::integer into v_count from public.member_establishment_permissions where assignment_id=p_assignment_id;
  insert into public.audit_logs(
    organization_id,establishment_id,actor_user_id,action,resource_type,resource_id,old_value,new_value
  ) values(
    v_assignment.organization_id,v_assignment.establishment_id,auth.uid(),'user.advanced_permissions_changed',
    'member_establishment_role',p_assignment_id::text,v_previous,coalesce(p_exceptions,'[]'::jsonb)
  );
  return v_count;
end;
$$;

create or replace function public.validate_member_establishment_permission()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.permission_key not in (
    'planning.publish','pointage.correct','leaves.validate','leaves.refuse',
    'employees.view_sensitive','financial.view'
  ) then raise exception 'Cette exception avancee n''est pas autorisee'; end if;
  if not exists(
    select 1 from public.member_establishment_roles mer
    where mer.id=new.assignment_id and mer.organization_id=new.organization_id
  ) then raise exception 'Exception inter-organisation interdite'; end if;
  return new;
end;
$$;

drop trigger if exists member_establishment_permissions_validate on public.member_establishment_permissions;
create trigger member_establishment_permissions_validate before insert or update
on public.member_establishment_permissions for each row
execute function public.validate_member_establishment_permission();

create or replace function public.get_access_context()
returns jsonb language sql stable security definer set search_path=public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id',om.organization_id,'organization_name',o.name,'member_id',om.id,
    'status',om.status,'role_id',primary_role.id,'role_key',primary_role.key,
    'role_label',case when primary_role.key='owner' then 'Administrateur' else primary_role.label end,
    'role_rank',primary_role.rank,'role_is_active',primary_role.is_active,
    'is_read_only',primary_role.is_read_only,'primary_establishment_id',primary_assignment.establishment_id,
    'employee_id',om.employee_id,
    'permissions',coalesce((select jsonb_agg(jsonb_build_object(
      'key',p.key,'allowed',public.has_permission_at(om.organization_id,primary_assignment.establishment_id,p.key)
    )) from public.permissions p),'[]'::jsonb),
    'establishment_access',coalesce((select jsonb_agg(jsonb_build_object(
      'assignment_id',mer.id,'establishment_id',mer.establishment_id,'role_id',r.id,
      'role_key',r.key,'role_label',case when r.key='owner' then 'Administrateur' else r.label end,
      'role_rank',r.rank,'is_primary',mer.is_primary,
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
  join public.roles primary_role on primary_role.id=primary_assignment.role_id and primary_role.is_active
  where om.user_id=auth.uid() and om.status='active';
$$;

-- Remplace le seed historique pour que les nouvelles entreprises disposent
-- directement des quatre profils metier. Les roles techniques/anciens restent
-- crees afin que les anciennes invitations et integrations demeurent lisibles.
create or replace function public.seed_organization_roles(p_organization_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_key text; v_role uuid;
begin
  insert into public.roles(
    organization_id,key,label,rank,is_system,is_read_only,is_active,permissions_initialized_at
  ) values
    (p_organization_id,'owner','Administrateur principal',100,true,false,true,now()),
    (p_organization_id,'administrator','Administrateur',90,true,false,true,now()),
    (p_organization_id,'hr_manager','Responsable RH (historique)',80,true,false,false,now()),
    (p_organization_id,'store_manager','Responsable Magasin (historique)',70,true,false,false,now()),
    (p_organization_id,'manager','Manager',60,true,false,true,now()),
    (p_organization_id,'supervisor','Superviseur',40,true,false,true,now()),
    (p_organization_id,'readonly','Lecture seule (historique)',20,true,true,false,now()),
    (p_organization_id,'employee','Employe',10,true,false,true,now()),
    (p_organization_id,'time_clock','Pointeuse',5,true,true,true,now())
  on conflict(organization_id,key) do nothing;

  foreach v_key in array array['owner','administrator'] loop
    select id into v_role from public.roles where organization_id=p_organization_id and key=v_key;
    insert into public.role_permissions(role_id,permission_key)
      select v_role,key from public.permissions
      where key not in ('pointage.manage_settings','users.manage_users') on conflict do nothing;
  end loop;
  select id into v_role from public.roles where organization_id=p_organization_id and key='manager';
  insert into public.role_permissions(role_id,permission_key)
    select v_role,key from public.permissions where key=any(array[
      'dashboard.view','planning.view','planning.create','planning.update','planning.move','planning.copy',
      'planning.delete','planning.publish','planning.lock','planning.unlock','planning.export','planning.print',
      'employees.view','employees.create','employees.update','team.view','pointage.view','pointage.correct',
      'pointage.validate','timesheets.view','timesheets.update','leaves.view','leaves.update',
      'leaves.validate','leaves.refuse','register.view','register.export','reports.view','reports.export',
      'establishments.view','users.view'
    ]) on conflict do nothing;
  select id into v_role from public.roles where organization_id=p_organization_id and key='supervisor';
  insert into public.role_permissions(role_id,permission_key)
    select v_role,key from public.permissions where key=any(array[
      'dashboard.view','planning.view','planning.create','planning.update','planning.move','planning.copy',
      'planning.print','employees.view','team.view','pointage.view','pointage.validate','timesheets.view',
      'leaves.view','leaves.update','reports.view','establishments.view'
    ]) on conflict do nothing;
  select id into v_role from public.roles where organization_id=p_organization_id and key='employee';
  insert into public.role_permissions(role_id,permission_key)
    select v_role,key from public.permissions where key=any(array[
      'dashboard.view','planning.view','employees.view','establishments.view','pointage.view',
      'pointage.badge','timesheets.view','leaves.view','leaves.request','leaves.cancel','documents.view'
    ]) on conflict do nothing;
  select id into v_role from public.roles where organization_id=p_organization_id and key='time_clock';
  insert into public.role_permissions(role_id,permission_key) values(v_role,'pointage.badge') on conflict do nothing;
end;
$$;

alter table public.member_establishment_roles enable row level security;
alter table public.member_establishment_permissions enable row level security;

-- Les matrices standards ne sont plus modifiables depuis le navigateur. Les
-- seuls écarts autorisés passent par la table d'exceptions par établissement.
revoke insert,update,delete on public.roles from authenticated;
revoke insert,update,delete on public.role_permissions from authenticated;
revoke insert,update,delete on public.user_permissions from authenticated;
revoke execute on function public.create_custom_role(uuid,text,smallint) from authenticated;
revoke execute on function public.duplicate_role(uuid,text) from authenticated;
revoke execute on function public.update_role_configuration(uuid,text,boolean) from authenticated;
revoke execute on function public.set_role_permissions(uuid,text[]) from authenticated;

drop policy if exists member_establishment_roles_select on public.member_establishment_roles;
create policy member_establishment_roles_select on public.member_establishment_roles for select to authenticated using (
  exists(select 1 from public.organization_members om where om.id=member_id and om.user_id=auth.uid() and om.status='active')
  or public.has_permission_at(organization_id,establishment_id,'users.view')
);
drop policy if exists member_establishment_roles_insert on public.member_establishment_roles;
create policy member_establishment_roles_insert on public.member_establishment_roles for insert to authenticated with check (
  public.can_assign_establishment_role(organization_id,establishment_id,role_id)
);
drop policy if exists member_establishment_roles_update on public.member_establishment_roles;
create policy member_establishment_roles_update on public.member_establishment_roles for update to authenticated
using (
  public.has_permission_at(organization_id,establishment_id,'users.manage_roles')
  and (public.is_owner(organization_id)
    or public.current_establishment_role_rank(organization_id,establishment_id)>=(select rank from public.roles where id=role_id))
)
with check (public.can_assign_establishment_role(organization_id,establishment_id,role_id));
drop policy if exists member_establishment_roles_delete on public.member_establishment_roles;
create policy member_establishment_roles_delete on public.member_establishment_roles for delete to authenticated using (
  public.has_permission_at(organization_id,establishment_id,'users.manage_roles')
  and public.current_establishment_role_rank(organization_id,establishment_id)>(select rank from public.roles where id=role_id)
);

drop policy if exists member_establishment_permissions_select on public.member_establishment_permissions;
create policy member_establishment_permissions_select on public.member_establishment_permissions for select to authenticated using (
  exists(select 1 from public.member_establishment_roles mer join public.organization_members om on om.id=mer.member_id
    where mer.id=assignment_id and om.user_id=auth.uid() and om.status='active')
  or exists(select 1 from public.member_establishment_roles mer where mer.id=assignment_id
    and public.has_permission_at(mer.organization_id,mer.establishment_id,'users.manage_permissions'))
);
drop policy if exists member_establishment_permissions_all on public.member_establishment_permissions;
create policy member_establishment_permissions_all on public.member_establishment_permissions for all to authenticated
using (exists(select 1 from public.member_establishment_roles mer join public.roles target on target.id=mer.role_id
  where mer.id=assignment_id
    and public.has_permission_at(mer.organization_id,mer.establishment_id,'users.manage_permissions')
    and (public.is_owner(mer.organization_id)
      or public.current_establishment_role_rank(mer.organization_id,mer.establishment_id)>=target.rank)))
with check (exists(select 1 from public.member_establishment_roles mer join public.roles target on target.id=mer.role_id
  where mer.id=assignment_id
    and public.has_permission_at(mer.organization_id,mer.establishment_id,'users.manage_permissions')
    and (public.is_owner(mer.organization_id)
      or public.current_establishment_role_rank(mer.organization_id,mer.establishment_id)>=target.rank)));

revoke all on public.member_establishment_roles from anon;
revoke all on public.member_establishment_permissions from anon;
grant select,insert,update,delete on public.member_establishment_roles to authenticated;
grant select,insert,update,delete on public.member_establishment_permissions to authenticated;

revoke execute on function public.has_permission_at(uuid,uuid,text) from public,anon;
revoke execute on function public.current_establishment_role_rank(uuid,uuid) from public,anon;
revoke execute on function public.can_assign_establishment_role(uuid,uuid,uuid) from public,anon;
revoke execute on function public.set_member_establishment_role(uuid,uuid,uuid) from public,anon;
revoke execute on function public.set_member_establishment_exceptions(uuid,jsonb) from public,anon;
revoke execute on function public.seed_organization_roles(uuid) from public,anon,authenticated;
revoke execute on function public.get_access_context() from public,anon;
revoke execute on function public.validate_member_establishment_role() from public,anon,authenticated;
revoke execute on function public.sync_member_primary_establishment_role() from public,anon,authenticated;
revoke execute on function public.sync_owner_role_to_new_establishment() from public,anon,authenticated;
revoke execute on function public.protect_last_establishment_administrator() from public,anon,authenticated;
revoke execute on function public.protect_member_last_establishment_administrator() from public,anon,authenticated;
revoke execute on function public.validate_member_establishment_permission() from public,anon,authenticated;
grant execute on function public.has_permission_at(uuid,uuid,text) to authenticated;
grant execute on function public.current_establishment_role_rank(uuid,uuid) to authenticated;
grant execute on function public.can_assign_establishment_role(uuid,uuid,uuid) to authenticated;
grant execute on function public.set_member_establishment_role(uuid,uuid,uuid) to authenticated;
grant execute on function public.set_member_establishment_exceptions(uuid,jsonb) to authenticated;
grant execute on function public.get_access_context() to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.member_establishment_roles;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.member_establishment_permissions;
exception when duplicate_object then null; end $$;

commit;
