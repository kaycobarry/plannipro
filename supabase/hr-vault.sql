-- PlanniPro — Coffre-fort RH Enterprise
-- À exécuter après schema.sql, time-clock.sql et rbac-advanced.sql.
-- Migration transactionnelle, idempotente et sans service_role.

begin;

-- ---------------------------------------------------------------------------
-- Permissions RBAC granulaires
-- ---------------------------------------------------------------------------

insert into public.permissions (key, module, action, label, is_sensitive)
values
  ('documents.upload', 'documents', 'upload', 'Coffre-fort RH · Déposer', true),
  ('documents.download', 'documents', 'download', 'Coffre-fort RH · Télécharger', true),
  ('documents.restore', 'documents', 'restore', 'Coffre-fort RH · Restaurer', true),
  ('documents.manage_categories', 'documents', 'manage_categories', 'Coffre-fort RH · Gérer les catégories', true),
  ('documents.audit', 'documents', 'audit', 'Coffre-fort RH · Consulter l’historique', true),
  ('documents.view_sensitive', 'documents', 'view_sensitive', 'Coffre-fort RH · Voir les documents sensibles', true)
on conflict (key) do update set
  module=excluded.module,
  action=excluded.action,
  label=excluded.label,
  is_sensitive=excluded.is_sensitive;

-- Les nouveaux droits prolongent la matrice existante sans réactiver les
-- anciens alias globaux. Les exceptions individuelles restent prioritaires.
insert into public.role_permissions(role_id, permission_key)
select r.id, p.permission_key
from public.roles r
join lateral (
  values
    ('documents.upload'), ('documents.download'), ('documents.restore'),
    ('documents.manage_categories'), ('documents.audit'), ('documents.view_sensitive')
) p(permission_key) on true
where r.key in ('owner','administrator','hr_manager')
on conflict do nothing;

insert into public.role_permissions(role_id, permission_key)
select r.id, p.permission_key
from public.roles r
join lateral (values ('documents.view'),('documents.download')) p(permission_key) on true
where r.key in ('store_manager','manager')
on conflict do nothing;

insert into public.role_permissions(role_id, permission_key)
select r.id, 'documents.download'
from public.roles r
where r.key='employee'
  and exists(select 1 from public.role_permissions rp where rp.role_id=r.id and rp.permission_key='documents.view')
on conflict do nothing;

insert into public.user_permissions(organization_id,user_id,permission_key,effect,created_by,created_at)
select up.organization_id,up.user_id,m.new_key,up.effect,up.created_by,up.created_at
from public.user_permissions up
join (values
  ('documents.create','documents.upload'),
  ('documents.view','documents.download'),
  ('documents.delete','documents.restore'),
  ('documents.manage','documents.manage_categories'),
  ('documents.manage','documents.audit'),
  ('employees.view_sensitive','documents.view_sensitive')
) m(old_key,new_key) on m.old_key=up.permission_key
on conflict (organization_id,user_id,permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- Catégories, dossiers, versions et audit immuable
-- ---------------------------------------------------------------------------

create table if not exists public.document_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  label text not null check (char_length(trim(label)) between 2 and 100),
  description text not null default '',
  is_sensitive boolean not null default false,
  employee_visible_default boolean not null default true,
  manager_visible_default boolean not null default false,
  is_required boolean not null default false,
  alert_days integer not null default 30 check (alert_days between 0 and 3650),
  sort_order integer not null default 100 check (sort_order between 0 and 10000),
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,key)
);

create table if not exists public.employee_document_folders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid not null references public.establishments(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(employee_id),
  unique(organization_id,employee_id)
);

alter table public.documents add column if not exists folder_id uuid references public.employee_document_folders(id) on delete restrict;
alter table public.documents add column if not exists category_id uuid references public.document_categories(id) on delete restrict;
alter table public.documents add column if not exists description text not null default '';
alter table public.documents add column if not exists current_version integer not null default 1 check (current_version > 0);
alter table public.documents add column if not exists expires_on date;
alter table public.documents add column if not exists employee_visible boolean not null default true;
alter table public.documents add column if not exists manager_visible boolean not null default false;
alter table public.documents add column if not exists deleted_at timestamptz;
alter table public.documents add column if not exists deleted_by uuid references public.profiles(id) on delete set null;
alter table public.documents add column if not exists restored_at timestamptz;
alter table public.documents add column if not exists restored_by uuid references public.profiles(id) on delete set null;
alter table public.documents add column if not exists search_vector tsvector generated always as (
  setweight(to_tsvector('french',coalesce(file_name,'')),'A') ||
  setweight(to_tsvector('french',coalesce(description,'')),'B') ||
  setweight(to_tsvector('french',coalesce(category,'')),'C')
) stored;

-- La suppression d'un salarié ne détruit jamais son coffre-fort : le dossier
-- reste rattaché à l'organisation et à l'établissement pour la conservation RH.
alter table public.documents drop constraint if exists documents_employee_id_fkey;
alter table public.documents add constraint documents_employee_id_fkey
  foreign key(employee_id) references public.employees(id) on delete set null;
alter table public.documents drop constraint if exists documents_folder_id_fkey;
alter table public.documents add constraint documents_folder_id_fkey
  foreign key(folder_id) references public.employee_document_folders(id) on delete set null;

create table if not exists public.document_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  storage_path text not null unique,
  file_name text not null check (char_length(trim(file_name)) between 1 and 255),
  content_type text not null default 'application/octet-stream',
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  change_note text not null default '',
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  unique(document_id,version_number)
);

create table if not exists public.document_audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  establishment_id uuid references public.establishments(id) on delete set null,
  employee_id uuid references public.employees(id) on delete set null,
  document_id uuid not null references public.documents(id) on delete restrict,
  version_id uuid references public.document_versions(id) on delete set null,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null check (action in (
    'document.created','document.uploaded','document.viewed','document.downloaded',
    'document.soft_deleted','document.restored','document.version_created',
    'document.metadata_updated','document.category_changed'
  )),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists document_categories_org_active_idx on public.document_categories(organization_id,is_active,sort_order);
create index if not exists employee_document_folders_scope_idx on public.employee_document_folders(organization_id,establishment_id,employee_id);
create index if not exists documents_vault_scope_idx on public.documents(organization_id,establishment_id,employee_id,deleted_at,expires_on);
create index if not exists documents_category_idx on public.documents(category_id,employee_id) where deleted_at is null;
create index if not exists documents_search_idx on public.documents using gin(search_vector);
create index if not exists document_versions_document_idx on public.document_versions(document_id,version_number desc);
create index if not exists document_audit_logs_document_idx on public.document_audit_logs(document_id,created_at desc);
create index if not exists document_audit_logs_org_idx on public.document_audit_logs(organization_id,created_at desc);

-- ---------------------------------------------------------------------------
-- Amorçage automatique des catégories et dossiers salariés
-- ---------------------------------------------------------------------------

create or replace function public.seed_hr_document_categories(p_organization_id uuid)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  insert into public.document_categories(
    organization_id,key,label,is_sensitive,employee_visible_default,
    manager_visible_default,is_required,alert_days,sort_order,is_system
  ) values
    (p_organization_id,'contrat_travail','Contrat de travail',true,true,false,true,30,10,true),
    (p_organization_id,'avenants','Avenants',true,true,false,false,30,20,true),
    (p_organization_id,'piece_identite','Pièce d’identité',true,true,false,true,30,30,true),
    (p_organization_id,'carte_vitale','Carte Vitale',true,true,false,true,30,40,true),
    (p_organization_id,'rib','RIB',true,true,false,true,30,50,true),
    (p_organization_id,'permis','Permis',false,true,true,false,30,60,true),
    (p_organization_id,'diplomes','Diplômes',false,true,true,false,60,70,true),
    (p_organization_id,'visite_medicale','Visite médicale',true,true,false,true,30,80,true),
    (p_organization_id,'autorisations','Autorisations diverses',false,true,true,false,30,90,true),
    (p_organization_id,'attestations','Attestations',false,true,true,false,30,100,true),
    (p_organization_id,'sanctions','Sanctions',true,true,false,false,30,110,true),
    (p_organization_id,'entretiens_annuels','Entretiens annuels',true,true,false,false,30,120,true),
    (p_organization_id,'formations','Formations',false,true,true,false,30,130,true),
    (p_organization_id,'documents_libres','Documents libres',false,true,false,false,30,140,true)
  on conflict(organization_id,key) do nothing;
end;
$$;

create or replace function public.seed_hr_vault_for_organization()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  perform public.seed_hr_document_categories(new.id);
  return new;
end;
$$;

drop trigger if exists organizations_seed_hr_vault on public.organizations;
create trigger organizations_seed_hr_vault
after insert on public.organizations
for each row execute function public.seed_hr_vault_for_organization();

create or replace function public.ensure_employee_document_folder()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
begin
  if new.establishment_id is null then return new; end if;
  insert into public.employee_document_folders(organization_id,establishment_id,employee_id)
  values(new.organization_id,new.establishment_id,new.id)
  on conflict(employee_id) do update set
    establishment_id=excluded.establishment_id,
    updated_at=now();
  return new;
end;
$$;

drop trigger if exists employees_ensure_document_folder on public.employees;
create trigger employees_ensure_document_folder
after insert or update of establishment_id on public.employees
for each row execute function public.ensure_employee_document_folder();

do $$ declare v_org uuid; begin
  for v_org in select id from public.organizations loop
    perform public.seed_hr_document_categories(v_org);
  end loop;
end $$;

insert into public.employee_document_folders(organization_id,establishment_id,employee_id)
select organization_id,establishment_id,id from public.employees where establishment_id is not null
on conflict(employee_id) do update set establishment_id=excluded.establishment_id,updated_at=now();

update public.documents d
set folder_id=f.id
from public.employee_document_folders f
where f.employee_id=d.employee_id and d.folder_id is null;

update public.documents d
set category_id=c.id
from public.document_categories c
where c.organization_id=d.organization_id
  and c.key=case
    when lower(d.category) like '%contrat%' then 'contrat_travail'
    when lower(d.category) like '%avenant%' then 'avenants'
    when lower(d.category) like '%ident%' then 'piece_identite'
    when lower(d.category) like '%vitale%' then 'carte_vitale'
    when lower(d.category) like '%rib%' then 'rib'
    when lower(d.category) like '%permis%' then 'permis'
    when lower(d.category) like '%dipl%' then 'diplomes'
    when lower(d.category) like '%visite%' then 'visite_medicale'
    when lower(d.category) like '%formation%' then 'formations'
    else 'documents_libres'
  end
  and d.category_id is null;

insert into public.document_versions(
  organization_id,document_id,version_number,storage_path,file_name,content_type,
  size_bytes,uploaded_by,created_at,metadata
)
select d.organization_id,d.id,1,d.storage_path,d.file_name,
  coalesce(d.content_type,'application/octet-stream'),greatest(coalesce(d.size_bytes,1),1),
  coalesce(d.created_by,d.updated_by,(
    select om.user_id from public.organization_members om
    join public.roles r on r.id=om.role_id
    where om.organization_id=d.organization_id and om.status='active'
    order by r.rank desc limit 1
  )),d.created_at,d.metadata
from public.documents d
where coalesce(d.created_by,d.updated_by,(
    select om.user_id from public.organization_members om
    where om.organization_id=d.organization_id and om.status='active' limit 1
  )) is not null
  and not exists(select 1 from public.document_versions v where v.document_id=d.id)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Autorisation centrale utilisée par RLS, RPC et Storage
-- ---------------------------------------------------------------------------

create or replace function public.has_hr_document_action(p_organization_id uuid,p_action text)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select case p_action
    when 'view' then public.has_permission(p_organization_id,'documents.view') or public.has_permission(p_organization_id,'documents.manage')
    when 'download' then public.has_permission(p_organization_id,'documents.download') or public.has_permission(p_organization_id,'documents.manage')
    when 'upload' then public.has_permission(p_organization_id,'documents.upload') or public.has_permission(p_organization_id,'documents.create') or public.has_permission(p_organization_id,'documents.manage')
    when 'update' then public.has_permission(p_organization_id,'documents.update') or public.has_permission(p_organization_id,'documents.manage')
    when 'delete' then public.has_permission(p_organization_id,'documents.delete') or public.has_permission(p_organization_id,'documents.manage')
    when 'restore' then public.has_permission(p_organization_id,'documents.restore') or public.has_permission(p_organization_id,'documents.manage')
    when 'audit' then public.has_permission(p_organization_id,'documents.audit') or public.has_permission(p_organization_id,'documents.manage')
    when 'manage_categories' then public.has_permission(p_organization_id,'documents.manage_categories') or public.has_permission(p_organization_id,'documents.manage')
    else false end;
$$;

create or replace function public.can_access_hr_document_values(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,
  p_employee_visible boolean,p_manager_visible boolean,p_deleted_at timestamptz,p_action text
)
returns boolean
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare v_own boolean;
begin
  if not public.is_active_member(p_organization_id) or not public.has_hr_document_action(p_organization_id,p_action) then return false; end if;
  if p_deleted_at is not null and p_action in ('view','download','audit')
     and not public.has_hr_document_action(p_organization_id,'restore') then return false; end if;
  v_own := public.current_employee_id(p_organization_id)=p_employee_id;
  if v_own then
    if p_action in ('view','download','audit') then return coalesce(p_employee_visible,false); end if;
    return true;
  end if;
  if not public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,null,null) then return false; end if;
  if public.has_permission(p_organization_id,'documents.view_sensitive')
     or public.has_permission(p_organization_id,'documents.manage') then return true; end if;
  if p_action in ('view','download','audit') then return coalesce(p_manager_visible,false); end if;
  return true;
end;
$$;

create or replace function public.can_access_hr_document(p_document_id uuid,p_action text default 'view')
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select coalesce((
    select public.can_access_hr_document_values(
      d.organization_id,d.establishment_id,d.employee_id,
      d.employee_visible,d.manager_visible,d.deleted_at,p_action
    ) from public.documents d where d.id=p_document_id
  ),false);
$$;

create or replace function public.can_access_hr_employee(
  p_organization_id uuid,p_establishment_id uuid,p_employee_id uuid,p_action text default 'view'
)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select public.is_active_member(p_organization_id)
    and public.has_hr_document_action(p_organization_id,p_action)
    and (
      public.current_employee_id(p_organization_id)=p_employee_id
      or public.member_in_scope(p_organization_id,p_establishment_id,p_employee_id,null,null)
    );
$$;

create or replace function public.can_view_hr_category(
  p_organization_id uuid,p_employee_visible boolean,p_manager_visible boolean
)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select public.is_active_member(p_organization_id)
    and public.has_hr_document_action(p_organization_id,'view')
    and (
      public.has_permission(p_organization_id,'documents.view_sensitive')
      or public.has_permission(p_organization_id,'documents.manage')
      or coalesce(p_manager_visible,false)
      or (public.current_employee_id(p_organization_id) is not null and coalesce(p_employee_visible,false))
    );
$$;

create or replace function public.can_view_hr_category_for_employee(
  p_organization_id uuid,p_employee_id uuid,p_employee_visible boolean,p_manager_visible boolean
)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select public.is_active_member(p_organization_id)
    and public.has_hr_document_action(p_organization_id,'view')
    and (
      public.has_permission(p_organization_id,'documents.view_sensitive')
      or public.has_permission(p_organization_id,'documents.manage')
      or (public.current_employee_id(p_organization_id)=p_employee_id and coalesce(p_employee_visible,false))
      or (public.current_employee_id(p_organization_id) is distinct from p_employee_id and coalesce(p_manager_visible,false))
    );
$$;

-- ---------------------------------------------------------------------------
-- RPC métier : dépôt/version, suppression logique, restauration, audit
-- ---------------------------------------------------------------------------

create or replace function public.create_hr_document_version(
  p_organization_id uuid,
  p_employee_id uuid,
  p_category_id uuid,
  p_document_id uuid,
  p_version_id uuid,
  p_storage_path text,
  p_file_name text,
  p_content_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text default null,
  p_description text default '',
  p_expires_on date default null,
  p_employee_visible boolean default true,
  p_manager_visible boolean default false,
  p_change_note text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=public,storage,pg_temp
as $$
declare
  v_employee public.employees%rowtype;
  v_category public.document_categories%rowtype;
  v_document public.documents%rowtype;
  v_folder uuid;
  v_version integer;
  v_prefix text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_employee from public.employees
    where id=p_employee_id and organization_id=p_organization_id and employment_status<>'archived';
  if not found then raise exception 'Employee not found'; end if;
  select * into v_category from public.document_categories
    where id=p_category_id and organization_id=p_organization_id and is_active;
  if not found then raise exception 'Document category not found'; end if;
  if not public.can_access_hr_employee(p_organization_id,v_employee.establishment_id,p_employee_id,'upload') then
    raise exception 'Not authorized to upload this document';
  end if;
  if v_category.is_sensitive
     and public.current_employee_id(p_organization_id) is distinct from p_employee_id
     and not public.has_permission(p_organization_id,'documents.view_sensitive')
     and not public.has_permission(p_organization_id,'documents.manage') then
    raise exception 'Not authorized to upload this sensitive document category';
  end if;
  if p_document_id is null or p_version_id is null then raise exception 'Document and version identifiers are required'; end if;
  if char_length(trim(coalesce(p_file_name,''))) not between 1 and 255
     or coalesce(p_size_bytes,0) not between 1 and 52428800
     or char_length(coalesce(p_description,''))>4000
     or char_length(coalesce(p_change_note,''))>1000
     or (p_checksum_sha256 is not null and p_checksum_sha256 !~ '^[a-f0-9]{64}$') then
    raise exception 'Invalid document metadata';
  end if;
  v_prefix := p_organization_id::text||'/'||v_employee.establishment_id::text||'/'||p_employee_id::text||'/'||p_document_id::text||'/'||p_version_id::text||'/';
  if left(p_storage_path,char_length(v_prefix))<>v_prefix or p_storage_path like '%..%' then
    raise exception 'Invalid Storage path';
  end if;
  if not exists(select 1 from storage.objects where bucket_id='plannipro-documents' and name=p_storage_path) then
    raise exception 'Uploaded Storage object not found';
  end if;
  select id into v_folder from public.employee_document_folders where employee_id=p_employee_id;
  if v_folder is null then raise exception 'Employee document folder not found'; end if;

  select * into v_document from public.documents where id=p_document_id for update;
  if found then
    if v_document.organization_id<>p_organization_id or v_document.employee_id<>p_employee_id then raise exception 'Document scope mismatch'; end if;
    if not public.can_access_hr_document(v_document.id,'upload') then raise exception 'Not authorized to create a new version'; end if;
    if v_document.deleted_at is not null then raise exception 'Restore the document before adding a version'; end if;
    select coalesce(max(version_number),0)+1 into v_version from public.document_versions where document_id=p_document_id;
  else
    v_version:=1;
    insert into public.documents(
      id,organization_id,establishment_id,employee_id,folder_id,category_id,
      storage_path,file_name,content_type,size_bytes,category,description,current_version,
      expires_on,employee_visible,manager_visible,metadata,created_by,updated_by
    ) values(
      p_document_id,p_organization_id,v_employee.establishment_id,p_employee_id,v_folder,p_category_id,
      p_storage_path,trim(p_file_name),coalesce(nullif(p_content_type,''),'application/octet-stream'),p_size_bytes,
      v_category.key,coalesce(p_description,''),1,p_expires_on,p_employee_visible,p_manager_visible,
      jsonb_build_object('vault','enterprise'),auth.uid(),auth.uid()
    );
  end if;

  insert into public.document_versions(
    id,organization_id,document_id,version_number,storage_path,file_name,content_type,
    size_bytes,checksum_sha256,change_note,uploaded_by,metadata
  ) values(
    p_version_id,p_organization_id,p_document_id,v_version,p_storage_path,trim(p_file_name),
    coalesce(nullif(p_content_type,''),'application/octet-stream'),p_size_bytes,p_checksum_sha256,
    coalesce(p_change_note,''),auth.uid(),jsonb_build_object('category_id',p_category_id)
  );

  update public.documents set
    category_id=p_category_id,category=v_category.key,storage_path=p_storage_path,file_name=trim(p_file_name),
    content_type=coalesce(nullif(p_content_type,''),'application/octet-stream'),size_bytes=p_size_bytes,
    description=coalesce(p_description,''),current_version=v_version,expires_on=p_expires_on,
    employee_visible=p_employee_visible,manager_visible=p_manager_visible,updated_by=auth.uid()
  where id=p_document_id;

  return jsonb_build_object('document_id',p_document_id,'version_id',p_version_id,'version_number',v_version,'storage_path',p_storage_path);
end;
$$;

create or replace function public.soft_delete_hr_document(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_document public.documents%rowtype;
begin
  select * into v_document from public.documents where id=p_document_id for update;
  if not found or not public.can_access_hr_document(p_document_id,'delete') then raise exception 'Not authorized to delete this document'; end if;
  if v_document.deleted_at is null then
    update public.documents set deleted_at=now(),deleted_by=auth.uid(),restored_at=null,restored_by=null,updated_by=auth.uid() where id=p_document_id returning * into v_document;
  end if;
  return jsonb_build_object('document_id',v_document.id,'deleted_at',v_document.deleted_at);
end;
$$;

create or replace function public.restore_hr_document(p_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_document public.documents%rowtype;
begin
  select * into v_document from public.documents where id=p_document_id for update;
  if not found or not public.can_access_hr_document(p_document_id,'restore') then raise exception 'Not authorized to restore this document'; end if;
  if v_document.deleted_at is not null then
    update public.documents set deleted_at=null,deleted_by=null,restored_at=now(),restored_by=auth.uid(),updated_by=auth.uid() where id=p_document_id returning * into v_document;
  end if;
  return jsonb_build_object('document_id',v_document.id,'restored_at',v_document.restored_at);
end;
$$;

create or replace function public.log_hr_document_access(p_document_id uuid,p_version_id uuid,p_action text)
returns void
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_document public.documents%rowtype;
begin
  if p_action not in ('document.viewed','document.downloaded') then raise exception 'Invalid document audit action'; end if;
  select * into v_document from public.documents where id=p_document_id;
  if not found or not public.can_access_hr_document(p_document_id,case when p_action='document.downloaded' then 'download' else 'view' end) then
    raise exception 'Not authorized to access this document';
  end if;
  if p_version_id is not null and not exists(select 1 from public.document_versions where id=p_version_id and document_id=p_document_id) then
    raise exception 'Document version not found';
  end if;
  insert into public.document_audit_logs(organization_id,establishment_id,employee_id,document_id,version_id,actor_user_id,action)
  values(v_document.organization_id,v_document.establishment_id,v_document.employee_id,p_document_id,p_version_id,auth.uid(),p_action);
end;
$$;

create or replace function public.save_hr_document_category(
  p_organization_id uuid,p_category_id uuid,p_key text,p_label text,p_description text,
  p_is_sensitive boolean,p_employee_visible boolean,p_manager_visible boolean,
  p_is_required boolean,p_alert_days integer,p_sort_order integer,p_is_active boolean
)
returns public.document_categories
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_category public.document_categories%rowtype;
begin
  if not public.has_hr_document_action(p_organization_id,'manage_categories') then raise exception 'Not authorized to manage document categories'; end if;
  if coalesce(p_key,'') !~ '^[a-z0-9][a-z0-9_-]{1,63}$' or char_length(trim(coalesce(p_label,''))) not between 2 and 100 then raise exception 'Invalid category'; end if;
  if p_category_id is null then
    insert into public.document_categories(
      organization_id,key,label,description,is_sensitive,employee_visible_default,
      manager_visible_default,is_required,alert_days,sort_order,is_active,created_by,updated_by
    ) values(
      p_organization_id,p_key,trim(p_label),coalesce(p_description,''),p_is_sensitive,
      p_employee_visible,p_manager_visible,p_is_required,p_alert_days,p_sort_order,p_is_active,auth.uid(),auth.uid()
    ) returning * into v_category;
  else
    update public.document_categories set
      label=trim(p_label),description=coalesce(p_description,''),is_sensitive=p_is_sensitive,
      employee_visible_default=p_employee_visible,manager_visible_default=p_manager_visible,
      is_required=p_is_required,alert_days=p_alert_days,sort_order=p_sort_order,
      is_active=p_is_active,updated_by=auth.uid()
    where id=p_category_id and organization_id=p_organization_id returning * into v_category;
    if not found then raise exception 'Document category not found'; end if;
  end if;
  return v_category;
end;
$$;

-- ---------------------------------------------------------------------------
-- Triggers d’audit et immutabilité des versions
-- ---------------------------------------------------------------------------

create or replace function public.audit_hr_document_change()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_action text;
begin
  if tg_op='INSERT' then v_action:='document.created';
  elsif old.deleted_at is null and new.deleted_at is not null then v_action:='document.soft_deleted';
  elsif old.deleted_at is not null and new.deleted_at is null then v_action:='document.restored';
  elsif old.category_id is distinct from new.category_id then v_action:='document.category_changed';
  elsif old.current_version is distinct from new.current_version then v_action:='document.version_created';
  else v_action:='document.metadata_updated'; end if;
  insert into public.document_audit_logs(organization_id,establishment_id,employee_id,document_id,actor_user_id,action,details)
  values(new.organization_id,new.establishment_id,new.employee_id,new.id,auth.uid(),v_action,
    jsonb_build_object('version',new.current_version,'category_id',new.category_id,'deleted_at',new.deleted_at));
  return new;
end;
$$;

drop trigger if exists documents_hr_vault_audit on public.documents;
create trigger documents_hr_vault_audit
after insert or update on public.documents
for each row execute function public.audit_hr_document_change();

create or replace function public.audit_hr_document_version()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare v_document public.documents%rowtype;
begin
  select * into v_document from public.documents where id=new.document_id;
  insert into public.document_audit_logs(organization_id,establishment_id,employee_id,document_id,version_id,actor_user_id,action,details)
  values(new.organization_id,v_document.establishment_id,v_document.employee_id,new.document_id,new.id,auth.uid(),
    case when new.version_number=1 then 'document.uploaded' else 'document.version_created' end,
    jsonb_build_object('version',new.version_number,'file_name',new.file_name,'size_bytes',new.size_bytes));
  return new;
end;
$$;

drop trigger if exists document_versions_audit on public.document_versions;
create trigger document_versions_audit after insert on public.document_versions
for each row execute function public.audit_hr_document_version();

create or replace function public.prevent_hr_document_version_mutation()
returns trigger
language plpgsql
set search_path=public,pg_temp
as $$ begin raise exception 'Document versions are immutable'; end; $$;

drop trigger if exists document_versions_immutable on public.document_versions;
create trigger document_versions_immutable before update or delete on public.document_versions
for each row execute function public.prevent_hr_document_version_mutation();

drop trigger if exists document_categories_set_updated_at on public.document_categories;
create trigger document_categories_set_updated_at before update on public.document_categories
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS tables et vue d’alertes
-- ---------------------------------------------------------------------------

alter table public.document_categories enable row level security;
alter table public.employee_document_folders enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_audit_logs enable row level security;

drop policy if exists document_categories_select on public.document_categories;
create policy document_categories_select on public.document_categories for select to authenticated using (
  public.can_view_hr_category(organization_id,employee_visible_default,manager_visible_default)
  or public.has_hr_document_action(organization_id,'manage_categories')
);

drop policy if exists employee_document_folders_select on public.employee_document_folders;
create policy employee_document_folders_select on public.employee_document_folders for select to authenticated using (
  public.can_access_hr_employee(organization_id,establishment_id,employee_id,'view')
);

drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated using (
  public.can_access_hr_document_values(
    organization_id,establishment_id,employee_id,employee_visible,manager_visible,deleted_at,'view'
  )
);
drop policy if exists documents_insert on public.documents;
drop policy if exists documents_update on public.documents;
drop policy if exists documents_delete on public.documents;

drop policy if exists document_versions_select on public.document_versions;
create policy document_versions_select on public.document_versions for select to authenticated using (
  public.can_access_hr_document(document_id,'view')
);

drop policy if exists document_audit_logs_select on public.document_audit_logs;
create policy document_audit_logs_select on public.document_audit_logs for select to authenticated using (
  public.can_access_hr_document(document_id,'audit')
);

create or replace view public.hr_document_alerts
with (security_invoker=true)
as
select
  ('expiration:'||d.id::text)::text as alert_id,
  d.organization_id,d.establishment_id,d.employee_id,d.id as document_id,d.category_id,
  case when d.expires_on<current_date then 'expired' else 'expiring' end::text as alert_type,
  case when d.expires_on<current_date then 3 else 2 end::integer as severity,
  d.file_name as document_name,c.label as category_name,d.expires_on,
  greatest(d.expires_on-current_date,0)::integer as days_remaining,
  d.employee_visible,d.manager_visible
from public.documents d
join public.document_categories c on c.id=d.category_id
where d.deleted_at is null and d.expires_on is not null
  and d.expires_on<=current_date+c.alert_days
union all
select
  ('missing:'||e.id::text||':'||c.id::text)::text,
  e.organization_id,e.establishment_id,e.id,null::uuid,c.id,
  'missing'::text,2::integer,null::text,c.label,null::date,null::integer,
  c.employee_visible_default,c.manager_visible_default
from public.employees e
join public.document_categories c on c.organization_id=e.organization_id and c.is_active and c.is_required
where e.employment_status='active'
  and public.can_access_hr_employee(e.organization_id,e.establishment_id,e.id,'view')
  and public.can_view_hr_category_for_employee(c.organization_id,e.id,c.employee_visible_default,c.manager_visible_default)
  and not exists(
    select 1 from public.documents d
    where d.employee_id=e.id and d.category_id=c.id and d.deleted_at is null
  );

drop function if exists public.search_hr_documents(text,uuid,uuid,uuid,boolean,boolean);
create or replace function public.search_hr_documents(
  p_organization_id uuid,p_search text default null,p_category_id uuid default null,p_employee_id uuid default null,
  p_establishment_id uuid default null,p_expired boolean default null,p_include_deleted boolean default false
)
returns table(
  document_id uuid,organization_id uuid,establishment_id uuid,employee_id uuid,category_id uuid,
  file_name text,description text,current_version integer,expires_on date,size_bytes bigint,
  content_type text,employee_visible boolean,manager_visible boolean,deleted_at timestamptz,
  created_at timestamptz,updated_at timestamptz,rank real
)
language sql
stable
security invoker
set search_path=public,pg_temp
as $$
  select d.id,d.organization_id,d.establishment_id,d.employee_id,d.category_id,d.file_name,d.description,
    d.current_version,d.expires_on,d.size_bytes,d.content_type,d.employee_visible,d.manager_visible,
    d.deleted_at,d.created_at,d.updated_at,
    case when nullif(trim(p_search),'') is null then 0::real
      else ts_rank(d.search_vector,websearch_to_tsquery('french',trim(p_search))) end as rank
  from public.documents d
  where d.organization_id=p_organization_id
    and public.is_active_member(p_organization_id)
    and (p_category_id is null or d.category_id=p_category_id)
    and (p_employee_id is null or d.employee_id=p_employee_id)
    and (p_establishment_id is null or d.establishment_id=p_establishment_id)
    and (p_include_deleted or d.deleted_at is null)
    and (p_expired is null or (p_expired and d.expires_on<current_date) or (not p_expired and (d.expires_on is null or d.expires_on>=current_date)))
    and (nullif(trim(p_search),'') is null or d.search_vector@@websearch_to_tsquery('french',trim(p_search)))
  order by rank desc,d.updated_at desc;
$$;

-- ---------------------------------------------------------------------------
-- Storage privé : objets immuables et chemins contrôlés par le RBAC
-- ---------------------------------------------------------------------------

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'plannipro-documents','plannipro-documents',false,52428800,
  array[
    'application/pdf','image/jpeg','image/png','image/webp','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.oasis.opendocument.text','text/plain'
  ]::text[]
)
on conflict(id) do update set
  public=false,file_size_limit=52428800,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.can_upload_hr_vault_object(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path=public,pg_temp
as $$
declare v_org uuid;v_establishment uuid;v_employee uuid;v_document uuid;v_version uuid;
begin
  if p_path like '%..%' or array_length(string_to_array(p_path,'/'),1)<6 then return false; end if;
  v_org:=split_part(p_path,'/',1)::uuid;
  v_establishment:=split_part(p_path,'/',2)::uuid;
  v_employee:=split_part(p_path,'/',3)::uuid;
  v_document:=split_part(p_path,'/',4)::uuid;
  v_version:=split_part(p_path,'/',5)::uuid;
  return v_document is not null and v_version is not null
    and exists(select 1 from public.employees e where e.id=v_employee and e.organization_id=v_org and e.establishment_id=v_establishment)
    and public.can_access_hr_employee(v_org,v_establishment,v_employee,'upload');
exception when invalid_text_representation then return false;
end;
$$;

create or replace function public.can_read_hr_vault_object(p_path text)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select exists(
    select 1 from public.document_versions v
    where v.storage_path=p_path and public.can_access_hr_document(v.document_id,'download')
  );
$$;

create or replace function public.is_hr_vault_orphan(p_path text)
returns boolean
language sql
stable
security definer
set search_path=public,pg_temp
as $$
  select not exists(select 1 from public.document_versions v where v.storage_path=p_path);
$$;

drop policy if exists plannipro_documents_select on storage.objects;
create policy plannipro_documents_select on storage.objects for select to authenticated using (
  bucket_id='plannipro-documents' and public.can_read_hr_vault_object(name)
);
drop policy if exists plannipro_documents_insert on storage.objects;
create policy plannipro_documents_insert on storage.objects for insert to authenticated with check (
  bucket_id='plannipro-documents' and public.can_upload_hr_vault_object(name)
);
drop policy if exists plannipro_documents_update on storage.objects;
drop policy if exists plannipro_documents_delete on storage.objects;
drop policy if exists plannipro_documents_delete_orphan on storage.objects;
create policy plannipro_documents_delete_orphan on storage.objects for delete to authenticated using (
  bucket_id='plannipro-documents'
  and owner_id=(select auth.uid()::text)
  and public.can_upload_hr_vault_object(name)
  and public.is_hr_vault_orphan(name)
);

-- ---------------------------------------------------------------------------
-- Exposition Data API explicite, sécurité des fonctions et Realtime
-- ---------------------------------------------------------------------------

revoke all on public.document_categories,public.employee_document_folders,
  public.document_versions,public.document_audit_logs from public,anon;
revoke insert,update,delete on public.document_categories,public.employee_document_folders,
  public.document_versions,public.document_audit_logs from authenticated;
revoke insert,update,delete on public.documents from authenticated;
grant select on public.document_categories,public.employee_document_folders,public.documents,
  public.document_versions,public.document_audit_logs,public.hr_document_alerts to authenticated;

revoke all on function public.seed_hr_document_categories(uuid) from public,anon,authenticated;
revoke all on function public.seed_hr_vault_for_organization() from public,anon,authenticated;
revoke all on function public.ensure_employee_document_folder() from public,anon,authenticated;
revoke all on function public.audit_hr_document_change() from public,anon,authenticated;
revoke all on function public.audit_hr_document_version() from public,anon,authenticated;
revoke all on function public.prevent_hr_document_version_mutation() from public,anon,authenticated;

revoke all on function public.has_hr_document_action(uuid,text) from public,anon,authenticated;
revoke all on function public.can_access_hr_document_values(uuid,uuid,uuid,boolean,boolean,timestamptz,text) from public,anon,authenticated;
revoke all on function public.can_access_hr_document(uuid,text) from public,anon,authenticated;
revoke all on function public.can_access_hr_employee(uuid,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.can_view_hr_category(uuid,boolean,boolean) from public,anon,authenticated;
revoke all on function public.can_view_hr_category_for_employee(uuid,uuid,boolean,boolean) from public,anon,authenticated;
revoke all on function public.can_upload_hr_vault_object(text) from public,anon,authenticated;
revoke all on function public.can_read_hr_vault_object(text) from public,anon,authenticated;
revoke all on function public.is_hr_vault_orphan(text) from public,anon,authenticated;
revoke all on function public.create_hr_document_version(uuid,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,date,boolean,boolean,text) from public,anon,authenticated;
revoke all on function public.soft_delete_hr_document(uuid) from public,anon,authenticated;
revoke all on function public.restore_hr_document(uuid) from public,anon,authenticated;
revoke all on function public.log_hr_document_access(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.save_hr_document_category(uuid,uuid,text,text,text,boolean,boolean,boolean,boolean,integer,integer,boolean) from public,anon,authenticated;
revoke all on function public.search_hr_documents(uuid,text,uuid,uuid,uuid,boolean,boolean) from public,anon,authenticated;

grant execute on function public.has_hr_document_action(uuid,text) to authenticated;
grant execute on function public.can_access_hr_document_values(uuid,uuid,uuid,boolean,boolean,timestamptz,text) to authenticated;
grant execute on function public.can_access_hr_document(uuid,text) to authenticated;
grant execute on function public.can_access_hr_employee(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.can_view_hr_category(uuid,boolean,boolean) to authenticated;
grant execute on function public.can_view_hr_category_for_employee(uuid,uuid,boolean,boolean) to authenticated;
grant execute on function public.can_upload_hr_vault_object(text) to authenticated;
grant execute on function public.can_read_hr_vault_object(text) to authenticated;
grant execute on function public.is_hr_vault_orphan(text) to authenticated;
grant execute on function public.create_hr_document_version(uuid,uuid,uuid,uuid,uuid,text,text,text,bigint,text,text,date,boolean,boolean,text) to authenticated;
grant execute on function public.soft_delete_hr_document(uuid) to authenticated;
grant execute on function public.restore_hr_document(uuid) to authenticated;
grant execute on function public.log_hr_document_access(uuid,uuid,text) to authenticated;
grant execute on function public.save_hr_document_category(uuid,uuid,text,text,text,boolean,boolean,boolean,boolean,integer,integer,boolean) to authenticated;
grant execute on function public.search_hr_documents(uuid,text,uuid,uuid,uuid,boolean,boolean) to authenticated;

do $$ begin alter publication supabase_realtime add table public.documents; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.document_versions; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.document_categories; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table public.document_audit_logs; exception when duplicate_object then null; end $$;

comment on table public.document_versions is 'Versions immuables du coffre-fort RH. Aucun objet Storage n’est écrasé.';
comment on table public.document_audit_logs is 'Journal append-only des actions documentaires RH.';
comment on view public.hr_document_alerts is 'Documents expirés, expirant prochainement et catégories obligatoires manquantes.';

commit;
