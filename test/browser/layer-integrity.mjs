/* Cross-layer invariants: an edit must touch exactly one layer, and undo must
 * put exactly that layer back.
 *
 * These are the properties that make a layer stack trustworthy, and the ones
 * that break quietly — a tool that reads or writes the composited picture
 * instead of the active layer leaves the document looking right until you hide
 * a layer or undo, and only then does the damage show.
 *
 * Every test hashes each layer independently, so "something changed on a layer
 * that should not have changed" is caught even when the composite looks fine.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__L = {
            /* Three layers, each with its own unmistakable content:
             *   0 Background — solid white
             *   1            — red square, left
             *   2            — blue square, right  */
            stack: () => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(200, 200);
                PaintApp.config.zoom = 1; PaintApp.updateBounds();
                PaintApp.config.sampleAllLayers = false;
                PaintApp.ctx.fillStyle = '#ffffff';
                PaintApp.ctx.fillRect(0, 0, 200, 200);

                document.getElementById('lsys-add').click();
                PaintApp.ctx.fillStyle = '#ff0000';
                PaintApp.ctx.fillRect(20, 20, 60, 60);

                document.getElementById('lsys-add').click();
                PaintApp.ctx.fillStyle = '#0000ff';
                PaintApp.ctx.fillRect(120, 120, 60, 60);

                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.saveState();
            },
            use: (i) => { PaintApp.layerMgr.activeIdx = i; },
            /* Content hash of one layer, on its own. */
            hash: (i) => {
                const L = PaintApp.layerMgr.layers[i];
                if (!L) return 'missing';
                const d = L.ctx.getImageData(0, 0, 200, 200).data;
                let a = 0x811c9dc5;
                for (let k = 0; k < d.length; k++) a = ((a ^ d[k]) * 16777619) >>> 0;
                return a.toString(16);
            },
            all: () => PaintApp.layerMgr.layers.map((_, i) => __L.hash(i)),
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
            wandClick: async (x, y) => {
                PaintApp.config.tool = 'wand';
                PaintApp.config.wandMode = 'contiguous';
                PaintApp.config.wandTolerance = 0;
                __L.ev('pointerdown', x, y, 1, PaintApp.ui.stage);
                await __L.frame(); await __L.sleep(60); await __L.frame();
                __L.ev('pointerup', x, y, 0);
                await __L.frame(); await __L.sleep(30);
            }
        };
        return true;
    `);

    /* ── 1. a stroke touches one layer, undo puts it back ─────────────── */
    console.log('== a stroke touches one layer only ==');
    const r1 = await page.eval(`(() => {
        __L.stack();
        const before = __L.all();
        __L.use(1);
        PaintApp.ctx.fillStyle = '#00ff00';
        PaintApp.ctx.fillRect(90, 90, 20, 20);
        PaintApp.saveState();
        const after = __L.all();
        PaintApp.undo();
        const undone = __L.all();
        return JSON.stringify({ before, after, undone });
    })()`);
    const o1 = JSON.parse(r1);
    check('the edited layer actually changed', o1.before[1] !== o1.after[1]);
    check('the layer below was untouched', o1.before[0] === o1.after[0]);
    check('the layer above was untouched', o1.before[2] === o1.after[2]);
    check('undo restores every layer exactly',
        JSON.stringify(o1.undone) === JSON.stringify(o1.before),
        `${o1.before.join('/')} -> ${o1.undone.join('/')}`);

    /* ── 2. wand + cut on a middle layer ──────────────────────────────── */
    // A wand selection already lifted the red square off the layer before the
    // cut ever ran, so "undo the cut" doesn't land back on the untouched
    // pre-selection layer in one step — it lands back on "selection active",
    // which still shows the lifted hole (covered by the floating selection,
    // not by real pixels). That's deliberate: it's what lets one more undo
    // (or just continuing to work) get the selection back instead of losing
    // it. A SECOND undo is what fully restores the pristine, pre-selection
    // layer.
    console.log('\n== wand-select and delete on a middle layer ==');
    const r2 = await page.eval(`(async () => {
        __L.stack();
        const before = __L.all();
        __L.use(1);
        await __L.wandClick(40, 40);        // the red square
        PaintApp.deleteSelection();
        const after = __L.all();
        PaintApp.undo();
        const undoneOnce = __L.all();
        const selectionBack = !!PaintApp.state.selection;
        PaintApp.undo();
        const undoneTwice = __L.all();
        return JSON.stringify({ before, after, undoneOnce, undoneTwice, selectionBack });
    })()`, { awaitPromise: true });
    const o2 = JSON.parse(r2);
    check('the cut layer changed', o2.before[1] !== o2.after[1]);
    check('the Background survived the cut', o2.before[0] === o2.after[0],
        'a cut on layer 1 also altered layer 0');
    check('the layer above survived the cut', o2.before[2] === o2.after[2],
        'a cut on layer 1 also altered layer 2');
    check('one undo after a wand cut brings the selection back',
        o2.selectionBack, 'state.selection was null after undoing a cut');
    check('a second undo restores every layer to before the selection',
        JSON.stringify(o2.undoneTwice) === JSON.stringify(o2.before),
        `${o2.before.join('/')} -> ${o2.undoneTwice.join('/')}`);

    /* ── 3. undo after switching layers ───────────────────────────────── */
    console.log('\n== undo after switching layers ==');
    const r3 = await page.eval(`(() => {
        __L.stack();
        const before = __L.all();
        __L.use(1);
        PaintApp.ctx.fillStyle = '#00ff00';
        PaintApp.ctx.fillRect(90, 90, 20, 20);
        PaintApp.saveState();
        __L.use(2);                          // walk away before undoing
        PaintApp.undo();
        const undone = __L.all();
        return JSON.stringify({ before, undone, active: PaintApp.layerMgr.activeIdx });
    })()`);
    const o3 = JSON.parse(r3);
    check('undo restores the layer that was edited, not the selected one',
        JSON.stringify(o3.undone) === JSON.stringify(o3.before),
        `${o3.before.join('/')} -> ${o3.undone.join('/')}`);

    /* ── 4. hidden layers are not edited ──────────────────────────────── */
    console.log('\n== a hidden layer is left alone ==');
    const r4 = await page.eval(`(async () => {
        __L.stack();
        PaintApp.layerMgr.layers[2].visible = false;
        const before = __L.all();
        __L.use(0);
        await __L.wandClick(150, 10);       // wand the white background
        PaintApp.deleteSelection();
        const after = __L.all();
        return JSON.stringify({ before, after });
    })()`, { awaitPromise: true });
    const o4 = JSON.parse(r4);
    check('the hidden layer is untouched by an edit below it',
        o4.before[2] === o4.after[2]);
    check('the visible middle layer is untouched too',
        o4.before[1] === o4.after[1]);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
