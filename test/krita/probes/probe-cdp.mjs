import fs from 'fs'; import path from 'path'; import { execFileSync } from 'child_process';
import { withPage } from '../../browser.mjs';
// CDPaint side of a Krita probe folder: each variant's edited preset XML through
// the real importer, painted with the same lines, saved as <name>/cdp.png.
// The preset is Ink-1 Precision (dumped by dump-ink1.mjs) unless the render
// names a real .kpp as `src`.
//   node test/krita/probes/<name>/job.mjs          Krita's side, into test/krita/out/<name>
//   node test/krita/probes/probe-cdp.mjs <name>    ours, beside it as cdp.png
const root = path.resolve('test/krita/out', process.argv[2]);
const ink1 = fs.readFileSync(path.resolve('test/krita/out/spacing/off.xml'), 'utf8');
const KPP_XML = [
    'import sys,zlib', 'd=open(sys.argv[1],"rb").read(); i=8',
    'while i<len(d):',
    '  n=int.from_bytes(d[i:i+4],"big"); t=d[i+4:i+8]; c=d[i+8:i+8+n]; i+=12+n',
    '  if t in (b"zTXt",b"tEXt"):',
    '    k,_,v=c.partition(bytes(1))',
    '    if k==b"preset": sys.stdout.buffer.write(zlib.decompress(v[1:]) if t==b"zTXt" else v)'].join('\n');
const SUBS = 'import re,sys,json\nx=sys.stdin.read()\nfor p,r in json.loads(sys.argv[1]): x=re.sub(p,r,x)\nsys.stdout.write(x)';
const names = fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'job.json')));
const xmls = {}, jobs = {};
for (const n of names) {
    const j = JSON.parse(fs.readFileSync(path.join(root, n, 'job.json'), 'utf8')), r = j.renders[0];
    jobs[n] = { lines: r.lines, W: j.width, H: j.height, size: r.size };
    const src = r.src ? execFileSync('python', ['-c', KPP_XML, r.src], { encoding: 'utf8' }) : ink1;
    xmls[n] = execFileSync('python', ['-c', SUBS, JSON.stringify(r.xmlSub || [])], { input: src, encoding: 'utf8' });
}
await withPage(async (page) => {
    const res = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush, out = {};
        const jobs = ${JSON.stringify(jobs)};
        for (const [name, xml] of Object.entries(${JSON.stringify(xmls)})) {
            const { lines, W, H, size } = jobs[name];
            app.layerMgr.collapseToBase({ fresh: true }); app.setSize(W, H); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click(); app.state.selection = null;
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            const pr = BrushPack.toPreset(BrushPack.parsePresetXml(xml)), params = pr.params;
            if (params.texturePatternData) params.texturePattern = params.texturePatternData;   // as the pack loader does
            delete params.texturePatternData; delete params.texturePatternFile;
            b.forgetSaved('Round'); b.loadPreset('Round');
            for (const k in params) b.setParam(k, params[k]);
            b.setParam('size', size);
            // a preset load fetches its pattern; setParam alone does not
            if (params.texturePattern) b.loadTexturePattern(params.texturePattern, b._currentPreset);
            await new Promise(r => setTimeout(r, 300));   // let a texture decode
            L.ctx.clearRect(0, 0, W, H);
            const clock = performance.now; performance.now = () => 0;
            for (const [x0, y0, p0, x1, y1, p1] of lines) {
                const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
                b.beginStroke(x0, y0, p0, '#000000');
                for (let i = 1; i <= n; i++) { const t = i / n; b.moveStroke(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, '#000000'); }
                b.endStroke();
            }
            performance.now = clock;
            await new Promise(r => setTimeout(r, 400));
            const c = new OffscreenCanvas(W, H); c.getContext('2d').drawImage(L.canvas, 0, 0);
            const blob = await c.convertToBlob(), buf = new Uint8Array(await blob.arrayBuffer());
            let s = ''; for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
            out[name] = { png: btoa(s), rot: [params.angle, params.angleSrc, params.angleStrength], warn: pr.warnings || [] };
        }
        return JSON.stringify(out);
    })()`, { awaitPromise: true }));
    for (const n of Object.keys(res)) {
        fs.writeFileSync(path.join(root, n, 'cdp.png'), Buffer.from(res[n].png, 'base64'));
        console.log(n.padEnd(8), JSON.stringify(res[n].rot), res[n].warn.join('; '));
    }
});
