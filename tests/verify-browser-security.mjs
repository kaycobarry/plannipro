import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of ['index.html', 'pointeuse.html']) {
  const source = readFileSync(file, 'utf8');
  assert.match(source, /http-equiv="Content-Security-Policy"/, `${file}: CSP absente`);
  assert.match(source, /default-src 'self'/, `${file}: source par défaut non restreinte`);
  assert.match(source, /object-src 'none'/, `${file}: objets embarqués non bloqués`);
  assert.match(source, /base-uri 'self'/, `${file}: base URI non protégée`);
  assert.match(source, /form-action 'self'/, `${file}: destination des formulaires non protégée`);
  assert.match(source, /connect-src[^>]+pkviymixsxwtwrarqomi\.supabase\.co/, `${file}: connexion Supabase non déclarée`);
  assert.match(source, /name="referrer" content="strict-origin-when-cross-origin"/, `${file}: politique Referrer absente`);
  assert.ok(!/service_role|SUPABASE_SERVICE_ROLE_KEY/i.test(source), `${file}: secret privilégié interdit`);
}

console.log('Sécurité navigateur: CSP minimale, Referrer et secrets vérifiés.');
