begin;

-- Supabase/Postgres evaluates a scalar subquery once per statement. Keeping
-- auth.uid() in that init plan preserves the exact policy semantics while
-- avoiding one JWT lookup per row on large organizations.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid())
  or exists (
    select 1 from public.organization_members mine
    where mine.user_id = (select auth.uid())
      and mine.status = 'active'
      and public.can_view_user(mine.organization_id, profiles.id)
  )
);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists organization_members_select on public.organization_members;
create policy organization_members_select on public.organization_members for select to authenticated using (
  public.is_active_member(organization_id)
  and (user_id = (select auth.uid()) or public.can_view_user(organization_id, user_id))
);

drop policy if exists roles_select on public.roles;
create policy roles_select on public.roles for select to authenticated using (
  public.has_permission(organization_id, 'users.view')
  or public.has_permission(organization_id, 'users.manage_roles')
  or exists (
    select 1 from public.organization_members om
    where om.organization_id = roles.organization_id
      and om.role_id = roles.id
      and om.user_id = (select auth.uid())
      and om.status = 'active'
  )
);

drop policy if exists role_permissions_select on public.role_permissions;
create policy role_permissions_select on public.role_permissions for select to authenticated using (
  exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and (
        public.has_permission(r.organization_id, 'users.view')
        or public.has_permission(r.organization_id, 'users.manage_permissions')
        or exists (
          select 1 from public.organization_members om
          where om.organization_id = r.organization_id
            and om.role_id = r.id
            and om.user_id = (select auth.uid())
            and om.status = 'active'
        )
      )
  )
);

drop policy if exists user_permissions_select on public.user_permissions;
create policy user_permissions_select on public.user_permissions for select to authenticated using (
  user_id = (select auth.uid())
  or (
    public.has_permission(organization_id, 'users.manage_permissions')
    and public.can_manage_user(organization_id, user_id)
  )
);

-- Cover the foreign keys used by tenant filters, employee deletion checks,
-- time-clock history and HR document navigation. All statements are
-- idempotent and add indexes only; no row is updated or removed.
create index if not exists audit_logs_establishment_fk_idx on public.audit_logs(establishment_id);
create index if not exists audit_logs_actor_fk_idx on public.audit_logs(actor_user_id);
create index if not exists business_records_establishment_fk_idx on public.business_records(establishment_id);
create index if not exists business_records_employee_fk_idx on public.business_records(employee_id);
create index if not exists documents_establishment_fk_idx on public.documents(establishment_id);
create index if not exists documents_employee_fk_idx on public.documents(employee_id);
create index if not exists documents_folder_fk_idx on public.documents(folder_id);
create index if not exists document_audit_logs_establishment_fk_idx on public.document_audit_logs(establishment_id);
create index if not exists document_audit_logs_employee_fk_idx on public.document_audit_logs(employee_id);
create index if not exists document_audit_logs_actor_fk_idx on public.document_audit_logs(actor_user_id);
create index if not exists document_audit_logs_version_fk_idx on public.document_audit_logs(version_id);
create index if not exists employee_document_folders_establishment_fk_idx on public.employee_document_folders(establishment_id);
create index if not exists employees_establishment_fk_idx on public.employees(establishment_id);
create index if not exists invitations_role_fk_idx on public.invitations(role_id);
create index if not exists invitations_establishment_fk_idx on public.invitations(primary_establishment_id);
create index if not exists invitations_employee_fk_idx on public.invitations(employee_id);
create index if not exists manager_scopes_organization_fk_idx on public.manager_scopes(organization_id);
create index if not exists manager_scopes_establishment_fk_idx on public.manager_scopes(establishment_id);
create index if not exists manager_scopes_employee_fk_idx on public.manager_scopes(employee_id);
create index if not exists organization_members_role_fk_idx on public.organization_members(role_id);
create index if not exists organization_members_establishment_fk_idx on public.organization_members(primary_establishment_id);
create index if not exists organization_members_employee_fk_idx on public.organization_members(employee_id);
create index if not exists time_clock_devices_establishment_fk_idx on public.time_clock_devices(establishment_id);
create index if not exists time_clock_events_establishment_fk_idx on public.time_clock_events(establishment_id);
create index if not exists time_clock_events_employee_fk_idx on public.time_clock_events(employee_id);
create index if not exists employee_clock_pin_invitations_employee_fk_idx on public.employee_time_clock_pin_invitations(employee_id);
create index if not exists user_permissions_user_fk_idx on public.user_permissions(user_id);
create index if not exists user_permissions_permission_fk_idx on public.user_permissions(permission_key);

commit;
