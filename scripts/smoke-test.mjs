import { readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const dir = join(src, 'js');
// freehand-path-engine.js and tauri-shim.js live in src/ rather than src/js/
// but are loaded by index.html all the same, so they are checked too.
const files = [
  ...readdirSync(dir).filter(f => f.endsWith('.js')).map(f => join(dir, f)),
  ...readdirSync(src).filter(f => f.endsWith('.js')).map(f => join(src, f)),
];

let failed = 0;
for (const f of files) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
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
