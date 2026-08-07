import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const migration = read('supabase/company-administration.sql');
const schema = read('supabase/schema.sql');
const rbac = read('supabase/rbac-advanced.sql');
const cloud = read('plannipro-cloud.js');
const createCompany = read('supabase/functions/create-company/index.ts');
const inviteUser = read('supabase/functions/invite-user/index.ts');
const shell = read('sw.js');
const config = read('supabase/config.toml');

const includes = (source, expected, label = expected) => {
  assert.ok(source.includes(expected), `Missing: ${label}`);
};

assert.match(migration, /^--[\s\S]*?\nbegin;/i, 'Company migration must start transactionally');
assert.match(migration, /commit;\s*$/i, 'Company migration must commit explicitly');
includes(migration, 'add column if not exists first_name', 'idempotent invitation first name');
includes(migration, 'add column if not exists last_name', 'idempotent invitation last name');

// New company + automatic first administrator, restricted to the platform owner.
includes(migration, 'plannipro_private.platform_administrators', 'private platform administrator registry');
includes(migration, 'and not exists (select 1 from plannipro_private.platform_administrators)', 'one-time initial platform owner seed');
includes(migration, 'function public.is_platform_administrator()', 'platform administrator authorization RPC');
includes(migration, 'auth.uid() is not null', 'platform administrator RPC requires authentication');
includes(migration, 'revoke all on schema plannipro_private from public, anon, authenticated', 'private schema access revoked');
includes(migration, 'revoke all on function public.is_platform_administrator()', 'platform RPC default execution revoked');
includes(createCompany, 'request.headers.get("Authorization")', 'authenticated Edge Function request');
includes(createCompany, 'callerClient.auth.getUser(token)', 'server-side JWT user validation');
includes(createCompany, 'callerClient.rpc("is_platform_administrator")', 'platform administrator authorization');
includes(createCompany, 'admin.auth.admin.createUser', 'server-only Auth user provisioning');
includes(createCompany, 'email_confirm: true', 'controlled administrator account confirmation');
assert.ok(!createCompany.includes('.auth.signUp'), 'The company endpoint must never expose public Auth signup');
includes(createCompany, 'plannipro_company_creator: true', 'trusted company creator flag');
includes(createCompany, 'plannipro_company_setup', 'trusted company setup payload');
assert.ok(!createCompany.includes('access_token'), 'The public company endpoint must not return Auth tokens');
includes(migration, "raw_app_meta_data ->> 'plannipro_company_creator'", 'bootstrap requires app_metadata authorization');
includes(migration, 'email_confirmed_at is null', 'bootstrap requires confirmed email');
includes(migration, 'This account already belongs to or created an organization', 'one-time bootstrap guard');
includes(migration, "where organization_id = v_org_id and key = 'owner'", 'automatic primary administrator role');
includes(migration, "'organization.created'", 'company creation audit');
includes(migration, "- 'plannipro_company_creator' - 'plannipro_company_setup'", 'one-time authorization consumption');
includes(cloud, "functions.invoke('create-company'", 'public company wizard uses server endpoint');
includes(cloud, "rpc('bootstrap_company'", 'authorized automatic bootstrap');
assert.ok(!cloud.includes("data-pp-auth-mode=\"signup\""), 'Free signup link must not be present');
assert.ok(!cloud.includes('App.client.auth.signUp'), 'Browser must not create free Auth accounts');
assert.ok(!cloud.includes('data-pp-auth-mode="company"'), 'Public company creation link must not be present');
includes(cloud, "if (!App.session || !App.platformAdmin)", 'browser company form requires platform administrator session');
includes(cloud, "App.platformAdmin ? '<button type=\"button\" data-pp-action=\"create-company\">Créer une entreprise</button>'", 'company action visible only to platform administrator');
includes(config, '[auth]\nenable_signup = false', 'public Supabase signup disabled in configuration');
includes(config, '[functions.create-company]\nverify_jwt = true', 'company function requires platform JWT verification');

// Invitation creation, activation, expiration, replay and tamper resistance.
includes(inviteUser, 'create_company_invitation', 'admin invitation RPC');
includes(inviteUser, 'userClient.rpc("create_invitation", invitationArgs)', 'legacy pending invitation resend compatibility');
includes(inviteUser, 'p_first_name', 'invited first name');
includes(inviteUser, 'p_last_name', 'invited last name');
includes(inviteUser, 'inviteUserByEmail', 'secure Supabase invite email');
includes(migration, 'function public.validate_invitation', 'pre-password invitation validation');
includes(cloud, "rpc('validate_invitation'", 'browser validates invitation before password');
includes(cloud, "rpc('claim_invitation'", 'invitation activation');
includes(migration, "and i.status = 'sent'", 'used/cancelled invitation rejection');
includes(migration, "v_inv.expires_at <= pg_catalog.now()", 'expired invitation rejection');
includes(migration, 'This invitation was issued for another email address', 'email/org impersonation rejection');
includes(migration, "extensions.digest(p_token, 'sha256')", 'tamper-resistant hashed token');
includes(migration, 'Password setup required', 'password required before membership');
includes(migration, 'delete from public.manager_scopes', 'stale scopes removed on reactivation');
includes(migration, 'delete from public.user_permissions', 'stale overrides removed on reactivation');
includes(cloud, "form.getAll('permission_key')", 'supplementary permission selector');
includes(cloud, "scope_type: 'service'", 'service scopes in invitation');
includes(cloud, "<h3>Salariés de l’équipe</h3>", 'team employees are listed in user administration');
includes(cloud, "data-pp-user-action=\"invite-employee\"", 'one-click employee invitation action');
includes(cloud, "data-pp-user-action=\"sync-invite-employee\"", 'new employees can be synchronized before invitation');
includes(cloud, "App.syncNow('prepare-employee-invitation')", 'employee synchronization precedes first invitation');
includes(cloud, "Renvoyer l’invitation", 'one-click invitation resend action');
includes(cloud, "first_name,last_name,employee_id,role_id,primary_establishment_id,status", 'invitation state is matched to employees');
includes(cloud, "const selectedEmployee = selectedEmployeeId", 'employee invitation form prefill');
includes(cloud, "roles.find((role) => role.key === 'employee')", 'employee role preselected');
includes(cloud, "selectedEmployee?.email || ''", 'employee e-mail prefilled');

// Direct writes remain closed; RLS and Realtime remain the enforcement layer.
includes(schema, 'drop policy if exists organization_members_insert', 'no direct membership insertion policy');
assert.ok(!schema.includes('create policy organization_members_insert'), 'Direct organization attachment must remain impossible');
includes(schema, 'alter table public.invitations enable row level security', 'invitation RLS');
includes(rbac, 'alter publication supabase_realtime add table public.roles', 'RBAC Realtime');
includes(migration, 'alter publication supabase_realtime add table public.invitations', 'invitation Realtime publication');
includes(cloud, "table: 'invitations'", 'invitation Realtime subscription');
includes(migration, 'revoke all on function public.bootstrap_company()', 'bootstrap EXECUTE lockdown');
includes(migration, 'grant execute on function public.bootstrap_company() to authenticated', 'authenticated bootstrap grant');
includes(shell, 'plannipro-shell-v34', 'new application shell cache');

new vm.Script(cloud, { filename: 'plannipro-cloud.js' });
new vm.Script(shell, { filename: 'sw.js' });

console.log('Company administration/static security checks: OK');
