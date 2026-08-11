import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('supabase-config.js', 'utf8');
const url = config.match(/url:\s*['"]([^'"]+)/)?.[1];
const key = config.match(/publishableKey:\s*['"]([^'"]+)/)?.[1];
assert.ok(url && key, 'Configuration publique Supabase introuvable');

const required = [
  'PLANNIPRO_TEST_NANTES_EMAIL', 'PLANNIPRO_TEST_NANTES_PASSWORD',
  'PLANNIPRO_TEST_OTHER_EMAIL', 'PLANNIPRO_TEST_OTHER_PASSWORD',
  'PLANNIPRO_TEST_NANTES_ORGANIZATION_ID', 'PLANNIPRO_TEST_OTHER_ORGANIZATION_ID'
];
for (const name of required) assert.ok(process.env[name], `Variable requise absente: ${name}`);

const nantesOrganizationId = process.env.PLANNIPRO_TEST_NANTES_ORGANIZATION_ID;
const otherOrganizationId = process.env.PLANNIPRO_TEST_OTHER_ORGANIZATION_ID;
assert.notEqual(nantesOrganizationId, otherOrganizationId, 'les deux organisations de recette doivent être distinctes');

async function login(email, password) {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, 'connexion de recette refusée');
  const session = await response.json();
  assert.ok(session.access_token && session.user?.id, 'JWT utilisateur absent');
  return session;
}

function claims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function api(path, token, options = {}) {
  return fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
}

async function rows(path, token) {
  const response = await api(path, token);
  assert.ok(response.ok, `lecture distante refusée: ${path} (${response.status})`);
  const data = await response.json();
  assert.ok(Array.isArray(data), `réponse non tabulaire: ${path}`);
  return data;
}

async function rpc(name, token, body) {
  return api(`rpc/${name}`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

async function storageDownload(bucket, path, token) {
  return fetch(`${url}/storage/v1/object/authenticated/${encodeURIComponent(bucket)}/${encodePath(path)}`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }
  });
}

function waitFor(predicate, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Délai Realtime dépassé'));
      setTimeout(tick, 80);
    };
    tick();
  });
}

async function realtimeSubscription(token, organizationId, suffix) {
  const websocketUrl = new URL(url.replace(/^http/, 'ws'));
  websocketUrl.pathname = '/realtime/v1/websocket';
  websocketUrl.search = new URLSearchParams({ apikey: key, vsn: '1.0.0' }).toString();
  const topic = `realtime:isolation-${suffix}-${crypto.randomUUID()}`;
  const socket = new WebSocket(websocketUrl);
  const messages = [];
  let joinError = null;
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch (_) { return; }
    messages.push(message);
    if (message.event === 'phx_reply' && message.ref === '1' && message.payload?.status !== 'ok') {
      joinError = new Error(`Abonnement Realtime refusé: ${message.payload?.response?.reason || 'erreur inconnue'}`);
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connexion Realtime impossible')), 10000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.send(JSON.stringify({
        topic,
        event: 'phx_join',
        payload: {
          config: {
            broadcast: { ack: false, self: false },
            presence: { enabled: false },
            postgres_changes: [{
              event: 'INSERT', schema: 'public', table: 'business_records',
              filter: `organization_id=eq.${organizationId}`
            }],
            private: false
          },
          access_token: token
        },
        ref: '1',
        join_ref: '1'
      }));
      resolve();
    }, { once: true });
    socket.addEventListener('error', () => reject(new Error('Erreur WebSocket Realtime')), { once: true });
  });
  await waitFor(() => joinError || messages.some((message) =>
    message.event === 'phx_reply' && message.ref === '1' && message.payload?.status === 'ok'
  ));
  if (joinError) throw joinError;
  return { socket, messages };
}

function receivedProbe(subscription, legacyId) {
  return subscription.messages.some((message) =>
    message.event === 'postgres_changes'
    && (message.payload?.data?.record?.legacy_id === legacyId || message.payload?.record?.legacy_id === legacyId)
  );
}

const [nantes, other] = await Promise.all([
  login(process.env.PLANNIPRO_TEST_NANTES_EMAIL, process.env.PLANNIPRO_TEST_NANTES_PASSWORD),
  login(process.env.PLANNIPRO_TEST_OTHER_EMAIL, process.env.PLANNIPRO_TEST_OTHER_PASSWORD)
]);
const nantesClaims = claims(nantes.access_token);
const otherClaims = claims(other.access_token);
assert.equal(nantesClaims.role, 'authenticated');
assert.equal(otherClaims.role, 'authenticated');
assert.notEqual(nantesClaims.sub, otherClaims.sub, 'deux utilisateurs Auth distincts sont requis');

const [nantesContextsResponse, otherContextsResponse] = await Promise.all([
  rpc('get_access_context', nantes.access_token, {}),
  rpc('get_access_context', other.access_token, {})
]);
assert.ok(nantesContextsResponse.ok && otherContextsResponse.ok, 'contexte d’accès indisponible');
const nantesContexts = await nantesContextsResponse.json();
const otherContexts = await otherContextsResponse.json();
assert.ok(nantesContexts.some((item) => item.organization_id === nantesOrganizationId), 'le compte Nantes n’est pas rattaché à Nantes');
assert.ok(otherContexts.some((item) => item.organization_id === otherOrganizationId), 'le compte de recette n’est pas rattaché au magasin fictif');
assert.equal(nantesContexts.some((item) => item.organization_id === otherOrganizationId), false, 'Nantes possède un contexte du magasin fictif');
assert.equal(otherContexts.some((item) => item.organization_id === nantesOrganizationId), false, 'le magasin fictif possède un contexte Nantes');

const tenantTables = [
  'establishments', 'roles', 'employees', 'employee_private_data', 'employee_self_service',
  'organization_members', 'manager_scopes', 'business_records', 'documents', 'invitations',
  'audit_logs', 'document_categories', 'planning_publications', 'planning_publication_recipients',
  'planning_publication_events', 'time_clock_events', 'user_permissions'
];
for (const table of tenantTables) {
  const [visibleToOther, visibleToNantes] = await Promise.all([
    rows(`${table}?select=organization_id&organization_id=eq.${nantesOrganizationId}&limit=1`, other.access_token),
    rows(`${table}?select=organization_id&organization_id=eq.${otherOrganizationId}&limit=1`, nantes.access_token)
  ]);
  assert.deepEqual(visibleToOther, [], `${table}: le magasin fictif voit Nantes`);
  assert.deepEqual(visibleToNantes, [], `${table}: Nantes voit le magasin fictif`);
}

const [nantesSeesOtherProfile, otherSeesNantesProfile] = await Promise.all([
  rows(`profiles?select=id&id=eq.${other.user.id}`, nantes.access_token),
  rows(`profiles?select=id&id=eq.${nantes.user.id}`, other.access_token)
]);
assert.deepEqual(nantesSeesOtherProfile, [], 'Nantes voit le profil du magasin fictif');
assert.deepEqual(otherSeesNantesProfile, [], 'le magasin fictif voit le profil Nantes');

const otherEstablishments = await rows(
  `establishments?select=id&organization_id=eq.${otherOrganizationId}&limit=1`,
  other.access_token
);
assert.ok(otherEstablishments[0]?.id, 'aucun établissement disponible pour la sonde du magasin fictif');
const otherEstablishmentId = otherEstablishments[0].id;

for (const [token, allowedOrganization, forbiddenOrganization] of [
  [nantes.access_token, nantesOrganizationId, otherOrganizationId],
  [other.access_token, otherOrganizationId, nantesOrganizationId]
]) {
  const ownClock = await rpc('list_time_clock_devices', token, { p_organization_id: allowedOrganization });
  assert.ok(ownClock.ok, 'la liste de pointeuses du magasin autorisé est indisponible');
  const crossClock = await rpc('list_time_clock_devices', token, { p_organization_id: forbiddenOrganization });
  assert.equal(crossClock.ok, false, 'une pointeuse d’un autre magasin est accessible');
}

const crossWriteId = `isolation-cross-${crypto.randomUUID()}`;
for (const [token, forbiddenOrganization] of [
  [nantes.access_token, otherOrganizationId],
  [other.access_token, nantesOrganizationId]
]) {
  const response = await api('business_records', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      organization_id: forbiddenOrganization,
      record_type: 'notification',
      legacy_id: crossWriteId,
      payload: { isolationProbe: true }
    })
  });
  assert.equal(response.ok, false, 'une écriture inter-magasin a été acceptée');
}

const storageCandidates = [];
const nantesVersions = await rows('document_versions?select=storage_path&limit=1', nantes.access_token);
if (nantesVersions[0]?.storage_path) storageCandidates.push(['plannipro-documents', nantesVersions[0].storage_path]);
const nantesPublications = await rows('planning_publications?select=global_pdf_path&global_pdf_path=not.is.null&limit=1', nantes.access_token);
if (nantesPublications[0]?.global_pdf_path) storageCandidates.push(['planning-publications', nantesPublications[0].global_pdf_path]);
assert.ok(storageCandidates.length, 'aucun objet Storage Nantes disponible pour la recette croisée');
for (const [bucket, path] of storageCandidates) {
  const ownDownload = await storageDownload(bucket, path, nantes.access_token);
  assert.ok(ownDownload.ok, `objet Storage Nantes illisible par Nantes (${bucket})`);
  await ownDownload.body?.cancel();
  const crossDownload = await storageDownload(bucket, path, other.access_token);
  assert.equal(crossDownload.ok, false, `objet Storage Nantes lisible par le magasin fictif (${bucket})`);
  await crossDownload.body?.cancel();
}

const probeLegacyId = `isolation-realtime-${crypto.randomUUID()}`;
const probeRecordType = 'shift';
let ownRealtime;
let crossRealtime;
try {
  ownRealtime = await realtimeSubscription(other.access_token, otherOrganizationId, 'own');
  crossRealtime = await realtimeSubscription(nantes.access_token, otherOrganizationId, 'cross');
  const insert = await api('business_records', other.access_token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      organization_id: otherOrganizationId,
      establishment_id: otherEstablishmentId,
      record_type: probeRecordType,
      legacy_id: probeLegacyId,
      payload: { isolationProbe: true, date: '2099-12-31', start: '00:00', end: '00:15' }
    })
  });
  assert.ok(insert.ok, `création de la sonde Realtime refusée (${insert.status})`);
  await waitFor(() => receivedProbe(ownRealtime, probeLegacyId));
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.equal(receivedProbe(crossRealtime, probeLegacyId), false, 'Realtime a diffusé le magasin fictif vers Nantes');
} finally {
  ownRealtime?.socket.close();
  crossRealtime?.socket.close();
  await api(`business_records?organization_id=eq.${otherOrganizationId}&record_type=eq.${probeRecordType}&legacy_id=eq.${encodeURIComponent(probeLegacyId)}`, other.access_token, {
    method: 'DELETE', headers: { Prefer: 'return=minimal' }
  }).catch(() => {});
}

const cleanup = await rows(`business_records?select=id&organization_id=eq.${otherOrganizationId}&record_type=eq.${probeRecordType}&legacy_id=eq.${encodeURIComponent(probeLegacyId)}`, other.access_token);
assert.deepEqual(cleanup, [], 'la sonde Realtime n’a pas été supprimée');

console.log(`Isolation distante réelle: 2 JWT, ${tenantTables.length} tables, Pointeuse, Storage et Realtime validés.`);
