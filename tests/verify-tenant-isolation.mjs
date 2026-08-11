import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const cloud = read('plannipro-cloud.js');
const index = read('index.html');

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Unable to extract ${startMarker.trim()}`);
  return source.slice(start, end).trim();
}

// I1 — Cloud mode never mirrors an authenticated tenant into the former
// origin-wide Web Storage or IndexedDB record.
const saveSource = extractBetween(index, 'function save()', '\n\nfunction promiseWithTimeout');
const saveContext = {
  window: { PlanniProCloud: { usePrivateCache: () => true } },
  document: { documentElement: { setAttribute: () => {} } },
  stateSnapshotWithMetadata: () => '{"employees":[{"id":"nantes"}]}',
  storageSet: () => { saveContext.webWrites += 1; return true; },
  queueStateSnapshot: () => { saveContext.globalIdbWrites += 1; return true; },
  console,
  webWrites: 0,
  globalIdbWrites: 0,
  result: null
};
vm.runInNewContext(`${saveSource}\nresult = save();`, saveContext);
assert.equal(saveContext.result, true);
assert.equal(saveContext.webWrites, 0);
assert.equal(saveContext.globalIdbWrites, 0);

// I2 — the explicit reset removes every business collection, templates and
// locks before another identity or organization can be displayed.
const resetSource = extractBetween(index, 'function resetBusinessStateForIsolation()', '\n\n// Narrow bridge');
const resetContext = {
  S: {
    employees: [{ id: 'nantes-employee' }], shifts: [{ id: 'nantes-shift' }],
    absences: [{ id: 'nantes-leave' }], punchLog: [{ id: 'nantes-punch' }],
    sites: [{ id: 'nantes' }], erpEntries: [{ id: 'nantes-erp' }],
    registre: [{ id: 'nantes-register' }], templates: [{ id: 'nantes-template' }],
    locks: { week: { nantes: true }, day: { nantes: true } },
    meta: { cloudOrganizationId: 'org-nantes' }
  },
  normalizeState: () => {},
  renderAll: () => { resetContext.rendered = true; },
  rendered: false,
  result: null
};
vm.runInNewContext(`${resetSource}\nresult = resetBusinessStateForIsolation();`, resetContext);
for (const collection of ['employees', 'shifts', 'absences', 'punchLog', 'sites', 'erpEntries', 'registre', 'templates']) {
  assert.equal(resetContext.S[collection].length, 0, `${collection} must be blank after identity reset`);
}
assert.deepEqual(JSON.parse(JSON.stringify(resetContext.S.locks)), { week: {}, day: {} });
assert.equal(resetContext.S.meta.cloudOrganizationId, undefined);
assert.equal(resetContext.rendered, true);

// I3 — cache and queue values are accepted only for their explicit user and
// organization. Legacy values are upgraded only when their scoped key/state is
// compatible with the active organization.
const scopeSource = extractBetween(cloud, '  function scopeLocalRecord(', '  async function readScopedLocalRecord(');
const scopeContext = { result: null };
vm.runInNewContext(`${scopeSource}\nresult = {
  valid: scopeLocalRecord({userId:'user-a',organizationId:'org-a',state:{meta:{cloudOrganizationId:'org-a'}}}, {userId:'user-a',organizationId:'org-a',cacheKey:'state:user-a:org-a'}),
  wrongUser: scopeLocalRecord({userId:'user-b',organizationId:'org-a',state:{}}, {userId:'user-a',organizationId:'org-a',cacheKey:'state:user-a:org-a'}),
  wrongTag: scopeLocalRecord({userId:'user-a',organizationId:'org-b',state:{}}, {userId:'user-a',organizationId:'org-a',cacheKey:'state:user-a:org-a'}),
  wrongState: scopeLocalRecord({state:{meta:{cloudOrganizationId:'org-b'}}}, {userId:'user-a',organizationId:'org-a',cacheKey:'state:user-a:org-a'}),
  upgrade: scopeLocalRecord({state:{employees:[]}}, {userId:'user-a',organizationId:'org-a',cacheKey:'state:user-a:org-a'})
};`, scopeContext);
assert.ok(scopeContext.result.valid);
assert.equal(scopeContext.result.wrongUser, null);
assert.equal(scopeContext.result.wrongTag, null);
assert.equal(scopeContext.result.wrongState, null);
assert.equal(scopeContext.result.upgrade.userId, 'user-a');
assert.equal(scopeContext.result.upgrade.organizationId, 'org-a');
assert.equal(scopeContext.result.upgrade.state.meta.cloudOrganizationId, 'org-a');

const queueSource = extractBetween(cloud, '  function makeQueueEntry(', '  function queueGeneration(');
const queueContext = {
  queueSequence: 0,
  globalThis: { crypto: { randomUUID: () => 'uuid' } },
  App: { remoteRecordRevisions: new Map() },
  currentIdentity: () => null,
  StaleIdentityError: class extends Error {},
  result: null
};
vm.runInNewContext(`${queueSource}\nresult = makeQueueEntry('offline', {employees:[]}, {userId:'user-a',organizationId:'org-a',cacheKey:'state:user-a:org-a'});`, queueContext);
assert.equal(queueContext.result.userId, 'user-a');
assert.equal(queueContext.result.organizationId, 'org-a');
assert.equal(queueContext.result.cacheKey, 'state:user-a:org-a');

// I4 — company bootstrap is clean even if the browser initially contains data
// from Nantes Charcot.
const bootstrapSource = extractBetween(cloud, '  async function bootstrapOrganization()', '  function existingImportForm(');
const bootstrapContext = {
  App: {
    client: { rpc: async () => ({ data: { organization_id: 'org-new' }, error: null }) },
    context: { organization_id: 'org-new' },
    syncNow: async (reason) => { bootstrapContext.syncReason = reason; return true; },
    remoteReady: false
  },
  S: { employees: [{ id: 'nantes-secret' }], shifts: [{ id: 'nantes-shift' }] },
  refreshContext: async () => {},
  currentIdentity: () => ({ userId: 'user-new', organizationId: 'org-new', cacheKey: 'state:user-new:org-new', context: {} }),
  assertIdentity: () => {},
  archiveAndClearLegacyStorage: async () => {},
  resetMemoryForIsolation: () => { bootstrapContext.S = { employees: [], shifts: [], meta: {} }; },
  snapshotForIdentity: (identity) => ({ ...bootstrapContext.S, meta: { cloudOrganizationId: identity.organizationId } }),
  scopedCacheValue: (identity, state, details) => ({ ...details, userId: identity.userId, organizationId: identity.organizationId, state }),
  makeQueueEntry: (reason, state, identity) => ({ reason, state, userId: identity.userId, organizationId: identity.organizationId }),
  dbPutStateAndQueue: async (...args) => { bootstrapContext.queued = args; },
  hideGate: () => {}, renderAccount: () => {}, updateCloudMessaging: () => {}, applyPermissionsToUi: () => {}, safeToast: () => {},
  queued: null, syncReason: null, result: null
};
vm.runInNewContext(`${bootstrapSource}\nresult = bootstrapOrganization();`, bootstrapContext);
await bootstrapContext.result;
assert.equal(bootstrapContext.queued[3].reason, 'first-empty-workspace');
assert.equal(bootstrapContext.queued[3].organizationId, 'org-new');
assert.equal(bootstrapContext.queued[3].state.employees.length, 0);
assert.equal(bootstrapContext.queued[3].state.employees.some((item) => item.id === 'nantes-secret'), false);
assert.equal(bootstrapContext.syncReason, 'first-empty-workspace');

// I5 — restore uses only the selected tenant's scoped record; the old in-memory
// tenant is blanked before the selected tenant is applied.
const restoreSource = extractBetween(cloud, '  async function restoreOrPull()', '  function captureLocalChange(');
assert.equal(restoreSource.includes('existingImportForm('), false, 'unscoped legacy import must not be offered during restore');
const restoreContext = {
  App: { context: { organization_id: 'org-new' }, applyingRemote: false, status: () => {} },
  S: { employees: [{ id: 'nantes-secret' }], meta: { cloudOrganizationId: 'org-nantes' } },
  navigator: { onLine: false },
  currentIdentity: () => ({ userId: 'user-new', organizationId: 'org-new', cacheKey: 'state:user-new:org-new', context: { employee_id: null } }),
  archiveAndClearLegacyStorage: async () => {}, assertIdentity: () => {},
  resetMemoryForIsolation: () => { restoreContext.S = { employees: [], meta: {} }; },
  readScopedLocalRecord: async (store) => store === 'kv'
    ? { userId: 'user-new', organizationId: 'org-new', state: { employees: [{ id: 'new-store' }], meta: { cloudOrganizationId: 'org-new' } } }
    : null,
  clone: (value) => JSON.parse(JSON.stringify(value)), normalizeState: () => {}, renderAll: () => {},
  syncNow: async () => true, fetchRemoteState: async () => { throw new Error('offline pull'); },
  shouldApplyRemoteState: () => true, applyRemoteState: () => {}, snapshotForIdentity: () => ({}), scopedCacheValue: () => ({}), dbPut: async () => {},
  result: null
};
vm.runInNewContext(`${restoreSource}\nresult = restoreOrPull();`, restoreContext);
await restoreContext.result;
assert.deepEqual(JSON.parse(JSON.stringify(restoreContext.S.employees)), [{ id: 'new-store' }]);
assert.equal(restoreContext.S.employees.some((item) => item.id === 'nantes-secret'), false);

// I6 — a context change during synchronization cannot apply the old tenant's
// remote result under the new tenant, and forces a clean sign-out.
const syncSource = extractBetween(cloud, '  async function syncNow(', '\n\n  App.restoreOrPull =');
const identityA = { epoch: 7, userId: 'user-shared', organizationId: 'org-a', cacheKey: 'state:user-shared:org-a', context: {} };
const staleContext = {
  App: {
    session: {}, user: { id: 'user-shared' }, context: { organization_id: 'org-a' }, cacheKey: identityA.cacheKey,
    identityEpoch: 7, syncing: false, switchingContext: false, localChangeRevision: 0,
    status: () => {}, lastError: null, syncTimer: null
  },
  navigator: { onLine: true },
  currentIdentity: () => identityA,
  identityIsCurrent: (identity) => identity.epoch === staleContext.App.identityEpoch
    && identity.userId === staleContext.App.user.id
    && identity.organizationId === staleContext.App.context.organization_id
    && identity.cacheKey === staleContext.App.cacheKey,
  assertIdentity: (identity) => {
    if (!staleContext.identityIsCurrent(identity)) {
      const error = new Error('stale'); error.name = 'StaleIdentityError'; throw error;
    }
  },
  refreshContext: async () => {},
  readScopedLocalRecord: async (_store, _key, identity) => { staleContext.assertIdentity(identity); return null; },
  fetchRemoteState: async () => {
    staleContext.App.context = { organization_id: 'org-b' };
    staleContext.App.cacheKey = 'state:user-shared:org-b';
    return { sites: [], employees: [{ id: 'a-secret' }], privateData: [], records: [] };
  },
  applyRemoteState: () => { staleContext.applied = true; },
  dbDeleteIfUnchanged: async () => true, queueGeneration: () => null,
  pushSnapshot: async () => ({}), scheduleQueuedSync: () => {}, dbPut: async () => {},
  snapshotForIdentity: () => ({}), scopedCacheValue: () => ({}), clone: (value) => JSON.parse(JSON.stringify(value)),
  resetMemoryForIsolation: () => { staleContext.reset = true; },
  logout: async () => { staleContext.loggedOut = true; },
  safeToast: () => {}, applied: false, reset: false, loggedOut: false, result: null
};
vm.runInNewContext(`${syncSource}\nresult = syncNow('realtime');`, staleContext);
assert.equal(await staleContext.result, false);
assert.equal(staleContext.applied, false);
assert.equal(staleContext.reset, true);
assert.equal(staleContext.loggedOut, true);

// I7 — organization switch drains synchronization, removes the old Realtime
// channel and clears memory before mutating App.context.
const switchSource = extractBetween(cloud, '  async function switchOrganization(', '  function renderAccount(');
const contextMutation = switchSource.indexOf('App.context = next');
assert.ok(switchSource.indexOf('await waitForSyncIdle()') < contextMutation);
assert.ok(switchSource.indexOf('await App.client.removeChannel(oldChannel)') < contextMutation);
assert.ok(switchSource.indexOf('resetMemoryForIsolation()') < contextMutation);
assert.ok(switchSource.indexOf('beginIdentityTransition()') < contextMutation);

const logoutSource = extractBetween(cloud, '  async function logout()', '  async function waitForSyncIdle(');
assert.ok(logoutSource.includes('resetMemoryForIsolation()'));
assert.ok(logoutSource.includes('archiveAndClearLegacyStorage(null)'));
assert.ok(logoutSource.includes("signOut({ scope: 'local' })"));
assert.equal(/dbDelete\(['"]queue['"]/.test(logoutSource), false, 'logout must preserve tenant-scoped offline queues');

console.log('Tenant isolation: browser cache, queue, bootstrap, switch and stale-sync checks OK');
