import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const sql = read('supabase/planning-publications.sql');
const edge = read('supabase/functions/publish-planning/index.ts');
const pdf = read('supabase/functions/_shared/planning-pdf.ts');
const ui = read('plannipro-publications.js');
const css = read('plannipro-publications.css');
const html = read('index.html');
const cloud = read('plannipro-cloud.js');
const sw = read('sw.js');

const results = [];
function scenario(name, callback) {
  callback(); results.push(name); console.log(`OK ${String(results.length).padStart(2, '0')} - ${name}`);
}
function contains(source, pattern, message) { assert.match(source, pattern, message); }

const sandbox = { window: {}, navigator: { onLine: true }, document: {}, console, TextEncoder, crypto: webcrypto, setTimeout, clearTimeout };
vm.runInNewContext(ui, sandbox, { filename: 'plannipro-publications.js' });
const publicationApi = sandbox.window.PlanniProPublications;
const hashA = await publicationApi.stableHash({ b: 2, a: 1 });
const hashB = await publicationApi.stableHash({ a: 1, b: 2 });

const durationStart = html.indexOf('function planningDurationMinutes');
const durationEnd = html.indexOf('/* Correct hours for any shift type */', durationStart);
const durationSandbox = {};
vm.runInNewContext(html.slice(durationStart, durationEnd), durationSandbox);
const contractHoursStart = html.indexOf('function planningContractHours');
const contractHoursEnd = html.indexOf('function getPlanningPublicationSnapshot', contractHoursStart);
const contractHoursSandbox = {
  S: { weekStart: '2026-08-03' },
  CCN: { refH: 35 },
  iso: (value) => typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10),
  dA: (value, days) => new Date(value.getTime() + days * 86400000),
  wkDays: (start) => Array.from({ length: 7 }, (_, day) => {
    const value = new Date(`${start}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + day);
    return value.toISOString().slice(0, 10);
  })
};
vm.runInNewContext(html.slice(contractHoursStart, contractHoursEnd), contractHoursSandbox);

scenario('hash stable malgré l’ordre des clés', () => assert.equal(hashA, hashB));
scenario('ordre des salariés stabilisé avant hash', () => contains(html, /\.sort\(\(a,b\)=>a\.employee_id\.localeCompare\(b\.employee_id\)\)/, 'employee order'));
scenario('ordre des shifts stabilisé avant hash', () => contains(html, /shifts[\s\S]*\.sort\(\(a,b\)=>/, 'shift order'));
scenario('durée journée normale', () => assert.equal(durationSandbox.planningDurationMinutes('09:00','17:30'), 510));
scenario('durée de nuit', () => assert.equal(durationSandbox.planningDurationMinutes('22:00','06:00'), 480));
scenario('horaire identique vaut zéro', () => assert.equal(durationSandbox.planningDurationHours('08:00','08:00'), 0));
scenario('horaire invalide refusé', () => assert.equal(durationSandbox.planningDurationMinutes('25:00','08:00'), 0));
scenario('pause non payée déduite une fois', () => contains(html, /const pauseH = \(sh\.pauseMin \|\| 0\) \/ 60;[\s\S]*Math\.max\(0, h - pauseH\)/));
scenario('double shift additionné', () => contains(html, /type==='double'.*h \+= hrs\(sh\.s2, sh\.e2\)/));
scenario('avenant actif prioritaire', () => contains(html, /sourceAmendments[\s\S]*item\.start<=end[\s\S]*sort\(\(a,b\)=>String\(b\.start\)/));
scenario('volume contractuel RH prioritaire sur un ancien miroir planning', () => {
  assert.equal(contractHoursSandbox.planningContractHours({ maxH: 24, planningContractHours: 35 }, '2026-08-03'), 24);
});
scenario('enregistrement RH synchronise le miroir planning', () => contains(html, /maxH:weeklyContractHours,\s*planningContractHours:weeklyContractHours/));
scenario('synchronisation cloud regenere le miroir depuis le contrat', () => contains(cloud, /employee\?\.maxH \?\? employee\?\.planningContractHours/));
scenario('migration transactionnelle', () => { contains(sql, /^begin;/m); contains(sql, /commit;\s*$/); });
scenario('version unique par semaine et établissement', () => contains(sql, /unique \(organization_id, establishment_id, week_start, version\)/));
scenario('clé d’idempotence unique', () => contains(sql, /unique \(organization_id, idempotency_key\)/));
scenario('instantané protégé par trigger immuable', () => contains(sql, /planning_publication_snapshot_immutable/));
scenario('RLS activée sur les trois tables', () => assert.equal((sql.match(/enable row level security/g) || []).length, 3));
scenario('écriture directe authentifiée révoquée', () => contains(sql, /revoke insert, update, delete on public\.planning_publications/));
scenario('bucket PDF privé', () => contains(sql, /planning-publications', 'planning-publications', false/));
scenario('salarié limité à ses PDF', () => contains(sql, /employee_id = public\.current_employee_id\(organization_id\)/));
scenario('permission planning.publish vérifiée en base', () => contains(sql, /has_permission\(p_organization_id, 'planning\.publish'\)/));
scenario('Edge Function exige un JWT et repasse par RLS', () => { contains(edge, /Authentication required/); contains(edge, /userClient\.rpc\("create_planning_publication"/); });
scenario('aucun secret fournisseur dans le navigateur', () => { assert.doesNotMatch(ui, /RESEND_API_KEY|SERVICE_ROLE/); assert.doesNotMatch(html, /RESEND_API_KEY|SERVICE_ROLE/); });
scenario('envoi réel via Resend avec idempotence', () => {
  contains(edge, /https:\/\/api\.resend\.com\/emails/);
  contains(edge, /Idempotency-Key/);
  contains(edge, /PLANNING_EMAIL_FROM/);
  contains(edge, /PLANNING_EMAIL_REPLY_TO/);
  contains(edge, /reply_to/);
});
scenario('succès enregistré seulement avec identifiant fournisseur', () => contains(edge, /!response\.ok \|\| !provider\.id[\s\S]*status: "sent"/));
scenario('PDF global et individuel générés en A4 paysage', () => {
  contains(pdf, /MediaBox \[0 0 842 595\]/);
  contains(pdf, /WinAnsiEncoding/);
  contains(pdf, /publication_version/);
  contains(pdf, /publication_date/);
  contains(edge, /buildGlobalPlanningPdf/);
  contains(edge, /buildEmployeePlanningPdf/);
});
scenario('UI, Realtime, hors-ligne et cache raccordés sans fuite', () => {
  contains(ui, /require\?\.\('planning', 'publish'\)/); contains(ui, /if \(!navigator\.onLine\)/);
  contains(ui, /removeChannel\(state\.channel\)/); contains(cloud, /PlanniProPublications\?\.shutdown/);
  contains(ui, /planningPublicationHistorySlot/); contains(html, /id="topbarTools"/);
  contains(html, /id="topbarAccountSlot"/); contains(cloud, /getElementById\('topbarAccountSlot'\)/);
  contains(css, /position:sticky;right:0/); contains(sw, /plannipro-shell-v31/);
  contains(html, /\.gh-day\{position:sticky;top:0/);
  assert.doesNotMatch(html, /cell\.style\.position\s*=\s*['"]relative['"]/);
  contains(html, /\.gr-fc-day\{position:sticky;bottom:0/);
  contains(html, /\.gr-fc-tot\{position:sticky;right:0;bottom:0/);
});

assert.equal(results.length, 28);
console.log(`\n${results.length}/28 scénarios de publication vérifiés.`);
