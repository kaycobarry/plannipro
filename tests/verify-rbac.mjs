import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const schema = read('supabase/schema.sql');
const cloud = read('plannipro-cloud.js');
const config = read('supabase-config.js');
const index = read('index.html');
const inviteFunction = read('supabase/functions/invite-user/index.ts');
const revokeFunction = read('supabase/functions/revoke-user-sessions/index.ts');

function includes(source, expected, label = expected) {
  assert.ok(source.includes(expected), `Missing: ${label}`);
}

[
  'organizations', 'establishments', 'profiles', 'organization_members', 'roles', 'permissions',
  'role_permissions', 'user_permissions', 'manager_scopes', 'employees', 'invitations', 'audit_logs',
  'business_records', 'documents'
].forEach((table) => includes(schema, `public.${table}`, `table ${table}`));

[
  'profiles', 'organizations', 'establishments', 'roles', 'permissions', 'role_permissions',
  'employees', 'employee_private_data', 'employee_self_service', 'organization_members',
  'user_permissions', 'manager_scopes', 'business_records', 'documents', 'invitations', 'audit_logs'
].forEach((table) => includes(schema, `alter table public.${table} enable row level security`, `RLS ${table}`));

[
  'has_permission', 'member_in_scope', 'can_access_employee', 'can_access_record', 'can_assign_role',
  'bootstrap_organization', 'create_invitation', 'claim_invitation', 'get_access_context',
  'validate_organization_links', 'protect_last_owner', 'audit_change', 'target_in_scope',
  'can_manage_target_scope', 'can_assign_permission', 'can_grant_scope', 'can_view_user',
  'can_view_invitation', 'can_access_audit_log', 'valid_scope_payload', 'protect_system_role'
].forEach((fn) => includes(schema, `function public.${fn}`, `function ${fn}`));

[
  'organization_members_select', 'employees_select', 'business_records_select',
  'employee_private_data_select', 'audit_logs_select', 'plannipro_documents_select'
].forEach((policy) => includes(schema, `policy ${policy}`, `policy ${policy}`));

includes(schema, "and om.status = 'active'", 'active-account enforcement');
includes(schema, 'organization_id is immutable', 'immutable organization IDs');
includes(schema, 'employee must belong to organization', 'cross-organization employee protection');
includes(schema, "r.key = 'owner'", 'owner protection');
includes(schema, "and up.effect = 'revoke'", 'individual revoke precedence');
includes(schema, 'storage.buckets', 'private documents bucket');
includes(schema, 'revoke all on all functions in schema public from public, anon', 'security-definer function lockdown');
includes(schema, 'Les rattachements sont créés exclusivement par claim_invitation()', 'invitation-only account attachment');
includes(schema, 'extensions.gen_random_bytes(32)', 'qualified invitation token generator');
includes(schema, "extensions.digest(v_token, 'sha256')", 'qualified invitation token digest');
includes(schema, "extensions.digest(p_token, 'sha256')", 'qualified invitation claim digest');
assert.ok(!/\bgen_random_bytes\(32\)/.test(schema.replaceAll('extensions.gen_random_bytes(32)', '')), 'Invitation token generation must not depend on the public search_path');
includes(schema, 'public.can_manage_target_scope(organization_id, primary_establishment_id, employee_id)', 'scoped membership update');
includes(schema, 'public.can_access_audit_log(organization_id, establishment_id)', 'scoped audit log access');

assert.ok(!/service_role\s*[:=]/i.test(config), 'A service role value must never appear in public configuration');
assert.ok(!cloud.includes('SUPABASE_SERVICE_ROLE_KEY'), 'A service role must never appear in browser code');
includes(inviteFunction, 'SUPABASE_SERVICE_ROLE_KEY', 'server-only invitation service key');
includes(revokeFunction, 'SUPABASE_SERVICE_ROLE_KEY', 'server-only session revocation service key');
includes(cloud, 'indexedDbAuthStorage', 'IndexedDB Auth persistence');
includes(cloud, 'dbPutStateAndQueue', 'atomic offline synchronization queue');
includes(cloud, 'subscribeRealtime', 'realtime synchronization');
includes(cloud, 'get_access_context', 'permission refresh');
includes(cloud, 'claim_invitation', 'invitation acceptance');
includes(cloud, 'protectFunction', 'UI action guards');
includes(cloud, 'view-users', 'users and rights page');
includes(cloud, 'PUBLIC_EMPLOYEE_FIELDS', 'sensitive employee fields private by default');
includes(cloud, 'archiveAndClearLegacyStorage', 'legacy localStorage migration');
includes(cloud, 'shouldApplyRemoteState', 'authoritative empty remote state decision');
includes(cloud, 'templates: Array.isArray(S.templates)', 'planning templates in cloud snapshot');
includes(cloud, "locks: S.locks && typeof S.locks === 'object'", 'planning locks in cloud snapshot');
includes(cloud, 'templates: Array.isArray(remoteSettings?.templates)', 'planning templates restored from Supabase');
includes(cloud, "remoteSettings?.locks && typeof remoteSettings.locks === 'object'", 'planning locks restored from Supabase');
includes(cloud, 'resend_invitation_id', 'secure invitation resend');
includes(cloud, "auth.signOut({ scope: 'local' })", 'device-local sign-out');
includes(cloud, 'clearTimeout(App.syncTimer)', 'sign-out stops queued synchronization');
includes(cloud, 'App.session = null', 'sign-out clears the in-memory session');
includes(cloud, 'App.user = null', 'sign-out clears the in-memory user');
includes(cloud, 'client.removeAllChannels()', 'sign-out closes every Realtime channel');
const logoutSource = cloud.slice(cloud.indexOf('  async function logout()'), cloud.indexOf('  function renderAccount()'));
assert.ok(logoutSource.indexOf("client.auth.signOut({ scope: 'local' })") < logoutSource.indexOf('PlanniProVault?.shutdown'), 'Supabase sign-out must not wait for feature channel cleanup');
assert.ok(logoutSource.indexOf("authForm('login')") < logoutSource.indexOf("client.auth.signOut({ scope: 'local' })"), 'login screen must be shown immediately while sign-out completes');
includes(index, './supabase-config.js', 'public Supabase config script');
includes(index, './plannipro-cloud.js', 'cloud application script');
includes(index, 'cloudOnly', 'localStorage reduction after authentication');
includes(index, 'cell.dataset.empId=emp.id;', 'explicit weekly drag employee target');
includes(index, 'cell.dataset.date=d;', 'explicit weekly drag date target');
includes(index, 'beginPlanningDrag', 'reliable planning drag payload');
includes(index, 'application/x-plannipro-shift', 'cross-browser planning drag payload');
assert.ok(!index.includes("delBtn.getAttribute('onclick').match"), 'Drag/drop must not parse a missing inline onclick attribute');

const inlineScripts = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inlineScripts.length, 1, 'The legacy application should retain one parseable inline script');
new vm.Script(inlineScripts[0][1], { filename: 'index-inline.js' });
new vm.Script(cloud, { filename: 'plannipro-cloud.js' });

console.log('RBAC/static security checks: OK');
