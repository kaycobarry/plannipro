import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const operations = readFileSync('docs/OPERATIONS.md', 'utf8');
const release = readFileSync('docs/RELEASE_GATE.md', 'utf8');
const security = readFileSync('docs/SECURITY_BASELINE.md', 'utf8');
const diagnostics = readFileSync('supabase/diagnostics.sql', 'utf8');

for (const script of ['test:static', 'test:remote:anon', 'test:remote:public', 'test:remote:rbac']) {
  assert.ok(pkg.scripts?.[script], `script manquant: ${script}`);
}
assert.match(operations, /ne sauvegarde pas la base/i, 'la portée de la sauvegarde Git doit être documentée');
assert.match(release, /données de recette ont été supprimées/i, 'le nettoyage de recette doit faire partie de la barrière');
assert.match(security, /89 avis/i, 'la référence Security Advisor doit être chiffrée');
assert.doesNotMatch(diagnostics, /\b(update|delete|insert|truncate|drop|alter)\b\s+(table|from|into)?/i, 'le diagnostic doit rester en lecture seule');
assert.match(diagnostics, /business_record_duplicate_key/, 'le diagnostic doit contrôler les doublons métier');

console.log('Exploitation: barrière de publication, diagnostic et référence sécurité vérifiés.');
