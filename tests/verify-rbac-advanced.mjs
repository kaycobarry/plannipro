import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const migration = read('supabase/rbac-advanced.sql');
const timeClock = read('supabase/time-clock.sql') + read('supabase/time-clock-secure-activation.sql');
const cloud = read('plannipro-cloud.js');
const kiosk = read('pointeuse.js');
const index = read('index.html');

function includes(source, expected, label = expected) {
  assert.ok(source.includes(expected), `Missing: ${label}`);
}

[
  'owner', 'administrator', 'hr_manager', 'store_manager', 'manager', 'employee', 'time_clock'
].forEach((role) => includes(migration, `'${role}'`, `default role ${role}`));

[
  'planning.move', 'planning.copy', 'planning.publish', 'planning.lock', 'planning.unlock',
  'pointage.badge', 'pointage.correct', 'pointage.edit_schedule',
  'pointage.suspend_device', 'pointage.reactivate_device',
  'employees.manage_contracts', 'documents.manage', 'register.manage',
  'leaves.request', 'leaves.cancel', 'users.invite', 'users.disable',
  'users.reactivate', 'users.delete', 'users.manage_roles', 'users.manage_permissions'
].forEach((permission) => includes(migration, `'${permission}'`, `granular permission ${permission}`));

[
  'create_custom_role', 'duplicate_role', 'update_role_configuration', 'set_role_permissions',
  'can_manage_role', 'can_write_record', 'enforce_member_permission_change',
  'enforce_business_record_permission', 'protect_owner_role_permissions',
  'protect_owner_user_permissions'
].forEach((fn) => includes(migration, `function public.${fn}`, `advanced RBAC function ${fn}`));

includes(migration, 'add column if not exists is_active', 'role activation state');
includes(migration, 'permissions_initialized_at', 'idempotent default-role initialization');
includes(migration, 'where organization_id=p_organization_id;', 'all existing roles marked initialized');
includes(migration, "and r.is_active", 'disabled roles removed from access context');
includes(migration, "and r.is_active\n  where om.user_id=auth.uid()", 'active-role access context filter');
includes(migration, "permission_key in ('pointage.manage_settings','users.manage_users')", 'broad legacy grants removed');
includes(migration, "new.status='active' and not public.has_permission(old.organization_id,'users.reactivate')", 'reactivation API guard');
includes(migration, "new.status<>'active' and not public.has_permission(old.organization_id,'users.disable')", 'suspension API guard');
includes(migration, "new.role_id is distinct from old.role_id", 'role-change column guard');
includes(migration, "public.has_permission(organization_id,'users.delete')", 'member deletion RLS');
includes(migration, "planning.move is required", 'direct shift move guard');
includes(migration, "planning.update is required", 'direct shift edit guard');
includes(migration, "planning.lock is required", 'direct lock guard');
includes(migration, "planning.unlock is required", 'direct unlock guard');
includes(migration, "alter publication supabase_realtime add table public.roles", 'role Realtime publication');
includes(migration, "alter publication supabase_realtime add table public.role_permissions", 'matrix Realtime publication');
includes(migration, "alter publication supabase_realtime add table public.user_permissions", 'override Realtime publication');

const hasPermissionBody = migration.match(/create or replace function public\.has_permission[\s\S]*?\$\$;/)?.[0] || '';
assert.ok(hasPermissionBody, 'Advanced has_permission function must exist');
assert.ok(!hasPermissionBody.includes('if public.is_owner'), 'Owner must use the configurable matrix, not an unconditional bypass');

includes(cloud, "rpc('create_custom_role'", 'create-role UI');
includes(cloud, "rpc('duplicate_role'", 'duplicate-role UI');
includes(cloud, "rpc('update_role_configuration'", 'rename/deactivate role UI');
includes(cloud, "rpc('set_role_permissions'", 'permission-matrix UI');
includes(cloud, "table: 'role_permissions'", 'matrix Realtime listener');
includes(cloud, 'refreshPermissions', 'live permission refresh');
includes(cloud, 'authorizedRecordRow', 'differential permission-aware synchronization');
includes(cloud, "App.can('planning', 'move')", 'move synchronization guard');
includes(cloud, "App.can('planning', 'lock')", 'lock synchronization guard');
includes(cloud, "action: 'copy'", 'copy UI guard');
includes(cloud, "action: 'manage_contracts'", 'contract UI guard');
includes(cloud, "action: 'manage'", 'module management UI guards');
assert.ok(!cloud.includes("App.require('users', 'manage_users')"), 'Browser UI must not rely on the broad legacy user permission');

includes(index, 'copiedFrom:shift.id', 'copied shifts carry an immutable-copy intent marker');
includes(timeClock, "clock_devices.disable", 'time-clock suspension permission');
includes(timeClock, "clock_devices.update", 'time-clock reactivation permission');
includes(kiosk, "managerCan('clock_devices.update'", 'time-clock update UI guard');
includes(kiosk, "managerCan('clock_devices.disable'", 'time-clock device-status UI guard');

const inlineScripts = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inlineScripts.length, 1, 'The application must retain one parseable inline script');
new vm.Script(inlineScripts[0][1], { filename: 'index-inline.js' });
new vm.Script(cloud, { filename: 'plannipro-cloud.js' });
new vm.Script(kiosk, { filename: 'pointeuse.js' });

console.log('Advanced RBAC/static security checks: OK');
