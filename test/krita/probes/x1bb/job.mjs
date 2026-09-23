import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Bisect X1BB Addition Soft (portnov-modular): switch its features off one at
// a time and see which one opens the gap. Fresh Krita, private resources.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs x1bb   then   python ../airbrush/measure.py-like compare
const root = path.resolve('test/krita/out/x1bb');
const kpp = path.resolve('test/krita/out/bank-run/portnov-modular/flat/paintoppresets/X1BB_AdditionSoft.kpp');
const lines = [[40, 50, 0.1, 440, 50, 1.0], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5],
    [440, 250, 1.0, 40, 250, 0.5]];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const V2 = {
    op10: [val('OpacityValue', 0.1)],
    flat10: [['(name="OpacitySensor".*?<curve>)[^<]*', '\\g<1>0,0.1;1,0.1;']],
};
const V3 = {   // one lone dab, everything else neutral
    dab: [val('OpacityValue', 1), val('OpacityUseCurve', 'false'), val('PressureSize', 'false'),
        val('Texture/Pattern/Enabled', 'false'), val('CompositeOp', 'normal'), val('PaintOpAction', 2)],
};
const V5 = { dab24: V3.dab, dab15: V3.dab, dab6: V3.dab };
const V4 = { spoff: [val('SpacingUseCurve', 'false')], spon: [val('PressureSpacing', 'true')] };
const dabLines = [[120, 100, 1, 121, 100, 1]];
const V = process.argv.includes('--v5') ? V5 : process.argv.includes('--v4') ? V4 : process.argv.includes('--v3') ? V3 : process.argv.includes('--v2') ? V2 : {
    asis: [],
    notex: [val('Texture/Pattern/Enabled', 'false')],
    noair: [val('AirbrushOption/isAirbrushing', 'false')],
    normal: [val('CompositeOp', 'normal')],
    nopress: [val('PressureOpacity', 'false')],
    wash: [val('PaintOpAction', 2)],
    bare: [val('Texture/Pattern/Enabled', 'false'), val('AirbrushOption/isAirbrushing', 'false'), val('CompositeOp', 'normal')],
};
const dry = process.argv.includes('--dry');
for (const name of Object.keys(V)) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    const job = { width: 480, height: 300, out: out.split(path.sep).join('/'),
        renders: [{ name, file: path.basename(kpp), src: kpp, size: V3[name] ? 50 : V5[name] ? +name.slice(3) : 30, lines: V3[name] || V5[name] ? dabLines : lines, xmlSub: V[name], dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    const res = path.join(out, 'kres');
    fs.rmSync(res, { recursive: true, force: true });
    fs.mkdirSync(path.join(res, 'paintoppresets'), { recursive: true });
    fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
    renderKrita(path.join(out, 'job.json'), { resourceDir: res });
    console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /xmlSub|MISSING|rror/.test(l)).map(l => l.replace(/.*: /, '')).join(' '));
}
