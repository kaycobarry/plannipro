import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const baseSql = read('supabase/time-clock.sql');
const secureSql = read('supabase/time-clock-secure-activation.sql');
const kiosk = read('pointeuse.js');
const kioskHtml = read('pointeuse.html');
const cloud = read('plannipro-cloud.js');
const shell = read('sw.js');
const index = read('index.html');
const config = read('supabase/config.toml');
const pinInvitationFunction = read('supabase/functions/send-clock-pin-invitation/index.ts');

const includes = (source, expected, label = expected) => assert.ok(source.includes(expected), `Missing: ${label}`);

['time_clock_devices','employee_time_clock_credentials','time_clock_events'].forEach((table) => includes(baseSql, `public.${table}`, table));
['time_clock_device_activation_codes','employee_time_clock_pin_invitations'].forEach((table) => includes(secureSql, `public.${table}`, table));

[
  'create_time_clock_activation_code','activate_time_clock_device','get_time_clock_device_cache',
  'list_time_clock_devices','update_time_clock_device','delete_or_archive_time_clock_device',
  'generate_employee_time_clock_pin','create_employee_time_clock_pin_invitation',
  'consume_employee_time_clock_pin_invitation','verify_time_clock_pin','time_clock_badge'
].forEach((fn) => includes(secureSql, `function public.${fn}`, fn));

includes(secureSql, 'begin;', 'transaction start');
includes(secureSql, 'commit;', 'transaction commit');
includes(secureSql, "p_ttl_minutes integer default 10", 'ten-minute activation');
includes(secureSql, 'used_at is not null', 'one-time activation consumption');
includes(secureSql, "encode(extensions.digest(p_device_token, 'sha256'), 'hex')", 'device token hashed server-side');
includes(secureSql, "revoke all on function public.register_time_clock_device", 'direct registration revoked');
assert.ok(!/grant execute on function public\.register_time_clock_device/.test(secureSql), 'Direct registration must not be granted again');
includes(secureSql, "revoke all on function public.set_time_clock_device_status(uuid,public.time_clock_device_status)", 'legacy device-status RPC revoked');

includes(secureSql, 'alter table public.time_clock_device_activation_codes enable row level security', 'activation RLS');
includes(secureSql, 'alter table public.employee_time_clock_pin_invitations enable row level security', 'PIN invitation RLS');
includes(secureSql, 'revoke all on public.time_clock_device_activation_codes from anon, authenticated', 'activation table direct access denied');
includes(secureSql, 'revoke all on public.employee_time_clock_pin_invitations from anon, authenticated', 'invitation table direct access denied');
includes(secureSql, "public.can_access_establishment", 'establishment isolation');
includes(secureSql, "public.can_access_employee", 'employee scope isolation');

includes(secureSql, 'extensions.gen_random_bytes', 'cryptographic random generation');
includes(secureSql, "extensions.gen_salt('bf', 12)", 'bcrypt cost');
includes(secureSql, "'visible_once', true", 'one-time plaintext PIN response');
includes(secureSql, 'offline_salt = null, offline_hash = null', 'offline PIN verifier removal');
includes(secureSql, "p_offline_proof is not null or p_pin is null", 'offline badge rejected');
includes(secureSql, "Code incorrect ou indisponible", 'non-enumerating PIN error');
includes(secureSql, 'attempt_window_started_at', 'attempt window');
includes(secureSql, 'lock_level', 'progressive lock');

includes(kiosk, "DEVICE_STORAGE_KEY = 'plannipro_clock_device_token'", 'stable browser token key');
includes(kiosk, "crypto.getRandomValues(new Uint8Array(32))", 'client token generation');
includes(kiosk, "activate_time_clock_device", 'voluntary activation call');
includes(kiosk, "verify_time_clock_pin", 'server-side PIN verification');
includes(kiosk, "Connexion indisponible — pointage momentanément impossible.", 'explicit offline refusal');
assert.ok(!kiosk.includes('register_time_clock_device'), 'Kiosk must never call direct registration');
assert.ok(!kiosk.includes('offline_hash'), 'Kiosk must never receive a PIN verifier');
assert.ok(!kiosk.includes('PBKDF2'), 'Kiosk must not verify PINs locally');
includes(kiosk, "await dbSet('cache', { securityMigrationAt: nowIso() })", 'legacy PIN verifier cache is sanitized');
assert.ok(!/localStorage\s*\./.test(kiosk), 'No session or PIN in localStorage');
assert.ok(/persistSession:\s*false/.test(kiosk), 'Manager session is memory-only');

includes(kiosk, 'delete_or_archive_time_clock_device', 'conditional delete/archive UI');
includes(kiosk, "p_status: 'revoked'", 'explicit revoke UI');
includes(kiosk, 'list_time_clock_device_history', 'device history UI');
includes(kiosk, 'generate_employee_time_clock_pin', 'server PIN generation UI');
includes(kiosk, 'create_employee_time_clock_pin_invitation', 'one-time link UI');
includes(kiosk, "send-clock-pin-invitation", 'e-mail invitation Edge Function UI');
includes(config, '[functions.send-clock-pin-invitation]', 'PIN invitation Edge Function config');
includes(config, '[functions.send-clock-pin-invitation]\n# The browser uses a modern sb_publishable_ key.', 'PIN invitation documents custom authentication');
includes(config, 'create_employee_time_clock_pin_invitation.\nverify_jwt = false', 'PIN invitation gateway JWT disabled');
includes(pinInvitationFunction, 'request.headers.get("Authorization")', 'PIN invitation requires bearer authorization');
includes(pinInvitationFunction, 'userClient.auth.getUser()', 'PIN invitation validates the caller session');
assert.match(config, /\[functions\.send-clock-pin-invitation\][\s\S]*?verify_jwt\s*=\s*false/, 'PIN invitation must use handler-level JWT validation');
includes(pinInvitationFunction, 'PLANNING_EMAIL_FROM', 'shared verified e-mail sender');
includes(index, "showSP('clocks',this)", 'Settings → Time clocks tab');
includes(index, 'openTimeClockManagement');
includes(cloud, "module: 'clock_devices', action: 'view'", 'management UI permission guard');
includes(kioskHtml, './pointeuse.webmanifest');
includes(shell, 'plannipro-shell-v33');
includes(shell, 'requestUrl.hostname.endsWith("supabase.co")');

assert.ok(!/SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]/i.test(kiosk), 'No service role secret in browser');
new vm.Script(kiosk, { filename: 'pointeuse.js' });
console.log('Time-clock secure activation static checks: OK');
