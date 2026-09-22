/* Free-pan mode: panning/zooming away has no forced snap-back anymore. A
 * "Return to Canvas" button appears once neither the canvas nor (while the
 * Palette Wand is active) its swatch canvas is on screen, and clicking it
 * recenters the view.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    const result = await page.run(`
        function btnVisible() {
            const btn = document.getElementById('recenter-canvas-btn');
            return btn && getComputedStyle(btn).display !== 'none';
        }

        // Enter Free mode.
        PaintApp.toggleAnchorCanvas(false);
        const hiddenAtCenter = !btnVisible();

        // Pan the canvas way off screen.
        PaintApp.state.canvasOffset = { x: -100000, y: -100000 };
        PaintApp.applyStageTransform();
        PaintApp.updateCanvasVisibilityButton();
        const shownWhenPannedAway = btnVisible();

        // Click it — should recenter and hide itself again.
        document.getElementById('recenter-canvas-btn').click();
        const offsetAfterClick = { x: PaintApp.state.canvasOffset.x, y: PaintApp.state.canvasOffset.y };
        const hiddenAfterRecenter = !btnVisible();

        // Activate the Palette Wand, pan away from the main canvas but keep
        // the swatch canvas (100px to its right) on screen — button should
        // stay hidden since the pseudo-canvas still counts.
        PaintApp._activateToolFromGrid(PaintApp.getToolManifestItem('wand-palette'));
        const vp = PaintApp.ui.viewport;
        const stageW = PaintApp.config.width * PaintApp.config.zoom;
        // Shift left by just over the stage width, so layer-main is gone but
        // swatch-canvas (offset +100px past it) still overlaps the viewport.
        PaintApp.state.canvasOffset = { x: -(stageW + 50), y: 0 };
        PaintApp.applyStageTransform();
        PaintApp.updateCanvasVisibilityButton();
        const hiddenWhileSwatchVisible = !btnVisible();

        // Now pan far enough that the swatch canvas is gone too.
        PaintApp.state.canvasOffset = { x: -100000, y: -100000 };
        PaintApp.applyStageTransform();
        PaintApp.updateCanvasVisibilityButton();
        const shownWhenBothGone = btnVisible();

        // Back to Anchored mode — button must never show there.
        PaintApp.toggleAnchorCanvas(true);
        PaintApp.state.canvasOffset = { x: -100000, y: -100000 };
        PaintApp.updateCanvasVisibilityButton();
        const hiddenInAnchoredMode = !btnVisible();

        // Direction check: re-enter Free mode, park the canvas far to the
        // LEFT of the viewport (large negative x offset moves the stage
        // left) — the arrow should point left (-90deg), and far below (large
        // positive y) should point down (180deg).
        function arrowAngle() {
            const t = document.getElementById('recenter-canvas-arrow').style.transform;
            const i = t.indexOf('rotate(');
            if (i === -1) return null;
            return parseFloat(t.slice(i + 'rotate('.length, t.indexOf('deg', i)));
        }
        PaintApp.toggleAnchorCanvas(false);
        PaintApp.setTool('pencil');
        PaintApp.state.canvasOffset = { x: -100000, y: 0 };
        PaintApp.applyStageTransform();
        PaintApp.updateCanvasVisibilityButton();
        const angleLeft = arrowAngle();
        PaintApp.state.canvasOffset = { x: 0, y: 100000 };
        PaintApp.applyStageTransform();
        PaintApp.updateCanvasVisibilityButton();
        const angleDown = arrowAngle();

        // Seam-crossing check: park the canvas just left-of-straight-down,
        // then just right-of-straight-down — the raw atan2 angle jumps from
        // near -180 to near +180 (a ~360deg wrap), but the applied rotation
        // should take the short ~2-3deg path across the seam instead.
        // x is measured around whatever offset centers the stage horizontally
        // (~400 here) so dx actually crosses zero, not just its magnitude.
        PaintApp.state.canvasOffset = { x: 395, y: 100000 };
        PaintApp.applyStageTransform();
        PaintApp.updateCanvasVisibilityButton();
        const seamBefore = arrowAngle();
        PaintApp.state.canvasOffset = { x: 405, y: 100000 };
        PaintApp.applyStageTransform();
        PaintApp.updateCanvasVisibilityButton();
        const seamAfter = arrowAngle();

        return { hiddenAtCenter, shownWhenPannedAway, offsetAfterClick, hiddenAfterRecenter, hiddenWhileSwatchVisible, shownWhenBothGone, hiddenInAnchoredMode, angleLeft, angleDown, seamBefore, seamAfter };
    `);
    console.log('  ' + JSON.stringify(result, null, 1).replace(/\n/g, '\n  '));
    check('button hidden while canvas is centered', result.hiddenAtCenter);
    check('button shown once the canvas is panned entirely off screen', result.shownWhenPannedAway);
    check('clicking the button recenters the canvas', result.offsetAfterClick.x !== -100000 && result.offsetAfterClick.y !== -100000, JSON.stringify(result.offsetAfterClick));
    check('button hides again after recentering', result.hiddenAfterRecenter);
    check('crossing the seam takes the short path, not a ~360deg wrap',
        Math.abs(result.seamAfter - result.seamBefore) < 10, JSON.stringify({ seamBefore: result.seamBefore, seamAfter: result.seamAfter }));
    check('with the Palette Wand active, button stays hidden while the swatch canvas is still visible', result.hiddenWhileSwatchVisible);
    check('button shows once both the canvas and the swatch canvas are off screen', result.shownWhenBothGone);
    check('arrow points left (-90deg) when the canvas is off to the left', Math.abs(result.angleLeft - (-90)) < 1, result.angleLeft);
    check('arrow points down (180deg) when the canvas is off below', Math.abs(Math.abs(result.angleDown) - 180) < 1, result.angleDown);
    check('button never shows in Anchored mode', result.hiddenInAnchoredMode);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
