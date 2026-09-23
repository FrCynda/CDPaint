import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
import { withPage } from '../../../browser.mjs';
// CDPaint side of the build-up probe: each variant's edited Ink-1 XML through
// the real importer, painted with the same lines, measured the same way.
const root = path.resolve('test/krita/out/buildup');
const orig = fs.readFileSync(path.resolve('test/krita/out/spacing/off.xml'), 'utf8');
const names = fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'job.json')));
const xmls = {};
for (const n of names) {
    const subs = JSON.parse(fs.readFileSync(path.join(root, n, 'job.json'), 'utf8')).renders[0].xmlSub;
    // python's re, exactly as the harness applies them
    xmls[n] = execFileSync('python', ['-c', 'import re,sys,json\nx=sys.stdin.read()\nfor p,r in json.loads(sys.argv[1]): x=re.sub(p,r,x)\nsys.stdout.write(x)', JSON.stringify(subs)],
        { input: orig, encoding: 'utf8' });
}
const P = [1, 0.75, 0.5, 0.25];
const lines = [...P.map((p, i) => [40, 30 + i * 50, p, 360, 30 + i * 50, p]),
    ...P.map((p, i) => [430, 30 + i * 50, p, 431, 30 + i * 50, p])];
await withPage(async (page) => {
    const res = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush, out = {};
        app.layerMgr.collapseToBase({ fresh: true }); app.setSize(480, 220); app.config.zoom = 1; app.updateBounds();
        document.getElementById('lsys-add').click(); app.state.selection = null;
        const L = app.layerMgr.layers[app.layerMgr.activeIdx];
        for (const [name, xml] of Object.entries(${JSON.stringify(xmls)})) {
            const params = BrushPack.toPreset(BrushPack.parsePresetXml(xml)).params;
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const k in params) b.setParam(k, params[k]);
            b.setParam('size', 12);
            L.ctx.clearRect(0, 0, 480, 220);
            const clock = performance.now; performance.now = () => 0;
            for (const [x0, y0, p0, x1, y1, p1] of ${JSON.stringify(lines)}) {
                const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
                b.beginStroke(x0, y0, p0, '#000000');
                for (let i = 1; i <= n; i++) { const t = i / n; b.moveStroke(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, '#000000'); }
                b.endStroke();
            }
            performance.now = clock;
            await new Promise(r => setTimeout(r, 100));
            const d = L.ctx.getImageData(0, 0, 480, 220).data, a = (x, y) => d[(y * 480 + x) * 4 + 3];
            out[name] = ${JSON.stringify(P)}.map((p, i) => { const y = 30 + i * 50; let line = 0, dab = 0;
                for (let x = 150; x < 250; x++) line = Math.max(line, a(x, y));
                for (let x = 420; x < 445; x++) for (let yy = y - 8; yy < y + 9; yy++) dab = Math.max(dab, a(x, yy));
                return 'p' + p.toFixed(2) + ' line ' + String(line).padStart(3) + ' dab ' + String(dab).padStart(3); }).join(' | ');
            out[name] += '   [op ' + params.opacity + ' fl ' + params.flow + ' dOp ' + (params.dabOpacitySrc || '-') + ']';
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    for (const n of Object.keys(res).sort()) console.log(n.padEnd(12), res[n]);
});
