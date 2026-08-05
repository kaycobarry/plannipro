import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), 'utf8');
const sql = read('supabase/time-clock-secure-activation.sql');
const js = read('pointeuse.js');
const html = read('pointeuse.html');
const index = read('index.html');

const scenarios = [
  ['01 première ouverture sans terminal', js.includes("state.device ? 'kiosk' : 'activation'")],
  ['02 aucune création automatique', !js.includes('register_time_clock_device')],
  ['03 activation avec code valide', js.includes("callRpc('activate_time_clock_device'")],
  ['04 code expiré refusé', sql.includes('v_activation.expires_at <= now()')],
  ['05 code consommé refusé', sql.includes('v_activation.used_at is not null')],
  ['06 reconnaissance après actualisation', js.includes('await loadDevice()') && js.includes('await refreshDevice()')],
  ['07 reconnaissance après fermeture', js.includes("DEVICE_STORAGE_KEY = 'plannipro_clock_device_token'")],
  ['08 stockage perdu affiche activation', js.includes("if (!stored?.device || !stored?.tokenCipher) return")],
  ['09 terminal désactivé', sql.includes("v_device.status <> 'active'")],
  ['10 terminal révoqué', sql.includes("p_status = 'revoked'")],
  ['11 suppression sans pointage', sql.includes("if v_count = 0 then") && sql.includes('delete from public.time_clock_devices')],
  ['12 archivage avec historique', sql.includes("'time_clock.device_archived'") && sql.includes('deleted_at = now()')],
  ['13 génération serveur du PIN', sql.includes('function public.secure_six_digit_pin')],
  ['14 aucun PIN en clair en base', sql.includes("extensions.crypt(v_pin, extensions.gen_salt('bf', 12))")],
  ['15 saisie correcte', js.includes("callRpc('verify_time_clock_pin'")],
  ['16 saisie incorrecte non énumérante', sql.includes("'error', 'Code incorrect ou indisponible'")],
  ['17 blocage après plusieurs essais', sql.includes('v_attempts >= 5')],
  ['18 déblocage après expiration', sql.includes('v_device.locked_until > now()')],
  ['19 réinitialisation du PIN', js.includes("employee.has_pin ? 'Réinitialiser' : 'Générer'")],
  ['20 invitation expirée', sql.includes('v_invitation.expires_at <= now()')],
  ['21 invitation à usage unique', sql.includes('v_invitation.used_at is not null')],
  ['22 salarié désactivé refusé', sql.includes("employment_status = 'active'")],
  ['23 autre établissement refusé', sql.includes('e.establishment_id = v_device.establishment_id')],
  ['24 permission requise', sql.includes("public.can_manage_clock_device(p_organization_id, p_establishment_id, 'clock_devices.create')")],
  ['25 isolation inter-tenant', sql.includes('e.organization_id = v_device.organization_id')],
  ['26 pointage entrée', js.includes('clock_in')],
  ['27 pointage sortie', js.includes('clock_out')],
  ['28 double pointage refusé/idempotent', sql.includes('client_event_id = p_client_event_id') && sql.includes('duplicate')],
  ['29 correction séparée et protégée', index.includes("function updatePunch(")],
  ['30 responsive tablette/mobile/ordinateur', html.includes('@media(max-width:780px)')]
];

for (const [name, passed] of scenarios) assert.ok(passed, `Scenario path missing: ${name}`);
assert.equal(scenarios.length, 30);
console.log(`Time-clock acceptance paths: ${scenarios.length}/30 OK (static coverage; remote and visual execution still required)`);
