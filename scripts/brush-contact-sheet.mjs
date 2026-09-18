/* Put our render of a brush next to the picture its author shipped with it.
 *
 *   node scripts/brush-contact-sheet.mjs <pack.bundle|dir of .kpp> [out.html]
 *
 * Why a page for the eye rather than a number: the picture inside a .kpp is
 * NOT Krita's render of the brush, it is an icon the author PAINTED -- a
 * brush on a shelf, a kneaded eraser -- with a stroke sample under it. There
 * is nothing in the file to diff against pixel for pixel. What the icon does
 * show truthfully is the brush's CHARACTER: how hard its edge is, whether it
 * is grainy, whether it tapers, what shape the tip is. That is what a person
 * can judge at a glance and a similarity score cannot.
 *
 * Our half of each pair is `engine.generatePreview`, the same swatch the
 * brush panel shows -- so this compares what the user will actually see in
 * the app against what the author advertised, not two laboratory renders.
 *
 * The measurable half of fidelity -- does a brush come out the size and
 * spacing its preset declares -- is test/browser/brush-fidelity.mjs.
 */
import { withPage, REPO_ROOT } from '../test/browser.mjs';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const src = process.argv[2];
const out = process.argv[3] || join(REPO_ROOT, 'brush-contact-sheet.html');
if (!src) {
    console.error('usage: node scripts/brush-contact-sheet.mjs <pack.bundle|dir> [out.html]');
    process.exit(2);
}

const isDir = statSync(src).isDirectory();
const files = isDir
    ? readdirSync(src).filter(f => /\.kpp$/i.test(f)).map(f => ({ name: f, b64: readFileSync(join(src, f)).toString('base64') }))
    : [{ name: src, b64: readFileSync(src).toString('base64') }];

await withPage(async (page) => {
    await page.run(`
        window.__CS = {
            bytes: (s) => {
                const bin = atob(s);
                const u = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
                return u;
            },
            url: (u8, type) => new Promise(r => {
                const fr = new FileReader();
                fr.onload = () => r(fr.result);
                fr.readAsDataURL(new Blob([u8], { type: type || 'image/png' }));
            })
        };
        return true;
    `);

    const rows = [];
    for (const f of files) {
        const chunk = JSON.parse(await page.eval(`(async () => {
            const raw = __CS.bytes(${JSON.stringify(f.b64)});

            /* Read the pack once for the authors' icons, then let the REAL
             * import path do the translating. Decoding tips here by hand was
             * the first version of this script and it got twelve brushes
             * wrong -- a Krita pack carries GIMP .gbr and .gih tips, which
             * createImageBitmap cannot decode and BrushPack.tipStrip can.
             * Driving engine.importBrushPack instead means the sheet shows
             * what the user actually gets, and cannot drift from it. */
            const pack = await BrushPack.read(raw);
            const icons = {};
            const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
            for (const pr of pack.presets) {
                const bytes = pr.thumbnail || (pack.kind === 'kpp' ? raw : null);
                if (bytes) icons[norm(pr.name)] = await __CS.url(bytes);
            }
            const iconFor = (added) => {
                const a = norm(added);
                if (icons[a]) return icons[a];
                const hit = Object.keys(icons).find(k => k.includes(a));
                return hit ? icons[hit] : null;
            };

            const before = new Set(Object.keys(PaintApp.brush.PRESETS));
            const res = await PaintApp.brush.importBrushPack(raw, ${JSON.stringify(f.name)});
            if (!res.ok) return JSON.stringify([{ name: ${JSON.stringify(f.name)}, error: res.error }]);

            const warnFor = {};
            for (const n of (res.notes || [])) warnFor[n.name] = n.warnings || [];

            const out = [];
            for (const name of res.added) {
                try {
                    PaintApp.brush.loadPreset(name);
                    // An imported tip is a data URL, but the engine still has
                    // to decode and bake it before a swatch can stamp it.
                    await new Promise(r => setTimeout(r, 250));
                    const c = PaintApp.brush.generatePreview(name);
                    const ps = PaintApp.brush.PRESETS[name] || {};
                    out.push({
                        name, paintop: 'imported',
                        theirs: iconFor(name),
                        ours: c ? c.toDataURL('image/png') : null,
                        size: Math.round(ps.size || 0),
                        spacing: ps.spacing,
                        warnings: warnFor[name] || []
                    });
                } catch (e) {
                    out.push({ name, error: String((e && e.message) || e) });
                }
            }
            for (const s of (res.skipped || [])) {
                if (s.why) out.push({ name: s.name, error: 'not imported: ' + s.why });
            }
            void before;
            return JSON.stringify(out);
        })()`, { awaitPromise: true }));
        rows.push(...chunk);
        console.log(`  ${f.name}: ${chunk.length} presets`);
    }

    const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const cards = rows.map(r => r.error
        ? `<div class="card bad"><h3>${esc(r.name)}</h3><p class="meta">${esc(r.error)}</p></div>`
        : `<div class="card">
             <h3>${esc(r.name)}</h3>
             <div class="pair">
               <figure>${r.theirs ? `<img src="${r.theirs}" alt="">` : '<div class="none">no icon</div>'}<figcaption>theirs</figcaption></figure>
               <figure>${r.ours ? `<img class="ours" src="${r.ours}" alt="">` : '<div class="none">nothing drawn</div>'}<figcaption>ours</figcaption></figure>
             </div>
             <p class="meta">${esc(r.paintop)} · size ${r.size} · spacing ${esc(r.spacing)}</p>
             ${r.warnings.length ? `<ul class="warn">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
           </div>`).join('\n');

    const bad = rows.filter(r => r.error || !r.ours).length;
    const warned = rows.filter(r => r.warnings && r.warnings.length).length;
    writeFileSync(out, `<!doctype html><meta charset="utf-8">
<title>Brush contact sheet</title>
<style>
 body{font:14px system-ui,sans-serif;margin:0;padding:24px;background:#1b1b1b;color:#e8e8e8}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#9a9a9a;margin:0 0 20px;max-width:70ch;line-height:1.5}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:16px}
 .card{background:#242424;border:1px solid #333;border-radius:8px;padding:12px}
 .card.bad{border-color:#7a3030}
 h3{font-size:12px;margin:0 0 8px;font-weight:600;color:#cfcfcf}
 .pair{display:flex;gap:10px;align-items:flex-start}
 figure{margin:0;flex:1;min-width:0}
 img{width:100%;display:block;border-radius:4px;background:#d4d4d4}
 img.ours{aspect-ratio:134/54;object-fit:cover}
 .none{aspect-ratio:1;display:grid;place-items:center;background:#2e2e2e;border-radius:4px;color:#777;font-size:11px}
 figcaption{font-size:11px;color:#8a8a8a;text-align:center;padding-top:4px}
 .meta{font-size:11px;color:#8a8a8a;margin:8px 0 0}
 .warn{margin:8px 0 0;padding-left:16px;font-size:11px;color:#d8a657;line-height:1.4}
</style>
<h1>Brush contact sheet</h1>
<p class="sub">${rows.length} presets from ${esc(resolve(src))} — ${warned} carry warnings, ${bad} produced nothing.
The left tile is the icon the author shipped inside the preset: hand-painted, not a render, so compare
<em>character</em> — edge softness, grain, taper, tip shape — not composition. The right tile is our engine
painting that same preset, and is the swatch the brush panel shows.</p>
<div class="grid">
${cards}
</div>`);
    console.log(`\nwrote ${out} — ${rows.length} presets, ${warned} warned, ${bad} blank`);
});
