import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync('supabase/security-performance-hardening.sql', 'utf8').toLowerCase();
const rlsRegression = readFileSync('supabase/rls-regression-rollback.sql', 'utf8').toLowerCase();
const memberPolicyFix = readFileSync('supabase/fix-membership-update-recursion.sql', 'utf8').toLowerCase();
const tenantIsolation = readFileSync('supabase/tenant-isolation-hardening.sql', 'utf8').toLowerCase();

assert.match(sql, /^begin;/, 'la migration doit être transactionnelle');
assert.match(sql, /commit;\s*$/, 'la migration doit se terminer par commit');
assert.equal((sql.match(/create policy/g) || []).length, 6, 'six politiques RLS doivent être recréées');
assert.ok((sql.match(/\(select auth\.uid\(\)\)/g) || []).length >= 7, 'auth.uid doit utiliser un init plan');
assert.ok((sql.match(/create index if not exists/g) || []).length >= 20, 'les index critiques doivent être idempotents');
assert.ok(!/drop table|truncate|delete from|update public\./.test(sql), 'la migration ne doit modifier aucune donnée métier');
assert.match(rlsRegression, /^--[^\n]*\nbegin;/, 'la recette RLS doit démarrer dans une transaction');
assert.match(rlsRegression, /rollback;\s*$/, 'la recette RLS doit toujours annuler ses données temporaires');
assert.doesNotMatch(rlsRegression, /\bcommit\b/, 'la recette RLS ne doit jamais valider ses données temporaires');
for (const scenario of ['manager can read forbidden establishment', 'manager elevated its own role', 'employee can read another employee', 'suspended manager still reads tenant data']) {
  assert.ok(rlsRegression.includes(scenario), `scénario RLS absent: ${scenario}`);
}
assert.match(memberPolicyFix, /^begin;/, 'le correctif de récursion doit être transactionnel');
assert.match(memberPolicyFix, /public\.can_assign_role\(organization_id, role_id\)/, 'le contrôle de rôle doit passer par le helper sans récursion');
assert.doesNotMatch(memberPolicyFix, /from public\.roles|from roles/, 'la politique ne doit pas relire roles directement');
assert.match(memberPolicyFix, /commit;\s*$/, 'le correctif de récursion doit se terminer par commit');
assert.match(tenantIsolation, /^begin;/, 'le durcissement multi-magasin doit être transactionnel');
assert.match(tenantIsolation, /revoke all on table public\.time_clock_devices\s+from public, anon, authenticated;/, 'les appareils ne doivent pas être exposés directement');
assert.match(tenantIsolation, /revoke all on table public\.employee_time_clock_credentials\s+from public, anon, authenticated;/, 'les secrets de pointeuse ne doivent pas être exposés directement');
assert.match(tenantIsolation, /revoke all on table public\.time_clock_events\s+from public, anon, authenticated;/, 'les événements de pointeuse ne doivent pas accepter de mutation directe');
assert.match(tenantIsolation, /grant select on table public\.time_clock_events to authenticated;/, 'la lecture autorisée des événements doit rester disponible');
assert.match(tenantIsolation, /alter view public\.hr_document_alerts set \(security_invoker = true\);/, 'la vue RH doit conserver les RLS de ses tables sources');
assert.match(tenantIsolation, /revoke all on table public\.hr_document_alerts\s+from public, anon, authenticated;/, 'la vue RH ne doit jamais être exposée à anon');
assert.doesNotMatch(tenantIsolation, /drop table|truncate|delete from|update public\./, 'le durcissement multi-magasin ne doit modifier aucune donnée métier');
assert.match(tenantIsolation, /commit;\s*$/, 'le durcissement multi-magasin doit se terminer par commit');

console.log('Durcissement Supabase: migrations transactionnelles, RLS, index et privilèges directs vérifiés.');
