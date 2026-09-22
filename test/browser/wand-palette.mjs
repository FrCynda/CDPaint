/* Palette Wand: a wand variant whose icon is the regular wand, hue-shifted,
 * and whose selections behave exactly like a normal wand's — same flood
 * fill, same undo/redo, same drag-to-adjust-threshold — except for what
 * happens on cut: instead of just leaving a hole, the cut region is
 * flattened to its own average colour (keeping its selection shape, not a
 * bounding box) and stamped onto a separate, non-interactive swatch canvas
 * at the exact coordinates it had on the main canvas.
 *
 * Selecting with the Palette Wand tags the selection `source: 'wand-palette'`
 * (instead of plain 'wand'), which every existing wand-selection code path
 * (undo snapshotting, noHandles, selectionJustCreated, the deferred-cut
 * collapse guard) treats identically to 'wand' — the only place that branches
 * on it is deleteSelection(), which is where the swatch-canvas paste happens.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    console.log('== Palette Wand: select, cut, flatten to the swatch canvas ==');
    const result = await page.run(`
        PaintApp.config.width = 40; PaintApp.config.height = 20;
        const ctx = PaintApp.ctx;
        const imgData = ctx.createImageData(40, 20);
        const d = imgData.data;
        for (let y = 0; y < 20; y++) {
            for (let x = 0; x < 40; x++) {
                const i = (y*40+x)*4;
                if (x >= 10 && x < 30 && y >= 5 && y < 15) {
                    d[i] = 200 + (x % 2 ? 10 : -10); d[i+1] = 20; d[i+2] = 20; d[i+3] = 255;
                } else {
                    d[i] = 255; d[i+1] = 255; d[i+2] = 255; d[i+3] = 255;
                }
            }
        }
        ctx.putImageData(imgData, 0, 0);
        PaintApp.saveState();

        const item = PaintApp.getToolManifestItem('wand-palette');
        PaintApp._activateToolFromGrid(item);
        const toolAfterActivate = PaintApp.config.tool;
        const flavorAfterActivate = PaintApp.config.wandFlavor;

        PaintApp.config.wandMode = 'contiguous'; PaintApp.config.wandTolerance = 30;
        PaintApp.magicWandSelect(15, 8, 30, 'replace', null, true);
        const selSource = PaintApp.state.selection && PaintApp.state.selection.source;

        return PaintApp.execCut().then(() => {
            const selAfterCut = PaintApp.state.selection;
            const swatchPixel = Array.from(PaintApp.ui.swatchCanvas.getContext('2d').getImageData(15, 8, 1, 1).data);
            const swatchOutsidePixel = Array.from(PaintApp.ui.swatchCanvas.getContext('2d').getImageData(2, 2, 1, 1).data);
            const mainPixelAfterCut = Array.from(ctx.getImageData(15, 8, 1, 1).data);

            PaintApp.undo();
            const selAfterUndo = PaintApp.state.selection ? { source: PaintApp.state.selection.source, x: PaintApp.state.selection.x } : null;

            PaintApp.setTool('wand');
            const flavorAfterPlainWand = PaintApp.config.wandFlavor;

            return {
                toolAfterActivate, flavorAfterActivate, selSource,
                selAfterCutIsNull: selAfterCut === null,
                swatchPixel, swatchOutsidePixel, mainPixelAfterCut,
                selAfterUndo, flavorAfterPlainWand
            };
        });
    `);
    console.log('  ' + JSON.stringify(result, null, 1).replace(/\n/g, '\n  '));

    check('activating the Palette Wand sets tool to wand', result.toolAfterActivate === 'wand', result.toolAfterActivate);
    check('activating the Palette Wand sets the palette flavor', result.flavorAfterActivate === 'palette', result.flavorAfterActivate);
    check('the selection is tagged wand-palette', result.selSource === 'wand-palette', result.selSource);
    check('cut clears the floating selection as usual', result.selAfterCutIsNull);
    check('the swatch canvas got a flattened, opaque pixel at the same coords', result.swatchPixel[3] === 255, JSON.stringify(result.swatchPixel));
    check('the flattened colour is a single average, not a raw sampled pixel',
        result.swatchPixel[0] === 200 && result.swatchPixel[1] === 20 && result.swatchPixel[2] === 20,
        JSON.stringify(result.swatchPixel));
    check('the swatch canvas outside the selection stays empty', result.swatchOutsidePixel[3] === 0, JSON.stringify(result.swatchOutsidePixel));
    check('the main canvas still gets a normal cut hole', result.mainPixelAfterCut[0] !== 200, JSON.stringify(result.mainPixelAfterCut));
    check('undo after the cut restores the wand-palette selection (same fix as plain wand cuts)',
        result.selAfterUndo && result.selAfterUndo.source === 'wand-palette', JSON.stringify(result.selAfterUndo));
    check('switching to the plain wand resets the flavor', result.flavorAfterPlainWand === 'normal', result.flavorAfterPlainWand);
});

console.log('\n== swatch canvas geometry: 1:1 with the main canvas, anchored 100px away, zoom applies to both ==');
await withPage(async (page) => {
    const geo = await page.run(`
        PaintApp.setSize(80, 50);
        // The swatch canvas is only shown while the Palette Wand is the
        // active tool, so it has to be activated before measuring it.
        PaintApp._activateToolFromGrid(PaintApp.getToolManifestItem('wand-palette'));
        PaintApp.config.zoom = 1;
        PaintApp.applyStageTransform();
        const br = id => document.getElementById(id).getBoundingClientRect();
        const main1 = br('layer-main'), swatch1 = br('swatch-canvas'), panel1 = br('swatch-panel');

        PaintApp.config.zoom = 2;
        PaintApp.applyStageTransform();
        const main2 = br('layer-main'), swatch2 = br('swatch-canvas');

        const resizeHandles = [...document.querySelectorAll('#canvas-resize-handles .resizer')]
            .map(el => el.getBoundingClientRect());
        const swatchOverlapsAnyHandle = resizeHandles.some(h =>
            h.left < swatch1.right && h.right > swatch1.left && h.top < swatch1.bottom && h.bottom > swatch1.top);

        const visibleWhilePaletteWandActive = getComputedStyle(document.getElementById('swatch-canvas')).display !== 'none';
        const panelVisibleWhilePaletteWandActive = getComputedStyle(document.getElementById('swatch-panel')).display !== 'none';
        PaintApp.setTool('pencil');
        const hiddenAfterSwitchingAway = getComputedStyle(document.getElementById('swatch-canvas')).display === 'none';
        const panelHiddenAfterSwitchingAway = getComputedStyle(document.getElementById('swatch-panel')).display === 'none';

        return JSON.stringify({
            gapAtZoom1: swatch1.left - main1.right,
            sameSizeAtZoom1: swatch1.width === main1.width && swatch1.height === main1.height,
            gapAtZoom2: swatch2.left - main2.right,
            sameSizeAtZoom2: swatch2.width === main2.width && swatch2.height === main2.height,
            swatchPointerEvents: getComputedStyle(document.getElementById('swatch-canvas')).pointerEvents,
            swatchOverlapsAnyHandle,
            visibleWhilePaletteWandActive,
            hiddenAfterSwitchingAway,
            panelVisibleWhilePaletteWandActive,
            panelHiddenAfterSwitchingAway,
            panelAboveCanvas: panel1.bottom <= swatch1.top,
            panelSharesLeftEdge: Math.abs(panel1.left - swatch1.left) < 1
        });
    `);
    const g = JSON.parse(geo);
    console.log('  ' + JSON.stringify(g, null, 1).replace(/\n/g, '\n  '));
    check('at zoom 1, the swatch canvas is anchored exactly 100px past the main canvas', g.gapAtZoom1 === 100, g.gapAtZoom1);
    check('at zoom 1, the swatch canvas is the same size as the main canvas', g.sameSizeAtZoom1);
    check('at zoom 2, the gap scales with zoom (100px * 2)', g.gapAtZoom2 === 200, g.gapAtZoom2);
    check('at zoom 2, the swatch canvas still matches the main canvas size 1:1', g.sameSizeAtZoom2);
    check('the swatch canvas is not a pointer target', g.swatchPointerEvents === 'none', g.swatchPointerEvents);
    check('the swatch canvas has no resize handles around it', !g.swatchOverlapsAnyHandle);
    check('the swatch canvas is visible while the Palette Wand is active', g.visibleWhilePaletteWandActive);
    check('the swatch canvas hides again after switching to another tool', g.hiddenAfterSwitchingAway);
    check('the copy panel is visible while the Palette Wand is active', g.panelVisibleWhilePaletteWandActive);
    check('the copy panel hides again after switching to another tool', g.panelHiddenAfterSwitchingAway);
    check('the copy panel sits above the swatch canvas', g.panelAboveCanvas);
    check('the copy panel shares the swatch canvas\'s left edge', g.panelSharesLeftEdge);
});

console.log('\n== Palette Wand (Global): the same tool, in global-flood mode ==');
await withPage(async (page) => {
    const result = await page.run(`
        PaintApp.config.width = 40; PaintApp.config.height = 20;
        const ctx = PaintApp.ctx;
        const imgData = ctx.createImageData(40, 20);
        const d = imgData.data;
        for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
            const i = (y*40+x)*4;
            if (x >= 10 && x < 30 && y >= 5 && y < 15) { d[i]=200; d[i+1]=20; d[i+2]=20; d[i+3]=255; }
            else { d[i]=255; d[i+1]=255; d[i+2]=255; d[i+3]=255; }
        }
        ctx.putImageData(imgData, 0, 0);
        PaintApp.saveState();

        const item = PaintApp.getToolManifestItem('wand-palette-global');
        PaintApp._activateToolFromGrid(item);
        const toolAfter = PaintApp.config.tool, flavorAfter = PaintApp.config.wandFlavor, modeAfter = PaintApp.config.wandMode;

        PaintApp.config.wandTolerance = 30;
        PaintApp.magicWandSelect(15, 8, 30, 'replace', null, true);
        const selSource = PaintApp.state.selection && PaintApp.state.selection.source;

        return PaintApp.execCut().then(() => {
            const swatchPixel = Array.from(PaintApp.ui.swatchCanvas.getContext('2d').getImageData(15, 8, 1, 1).data);
            return { toolAfter, flavorAfter, modeAfter, selSource, swatchPixel };
        });
    `);
    console.log('  ' + JSON.stringify(result, null, 1).replace(/\n/g, '\n  '));
    check('activating wand-palette-global sets tool=wand, flavor=palette, mode=global',
        result.toolAfter === 'wand' && result.flavorAfter === 'palette' && result.modeAfter === 'global', JSON.stringify(result));
    check('the selection is still tagged wand-palette (same as the contiguous variant)', result.selSource === 'wand-palette', result.selSource);
    check('cut flattens onto the swatch canvas exactly like the contiguous Palette Wand',
        result.swatchPixel[0] === 200 && result.swatchPixel[1] === 20 && result.swatchPixel[2] === 20 && result.swatchPixel[3] === 255,
        JSON.stringify(result.swatchPixel));
});

console.log('\n== toolbar highlight: wand and the merged wand-palette button stay mutually exclusive ==');
await withPage(async (page) => {
    const result = await page.run(`
        function active(id) {
            const b = document.querySelector('.tool-grid-slot[data-tool-id="' + id + '"]');
            return b ? b.classList.contains('active') : null;
        }
        function click(id) { document.querySelector('.tool-grid-slot[data-tool-id="' + id + '"]').click(); }
        function snapshot() { return { wand: active('wand'), palette: active('wand-palette') }; }

        click('wand');       const afterWand = snapshot();
        click('wand-palette'); const afterPalette = snapshot();
        click('wand');       const afterBackToWand = snapshot();
        return { afterWand, afterPalette, afterBackToWand };
    `);
    console.log('  ' + JSON.stringify(result, null, 1).replace(/\n/g, '\n  '));
    const onlyOne = (s) => Object.values(s).filter(Boolean).length === 1;
    check('only the wand button lights up after clicking it', onlyOne(result.afterWand) && result.afterWand.wand, JSON.stringify(result.afterWand));
    check('only the wand-palette button lights up after clicking it', onlyOne(result.afterPalette) && result.afterPalette.palette, JSON.stringify(result.afterPalette));
    check('clicking plain wand again lights up only the wand button', onlyOne(result.afterBackToWand) && result.afterBackToWand.wand, JSON.stringify(result.afterBackToWand));
});

console.log('\n== wand-palette is a single merged button: left-click activates without forcing mode, right-click cycles mode, icon swaps, and its mode is independent of plain wand\'s ==');
await withPage(async (page) => {
    const result = await page.run(`
        function iconState(id) {
            const slot = document.querySelector('.tool-grid-slot[data-tool-id="' + id + '"]');
            const contig = slot.querySelector('.wand-icon-contig');
            const global = slot.querySelector('.wand-icon-global');
            return { contigShown: contig.classList.contains('show'), globalShown: global.classList.contains('show') };
        }
        function rightClick(id) {
            const slot = document.querySelector('.tool-grid-slot[data-tool-id="' + id + '"]');
            slot.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        }
        function state(id) {
            return {
                tool: PaintApp.config.tool, flavor: PaintApp.config.wandFlavor, mode: PaintApp.config.wandMode,
                icon: iconState(id)
            };
        }

        // Put plain wand into global mode, then left-click the merged palette
        // button (never touched before) — its own remembered mode
        // (contiguous, the default) must apply, NOT plain wand's global mode.
        PaintApp.setTool('wand');
        PaintApp.setWandMode('global');
        document.querySelector('.tool-grid-slot[data-tool-id="wand-palette"]').click();
        const afterLeftClick = state('wand-palette');

        // Right-click cycles the palette button's OWN mode, staying on
        // palette flavor and leaving plain wand's mode untouched.
        rightClick('wand-palette');
        const afterRightClick1 = state('wand-palette');
        rightClick('wand-palette');
        const afterRightClick2 = state('wand-palette');

        // Switching back to plain wand must still show ITS mode (global),
        // unaffected by everything just done to the palette button.
        document.querySelector('.tool-grid-slot[data-tool-id="wand"]').click();
        const backToWand = state('wand');

        return { afterLeftClick, afterRightClick1, afterRightClick2, backToWand };
    `);
    console.log('  ' + JSON.stringify(result, null, 1).replace(/\n/g, '\n  '));
    check('left-click activates palette flavor using its OWN mode (contiguous default), not plain wand\'s global mode',
        result.afterLeftClick.tool === 'wand' && result.afterLeftClick.flavor === 'palette' && result.afterLeftClick.mode === 'contiguous',
        JSON.stringify(result.afterLeftClick));
    check('icon reflects contiguous mode right after left-click',
        result.afterLeftClick.icon.contigShown && !result.afterLeftClick.icon.globalShown, JSON.stringify(result.afterLeftClick.icon));
    check('right-click cycles contiguous -> global, staying on palette flavor',
        result.afterRightClick1.mode === 'global' && result.afterRightClick1.flavor === 'palette', JSON.stringify(result.afterRightClick1));
    check('icon swaps to global after the first right-click',
        result.afterRightClick1.icon.globalShown && !result.afterRightClick1.icon.contigShown, JSON.stringify(result.afterRightClick1.icon));
    check('right-click cycles global -> contiguous again',
        result.afterRightClick2.mode === 'contiguous' && result.afterRightClick2.flavor === 'palette', JSON.stringify(result.afterRightClick2));
    check('switching back to plain wand still shows its own mode (global), untouched by the palette button\'s right-clicks',
        result.backToWand.tool === 'wand' && result.backToWand.flavor === 'normal' && result.backToWand.mode === 'global', JSON.stringify(result.backToWand));
    check('icon swaps back to contiguous after the second right-click',
        result.afterRightClick2.icon.contigShown && !result.afterRightClick2.icon.globalShown, JSON.stringify(result.afterRightClick2.icon));
});

console.log('\n== wand and wand-palette show DIFFERENT icons at the same time when their modes differ ==');
await withPage(async (page) => {
    const result = await page.run(`
        function iconState(id) {
            const slot = document.querySelector('.tool-grid-slot[data-tool-id="' + id + '"]');
            const contig = slot.querySelector('.wand-icon-contig');
            const global = slot.querySelector('.wand-icon-global');
            return { contigShown: contig.classList.contains('show'), globalShown: global.classList.contains('show') };
        }
        function rightClick(id) {
            document.querySelector('.tool-grid-slot[data-tool-id="' + id + '"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        }

        // Reset both to a known state, then diverge them: wand -> global,
        // wand-palette stays contiguous.
        document.querySelector('.tool-grid-slot[data-tool-id="wand"]').click();
        PaintApp.setWandMode('contiguous', 'normal');
        document.querySelector('.tool-grid-slot[data-tool-id="wand-palette"]').click();
        PaintApp.setWandMode('contiguous', 'palette');
        rightClick('wand'); // wand -> global; palette untouched

        return { wand: iconState('wand'), palette: iconState('wand-palette') };
    `);
    console.log('  ' + JSON.stringify(result, null, 1).replace(/\n/g, '\n  '));
    check('the plain wand slot shows the global icon', result.wand.globalShown && !result.wand.contigShown, JSON.stringify(result.wand));
    check('the palette wand slot still shows the contiguous icon, independently', result.palette.contigShown && !result.palette.globalShown, JSON.stringify(result.palette));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
