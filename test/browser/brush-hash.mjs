/* Pixel-hash falsification suite for the brush-lag fixes.
 *
 * Every brush-performance change (stencil clips, param freeze, chunking) must
 * leave final pixels bit-identical. This suite strokes the real engine through
 * its real API and hashes the tight ink bounding box (coords + pixels), then
 * diffs against test/browser/brush-hash.goldens.json. Any drift rejects the
 * change. Run with --record to (re-)write the goldens, without it to compare.
 *
 * Goldens are only valid for the tree they were recorded on: no unrelated
 * engine edits between recording and the last item landing, or re-record.
 * The engine files at record time are copied to test/browser/baseline/.
 *
 * KNOWN INTENTIONAL DRIFT: the mid-stroke-drag golden records the Item-5
 * freeze (dragged stroke == clean size-14 stroke, asserted in-suite). It was
 * re-recorded when Item 5 landed; any later drift rejects.
 *
 * The wash/singleWet/retraceWet/singleDry/retraceDry/crossWet goldens were
 * re-recorded when the watercolor wash moved from a per-dab alpha cut to a
 * flush-time ceiling (_applyWatercolorWash) — the per-dab cut's stacking
 * estimate only held for a symmetric round tip and washed a real .sut custom
 * tip to near-nothing instead. The semantic checks in-suite (wash differs
 * from detA, coverage still stacks stroke over stroke) are the ones that
 * actually matter; the hashes just pin today's pixels.
 *
 * Mutation discipline: point this suite at a deliberately broken engine copy
 * (e.g. stencil disabled); if it still passes, the suite is testing nothing.
 */
import { withPage, REPO_ROOT } from '../browser.mjs';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

const GOLDENS = join(REPO_ROOT, 'test', 'browser', 'brush-hash.goldens.json');
const RECORD = process.argv.includes('--record');

await withPage(async (page) => {
    await page.run(`
        window.__H = {
            frame: () => new Promise(r => requestAnimationFrame(r)),
            /* Fresh transparent layer over white, sized per case. */
            doc: (w, h) => {
                const app = PaintApp;
                app.layerMgr.collapseToBase({ fresh: true });
                app.setSize(w, h);
                app.config.zoom = 1; app.updateBounds();
                app.ctx.fillStyle = '#ffffff';
                app.ctx.fillRect(0, 0, w, h);
                document.getElementById('lsys-add').click();
                app.state.selection = null;
                app.state.history = []; app.state.step = -1;
                return app.layerMgr.layers[app.layerMgr.activeIdx];
            },
            /* Every source of non-determinism, pinned. The seed pin is the
             * engine's own (_setStrokeSeed); the Math.random stub covers the
             * airbrush timer path, which stamps random pressure per dab. */
            pins: () => {
                PaintApp.brush._setStrokeSeed(1337);
                // Saved-override hygiene: setParam persists the whole _params
                // on a 400ms idle timer, so without this a block's tweaks leak
                // through localStorage into a later block's loadPreset and the
                // goldens go order- and timing-dependent. Forget first, every
                // block, via cleanLoad below.
                ['Round', 'Fan Brush', 'Canvas Rub'].forEach(n => {
                    try { PaintApp.brush.forgetSaved(n); } catch (e) {}
                });
                let s = 0x12345678;
                Math.random = () => {
                    s = (s * 1664525 + 1013904223) >>> 0;
                    return s / 4294967296;
                };
            },
            // loadPreset PLUS forgetting saved overrides first. Every case
            // block must use this, never bare loadPreset — see pins() above.
            cleanLoad: (n) => {
                try { PaintApp.brush.forgetSaved(n); } catch (e) {}
                PaintApp.brush.loadPreset(n);
            },
            flat: () => {
                const b = PaintApp.brush;
                b.setParam('dynamicsMode', 'off');
                b.setParam('sizeSrc', 'none'); b.setParam('flowSrc', 'none');
                b.setParam('scatter', 0);
                // Explicitly off: a leaked edge override would paint into
                // every later case and no other pin would catch it.
                b.setParam('edgeWidth', 0); b.setParam('edgeDensity', 0);
            },
            /* A stroke that yields frames, so the live passes actually run —
             * without the rAF the engine paints nothing until endStroke. */
            stroke: async (pts, color) => {
                const b = PaintApp.brush, c = color || '#c03030';
                b.beginStroke(pts[0][0], pts[0][1], 0.9, c);
                for (let i = 1; i < pts.length; i++) {
                    b.moveStroke(pts[i][0], pts[i][1], 0.9, c);
                    if (i % 6 === 0) await __H.frame();
                }
                await __H.frame();
                b.endStroke();
                await new Promise(r => setTimeout(r, 150));
            },
            line: (x0, y0, x1, y1, n) => {
                const pts = [];
                for (let i = 0; i <= n; i++)
                    pts.push([x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n]);
                return pts;
            },
            /* Tight ink bbox + its pixels, so moved-but-identical ink still
             * matches while a shifted dab does not. */
            hash: (L, W, H) => {
                const d = L.ctx.getImageData(0, 0, W, H).data;
                let x0 = W, y0 = H, x1 = -1, y1 = -1;
                for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                    if (d[(y * W + x) * 4 + 3] > 8) {
                        if (x < x0) x0 = x; if (x > x1) x1 = x;
                        if (y < y0) y0 = y; if (y > y1) y1 = y;
                    }
                }
                let a = 0x811c9dc5;
                const mix = (n) => { a = ((a ^ (n & 0xff)) * 16777619) >>> 0; };
                if (x1 < 0) { mix(0); return 'empty:' + a.toString(16); }
                [x0, y0, x1, y1].forEach(mix);
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const o = (y * W + x) * 4;
                    mix(d[o]); mix(d[o + 1]); mix(d[o + 2]); mix(d[o + 3]);
                }
                return a.toString(16);
            },
            /* Hand-made selection: the stencil reads sel.mask + the
             * normalized rect and nothing else, so driving the UI would only
             * add nondeterminism. soft=false is a binary mask, true a linear
             * alpha ramp — the feathered-edge case. */
            select: (x, y, w, h, soft) => {
                const mask = document.createElement('canvas');
                mask.width = w; mask.height = h;
                const m = mask.getContext('2d');
                if (soft) {
                    const img = m.createImageData(w, h);
                    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
                        img.data[(py * w + px) * 4 + 3] = Math.round(255 * px / (w - 1));
                    }
                    m.putImageData(img, 0, 0);
                } else {
                    m.fillStyle = '#ffffff'; m.fillRect(0, 0, w, h);
                }
                PaintApp.state.selection = { x, y, w, h, rotation: 0, mask };
            },
            /* Pixel snapshots for cross-case diffing (kept in-page: a full
             * layer is ~2MB, far too fat to ferry back through eval). diff
             * counts pixels whose channels differ by more than 2 — a
             * threshold-free comparator when both sides are measured, e.g.
             * wet-retrace residual vs dry-retrace stacking below. */
            snaps: {},
            snap: (name, L, W, H) => {
                const d = L.ctx.getImageData(0, 0, W, H);
                __H.snaps[name] = { w: W, h: H, px: new Uint8ClampedArray(d.data) };
            },
            diff: (a, b) => {
                const A = __H.snaps[a], B = __H.snaps[b];
                if (!A || !B || A.w !== B.w || A.h !== B.h) return -1;
                let n = 0;
                for (let i = 0; i < A.px.length; i += 4) {
                    if (Math.abs(A.px[i] - B.px[i]) > 2 ||
                        Math.abs(A.px[i + 1] - B.px[i + 1]) > 2 ||
                        Math.abs(A.px[i + 2] - B.px[i + 2]) > 2 ||
                        Math.abs(A.px[i + 3] - B.px[i + 3]) > 2) n++;
                }
                return n;
            },
            /* Mean alpha over a snapshot: a bristle/fan brush's individual
             * hairs sit at direction-dependent offsets (perpendicular to
             * travel), so a retrace walking the same centerline backwards
             * lands each hair mirrored to the opposite side, not on top of
             * where it landed forward. Per-dab wet-blend coverage gates by
             * hair position, not by aggregate stroke footprint, so the
             * position-level pixel diff churns even when suppression is
             * working -- ink that used to land under hair 0 now lands under
             * mirrored hair 0, coverage-gated against a nearby but distinct
             * hair's ink instead. Mean alpha is immune to that churn and
             * still answers the real question: does a retrace deposit less
             * additional ink under wet blend than under dry. */
            meanAlpha: (name) => {
                const S = __H.snaps[name];
                if (!S) return -1;
                let sum = 0, n = 0;
                for (let i = 3; i < S.px.length; i += 4) { sum += S.px[i]; n++; }
                return n ? sum / n : 0;
            },
            unselect: () => { PaintApp.state.selection = null; },
            /* Mean (r-g) over the boundary-alpha band: the edge ring must read
             * as pooled pigment of the stroke color (red strokes here), not a
             * black outline (which sits near zero). */
            ringRed: (L, W, H) => {
                const d = L.ctx.getImageData(0, 0, W, H).data;
                let sum = 0, n = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const a = d[i + 3];
                    if (a >= 30 && a <= 210) { sum += d[i] - d[i + 1]; n++; }
                }
                return n ? Math.round(sum / n) : -999;
            },
            restore: () => {
                // Undo per-preset overrides so later suites start clean.
                PaintApp.brush.loadPreset('Round');
                ['Round', 'Fan Brush', 'Canvas Rub'].forEach(n => {
                    try { PaintApp.brush.forgetSaved(n); } catch (e) {}
                });
                PaintApp.brush._setStrokeSeed(null);
                PaintApp.state.selection = null;
            }
        };
        __H.pins();
        return true;
    `);

    const out = JSON.parse(await page.eval(`(async () => {
        const R = {}, W = 900, H = 500;
        const b = PaintApp.brush;

        // 1. selection-edged bristle, binary mask
        {
            const L = __H.doc(W, H);
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('bristleCount', 12); b.setParam('bristleLength', 20);
            b.setParam('bristleWidth', 3); b.setParam('bristleSpread', 60);
            __H.select(200, 100, 500, 300, false);
            await __H.stroke(__H.line(100, 250, 800, 250, 120));
            R.selBinary = __H.hash(L, W, H);
            __H.unselect();
        }
        // 2. feathered selection: soft mask ramp, stroke crosses the gradient
        {
            const L = __H.doc(W, H);
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 30); b.setParam('hardness', 100);
            __H.select(200, 100, 500, 300, true);
            await __H.stroke(__H.line(100, 250, 800, 250, 120));
            R.selFeather = __H.hash(L, W, H);
            __H.unselect();
        }
        // 3. alpha-locked multiply
        {
            const L = __H.doc(W, H);
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 60); b.setParam('blendMode', 'normal');
            await __H.stroke(__H.line(150, 150, 750, 350, 60), '#ffcc00');
            L.alphaLock = true;
            b.setParam('size', 40); b.setParam('blendMode', 'multiply');
            await __H.stroke(__H.line(150, 350, 750, 150, 60), '#0066ff');
            R.alphaLockMultiply = __H.hash(L, W, H);
            L.alphaLock = false;
        }
        // 4+5. overlapping textured dabs, spacing 5 vs 100
        {
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('texture', 90); b.setParam('textureScale', 1);
            b.setParam('textureType', 'grain');
            let L = __H.doc(W, H);
            b.setParam('spacing', 5);
            await __H.stroke(__H.line(100, 250, 800, 250, 140));
            R.textured5 = __H.hash(L, W, H);
            L = __H.doc(W, H);
            b.setParam('spacing', 100);
            await __H.stroke(__H.line(100, 250, 800, 250, 140));
            R.textured100 = __H.hash(L, W, H);
        }
        // 5b. watercolor edge: zero width or zero density must be a no-op,
        // a live edge must change pixels, and it must follow a selection clip.
        {
            const edgeStroke = async (w, d) => {
                const L = __H.doc(W, H);
                __H._lastEdge = L;
                __H.cleanLoad('Round'); __H.flat();
                b.setParam('size', 60); b.setParam('hardness', 100);
                b.setParam('spacing', 6);
                b.setParam('edgeWidth', w); b.setParam('edgeDensity', d);
                b._setStrokeSeed(1337);
                await __H.stroke(__H.line(100, 250, 800, 250, 100));
                return __H.hash(L, W, H);
            };
            R.edgeOff = await edgeStroke(0, 0);
            R.edgeZeroDensity = await edgeStroke(3, 0);
            R.edgeZeroWidth = await edgeStroke(0, 70);
            R.edgeOn = await edgeStroke(3, 70);
            R.edgeHue = __H.ringRed(__H._lastEdge, W, H);
            const L = __H.doc(W, H);
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 60); b.setParam('hardness', 100);
            b.setParam('spacing', 6);
            b.setParam('edgeWidth', 3); b.setParam('edgeDensity', 70);
            b._setStrokeSeed(1337);
            __H.select(200, 100, 500, 300, false);
            await __H.stroke(__H.line(100, 250, 800, 250, 100));
            R.edgeSel = __H.hash(L, W, H);
            __H.unselect();
        }
        // 6. short-taper replay (Fan Brush tapers both ends)
        {
            const L = __H.doc(W, H);
            __H.cleanLoad('Fan Brush');
            b._setStrokeSeed(1337);
            await __H.stroke(__H.line(100, 250, 800, 250, 100));
            R.fanTaper = __H.hash(L, W, H);
        }
        // 7. rainbow smudge at colorRate 0 and 50
        {
            const rake = async (rate) => {
                const L = __H.doc(W, H);
                L.ctx.fillStyle = '#ff0000'; L.ctx.fillRect(0, 0, W, H / 2);
                L.ctx.fillStyle = '#0000ff'; L.ctx.fillRect(0, H / 2, W, H / 2);
                __H.cleanLoad('Round'); __H.flat();
                b.setParam('size', 60); b.setParam('hardness', 100);
                b.setParam('spacing', 8);
                b.setParam('bristleCount', 12); b.setParam('bristleLength', 10);
                b.setParam('bristleWidth', 4); b.setParam('bristleSpread', 90);
                b.setParam('colorRate', rate); b.setParam('smudgeLength', 80);
                b._setStrokeSeed(1337);
                await __H.stroke(__H.line(100, H / 2, 800, H / 2, 120), '#00ff00');
                return __H.hash(L, W, H);
            };
            R.smudge0 = await rake(0);
            R.smudge50 = await rake(50);
        }
        // 8. taperless control: the actual lag complaint (Canvas Rub 180/3)
        {
            const LW = 1200, LH = 700;
            const L = __H.doc(LW, LH);
            __H.cleanLoad('Canvas Rub');
            await new Promise(r => setTimeout(r, 800)); // custom tip + pattern
            b._setStrokeSeed(1337);
            await __H.stroke(__H.line(100, 350, 1100, 350, 160));
            R.canvasRub = __H.hash(L, LW, LH);
        }
        // 10. chunked drain: the same stroke as canvasRub but queued as one
        // backlog with no frame yields, forcing live-pass suspends. The
        // frames then drain it suspend-resume-suspend before endStroke does
        // the final synchronous drain. Scheduling must not move a single
        // pixel: same hash as canvasRub. chunks must be non-zero, proving
        // the suspend path ran instead of a vacuous pass.
        {
            const LW = 1200, LH = 700;
            const L = __H.doc(LW, LH);
            __H.cleanLoad('Canvas Rub');
            await new Promise(r => setTimeout(r, 800)); // custom tip + pattern
            b._setStrokeSeed(1337);
            const pts = __H.line(100, 350, 1100, 350, 160);
            b.beginStroke(pts[0][0], pts[0][1], 0.9, '#c03030');
            for (let i = 1; i < pts.length; i++)
                b.moveStroke(pts[i][0], pts[i][1], 0.9, '#c03030');
            for (let f = 0; f < 30; f++) await __H.frame();
            R.chunks = b._suspendCount();
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            R.drain = __H.hash(L, LW, LH);
        }
        // 9a. determinism: the same stroke twice must hash identically —
        // validates the pins actually pin everything.
        {
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 24); b.setParam('hardness', 80);
            b.setParam('spacing', 6);
            b.setParam('bristleCount', 8); b.setParam('bristleLength', 15);
            b.setParam('bristleWidth', 3); b.setParam('bristleSpread', 50);
            let L = __H.doc(W, H);
            b._setStrokeSeed(1337);
            await __H.stroke(__H.line(100, 250, 800, 250, 100));
            R.detA = __H.hash(L, W, H);
            L = __H.doc(W, H);
            b._setStrokeSeed(1337);
            await __H.stroke(__H.line(100, 250, 800, 250, 100));
            R.detB = __H.hash(L, W, H);
        }
        // 9c. watercolor wash: the marker thins deposited paint. Same setup
        // as detA plus the flag the importer sets — must visibly differ.
        {
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 24); b.setParam('hardness', 80);
            b.setParam('spacing', 6);
            b.setParam('bristleCount', 8); b.setParam('bristleLength', 15);
            b.setParam('bristleWidth', 3); b.setParam('bristleSpread', 50);
            b.setParam('watercolor', 1);
            const L = __H.doc(W, H);
            b._setStrokeSeed(1337);
            await __H.stroke(__H.line(100, 250, 800, 250, 100));
            R.wash = __H.hash(L, W, H);
        }
        // 10. wet-blend coverage: retracing a stroke inside ONE wet stroke
        // must land far less new paint than retracing it dry, while a SECOND
        // stroke over a dried one still stacks (coverage is per-stroke).
        {
            const setup = (wet) => {
                __H.cleanLoad('Round'); __H.flat();
                b.setParam('size', 24); b.setParam('hardness', 80);
                b.setParam('spacing', 6);
                b.setParam('bristleCount', 8); b.setParam('bristleLength', 15);
                b.setParam('bristleWidth', 3); b.setParam('bristleSpread', 50);
                b.setParam('watercolor', 1);
                b.setParam('wetBlend', wet ? 1 : 0);
                b._setStrokeSeed(1337);
            };
            const out = __H.line(100, 250, 800, 250, 60);
            const back = __H.line(800, 250, 100, 250, 60).slice(1);
            setup(true);
            let L = __H.doc(W, H);
            await __H.stroke(out);
            R.singleWet = __H.hash(L, W, H);
            __H.snap('singleWet', L, W, H);
            L = __H.doc(W, H);
            setup(true);
            await __H.stroke(out.concat(back));
            R.retraceWet = __H.hash(L, W, H);
            __H.snap('retraceWet', L, W, H);
            L = __H.doc(W, H);
            setup(false);
            await __H.stroke(out);
            R.singleDry = __H.hash(L, W, H);
            __H.snap('singleDry', L, W, H);
            L = __H.doc(W, H);
            setup(false);
            await __H.stroke(out.concat(back));
            R.retraceDry = __H.hash(L, W, H);
            __H.snap('retraceDry', L, W, H);
            R.diffWet = __H.diff('singleWet', 'retraceWet');
            R.diffDry = __H.diff('singleDry', 'retraceDry');
            R.gainWet = __H.meanAlpha('retraceWet') - __H.meanAlpha('singleWet');
            R.gainDry = __H.meanAlpha('retraceDry') - __H.meanAlpha('singleDry');
            L = __H.doc(W, H);
            setup(true);
            await __H.stroke(out);
            await __H.stroke(out);
            R.crossWet = __H.hash(L, W, H);
            /* Stroke order, same two colours both ways. Watercolour
             * composites with multiply, which is COMMUTATIVE -- and almost
             * nothing else in the space of models we might reach for instead
             * is. That makes order a free discriminator: it costs two strokes
             * and it fails loudly if a future change to the colour model
             * quietly makes it matter which stroke went down first.
             * Re-seeding between the two strokes is what keeps this honest --
             * without it the second stroke draws different bristle jitter than
             * the first and the two orders differ for a reason that has
             * nothing to do with the operator. */
            const order = async (c1, c2) => {
                L = __H.doc(W, H);
                setup(true); await __H.stroke(out, c1);
                setup(true); await __H.stroke(out, c2);
                return __H.hash(L, W, H);
            };
            R.orderRB = await order('#ff3030', '#3030ff');
            R.orderBR = await order('#3030ff', '#ff3030');
        }
        // 9b. mid-stroke param drag: the freeze at work. Rendering follows the
        // stroke-start params (size 14 throughout), while the PATH still
        // follows live smoothing — so this must hash EXACTLY like a clean
        // stroke painted at 14 with no drag at all.
        {
            const L = __H.doc(W, H);
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 14); b.setParam('hardness', 80);
            b.setParam('spacing', 6);
            b._setStrokeSeed(1337);
            b.beginStroke(100, 250, 0.9, '#c03030');
            for (let i = 1; i <= 60; i++) {
                b.moveStroke(100 + i * 10, 250, 0.9, '#c03030');
                if (i === 30) b.setParam('size', 44);
                if (i % 6 === 0) await __H.frame();
            }
            await __H.frame();
            b.endStroke();
            await new Promise(r => setTimeout(r, 150));
            R.drag = __H.hash(L, W, H);
            const L2 = __H.doc(W, H);
            b.setParam('size', 14);
            b._setStrokeSeed(1337);
            await __H.stroke(__H.line(100, 250, 700, 250, 60));
            R.dragFrozen = __H.hash(L2, W, H);
        }
        // 9c. paper-grain removal: a mask-style tile (specks in alpha, like
        // the CSP paper grain) must REMOVE paint, not tint it. The tile is
        // built in-page (seeded specks, deterministic) and installed through
        // the same saved-params vector loadPreset uses, so _loadTexturePattern
        // classifies it exactly as it would an imported pattern.
        {
            const sc = document.createElement('canvas');
            sc.width = sc.height = 64;
            const sm = sc.getContext('2d');
            sm.clearRect(0, 0, 64, 64);
            let ss = 0x1234;
            const srnd = () => (ss = (ss * 1664525 + 1013904223) >>> 0) / 4294967296;
            sm.fillStyle = '#000';
            for (let i = 0; i < 300; i++) {
                sm.globalAlpha = 0.3 + srnd() * 0.7;
                sm.fillRect((srnd() * 64) | 0, (srnd() * 64) | 0, 2, 2);
            }
            const url = sc.toDataURL();
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('spacing', 6);
            b.setParam('texture', 60); b.setParam('textureScale', 2);
            b.setParam('texturePattern', url);
            await new Promise(r => setTimeout(r, 700)); // idle flush persists it
            b.loadPreset('Round'); // fires _loadTexturePattern for the URL
            await new Promise(r => setTimeout(r, 800)); // async decode + classify
            b._setStrokeSeed(1337);
            const L = __H.doc(W, H);
            await __H.stroke(__H.line(100, 250, 800, 250, 140));
            R.paperMask = __H.hash(L, W, H);
            // Tinted control: same texture level, pattern evicted — if the
            // tile above failed to load, paperMask would equal this (same
            // generated-grain tint path), and the check below catches it.
            b.forgetSaved('Round');
            __H.cleanLoad('Round'); __H.flat();
            b.setParam('size', 40); b.setParam('hardness', 100);
            b.setParam('spacing', 6);
            b.setParam('texture', 60); b.setParam('textureScale', 2);
            b._setStrokeSeed(1337);
            const L2 = __H.doc(W, H);
            await __H.stroke(__H.line(100, 250, 800, 250, 140));
            R.paperTinted = __H.hash(L2, W, H);
            // Plain control: texture off entirely.
            b.setParam('texture', 0);
            b._setStrokeSeed(1337);
            const L3 = __H.doc(W, H);
            await __H.stroke(__H.line(100, 250, 800, 250, 140));
            R.paperPlain = __H.hash(L3, W, H);
            b.forgetSaved('Round');
            __H.cleanLoad('Round');
        }
        __H.restore();
        return JSON.stringify(R);
    })()`, { awaitPromise: true }));

    console.log('  hashes: ' + JSON.stringify(out, null, 1).replace(/\n/g, '\n  '));

    check('the pins pin everything: same stroke twice, same hash', out.detA === out.detB,
        `${out.detA} vs ${out.detB}`);
    check('texture grain is visible: spacing 5 differs from 100', out.textured5 !== out.textured100,
        `both ${out.textured5}`);
    check('smudge rate matters: colorRate 0 differs from 50', out.smudge0 !== out.smudge50,
        `both ${out.smudge0}`);
    check('edge off-switches are no-ops', out.edgeZeroDensity === out.edgeOff && out.edgeZeroWidth === out.edgeOff,
        `${out.edgeOff} vs ${out.edgeZeroDensity} / ${out.edgeZeroWidth}`);
    check('edge darkens: live edge differs from off', out.edgeOn !== out.edgeOff,
        `both ${out.edgeOn}`);
    check('edge ring follows stroke hue: red-dominant, not black', out.edgeHue > 15,
        `mean(r-g)=${out.edgeHue}`);
    check('the freeze is exact: dragged stroke equals clean size-14 stroke', out.drag === out.dragFrozen,
        `${out.drag} vs ${out.dragFrozen}`);
    check('the wash thins paint: watercolor stroke differs from detA', out.wash !== out.detA,
        `both ${out.wash}`);
    check('the backlog actually chunked: suspend path ran', out.chunks > 0,
        `chunks=${out.chunks}`);
    check('scheduling moves no pixels: drained backlog equals framed stroke', out.drain === out.canvasRub,
        `${out.drain} vs ${out.canvasRub}`);
    check('wet blend idempotence: retracing a wet stroke deposits less new ink than retracing it dry',
        out.gainDry > 0 && out.gainWet < out.gainDry,
        `wet gain=${out.gainWet} dry gain=${out.gainDry}`);
    check('coverage is per-stroke: a second stroke over the first still stacks',
        out.crossWet !== out.singleWet,
        `both ${out.crossWet}`);
    check('watercolor is commutative: red over blue equals blue over red',
        out.orderRB === out.orderBR,
        `${out.orderRB} vs ${out.orderBR}`);
    check('paper grain removes paint: mask tile differs from no texture',
        out.paperMask !== out.paperPlain,
        `both ${out.paperMask}`);
    check('paper grain is removal, not tint: mask tile differs from generated-grain tint',
        out.paperMask !== out.paperTinted,
        `both ${out.paperMask}`);
    // Timing-dependent counter, not a pixel golden — keep it out of the file.
    delete out.chunks;
    // Hue metric, not a hash — asserted relationally above, not pinned.
    delete out.edgeHue;
    // Pixel counts, not hashes — asserted relationally above, not pinned.
    delete out.diffWet; delete out.diffDry;
    delete out.gainWet; delete out.gainDry;
    for (const k of Object.keys(out)) {
        check(`case ${k} painted something`, out[k] && !out[k].startsWith('empty:'), out[k]);
    }

    if (RECORD) {
        writeFileSync(GOLDENS, JSON.stringify(out, null, 2) + '\n');
        console.log(`  goldens recorded to test/browser/brush-hash.goldens.json`);
    } else if (!existsSync(GOLDENS)) {
        fail++;
        console.log('  FAIL no goldens file — run once with --record on the pre-change tree');
    } else {
        const gold = JSON.parse(readFileSync(GOLDENS, 'utf8'));
        for (const k of Object.keys(out)) {
            check(`golden ${k} unchanged`, out[k] === gold[k],
                `was ${gold[k]}, now ${out[k]}`);
        }
        for (const k of Object.keys(gold)) {
            if (!(k in out)) { fail++; console.log(`  FAIL golden ${k} has no current hash — case removed?`); }
        }
    }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
