import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: which way Krita turns a thin rect tip when rotation follows
// the tilt-direction ("ascension") sensor and the pen reports no tilt.
const root = path.resolve('test/krita/out/ascension');
const lines = [[40, 40, 1, 300, 40, 1], [360, 30, 1, 360, 200, 1], [40, 200, 1, 200, 100, 1],
    [440, 100, 1, 441, 100, 1], [440, 200, 1, 441, 200, 1], [40, 260, 0, 440, 260, 1]];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const tip = a => ['angle="0"', 'angle="' + a + '"'];
const rect = ['ratio="1"(.*?)type="circle"(.*?)diameter="3" id="gauss"', 'ratio="0.15"\\g<1>type="rect"\\g<2>diameter="3" id="default"'];
const asc = [val('PressureRotation', 'true'), ['(name="RotationSensor"[^>]*>[^>]*>[^>]*<params id=")pressure', '\\g<1>ascension']];
const base = [val('PressureSize', 'false'), rect, ['spikes="9"', 'spikes="2"']];
const V = {
    off0: [...base, tip(0)],
    off90: [...base, tip(1.5708)],
    asc0: [...base, tip(0), ...asc],
    asc90: [...base, tip(1.5708), ...asc],
    pres0: [...base, tip(0), val('PressureRotation', 'true')],
    list0: [...base, tip(0), val('PressureRotation', 'true'), ['(name="RotationSensor"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]]+', '\\g<1><!DOCTYPE params> <params id="sensorslist"> <ChildSensor id="ascension"/> <ChildSensor id="pressure"> <curve>0,0;1,1;</curve> </ChildSensor> </params> ']],
};
const dry = process.argv.includes('--dry');
const arg = process.argv.slice(2).find(a => a !== '--dry');
const only = arg ? arg.split(',') : Object.keys(V);
for (const name of only) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    const job = { width: 480, height: 300, out: out.split(path.sep).join('/'),
        renders: [{ name, preset: 'd) Ink-1 Precision', size: 30, lines, xmlSub: V[name], dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    renderKrita(path.join(out, 'job.json'));
    console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /xmlSub/.test(l)).map(l => l.replace(/.*: /, '')).join(' '));
}
