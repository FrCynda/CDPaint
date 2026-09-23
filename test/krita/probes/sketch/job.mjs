import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: Krita's sketch engine. The bank's straight lines, plus a
// zigzag and a spiral whose earlier turns lie within reach of later ones, so
// the "curve lines" to nearby history show. One fresh Krita per preset.
//   node job.mjs [a,b] [--dry]   then   node ../probe-cdp.mjs sketch
const root = path.resolve('test/krita/out/sketch');
const dir = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets');
const lines = [[40, 50, 0.1, 440, 50, 1.0], [300, 115, 0.5, 300, 185, 0.5]];
const zig = [60, 120]; for (let i = 1; i <= 6; i++) zig.push(60 + i * 25, i % 2 ? 190 : 120);
const spiral = []; for (let t = 0; t <= 6 * Math.PI; t += 0.1) spiral.push(390 + Math.cos(t) * (8 + t * 5), 170 + Math.sin(t) * (8 + t * 5));
const paths = [zig, spiral.map(v => Math.round(v * 10) / 10)];
const V = { sketch: 'Sketch.kpp', chrome: 'Sketch_chrome.kpp', fur: 'Sketch_fur.kpp', inkbig: 'Sketch_ink_big.kpp',
    speed: 'Sketch_speedpaint.kpp', line: 'Sketch_line.kpp', shade: 'Sketch_shade.kpp' };
const dry = process.argv.includes('--dry');
const arg = process.argv.slice(2).find(a => a !== '--dry');
for (const name of arg ? arg.split(',') : Object.keys(V)) {
    const kpp = path.join(dir, V[name]), out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    const job = { width: 480, height: 300, out: out.split(path.sep).join('/'),
        renders: [{ name, file: V[name], src: kpp, maxSize: 30, lines, paths, dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    const res = path.join(out, 'kres');
    fs.rmSync(res, { recursive: true, force: true });
    fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
    fs.copyFileSync(kpp, path.join(res, 'paintoppresets', V[name]));
    renderKrita(path.join(out, 'job.json'), { resourceDir: res });
    console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /OK|MISSING|rror|FAIL/.test(l)).join(' '));
}
