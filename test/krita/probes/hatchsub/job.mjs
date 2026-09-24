import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: Big Hatches' hatching (45 degrees, crossed, 4 px apart,
// subpixel precision off) -- what does subpixel precision change? Hatch_diag_S (angle -60, separation 6, thickness 6), one wide
// stroke at pressure 1, each sensor given a flat curve so its reading is that
// constant whatever the pen does. Separation also has "separationintervals".
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs hatchsub
const root = path.resolve('test/krita/out/hatchsub');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Hatch_diag_S.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const set = o => [val('PressureSize', 'false'), val('Hatching/angle', o.angle ?? 45),
    val('Hatching/bool_nocrosshatching', o.cross ? 'false' : 'true'), val('Hatching/bool_perpendicular', o.cross ? 'true' : 'false'),
    val('Hatching/bool_subpixelprecision', o.sub ? 'true' : 'false'),
    val('PressureThickness', o.th ? 'true' : 'false'), val('ThicknessUseCurve', 'true'), curve('Thickness', '0,0;0.851406,0.676856;1,1;'),
    val('PressureSeparation', o.sp ? 'true' : 'false'), val('SeparationUseCurve', 'true'), curve('Separation', '0,0;1,0.489083;'),
    val('Hatching/separationintervals', 2), val('Hatching/thickness', o.t ?? 4), val('Hatching/separation', o.sep ?? 4),
    val('Hatching/origin_x', 0), val('Hatching/origin_y', 0)];
// Big Hatches' hatching (its own tip is a pack .gbr, so Hatch_diag_S's round tip stands in)
const V = {};
for (const sub of [0, 1]) for (const cross of [0, 1]) V['s' + sub + 'c' + cross] = { sub, cross };
for (const sub of [0, 1]) { V['s' + sub + '-a30'] = { sub, angle: 30 }; V['s' + sub + '-a-60t6s6'] = { sub, angle: -60, t: 6, sep: 6 }; V['s' + sub + '-sep5'] = { sub, sep: 5 }; }
V.big = { cross: 1, th: 1, sp: 1 };
V['big-p0.5'] = { cross: 1, th: 1, sp: 1, p: 0.5 };
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const renders = Object.entries(V).filter(([n]) => !only.length || only.some(o => n.startsWith(o))).map(([name, o]) => ({ name, file: path.basename(kpp), size: 200,
    lines: [[-40, 130, o.p ?? 1, 520, 130, o.p ?? 1]], rects: [], xmlSub: set(o) }));
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
