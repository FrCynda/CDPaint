import fs from 'fs'; import path from 'path';
// Black-box probe: Bristle_frottis0011 (picture tip, rotation on "ascension",
// scatter on pressure) paints its diagonal about twice as thick in Krita as
// ours while its horizontal and vertical match. Fixed pressure, strokes at
// 0, -27 (the bank's diagonal), -45 and 90 degrees, plus lone dabs; with the
// preset as it is, with scatter off, and with rotation off.
//   node job.mjs   then   node ../solo.mjs frottis <variants>   then   node ../probe-cdp.mjs frottis
const root = path.resolve('test/krita/out/frottis');
const kpp = path.resolve('test/krita/out/bank-run/portnov-pastel/flat/paintoppresets/Bristle_frottis0011.kpp');
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const lines = pr => [[40, 50, pr, 300, 50, pr], [40, 250, pr, 180, 180, pr], [200, 250, pr, 280, 170, pr],
    [360, 40, pr, 360, 240, pr], [440, 60, pr, 441.5, 60, pr], [440, 200, pr, 441.5, 200, pr]];
const V = { as: [], noscat: [val('PressureScatter', 'false')], norot: [val('PressureRotation', 'false')],
    plain: [val('PressureScatter', 'false'), val('PressureRotation', 'false')] };
const renders = [];
for (const [name, subs] of Object.entries(V)) for (const pr of [1, 0.5])
    renders.push({ name: name + (pr === 1 ? '' : '5'), file: path.basename(kpp), size: 40, lines: lines(pr), rects: [], xmlSub: subs });
// the bank's own strokes and size, then the diagonal alone at other pressures
const BANK = [[40, 50, 0.1, 440, 50, 1.0], [60, 185, 0.8, 200, 115, 0.8], [300, 115, 0.5, 300, 185, 0.5], [440, 250, 1.0, 40, 250, 0.5]];
renders.push({ name: 'bank', file: path.basename(kpp), size: 30, lines: BANK, rects: [], xmlSub: [] });
for (const pr of [0.6, 0.8, 0.9]) renders.push({ name: 'diag' + pr * 10, file: path.basename(kpp), size: 30,
    lines: [[60, 185, pr, 200, 115, pr], [260, 150, pr, 420, 150, pr], [440, 60, pr, 441.5, 60, pr]], rects: [], xmlSub: [] });
// lone dabs: pressures across, at two sizes, the preset as it is and with rotation off
const dabs = [0.5, 0.6, 0.7, 0.8, 0.9, 1].map((pr, i) => [40 + i * 80, 80, pr, 41.5 + i * 80, 80, pr]);
for (const s of [30, 40]) {
    renders.push({ name: 'dab' + s, file: path.basename(kpp), size: s, lines: dabs, rects: [], xmlSub: [] });
    renders.push({ name: 'dabnr' + s, file: path.basename(kpp), size: s, lines: dabs, rects: [], xmlSub: V.norot });
}
// is it pressure? the same six dabs all at 0.8, and the ramp with the airbrush off
renders.push({ name: 'same8', file: path.basename(kpp), size: 40, lines: dabs.map(l => [l[0], l[1], 0.8, l[3], l[4], 0.8]), rects: [], xmlSub: [] });
renders.push({ name: 'noair', file: path.basename(kpp), size: 40, lines: dabs, rects: [], xmlSub: [val('AirbrushOption/isAirbrushing', 'false')] });
renders.push({ name: 'rev', file: path.basename(kpp), size: 40, lines: dabs.slice().reverse(), rects: [], xmlSub: [] });
// the same sensor written with a curve, as the Ink-1 ascension probe had it
renders.push({ name: 'ascc', file: path.basename(kpp), size: 40, lines: dabs, rects: [],
    xmlSub: [['<params id="ascension"/>', '<params id="ascension"> <curve>0,0;1,1;</curve> </params>']] });
// is it rotation only? size following a curve-less ascension, then the same with a curve
const sizeAsc = c => [...V.norot, ['(name="SizeSensor"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]]+', '\\g<1><!DOCTYPE params> <params id="ascension"' + (c ? '> <curve>0,0;1,1;</curve> </params>' : '/>')]];
renders.push({ name: 'sizea', file: path.basename(kpp), size: 40, lines: dabs, rects: [], xmlSub: sizeAsc(false) });
renders.push({ name: 'sizeac', file: path.basename(kpp), size: 40, lines: dabs, rects: [], xmlSub: sizeAsc(true) });
// a colour smudge preset with the same curve-less rotation (Gouache Tilt #1), as it is and with a curve
const gou = path.resolve('test/krita/out/bank-run/portnov-mybrushes/flat/paintoppresets/Gouache Tilt #1.kpp');
const gtip = path.resolve('test/krita/out/bank-run/portnov-mybrushes/flat/brushes/brush31.gbr');
renders.push({ name: 'gou', file: path.basename(gou), src: gou, tip: gtip, size: 40, lines: dabs, rects: [], xmlSub: [] });
renders.push({ name: 'gouc', file: path.basename(gou), src: gou, tip: gtip, size: 40, lines: dabs, rects: [],
    xmlSub: [['<params id="ascension"/>', '<params id="ascension"> <curve>0,0;1,1;</curve> </params>']] });
// RGBA_06_Rock stores the same curve-less rotation and does not turn; it also stores a commonCurve
const addP = (k, v) => ['(<param [^>]*name="PressureRotation")', '<param name="' + k + '" type="string"><![CDATA[' + v + ']]></param>\n \\g<1>'];
renders.push({ name: 'cc', file: path.basename(kpp), size: 40, lines: dabs, rects: [], xmlSub: [addP('RotationcommonCurve', '0,0;1,1;')] });
renders.push({ name: 'cm', file: path.basename(kpp), size: 40, lines: dabs, rects: [], xmlSub: [addP('RotationcurveMode', '0')] });
// RGBA_06_Rock itself (bundle unpacked into test/krita/out/rgba-flat)
const rock = path.resolve('test/krita/out/rgba-flat/paintoppresets/m)_RGBA_06_Rock.kpp');
renders.push({ name: 'rock', file: path.basename(rock), src: rock, tip: path.resolve('test/krita/out/rgba-flat/brushes/Mountain_Brush_01.png'),
    size: 40, lines: dabs, rects: [], xmlSub: [] });
// ...with the old per-option keys Bristle_frottis0011 carries and it does not
for (const [n, subs] of [['rockcu', [addP('CustomRotation', 'true')]], ['rockcv', [addP('CurveRotation', '0,0;1,1;')]],
    ['rockboth', [addP('CustomRotation', 'true'), addP('CurveRotation', '0,0;1,1;')]]])
    renders.push({ ...renders.find(r => r.name === 'rock'), name: n, xmlSub: subs });
for (const r of renders) {
    const d = path.join(root, r.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ width: 480, height: 300, out: d.split(path.sep).join('/'), renders: [{ src: kpp,
        tip: path.resolve('test/krita/out/bank-run/portnov-pastel/flat/brushes/A_Angular_church.gbr'), ...r }] }, null, 1));
}
