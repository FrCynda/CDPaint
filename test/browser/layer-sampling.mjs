/* Tools must act on the layer you have selected.
 *
 * Reported: draw a stroke on an upper layer, select the Background layer, wand
 * the uniform background — and the selection has a stroke-shaped hole in it,
 * even though that stroke is not on this layer.
 *
 * The wand was hardcoded to sample the composite whenever the document had
 * more than one layer, while the bucket and the eyedropper sampled the active
 * layer. Two consequences: the mask is wrong (this file's first group), and —
 * worse — the composite pixels were also used as the *source* for the lifted
 * selection and for the layer's new contents, so wanding on a lower layer
 * baked the upper layers' art into it (the second group).
 *
 * Krita and CSP both sample the active layer by default and put "sample all
 * layers" behind an explicit toggle. That is what these tests pin down.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const WHITE = '255,255,255,255';
const BLACK = '0,0,0,255';

await withPage(async (page) => {
    await page.run(`
        window.__q = {
            /* White Background layer, black square on a transparent layer above
             * it, Background selected again. The classic two-layer document. */
            twoLayers: () => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(200, 200);
                PaintApp.config.zoom = 1; PaintApp.updateBounds();
                PaintApp.ctx.fillStyle = '#ffffff';
                PaintApp.ctx.fillRect(0, 0, 200, 200);

                document.getElementById('lsys-add').click();
                PaintApp.ctx.fillStyle = '#000000';
                PaintApp.ctx.fillRect(80, 80, 40, 40);

                PaintApp.layerMgr.activeIdx = 0;          // back to Background
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.config.sampleAllLayers = false;
                PaintApp.saveState();
            },
            layerPx: (i, x, y) => {
                const L = PaintApp.layerMgr.layers[i];
                const d = L.ctx.getImageData(x, y, 1, 1).data;
                return [d[0], d[1], d[2], d[3]].join(',');
            },
            /* What the floating selection actually picked up. */
            selPx: (x, y) => {
                const s = PaintApp.state.selection;
                if (!s) return 'no-selection';
                const d = s.canvas.getContext('2d')
                    .getImageData(x - s.x, y - s.y, 1, 1).data;
                return [d[0], d[1], d[2], d[3]].join(',');
            },
            selRect: () => {
                const s = PaintApp.state.selection;
                return s ? [s.x, s.y, s.w, s.h].join(',') : 'no-selection';
            },
            ev: (type, x, y, buttons, target) => {
                const b = PaintApp.bounds;
                (target || window).dispatchEvent(new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 1,
                    pointerType: 'mouse', isPrimary: true, buttons, button: 0,
                    clientX: b.left + x, clientY: b.top + y
                }));
            },
            frame: () => new Promise(r => requestAnimationFrame(() => r())),
            sleep: (ms) => new Promise(r => setTimeout(r, ms)),
            /* A real wand click, through the pointer handlers, so the layer
             * system's onMouseDown patch is in the path. */
            wandClick: async (x, y) => {
                PaintApp.config.tool = 'wand';
                PaintApp.config.wandMode = 'contiguous';
                PaintApp.config.wandTolerance = 0;
                __q.ev('pointerdown', x, y, 1, PaintApp.ui.stage);
                await __q.frame(); await __q.sleep(60); await __q.frame();
                __q.ev('pointerup', x, y, 0);
                await __q.frame(); await __q.sleep(30);
            }
        };
        return true;
    `);

    console.log('== wand samples the active layer ==');
    const r1 = await page.eval(`(async () => {
        __q.twoLayers();
        const out = {};
        out.bgUnderStroke = __q.layerPx(0, 100, 100);   // Background is white here
        out.strokeOnUpper = __q.layerPx(1, 100, 100);   // the square lives up there
        await __q.wandClick(10, 10);                    // wand the uniform background
        out.rect  = __q.selRect();
        out.selAtStroke = __q.selPx(100, 100);
        out.selAtCorner = __q.selPx(10, 10);
        out.bgLeftBehind = __q.layerPx(0, 100, 100);
        return JSON.stringify(out);
    })()`, { awaitPromise: true });
    const o1 = JSON.parse(r1);
    console.log('  ' + JSON.stringify(o1, null, 1).replace(/\n/g, '\n  '));

    check('Background really is uniform white under the stroke',
        o1.bgUnderStroke === WHITE, o1.bgUnderStroke);
    check('the stroke really is on the upper layer',
        o1.strokeOnUpper === BLACK, o1.strokeOnUpper);
    check('the wand reaches the far corner of the uniform layer',
        o1.selAtCorner === WHITE && o1.rect === '0,0,200,200',
        `rect ${o1.rect}, corner ${o1.selAtCorner}`);
    check('no stroke-shaped hole — the upper layer does not block this selection',
        o1.selAtStroke === WHITE,
        `selection is transparent at the stroke (${o1.selAtStroke}); the mask came from the composite`);
    check('the Background layer is not contaminated with the upper layer art',
        o1.bgLeftBehind !== BLACK,
        `Background is ${o1.bgLeftBehind} at the stroke — composite pixels were written into it`);

    console.log('\n== "sample all layers" still available ==');
    const r2 = await page.eval(`(async () => {
        __q.twoLayers();
        PaintApp.config.sampleAllLayers = true;
        const out = {};
        await __q.wandClick(10, 10);
        out.rect = __q.selRect();
        out.selAtStroke = __q.selPx(100, 100);
        out.selAtCorner = __q.selPx(10, 10);
        out.bgLeftBehind = __q.layerPx(0, 100, 100);
        return JSON.stringify(out);
    })()`, { awaitPromise: true });
    const o2 = JSON.parse(r2);
    console.log('  ' + JSON.stringify(o2, null, 1).replace(/\n/g, '\n  '));

    check('with the toggle on, the composited stroke does block the mask',
        o2.selAtStroke === '0,0,0,0' && o2.selAtCorner === WHITE,
        `stroke ${o2.selAtStroke}, corner ${o2.selAtCorner}`);
    check('even then the Background layer keeps its own pixels',
        o2.bgLeftBehind !== BLACK,
        `Background is ${o2.bgLeftBehind} at the stroke — composite pixels leaked in`);

    console.log('\n== bucket and eyedropper agree with the wand ==');
    const r3 = await page.eval(`(() => {
        __q.twoLayers();
        const out = {};
        PaintApp.pickColor(100, 100, 1);
        out.picked = PaintApp.config.c1;
        PaintApp.floodFill(10, 10, PaintApp.hexToRgb('#ffffff'));
        out.filledUnderStroke = __q.layerPx(0, 100, 100);
        return JSON.stringify(out);
    })()`);
    const o3 = JSON.parse(r3);
    console.log('  ' + JSON.stringify(o3, null, 1).replace(/\n/g, '\n  '));

    check('eyedropper reads the active layer, not the composited stroke',
        String(o3.picked).toLowerCase() === '#ffffff', o3.picked);
    check('bucket floods across the whole layer, unblocked by the upper stroke',
        o3.filledUnderStroke === WHITE, o3.filledUnderStroke);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
