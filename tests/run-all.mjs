import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const tests = readdirSync(testDirectory)
  .filter((name) => /^verify-.*\.mjs$/.test(name))
  .sort();

if (!tests.length) {
  console.error('Aucun test statique PlanniPro trouvé.');
  process.exit(1);
}

for (const test of tests) {
  console.log(`\n▶ ${test}`);
  const result = spawnSync(process.execPath, [join(testDirectory, test)], {
    cwd: join(testDirectory, '..'),
    stdio: 'inherit'
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\n${tests.length} suites PlanniPro réussies.`);
