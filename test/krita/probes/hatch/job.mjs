import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe of Krita's hatching brush, which we paint as a plain round
// brush (11 bank presets). One wide stroke at pressure 1 fills most of the
// canvas with the pattern; each render changes one setting of Hatch_diag_S:
// angle, separation, thickness, origin, and the cross-hatching style. Every
// render sets every hatching value (xmlSub edits persist on the preset).
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs hatch
const root = path.resolve('test/krita/out/hatch');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Hatch_diag_S.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const STYLES = ['nocrosshatching', 'perpendicular', 'minusthenplus', 'plusthenminus', 'moirepattern'];
const base = { angle: -60, separation: 6, thickness: 6, ox: 50, oy: 50, style: 'nocrosshatching', aa: 'true' };
const set = o => [val('PressureSize', 'false'), val('PressureTexture/Strength/', 'false'),
    val('Hatching/angle', o.angle), val('Hatching/separation', o.separation), val('Hatching/thickness', o.thickness),
    val('Hatching/origin_x', o.ox), val('Hatching/origin_y', o.oy), val('Hatching/bool_antialias', o.aa),
    ...STYLES.map(s => val('Hatching/bool_' + s, s === o.style ? 'true' : 'false'))];
const V = { base: {} };
for (const a of [0, 30, 45, 90, -30]) V['a' + a] = { angle: a };
for (const s of [3, 12, 20]) V['sep' + s] = { separation: s };
for (const t of [1, 2, 3, 10]) V['th' + t] = { thickness: t };
V.org00 = { ox: 0, oy: 0 }; V.org30 = { ox: 3, oy: 0 }; V.org07 = { ox: 0, oy: 7 };
for (const s of STYLES.slice(1)) V[s] = { style: s, angle: 30, separation: 12, thickness: 2 };
V.noaa = { aa: 'false', angle: 30, separation: 12, thickness: 3 };
const renders = Object.entries(V).map(([name, o]) => ({ name, file: path.basename(kpp), size: 200,
    lines: [[-40, 130, 1, 520, 130, 1]], rects: [], xmlSub: set({ ...base, ...o }) }));
fs.mkdirSync(root, { recursive: true });
const job = { width: 480, height: 260, out: root.split(path.sep).join('/'), renders };
fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(job, null, 1));
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ ...job, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
if (!process.argv.includes('--dry')) {
    const res = path.join(root, 'kres');
    fs.rmSync(res, { recursive: true, force: true });
    fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
    fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
    renderKrita(path.join(root, 'job.json'), { resourceDir: res, timeoutMs: 600000 });
    for (const r of renders) fs.renameSync(path.join(root, r.name + '.png'), path.join(root, r.name, r.name + '.png'));
    console.log(fs.readFileSync(path.join(root, 'harness.log'), 'utf8').split('\n').filter(l => /MISSING|rror|FAIL|: 0$/.test(l)).join('\n') || 'ok');
}
