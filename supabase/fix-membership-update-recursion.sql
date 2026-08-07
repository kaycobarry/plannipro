begin;

-- Reading public.roles from the WITH CHECK expression re-entered the roles RLS
-- policy, which itself reads organization_members. Use the SECURITY DEFINER
-- authorization helper so the decision remains scoped without policy recursion.
drop policy if exists organization_members_update on public.organization_members;
create policy organization_members_update on public.organization_members
for update to authenticated
using (
  public.can_manage_user(organization_id, user_id)
)
with check (
  public.can_manage_user(organization_id, user_id)
  and public.target_in_scope(organization_id, primary_establishment_id, employee_id)
  and public.can_assign_role(organization_id, role_id)
);

commit;
