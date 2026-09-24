import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: EO Pixel Taper's soft tip (softness curve, fades 0.9, type
// "rct", no anti-alias) is far narrower in Krita than the same curve on Soft
// Cloud. Pen options off (size/ratio/rotation/flow/opacity), one stroke at
// pressure 1; the d* variants are a 1.5 px stroke (Krita paints nothing
// shorter), i.e. two overlapping dabs, with other softness curves.
// Krita keeps a curve across renders in one session: render the d* variants
// with  node test/krita/probes/solo.mjs softtip dlin dbase ...
// The preset is paintoppresets/EO Pixel Taper.kpp out of the bank's
// test/krita/out/bank/eo/Eo_Bundle_v3.bundle, saved as KPP (default below).
//   node job.mjs [filters]   then   node ../probe-cdp.mjs softtip
const root = path.resolve('test/krita/out/softtip');
const kpp = path.resolve(process.env.KPP || 'test/krita/out/EO_Pixel_Taper.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const attr = (k, v) => ['(<MaskGenerator[^>]*?\\b' + k + '=")[^"]*', '\\g<1>' + v];
const set = o => [val('PressureSize', 'false'), val('PressureRatio', 'false'), val('PressureRotation', 'false'),
    val('PressureFlow', 'false'), val('PressureOpacity', 'false'), val('OpacityUseCurve', 'false'), val('FlowValue', o.flow ?? 0.5),
    attr('type', o.type ?? 'rct'), attr('antialiasEdges', o.aa ?? 0), attr('hfade', o.fade ?? 0.9), attr('vfade', o.fade ?? 0.9),
    ...(o.curve ? [attr('softness_curve', o.curve)] : [])];
const V = { base: {}, circle: { type: 'circle' }, aa: { aa: 1 }, fade1: { fade: 1 }, fade05: { fade: 0.5 },
    lin: { curve: '0,1;1,0;' }, linfade1: { curve: '0,1;1,0;', fade: 1 }, flow1: { flow: 1 },
    dlin: { curve: '0,1;1,0;', flow: 1, dab: 1 }, dbase: { flow: 1, dab: 1 }, dcirc: { type: 'circle', flow: 1, dab: 1 }, dlincirc: { type: 'circle', curve: '0,1;1,0;', flow: 1, dab: 1 },
    dlinf1: { curve: '0,1;1,0;', flow: 1, dab: 1, fade: 1 }, dlinf5: { curve: '0,1;1,0;', flow: 1, dab: 1, fade: 0.5 }, dstep: { curve: '0,1;0.5,1;0.500001,0;1,0;', flow: 1, dab: 1, fade: 1 },
    dconst: { curve: '0,1;1,1;', flow: 1, dab: 1 }, dinv: { curve: '0,0;1,1;', flow: 1, dab: 1 }, dmid: { curve: '0,1;0.5,0.2;1,0;', flow: 1, dab: 1 } };
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const renders = Object.entries(V).filter(([n]) => !only.length || only.some(o => n.startsWith(o))).map(([name, o]) => ({ name, file: path.basename(kpp), size: 40,
    lines: o.dab ? [[240, 120, 1, 241.5, 120, 1]] : [[40, 60, 1, 440, 60, 1], [240, 180, 1, 240, 180, 1]], rects: [], xmlSub: set(o) }));
fs.mkdirSync(root, { recursive: true });
const job = { width: 480, height: 240, out: root.split(path.sep).join('/'), renders };
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
