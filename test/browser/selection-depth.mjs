/* A floating selection belongs to its layer, so layers above it cover it.
 *
 * Lifting a selection puts its pixels on the temp canvas. That canvas used to
 * sit above the whole composited stack in the DOM, so a selection floated off
 * the Background layer was drawn over every layer above it — including opaque
 * ones that should hide it completely. Krita, CSP and Photoshop all composite a
 * floating selection at its own layer's depth.
 *
 * The marching-ants outline is a different thing and legitimately draws above
 * everything: it lives in the SVG overlay, not on the temp canvas, and these
 * tests do not touch it.
 *
 * Layout, all on a 200x200 document:
 *   Background  white, with a RED square   at (20,20)-(80,80)
 *   layer 1     transparent, BLUE square   at (50,50)-(110,110)
 * so (30,30) is red only, (60,60) is red under blue, (100,100) is blue only.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const RED = '255,0,0,255';
const BLUE = '0,0,255,255';

await withPage(async (page) => {
    await page.run(`
        window.__D = {
            stack: () => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(200, 200);
                PaintApp.config.zoom = 1; PaintApp.updateBounds();
                PaintApp.config.sampleAllLayers = false;
                PaintApp.ctx.fillStyle = '#ffffff';
                PaintApp.ctx.fillRect(0, 0, 200, 200);
                PaintApp.ctx.fillStyle = '#ff0000';
                PaintApp.ctx.fillRect(20, 20, 60, 60);

                document.getElementById('lsys-add').click();
                PaintApp.ctx.fillStyle = '#0000ff';
                PaintApp.ctx.fillRect(50, 50, 60, 60);

                PaintApp.layerMgr.activeIdx = 0;      // work on the Background
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.saveState();
            },
            /* What the display surface actually shows. */
            shown: (x, y) => {
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(x, y, 1, 1).data;
                return [d[0], d[1], d[2], d[3]].join(',');
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
            settle: async () => {
                PaintApp.layerMgr.render();
                await __D.frame(); await __D.sleep(40); await __D.frame();
            },
            wandClick: async (x, y) => {
                PaintApp.config.tool = 'wand';
                PaintApp.config.wandMode = 'contiguous';
                PaintApp.config.wandTolerance = 0;
                __D.ev('pointerdown', x, y, 1, PaintApp.ui.stage);
                await __D.frame(); await __D.sleep(60); await __D.frame();
                __D.ev('pointerup', x, y, 0);
                await __D.frame(); await __D.sleep(40);
            }
        };
        return true;
    `);

    console.log('== a wand selection floats at its own layer depth ==');
    const r1 = await page.eval(`(async () => {
        __D.stack();
        await __D.settle();
        const out = {};
        out.beforeRedOnly = __D.shown(30, 30);
        out.beforeOverlap = __D.shown(60, 60);
        await __D.wandClick(30, 30);      // lift the red square off the Background
        await __D.settle();
        out.redOnly = __D.shown(30, 30);
        out.overlap = __D.shown(60, 60);
        out.blueOnly = __D.shown(100, 100);
        return JSON.stringify(out);
    })()`, { awaitPromise: true });
    const o1 = JSON.parse(r1);
    console.log('  ' + JSON.stringify(o1, null, 1).replace(/\n/g, '\n  '));

    check('the document starts out composited correctly',
        o1.beforeRedOnly === RED && o1.beforeOverlap === BLUE,
        `${o1.beforeRedOnly} / ${o1.beforeOverlap}`);
    check('the floating selection is still visible where nothing covers it',
        o1.redOnly === RED, `got ${o1.redOnly}`);
    check('the layer above covers the floating selection',
        o1.overlap === BLUE,
        `got ${o1.overlap} — the selection is drawing over the layer above it`);
    check('the layer above is otherwise unaffected',
        o1.blueOnly === BLUE, o1.blueOnly);

    console.log('\n== select-all floats at its own layer depth too ==');
    const r2 = await page.eval(`(async () => {
        __D.stack();
        await __D.settle();
        const out = {};
        PaintApp.selectAll();
        await __D.settle();
        out.redOnly = __D.shown(30, 30);
        out.overlap = __D.shown(60, 60);
        return JSON.stringify(out);
    })()`, { awaitPromise: true });
    const o2 = JSON.parse(r2);
    console.log('  ' + JSON.stringify(o2, null, 1).replace(/\n/g, '\n  '));

    check('select-all keeps the Background visible where it should be',
        o2.redOnly === RED, `got ${o2.redOnly}`);
    check('select-all does not lift the layer above the stack',
        o2.overlap === BLUE,
        `got ${o2.overlap} — the whole layer floated over the one above it`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
