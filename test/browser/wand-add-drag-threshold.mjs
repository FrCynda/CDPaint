/* Magic wand: shift-adding a second region, then dragging the mouse to
 * change ITS threshold live (before releasing).
 *
 * The threshold-drag preview always worked for a plain (non-additive) wand
 * click: each frame recomputes the whole selection from scratch off a
 * pristine pre-drag snapshot, so dragging back toward the click point always
 * shrinks it correctly.
 *
 * Shift-click-and-drag to ADD a second region shared none of that safety.
 * Every preview frame (a) unioned the new flood-fill against
 * `state.selection` — but that field had *already been overwritten* by the
 * previous frame's own (possibly larger) result, so the "previous selection"
 * side of the union could only ever grow, never shrink back down as the
 * threshold dropped — and (b) rebuilt its pixel data by re-reading
 * `this.ctx`, which earlier frames had already mutated, so pixels that
 * briefly fell inside a larger threshold and then dropped back out had no
 * record of their original colour left anywhere and stayed a stray hole.
 *
 * The fix freezes two things once, at the start of the add gesture, and
 * uses them as every frame's fixed baseline instead of re-reading live
 * (already-mutated) state: the selection mask to union against
 * (state.wandOpBaseSelection) and a pristine copy of this layer's pixels
 * (state.wandOpBaseLayerSnapshot).
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        PaintApp.layerMgr.collapseToBase({ fresh: true });
        PaintApp.setSize(60, 30);
        const c = PaintApp.ctx;
        const img = c.createImageData(60, 30);
        const d = img.data;
        for (let y = 0; y < 30; y++) for (let x = 0; x < 60; x++) {
            const i = (y * 60 + x) * 4;
            if (x < 15 && y < 15) {
                d[i] = 200; d[i+1] = 20; d[i+2] = 20; d[i+3] = 255; // region A
            } else if (x >= 30) {
                // Region B: blue that drifts further from the seed pixel (30,15)
                // as x increases, so different tolerances select different widths.
                d[i] = 20; d[i+1] = 20; d[i+2] = Math.max(0, 200 - (x - 30) * 5); d[i+3] = 255;
            } else {
                d[i] = 255; d[i+1] = 255; d[i+2] = 255; d[i+3] = 255; // gap, always white
            }
        }
        c.putImageData(img, 0, 0);
        PaintApp.state.history = []; PaintApp.state.step = -1;
        PaintApp.config.zoom = 1; PaintApp.updateBounds();
        PaintApp.saveState();
        PaintApp.setTool('wand');
        PaintApp.config.wandMode = 'contiguous';
        PaintApp.config.wandTolerance = 0;
        window.__originalAt45 = Array.from(c.getImageData(45, 15, 1, 1).data);
    `);

    const ev = async (type, x, y, opts) => page.run(`
        (() => {
            const b = PaintApp.bounds;
            const target = ${JSON.stringify(type)} === 'pointerdown' ? PaintApp.ui.stage : window;
            target.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
                bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
                isPrimary: true, buttons: ${opts && opts.buttons != null ? opts.buttons : 1}, button: 0,
                shiftKey: ${!!(opts && opts.shift)},
                clientX: b.left + ${x}, clientY: b.top + ${y}
            }));
        })();
    `);
    const frame = async () => page.run(`return new Promise(r => requestAnimationFrame(() => r()));`);
    const sleep = async (ms) => page.run(`return new Promise(r => setTimeout(r, ${ms}));`);
    const originalAt45 = await page.run(`return window.__originalAt45;`);

    // Step 1: plain click selects region A.
    await ev('pointerdown', 5, 5);
    await frame();
    await ev('pointerup', 5, 5);
    await sleep(50);
    const afterFirst = await page.run(`return { w: PaintApp.state.selection.w, source: PaintApp.state.selection.source };`);
    check('plain click selects region A', afterFirst.w === 15, JSON.stringify(afterFirst));

    // Step 2: shift+click at (30,15) then drag right (grow) then drag back
    // left to the start (shrink) before releasing.
    await ev('pointerdown', 30, 15, { shift: true });
    await frame();
    await sleep(30);
    // Drag to a screen offset that pushes the threshold well past the diff at
    // x=45 (diff 75, and 3.333px of drag = 1 unit of tolerance), so it's
    // solidly included.
    await ev('pointermove', 30 + 300, 15, { shift: true });
    await frame();
    await sleep(150);
    const grown = await page.run(`
        return { pixelAt45: Array.from(PaintApp.ctx.getImageData(45, 15, 1, 1).data), w: PaintApp.state.selection.w };
    `);
    check('x=45 got cut away once the drag threshold grew past it',
        JSON.stringify(grown.pixelAt45) !== JSON.stringify(originalAt45), JSON.stringify(grown.pixelAt45));

    // Drag back to (almost) the click point — threshold back near 0.
    await ev('pointermove', 31, 15, { shift: true });
    await frame();
    await sleep(30);
    await ev('pointerup', 31, 15, { shift: true });
    await sleep(50);

    const final = await page.run(`
        const sel = PaintApp.state.selection;
        const mask = sel.mask.getContext('2d').getImageData(0, 0, sel.mask.width, sel.mask.height).data;
        let area = 0;
        for (let i = 3; i < mask.length; i += 4) if (mask[i] > 0) area++;
        return {
            w: sel.w,
            area,
            pixelAt45: Array.from(PaintApp.ctx.getImageData(45, 15, 1, 1).data)
        };
    `);

    check('dragging back to the click point shrinks the added region back down (not stuck at the grown size)',
        final.w < grown.w, JSON.stringify({ final, grown }));
    check('the pixel that fell out of the shrunk-back selection is restored to its original colour, not left as a hole',
        JSON.stringify(final.pixelAt45) === JSON.stringify(originalAt45),
        JSON.stringify({ got: final.pixelAt45, want: originalAt45 }));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
