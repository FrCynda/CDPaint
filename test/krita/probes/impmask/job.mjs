import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe of RGBA Impasto-details' multiply mask: Krita lays it in
// separate blobs a mask dab wide where we lay a ribbon. One level line at
// pressure 1; each render switches one thing off.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs impmask
const root = path.resolve('test/krita/out/impmask');
const kpp = path.resolve('test/krita/out/rgba-flat/paintoppresets/m)_RGBA_05_Impasto-details.kpp');
const val = (k, v) => ['(name="' + k + String.raw`"[^>]*>(?:<!\[CDATA\[)?)[^\]<]+`, String.raw`\g<1>` + v];
const V = {
    base: [],
    nomask: [val('MaskingBrush/Enabled', 'false')],
    noscat: [val('PressureScatter', 'false')],
    nosize: [val('PressureSize', 'false')],
    norat: [val('PressureRatio', 'false')],
    mnorot: [val('MaskingBrush/Preset/PressureRotation', 'false')],
    msp1: [['spacing="0\.37"', 'spacing="1"']],
    msp01: [['spacing="0\.37"', 'spacing="0.1"']],
};
const renders = Object.entries(V).map(([name, xmlSub]) => ({ name, file: path.basename(kpp), size: 30,
    lines: [[40, 130, 1, 440, 130, 1]], rects: [], xmlSub }));
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
    fs.cpSync(path.resolve('test/krita/out/rgba-flat/brushes'), path.join(res, 'brushes'), { recursive: true });
    renderKrita(path.join(root, 'job.json'), { resourceDir: res, timeoutMs: 600000 });
    for (const r of renders) fs.renameSync(path.join(root, r.name + '.png'), path.join(root, r.name, r.name + '.png'));
    console.log(fs.readFileSync(path.join(root, 'harness.log'), 'utf8').split('\n').filter(l => /MISSING|rror|FAIL|: 0$/.test(l)).join('\n') || 'ok');
}
