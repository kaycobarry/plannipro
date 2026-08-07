import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = readFileSync('supabase-config.js', 'utf8');
const url = config.match(/url:\s*['"]([^'"]+)/)?.[1];
const key = config.match(/publishableKey:\s*['"]([^'"]+)/)?.[1];
assert.ok(url && key, 'Configuration publique Supabase introuvable');

const trustedOrigin = 'https://plannipro.eu';
const untrustedOrigin = 'https://attacker.invalid';
const functions = [
  'create-company',
  'invite-user',
  'revoke-user-sessions',
  'publish-planning',
  'send-clock-pin-invitation'
];

for (const name of functions) {
  const endpoint = `${url}/functions/v1/${name}`;
  const preflight = await fetch(endpoint, {
    method: 'OPTIONS',
    headers: {
      Origin: trustedOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,apikey,content-type'
    }
  });
  assert.ok(preflight.ok, `${name}: préflight CORS refusé (${preflight.status})`);
  assert.equal(preflight.headers.get('access-control-allow-origin'), trustedOrigin, `${name}: origine PlanniPro non reflétée`);

  const hostile = await fetch(endpoint, {
    method: 'OPTIONS',
    headers: { Origin: untrustedOrigin, 'Access-Control-Request-Method': 'POST' }
  });
  assert.notEqual(hostile.headers.get('access-control-allow-origin'), untrustedOrigin, `${name}: une origine tierce est autorisée`);

  const anonymous = await fetch(endpoint, {
    method: 'POST',
    headers: { apikey: key, Origin: trustedOrigin, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(anonymous.status, 401, `${name}: un appel sans session n'est pas rejeté en 401`);
}

console.log(`Edge Functions distantes: ${functions.length} préflights stricts et appels anonymes refusés.`);
