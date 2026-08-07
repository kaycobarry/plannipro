import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const expectedVersion = '2.112.2';
const expectedIntegrity = 'sha384-B2duOBIryCXbX4eDE4BdJwtNkQMRQde3o6IsjfPW28E6aH1CYE96hHeZRG3zY56O';
const productFiles = ['index.html', 'pointeuse.html', 'sw.js'];
const edgeFiles = [
  'supabase/functions/create-company/index.ts',
  'supabase/functions/invite-user/index.ts',
  'supabase/functions/publish-planning/index.ts',
  'supabase/functions/revoke-user-sessions/index.ts',
  'supabase/functions/send-clock-pin-invitation/index.ts'
];

for (const file of productFiles) {
  const source = readFileSync(file, 'utf8');
  assert.ok(source.includes(`@supabase/supabase-js@${expectedVersion}`), `${file}: version Supabase non figée`);
  assert.ok(!source.includes('@supabase/supabase-js@2"'), `${file}: version majeure flottante interdite`);
}

for (const file of ['index.html', 'pointeuse.html']) {
  const source = readFileSync(file, 'utf8');
  assert.ok(source.includes(`integrity="${expectedIntegrity}"`), `${file}: intégrité CDN absente`);
  assert.ok(source.includes('crossorigin="anonymous"'), `${file}: crossorigin requis avec SRI`);
}

for (const file of edgeFiles) {
  const source = readFileSync(file, 'utf8');
  assert.ok(source.includes(`@supabase/supabase-js@${expectedVersion}`), `${file}: import Edge non figé`);
}

console.log('Supply-chain Supabase: version exacte et intégrité CDN vérifiées.');
