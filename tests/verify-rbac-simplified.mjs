import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const migration = read('supabase/rbac-simplified-roles.sql');
const regression = read('supabase/rbac-simplified-regression-rollback.sql');
const cloud = read('plannipro-cloud.js');
const index = read('index.html');

const includes = (source, value, label = value) => assert.ok(source.includes(value), `Missing: ${label}`);

assert.match(migration.trim(), /^--[\s\S]*\nbegin;/i, 'Migration must start a transaction');
assert.match(migration.trim(), /commit;$/i, 'Migration must commit explicitly');

['administrator', 'manager', 'supervisor', 'employee'].forEach((role) =>
  includes(migration, `'${role}'`, `standard business role ${role}`));

[
  'member_establishment_roles', 'member_establishment_permissions',
  'has_permission_at', 'current_establishment_role_rank',
  'can_assign_establishment_role', 'set_member_establishment_role',
  'set_member_establishment_exceptions', 'protect_last_establishment_administrator',
  'protect_member_last_establishment_administrator', 'sync_member_primary_establishment_role'
].forEach((item) => includes(migration, item, `per-establishment RBAC ${item}`));

includes(migration, 'enable row level security', 'RLS enabled on assignment tables');
includes(migration, "target.key in ('administrator','manager','supervisor','employee')", 'only standard roles assignable');
includes(migration, '>=target.rank', 'same-level or lower hierarchy rule');
includes(migration, 'Affectation inter-organisation interdite', 'cross-tenant assignment guard');
includes(migration, 'l’établissement doit conserver au moins un Administrateur actif', 'last active administrator protection');
includes(migration, "not in ('planning.publish','pointage.correct','leaves.validate','leaves.refuse','employees.view_sensitive','financial.view')", 'advanced exceptions allowlist');
includes(migration, 'alter publication supabase_realtime add table public.member_establishment_roles', 'assignment Realtime publication');
includes(migration, 'alter publication supabase_realtime add table public.member_establishment_permissions', 'exception Realtime publication');
includes(migration, 'on conflict(member_id,establishment_id)', 'idempotent assignment migration');
includes(migration, 'pp_role_mapping', 'deterministic legacy mapping');
includes(migration, 'Preserve exactement la matrice historique', 'legacy effective-right preservation');
includes(migration, 'revoke insert,update,delete on public.roles from authenticated', 'global role writes disabled');
includes(migration, 'revoke insert,update,delete on public.user_permissions from authenticated', 'legacy global overrides disabled');
includes(migration, 'revoke execute on function public.set_role_permissions', 'legacy giant matrix RPC disabled');

const standardMatrices = new Map([...migration.matchAll(
  /insert into public\.role_permissions\(role_id,permission_key\)[\s\S]*?join public\.permissions p on p\.key=any\(array\[([\s\S]*?)\]\)\nwhere r\.key='(manager|supervisor|employee)'/g
)].map((match) => [match[2], match[1]]));
const managerMatrix = standardMatrices.get('manager') || '';
const supervisorMatrix = standardMatrices.get('supervisor') || '';
const employeeMatrix = standardMatrices.get('employee') || '';
assert.ok(managerMatrix, 'Manager matrix must be explicit');
assert.ok(supervisorMatrix, 'Supervisor matrix must be explicit');
assert.ok(employeeMatrix, 'Employee matrix must be explicit');
['planning.publish', 'pointage.correct', 'leaves.validate', 'leaves.refuse', 'employees.create'].forEach((permission) =>
  includes(managerMatrix, `'${permission}'`, `manager permission ${permission}`));
['settings.update', 'users.manage_roles', 'users.manage_permissions', 'employees.view_sensitive', 'financial.view'].forEach((permission) =>
  assert.ok(!managerMatrix.includes(`'${permission}'`), `Manager must not receive ${permission}`));
['planning.view', 'planning.move', 'planning.copy', 'pointage.view', 'timesheets.view', 'leaves.view'].forEach((permission) =>
  includes(supervisorMatrix, `'${permission}'`, `supervisor permission ${permission}`));
['planning.publish', 'pointage.correct', 'leaves.validate', 'leaves.refuse', 'employees.view_sensitive'].forEach((permission) =>
  assert.ok(!supervisorMatrix.includes(`'${permission}'`), `Supervisor must not receive ${permission} by default`));
['planning.view', 'pointage.view', 'pointage.badge', 'timesheets.view', 'leaves.request', 'documents.view'].forEach((permission) =>
  includes(employeeMatrix, `'${permission}'`, `employee self-service permission ${permission}`));
['planning.create', 'planning.update', 'pointage.correct', 'users.view', 'settings.view'].forEach((permission) =>
  assert.ok(!employeeMatrix.includes(`'${permission}'`), `Employee must not receive ${permission}`));

includes(cloud, 'STANDARD_BUSINESS_ROLE_KEYS', 'four-role UI allowlist');
includes(cloud, "rpc('set_member_establishment_role'", 'server-side role assignment RPC');
includes(cloud, "rpc('set_member_establishment_exceptions'", 'server-side advanced exceptions RPC');
includes(cloud, "table: 'member_establishment_roles'", 'assignment Realtime subscription');
includes(cloud, "table: 'member_establishment_permissions'", 'exception Realtime subscription');
includes(cloud, 'Autorisations avancées', 'advanced section label');
assert.ok(!cloud.includes("from('organization_members').update({ role_id:"), 'Role UI must not directly update organization_members');

includes(index, "showSP('access',this)", 'Settings > Access and security entry');
includes(index, 'id="sp-access"', 'advanced access settings panel');
includes(index, "'clocks','access'", 'all settings panels remain navigable');

new vm.Script(cloud, { filename: 'plannipro-cloud.js' });
const inlineScripts = [...index.matchAll(/<script>([\s\S]*?)<\/script>/g)];
assert.equal(inlineScripts.length, 1, 'index must retain one parseable inline script');
new vm.Script(inlineScripts[0][1], { filename: 'index-inline.js' });

assert.match(regression.trim(), /^--[\s\S]*\nbegin;/i, 'RLS regression must be transactional');
assert.match(regression.trim(), /rollback;$/i, 'RLS regression must remove every fixture');
[
  'Administrator crossed establishment isolation', 'Manager self-promoted through direct API',
  'Supervisor received an optional or sensitive permission by default',
  'Employee A reads employee B', 'Employee A reads planning B',
  'Supervisor exception was not applied', 'Last establishment administrator was removed'
].forEach((scenario) => includes(regression, scenario, `rollback RLS scenario: ${scenario}`));

console.log('Simplified per-establishment RBAC checks: OK');
