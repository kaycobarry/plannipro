import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const cloud = read('plannipro-cloud.js');
const schema = read('supabase/schema.sql');
const timeClock = read('supabase/time-clock.sql');
const kiosk = read('pointeuse.js');

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${nextName}(`, start + 1);
  assert.ok(start >= 0 && end > start, `Unable to extract ${name}`);
  return source.slice(start, end).trim();
}

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Unable to extract ${startMarker.trim()}`);
  return source.slice(start, end).trim();
}

// B1 — every pgcrypto call used by invitations is schema-qualified.
assert.ok(schema.includes('extensions.gen_random_bytes(32)'));
assert.ok(schema.includes("extensions.digest(v_token, 'sha256')"));
assert.ok(schema.includes("extensions.digest(p_token, 'sha256')"));

// B2 — an empty remote state wins over a stale cache unless a local mutation
// is still waiting in the offline queue.
const remoteSource = extractFunction(cloud, 'remoteHasContent', 'shouldApplyRemoteState');
const decisionSource = extractFunction(cloud, 'shouldApplyRemoteState', 'applyRemoteState');
const decisionContext = { result: null };
vm.runInNewContext(`${remoteSource}\n${decisionSource}\nresult = {
  staleCache: shouldApplyRemoteState({employees:[],records:[],documents:[]}, {state:{}}, null),
  pendingOffline: shouldApplyRemoteState({employees:[],records:[],documents:[]}, {state:{}}, {state:{shifts:[1]}}),
  missingCachePending: shouldApplyRemoteState({employees:[],records:[],documents:[]}, null, {state:{shifts:[1]}}),
  remoteData: shouldApplyRemoteState({employees:[{}],records:[],documents:[]}, {state:{}}, null),
  remoteDataPending: shouldApplyRemoteState({employees:[{}],records:[],documents:[]}, {state:{}}, {state:{shifts:[1]}})
};`, decisionContext);
assert.equal(
  JSON.stringify(decisionContext.result),
  JSON.stringify({ staleCache: true, pendingOffline: false, missingCachePending: false, remoteData: true, remoteDataPending: false })
);
assert.ok(/const remote = await fetchRemoteState\(\);[\s\S]{0,600}applyRemoteState\(remote\);/.test(cloud), 'syncNow must apply the post-push remote state once the queue is stable');
assert.ok(/if \(pending\?\.state\) \{\s*const synced = await syncNow\('restore-pending'\);/.test(cloud), 'restore must flush a queued offline snapshot before pulling remote data');
assert.ok(cloud.includes("restored?.pending ? 'Synchronisation en attente'"), 'a failed startup flush must remain visibly pending');
assert.ok(cloud.includes("dbDeleteIfUnchanged('queue', pendingKey, queueGeneration(pending))"), 'queue deletion must compare the pushed generation atomically');
assert.ok(cloud.includes("db.transaction(['kv', 'queue'], 'readwrite')"), 'cache and pending state must be written atomically');

const restoreSource = extractBetween(cloud, '  async function restoreOrPull(', '  function captureLocalChange(');
const restartContext = {
  App: {
    context: { organization_id: 'org-1', role_key: 'manager' },
    user: { id: 'user-1' }, cacheKey: 'cache-1', applyingRemote: false,
    status: () => {}
  },
  S: {}, navigator: { onLine: true },
  dbGet: async (store) => store === 'queue'
    ? { state: { employees: [], shifts: [{ id: 'offline-1' }] } }
    : null,
  dbPut: async () => { throw new Error('cache rewrite before pending push'); },
  localStateHasContent: () => false,
  clone: (value) => JSON.parse(JSON.stringify(value)),
  normalizeState: () => {}, renderAll: () => {},
  syncNow: async (reason) => {
    restartContext.syncReason = reason;
    return true;
  },
  fetchRemoteState: async () => { throw new Error('remote pull before pending push'); },
  remoteHasContent: () => false, shouldApplyRemoteState: () => false,
  applyRemoteState: () => {}, existingImportForm: () => {}, archiveAndClearLegacyStorage: async () => {},
  syncReason: null, result: null
};
vm.runInNewContext(`${restoreSource}\nresult = restoreOrPull();`, restartContext);
assert.equal(JSON.stringify(await restartContext.result), JSON.stringify({ pending: false }));
assert.equal(restartContext.syncReason, 'restore-pending');
assert.equal(JSON.stringify(restartContext.S.shifts), JSON.stringify([{ id: 'offline-1' }]));

const syncSource = extractBetween(cloud, '  async function syncNow(', '\n\n  App.restoreOrPull =');
let queuedRace = { generation: 'p1', state: { id: 'p1' } };
const pushedRace = [];
const syncContext = {
  App: {
    session: {}, context: { organization_id: 'org-1' }, user: { id: 'user-1' },
    syncing: false, localChangeRevision: 0, cacheKey: 'cache-1', lastError: null,
    status: () => {}, syncTimer: null
  },
  navigator: { onLine: true },
  refreshContext: async () => {},
  dbGet: async (store) => store === 'queue' ? queuedRace : null,
  pushSnapshot: async (state) => {
    pushedRace.push(state.id);
    if (state.id === 'p1') {
      syncContext.App.localChangeRevision += 1;
      queuedRace = { generation: 'p2', state: { id: 'p2' } };
    }
  },
  dbDeleteIfUnchanged: async (_store, _key, generation) => {
    if (queuedRace?.generation !== generation) return false;
    queuedRace = null;
    return true;
  },
  queueGeneration: (entry) => entry?.generation,
  fetchRemoteState: async () => ({ employees: [], records: [], documents: [] }),
  applyRemoteState: () => { syncContext.applied = true; },
  dbPut: async () => {}, snapshotState: () => ({}),
  scheduleQueuedSync: () => { syncContext.scheduled = true; },
  safeToast: () => {}, logout: async () => {},
  applied: false, scheduled: false, result: null
};
vm.runInNewContext(`${syncSource}\nresult = syncNow('race');`, syncContext);
assert.equal(await syncContext.result, false);
assert.equal(JSON.stringify(pushedRace), JSON.stringify(['p1', 'p2']));
assert.equal(queuedRace, null);
assert.equal(syncContext.applied, false);
assert.equal(syncContext.scheduled, true);
vm.runInNewContext(`result = syncNow('followup');`, syncContext);
assert.equal(await syncContext.result, true);
assert.equal(syncContext.applied, true);

// B3 — returning normally commits the server-side attempt counter; the kiosk
// converts the returned business error into its existing error path.
assert.ok(timeClock.includes("return jsonb_build_object('error', 'Invalid time clock code')"));
assert.ok(timeClock.includes("return jsonb_build_object('error', 'Offline badge proof is invalid')"));
assert.ok(timeClock.includes("convert_to(public.time_clock_proof_message"));
assert.ok(kiosk.includes('throw appError(parsed.error)'));

// B4 — snapshots contain both planning states and the synchronized setting
// record persists/restores them.
const snapshotSource = extractFunction(cloud, 'snapshotState', 'splitEmployee');
const snapshotContext = {
  S: {
    employees: [], shifts: [], absences: [], punchLog: [], sites: [], erpEntries: [], registre: [],
    templates: [{ id: 't1', name: 'Matin' }],
    locks: { week: { '2026-08-03': true }, day: { '2026-08-04': true } },
    weekStart: '2026-08-03', settings: {}, meta: {}
  },
  clone: (value) => JSON.parse(JSON.stringify(value)),
  result: null
};
vm.runInNewContext(`${snapshotSource}\nresult = snapshotState();`, snapshotContext);
assert.equal(JSON.stringify(snapshotContext.result.templates), JSON.stringify([{ id: 't1', name: 'Matin' }]));
assert.equal(
  JSON.stringify(snapshotContext.result.locks),
  JSON.stringify({ week: { '2026-08-03': true }, day: { '2026-08-04': true } })
);
const recordRowsSource = extractFunction(cloud, 'recordRows', 'tableError');
const recordRowsContext = { result: null };
vm.runInNewContext(`${recordRowsSource}\nresult = recordRows({
  employees: [], shifts: [], absences: [], punchLog: [], erpEntries: [], registre: [],
  settings: { legalAlerts: true }, templates: [{ id: 't1', name: 'Matin' }],
  locks: { week: { w1: true }, day: { d1: true } }, weekStart: '2026-08-03'
}, 'org-1', new Map(), new Map());`, recordRowsContext);
const applicationStateRow = recordRowsContext.result.find((row) => row.legacy_id === 'application-state');
assert.ok(applicationStateRow);
assert.equal(JSON.stringify(applicationStateRow.payload.templates), JSON.stringify([{ id: 't1', name: 'Matin' }]));
assert.equal(JSON.stringify(applicationStateRow.payload.locks), JSON.stringify({ week: { w1: true }, day: { d1: true } }));

const applySource = extractBetween(cloud, '  function applyRemoteState(', '  async function pushDocuments(');
const applyContext = {
  App: { context: { organization_id: 'org-1', employee_id: null }, applyingRemote: false },
  S: { weekStart: null, settings: {}, meta: {} },
  normalizeState: () => {}, renderAll: () => {}, result: null
};
vm.runInNewContext(`${applySource}\napplyRemoteState({
  sites: [], employees: [], privateData: [], documents: [],
  records: [${JSON.stringify(applicationStateRow)}]
}); result = S;`, applyContext);
assert.equal(JSON.stringify(applyContext.result.templates), JSON.stringify([{ id: 't1', name: 'Matin' }]));
assert.equal(JSON.stringify(applyContext.result.locks), JSON.stringify({ week: { w1: true }, day: { d1: true } }));
assert.ok(cloud.includes('templates: Array.isArray(snapshot.templates) ? snapshot.templates : []'));
assert.ok(cloud.includes("locks: snapshot.locks && typeof snapshot.locks === 'object'"));
assert.ok(cloud.includes('templates: Array.isArray(remoteSettings?.templates) ? remoteSettings.templates : []'));

console.log('Blocking fixes B1-B4: OK');
