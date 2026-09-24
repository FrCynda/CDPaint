import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: how do the hatching brush's thickness and separation
// sensors act? Hatch_diag_S (angle -60, separation 6, thickness 6), one wide
// stroke at pressure 1, each sensor given a flat curve so its reading is that
// constant whatever the pen does. Separation also has "separationintervals".
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs hatchp
const root = path.resolve('test/krita/out/hatchp');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Hatch_diag_S.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const set = o => [val('PressureSize', 'false'),
    val('PressureThickness', o.th != null ? 'true' : 'false'), val('ThicknessUseCurve', o.raw ? 'false' : 'true'), curve('Thickness', '0,' + (o.th ?? 1) + ';1,' + (o.th ?? 1) + ';'),
    val('PressureSeparation', o.sp != null ? 'true' : 'false'), curve('Separation', '0,' + (o.sp ?? 1) + ';1,' + (o.sp ?? 1) + ';'),
    val('Hatching/separationintervals', o.iv ?? 3), val('Hatching/thickness', 6), val('Hatching/separation', o.sep ?? 6)];
const V = { none: {} };
for (const t of [0, 0.25, 0.5, 0.75, 1]) V['th' + t] = { th: t };
V.thraw = { th: 0.5, raw: true };   // ThicknessUseCurve off: the curve is ignored
for (const iv of [2, 3, 5]) for (const s of [0, 0.3, 0.5, 0.7, 1]) V['sp' + s + '-iv' + iv] = { sp: s, iv, sep: 12 };
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const renders = Object.entries(V).filter(([n]) => !only.length || only.some(o => n.startsWith(o))).map(([name, o]) => ({ name, file: path.basename(kpp), size: 200,
    lines: [[-40, 130, 1, 520, 130, 1]], rects: [], xmlSub: set(o) }));
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
    console.log(fs.readFileSync(path.join(root, 'harness.log'), 'utf8').split('\n').filter(l => /MISSING|rror|FAIL/.test(l)).join('\n') || 'ok');
}
