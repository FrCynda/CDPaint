import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: where does a 1 px sharp tip (krita3 pixel1) land for a
// stroke at fractional positions, in each direction? Short segments on a grid.
//   node job.mjs   then   python look at pixel/all/all.png
const root = path.resolve('test/krita/out/pixel');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/pixel1.kpp');
const L = [], F = [0, 0.25, 0.5, 0.75];
F.forEach((f, i) => {
    const y = 20 + i * 10 + f, x = 20 + i * 10 + f;
    L.push([20, y, 1, 60, y, 1], [120, y, 1, 80, y, 1]);             // horizontal, right / left
    L.push([x + 140, 10, 1, x + 140, 50, 1], [x + 240, 50, 1, x + 240, 10, 1]); // vertical, down / up
});
// slope -0.5 and +0.5 lines, both directions, fractional starts
F.forEach((f, i) => {
    const y = 100 + i * 30 + f;
    L.push([20 + f, y + 20, 1, 60 + f, y, 1], [160 + f, y, 1, 120 + f, y + 20, 1]);
    L.push([220 + f, y, 1, 260 + f, y + 20, 1], [360 + f, y + 20, 1, 320 + f, y, 1]);
});
const renders = [{ name: 'all', file: path.basename(kpp), size: 1, lines: L, rects: [] }];
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'lines.json'), JSON.stringify(L));
const job = { width: 400, height: 240, out: root.split(path.sep).join('/'), renders };
fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(job, null, 1));
const res = path.join(root, 'kres');
fs.rmSync(res, { recursive: true, force: true });
fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
renderKrita(path.join(root, 'job.json'), { resourceDir: res, timeoutMs: 600000 });
console.log(fs.readFileSync(path.join(root, 'harness.log'), 'utf8').split('\n').filter(l => /MISSING|rror|FAIL/.test(l)).join('\n') || 'ok');
