// Paint one reference case with CDPaint and score it against the reference
// PNG. Shared by compare.mjs (the fixed corpus) and bank.mjs (every
// downloadable brush).
//
// c: { preset, size?, params?, lines: [[x0,y0,p0,x1,y1,p1], ...],
//      bands?: [[y0,y1], ...] }         bands: ink ratio per horizontal strip
// packVar: page expression holding the pack's bytes; packName its filename.
// importExpr: page expression for any other import ({ ok, added: [name] }).
// Imported presets are deleted again, so a long run never fills storage.
export async function measureCase(page, c, { packVar, packName, refB64, W, H, keep = false, importExpr }) {
    return JSON.parse(await page.eval(`(async () => {
        const app = PaintApp, b = app.brush, W = ${W}, H = ${H};
        const imp = ${importExpr || `await b.importBrushPack(${packVar}, ${JSON.stringify(packName)},
                                            { only: ${JSON.stringify([c.preset, c.preset.replace(/ /g, '_')])} })`};   // the file says b)_Basic-2, Krita shows b) Basic-2
        if (!imp.ok || !imp.added.length) return JSON.stringify({ error: imp.error || 'not imported', skipped: imp && imp.skipped });
        app.layerMgr.collapseToBase({ fresh: true });
        app.setSize(W, H); app.config.zoom = 1; app.updateBounds();
        document.getElementById('lsys-add').click();
        app.state.selection = null;
        const L = app.layerMgr.layers[app.layerMgr.activeIdx];
        b.loadPreset(imp.added[0]);
        ${c.size != null ? `b.setParam('size', ${c.size});` : ''}
        ${Object.entries(c.params || {}).map(([k, v]) => `b.setParam(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')}   // the same edit xmlSub made in Krita
        await new Promise(res => setTimeout(res, 600));          // let the tip load
        L.ctx.clearRect(0, 0, W, H);
        // Krita's paintLine interpolates pressure along the line; a
        // tablet reports about one sample a pixel at this speed.
        // Node.paintLine hands Krita no speed at all, so the clock stands
        // still while we draw: every speed sensor reads 0 on both sides.
        const clock = performance.now; performance.now = () => 0;
        for (const [x0, y0, p0, x1, y1, p1] of ${JSON.stringify(c.lines)}) {
            const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
            b.beginStroke(x0, y0, p0, '#000000');
            for (let i = 1; i <= n; i++) {
                const t = i / n;
                b.moveStroke(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p0 + (p1 - p0) * t, '#000000');
            }
            b.endStroke();
        }
        performance.now = clock;
        await new Promise(res => setTimeout(res, 250));
        const ours = L.ctx.getImageData(0, 0, W, H).data;
        const params = JSON.parse(JSON.stringify(b.getParams(), (k, v) =>
            typeof v === 'string' && v.length > 80 ? v.slice(0, 40) + '...' : v));
        if (!${keep}) for (const n of imp.added) b.deleteUserPreset(n);
        const img = new Image(); img.src = 'data:image/png;base64,${refB64}'; await img.decode();
        const kc = new OffscreenCanvas(W, H), kx = kc.getContext('2d');
        kx.drawImage(img, 0, 0);
        const theirs = kx.getImageData(0, 0, W, H).data;

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
        dx.drawImage(L.canvas, 0, 0); dx.drawImage(kc, 0, H);
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
        const so = stat(ours), sk = stat(theirs);
        return JSON.stringify({ png: btoa(s), ours: so, krita: sk,
            inkRatio: +(so.ink / Math.max(1, sk.ink)).toFixed(3),
            bandInk: so.bands.map((v, i) => +(v / Math.max(1, sk.bands[i])).toFixed(3)),
            meanDiff: +(diff / Math.max(1, n)).toFixed(1), maxDiff: maxd,
            iou: +(both / Math.max(1, either)).toFixed(3),
            warnings: imp.notes || [],
            // What the import actually produced, long strings (tip data) cut.
            params });
    })()`, { awaitPromise: true }));
}
