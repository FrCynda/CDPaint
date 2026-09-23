import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: how far Krita's sketch brush reaches back. A paintPath is
// one paintLine per vertex, and only vertices become history (job.mjs's zigzag,
// seven corners far apart, drew no curve lines at all). So every stroke here
// is laid in 2px steps: a straight run, and U-turns whose way back runs d px
// from the way out -- a curve line appears across the gap once d is in reach.
// Sketch chrome: probability 1, so nothing is left to chance.
//   node reach.mjs [s30,s60] [--dry]   then   node ../probe-cdp.mjs sketch-reach
const root = path.resolve('test/krita/out/sketch-reach');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Sketch_chrome.kpp');
const run = (x0, x1, y) => { const o = []; for (let x = x0; x0 < x1 ? x <= x1 : x >= x1; x += x0 < x1 ? 2 : -2) o.push(x, y); return o; };
const paths = [run(20, 460, 20)];
[4, 8, 12, 16, 24, 32].forEach((d, i) => { const y = 50 + i * 42; paths.push([...run(20, 200, y), ...run(200, 20, y + d)]); });
[4, 8, 12, 16, 24, 32].forEach((d, i) => { const y = 50 + i * 42; paths.push([...run(260, 440, y), ...run(440, 260, y + d)]); });
const V = { s30: 30, s60: 60 };
const dry = process.argv.includes('--dry');
const arg = process.argv.slice(2).find(a => a !== '--dry');
for (const name of arg ? arg.split(',') : Object.keys(V)) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    // left column at the size named, right column at half of it
    const job = { width: 480, height: 310, out: out.split(path.sep).join('/'),
        renders: [{ name, file: path.basename(kpp), src: kpp, size: V[name], paths: paths.slice(0, 7) },
                  { name: name + 'h', file: path.basename(kpp), src: kpp, size: V[name] / 2, paths: paths.slice(7) }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    const res = path.join(out, 'kres');
    fs.rmSync(res, { recursive: true, force: true });
    fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
    fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
    renderKrita(path.join(out, 'job.json'), { resourceDir: res });
    console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /OK|MISSING|rror|FAIL/.test(l)).join(' '));
}
