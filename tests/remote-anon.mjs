import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('supabase-config.js', 'utf8');
const url = config.match(/url:\s*['"]([^'"]+)/)?.[1];
const key = config.match(/publishableKey:\s*['"]([^'"]+)/)?.[1];
assert.ok(url && key, 'Configuration publique Supabase introuvable');

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const tables = ['organizations', 'employees', 'employee_private_data', 'business_records', 'documents', 'audit_logs'];

for (const table of tables) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
  const body = await response.text();
  assert.ok(response.ok || [401, 403, 404].includes(response.status), `${table}: réponse inattendue ${response.status}`);
  if (response.ok) assert.deepEqual(JSON.parse(body), [], `${table}: des lignes sont visibles sans authentification`);
}

const mutation = await fetch(`${url}/rest/v1/business_records`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
  body: JSON.stringify({
    organization_id: crypto.randomUUID(),
    record_type: 'shift',
    legacy_id: `anonymous-security-test-${crypto.randomUUID()}`,
    payload: {}
  })
});
assert.ok(!mutation.ok, 'une écriture anonyme a été acceptée');

console.log(`RLS distante anonyme: ${tables.length} tables invisibles et écriture refusée.`);
