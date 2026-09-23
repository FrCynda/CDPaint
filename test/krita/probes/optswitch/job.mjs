import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: which key switches a Krita curve option on -- its
// Pressure<X> flag or its <X>UseCurve box? Ink-1, constant-pressure lines.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs optswitch   then   python measure.py
const root = path.resolve('test/krita/out/optswitch');
const P = [1, 0.5, 0.25];
const lines = P.map((p, i) => [40, 40 + i * 60, p, 400, 40 + i * 60, p]);
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const prm = (k, v) => '<param type="string" name="' + k + '"><![CDATA[' + v + ']]></param>';
const lin = k => ['(name="' + k + 'Sensor".*?<params id="pressure")[^>]*>.*?</params>', '\\g<1>> <curve>0,0;1,1;</curve> </params>'];
// Ink-1 has no Pressure<X> key for opacity or flow: add one; size has one.
const flag = (k, v) => k === 'Size' ? val('PressureSize', v) : ['</Preset>', prm('Pressure' + k, v) + '</Preset>'];
const V = {};
for (const k of ['Opacity', 'Flow', 'Size']) {
    V[k.toLowerCase() + '_flagOff_curveOn'] = [flag(k, 'false'), val(k + 'UseCurve', 'true'), lin(k)];
    V[k.toLowerCase() + '_flagOn_curveOff'] = [flag(k, 'true'), val(k + 'UseCurve', 'false'), lin(k)];
}
V.base = [val('PressureSize', 'false')];
const dry = process.argv.includes('--dry');
for (const name of Object.keys(V)) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    // size stays off unless it is the option under test
    const subs = name.startsWith('size') ? V[name] : [val('PressureSize', 'false'), ...V[name]];
    const job = { width: 440, height: 200, out: out.split(path.sep).join('/'),
        renders: [{ name, preset: 'd) Ink-1 Precision', size: 20, lines, xmlSub: subs, dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    renderKrita(path.join(out, 'job.json'));
    console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /xmlSub|rror/.test(l)).map(l => l.replace(/.*: /, '')).join(' '));
}
