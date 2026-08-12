import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const operations = readFileSync('docs/OPERATIONS.md', 'utf8');
const release = readFileSync('docs/RELEASE_GATE.md', 'utf8');
const security = readFileSync('docs/SECURITY_BASELINE.md', 'utf8');
const diagnostics = readFileSync('supabase/diagnostics.sql', 'utf8');
const isolationWorkflow = readFileSync('.github/workflows/tenant-isolation.yml', 'utf8');

for (const script of ['test:static', 'test:remote:anon', 'test:remote:public', 'test:remote:rbac', 'test:remote:isolation']) {
  assert.ok(pkg.scripts?.[script], `script manquant: ${script}`);
}
assert.match(isolationWorkflow, /workflow_dispatch:/, 'la recette multi-magasin doit rester déclenchée manuellement');
assert.doesNotMatch(isolationWorkflow, /^\s+(push|pull_request):/m, 'la recette de production ne doit pas partir sur chaque commit');
for (const secret of ['NANTES_EMAIL', 'NANTES_PASSWORD', 'OTHER_EMAIL', 'OTHER_PASSWORD', 'NANTES_ORGANIZATION_ID', 'OTHER_ORGANIZATION_ID']) {
  assert.ok(isolationWorkflow.includes(`PLANNIPRO_TEST_${secret}`), `secret de recette absent: ${secret}`);
}
assert.match(isolationWorkflow, /npm run test:remote:isolation/, 'le workflow doit exécuter la matrice multi-magasin');
assert.match(operations, /ne sauvegarde pas la base/i, 'la portée de la sauvegarde Git doit être documentée');
assert.match(release, /données de recette ont été supprimées/i, 'le nettoyage de recette doit faire partie de la barrière');
assert.match(security, /89 avis/i, 'la référence Security Advisor doit être chiffrée');
assert.doesNotMatch(diagnostics, /\b(update|delete|insert|truncate|drop|alter)\b\s+(table|from|into)?/i, 'le diagnostic doit rester en lecture seule');
assert.match(diagnostics, /business_record_duplicate_key/, 'le diagnostic doit contrôler les doublons métier');

console.log('Exploitation: barrière de publication, diagnostic et référence sécurité vérifiés.');
