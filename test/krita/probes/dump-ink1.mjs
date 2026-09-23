import fs from 'fs'; import path from 'path';
import { renderKrita } from '../render.mjs';
// Writes Krita's own XML for Ink-1 Precision to test/krita/out/spacing/off.xml,
// the base every Ink-1 probe edits. Run once before the probes.
const out = path.resolve('test/krita/out/spacing');
fs.mkdirSync(out, { recursive: true });
const job = { width: 64, height: 64, out: out.split(path.sep).join('/'),
    renders: [{ name: 'off', preset: 'd) Ink-1 Precision', size: 12, lines: [[10, 32, 1, 50, 32, 1]], dumpXml: true }] };
fs.writeFileSync(path.join(out, 'dump-job.json'), JSON.stringify(job));
renderKrita(path.join(out, 'dump-job.json'));
console.log(fs.existsSync(path.join(out, 'off.xml')) ? 'wrote off.xml' : 'no XML written -- see harness.log');
