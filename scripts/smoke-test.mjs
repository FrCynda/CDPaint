import { readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'js');
const files = readdirSync(dir).filter(f => f.endsWith('.js'));

let failed = 0;
for (const f of files) {
  try {
    execSync(`node --check "${join(dir, f)}"`, { stdio: 'pipe' });
  } catch {
    console.error(`FAIL: ${f}`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed syntax check.`);
  process.exit(1);
}
console.log(`OK (${files.length} files)`);
