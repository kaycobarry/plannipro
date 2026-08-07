import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const cloud = readFileSync('plannipro-cloud.js', 'utf8');

assert.match(cloud, /baseRecordRevisionsCaptured:\s*true/, 'la file hors ligne doit mémoriser les révisions de départ');
assert.match(cloud, /function detectBusinessRecordConflicts\(/, 'la détection de conflits métier doit exister');
assert.match(cloud, /Number\(base\[key\]\)\s*!==\s*Number\(remote\.revision/, 'la révision distante doit être comparée à la base locale');
assert.match(cloud, /throw new SyncConflictError\(preflightConflicts\)/, 'un conflit doit bloquer l’écriture distante');
assert.match(cloud, /if \(!hadBase && !local\) return;/, 'une création distante sans collision locale ne doit pas produire un faux conflit');
assert.ok(cloud.indexOf('const preflightConflicts = detectBusinessRecordConflicts(') < cloud.indexOf("upsert(siteRows"), 'la détection doit précéder toute écriture de site');
assert.match(cloud, /dbPut\('backups', `conflict:/, 'un conflit doit créer une sauvegarde locale');
assert.match(cloud, /dbRebaseQueueIfChanged\(/, 'une modification locale concurrente doit être rebasée après une poussée réussie');
assert.match(cloud, /\.range\(from, from \+ pageSize - 1\)/, 'les lectures Supabase doivent être paginées');
assert.match(cloud, /page\.length < pageSize/, 'la pagination doit s’arrêter sur la dernière page');

console.log('Synchronisation: pagination et protection contre les conflits vérifiées.');
