import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cloud = readFileSync('plannipro-cloud.js', 'utf8');
const createCompany = readFileSync('supabase/functions/create-company/index.ts', 'utf8');
const config = readFileSync('supabase/config.toml', 'utf8');

assert.ok((cloud.match(/minlength="10"/g) || []).length >= 2, 'les nouveaux mots de passe doivent contenir au moins 10 caractères');
assert.match(createCompany, /password\.length < 10/, 'la création d’entreprise doit appliquer la même longueur côté serveur');
assert.match(config, /\[auth\][\s\S]*?enable_signup\s*=\s*false/, 'les inscriptions publiques doivent rester désactivées');
assert.doesNotMatch(cloud, /minlength="(?:6|7|8|9)"/, 'une ancienne longueur minimale subsiste dans l’interface');

console.log('Auth: inscription fermée et longueur minimale cohérente vérifiées.');
