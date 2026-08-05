import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const index = fs.readFileSync(new URL('index.html', root), 'utf8');
const cloud = fs.readFileSync(new URL('plannipro-cloud.js', root), 'utf8');
const serviceWorker = fs.readFileSync(new URL('sw.js', root), 'utf8');
const sources = `${index}\n${cloud}`;

assert.match(index, /employees:\s*\[\],\s*shifts:\s*\[\],\s*absences:\s*\[\]/);
assert.match(index, /punchLog:\s*\[\],\s*sites:\s*\[\],\s*erpEntries:\s*\[\],\s*registre:\s*\[\]/);
assert.ok(!/const\s+seeds\s*=/.test(index), 'Automatic planning seed remains');
assert.ok(!/S\.employees\s*=\s*\[\s*\{/.test(index), 'Automatic employee seed remains');
assert.ok(!/if\s*\(\s*!S\.sites\.length\s*\)\s*S\.sites\s*=/.test(index), 'Automatic establishment seed remains');
assert.ok(!/[a-z0-9._%+-]+@mail\.fr/i.test(sources), 'Bundled employee contact data remains');
assert.match(index, /isLegacyBundledDemoState\(indexedSnapshot\.state\)/, 'Legacy demo IndexedDB snapshots must be ignored');
assert.match(serviceWorker, /plannipro-shell-v28/, 'Service Worker cache version was not incremented');
assert.match(serviceWorker, /const isNavigation = event\.request\.mode === "navigate"/, 'HTML navigations must use the network-first path');
assert.ok(serviceWorker.indexOf('fetch(event.request)') < serviceWorker.indexOf('caches.match(event.request)'), 'Navigation fetch must be attempted before its cache fallback');

console.log('Clean first-run checks: OK');
