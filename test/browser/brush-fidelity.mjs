/* Does a brush come out the size its author asked for?
 *
 * The obvious reference -- Krita's own render of the brush -- turns out not
 * to exist. A .kpp is a PNG, but for David Revoy's pack that PNG is an icon
 * he PAINTED (a brush on a shelf, a kneaded eraser), with a stroke sample
 * tucked underneath it. There is no machine-generated preview in the file to
 * diff against, so a pixel comparison would be scoring our stroke against
 * somebody's illustration.
 *
 * What a preset does carry is a precise statement of what it should draw:
 * a diameter, a ratio, a spacing, a tip image and a scale. This suite checks
 * our render against those declarations. That is the class of bug that has
 * actually bitten here -- `aspectRatio` once stretched where Krita squashes,
 * so fourteen presets painted several times their own size while every
 * pixel test stayed green.
 *
 * For eye comparison against Revoy's icons, see scripts/brush-contact-sheet.
 */
import { withPage, REPO_ROOT } from '../browser.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
/* Rasterisers disagree at the edges and a soft brush has no crisp one, so
 * every size assertion is a tolerance, not an equality. */
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

const FIX = join(REPO_ROOT, 'test', 'fixtures', 'brushes');
const b64 = (f) => readFileSync(join(FIX, f)).toString('base64');

await withPage(async (page) => {
    await page.run(`
        window.__fx = {};
        const put = (k, s) => {
            const bin = atob(s);
            const u = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            window.__fx[k] = u;
        };
        put('auto', ${JSON.stringify(b64('eraser-kneaded-soft.kpp'))});
        put('stamp', ${JSON.stringify(b64('thin-brush-pointy.kpp'))});

        window.__F = {
            /* Translate a fixture exactly as the importer would, keeping the
             * size it asks for -- the size is the thing under test, so it
             * must not be overridden the way the other suites do. */
            translate: async (key) => {
                const p = await BrushPack.read(window.__fx[key]);
                const pr = p.presets[0];
                const bd = BrushPack.brushDefinition(pr);
                let tipSize = 0, tipUrl = null;
                if (bd && bd.filename && pr.resources[bd.filename]) {
                    const blob = new Blob([pr.resources[bd.filename].bytes], { type: 'image/png' });
                    const bmp = await createImageBitmap(blob);
                    tipSize = Math.max(bmp.width, bmp.height);
                    tipUrl = await new Promise(r => {
                        const fr = new FileReader();
                        fr.onload = () => r(fr.result);
                        fr.readAsDataURL(blob);
                    });
                }
                const t = BrushPack.toPreset(pr, { tipSize });
                return { t, bd, tipSize, tipUrl, name: pr.name };
            },

            /* Paint one horizontal stroke at full pressure and report how
             * wide the ink actually is, plus how far apart the dabs fell. */
            measure: async (tr, opts) => {
                const app = PaintApp, b = app.brush;
                const W = 700, H = 300;
                app.layerMgr.collapseToBase({ fresh: true });
                app.setSize(W, H); app.config.zoom = 1; app.updateBounds();
                document.getElementById('lsys-add').click();
                app.state.selection = null;
                const L = app.layerMgr.layers[app.layerMgr.activeIdx];

                const ps = Object.assign({}, tr.t.params);
                if (tr.tipUrl) ps._tipUrl = tr.tipUrl;
                // Anything that moves a dab off the line would widen the
                // measurement without meaning the brush is bigger.
                ps.scatter = 0; ps.taperStart = 0; ps.taperEnd = 0;
                if (opts && opts.flat) { ps.sizeSrc = 'none'; ps.flowSrc = 'none'; }
                /* An eraser rearranges pixels rather than adding them, so
                 * on an empty layer it draws a perfect nothing and every
                 * measurement below reads zero. Give it something to take
                 * away and measure the hole instead of the ink. */
                const erasing = ps.blendMode === 'erase';
                if (erasing) {
                    L.ctx.fillStyle = '#000000';
                    L.ctx.fillRect(0, 0, W, H);
                }

                b.PRESETS.__fid = ps;
                b.loadPreset('__fid');
                await new Promise(r => setTimeout(r, 600));   // let the tip load

                b.beginStroke(80, 150, 1, '#000000');
                for (let x = 90; x <= 620; x += 5) b.moveStroke(x, 150, 1, '#000000');
                b.endStroke();
                await new Promise(r => setTimeout(r, 250));

                const d = L.ctx.getImageData(0, 0, W, H).data;
                const marked = erasing
                    ? (i) => d[i * 4 + 3] < 247     // alpha taken away
                    : (i) => d[i * 4 + 3] > 8;      // alpha put down
                const rowHas = [], colHas = [];
                for (let y = 0; y < H; y++) {
                    let any = false;
                    for (let x = 0; x < W; x++) if (marked(y * W + x)) { any = true; break; }
                    rowHas.push(any);
                }
                for (let x = 0; x < W; x++) {
                    let any = false;
                    for (let y = 0; y < H; y++) if (marked(y * W + x)) { any = true; break; }
                    colHas.push(any);
                }
                const first = rowHas.indexOf(true), last = rowHas.lastIndexOf(true);
                const cFirst = colHas.indexOf(true), cLast = colHas.lastIndexOf(true);
                return {
                    height: first < 0 ? 0 : last - first + 1,
                    length: cFirst < 0 ? 0 : cLast - cFirst + 1,
                    // A stroke with gaps means spacing exceeded the tip width.
                    gaps: colHas.slice(Math.max(cFirst, 0), cLast + 1).filter(v => !v).length
                };
            }
        };
        return true;
    `);

    /* ── a generated tip ───────────────────────────────────────────────── */
    console.log('== a brush Krita generates from numbers ==');
    const a = JSON.parse(await page.eval(`(async () => {
        const tr = await __F.translate('auto');
        const m = await __F.measure(tr, { flat: true });
        return JSON.stringify({
            name: tr.name,
            declaredDiameter: tr.bd && tr.bd.mask && tr.bd.mask.diameter,
            declaredRatio: tr.bd && tr.bd.mask && tr.bd.mask.ratio,
            declaredSpacing: tr.bd && tr.bd.spacing,
            translatedSize: tr.t.params.size,
            measured: m
        });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(a));

    check('the translated size is the diameter the preset declares',
        near(a.translatedSize, a.declaredDiameter, 1),
        `declared ${a.declaredDiameter}, translated ${a.translatedSize}`);
    check('...and the ink is that wide on the canvas',
        near(a.measured.height, a.declaredDiameter * (a.declaredRatio || 1), Math.max(3, a.declaredDiameter * 0.15)),
        `declared ${a.declaredDiameter} x ratio ${a.declaredRatio}, drew ${a.measured.height}`);
    check('the stroke is continuous, not a row of separate dabs',
        a.measured.gaps === 0, `${a.measured.gaps} empty columns inside the stroke`);

    /* ── a stamped tip ─────────────────────────────────────────────────── */
    console.log('== a brush that stamps a picture ==');
    const s = JSON.parse(await page.eval(`(async () => {
        const tr = await __F.translate('stamp');
        const m = await __F.measure(tr, { flat: true });
        return JSON.stringify({
            name: tr.name,
            tipPixels: tr.tipSize,
            declaredScale: tr.bd && tr.bd.scale,
            declaredSpacing: tr.bd && tr.bd.spacing,
            translatedSize: tr.t.params.size,
            measured: m
        });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(s));

    check('a stamped tip is sized by its own pixels times the scale',
        near(s.translatedSize, s.tipPixels * s.declaredScale, 1),
        `${s.tipPixels}px tip x ${s.declaredScale} = ${s.tipPixels * s.declaredScale}, translated ${s.translatedSize}`);
    check('...and the ink is no wider than the tip asks for',
        s.measured.height <= s.translatedSize * 1.2 && s.measured.height > s.translatedSize * 0.4,
        `asked ${s.translatedSize}, drew ${s.measured.height}`);
    check('the stroke runs the length it was drawn',
        near(s.measured.length, 540 + s.translatedSize, s.translatedSize),
        `drew ${s.measured.length}px`);

    /* ── the two options a preset can ask for and we used to drop ──────── */
    console.log('== sharpness cuts the soft edge off ==');
    const sh = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush;
        const L = (() => {
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(200, 200); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            return app.layerMgr.layers[app.layerMgr.activeIdx];
        })();
        // A deliberately soft dab: most of its pixels are part-way alpha.
        const ramp = async (sharpness) => {
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 80); b.setParam('hardness', 20);
            b.setParam('scatter', 0); b.setParam('flow', 100);
            b.setParam('sharpness', sharpness); b.setParam('sharpSoftness', 10);
            L.ctx.clearRect(0, 0, 200, 200);
            b.beginStroke(100, 100, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 80));
            const d = L.ctx.getImageData(0, 0, 200, 200).data;
            let mid = 0, solid = 0;
            for (let i = 3; i < d.length; i += 4) {
                if (d[i] > 40 && d[i] < 215) mid++;
                else if (d[i] >= 215) solid++;
            }
            return { mid, solid };
        };
        const off = await ramp(0);
        const on = await ramp(100);
        b.setParam('sharpness', 0);
        return JSON.stringify({ off, on });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(sh));

    check('a soft brush is mostly gradient until sharpness is asked for',
        sh.off.mid > sh.off.solid, JSON.stringify(sh.off));
    check('...and sharpness turns that gradient into an edge',
        sh.on.mid < sh.off.mid / 2 && sh.on.solid > sh.off.solid,
        `${sh.off.mid} ramp pixels became ${sh.on.mid}`);

    console.log('== scatter can be asked for on one axis only ==');
    const ax = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush;
        const W = 400, H = 300;
        const run = async (axis) => {
            app.layerMgr.collapseToBase({ fresh: true });
            app.setSize(W, H); app.config.zoom = 1; app.updateBounds();
            document.getElementById('lsys-add').click();
            app.state.selection = null;
            const L = app.layerMgr.layers[app.layerMgr.activeIdx];
            b.loadPreset('Round');
            b.setParam('dynamicsMode', 'off');
            b.setParam('size', 8); b.setParam('hardness', 100);
            b.setParam('scatter', 300); b.setParam('scatterAxis', axis);
            b.beginStroke(100, 150, 1, '#000000');
            for (let x = 105; x <= 300; x += 5) b.moveStroke(x, 150, 1, '#000000');
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            const d = L.ctx.getImageData(0, 0, W, H).data;
            let top = H, bot = -1;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    if (d[(y * W + x) * 4 + 3] > 8) { if (y < top) top = y; bot = y; break; }
                }
            }
            return bot < 0 ? 0 : bot - top + 1;
        };
        const both = await run('both');
        const along = await run('along');
        const across = await run('across');
        b.setParam('scatterAxis', 'both');
        return JSON.stringify({ both, along, across });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(ax));

    /* A horizontal stroke: scattering ALONG it cannot make it any taller
     * than the tip, scattering ACROSS it is the only thing that can. */
    check('scatter along the stroke leaves its width alone',
        ax.along <= 12, `the stroke grew to ${ax.along}px tall`);
    check('...and scatter across it does not',
        ax.across > ax.along * 2 && Math.abs(ax.across - ax.both) < ax.both * 0.5,
        JSON.stringify(ax));

    /* A rake smudge dragged along the join between two colours has to come
     * out two-toned. One load shared by the whole head averages them into a
     * single muddy smear, which is what Krita's rake smudges never do. */
    console.log('== each hair of a rake carries its own colour ==');
    const sm = JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush;
        const W = 400, H = 240;
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(W, H); app.config.zoom = 1; app.updateBounds();
        document.getElementById('lsys-add').click();
        app.state.selection = null;
        const L = app.layerMgr.layers[app.layerMgr.activeIdx];
        // Red over blue, with the join at y = 120.
        L.ctx.fillStyle = '#ff0000'; L.ctx.fillRect(0, 0, W, 120);
        L.ctx.fillStyle = '#0000ff'; L.ctx.fillRect(0, 120, W, 120);

        b.loadPreset('Round');
        b.setParam('dynamicsMode', 'off');
        b.setParam('size', 60); b.setParam('hardness', 100);
        b.setParam('scatter', 0); b.setParam('spacing', 8);
        b.setParam('bristleCount', 12); b.setParam('bristleLength', 10);
        b.setParam('bristleWidth', 4); b.setParam('bristleSpread', 90);
        b.setParam('colorRate', 0);        // pure smudge, no fresh paint
        b.setParam('smudgeLength', 80);

        b.beginStroke(60, 120, 1, '#00ff00');
        for (let x = 66; x <= 340; x += 6) b.moveStroke(x, 120, 1, '#00ff00');
        b.endStroke();
        await new Promise(r => setTimeout(r, 250));

        // Read a column well past where the stroke started, so whatever the
        // hairs are carrying has been carried some distance.
        const d = L.ctx.getImageData(300, 95, 1, 50).data;
        let above = null, below = null;
        for (let i = 0; i < 50; i++) {
            const px = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
            if (i < 15) above = px;
            if (i > 34) below = px;
        }
        b.loadPreset('Round');
        return JSON.stringify({ above, below });
    })()`, { awaitPromise: true }));
    console.log('  ' + JSON.stringify(sm));

    /* The thresholds are what separates this from the shared-load version,
     * which drags 108 of red down into the blue: both are "mostly the right
     * colour", only one keeps them apart. */
    check('the hairs over red carry red and nothing else',
        sm.above[0] > 200 && sm.above[2] < 40, JSON.stringify(sm.above));
    check('...while the hairs over blue carry blue and nothing else',
        sm.below[2] > 200 && sm.below[0] < 40, JSON.stringify(sm.below));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
