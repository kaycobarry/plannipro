import assert from 'node:assert/strict';

const base = 'https://plannipro.eu/';
const pages = ['index.html', 'pointeuse.html', 'pointeuse.webmanifest', 'sw.js', 'plannipro-cloud.js', 'pointeuse.js'];

for (const path of pages) {
  const response = await fetch(new URL(path, base), { redirect: 'follow' });
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  assert.ok((await response.arrayBuffer()).byteLength > 0, `${path}: réponse vide`);
}

const root = await fetch(base, { redirect: 'follow' });
assert.ok(root.ok, `racine publique: HTTP ${root.status}`);
assert.equal(new URL(root.url).protocol, 'https:', 'le site public ne reste pas en HTTPS');
const html = await root.text();
assert.match(html, /PlanniPro/i, 'la page publique ne contient pas PlanniPro');

console.log(`Site public: ${pages.length + 1} ressources HTTPS disponibles.`);
