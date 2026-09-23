import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe, sixth pass on Krita's colour smudge: smudge5 showed a
// linear smudge curve at pressure 0.5 acting like a flat 0.25, i.e. pressure
// counted twice. Is the second one the opacity curve, although the preset
// switches opacity pressure off? Each render sets the opacity curve and switch.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs smudge6
const root = path.resolve('test/krita/out/smudge6');
const kpp = path.resolve('test/krita/out/bank-run/krita3/flat/paintoppresets/Basic_mix.kpp');
const curve = (k, c) => ['(name="' + k + 'Sensor".*?<curve>)[^<]*', '\\g<1>' + c];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const CR = '0,0;0.526104,0;1,1;', SR = '0,1;0.506024,1;1,0.484716;', FLAT = '0,1;1,1;', LIN = '0,0;1,1;';
const blue = [[0, 0, 120, 120, 0, 0, 255, 255]], red = [255, 0, 0, 255];
const set = (cc, cv, sc, sv) => [curve('ColorRate', cc), val('ColorRateValue', cv), curve('SmudgeRate', sc), val('SmudgeRateValue', sv)];
const op = (c, on) => [curve('Opacity', c), val('PressureOpacity', on)];
const V = [   // name, xmlSub, pressure, fill, rects
    ['lin-of', [...set(FLAT, 0, LIN, 1), ...op(FLAT, 'false')], 0.5, null, blue],       // opacity flat: a flat 0.5?
    ['flat-ol', [...set(FLAT, 0, FLAT, 0.5), ...op(LIN, 'false')], 0.5, null, blue],    // opacity linear, off: a flat 0.25?
    ['flat-ol-on', [...set(FLAT, 0, FLAT, 0.5), ...op(LIN, 'true')], 0.5, null, blue],  // and switched on
    ['flat-of-on', [...set(FLAT, 0, FLAT, 0.5), ...op(FLAT, 'true')], 0.5, null, blue],
    ['red-crlin-of', [...set(LIN, 1, FLAT, 0.65), ...op(FLAT, 'false')], 0.5, red, []],
    ['red-flat-ol', [...set(FLAT, 0.5, FLAT, 0.65), ...op(LIN, 'false')], 0.5, red, []],
];
const renders = V.map(([name, xmlSub, p, fill, rects]) => ({ name, file: path.basename(kpp), size: 30,
    lines: [[rects.length ? 60 : 40, 60, p, 440, 60, p]], rects, ...(fill ? { fill } : {}), xmlSub }));
fs.mkdirSync(root, { recursive: true });
const job = { width: 480, height: 120, out: root.split(path.sep).join('/'), renders };
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
