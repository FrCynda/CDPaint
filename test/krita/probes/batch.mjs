// Render probe variants in ONE Krita session: Krita takes ~25s to start and
// well under a second a render, and the harness puts each preset's own XML
// back before every render, so variants no longer leak into each other.
//   node test/krita/probes/batch.mjs <probe>[,<probe>...] [<variant>...]   (no variants: all of them)
import fs from 'fs'; import path from 'path';
import { renderKrita } from '../render.mjs';
const [probes, ...names] = process.argv.slice(2);
const runs = [];
for (const probe of probes.split(',')) {
    const root = path.resolve('test/krita/out', probe);
    for (const n of names.length ? names : fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'job.json'))))
        if (fs.existsSync(path.join(root, n, 'job.json'))) runs.push(path.join(root, n));
}
if (!runs.length) throw new Error('no such variants: ' + names.join(' ') + ' (variants are separate arguments)');
const jobs = runs.map(d => JSON.parse(fs.readFileSync(path.join(d, 'job.json'), 'utf8')));
const W = Math.max(...jobs.map(j => j.width)), H = Math.max(...jobs.map(j => j.height));
const tmp = path.resolve('test/krita/out/.batch'); fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
// every variant keeps its own canvas size: a bigger shared canvas is cropped back after
const renders = jobs.map((j, i) => ({ ...j.renders[0], name: 'v' + i }));
const res = path.join(tmp, 'kres'); fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
for (const r of renders) {
    fs.copyFileSync(r.src, path.join(res, 'paintoppresets', path.basename(r.src)));
    const tips = path.join(path.dirname(path.dirname(r.src)), 'brushes');   // the pack's tips beside the preset
    if (fs.existsSync(tips)) fs.cpSync(tips, path.join(res, 'brushes'), { recursive: true });
}
fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify({ width: W, height: H, out: tmp.split(path.sep).join('/'), renders }, null, 1));
const t = Date.now();
renderKrita(path.join(tmp, 'job.json'), { resourceDir: res, timeoutMs: 600000 });
const { execFileSync } = await import('child_process');
runs.forEach((d, i) => {
    const out = path.join(d, path.basename(d) + '.png'), src = path.join(tmp, 'v' + i + '.png');
    if (!fs.existsSync(src)) return console.log(path.basename(d), 'MISSING');
    if (jobs[i].width === W && jobs[i].height === H) fs.copyFileSync(src, out);
    else execFileSync('python', ['-c', 'import sys;from PIL import Image;Image.open(sys.argv[1]).crop((0,0,int(sys.argv[3]),int(sys.argv[4]))).save(sys.argv[2])', src, out, jobs[i].width, jobs[i].height]);
    console.log(path.basename(d), true);
});
console.log(`${runs.length} renders in ${Math.round((Date.now() - t) / 1000)}s`);
