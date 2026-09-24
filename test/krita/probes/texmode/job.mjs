import fs from 'fs'; import path from 'path';
import { renderKrita } from '../../render.mjs';
// Black-box probe: Krita's texturing mode 12 (deevad's c5 and Textured Crease;
// we paint it as multiply). One hard round tip, every pen option constant, the
// masking brush off: multiply (0) and subtract (1) beside mode 12 at a few
// strengths and flows, so the pattern's grey -> ink map reads off the pixels.
// The preset (saved as test/krita/out/deevad_c5.kpp) and patterns/14_texture-rock.png
// (saved into test/krita/out/texmode) come out of the bank's deevad23 bundle.
//   node job.mjs [--dry]   then   node ../probe-cdp.mjs texmode
const root = path.resolve('test/krita/out/texmode');
const kpp = path.resolve('test/krita/out/deevad_c5.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const tipDef = d => ['(name="brush_definition"[^>]*><!\\[CDATA\\[)[\\s\\S]*?(\\]\\]>)', '\\g<1>' + d + '\\g<2>'];
const hard = '<Brush type="auto_brush" useAutoSpacing="0" randomness="0" density="1" autoSpacingCoeff="1" BrushVersion="2" spacing="0.1" angle="0">' +
    '<MaskGenerator ratio="1" type="circle" vfade="1" id="default" spikes="2" antialiasEdges="1" hfade="1" diameter="80"/></Brush>';
const soft = hard.replace('vfade="1" id="default"', 'vfade="0.4" id="gauss"').replace('hfade="1"', 'hfade="0.4"');
const OFF = ['Size', 'Rotation', 'Ratio', 'Spacing', 'Opacity', 'Flow', 'Mirror', 'Scatter', 'Darken', 'Mix', 'Sharpness', 'Softness', 'h', 's', 'v', 'LightnessStrength', 'Texture/Strength/']
    .map(o => val(o + 'UseCurve', 'false'));
const flat = a => '<Brush type="png_brush" filename="flat' + a + '.png" name="flat' + a + '" scale="1" spacing="0.1" useAutoSpacing="0" autoSpacingCoeff="1" angle="0" BrushVersion="2" ColorAsMask="1"/>';
const set = o => [tipDef(o.flat ? flat(o.flat) : o.soft ? soft : hard), ...OFF, val('MaskingBrush/Enabled', 'false'), val('Texture/Pattern/TexturingMode', o.mode),
    val('Texture/Strength/Value', o.s ?? 1), val('FlowValue', o.flow ?? 1), val('OpacityValue', o.opac ?? 1), val('Texture/Pattern/Invert', o.inv ?? 'true'),
    val('Texture/Pattern/NeutralPoint', o.np ?? 0.5)];
const V = { m0: { mode: 0 }, m1: { mode: 1 }, m12: { mode: 12 }, m12s05: { mode: 12, s: 0.5 }, m12s02: { mode: 12, s: 0.2 },
    m12f05: { mode: 12, flow: 0.5 }, m12o05: { mode: 12, opac: 0.5 }, m0f05: { mode: 0, flow: 0.5 }, m12inv0: { mode: 12, inv: 'false' },
    // lone dabs (a 1.5 px stroke; Krita paints nothing shorter): the map with no overlap
    d0: { mode: 0, dab: 1 }, d1: { mode: 1, dab: 1 }, d12: { mode: 12, dab: 1 }, d12s05: { mode: 12, s: 0.5, dab: 1 }, d12s02: { mode: 12, s: 0.2, dab: 1 },
    d12f05: { mode: 12, flow: 0.5, dab: 1 }, d0f05: { mode: 0, flow: 0.5, dab: 1 }, d12o05: { mode: 12, opac: 0.5, dab: 1 },
    ...Object.fromEntries([0.05, 0.1, 0.3, 0.4, 0.6, 0.7, 0.85].map(v => ['d12s' + v, { mode: 12, s: v, dab: 1 }])),
    d12np3: { mode: 12, s: 0.2, np: 0.3, dab: 1 }, d12np7: { mode: 12, s: 0.2, np: 0.7, dab: 1 },
    d12soft: { mode: 12, s: 0.3, soft: 1, dab: 1 }, d0soft: { mode: 0, soft: 1, dab: 1 }, d12s3f05: { mode: 12, s: 0.3, flow: 0.5, dab: 1 },
    // flat picture tips of one alpha each (flat25/50/75.png, written beside the output): how the dab's alpha enters
    ...Object.fromEntries([25, 50, 75].flatMap(a => [['f' + a + 'm0', { mode: 0, flat: a, dab: 1 }],
        ...[0.1, 0.2, 0.3, 0.5, 0.8].map(v => ['f' + a + 's' + v, { mode: 12, s: v, flat: a, dab: 1 }])])) };
const only = process.argv.slice(2).filter(a => !a.startsWith('--'));
const renders = Object.entries(V).filter(([n]) => !only.length || only.some(o => n.startsWith(o))).map(([name, o]) => ({ name, file: path.basename(kpp), size: 80,
    lines: o.dab ? [[240, 80, 1, 241.5, 80, 1]] : [[20, 80, 1, 460, 80, 1]], rects: [], xmlSub: set(o), ...(o.flat ? { tip: path.join(root, 'flat' + o.flat + '.png').split(path.sep).join('/') } : {}), pattern: path.join(root, '14_texture-rock.png').split(path.sep).join('/') }));
fs.mkdirSync(root, { recursive: true });
const job = { width: 480, height: 160, out: root.split(path.sep).join('/'), renders };
fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(job, null, 1));
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ ...job, out: d.split(path.sep).join('/'), renders: [{ ...r, src: kpp }] }, null, 1));
}
if (!process.argv.includes('--dry')) {
    const res = path.join(root, 'kres');
    fs.rmSync(res, { recursive: true, force: true });
    for (const d of ['paintoppresets', 'patterns', 'brushes']) fs.mkdirSync(path.join(res, d), { recursive: true });
    for (const a of [25, 50, 75]) fs.copyFileSync(path.join(root, 'flat' + a + '.png'), path.join(res, 'brushes', 'flat' + a + '.png'));
    fs.copyFileSync(kpp, path.join(res, 'paintoppresets', path.basename(kpp)));
    fs.copyFileSync(path.join(root, '14_texture-rock.png'), path.join(res, 'patterns', '14_texture-rock.png'));
    renderKrita(path.join(root, 'job.json'), { resourceDir: res, timeoutMs: 600000 });
    for (const r of renders) fs.renameSync(path.join(root, r.name + '.png'), path.join(root, r.name, r.name + '.png'));
    console.log(fs.readFileSync(path.join(root, 'harness.log'), 'utf8').split('\n').filter(l => /MISSING|rror|FAIL|xmlSub.*: 0/.test(l)).join('\n') || 'ok');
}
