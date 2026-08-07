import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('supabase-config.js', 'utf8');
const url = config.match(/url:\s*['"]([^'"]+)/)?.[1];
const key = config.match(/publishableKey:\s*['"]([^'"]+)/)?.[1];
assert.ok(url && key, 'Configuration publique Supabase introuvable');

const required = [
  'PLANNIPRO_TEST_MANAGER_EMAIL', 'PLANNIPRO_TEST_MANAGER_PASSWORD',
  'PLANNIPRO_TEST_EMPLOYEE_EMAIL', 'PLANNIPRO_TEST_EMPLOYEE_PASSWORD',
  'PLANNIPRO_TEST_FORBIDDEN_ESTABLISHMENT_ID'
];
for (const name of required) assert.ok(process.env[name], `Variable requise absente: ${name}`);

async function login(email, password) {
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200, `connexion de recette refusée pour ${email}`);
  return response.json();
}

async function rest(path, token, options = {}) {
  return fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  });
}

const manager = await login(process.env.PLANNIPRO_TEST_MANAGER_EMAIL, process.env.PLANNIPRO_TEST_MANAGER_PASSWORD);
const employee = await login(process.env.PLANNIPRO_TEST_EMPLOYEE_EMAIL, process.env.PLANNIPRO_TEST_EMPLOYEE_PASSWORD);

const managerContextResponse = await rest('rpc/get_access_context', manager.access_token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.ok(managerContextResponse.ok, 'contexte manager indisponible');
const managerContexts = await managerContextResponse.json();
assert.ok(managerContexts.some((context) => context.role_key === 'manager'), 'le compte de recette n’est pas manager');

const forbidden = encodeURIComponent(process.env.PLANNIPRO_TEST_FORBIDDEN_ESTABLISHMENT_ID);
const managerCrossSite = await rest(`employees?select=id&establishment_id=eq.${forbidden}`, manager.access_token);
assert.ok(managerCrossSite.ok, 'lecture manager impossible');
assert.deepEqual(await managerCrossSite.json(), [], 'le manager voit un établissement interdit');

const employeeContextResponse = await rest('rpc/get_access_context', employee.access_token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.ok(employeeContextResponse.ok, 'contexte salarié indisponible');
const employeeContexts = await employeeContextResponse.json();
const employeeContext = employeeContexts.find((context) => context.role_key === 'employee');
assert.ok(employeeContext?.employee_id, 'le compte salarié n’est pas relié à sa fiche');

const visibleEmployees = await rest('employees?select=id', employee.access_token);
assert.ok(visibleEmployees.ok, 'lecture de sa fiche refusée au salarié');
const employeeRows = await visibleEmployees.json();
assert.ok(employeeRows.length <= 1 && employeeRows.every((row) => row.id === employeeContext.employee_id), 'le salarié voit une autre fiche');

const privateRows = await rest('employee_private_data?select=employee_id', employee.access_token);
assert.ok(privateRows.ok, 'lecture RLS des données privées en erreur');
assert.ok((await privateRows.json()).every((row) => row.employee_id === employeeContext.employee_id), 'le salarié voit des données RH privées tierces');

console.log('RLS distante multi-rôles: manager isolé et salarié limité à sa fiche.');
