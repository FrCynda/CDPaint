/* Magic wand: the threshold-drag preview.
 *
 * Dragging the mouse after a wand click sweeps the tolerance, and the
 * marching ants are meant to follow. Three things used to go wrong on a
 * large canvas:
 *
 *   - every frame queued a job on the preview worker whether or not the
 *     previous one had finished, so a one-second drag left a backlog that
 *     ran for another nine seconds — during which the app looked frozen
 *     and the next wand click sat behind the leftovers;
 *   - the worker traced the whole canvas even though the ants overlay is
 *     clipped to the viewport, producing multi-megabyte path strings that
 *     were mostly thrown away;
 *   - mouse-up ran a flood fill that allocated four objects per pixel.
 *
 * What must NOT change is the selection itself. These tests check the
 * committed mask against a plain flood fill, and check that cropping the
 * preview to the viewport never drops anything inside it.
 */
import { withPage } from '../browser.mjs';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

await withPage(async (page) => {
    await page.run(`
        window.__w = {
            /* Smooth gradient plus fine noise: sweeping the tolerance over
             * this produces ragged, high-perimeter masks, which is the case
             * that used to fall over. */
            doc: (w, h) => {
                PaintApp.layerMgr.collapseToBase({ fresh: true });
                PaintApp.setSize(w, h);
                const c = PaintApp.ctx;
                const img = c.createImageData(w, h);
                const d = img.data;
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4;
                    const g = ((x * 255 / w) + (y * 255 / h)) / 2;
                    const n = ((x * 7919 + y * 104729) % 23);
                    const v = Math.max(0, Math.min(255, g + n - 11));
                    d[i] = v; d[i+1] = v; d[i+2] = 255 - v; d[i+3] = 255;
                }
                c.putImageData(img, 0, 0);
                PaintApp.state.history = []; PaintApp.state.step = -1;
                PaintApp.config.zoom = 1; PaintApp.updateBounds();
                PaintApp.saveState();
                PaintApp.config.tool = 'wand';
                PaintApp.config.wandMode = 'contiguous';
                PaintApp.config.wandTolerance = 0;
            },
            ev: (type, x, y, buttons, target) => {
                const b = PaintApp.bounds;
                (target || window).dispatchEvent(new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
                    isPrimary: true, buttons, button: 0,
                    clientX: b.left + x, clientY: b.top + y
                }));
            },
            frame: () => new Promise(r => requestAnimationFrame(() => r())),
            sleep: (ms) => new Promise(r => setTimeout(r, ms)),
            /* Straightforward flood fill over the raw pixels — the definition
             * of what the wand is supposed to select. */
            referenceMask: (w, h, sx, sy, tol) => {
                const d = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, w, h).data;
                const si = (sy * w + sx) * 4;
                const tr = d[si], tg = d[si+1], tb = d[si+2], ta = d[si+3];
                const mask = new Uint8Array(w * h);
                const stack = [sx, sy];
                while (stack.length) {
                    const y = stack.pop(), x = stack.pop();
                    if (x < 0 || y < 0 || x >= w || y >= h) continue;
                    const vi = y * w + x;
                    if (mask[vi]) continue;
                    const i = vi * 4;
                    if (Math.abs(d[i] - tr) > tol) continue;
                    if (Math.abs(d[i+1] - tg) > tol) continue;
                    if (Math.abs(d[i+2] - tb) > tol) continue;
                    if (Math.abs(d[i+3] - ta) > tol) continue;
                    mask[vi] = 1;
                    stack.push(x+1, y); stack.push(x-1, y);
                    stack.push(x, y+1); stack.push(x, y-1);
                }
                return mask;
            },
            /* The committed selection, as a full-canvas 0/1 mask. */
            selectionMask: (w, h) => {
                const s = PaintApp.state.selection;
                const out = new Uint8Array(w * h);
                if (!s || !s.mask) return out;
                const md = s.mask.getContext('2d').getImageData(0, 0, s.w, s.h).data;
                for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
                    if (md[(y * s.w + x) * 4 + 3] > 0) {
                        const cx = s.x + x, cy = s.y + y;
                        if (cx >= 0 && cy >= 0 && cx < w && cy < h) out[cy * w + cx] = 1;
                    }
                }
                return out;
            },
            countDiff: (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }
        };
        return true;
    `);

    console.log('== 1. the committed selection still matches a plain flood fill ==');
    {
        const r = await page.eval(`(async () => {
            const out = [];
            for (const tol of [0, 8, 25, 60]) {
                __w.doc(600, 600);
                PaintApp.config.wandTolerance = tol;
                __w.ev('pointerdown', 300, 300, 1, PaintApp.ui.stage);
                await __w.sleep(120);
                __w.ev('pointerup', 300, 300, 0);
                await __w.sleep(120);
                const want = __w.referenceMask(600, 600, 300, 300, tol);
                const got = __w.selectionMask(600, 600);
                let selected = 0; for (let i = 0; i < want.length; i++) selected += want[i];
                out.push({ tol, wrong: __w.countDiff(want, got), selected });
            }
            return out;
        })()`);
        for (const s of r) {
            check(`tolerance ${s.tol}: selection matches the reference exactly`,
                s.wrong === 0 && s.selected > 0,
                `${s.wrong} pixels differ, reference selected ${s.selected}`);
        }
    }

    console.log('\n== 2. cropping the preview to the viewport keeps everything inside it ==');
    {
        const r = await page.eval(`(() => {
            __w.doc(1200, 1200);
            // A ragged, fine-grained mask spilling well outside the crop —
            // the shape a wand actually produces part-way up the tolerance,
            // and the one whose perimeter used to blow the path up.
            const w = 1200, h = 1200;
            const mask = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
                if (((x * 7919 + y * 104729) % 23) < 11) mask[y * w + x] = 1;

            const full = PaintApp._maskToSvgPath(mask, w, h);
            const clip = { x: 100, y: 80, w: 400, h: 300, visible: true };
            const cropped = PaintApp._maskToSvgPath(mask, w, h, clip);

            // Every coordinate in the cropped path must lie in the crop box
            // (+1 because an edge on the far side of a pixel is at x+1).
            let outside = 0, pts = 0;
            for (const m of cropped.matchAll(/[ML](-?\\d+) (-?\\d+)/g)) {
                pts++;
                const px = +m[1], py = +m[2];
                if (px < clip.x || px > clip.x + clip.w + 1 ||
                    py < clip.y || py > clip.y + clip.h + 1) outside++;
            }

            // A mask that sits entirely inside the crop must be untouched by it.
            const small = new Uint8Array(w * h);
            for (let y = 150; y < 300; y++) for (let x = 160; x < 380; x++)
                if (((x * 7919 + y * 104729) % 23) < 11) small[y * w + x] = 1;
            const smallFull = PaintApp._maskToSvgPath(small, w, h);
            const smallCrop = PaintApp._maskToSvgPath(small, w, h, clip);

            const hidden = PaintApp._maskToSvgPath(mask, w, h, { x: 0, y: 0, w: 0, h: 0, visible: false });
            return {
                fullChars: full.length, croppedChars: cropped.length,
                pts, outside,
                smallIdentical: smallFull === smallCrop && smallFull.length > 100,
                hiddenEmpty: hidden === ''
            };
        })()`);
        check('cropping produces a much smaller path',
            r.croppedChars > 0 && r.croppedChars < r.fullChars / 4,
            `${(r.fullChars/1000).toFixed(0)}k -> ${(r.croppedChars/1000).toFixed(0)}k chars`);
        check('no part of the cropped path falls outside the crop box',
            r.outside === 0 && r.pts > 100, `${r.outside} of ${r.pts} points outside`);
        check('a selection wholly inside the viewport is traced identically',
            r.smallIdentical, 'cropping altered a path it should not have touched');
        check('an off-screen viewport produces no path at all', r.hiddenEmpty);
    }

    console.log('\n== 3. the ants actually redraw while the threshold is dragged ==');
    {
        const r = await page.eval(`(async () => {
            __w.doc(1500, 1500);
            __w.ev('pointerdown', 750, 750, 1, PaintApp.ui.stage);
            await __w.sleep(250);
            let redraws = 0, chars = 0;
            const orig = PaintApp._applyWandSvgPreview.bind(PaintApp);
            PaintApp._applyWandSvgPreview = (s) => { redraws++; chars = s ? s.length : chars; return orig(s); };
            const tols = [];
            for (let i = 0; i < 40; i++) {
                __w.ev('pointermove', 750 + i * 8, 750, 1);
                await __w.frame();
                tols.push(PaintApp.state.wandTol);
            }
            await __w.sleep(400);
            PaintApp._applyWandSvgPreview = orig;
            __w.ev('pointerup', 750 + 320, 750, 0);
            return { redraws, chars, tolMoved: tols[tols.length - 1] !== tols[0] };
        })()`);
        check('dragging really did sweep the tolerance', r.tolMoved);
        check('the ants were redrawn many times during the drag',
            r.redraws >= 10, `${r.redraws} redraws`);
        check('the redrawn path was non-empty', r.chars > 0, `${r.chars} chars`);
    }

    console.log('\n== 4. no backlog survives the drag ==');
    {
        const r = await page.eval(`(async () => {
            // Big enough that tracing one mask outlasts a frame — otherwise
            // the worker keeps up and there is no backlog to prevent. It does
            // not need to be huge; this suite runs alongside others that hold
            // very large canvases, and peak memory is shared.
            __w.doc(2000, 2000);
            __w.ev('pointerdown', 1000, 1000, 1, PaintApp.ui.stage);
            await __w.sleep(400);

            // Track how many jobs the worker owes an answer for at any moment.
            // That is the invariant the fix provides and the old code broke:
            // one at most, however far behind the worker falls.
            let sent = 0, answered = 0, maxOutstanding = 0, wanted = 0;
            const worker = PaintApp._wandPreviewWorker;
            const origPost = worker.postMessage.bind(worker);
            worker.postMessage = (m, t) => {
                if (m && m.type === 'update') {
                    sent++;
                    maxOutstanding = Math.max(maxOutstanding, sent - answered);
                }
                return origPost(m, t);
            };
            const origOnMessage = worker.onmessage;
            worker.onmessage = (ev) => { answered++; return origOnMessage(ev); };
            const origUpdate = PaintApp._postWandWorkerUpdate.bind(PaintApp);
            PaintApp._postWandWorkerUpdate = (tol, id) => { wanted++; return origUpdate(tol, id); };

            for (let i = 0; i < 50; i++) {
                __w.ev("pointermove", 1000 + i * 7, 1000, 1);
                await __w.frame();
            }
            PaintApp._postWandWorkerUpdate = origUpdate;
            __w.ev("pointerup", 1000 + 350, 1000, 0);
            worker.postMessage = origPost;
            worker.onmessage = origOnMessage;

            // With one job in flight at a time, the worker can only ever owe
            // one more answer. Time a fresh round trip: if a backlog were
            // still draining, this would sit behind all of it.
            const t0 = performance.now();
            await new Promise(res => {
                const h = (ev) => { worker.removeEventListener('message', h); res(); };
                worker.addEventListener('message', h);
                origPost({ type: 'update', jobId: -1, tolerance: 30 });
            });
            const roundTrip = performance.now() - t0;
            return { wanted, sent, maxOutstanding, roundTrip, pending: PaintApp._wandWorkerPending };
        })()`);
        console.log(`     (the drag asked for ${r.wanted} updates, ${r.sent} reached the worker, at most ${r.maxOutstanding} outstanding at once; a fresh round trip afterwards took ${r.roundTrip.toFixed(0)} ms)`);
        check('the drag really did ask for an update on most frames',
            r.wanted >= 20, `${r.wanted} requests`);
        check('the worker is never made to owe more than one answer',
            r.maxOutstanding <= 1, `${r.maxOutstanding} jobs queued at once — the backlog is back`);
        check('the worker answers promptly right after the drag ends',
            r.roundTrip < 1500, `${r.roundTrip.toFixed(0)} ms — a backlog is still draining`);
        check('nothing is left queued once the drag is over',
            r.pending === null || r.pending === undefined, JSON.stringify(r.pending));
    }

    console.log('\n== 5. the viewport crop follows the zoom ==');
    {
        /* The crop rectangle has to be in canvas pixels, but the one the SVG
         * clip uses is in screen pixels. They are the same thing at 100% and
         * nowhere else, so a crop that ignores the zoom shows the ants in a
         * corner when zoomed out and in the wrong place when zoomed in —
         * while looking perfect at 100%. */
        const r = await page.eval(`(async () => {
            __w.doc(3000, 3000);
            const w = 3000, h = 3000;
            // Fine pattern: boundary edges everywhere, so the traced path
            // covers exactly whatever region it was allowed to look at.
            const mask = new Uint8Array(w * h);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
                if (((x * 7919 + y * 104729) % 23) < 11) mask[y * w + x] = 1;

            const out = [];
            // Steps through the app's zoom list from 100%: 12.5, 25, 50, 100,
            // 200, 500 — plus two scrolled cases, since the crop's origin has
            // to follow the pan as well as the scale.
            for (const [steps, scroll] of [[-3, 0], [-2, 0], [-1, 0], [0, 0], [1, 0], [4, 0], [1, 500], [4, 1200]]) {
                // Drive the app's own zoom, not a shortcut.
                PaintApp.config.zoom = 1;
                document.documentElement.style.setProperty('--zoom', 1);
                document.documentElement.style.setProperty('--zoom-inv', '1');
                PaintApp.applyStageTransform();
                for (let i = 0; i < Math.abs(steps); i++) PaintApp.setZoom(steps > 0 ? 0.1 : -0.1);
                PaintApp.ui.viewport.scrollLeft = scroll;
                PaintApp.ui.viewport.scrollTop = scroll;
                PaintApp.ui.stage.getBoundingClientRect();     // flush layout
                const z = PaintApp.config.zoom;

                // What is genuinely on screen, in canvas pixels, worked out
                // from the boxes themselves rather than from the code under test.
                const st = PaintApp.ui.stage.getBoundingClientRect();
                const vp = PaintApp.ui.viewport.getBoundingClientRect();
                const l = Math.max(st.left, vp.left), t = Math.max(st.top, vp.top);
                const rr = Math.min(st.right, vp.right), b = Math.min(st.bottom, vp.bottom);
                if (rr <= l || b <= t) continue;
                const vis = { x: (l - st.left) / z, y: (t - st.top) / z,
                              w: (rr - l) / z, h: (b - t) / z };

                const crop = PaintApp._antsClipRectInCanvasPx();
                const covers = crop.x <= vis.x + 2 && crop.y <= vis.y + 2 &&
                               crop.x + crop.w >= vis.x + vis.w - 2 &&
                               crop.y + crop.h >= vis.y + vis.h - 2;
                const bloat = (crop.w * crop.h) / (vis.w * vis.h);

                // End to end: trace with that crop and see where the ants land.
                const path = PaintApp._maskToSvgPath(mask, w, h, crop);
                let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9, n = 0;
                for (const m of path.matchAll(/[ML](-?\\d+) (-?\\d+)/g)) {
                    n++;
                    const px = +m[1], py = +m[2];
                    if (px < minX) minX = px; if (px > maxX) maxX = px;
                    if (py < minY) minY = py; if (py > maxY) maxY = py;
                }
                // The visible area clamped to the canvas is what the ants
                // should span.
                const wantX0 = Math.max(0, vis.x), wantY0 = Math.max(0, vis.y);
                const wantX1 = Math.min(w, vis.x + vis.w), wantY1 = Math.min(h, vis.y + vis.h);
                const spanX = n ? (maxX - minX) : 0, spanY = n ? (maxY - minY) : 0;
                const coverX = spanX / (wantX1 - wantX0), coverY = spanY / (wantY1 - wantY0);

                out.push({
                    zoom: +z.toFixed(2), scroll, covers, bloat: +bloat.toFixed(2),
                    pts: n, coverX: +coverX.toFixed(2), coverY: +coverY.toFixed(2),
                    startsNear: n ? (minX <= wantX0 + 40 && minY <= wantY0 + 40) : false
                });
            }
            PaintApp.config.zoom = 1;
            document.documentElement.style.setProperty('--zoom', 1);
            PaintApp.applyStageTransform();
            PaintApp.updateBounds();
            return out;
        })()`);
        for (const s of r) {
            const tag = `zoom ${s.zoom}${s.scroll ? ' scrolled ' + s.scroll : ''}`;
            check(`${tag}: the crop covers everything on screen`,
                s.covers, `crop misses part of the visible canvas`);
            check(`${tag}: the crop is not wildly bigger than the screen`,
                s.bloat <= 4, `crop is ${s.bloat}x the visible area`);
            check(`${tag}: the ants actually span the visible area`,
                s.pts > 100 && s.coverX > 0.8 && s.coverY > 0.8 && s.startsNear,
                `${s.pts} points, spans ${s.coverX} x ${s.coverY} of the view, aligned=${s.startsNear}`);
        }
    }

    console.log('\n== 6. back-to-back wand selections stay correct ==');
    {
        const r = await page.eval(`(async () => {
            __w.doc(700, 700);
            const results = [];
            for (const [x, y, tol] of [[200, 200, 12], [500, 480, 30], [350, 120, 5]]) {
                PaintApp.config.wandTolerance = tol;
                __w.ev('pointerdown', x, y, 1, PaintApp.ui.stage);
                __w.ev('pointerup', x, y, 0);          // no pause between them
                await __w.sleep(60);
                const want = __w.referenceMask(700, 700, x, y, tol);
                const got = __w.selectionMask(700, 700);
                let sel = 0; for (let i = 0; i < want.length; i++) sel += want[i];
                results.push({ x, y, tol, wrong: __w.countDiff(want, got), sel });
            }
            return results;
        })()`);
        for (const s of r)
            check(`click at (${s.x},${s.y}) tol ${s.tol} selects the right pixels`,
                s.wrong === 0 && s.sel > 0, `${s.wrong} differ`);
    }

    console.log('\n== 7. the preview leaves the canvas untouched until pointer-up ==');
    {
        /* The click used to build the real floating selection straight away:
         * that lifts the matched pixels off the layer and fills the hole with
         * C2, then draws the lifted pixels onto cTemp so it looks unchanged.
         * The first preview frame clears cTemp before stamping the ants, which
         * uncovered the hole — the first clump the wand found appeared as a
         * solid C2-coloured blob for the whole drag, and only snapped back on
         * pointer-up. Nothing may touch the layer before the commit. */
        const r = await page.eval(`(async () => {
            // Land the selection the previous section left floating, before the
            // document is replaced: otherwise the click below commits it into
            // the fresh canvas and the layer changes for reasons of its own.
            PaintApp.commitSelection();
            __w.doc(400, 400);
            const w = 400, h = 400;
            const c = PaintApp.ctx;
            // A flat block under the click: at tolerance 0 this exact block is
            // the "first clump", so it is the region that used to be lifted.
            c.fillStyle = '#3366cc';
            c.fillRect(120, 120, 80, 80);
            PaintApp.saveState();
            PaintApp.config.c2 = '#ffff00';        // unmistakable if it leaks
            PaintApp.config.wandTolerance = 0;

            const px = (d, x, y) => {
                const i = (y * w + x) * 4;
                return [d[i], d[i+1], d[i+2], d[i+3]].join(',');
            };
            const before = new Uint8ClampedArray(c.getImageData(0, 0, w, h).data);

            __w.ev('pointerdown', 160, 160, 1, PaintApp.ui.stage);
            await __w.sleep(150);
            const downLayer = c.getImageData(0, 0, w, h).data;
            const downTemp  = PaintApp.ctxTemp.getImageData(0, 0, w, h).data;
            const antsAfterDown = PaintApp.ui.svgAntsPath.style.display === 'block' &&
                                  (PaintApp.ui.svgAntsPath.getAttribute('d') || '').length > 20;

            // Sweep the threshold, which is when the C2 blob was on screen.
            for (let i = 0; i < 12; i++) {
                __w.ev('pointermove', 160 + i * 6, 160, 1);
                await __w.frame();
            }
            await __w.sleep(200);
            const dragLayer = c.getImageData(0, 0, w, h).data;
            const dragTemp  = PaintApp.ctxTemp.getImageData(0, 0, w, h).data;
            const selDuringDrag = !!PaintApp.state.selection;

            __w.ev('pointerup', 160 + 66, 160, 0);
            await __w.sleep(200);
            const selAfterUp = !!PaintApp.state.selection;

            let tempInk = 0;
            for (let i = 3; i < downTemp.length; i += 4) if (downTemp[i] !== 0) tempInk++;
            for (let i = 3; i < dragTemp.length; i += 4) if (dragTemp[i] !== 0) tempInk++;

            return {
                downDiff: __w.countDiff(before, downLayer),
                dragDiff: __w.countDiff(before, dragLayer),
                clumpAfterDown: px(downLayer, 160, 160),
                clumpDuringDrag: px(dragLayer, 160, 160),
                tempInk, antsAfterDown, selDuringDrag, selAfterUp
            };
        })()`);
        check('the click does not alter the layer', r.downDiff === 0,
            `${r.downDiff} channel values changed; clicked pixel is now ${r.clumpAfterDown}`);
        check('the clicked clump keeps its own colour, not C2 (255,255,0)',
            r.clumpAfterDown === '51,102,204,255', `it is ${r.clumpAfterDown}`);
        check('the threshold drag does not alter the layer', r.dragDiff === 0,
            `${r.dragDiff} channel values changed; clicked pixel is now ${r.clumpDuringDrag}`);
        check('nothing is lifted onto the temp overlay during the preview',
            r.tempInk === 0, `${r.tempInk} opaque pixels on cTemp`);
        check('no selection exists until the pointer is released', !r.selDuringDrag);
        check('the ants preview still shows on the click itself', r.antsAfterDown);
        check('releasing the pointer does create the selection', r.selAfterUp);
    }

    const errs = page.errors();
    console.log(`\npage errors: ${errs.length}`);
    for (const e of errs.slice(0, 6)) console.log('  ! ' + e.text.split('\n')[0]);
    console.log(`\n${pass} passed, ${fail} failed`);
});

process.exit(fail ? 1 : 0);
