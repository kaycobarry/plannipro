-- PlanniPro — RBAC avancé et rôles configurables.
-- À exécuter après schema.sql et time-clock.sql sur une base existante.
-- Aucune clé service_role n'est requise par ce script.

begin;

alter table public.roles
  add column if not exists is_active boolean not null default true;
alter table public.roles
  add column if not exists permissions_initialized_at timestamptz;

create index if not exists roles_org_active_rank_idx
  on public.roles (organization_id, is_active, rank desc);

-- Catalogue fonctionnel exhaustif. Les anciennes clés restent présentes pour
-- assurer la compatibilité des données synchronisées et des clients existants.
insert into public.permissions (key, module, action, label, is_sensitive)
values
  ('planning.move', 'planning', 'move', 'Planning · Déplacer', false),
  ('planning.copy', 'planning', 'copy', 'Planning · Copier', false),
  ('planning.publish', 'planning', 'publish', 'Planning · Publier', false),
  ('planning.lock', 'planning', 'lock', 'Planning · Verrouiller', false),
  ('planning.unlock', 'planning', 'unlock', 'Planning · Déverrouiller', false),
  ('pointage.badge', 'pointage', 'badge', 'Pointeuse · Pointer', false),
  ('pointage.correct', 'pointage', 'correct', 'Pointeuse · Corriger', true),
  ('pointage.edit_schedule', 'pointage', 'edit_schedule', 'Pointeuse · Modifier les horaires', true),
  ('pointage.suspend_device', 'pointage', 'suspend_device', 'Pointeuse · Suspendre une tablette', true),
  ('pointage.reactivate_device', 'pointage', 'reactivate_device', 'Pointeuse · Réactiver une tablette', true),
  ('employees.manage_contracts', 'employees', 'manage_contracts', 'RH · Gérer les contrats', true),
  ('documents.manage', 'documents', 'manage', 'RH · Gérer les documents', true),
  ('register.manage', 'register', 'manage', 'RH · Gérer le registre du personnel', true),
  ('leaves.request', 'leaves', 'request', 'Congés · Demander', false),
  ('leaves.cancel', 'leaves', 'cancel', 'Congés · Annuler', false),
  ('users.invite', 'users', 'invite', 'Utilisateurs · Inviter', true),
  ('users.disable', 'users', 'disable', 'Utilisateurs · Désactiver', true),
  ('users.reactivate', 'users', 'reactivate', 'Utilisateurs · Réactiver', true),
  ('users.delete', 'users', 'delete', 'Utilisateurs · Supprimer', true),
  ('users.manage_roles', 'users', 'manage_roles', 'Utilisateurs · Modifier les rôles', true),
  ('users.manage_permissions', 'users', 'manage_permissions', 'Utilisateurs · Modifier les permissions', true)
on conflict (key) do update
set module = excluded.module,
    action = excluded.action,
    label = excluded.label,
    is_sensitive = excluded.is_sensitive;

-- Les actions historiques sont migrées vers leurs équivalents granulaires.
insert into public.role_permissions (role_id, permission_key)
select rp.role_id, mapping.new_key
from public.role_permissions rp
join public.roles migrating_role on migrating_role.id=rp.role_id and migrating_role.permissions_initialized_at is null
join (values
  ('planning.update', 'planning.move'),
  ('planning.create', 'planning.copy'),
  ('planning.update', 'planning.lock'),
  ('planning.update', 'planning.unlock'),
  ('pointage.create', 'pointage.badge'),
  ('pointage.update', 'pointage.correct'),
  ('pointage.manage_settings', 'pointage.edit_schedule'),
  ('pointage.manage_settings', 'pointage.suspend_device'),
  ('pointage.manage_settings', 'pointage.reactivate_device'),
  ('employees.update_sensitive', 'employees.manage_contracts'),
  ('documents.update', 'documents.manage'),
  ('register.update', 'register.manage'),
  ('leaves.create', 'leaves.request'),
  ('leaves.delete', 'leaves.cancel'),
  ('users.manage_users', 'users.invite'),
  ('users.manage_users', 'users.disable'),
  ('users.manage_users', 'users.reactivate'),
  ('users.manage_users', 'users.delete'),
  ('users.manage_users', 'users.manage_roles'),
  ('users.manage_users', 'users.manage_permissions')
) as mapping(old_key, new_key) on mapping.old_key = rp.permission_key
on conflict do nothing;

insert into public.user_permissions(organization_id,user_id,permission_key,effect,created_by,created_at)
select up.organization_id,up.user_id,mapping.new_key,up.effect,up.created_by,up.created_at
from public.user_permissions up
join (values
  ('pointage.manage_settings','pointage.edit_schedule'),
  ('pointage.manage_settings','pointage.suspend_device'),
  ('pointage.manage_settings','pointage.reactivate_device'),
  ('users.manage_users','users.invite'),
  ('users.manage_users','users.disable'),
  ('users.manage_users','users.reactivate'),
  ('users.manage_users','users.delete'),
  ('users.manage_users','users.manage_roles'),
  ('users.manage_users','users.manage_permissions')
) as mapping(old_key,new_key) on mapping.old_key=up.permission_key
where exists(
  select 1 from public.roles r
  where r.organization_id=up.organization_id and r.permissions_initialized_at is null
)
on conflict (organization_id,user_id,permission_key) do nothing;

-- Ces deux droits historiques sont des alias larges. Les conserver actifs
-- contournerait les nouvelles cases granulaires de la matrice.
delete from public.role_permissions
where permission_key in ('pointage.manage_settings','users.manage_users');
delete from public.user_permissions
where permission_key in ('pointage.manage_settings','users.manage_users');

create or replace function public.seed_organization_roles(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_admin uuid;
  v_hr uuid;
  v_store uuid;
  v_manager uuid;
  v_employee uuid;
  v_clock uuid;
begin
  insert into public.roles (organization_id, key, label, rank, is_system, is_read_only, is_active)
  values
    (p_organization_id, 'owner', 'Super Administrateur', 100, true, false, true),
    (p_organization_id, 'administrator', 'Administrateur', 90, true, false, true),
    (p_organization_id, 'hr_manager', 'Responsable RH', 80, true, false, true),
    (p_organization_id, 'store_manager', 'Responsable Magasin', 70, true, false, true),
    (p_organization_id, 'manager', 'Manager', 60, true, false, true),
    (p_organization_id, 'employee', 'Employé', 10, true, false, true),
    (p_organization_id, 'time_clock', 'Pointeuse', 5, true, true, true)
  on conflict (organization_id, key) do update
    set label = excluded.label,
        is_active = true
    where public.roles.permissions_initialized_at is null;

  select id into v_owner from public.roles where organization_id=p_organization_id and key='owner';
  select id into v_admin from public.roles where organization_id=p_organization_id and key='administrator';
  select id into v_hr from public.roles where organization_id=p_organization_id and key='hr_manager';
  select id into v_store from public.roles where organization_id=p_organization_id and key='store_manager';
  select id into v_manager from public.roles where organization_id=p_organization_id and key='manager';
  select id into v_employee from public.roles where organization_id=p_organization_id and key='employee';
  select id into v_clock from public.roles where organization_id=p_organization_id and key='time_clock';

  insert into public.role_permissions(role_id, permission_key)
  select v_owner, key from public.permissions
  where key not in ('pointage.manage_settings','users.manage_users')
    and exists(select 1 from public.roles where id=v_owner and permissions_initialized_at is null)
  on conflict do nothing;
  insert into public.role_permissions(role_id, permission_key)
  select v_admin, key from public.permissions
  where key not in ('pointage.manage_settings','users.manage_users')
    and exists(select 1 from public.roles where id=v_admin and permissions_initialized_at is null)
  on conflict do nothing;

  insert into public.role_permissions(role_id, permission_key)
  select v_hr, key from public.permissions where key = any(array[
    'dashboard.view','employees.view','employees.create','employees.update','employees.delete',
    'employees.view_sensitive','employees.create_sensitive','employees.update_sensitive','employees.delete_sensitive',
    'employees.manage_contracts','documents.view','documents.create','documents.update','documents.delete','documents.manage',
    'register.view','register.create','register.update','register.delete','register.export','register.manage',
    'leaves.view','leaves.request','leaves.update','leaves.validate','leaves.refuse','leaves.cancel',
    'timesheets.view','timesheets.update','reports.view','reports.export','users.view','establishments.view'
  ]) and exists(select 1 from public.roles where id=v_hr and permissions_initialized_at is null)
  on conflict do nothing;

  insert into public.role_permissions(role_id, permission_key)
  select v_store, key from public.permissions where key = any(array[
    'dashboard.view','planning.view','planning.create','planning.update','planning.move','planning.copy',
    'planning.delete','planning.publish','planning.lock','planning.unlock','planning.export','planning.print',
    'employees.view','team.view','pointage.view','pointage.badge','pointage.correct','pointage.validate',
    'pointage.edit_schedule','pointage.suspend_device','pointage.reactivate_device',
    'timesheets.view','leaves.view','leaves.request','leaves.update','leaves.validate','leaves.refuse','leaves.cancel',
    'reports.view','establishments.view','users.view'
  ]) and exists(select 1 from public.roles where id=v_store and permissions_initialized_at is null)
  on conflict do nothing;

  insert into public.role_permissions(role_id, permission_key)
  select v_manager, key from public.permissions where key = any(array[
    'dashboard.view','planning.view','planning.create','planning.update','planning.move','planning.copy',
    'planning.delete','planning.print','employees.view','team.view','pointage.view','pointage.correct','pointage.validate',
    'timesheets.view','leaves.view','leaves.update','leaves.validate','leaves.refuse','reports.view','establishments.view'
  ]) and exists(select 1 from public.roles where id=v_manager and permissions_initialized_at is null)
  on conflict do nothing;

  insert into public.role_permissions(role_id, permission_key)
  select v_employee, key from public.permissions where key = any(array[
    'dashboard.view','planning.view','employees.view','establishments.view','pointage.view','pointage.badge',
    'timesheets.view','leaves.view','leaves.request','leaves.cancel','documents.view'
  ]) and exists(select 1 from public.roles where id=v_employee and permissions_initialized_at is null)
  on conflict do nothing;

  insert into public.role_permissions(role_id, permission_key)
  select v_clock,'pointage.badge'
  where exists(select 1 from public.roles where id=v_clock and permissions_initialized_at is null)
  on conflict do nothing;

  update public.roles
  set permissions_initialized_at=coalesce(permissions_initialized_at,now())
  where organization_id=p_organization_id;
end;
$$;

-- La désactivation d'un rôle coupe immédiatement tous ses membres, y compris
-- les sessions déjà ouvertes, car chaque autorisation relit la base.
create or replace function public.is_active_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members om
    join public.roles r on r.id=om.role_id and r.organization_id=om.organization_id
    where om.organization_id=p_organization_id
      and om.user_id=auth.uid()
      and om.status='active'
      and r.is_active
  );
$$;

create or replace function public.has_permission(p_organization_id uuid, p_permission_key text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_role_id uuid;
begin
  if p_permission_key in ('pointage.manage_settings','users.manage_users') then return false; end if;
  if not public.is_active_member(p_organization_id) then return false; end if;
  if exists(select 1 from public.user_permissions where organization_id=p_organization_id and user_id=auth.uid() and permission_key=p_permission_key and effect='revoke') then return false; end if;
  if exists(select 1 from public.user_permissions where organization_id=p_organization_id and user_id=auth.uid() and permission_key=p_permission_key and effect='grant') then return true; end if;
  select om.role_id into v_role_id
  from public.organization_members om join public.roles r on r.id=om.role_id
  where om.organization_id=p_organization_id and om.user_id=auth.uid() and om.status='active' and r.is_active
  limit 1;
  return exists(select 1 from public.role_permissions where role_id=v_role_id and permission_key=p_permission_key);
end;
$$;

create or replace function public.can_manage_role(p_organization_id uuid, p_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission(p_organization_id, 'users.manage_roles')
     and exists (
       select 1 from public.roles target
       where target.id=p_role_id and target.organization_id=p_organization_id
         and (public.is_owner(p_organization_id) or public.current_role_rank(p_organization_id) > target.rank)
     );
$$;

create or replace function public.can_assign_role(p_organization_id uuid, p_target_role_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select (
      public.has_permission(p_organization_id, 'users.manage_roles')
      or public.has_permission(p_organization_id, 'users.invite')
    )
    and exists (
      select 1
      from public.roles target
      where target.id=p_target_role_id
        and target.organization_id=p_organization_id
        and target.is_active
        and (public.is_owner(p_organization_id) or public.current_role_rank(p_organization_id) > target.rank)
    );
$$;

create or replace function public.can_assign_permission(p_organization_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_permission(p_organization_id, 'users.manage_permissions')
     and p_permission_key not in ('pointage.manage_settings','users.manage_users')
     and exists(select 1 from public.permissions where key=p_permission_key)
     and (public.is_owner(p_organization_id) or public.has_permission(p_organization_id, p_permission_key));
$$;

create or replace function public.can_manage_user(p_organization_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_target_rank integer; v_establishment uuid; v_employee uuid;
begin
  if p_user_id is null or p_user_id=auth.uid() or not public.is_active_member(p_organization_id) then return false; end if;
  if not (
    public.has_permission(p_organization_id,'users.disable') or public.has_permission(p_organization_id,'users.reactivate') or
    public.has_permission(p_organization_id,'users.delete') or public.has_permission(p_organization_id,'users.manage_roles') or
    public.has_permission(p_organization_id,'users.manage_permissions')
  ) then return false; end if;
  select r.rank,om.primary_establishment_id,om.employee_id into v_target_rank,v_establishment,v_employee
  from public.organization_members om join public.roles r on r.id=om.role_id
  where om.organization_id=p_organization_id and om.user_id=p_user_id limit 1;
  if v_target_rank is null or (not public.is_owner(p_organization_id) and public.current_role_rank(p_organization_id)<=v_target_rank) then return false; end if;
  return public.is_owner(p_organization_id) or public.target_in_scope(p_organization_id,v_establishment,v_employee);
end;
$$;

create or replace function public.can_manage_target_scope(p_organization_id uuid, p_primary_establishment_id uuid default null, p_employee_id uuid default null)
returns boolean
language sql stable security definer set search_path=public
as $$ select public.has_permission(p_organization_id,'users.manage_permissions') and public.target_in_scope(p_organization_id,p_primary_establishment_id,p_employee_id); $$;

create or replace function public.can_grant_scope(
  p_organization_id uuid,
  p_scope_type public.scope_type,
  p_establishment_id uuid default null,
  p_team_id text default null,
  p_service_id text default null,
  p_employee_id uuid default null
)
returns boolean
language plpgsql stable security definer set search_path=public
as $$
begin
  if not public.has_permission(p_organization_id,'users.manage_permissions') then return false; end if;
  if p_scope_type='organization' then return public.is_owner(p_organization_id); end if;
  if p_scope_type='employee' then return public.target_in_scope(p_organization_id,null,p_employee_id); end if;
  return public.member_in_scope(p_organization_id,p_establishment_id,null,p_team_id,p_service_id);
end;
$$;

create or replace function public.can_manage_invitation(p_organization_id uuid, p_role_id uuid, p_primary_establishment_id uuid, p_employee_id uuid)
returns boolean
language sql stable security definer set search_path=public
as $$ select public.has_permission(p_organization_id,'users.invite') and public.can_assign_role(p_organization_id,p_role_id) and public.target_in_scope(p_organization_id,p_primary_establishment_id,p_employee_id); $$;

-- Un contexte n'est retourné que tant que le rôle est actif. La désactivation
-- d'un rôle coupe donc aussi les clients déjà ouverts au prochain événement
-- Realtime, sans attendre l'expiration du JWT.
create or replace function public.get_access_context()
returns jsonb
language sql stable security definer set search_path=public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id',om.organization_id,'organization_name',o.name,'member_id',om.id,
    'status',om.status,'role_id',r.id,'role_key',r.key,'role_label',r.label,
    'role_rank',r.rank,'role_is_active',r.is_active,'is_read_only',r.is_read_only,
    'primary_establishment_id',om.primary_establishment_id,'employee_id',om.employee_id,
    'permissions',coalesce((
      select jsonb_agg(jsonb_build_object('key',p.key,'allowed',public.has_permission(om.organization_id,p.key)))
      from public.permissions p
    ),'[]'::jsonb),
    'scopes',coalesce((
      select jsonb_agg(jsonb_build_object(
        'scope_type',ms.scope_type,'establishment_id',ms.establishment_id,
        'team_id',ms.team_id,'service_id',ms.service_id,'employee_id',ms.employee_id
      )) from public.manager_scopes ms where ms.member_id=om.id
    ),'[]'::jsonb)
  )),'[]'::jsonb)
  from public.organization_members om
  join public.organizations o on o.id=om.organization_id
  join public.roles r on r.id=om.role_id and r.is_active
  where om.user_id=auth.uid() and om.status='active';
$$;

create or replace function public.create_invitation(
  p_organization_id uuid,
  p_email text,
  p_role_id uuid,
  p_primary_establishment_id uuid default null,
  p_employee_id uuid default null,
  p_scopes jsonb default '[]'::jsonb,
  p_permission_overrides jsonb default '[]'::jsonb,
  p_expires_at timestamptz default (now()+interval '7 days')
)
returns jsonb
language plpgsql security definer set search_path=public
as $$
declare v_token text; v_invitation_id uuid;
begin
  if p_organization_id is null
     or not public.can_manage_invitation(p_organization_id,p_role_id,p_primary_establishment_id,p_employee_id) then
    raise exception 'Not authorized to invite this user';
  end if;
  if exists(select 1 from public.roles where id=p_role_id and key='employee') then
    if p_employee_id is null then raise exception 'An employee invitation must be linked to an employee record'; end if;
    if p_primary_establishment_id is null then
      select establishment_id into p_primary_establishment_id
      from public.employees where id=p_employee_id and organization_id=p_organization_id;
    end if;
  end if;
  if jsonb_array_length(coalesce(p_scopes,'[]'::jsonb))>0
     and not public.has_permission(p_organization_id,'users.manage_permissions') then
    if jsonb_array_length(coalesce(p_scopes,'[]'::jsonb))<>1
       or coalesce(p_scopes->0->>'scope_type','')<>'establishment'
       or nullif(p_scopes->0->>'establishment_id','')::uuid is distinct from p_primary_establishment_id
       or not public.member_in_scope(p_organization_id,p_primary_establishment_id,null,null,null) then
      raise exception 'Only an establishment scope already held by the inviter may be delegated';
    end if;
  end if;
  if jsonb_array_length(coalesce(p_permission_overrides,'[]'::jsonb))>0
     and not public.has_permission(p_organization_id,'users.manage_permissions') then
    raise exception 'Permission overrides require users.manage_permissions';
  end if;
  if public.has_permission(p_organization_id,'users.manage_permissions')
     and not public.valid_scope_payload(p_organization_id,p_scopes) then
    raise exception 'One or more requested scopes exceed your permissions';
  end if;
  if not public.valid_permission_overrides(p_organization_id,p_permission_overrides) then
    raise exception 'One or more requested permissions exceed your permissions';
  end if;
  if p_expires_at<=now() or p_expires_at>now()+interval '90 days' then
    raise exception 'Invitation expiry must be between now and 90 days';
  end if;
  if exists(
    select 1 from public.organization_members om join public.profiles p on p.id=om.user_id
    where om.organization_id=p_organization_id and lower(p.email)=lower(trim(p_email))
  ) then raise exception 'This email already belongs to the organization'; end if;

  update public.invitations set status='cancelled'
  where organization_id=p_organization_id and lower(email)=lower(trim(p_email)) and status='sent';
  v_token:=encode(extensions.gen_random_bytes(32),'hex');
  insert into public.invitations(
    organization_id,email,role_id,primary_establishment_id,employee_id,
    scopes,permission_overrides,token_hash,expires_at,created_by
  ) values(
    p_organization_id,lower(trim(p_email)),p_role_id,p_primary_establishment_id,p_employee_id,
    coalesce(p_scopes,'[]'::jsonb),coalesce(p_permission_overrides,'[]'::jsonb),
    encode(extensions.digest(v_token,'sha256'),'hex'),p_expires_at,auth.uid()
  ) returning id into v_invitation_id;
  return jsonb_build_object(
    'invitation_id',v_invitation_id,'token',v_token,
    'organization_id',p_organization_id,'expires_at',p_expires_at
  );
end;
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
language plpgsql security definer set search_path=public
as $$
declare v_module text:=split_part(p_action,'.',1);
begin
  if not public.is_active_member(p_organization_id) then raise exception 'Not authorized'; end if;
  if p_action like '%.export%' and not public.has_permission(p_organization_id,v_module||'.export') then
    raise exception 'Not authorized to export';
  elsif p_action like '%.print%' and not public.has_permission(p_organization_id,v_module||'.print') then
    raise exception 'Not authorized to print';
  elsif p_action like 'invitation.%' and not public.has_permission(p_organization_id,'users.invite') then
    raise exception 'Not authorized to manage invitations';
  elsif p_action not like '%.export%' and p_action not like '%.print%' and p_action not like 'invitation.%' then
    raise exception 'Unsupported client audit action';
  end if;
  insert into public.audit_logs(
    organization_id,establishment_id,actor_user_id,action,resource_type,resource_id,old_value,new_value,metadata
  ) values(
    p_organization_id,p_establishment_id,auth.uid(),left(p_action,120),left(p_resource_type,80),
    left(p_resource_id,160),p_old_value,p_new_value,coalesce(p_metadata,'{}'::jsonb)
  );
end;
$$;

create or replace function public.create_custom_role(p_organization_id uuid, p_label text, p_rank smallint default 50)
returns public.roles
language plpgsql security definer set search_path=public
as $$
declare v_role public.roles; v_key text;
begin
  if not public.has_permission(p_organization_id,'users.manage_roles') then raise exception 'Not authorized'; end if;
  if char_length(trim(p_label)) not between 2 and 80 then raise exception 'Role label must contain 2 to 80 characters'; end if;
  if not public.is_owner(p_organization_id) and p_rank>=public.current_role_rank(p_organization_id) then raise exception 'Role rank exceeds caller rank'; end if;
  v_key := 'custom_'||substr(encode(extensions.digest(convert_to(lower(trim(p_label))||clock_timestamp()::text,'utf8'),'sha256'),'hex'),1,24);
  insert into public.roles(organization_id,key,label,rank,is_system,is_read_only,is_active,permissions_initialized_at)
  values(p_organization_id,v_key,trim(p_label),p_rank,false,false,true,now()) returning * into v_role;
  return v_role;
end;
$$;

create or replace function public.duplicate_role(p_source_role_id uuid, p_label text)
returns public.roles
language plpgsql security definer set search_path=public
as $$
declare v_source public.roles; v_created public.roles;
begin
  select * into v_source from public.roles where id=p_source_role_id;
  if not found or not public.can_manage_role(v_source.organization_id,v_source.id) then raise exception 'Not authorized'; end if;
  if exists(select 1 from public.role_permissions rp where rp.role_id=v_source.id and not public.can_assign_permission(v_source.organization_id,rp.permission_key)) then raise exception 'Source role contains permissions you cannot grant'; end if;
  v_created := public.create_custom_role(v_source.organization_id,p_label,least(v_source.rank,(public.current_role_rank(v_source.organization_id)-1)::smallint));
  insert into public.role_permissions(role_id,permission_key) select v_created.id,permission_key from public.role_permissions where role_id=v_source.id;
  return v_created;
end;
$$;

create or replace function public.update_role_configuration(p_role_id uuid, p_label text, p_is_active boolean)
returns public.roles
language plpgsql security definer set search_path=public
as $$
declare v_role public.roles;
begin
  select * into v_role from public.roles where id=p_role_id;
  if not found or not public.can_manage_role(v_role.organization_id,v_role.id) then raise exception 'Not authorized'; end if;
  if v_role.key='owner' and not p_is_active then raise exception 'The Super Administrator role cannot be disabled'; end if;
  if char_length(trim(p_label)) not between 2 and 80 then raise exception 'Role label must contain 2 to 80 characters'; end if;
  update public.roles set label=trim(p_label),is_active=p_is_active where id=p_role_id returning * into v_role;
  return v_role;
end;
$$;

create or replace function public.set_role_permissions(p_role_id uuid, p_permission_keys text[])
returns integer
language plpgsql security definer set search_path=public
as $$
declare v_role public.roles; v_key text; v_count integer;
begin
  select * into v_role from public.roles where id=p_role_id;
  if not found or not public.can_manage_role(v_role.organization_id,v_role.id) or not public.has_permission(v_role.organization_id,'users.manage_permissions') then raise exception 'Not authorized'; end if;
  foreach v_key in array coalesce(p_permission_keys,array[]::text[]) loop
    if not exists(select 1 from public.role_permissions where role_id=p_role_id and permission_key=v_key)
       and not public.can_assign_permission(v_role.organization_id,v_key) then
      raise exception 'Cannot grant permission %',v_key;
    end if;
  end loop;
  if v_role.key='owner' and not array['users.view','users.manage_roles','users.manage_permissions']::text[] <@ coalesce(p_permission_keys,array[]::text[]) then
    raise exception 'The Super Administrator role must retain RBAC administration permissions';
  end if;
  insert into public.role_permissions(role_id,permission_key)
  select p_role_id,key from public.permissions where key=any(coalesce(p_permission_keys,array[]::text[]))
  on conflict do nothing;
  delete from public.role_permissions
  where role_id=p_role_id
    and not (permission_key=any(coalesce(p_permission_keys,array[]::text[])));
  select count(*)::integer into v_count from public.role_permissions where role_id=p_role_id;
  return v_count;
end;
$$;

-- Les rôles système sont des modèles configurables : seule leur identité
-- technique et leur rang restent immuables pour empêcher les élévations.
create or replace function public.protect_system_role()
returns trigger language plpgsql set search_path=public
as $$
begin
  if tg_op='DELETE' and old.is_system then raise exception 'System roles cannot be deleted; disable them instead'; end if;
  if tg_op='UPDATE' and (
    new.key is distinct from old.key or new.rank is distinct from old.rank
    or new.is_system is distinct from old.is_system
    or new.is_read_only is distinct from old.is_read_only
    or (old.permissions_initialized_at is not null
        and new.permissions_initialized_at is distinct from old.permissions_initialized_at)
  ) then
    raise exception 'Role key, rank and technical status are immutable';
  end if;
  if tg_op='UPDATE' and old.key='owner' and not new.is_active then raise exception 'The Super Administrator role cannot be disabled'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

-- Les RPC facilitent l'interface, mais les mêmes règles restent obligatoires
-- pour une requête PostgREST directe.
create or replace function public.protect_owner_role_permissions()
returns trigger language plpgsql security definer set search_path=public
as $$
declare v_role_key text;
begin
  select key into v_role_key from public.roles where id=old.role_id;
  if tg_op='DELETE' and v_role_key='owner'
     and old.permission_key=any(array['users.view','users.manage_roles','users.manage_permissions']) then
    raise exception 'The Super Administrator role must retain RBAC administration permissions';
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists role_permissions_protect_owner on public.role_permissions;
create trigger role_permissions_protect_owner
  before delete on public.role_permissions
  for each row execute function public.protect_owner_role_permissions();

create or replace function public.protect_owner_user_permissions()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  if new.effect='revoke'
     and new.permission_key=any(array['users.view','users.manage_roles','users.manage_permissions'])
     and exists(
       select 1 from public.organization_members om join public.roles r on r.id=om.role_id
       where om.organization_id=new.organization_id and om.user_id=new.user_id and r.key='owner'
     ) then
    raise exception 'Super Administrator RBAC administration permissions cannot be revoked';
  end if;
  return new;
end;
$$;

drop trigger if exists user_permissions_protect_owner on public.user_permissions;
create trigger user_permissions_protect_owner
  before insert or update on public.user_permissions
  for each row execute function public.protect_owner_user_permissions();

create or replace function public.enforce_member_permission_change()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  -- Les deux RPC de session légitimes restent possibles ; leur écriture
  -- directe est de toute façon refusée par la politique RLS d'UPDATE.
  if old.user_id=auth.uid()
     and new.role_id=old.role_id and new.status=old.status
     and new.primary_establishment_id is not distinct from old.primary_establishment_id
     and new.employee_id is not distinct from old.employee_id then
    return new;
  end if;
  if old.user_id=auth.uid() and old.status='invited' and new.status='active' then return new; end if;
  if not public.can_manage_user(old.organization_id,old.user_id) then raise exception 'Not authorized'; end if;
  if new.role_id is distinct from old.role_id
     and not public.has_permission(old.organization_id,'users.manage_roles') then
    raise exception 'users.manage_roles is required';
  end if;
  if new.status is distinct from old.status then
    if new.status='active' and not public.has_permission(old.organization_id,'users.reactivate') then
      raise exception 'users.reactivate is required';
    elsif new.status<>'active' and not public.has_permission(old.organization_id,'users.disable') then
      raise exception 'users.disable is required';
    end if;
  end if;
  if (new.primary_establishment_id is distinct from old.primary_establishment_id
      or new.employee_id is distinct from old.employee_id)
     and not public.has_permission(old.organization_id,'users.manage_permissions') then
    raise exception 'users.manage_permissions is required';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_members_enforce_permissions on public.organization_members;
create trigger organization_members_enforce_permissions
  before update on public.organization_members
  for each row execute function public.enforce_member_permission_change();

create or replace function public.can_write_record(
  p_organization_id uuid,
  p_record_type text,
  p_establishment_id uuid,
  p_employee_id uuid,
  p_team_id text,
  p_service_id text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns boolean
language plpgsql stable security definer set search_path=public
as $$
declare v_allowed boolean:=false;
begin
  if not public.is_active_member(p_organization_id) then return false; end if;
  if p_record_type='shift' then
    if p_action='create' then
      if nullif(p_payload->>'copiedFrom','') is null then
        v_allowed:=public.has_permission(p_organization_id,'planning.create');
      else
        v_allowed:=public.has_permission(p_organization_id,'planning.copy') and exists(
          select 1 from public.business_records source
          where source.organization_id=p_organization_id
            and source.record_type='shift' and source.legacy_id=p_payload->>'copiedFrom'
            and source.deleted_at is null
            and public.can_access_record(
              source.organization_id,source.record_type,source.establishment_id,
              source.employee_id,source.team_id,source.service_id,'view'
            )
        );
      end if;
    elsif p_action='update' then
      v_allowed:=public.has_permission(p_organization_id,'planning.update')
        or public.has_permission(p_organization_id,'planning.move');
    else v_allowed:=public.has_permission(p_organization_id,'planning.'||p_action); end if;
  elsif p_record_type='absence' then
    v_allowed:=public.has_permission(p_organization_id,
      case p_action when 'create' then 'leaves.request' when 'delete' then 'leaves.cancel' else 'leaves.'||p_action end);
  elsif p_record_type='punch' then
    v_allowed:=public.has_permission(p_organization_id,
      case p_action when 'create' then 'pointage.badge' when 'update' then 'pointage.correct' else 'pointage.'||p_action end);
  elsif p_record_type='register' and p_action<>'view' then
    v_allowed:=public.has_permission(p_organization_id,'register.manage');
  elsif p_record_type='setting' and p_action='update' then
    v_allowed:=public.has_permission(p_organization_id,'settings.update')
      or public.has_permission(p_organization_id,'planning.update')
      or public.has_permission(p_organization_id,'planning.lock')
      or public.has_permission(p_organization_id,'planning.unlock');
  else
    v_allowed:=public.has_permission(p_organization_id,public.record_module(p_record_type)||'.'||p_action);
  end if;
  return v_allowed and (public.is_owner(p_organization_id)
    or public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,p_team_id,p_service_id));
end;
$$;

create or replace function public.enforce_business_record_permission()
returns trigger language plpgsql security definer set search_path=public
as $$
declare v_added_lock boolean:=false; v_removed_lock boolean:=false; v_shift_moved boolean:=false;
begin
  if new.record_type is distinct from old.record_type or new.legacy_id is distinct from old.legacy_id then
    raise exception 'Record identity is immutable';
  end if;
  if new.record_type='shift' then
    v_shift_moved:=new.establishment_id is distinct from old.establishment_id
       or new.employee_id is distinct from old.employee_id
       or new.team_id is distinct from old.team_id
       or new.service_id is distinct from old.service_id
       or new.payload->>'date' is distinct from old.payload->>'date';
    if v_shift_moved then
      if not public.has_permission(old.organization_id,'planning.move') then raise exception 'planning.move is required'; end if;
    end if;
    if ((new.payload-'date') is distinct from (old.payload-'date')
        or new.deleted_at is distinct from old.deleted_at)
       and not public.has_permission(old.organization_id,'planning.update') then
      raise exception 'planning.update is required';
    end if;
  elsif new.record_type='absence' and not public.has_permission(old.organization_id,'leaves.update') then
    raise exception 'leaves.update is required';
  elsif new.record_type='punch' and not public.has_permission(old.organization_id,'pointage.correct') then
    raise exception 'pointage.correct is required';
  elsif new.record_type='register' and not public.has_permission(old.organization_id,'register.manage') then
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
      if v_added_lock and not public.has_permission(old.organization_id,'planning.lock') then raise exception 'planning.lock is required'; end if;
      if v_removed_lock and not public.has_permission(old.organization_id,'planning.unlock') then raise exception 'planning.unlock is required'; end if;
    end if;
    if coalesce(new.payload->'templates','[]'::jsonb) is distinct from coalesce(old.payload->'templates','[]'::jsonb)
       and not public.has_permission(old.organization_id,'planning.update') then
      raise exception 'planning.update is required for templates';
    end if;
    if (new.payload-'locks'-'templates'-'weekStart'-'meta') is distinct from (old.payload-'locks'-'templates'-'weekStart'-'meta')
       and not public.has_permission(old.organization_id,'settings.update') then
      raise exception 'settings.update is required';
    end if;
  elsif not public.has_permission(old.organization_id,public.record_module(new.record_type)||'.update') then
    raise exception 'Update permission is required';
  end if;
  return new;
end;
$$;

drop trigger if exists business_records_enforce_permission on public.business_records;
create trigger business_records_enforce_permission
  before update on public.business_records
  for each row
  when (not (
    coalesce(current_setting('app.plannipro_time_clock_rebuild', true), 'off') = 'on'
    and old.record_type = 'punch'
    and new.record_type = 'punch'
    and old.payload->>'source' = 'external-time-clock'
    and new.payload->>'source' = 'external-time-clock'
  ))
  execute function public.enforce_business_record_permission();

create or replace function public.can_access_document(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,p_action text
)
returns boolean language plpgsql stable security definer set search_path=public
as $$
begin
  if not public.is_active_member(p_organization_id) then return false; end if;
  if p_employee_id is not null and public.current_employee_id(p_organization_id)=p_employee_id then
    return p_action='view' and public.has_permission(p_organization_id,'documents.view');
  end if;
  return (public.has_permission(p_organization_id,'documents.'||p_action)
      or (p_action in ('create','update','delete') and public.has_permission(p_organization_id,'documents.manage')))
    and public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,null,null);
end;
$$;

drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated using (
  public.has_permission(organization_id,'users.view')
  or public.has_permission(organization_id,'users.manage_roles')
  or exists(
    select 1 from public.organization_members om
    where om.organization_id=roles.organization_id and om.role_id=roles.id
      and om.user_id=auth.uid() and om.status='active'
  )
);
drop policy if exists roles_insert on public.roles;
create policy roles_insert on public.roles for insert to authenticated with check (
  public.has_permission(organization_id,'users.manage_roles') and not is_system and rank<public.current_role_rank(organization_id)
);
drop policy if exists roles_update on public.roles;
create policy roles_update on public.roles for update to authenticated using (public.can_manage_role(organization_id,id)) with check (public.can_manage_role(organization_id,id));

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated using (
  exists(
    select 1 from public.roles r
    where r.id=role_id and (
      public.has_permission(r.organization_id,'users.view')
      or public.has_permission(r.organization_id,'users.manage_permissions')
      or exists(
        select 1 from public.organization_members om
        where om.organization_id=r.organization_id and om.role_id=r.id
          and om.user_id=auth.uid() and om.status='active'
      )
    )
  )
);
drop policy if exists role_permissions_insert on public.role_permissions;
create policy role_permissions_insert on public.role_permissions for insert to authenticated with check (
  exists(select 1 from public.roles r where r.id=role_id and public.can_manage_role(r.organization_id,r.id) and public.can_assign_permission(r.organization_id,permission_key))
);
drop policy if exists role_permissions_delete on public.role_permissions;
create policy role_permissions_delete on public.role_permissions for delete to authenticated using (
  exists(select 1 from public.roles r where r.id=role_id and public.can_manage_role(r.organization_id,r.id) and public.has_permission(r.organization_id,'users.manage_permissions'))
);

drop policy if exists organization_members_update on public.organization_members;
create policy organization_members_update on public.organization_members for update to authenticated using (
  public.can_manage_user(organization_id,user_id)
) with check (
  public.can_manage_user(organization_id,user_id)
  and public.target_in_scope(organization_id,primary_establishment_id,employee_id)
  and exists(
    select 1 from public.roles r
    where r.id=role_id and r.organization_id=organization_id and r.is_active
      and (public.is_owner(organization_id) or public.current_role_rank(organization_id)>r.rank)
  )
);
drop policy if exists organization_members_delete on public.organization_members;
create policy organization_members_delete on public.organization_members for delete to authenticated using (
  public.has_permission(organization_id,'users.delete') and public.can_manage_user(organization_id,user_id)
);

drop policy if exists user_permissions_select on public.user_permissions;
create policy user_permissions_select on public.user_permissions for select to authenticated using (
  user_id=auth.uid() or (
    public.has_permission(organization_id,'users.manage_permissions')
    and public.can_manage_user(organization_id,user_id)
  )
);
drop policy if exists user_permissions_insert on public.user_permissions;
create policy user_permissions_insert on public.user_permissions for insert to authenticated with check (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_user(organization_id,user_id)
  and public.can_assign_permission(organization_id,permission_key)
);
drop policy if exists user_permissions_update on public.user_permissions;
create policy user_permissions_update on public.user_permissions for update to authenticated using (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_user(organization_id,user_id)
  and public.can_assign_permission(organization_id,permission_key)
) with check (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_user(organization_id,user_id)
  and public.can_assign_permission(organization_id,permission_key)
);
drop policy if exists user_permissions_delete on public.user_permissions;
create policy user_permissions_delete on public.user_permissions for delete to authenticated using (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_user(organization_id,user_id)
  and public.can_assign_permission(organization_id,permission_key)
);

drop policy if exists manager_scopes_select on public.manager_scopes;
create policy manager_scopes_select on public.manager_scopes for select to authenticated using (
  member_id=public.current_member_id(organization_id) or (
    public.has_permission(organization_id,'users.manage_permissions')
    and public.can_manage_member(organization_id,member_id)
  )
);
drop policy if exists manager_scopes_insert on public.manager_scopes;
create policy manager_scopes_insert on public.manager_scopes for insert to authenticated with check (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_member(organization_id,member_id)
  and public.can_grant_scope(organization_id,scope_type,establishment_id,team_id,service_id,employee_id)
);
drop policy if exists manager_scopes_update on public.manager_scopes;
create policy manager_scopes_update on public.manager_scopes for update to authenticated using (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_member(organization_id,member_id)
) with check (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_member(organization_id,member_id)
  and public.can_grant_scope(organization_id,scope_type,establishment_id,team_id,service_id,employee_id)
);
drop policy if exists manager_scopes_delete on public.manager_scopes;
create policy manager_scopes_delete on public.manager_scopes for delete to authenticated using (
  public.has_permission(organization_id,'users.manage_permissions')
  and public.can_manage_member(organization_id,member_id)
);

drop policy if exists business_records_insert on public.business_records;
create policy business_records_insert on public.business_records for insert to authenticated with check (
  deleted_at is null and public.can_write_record(
    organization_id,record_type,establishment_id,employee_id,team_id,service_id,'create',payload
  )
);
drop policy if exists business_records_update on public.business_records;
create policy business_records_update on public.business_records for update to authenticated using (
  public.can_write_record(
    organization_id,record_type,establishment_id,employee_id,team_id,service_id,'update',payload
  )
) with check (
  public.can_write_record(
    organization_id,record_type,establishment_id,employee_id,team_id,service_id,'update',payload
  )
);
drop policy if exists business_records_delete on public.business_records;
create policy business_records_delete on public.business_records for delete to authenticated using (
  public.can_write_record(
    organization_id,record_type,establishment_id,employee_id,team_id,service_id,'delete',payload
  )
);

-- Realtime applique les mêmes politiques SELECT aux changements de matrices.
do $$ begin alter publication supabase_realtime add table public.roles; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.role_permissions; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.user_permissions; exception when duplicate_object then null; end $$;

-- Actualise toutes les organisations, sans modifier les membres existants.
do $$ declare v_org uuid; begin for v_org in select id from public.organizations loop perform public.seed_organization_roles(v_org); end loop; end $$;

revoke all on function public.create_custom_role(uuid,text,smallint) from public,anon,authenticated;
revoke all on function public.duplicate_role(uuid,text) from public,anon,authenticated;
revoke all on function public.update_role_configuration(uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.set_role_permissions(uuid,text[]) from public,anon,authenticated;
revoke all on function public.can_manage_role(uuid,uuid) from public,anon,authenticated;
revoke all on function public.can_write_record(uuid,text,uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.protect_owner_role_permissions() from public,anon,authenticated;
revoke all on function public.protect_owner_user_permissions() from public,anon,authenticated;
revoke all on function public.enforce_member_permission_change() from public,anon,authenticated;
revoke all on function public.enforce_business_record_permission() from public,anon,authenticated;
grant execute on function public.create_custom_role(uuid,text,smallint) to authenticated;
grant execute on function public.duplicate_role(uuid,text) to authenticated;
grant execute on function public.update_role_configuration(uuid,text,boolean) to authenticated;
grant execute on function public.set_role_permissions(uuid,text[]) to authenticated;
grant execute on function public.can_manage_role(uuid,uuid) to authenticated;
grant execute on function public.can_write_record(uuid,text,uuid,uuid,text,text,text,jsonb) to authenticated;

-- Aligne atomiquement la Pointeuse deja deployee sur les permissions fines.
-- Ces remplacements evitent qu'une ancienne fonction demande la permission globale retiree.
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
     or not (public.has_permission(p_organization_id, 'pointage.edit_schedule')) then
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
       (p_status = 'active' and (public.has_permission(v_device.organization_id, 'pointage.reactivate_device')))
       or (p_status <> 'active' and (public.has_permission(v_device.organization_id, 'pointage.suspend_device')))
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
     or not (public.has_permission(p_organization_id, 'pointage.edit_schedule')) then
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
     or not (public.has_permission(p_organization_id, 'pointage.edit_schedule')) then
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

commit;
