/* Selecting on a transparent layer must not paint the background colour in.
 *
 * Lifting a selection leaves a hole where the pixels were. On a flat document
 * that hole is C2, the background colour, exactly as MS Paint does it. A layer
 * that carries real alpha has to keep the hole transparent instead.
 *
 * The rectangular tool already got this right — its cut is deferred and checks
 * the layer. The lasso, the polyline and the wand all go through
 * applyMaskSelection(), which used to fill C2 unconditionally, so every
 * selection flooded the empty parts of the layer with the secondary colour and
 * it showed through the gaps in the floating selection.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const CLEAR = '0,0,0,0';
const C2 = '0,255,0,255';   // the loud secondary colour these tests use
const RED = '255,0,0,255';

await withPage(async (page) => {
    await page.run(`
        window.__q = {
            /* A fresh flat white document with a garish secondary colour, so a
             * stray background fill is unmistakable. */
            reset: () => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(200, 200);
                PaintApp.ctx.fillStyle = '#ffffff';
                PaintApp.ctx.fillRect(0, 0, 200, 200);
                PaintApp.config.c2 = '#00ff00';
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.saveState();
            },
            /* Add a layer above it — new layers carry alpha. */
            addTrans: () => {
                document.getElementById('lsys-add').click();
                return PaintApp.layerMgr.layers[PaintApp.layerMgr.activeIdx];
            },
            activeSurface: () => PaintApp.layerMgr.layers[PaintApp.layerMgr.activeIdx]
                || { ctx: PaintApp.ui.cMain.getContext('2d') },
            blob: (x, y, w, h) => {
                PaintApp.ctx.fillStyle = '#ff0000';
                PaintApp.ctx.fillRect(x, y, w, h);
            },
            px: (L, x, y) => {
                const d = L.ctx.getImageData(x, y, 1, 1).data;
                return [d[0], d[1], d[2], d[3]].join(',');
            },
            /* A quadrilateral covering most of the canvas, drawn either as a
             * freehand drag or click-by-click as the polyline mode does. */
            lasso: (mode, pts) => {
                PaintApp.config.tool = 'lasso';
                PaintApp.config.lassoSelectMode = mode;
                const p = pts || [{x:10,y:10},{x:180,y:10},{x:180,y:180},{x:10,y:180}];
                PaintApp.startLassoSelection(p[0]);
                for (let i = 1; i < p.length; i++) PaintApp.appendLassoPoint(p[i]);
                PaintApp.finalizeLassoSelection();
            },
            hash: (L) => {
                const d = L.ctx.getImageData(0, 0, 200, 200).data;
                let a = 0x811c9dc5;
                for (let i = 0; i < d.length; i++) a = ((a ^ d[i]) * 16777619) >>> 0;
                return a.toString(16);
            }
        };
        return true;
    `);

    console.log('== 1. free lasso on a transparent layer ==');
    {
        const r = await page.eval(`(() => {
            __q.reset();
            const L = __q.addTrans();
            __q.blob(20, 20, 10, 10);
            const before = __q.hash(L);
            __q.lasso('free');
            const out = {
                alpha: L.alpha,
                empty: __q.px(L, 100, 100),
                lifted: __q.px(L, 25, 25),
                outside: __q.px(L, 5, 5),
                selected: !!PaintApp.state.selection
            };
            PaintApp.commitSelection();          // deselect without moving
            out.restored = __q.hash(L) === before;
            return out;
        })()`);
        check('the layer really does carry alpha', r.alpha === true);
        check('a selection was created', r.selected);
        check('empty pixels inside the selection stay transparent',
            r.empty === CLEAR, r.empty);
        check('drawn pixels are lifted out, leaving transparency',
            r.lifted === CLEAR, r.lifted);
        check('pixels outside the selection are untouched',
            r.outside === CLEAR, r.outside);
        check('deselecting without moving puts the layer back exactly',
            r.restored);
    }

    console.log('\n== 2. polyline lasso on a transparent layer ==');
    {
        const r = await page.eval(`(() => {
            __q.reset();
            const L = __q.addTrans();
            __q.blob(20, 20, 10, 10);
            __q.lasso('poly');
            return { empty: __q.px(L, 100, 100), lifted: __q.px(L, 25, 25) };
        })()`);
        check('empty pixels inside the selection stay transparent',
            r.empty === CLEAR, r.empty);
        check('drawn pixels are lifted out', r.lifted === CLEAR, r.lifted);
    }

    console.log('\n== 3. magic wand on a transparent layer ==');
    {
        const r = await page.eval(`(() => {
            __q.reset();
            const L = __q.addTrans();
            __q.blob(20, 20, 60, 60);
            PaintApp.config.tool = 'wand';
            PaintApp.magicWandSelect(40, 40, 0);
            return { inside: __q.px(L, 40, 40), outside: __q.px(L, 150, 150) };
        })()`);
        check('the wanded region is lifted, not filled with C2',
            r.inside === CLEAR, r.inside);
        check('the rest of the layer is untouched',
            r.outside === CLEAR, r.outside);
    }

    console.log('\n== 4. moving a lassoed selection ==');
    {
        const r = await page.eval(`(() => {
            __q.reset();
            const L = __q.addTrans();
            __q.blob(20, 20, 40, 40);
            PaintApp.saveState();
            const before = __q.hash(L);
            __q.lasso('free', [{x:15,y:15},{x:65,y:15},{x:65,y:65},{x:15,y:65}]);
            const s = PaintApp.state.selection;
            s.x += 100; s.y += 100;
            PaintApp.commitSelection();
            const out = {
                vacated: __q.px(L, 40, 40),
                arrived: __q.px(L, 140, 140),
                moved: __q.hash(L) !== before
            };
            let n = 0;
            while (n < 6 && __q.hash(L) !== before) { PaintApp.undo(); n++; }
            out.undos = n;
            out.backToStart = __q.hash(L) === before;
            return out;
        })()`);
        check('the picture actually changed', r.moved);
        check('the vacated area is transparent, not C2',
            r.vacated === CLEAR, r.vacated);
        check('the pixels arrived at the new position',
            r.arrived === RED, r.arrived);
        check('one undo puts the layer back exactly',
            r.backToStart && r.undos === 1, r.undos + ' undos, restored=' + r.backToStart);
    }

    console.log('\n== 5. a flat document still behaves like MS Paint ==');
    {
        const r = await page.eval(`(() => {
            __q.reset();
            const L = __q.activeSurface();
            __q.blob(20, 20, 10, 10);
            __q.lasso('free');
            return { hole: __q.px(L, 100, 100) };
        })()`);
        check('the hole left behind is filled with the background colour',
            r.hole === C2, r.hole);
    }

    console.log('\n== 6. a layer explicitly marked opaque also fills ==');
    {
        const r = await page.eval(`(() => {
            __q.reset();
            const L = __q.addTrans();
            L.alpha = false;                     // as the "normal" layer mode sets it
            L.ctx.fillStyle = '#ffffff';
            L.ctx.fillRect(0, 0, 200, 200);
            __q.blob(20, 20, 10, 10);
            __q.lasso('free');
            return { hole: __q.px(L, 100, 100) };
        })()`);
        check('an opaque layer keeps the background fill',
            r.hole === C2, r.hole);
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 6)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
