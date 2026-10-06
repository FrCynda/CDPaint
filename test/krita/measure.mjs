// Paint one reference case with CDPaint and score it against the reference
// PNG. Shared by compare.mjs (the fixed corpus) and bank.mjs (every
// downloadable brush).
//
// c: { preset, file?, size?, params?, lines: [[x0,y0,p0,x1,y1,p1], ...],
//      bands?: [[y0,y1], ...] }         bands: ink ratio per horizontal strip
// packVar: page expression holding the pack's bytes; packName its filename.
// importExpr: page expression for any other import ({ ok, added: [name] }).
// Imported presets are deleted again, so a long run never fills storage.
export async function measureCase(page, c, { packVar, packName, refB64, W, H, keep = false, importExpr, kritaStart = true, onWhite = false, msPerPx = 0, keepErase = false, under = false, seed = null, selfSeed = null, refB = null, moves = 0, origin = null, intMoves = false }) {
    // origin: where the reference's frame sits on its program's canvas, so canvas-anchored paper lands in phase
    const [OX, OY] = origin || [0, 0];
    return JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush, W = ${W}, H = ${H};
        const imp = ${importExpr || `await b.importBrushPack(${packVar}, ${JSON.stringify(packName)},
                                            { only: ${JSON.stringify(c.file ? [c.file] : [c.preset, c.preset.replace(/ /g, '_')])} })`};   // the file says b)_Basic-2, Krita shows b) Basic-2
        if (!imp.ok || !imp.added.length) return JSON.stringify({ error: imp.error || 'not imported', skipped: imp && imp.skipped });
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(W + ${OX}, H + ${OY}); app.config.zoom = 1; app.updateBounds();
        document.getElementById('lsys-add').click();
        // Krita's createDocument puts an opaque white layer under ours; a merged smudge picks it up
        { const bg = app.layerMgr.layers[0].ctx; bg.fillStyle = '#fff'; bg.fillRect(0, 0, W + ${OX}, H + ${OY}); }
        app.state.selection = null;
        const L = app.layerMgr.layers[app.layerMgr.activeIdx];
        b.loadPreset(imp.added[0]);
        ${c.size != null ? `b.setParam('size', ${c.size});` : ''}
        ${Object.entries(c.params || {}).map(([k, v]) => `b.setParam(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')}   // the same edit xmlSub made in Krita
        // Node.paintLine takes no eraser toggle from the preset (a) Eraser_Textured paints ink
        // there); a true erase blend leaves Krita's canvas blank and is never scored.
        if (b.getParams().blendMode === 'erase' && !${keepErase}) b.setParam('blendMode', 'normal');
        await new Promise(res => setTimeout(res, 600));          // let the tip load
        /* under: stripes to smudge or rub out (mypaint-render.py's), and each
         * side scored by how far it moved a pixel off them, as black ink. */
        const STRIPES = [[255, 0, 0], [0, 0, 255], [255, 255, 0]];
        const moved = (d) => { for (let i = 0; i < W * H; i++) {
            const c = STRIPES[((i % W) >> 4) % 3], a = d[i * 4 + 3];
            let m = 255 - a;
            for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(Math.round(d[i * 4 + k] * a / 255) - c[k]));
            d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0; d[i * 4 + 3] = m;
        } };
        // seed pins the stroke's random numbers (null: a fresh draw, as a user gets)
        const paint = async (seed) => {
        if (seed != null) b._setStrokeSeed(seed);
        L.ctx.clearRect(0, 0, W + ${OX}, H + ${OY});
        if (${under}) for (let x = 0; x < W; x += 16) { L.ctx.fillStyle = 'rgb(' + STRIPES[x / 16 % 3] + ')'; L.ctx.fillRect(x, 0, 16, H); }
        // Krita's paintLine interpolates pressure along the line; a
        // tablet reports about one sample a pixel at this speed.
        // Node.paintLine hands Krita no speed at all, so the clock stands
        // still while we draw: every speed sensor reads 0 on both sides.
        // msPerPx > 0 runs the clock instead: the pen moves at 1/msPerPx px/ms.
        const clock = performance.now; let tick = 0; performance.now = () => tick;
        // A sketch or curve brush remembers every point it is handed and joins back to
        // them; Krita's paintLine hands it the two ends and nothing between
        // (test/krita/probes/sketch), so it gets the same here.
        const oneSeg = /^(sketch|curve|particle|hairy)$/.test(b.getParams().engineKind);
        for (const [x0, y0, p0, x1, y1, p1] of ${JSON.stringify(c.lines.map(([a, b, p, d, e, q]) => [a + OX, b + OY, p, d + OX, e + OY, q]))}) {
            // moves: how many reports the reference program got (Clip Studio's drag posts 70)
            const n = oneSeg ? 1 : ${moves} || Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
            /* Node.paintLine starts from a blank KisSpacingInformation, whose
             * spacing 0 is floored to MIN_DISTANCE_SPACING: Krita's first dab
             * lands half a pixel along the line, not on its start (every
             * Light Shine star sat 0.5px down the stroke from ours). GIMP's
             * lands on the start, so its bank turns this off. */
            const len = Math.hypot(x1 - x0, y1 - y0), h = !${kritaStart} || oneSeg || !len ? 0 : 0.5 / len;
            // ...and its distance is counted from the canvas origin (a blank
            // KisDistanceInformation's lastPosition is 0,0): X3CD Doodle.
            b.distanceFrom = ${kritaStart} ? Math.hypot(x0 + (x1 - x0) * h, y0 + (y1 - y0) * h) : 0;
            b.beginStroke(x0 + (x1 - x0) * h, y0 + (y1 - y0) * h, p0 + (p1 - p0) * h, '#000000');
            for (let i = 1; i <= n; i++) {
                const t = i / n;
                tick += ${msPerPx} * len / n;
                // intMoves: Clip Studio's drag posts whole pixels, (x1 - x0) * i / n in integers
                if (${intMoves}) b.moveStroke(x0 + Math.trunc((x1 - x0) * i / n), y0 + Math.trunc((y1 - y0) * i / n), p0 + (p1 - p0) * t, '#000000');
                else b.moveStroke(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, '#000000');
            }
            b.endStroke();
        }
        performance.now = clock;
        await new Promise(res => setTimeout(res, 250));
        b.distanceFrom = 0;
        const ours = L.ctx.getImageData(${OX}, ${OY}, W, H).data;
        if (${under}) moved(ours);
        // A reference captured as ink on white (Clip Studio) scores darkness
        // over white, so a stamp's own white parts are paper there too.
        if (${onWhite}) for (let i = 0; i < W * H * 4; i += 4)
            ours[i + 3] = Math.round(ours[i + 3] * (255 - Math.min(ours[i], ours[i + 1], ours[i + 2])) / 255);
        b._setStrokeSeed(null);
        return ours;
        };
        const ours = await paint(${seed == null ? 'null' : seed}), shown = L.ctx.getImageData(${OX}, ${OY}, W, H);
        // selfSeed: the same stroke on other random numbers, to say how far a
        // random brush agrees with itself (second, once a picture tip has loaded)
        const self = ${selfSeed == null ? 'null' : 'await paint(' + selfSeed + ')'};
        if (self) L.ctx.putImageData(shown, ${OX}, ${OY});
        const params = JSON.parse(JSON.stringify(b.getParams(), (k, v) =>
            typeof v === 'string' && v.length > 80 ? v.slice(0, 40) + '...' : v));
        const sec = b.PRESETS[b._currentPreset] && b.PRESETS[b._currentPreset].second;   // a Clip Studio second brush lives on the preset
        if (sec) params.second = { op: sec.op, p: JSON.parse(JSON.stringify(sec.p, (k, v) => typeof v === 'string' && v.length > 80 ? v.slice(0, 40) + '...' : v)) };
        if (!${keep}) for (const n of imp.added) b.deleteUserPreset(n);
        const img = new Image(); img.src = 'data:image/png;base64,${refB64}'; await img.decode();
        const kc = new OffscreenCanvas(W, H), kx = kc.getContext('2d');
        kx.drawImage(img, 0, 0);
        const theirs = kx.getImageData(0, 0, W, H).data;
        if (${under}) moved(theirs);

        const stat = (d) => {
            let ink = 0, px = 0, part = 0, x0 = W, x1 = -1, y0 = H, y1 = -1, cy = 0;
            const cols = new Float64Array(W);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const a = d[(y * W + x) * 4 + 3];
                if (!a) continue;
                ink += a; px++; if (a < 255) part++; cy += a * y; cols[x]++;
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
            // Stroke thickness sampled at four points along its length.
            const at = (f) => cols[Math.round(${c.lines[0][0]} + (${c.lines[0][3]} - ${c.lines[0][0]}) * f)];
            const band = ([b0, b1]) => { let s = 0; for (let y = b0; y < b1; y++) for (let x = 0; x < W; x++) s += d[(y * W + x) * 4 + 3]; return s / 255; };
            return { ink: Math.round(ink / 255), pixels: px, partial: part,
                     box: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], centreY: +(cy / Math.max(1, ink)).toFixed(2),
                     thick: [at(0.1), at(0.35), at(0.65), at(0.95)], bands: ${JSON.stringify(c.bands || [])}.map(band) };
        };
        let diff = 0, n = 0, maxd = 0, both = 0, either = 0;
        const dc = new OffscreenCanvas(W, H * 3), dx = dc.getContext('2d');
        dx.fillStyle = '#fff'; dx.fillRect(0, 0, W, H * 3);
        dx.drawImage(L.canvas, ${OX}, ${OY}, W, H, 0, 0, W, H); dx.drawImage(kc, 0, H);
        const dd = dx.getImageData(0, H * 2, W, H);
        /* "Inked" is at least half Krita's darkest pixel -- a fixed 127
         * scored Pencil-1 (60% opacity, nothing past 153) as no overlap. */
        let kmax = 1;
        for (let i = 0; i < W * H; i++) kmax = Math.max(kmax, theirs[i * 4 + 3]);
        const half = kmax >> 1;
        for (let i = 0; i < W * H; i++) {
            const a = ours[i * 4 + 3], k = theirs[i * 4 + 3];
            if (a || k) { n++; diff += Math.abs(a - k); }
            if (Math.abs(a - k) > maxd) maxd = Math.abs(a - k);
            if (a > half && k > half) both++;
            if (a > half || k > half) either++;
            // red: CDPaint has more ink, blue: Krita has more
            const e = Math.min(255, Math.abs(a - k) * 2);
            dd.data[i * 4] = a >= k ? 255 : 255 - e;
            dd.data[i * 4 + 1] = 255 - e;
            dd.data[i * 4 + 2] = a >= k ? 255 - e : 255;
            dd.data[i * 4 + 3] = 255;
        }
        dx.putImageData(dd, 0, H * 2);
        dx.fillStyle = '#888'; dx.fillRect(0, H - 1, W, 1); dx.fillRect(0, 2 * H - 1, W, 1);
        const blob = await dc.convertToBlob();
        const u8 = new Uint8Array(await blob.arrayBuffer());
        let s = ''; for (const x of u8) s += String.fromCharCode(x);
        /* Where the ink lies, not which pixel: both alphas box-blurred twice
         * over 12px, then sum(min) / sum(max). A scatter brush can match this
         * without drawing the same random numbers. */
        const blur = (d) => {
            let a = new Float32Array(W * H), t = new Float32Array(W * H);
            for (let i = 0; i < W * H; i++) a[i] = d[i * 4 + 3];
            const R = 12;
            for (let pass = 0; pass < 2; pass++) {
                for (let y = 0; y < H; y++) { let s = 0; for (let x = -R; x < W; x++) {
                    if (x + R < W) s += a[y * W + x + R]; if (x - R - 1 >= 0) s -= a[y * W + x - R - 1];
                    if (x >= 0) t[y * W + x] = s / (2 * R + 1); } }
                for (let x = 0; x < W; x++) { let s = 0; for (let y = -R; y < H; y++) {
                    if (y + R < H) s += t[(y + R) * W + x]; if (y - R - 1 >= 0) s -= t[(y - R - 1) * W + x];
                    if (y >= 0) a[y * W + x] = s / (2 * R + 1); } }
            }
            return a;
        };
        const softIou = (p, q) => { let lo = 0, hi = 0; for (let i = 0; i < W * H; i++) { lo += Math.min(p[i], q[i]); hi += Math.max(p[i], q[i]); } return +(lo / Math.max(1e-9, hi)).toFixed(3); };
        const bo = blur(ours), bk = blur(theirs);
        /* refB: Krita's second render of a random brush -- how far Krita agrees
         * with itself is the most we can ask of ours. */
        let kk = null;
        if (${refB != null}) {
            const ib = new Image(); ib.src = 'data:image/png;base64,${refB || ''}'; await ib.decode();
            const bc = new OffscreenCanvas(W, H), bx = bc.getContext('2d'); bx.drawImage(ib, 0, 0);
            const tb = bx.getImageData(0, 0, W, H).data;
            kk = { soft: softIou(bk, blur(tb)), ink: stat(tb).ink };
        }
        const so = stat(ours), sk = stat(theirs);
        return JSON.stringify({ png: btoa(s), ours: so, krita: sk,
            inkRatio: +(so.ink / Math.max(1, sk.ink)).toFixed(3),
            bandInk: so.bands.map((v, i) => +(v / Math.max(1, sk.bands[i])).toFixed(3)),
            meanDiff: +(diff / Math.max(1, n)).toFixed(1), maxDiff: maxd,
            iou: +(both / Math.max(1, either)).toFixed(3), soft: softIou(bo, bk),
            self: self ? softIou(bo, blur(self)) : null, kk,
            warnings: imp.notes || [],
            // What the import actually produced, long strings (tip data) cut.
            params });
    })()`, { awaitPromise: true }));
}
