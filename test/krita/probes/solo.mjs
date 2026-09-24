// Render probe variants one Krita session each. Within one session Krita can
// keep the previous render's tip (a softness curve the next variant leaves
// alone came back as the last one's), so tip-shape variants go through here.
//   node test/krita/probes/solo.mjs <probe> <variant>...
import fs from 'fs'; import path from 'path';
import { renderKrita } from '../render.mjs';
const [probe, ...names] = process.argv.slice(2);
const root = path.resolve('test/krita/out', probe);
for (const n of names) {
    const d = path.join(root, n), j = JSON.parse(fs.readFileSync(path.join(d, 'job.json'), 'utf8'));
    const res = path.join(d, 'kres'); fs.rmSync(res, { recursive: true, force: true });
    fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
    fs.copyFileSync(j.renders[0].src, path.join(res, 'paintoppresets', path.basename(j.renders[0].src)));
    // the pack's tips beside the preset (a preset two folders under its pack, as the bank lays them out)
    const tips = path.join(path.dirname(path.dirname(j.renders[0].src)), 'brushes');
    if (fs.existsSync(tips)) fs.cpSync(tips, path.join(res, 'brushes'), { recursive: true });
    renderKrita(path.join(d, 'job.json'), { resourceDir: res, timeoutMs: 300000 });
    console.log(n, fs.existsSync(path.join(d, n + '.png')));
}
