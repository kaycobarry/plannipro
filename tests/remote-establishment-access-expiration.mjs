import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Recette distante destructive uniquement sur un établissement de recette.
// Elle n'utilise que la clé publique et cinq sessions Auth distinctes.
const config = readFileSync('supabase-config.js', 'utf8');
const url = config.match(/url:\s*['"]([^'"]+)/)?.[1];
const key = config.match(/publishableKey:\s*['"]([^'"]+)/)?.[1];
assert.ok(url && key, 'Configuration publique Supabase introuvable');

const roleNames = ['ADMIN', 'MANAGER', 'SUPERVISOR', 'EMPLOYEE'];
const required = [
  'PLANNIPRO_TEST_ACCESS_ORGANIZATION_ID',
  'PLANNIPRO_TEST_ACCESS_ESTABLISHMENT_ID',
  'PLANNIPRO_TEST_ACCESS_OTHER_ESTABLISHMENT_ID',
  'PLANNIPRO_TEST_ACCESS_OTHER_ORGANIZATION_ID',
  'PLANNIPRO_TEST_ACCESS_OTHER_ORGANIZATION_ESTABLISHMENT_ID',
  'PLANNIPRO_TEST_ACCESS_STORAGE_BUCKET',
  'PLANNIPRO_TEST_ACCESS_STORAGE_PATH',
  ...roleNames.flatMap((role) => [
    `PLANNIPRO_TEST_ACCESS_${role}_EMAIL`,
    `PLANNIPRO_TEST_ACCESS_${role}_PASSWORD`
  ]),
  'PLANNIPRO_TEST_ACCESS_ISOLATED_EMAIL',
  'PLANNIPRO_TEST_ACCESS_ISOLATED_PASSWORD'
];
for (const name of required) assert.ok(process.env[name], `Variable requise absente: ${name}`);

const organizationId = process.env.PLANNIPRO_TEST_ACCESS_ORGANIZATION_ID;
const establishmentId = process.env.PLANNIPRO_TEST_ACCESS_ESTABLISHMENT_ID;
const otherEstablishmentId = process.env.PLANNIPRO_TEST_ACCESS_OTHER_ESTABLISHMENT_ID;
const otherOrganizationId = process.env.PLANNIPRO_TEST_ACCESS_OTHER_ORGANIZATION_ID;
const otherOrganizationEstablishmentId = process.env.PLANNIPRO_TEST_ACCESS_OTHER_ORGANIZATION_ESTABLISHMENT_ID;
assert.notEqual(organizationId, otherOrganizationId, 'deux organisations de recette distinctes sont requises');
assert.equal(process.env.PLANNIPRO_TEST_ACCESS_STORAGE_BUCKET, 'plannipro-documents',
  'le test upload/download requiert un objet du bucket RH privé plannipro-documents');

async function login(role) {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env[`PLANNIPRO_TEST_ACCESS_${role}_EMAIL`],
      password: process.env[`PLANNIPRO_TEST_ACCESS_${role}_PASSWORD`]
    })
  });
  assert.equal(response.status, 200, `connexion ${role} refusée`);
  return response.json();
}

async function api(path, token, options = {}) {
  return fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
}

async function rpc(name, token, body = {}) {
  return api(`rpc/${name}`, token, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

async function json(response, label) {
  const payload = await response.text();
  assert.ok(response.ok, `${label}: HTTP ${response.status} ${payload}`);
  return payload ? JSON.parse(payload) : null;
}

async function assertMutationDenied(response, label) {
  if (!response.ok) return;
  const rows = await response.json();
  assert.deepEqual(rows, [], `${label}: RLS a modifié une ligne au lieu de la filtrer/refuser`);
}

async function setAccess(token, values) {
  return rpc('set_establishment_access', token, {
    p_establishment_id: establishmentId,
    p_access_starts_at: values.access_starts_at,
    p_access_expires_at: values.access_expires_at,
    p_suspended: Boolean(values.access_suspended_at),
    p_reason: values.access_suspended_at ? (values.access_suspension_reason || 'Recette expiration magasin') : null
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

async function realtimeEstablishment(token, suffix) {
  const websocketUrl = new URL(url.replace(/^http/, 'ws'));
  websocketUrl.pathname = '/realtime/v1/websocket';
  websocketUrl.search = new URLSearchParams({ apikey: key, vsn: '1.0.0' }).toString();
  const topic = `realtime:store-access-${suffix}-${crypto.randomUUID()}`;
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
              event: 'UPDATE', schema: 'public', table: 'establishments',
              filter: `id=eq.${establishmentId}`
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
  try {
    await waitFor(() => joinError || messages.some((message) =>
      message.event === 'phx_reply' && message.ref === '1' && message.payload?.status === 'ok'
    ), 30000);
  } catch (error) {
    throw new Error(`${error.message}; messages Realtime: ${JSON.stringify(messages.slice(-5))}`);
  }
  if (joinError) throw joinError;
  return { socket, messages };
}

function receivedUpdate(subscription) {
  return subscription.messages.some((message) => message.event === 'postgres_changes');
}

const sessions = Object.fromEntries(await Promise.all(roleNames.map(async (role) => [role, await login(role)])));
sessions.ISOLATED = await login('ISOLATED');
assert.equal(new Set([...roleNames, 'ISOLATED'].map((role) => sessions[role].user.id)).size, 5,
  'cinq comptes Auth distincts sont requis');

const isolatedContexts = await json(await rpc('get_access_context', sessions.ISOLATED.access_token),
  'contexte organisation isolée');
assert.ok(isolatedContexts.some((item) => item.organization_id === otherOrganizationId),
  'le compte isolé n’est pas rattaché à la seconde organisation');
assert.equal(isolatedContexts.some((item) => item.organization_id === organizationId), false,
  'le compte isolé possède un contexte dans l’organisation principale de recette');

const adminState = await json(await rpc('get_establishment_access_state', sessions.ADMIN.access_token, {
  p_establishment_id: establishmentId
}), 'état initial');
assert.equal(adminState.can_administer_access, true, 'le compte ADMIN ne peut pas administrer le magasin de recette');
assert.ok(['active', 'expiring_soon'].includes(adminState.access_status), 'le magasin de recette doit être actif avant le test');

const baselineAdminEmployees = await json(await api(
  `employees?select=id,display_name&establishment_id=eq.${encodeURIComponent(establishmentId)}`,
  sessions.ADMIN.access_token
), 'lecture salariés initiale ADMIN');
const baselineManagerEmployees = await json(await api(
  `employees?select=id&establishment_id=eq.${encodeURIComponent(establishmentId)}`,
  sessions.MANAGER.access_token
), 'lecture salariés initiale MANAGER');
assert.ok(baselineAdminEmployees.length > 0, 'le magasin de recette doit contenir au moins un salarié visible par ADMIN');
assert.ok(baselineManagerEmployees.length > 0, 'MANAGER doit voir au moins un salarié avant expiration');

const baselineBusinessRecords = await json(await api(
  `business_records?select=id&establishment_id=eq.${encodeURIComponent(establishmentId)}&limit=1`,
  sessions.ADMIN.access_token
), 'lecture métier initiale ADMIN');
assert.ok(baselineBusinessRecords.length > 0, 'le magasin de recette doit contenir un enregistrement métier pour tester DELETE');

const isolatedOwnEmployees = await json(await api(
  `employees?select=id&establishment_id=eq.${encodeURIComponent(otherOrganizationEstablishmentId)}`,
  sessions.ISOLATED.access_token
), 'lecture salariés organisation isolée');
assert.ok(isolatedOwnEmployees.length > 0, 'le compte isolé doit voir un salarié de sa propre organisation');
const isolatedCrossEmployees = await json(await api(
  `employees?select=id&organization_id=eq.${encodeURIComponent(organizationId)}`,
  sessions.ISOLATED.access_token
), 'lecture croisée depuis organisation isolée');
assert.deepEqual(isolatedCrossEmployees, [], 'le compte isolé voit l’organisation principale de recette');
const adminCrossEmployees = await json(await api(
  `employees?select=id&organization_id=eq.${encodeURIComponent(otherOrganizationId)}`,
  sessions.ADMIN.access_token
), 'lecture croisée depuis organisation principale');
assert.deepEqual(adminCrossEmployees, [], 'ADMIN voit la seconde organisation de recette');

const storagePath = String(process.env.PLANNIPRO_TEST_ACCESS_STORAGE_PATH).split('/').map(encodeURIComponent).join('/');
const storageUrl = `${url}/storage/v1/object/authenticated/${encodeURIComponent(process.env.PLANNIPRO_TEST_ACCESS_STORAGE_BUCKET)}/${storagePath}`;
const seedStorageUpload = await fetch(`${url}/storage/v1/object/${encodeURIComponent(process.env.PLANNIPRO_TEST_ACCESS_STORAGE_BUCKET)}/${storagePath}`, {
  method: 'POST',
  headers: {
    apikey: key, Authorization: `Bearer ${sessions.ADMIN.access_token}`,
    'Content-Type': 'text/plain', 'x-upsert': 'true'
  },
  body: 'PlanniPro store access registered probe'
});
const seedStorageUploadBody = await seedStorageUpload.text();
assert.ok(seedStorageUpload.ok,
  `téléversement de l’objet Storage de recette refusé (${seedStorageUpload.status}: ${seedStorageUploadBody})`);
const storageBefore = await fetch(storageUrl, {
  headers: { apikey: key, Authorization: `Bearer ${sessions.ADMIN.access_token}` }
});
assert.ok(storageBefore.ok, 'l’objet Storage de recette doit être lisible avant expiration');
await storageBefore.body?.cancel();
const sourcePathParts = String(process.env.PLANNIPRO_TEST_ACCESS_STORAGE_PATH).split('/');
assert.ok(sourcePathParts.length >= 6, 'chemin Storage RH de recette invalide');
assert.equal(sourcePathParts[0], organizationId, 'l’objet Storage de recette appartient à une autre organisation');
assert.equal(sourcePathParts[1], establishmentId, 'l’objet Storage de recette appartient à un autre magasin');
const uploadPath = [sourcePathParts[0], sourcePathParts[1], sourcePathParts[2], crypto.randomUUID(), crypto.randomUUID(), 'store-access-probe.txt'].join('/');
const uploadUrl = `${url}/storage/v1/object/${encodeURIComponent(process.env.PLANNIPRO_TEST_ACCESS_STORAGE_BUCKET)}/${uploadPath.split('/').map(encodeURIComponent).join('/')}`;

const original = {
  access_starts_at: adminState.access_starts_at,
  access_expires_at: adminState.access_expires_at,
  access_suspended_at: adminState.access_suspended_at,
  access_suspension_reason: adminState.access_suspension_reason
};

let adminRealtime;
let managerRealtime;
let expiredManagerRealtime;
try {
  adminRealtime = await realtimeEstablishment(sessions.ADMIN.access_token, 'admin');
  managerRealtime = await realtimeEstablishment(sessions.MANAGER.access_token, 'manager');
  // Les profils non administrateurs ne peuvent ni prolonger ni suspendre.
  for (const role of ['MANAGER', 'SUPERVISOR', 'EMPLOYEE']) {
    const denied = await setAccess(sessions[role].access_token, {
      access_starts_at: new Date(Date.now() - 60000).toISOString(),
      access_expires_at: new Date(Date.now() + 86400000).toISOString(),
      access_suspended_at: null
    });
    assert.equal(denied.ok, false, `${role} peut modifier l’échéance`);
  }

  // L'Administrateur place le magasin dans une fenêtre déjà expirée.
  const expired = await json(await setAccess(sessions.ADMIN.access_token, {
    access_starts_at: new Date(Date.now() - 7200000).toISOString(),
    access_expires_at: new Date(Date.now() - 3600000).toISOString(),
    access_suspended_at: null
  }), 'expiration administrateur');
  assert.equal(expired.access_status, 'expired');
  await waitFor(() => receivedUpdate(adminRealtime));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(receivedUpdate(managerRealtime), false, 'Realtime a diffusé la ligne expirée au MANAGER');
  expiredManagerRealtime = await realtimeEstablishment(sessions.MANAGER.access_token, 'manager-expired');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(receivedUpdate(expiredManagerRealtime), false, 'une reconnexion Realtime a révélé le magasin expiré');

  // Tous les rôles, Administrateur compris, perdent les données métier.
  for (const role of roleNames) {
    const ownRead = await api(`employees?select=id&establishment_id=eq.${encodeURIComponent(establishmentId)}`, sessions[role].access_token);
    assert.ok(ownRead.ok, `${role}: SELECT en erreur au lieu d’être filtré par RLS`);
    assert.deepEqual(await ownRead.json(), [], `${role}: lecture métier encore visible après expiration`);

    const insert = await api('business_records', sessions[role].access_token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        organization_id: organizationId,
        establishment_id: establishmentId,
        record_type: 'notification',
        legacy_id: `expired-probe-${role.toLowerCase()}-${crypto.randomUUID()}`,
        payload: { expirationProbe: true }
      })
    });
    assert.equal(insert.ok, false, `${role}: INSERT accepté après expiration`);
  }

  const update = await api(`employees?id=eq.${encodeURIComponent(baselineAdminEmployees[0].id)}`, sessions.ADMIN.access_token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ display_name: 'STORE_ACCESS_EXPIRED_PROBE' })
  });
  await assertMutationDenied(update, 'UPDATE après expiration');
  const remove = await api(`business_records?id=eq.${encodeURIComponent(baselineBusinessRecords[0].id)}`, sessions.ADMIN.access_token, {
    method: 'DELETE', headers: { Prefer: 'return=representation' }
  });
  await assertMutationDenied(remove, 'DELETE après expiration');

  const businessRpc = await rpc('preview_planning_publication_recipients', sessions.ADMIN.access_token, {
    p_organization_id: organizationId,
    p_establishment_id: establishmentId,
    p_employee_ids: null
  });
  assert.equal(businessRpc.ok, false, 'RPC Planning encore utilisable sur le magasin expiré');

  const storage = await fetch(storageUrl, {
    headers: { apikey: key, Authorization: `Bearer ${sessions.ADMIN.access_token}` }
  });
  assert.equal(storage.ok, false, 'Storage reste lisible après expiration');
  await storage.body?.cancel();
  const uploadAfter = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: `Bearer ${sessions.ADMIN.access_token}`,
      'Content-Type': 'text/plain', 'x-upsert': 'false'
    },
    body: 'must be rejected'
  });
  assert.equal(uploadAfter.ok, false, 'Storage accepte encore un téléversement après expiration');

  // Le magasin voisin reste isolé et n'est jamais attribué aux trois profils limités.
  for (const role of ['MANAGER', 'SUPERVISOR', 'EMPLOYEE']) {
    const cross = await api(`employees?select=id&establishment_id=eq.${encodeURIComponent(otherEstablishmentId)}`, sessions[role].access_token);
    assert.ok(cross.ok);
    assert.deepEqual(await cross.json(), [], `${role}: accès croisé au second magasin`);
  }

  // Réactivation puis revalidation des quatre JWT sans recréer les comptes.
  const reactivated = await json(await setAccess(sessions.ADMIN.access_token, {
    access_starts_at: new Date(Date.now() - 60000).toISOString(),
    access_expires_at: null,
    access_suspended_at: null
  }), 'réactivation administrateur');
  assert.equal(reactivated.access_status, 'active');
  for (const role of roleNames) {
    const context = await json(await rpc('get_access_context', sessions[role].access_token), `${role}: contexte réactivé`);
    const target = context.flatMap((item) => item.establishment_access || []).find((item) => item.establishment_id === establishmentId);
    assert.equal(target?.access_status, 'active', `${role}: session non revalidée après réactivation`);
  }
  const employeeAfter = await json(await api(
    `employees?select=id,display_name&id=eq.${encodeURIComponent(baselineAdminEmployees[0].id)}`,
    sessions.ADMIN.access_token
  ), 'contrôle UPDATE refusé');
  assert.equal(employeeAfter[0]?.display_name, baselineAdminEmployees[0].display_name, 'UPDATE expiré a altéré le salarié');
  const recordAfter = await json(await api(
    `business_records?select=id&id=eq.${encodeURIComponent(baselineBusinessRecords[0].id)}`,
    sessions.ADMIN.access_token
  ), 'contrôle DELETE refusé');
  assert.equal(recordAfter[0]?.id, baselineBusinessRecords[0].id, 'DELETE expiré a supprimé une donnée métier');
} finally {
  adminRealtime?.socket.close();
  managerRealtime?.socket.close();
  expiredManagerRealtime?.socket.close();
  const restored = await setAccess(sessions.ADMIN.access_token, original);
  assert.ok(restored.ok, `restauration de la fenêtre initiale impossible: ${restored.status}`);
}

console.log('Expiration distante: 5 JWT, 2 organisations, RLS lecture/écriture, RPC, Storage, Realtime, isolation et réactivation OK.');
