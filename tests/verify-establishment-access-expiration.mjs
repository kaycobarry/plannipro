import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const sql = read('supabase/establishment-access-expiration.sql');
const cloud = read('plannipro-cloud.js');
const index = read('index.html');
const sw = read('sw.js');

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Unable to extract ${startMarker.trim()}`);
  return source.slice(start, end).trim();
}

// A1 — migration safety and backward-compatible unlimited access.
assert.match(sql, /^--[\s\S]*\nbegin;/i);
assert.match(sql, /commit;\s*$/i);
assert.match(sql, /access_expires_at timestamptz/);
assert.match(sql, /access_version bigint not null default 1/);
assert.match(sql, /access_expires_at is null or access_expires_at > access_starts_at/);
assert.equal(/update\s+public\.establishments\s+set\s+access_expires_at/is.test(sql), false,
  'existing establishments must not receive a finite expiration');
assert.equal(/delete\s+from\s+public\.(employees|business_records|establishments)/i.test(sql), false,
  'the migration must not delete business data');

// A2 — server-time states have a strict boundary: equality is expired.
assert.match(sql, /p_reference_at >= p_expires_at then 'expired'/);
assert.match(sql, /p_reference_at < e\.access_expires_at/);
const stateAt = ({ starts, expires = null, suspended = false }, now) => {
  if (suspended) return 'suspended';
  if (starts > now) return 'scheduled';
  if (expires !== null && now >= expires) return 'expired';
  if (expires !== null && expires <= now + 30 * 86400000) return 'expiring_soon';
  return 'active';
};
const t0 = Date.parse('2026-08-17T10:00:00Z');
assert.equal(stateAt({ starts: t0 - 1, expires: null }, t0), 'active');
assert.equal(stateAt({ starts: t0 + 1, expires: null }, t0), 'scheduled');
assert.equal(stateAt({ starts: t0 - 10, expires: t0 + 1 }, t0), 'expiring_soon');
assert.equal(stateAt({ starts: t0 - 10, expires: t0 }, t0), 'expired');
assert.equal(stateAt({ starts: t0 - 10, expires: null, suspended: true }, t0), 'suspended');

// A3 — the barrier is central, applies to RLS and also to SECURITY DEFINER writes.
for (const fragment of [
  'establishment_business_access_allowed',
  'assert_establishment_business_access',
  'has_permission_at',
  'member_in_scope',
  'can_access_hr_document_values',
  'can_read_planning_publication_object',
  'enforce_establishment_business_write',
  "message='STORE_ACCESS_EXPIRED'"
]) assert.ok(sql.includes(fragment), `missing server barrier: ${fragment}`);
for (const table of ['business_records', 'employees', 'documents', 'planning_publications', 'time_clock_devices', 'time_clock_events']) {
  assert.ok(sql.includes(`'${table}'`), `missing privileged-write guard for ${table}`);
}
assert.match(sql, /v_old := to_jsonb\(old\)/,
  'the generic trigger must not resolve time-clock-only columns on unrelated tables');
assert.equal(/old\.used_at|old\.expires_at/.test(sql), false,
  'generic trigger fields must be read through JSON after the table check');
assert.match(sql, /alter publication supabase_realtime add table public\.establishments/);

// A4 — only an owner or an Administrator assigned to the target store can administer access.
assert.match(sql, /r\.key='owner'[\s\S]*r\.key='administrator' and mer\.establishment_id=p_establishment_id/);
assert.match(sql, /STORE_ACCESS_ADMIN_REQUIRED/);
assert.match(sql, /establishments_access_suspension_reason_required/);
assert.match(sql, /to_jsonb\(new\) - array\[/);
assert.match(sql, /grant execute on function public\.set_establishment_access[\s\S]*to authenticated/);
assert.equal(/grant execute on function public\.set_establishment_access[\s\S]*to anon/.test(sql), false);
for (const triggerFunction of [
  'guard_establishment_access_fields',
  'audit_establishment_access_change',
  'enforce_establishment_business_write'
]) assert.match(sql, new RegExp(`revoke all on function public\\.${triggerFunction}\\(\\) from public,anon,authenticated`));

// A5 — append-only audit: authenticated users receive SELECT only.
assert.match(sql, /create table if not exists public\.establishment_access_events/);
assert.match(sql, /revoke all on public\.establishment_access_events from public,anon,authenticated/);
assert.match(sql, /grant select on public\.establishment_access_events to authenticated/);
assert.equal(/grant (insert|update|delete)[^;]*establishment_access_events/i.test(sql), false);

// A6 — Europe/Paris conversion is explicit and rejects the missing DST hour.
const parisSource = extractBetween(cloud, '  function utcToParisInput(', '  async function quarantinePendingAccess(');
const parisContext = { Intl, Date, Error, result: null };
vm.runInNewContext(`${parisSource}\nresult = {
  winter: parisInputToUtc('2026-01-15T12:00'),
  summer: parisInputToUtc('2026-07-15T12:00'),
  springBefore: parisInputToUtc('2026-03-29T01:30'),
  nonexistent: (() => { try { parisInputToUtc('2026-03-29T02:30'); return false; } catch (_) { return true; } })()
};`, parisContext);
assert.equal(parisContext.result.winter, '2026-01-15T11:00:00.000Z');
assert.equal(parisContext.result.summer, '2026-07-15T10:00:00.000Z');
assert.equal(parisContext.result.springBefore, '2026-03-29T00:30:00.000Z');
assert.equal(parisContext.result.nonexistent, true);
const addDaysSource = extractBetween(cloud, '  function addParisDays(', '  async function openStoreAccessDialog(');
const addDaysContext = { Date, Error, result: null };
vm.runInNewContext(`${addDaysSource}\nresult = addParisDays('2026-03-28T12:00', 1);`, addDaysContext);
assert.equal(addDaysContext.result, '2026-03-29T12:00', 'a calendar-day shortcut must preserve Paris wall time across DST');

// A7 — offline writes carry the access version and are quarantined before replay.
const queueSource = extractBetween(cloud, '  function makeQueueEntry(', '  function queueGeneration(');
const queueContext = {
  queueSequence: 0,
  globalThis: { crypto: { randomUUID: () => 'queue-id' } },
  App: { remoteRecordRevisions: new Map() },
  currentIdentity: () => null,
  StaleIdentityError: class extends Error {},
  result: null
};
vm.runInNewContext(`${queueSource}\nresult = makeQueueEntry('offline', {}, {
  userId:'u1',organizationId:'o1',cacheKey:'state:u1:o1',
  context:{primary_establishment_id:'e1',access_version:8}
});`, queueContext);
assert.equal(queueContext.result.establishmentId, 'e1');
assert.equal(queueContext.result.accessVersion, 8);
assert.match(cloud, /store-access-version-changed/);
assert.match(cloud, /dbPut\('backups', `store-access:/);
assert.match(cloud, /await dbDelete\('queue', pendingKey\)/);
assert.match(cloud, /if \(!storeAccessIsOpen\(state\)\)[\s\S]*enterStoreAccessBlocked/);
for (const policy of [
  'store_access_time_clock_devices',
  'store_access_time_clock_activation_codes',
  'store_access_document_audit_logs'
]) assert.ok(sql.includes(policy), `missing restrictive access policy ${policy}`);
assert.ok((cloud.match(/const remote = await fetchRemoteState\(identity\);\s+(?:assertIdentity\(identity\);\s+)?(?:\/\*[\s\S]*?\*\/\s+|\/\/[^\n]*\n\s+)*if \(typeof enforceCurrentStoreAccess/g) || []).length >= 2,
  'remote RLS snapshots must be revalidated after reads and before apply/cache');

// A8 — UI supports unlimited/custom windows, 7/30/90 days and a stable blocking screen.
for (const marker of ['siteAccessUnlimited', 'siteAccessStarts', 'siteAccessExpires', 'siteAccessDuration']) {
  assert.ok(index.includes(marker), `missing establishment form control ${marker}`);
}
for (const days of ['value="7"', 'value="30"', 'value="90"']) assert.ok(index.includes(days));
assert.match(cloud, /Code : \$\{STORE_ACCESS_ERROR\}/);
assert.match(cloud, /Les données sont conservées, mais aucune donnée métier ni mutation hors ligne n’est accessible/);
assert.match(cloud, /removeChannel/);
assert.match(sw, /plannipro-shell-v37/);

// A9 — no privileged key is introduced into browser or migration sources.
assert.equal(/service[_-]?role/i.test(`${cloud}\n${index}\n${sql}`), false);

console.log('Expiration établissement: SQL, RLS/RPC, hors-ligne, DST et interface OK');
