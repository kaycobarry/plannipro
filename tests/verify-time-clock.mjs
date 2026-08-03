import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const sql = read('supabase/time-clock.sql');
const kiosk = read('pointeuse.js');
const kioskHtml = read('pointeuse.html');
const cloud = read('plannipro-cloud.js');
const shell = read('sw.js');
const index = read('index.html');

function includes(source, expected, label = expected) {
  assert.ok(source.includes(expected), `Missing: ${label}`);
}

[
  'time_clock_devices', 'employee_time_clock_credentials', 'time_clock_events'
].forEach((table) => includes(sql, `public.${table}`, `table ${table}`));

[
  'register_time_clock_device', 'set_employee_time_clock_pin', 'get_time_clock_device_cache',
  'rebuild_time_clock_day_summary', 'time_clock_badge', 'can_manage_time_clock'
].forEach((fn) => includes(sql, `function public.${fn}`, `function ${fn}`));

[
  'alter table public.time_clock_devices enable row level security',
  'alter table public.employee_time_clock_credentials enable row level security',
  'alter table public.time_clock_events enable row level security',
  "grant execute on function public.time_clock_badge",
  'client_event_id',
  "'offline_proof'",
  'previous_offline_valid_until',
  'time_clock_events_select',
  'extensions.crypt',
  'extensions.gen_salt',
  'extensions.digest',
  'extensions.hmac'
].forEach((item) => includes(sql, item));

includes(sql, "return jsonb_build_object('error', 'Invalid time clock code')", 'persistent invalid PIN counter');
includes(sql, "return jsonb_build_object('error', 'Offline badge proof is invalid')", 'persistent invalid offline proof counter');
includes(sql, "convert_to(public.time_clock_proof_message", 'UTF-8 byte message for pgcrypto HMAC');
assert.ok(!/set failed_attempts[\s\S]{0,260}raise exception 'Invalid time clock code'/.test(sql), 'Invalid PIN update must not be rolled back');
assert.ok(!/set failed_attempts[\s\S]{0,260}raise exception 'Offline badge proof is invalid'/.test(sql), 'Invalid offline proof update must not be rolled back');
includes(kiosk, 'if (parsed && typeof parsed ===', 'JSON business error handling');
includes(kiosk, 'throw appError(parsed.error)', 'time-clock RPC error propagation');

assert.ok(!/SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]/i.test(kiosk), 'Kiosk browser code must not contain a service role key');
assert.ok(!/(?:window\.)?localStorage\s*\.\s*(?:setItem|getItem|removeItem)/.test(kiosk), 'Kiosk must not persist a manager session or code in localStorage');
assert.ok(/persistSession:\s*false/.test(kiosk), 'Manager session must remain memory-only');
includes(kiosk, 'PBKDF2');
includes(kiosk, 'offlineProof');
includes(kiosk, "dbSet('queue'");
includes(kiosk, "time_clock_badge");
includes(kiosk, "get_time_clock_device_cache");
includes(kiosk, "function deviceCanBadge()", 'local suspended-device guard');
includes(kiosk, "state.device?.status === 'active'", 'active device required for badge entry');
includes(kiosk, "event.status === 'pending'", 'blocked events excluded from the local attendance state');
includes(kiosk, "${active ? '' : 'disabled'}", 'suspended device employee buttons disabled');
includes(kiosk, "await storeDevice({ ...state.device, status: 'suspended' })", 'server suspension persisted locally');
includes(kioskHtml, './pointeuse.webmanifest');
includes(shell, './pointeuse.html');
includes(shell, './pointeuse.js');
includes(index, 'openTimeClockApp');
includes(index, 'punchDisplay');
includes(index, 'external-time-clock');
includes(cloud, 'TIME_CLOCK_LEGACY_PREFIX');
includes(cloud, 'managedByTimeClock');

new vm.Script(kiosk, { filename: 'pointeuse.js' });

console.log('Time-clock static security checks: OK');
