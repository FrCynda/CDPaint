    (function (app) {

        /* ── 1. DEFAULTS & PRESETS ───────────────────────────────────────── */

        const DEFAULTS = {
            shape: 'circle',
            startSize: 8,   endSize: 8,
            spacing: 20,
            angle: 0,
            speedSize: 0,   speedOpacity: 0,
            stabilize: 0,
            taper: 0,
            sizeJitter: 0,  posJitter: 0,   angleJitter: 0,
            opacity: 100,   flow: 100,      hardness: 100,
            wetness: 0,
            texture: 0,     grainScale: 4,
            scatter: 0,     scatterRadius: 12,
            smudge: 0,
            hueJitter: 0,   satJitter: 0,   briJitter: 0,
            colorFade: 0,
            antialias: true,
            binaryMode: false,
            smartBrush: false,
            outlineThick: 3,
            // Custom image brush tip (OffscreenCanvas or null)
            customTipCanvas: null,   // baked tip (hardness + invert applied)
            customTipRaw: null,      // raw luminance-only mask, no hardness baked in
            tipInvert: false,
            tipHardness: 100,        // 0 = feathered edge, 100 = sharp (applied at bake time)
            // Bristle brush
            bristleCount:  8,
            bristleSpread: 40,
            // Polygon-growth watercolor bloom (on-stroke-end edge bleed)
            polyWatercolor: false,
            // Airbrush accumulation: paint builds up even when brush is stationary
            airbrushMode: false,
            airbrushRate: 40,   // dabs per second while held still (1–100)
            // Phase 3: sensor-curve LUTs (Float32Array[256] or null = linear fallback)
            _sizeLUT:    null,
            _opacityLUT: null,
            // Phase 4: Krita texture tile (OffscreenCanvas or null = procedural noise)
            _kritaTextureTile: null,
        };

        const PRESETS = {
            round:      { shape:'circle', startSize:8,  endSize:8,  spacing:20,  hardness:100, opacity:100, flow:100, taper:0,  texture:0,  smudge:0,  wetness:0, scatter:0, sizeJitter:0, angleJitter:0 },
            calligraphy:{ shape:'slash',  startSize:12, endSize:2,  spacing:10,  hardness:100, opacity:100, flow:100, taper:55, texture:5,  smudge:0,  wetness:0, scatter:0, angle:0, angleJitter:0, grainScale:2 },
            airbrush:   { shape:'circle', startSize:22, endSize:22, spacing:5,   hardness:0,   opacity:55,  flow:35,  taper:0,  texture:0,  smudge:0,  wetness:0, scatter:6, scatterRadius:18, sizeJitter:15, airbrushMode:true, airbrushRate:40 },
            ink:        { shape:'circle', startSize:10, endSize:1,  spacing:15,  hardness:100, opacity:100, flow:100, taper:75, texture:8,  smudge:0,  wetness:0, scatter:0, speedSize:-25, grainScale:2 },
            marker:     { shape:'square', startSize:16, endSize:16, spacing:10,  hardness:100, opacity:55,  flow:65,  taper:0,  texture:0,  smudge:0,  wetness:0, scatter:0 },
            watercolor: { shape:'circle', startSize:20, endSize:5,  spacing:12,  hardness:8,   opacity:55,  flow:25,  taper:40, texture:10, smudge:15, wetness:30, scatter:3, scatterRadius:10, colorFade:35, sizeJitter:10, polyWatercolor:true },
            charcoal:   { shape:'line',   startSize:18, endSize:12, spacing:12,  hardness:25,  opacity:65,  flow:45,  taper:20, texture:75, smudge:0,  wetness:0, scatter:0, scatterRadius:6, sizeJitter:25, angleJitter:35, grainScale:3 },
            splatter:   { shape:'circle', startSize:5,  endSize:5,  spacing:50,  hardness:90,  opacity:85,  flow:85,  taper:0,  texture:0,  smudge:0,  wetness:0, scatter:14, scatterRadius:32, sizeJitter:65, posJitter:6 },
            fanbrush:   { shape:'bristle', startSize:28, endSize:22, spacing:8,  hardness:80,  opacity:80,  flow:70,  taper:20, texture:15, smudge:0,  wetness:0, scatter:0, bristleCount:12, bristleSpread:60, angleJitter:5, sizeJitter:8 },
            drybrush:   { shape:'bristle', startSize:18, endSize:14, spacing:5,  hardness:100, opacity:65,  flow:55,  taper:30, texture:40, smudge:5,  wetness:0, scatter:0, bristleCount:7,  bristleSpread:30, angleJitter:8, sizeJitter:20, grainScale:2 },
        };

        let params = Object.assign({}, DEFAULTS);
        let engineActive = false;

        // Shared math constant — avoids recomputing Math.PI * 2 in every hot-path call
        const TWO_PI = Math.PI * 2;

        /* ── 2. STROKE STATE ─────────────────────────────────────────────── */

        let strokeActive = false;
        let lastDabX = 0, lastDabY = 0;
        let residualDist = 0;
        let strokeLength = 0;
        // ── Smudge bucket system (inspired by libmypaint) ──────────────────────
        // libmypaint maintains multiple smudge buckets, each capturing a colour
        // sample at a different position.  Blending across buckets creates a
        // spatially-aware smear: colour picked up at the edge of the dab differs
        // from colour at the centre, giving the effect of the brush dragging
        // different canvas colours at different lateral positions.
        //
        // Our implementation keeps N_SMUDGE_BUCKETS samples arranged in a ring.
        // Each bucket stores the last sampled colour at one of N evenly-spaced
        // offsets across the brush width, perpendicular to the stroke direction.
        // On each sample event, one bucket is updated (round-robin) so the cost
        // is always one getImageData call regardless of bucket count.
        // When computing smudge fill, buckets are averaged with spatial weighting
        // based on how close they are to the current dab centre — buckets sampled
        // recently near the dab contribute more.
        const N_SMUDGE_BUCKETS = 4;
        let smudgeColor = null;   // legacy scalar kept for backwards-compat reads
        let _smudgeBuckets = [];  // [{r,g,b}]  — ring of spatial colour samples
        let _smudgeBucketIdx = 0; // which bucket to update next (round-robin)

        // Clear/init buckets — call on strokeBegin
        function _resetSmudgeBuckets() {
            _smudgeBuckets = [];
            _smudgeBucketIdx = 0;
            smudgeColor = null;
        }

        // Sample one bucket from the canvas at position (sx, sy) and store it.
        // Returns the bucket color or null.
        function _sampleSmudgeBucket(ctx, sx, sy, sampleR, W, H) {
            try {
                const sampleD = sampleR * 2;
                const ox = Math.max(0, Math.min(W - sampleD, Math.round(sx) - sampleR));
                const oy = Math.max(0, Math.min(H - sampleD, Math.round(sy) - sampleR));
                const src = (_flowBufActive && _preStrokeCtx) ? _preStrokeCtx : ctx;
                const d   = src.getImageData(ox, oy, sampleD, sampleD).data;
                let rr = 0, gg = 0, bb = 0, cnt = 0;
                for (let i = 0; i < d.length; i += 8) {
                    if (d[i+3] > 8) { rr += d[i]; gg += d[i+1]; bb += d[i+2]; cnt++; }
                }
                if (cnt === 0) return null;
                return { r: rr/cnt, g: gg/cnt, b: bb/cnt };
            } catch (_) { return null; }
        }

        // Compute the effective smudge colour as a weighted average of all buckets.
        // Weight by _smudgeAccum so influence builds progressively over the stroke.
        function _getSmudgeColor(userSmudge) {
            if (!_smudgeBuckets.length) return null;
            // Simple average across all valid buckets, then scale by accum
            let rr = 0, gg = 0, bb = 0;
            for (const b of _smudgeBuckets) { rr += b.r; gg += b.g; bb += b.b; }
            const n = _smudgeBuckets.length;
            return { r: rr/n, g: gg/n, b: bb/n };
        }

        // Catmull-Rom spline: fixed 4-slot circular buffer — zero allocation in the hot path.
        // _crHead is the index of the oldest slot (the one to be overwritten on the next push).
        // Access order oldest→newest: [_crHead], [_crHead+1], [_crHead+2], [_crHead+3] (all &3).
        const _crBuf  = [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }];
        let   _crHead = 0;

        // Airbrush accumulation: interval handle and last-dab position
        let _airbrushInterval = 0;
        let _airbrushX = 0, _airbrushY = 0;
        let _airbrushColor = '#000000';

        // Grain cache (OffscreenCanvas per brush size)
        let _grainCache = null, _grainCacheSize = -1, _grainCacheScale = -1;

        // Wet layer
        let _wetCanvas = null, _wetCtx = null;
        let _wetW = 0, _wetH = 0;
        let _wetDecayLastT = 0;   // timestamp of last full-canvas decay pass
        // Smudge state
        // smudgeColor          = the colour currently carried in the "smudge buffer"
        // _smudgeSampleDist    = distance travelled since the last getImageData sample
        // _smudgeAccum         = 0-1, how saturated the buffer is with picked-up colour
        //                        (builds toward 1 as you drag; reset to 0 on stroke start)
        let _smudgeSampleDist = 0;
        let _smudgeAccum = 0;        // replaces old _smudgeDecay
        let _lastSmudgeTime = 0;     // timestamp of last getImageData smudge sample

        // End-taper RAF handle
        let _endTaperRAF = 0;

        // Bristle strand state — generated at strokeBegin, persists for the stroke.
        // Each strand has a fixed lateral offset (perpendicular to stroke direction)
        // plus a small random wobble bias so fibers look independent, not cloned.
        let _bristleStrands = [];  // [{lateralFrac, wFrac, alphaScale}]  — rebuilt each stroke

        // ── Flow accumulation buffer ───────────────────────────────────────────
        // When opacity < 100 or flow < 100, dabs go to _strokeCanvas first,
        // then composite to the real canvas at params.opacity each dab group.
        // This prevents dabs stacking within a single stroke past the opacity
        // ceiling — a fundamental difference from how Photoshop-style brushes feel.
        let _flowBufActive   = false;
        let _strokeCanvas    = null, _strokeCtx    = null;
        let _preStrokeCanvas = null, _preStrokeCtx = null;
        let _strokeBufW      = 0,    _strokeBufH    = 0;

        // ── Flow buffer dirty-rect batching ────────────────────────────────────
        // Instead of compositing on every dab in the hot path, we accumulate the
        // union of all dab dirty regions during a frame and flush exactly once in
        // the next requestAnimationFrame.  _syncFlowBuf is still called directly
        // (synchronously) for the first dab in strokeBegin, the end-taper RAF
        // loop, and the airbrush timer — those fire at most once per tick and
        // need an immediate update.  Only the strokeMove inner loop is batched.
        let _flowDirtyRect      = null;   // { x, y, w, h } — union of pending dab regions
        let _flowRAFPending     = false;  // true when a flush RAF is already queued
        let _flowRAFCtx         = null;   // realCtx captured when the RAF was scheduled

        // Pre-computed constant part of the flow dirty-rect padding.
        // scatterRadius and posJitter don't change mid-stroke, so we compute
        // their contribution once at strokeBegin rather than every _expandFlowDirty call.
        let _flowPadBase = 6;

        let _noiseData = null, _noiseSz = 128;

        function _buildNoise() {
            _noiseData = new Float32Array(_noiseSz * _noiseSz);
            const gridSz = 8;
            const grid = new Float32Array((gridSz + 1) * (gridSz + 1));
            for (let i = 0; i < grid.length; i++) grid[i] = Math.random();
            for (let py = 0; py < _noiseSz; py++) {
                for (let px = 0; px < _noiseSz; px++) {
                    const gx = (px / _noiseSz) * gridSz;
                    const gy = (py / _noiseSz) * gridSz;
                    const ix = Math.floor(gx), iy = Math.floor(gy);
                    const fx = gx - ix, fy = gy - iy;
                    const ux = fx * fx * (3 - 2 * fx);
                    const uy = fy * fy * (3 - 2 * fy);
                    const g = gridSz + 1;
                    const v00 = grid[iy * g + ix];
                    const v10 = grid[iy * g + ix + 1];
                    const v01 = grid[(iy + 1) * g + ix];
                    const v11 = grid[(iy + 1) * g + ix + 1];
                    _noiseData[py * _noiseSz + px] =
                        v00 * (1 - ux) * (1 - uy) +
                        v10 * ux * (1 - uy) +
                        v01 * (1 - ux) * uy +
                        v11 * ux * uy;
                }
            }
        }

        function sampleNoise(x, y, scale) {
            if (!_noiseData) _buildNoise();
            const nx = ((Math.floor(x / scale) % _noiseSz) + _noiseSz) % _noiseSz;
            const ny = ((Math.floor(y / scale) % _noiseSz) + _noiseSz) % _noiseSz;
            return _noiseData[ny * _noiseSz + nx];
        }

        /* Build / reuse a tileable grain OffscreenCanvas at the given dab size.
           Phase 4 upgrade: if params._kritaTextureTile is set (extracted from a
           .kpp ZIP), sample that bitmap instead of the procedural noise grid.
           Directional: coordinates are rotated by strokeAngle before lookup so
           grain aligns with brush direction (critical for slash / line shapes). */
        function _getGrainCanvas(sz, scale, strokeAngleDeg) {
            // Quantise to the next 4-px bucket before the cache check.
            const iSz = Math.max(4, Math.ceil(sz / 4) * 4);
            if (_grainCache && _grainCacheSize === iSz && _grainCacheScale === scale) {
                return _grainCache;
            }
            const oc = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(iSz, iSz)
                : (function () { const c = document.createElement('canvas'); c.width = iSz; c.height = iSz; return c; })();
            const octx = oc.getContext('2d');
            const img  = octx.createImageData(iSz, iSz);
            const rad  = strokeAngleDeg * Math.PI / 180;
            const ca   = Math.cos(rad), sa = Math.sin(rad);

            /* ── Phase 4: Krita texture tile path ────────────────────────── */
            const tile = params._kritaTextureTile;
            if (tile) {
                const TW = tile.width  || 128;
                const TH = tile.height || 128;
                /* Read the tile pixels once into a temporary ImageData. */
                const tileCtx  = tile.getContext('2d');
                const tileData = tileCtx.getImageData(0, 0, TW, TH).data;

                for (let py = 0; py < iSz; py++) {
                    for (let px = 0; px < iSz; px++) {
                        /* Rotate sample coordinates to align with stroke direction */
                        const rx = px * ca - py * sa;
                        const ry = px * sa + py * ca;
                        /* Tile-wrap with scale factor */
                        const tx = (((Math.floor(rx / scale) % TW) + TW) % TW) | 0;
                        const ty = (((Math.floor(ry / scale) % TH) + TH) % TH) | 0;
                        const ti = (ty * TW + tx) * 4;
                        /* Convert to luminance; dark tile pixels = more erosion */
                        const lum = (tileData[ti] * 0.299 +
                                     tileData[ti + 1] * 0.587 +
                                     tileData[ti + 2] * 0.114) / 255;
                        const i = (py * iSz + px) * 4;
                        img.data[i]     = 0;
                        img.data[i + 1] = 0;
                        img.data[i + 2] = 0;
                        /* Invert: bright tile areas erode more (destination-out) */
                        img.data[i + 3] = Math.round(lum * 255);
                    }
                }
            } else {
                /* ── Procedural noise path (original) ──────────────────────── */
                if (!_noiseData) _buildNoise();
                for (let py = 0; py < iSz; py++) {
                    for (let px = 0; px < iSz; px++) {
                        const rx = px * ca - py * sa;
                        const ry = px * sa + py * ca;
                        const nx = ((Math.floor(rx / scale) % _noiseSz) + _noiseSz) % _noiseSz;
                        const ny = ((Math.floor(ry / scale) % _noiseSz) + _noiseSz) % _noiseSz;
                        const v  = _noiseData[ny * _noiseSz + nx];
                        const i  = (py * iSz + px) * 4;
                        img.data[i]     = 0;
                        img.data[i + 1] = 0;
                        img.data[i + 2] = 0;
                        img.data[i + 3] = Math.round(v * 255);
                    }
                }
            }

            octx.putImageData(img, 0, 0);
            _grainCache     = oc;
            _grainCacheSize = iSz;
            _grainCacheScale = scale;
            return oc;
        }

        /* ── 4. COLOR UTILITIES ──────────────────────────────────────────── */

        /* Local hexToRgb with a small map cache — the same hex string recurs on
           every dab of a stroke, so we avoid repeated parseInt calls. */
        const _hexRgbCache = new Map();
        function hexToRgb(hex) {
            let v = _hexRgbCache.get(hex);
            if (v) return v;
            const n = parseInt(hex.replace('#', ''), 16);
            v = { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
            if (_hexRgbCache.size >= 32) _hexRgbCache.delete(_hexRgbCache.keys().next().value);
            _hexRgbCache.set(hex, v);
            return v;
        }

        /* Soft-circle gradient cache — the gradient only depends on r, hardness,
           and RGB colour. Within a single stroke those almost never change, so we
           recreate it only when the key differs from the last call.
           NOTE: a CanvasGradient is bound to the context it was created on, so we
           must also track the context and rebuild whenever it switches (scratch
           canvases from the pool may be different objects but pool reuse means the
           same ctx object often comes back, making the cache hit on most dabs). */
        let _gradCacheKey = '';
        let _gradCacheCtx = null;
        let _gradCacheVal = null;

        function _getSoftGrad(dctx, r, hardness, rgb) {
            const key = r + '|' + hardness + '|' + rgb.r + ',' + rgb.g + ',' + rgb.b;
            if (key === _gradCacheKey && dctx === _gradCacheCtx && _gradCacheVal) {
                return _gradCacheVal;
            }
            const innerR = r * Math.max(0, hardness);
            const grad   = dctx.createRadialGradient(0, 0, innerR, 0, 0, r);
            grad.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',1)');
            grad.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
            _gradCacheKey = key;
            _gradCacheCtx = dctx;
            _gradCacheVal = grad;
            return grad;
        }

        /* Module-level constant for the white stamp — hoisted so the tinted
           stamp path never allocates a new object literal per dab. */
        const _WHITE_RGB = { r: 255, g: 255, b: 255 };

        /* ── 5. DAB STAMP CACHE ──────────────────────────────────────────────
           For the common case of a plain circle/square/diamond/etc. brush with
           no grain, no jitter, and no angle, the dab shape is identical for every
           stamp along the stroke.  We pre-render it once into a cached
           OffscreenCanvas and then reuse it via drawImage — a single GPU blit is
           5-10× faster than arc + gradient fill for large brushes.

           Phase 5 upgrade: memory-bounded LRU.
           Each cached canvas costs width × height × 4 bytes (RGBA).  For a
           256×256 custom tip that is 256 KB — 8 entries would be 2 MB.  With
           rotation variants the pool could balloon to crash-territory.

           New policy:
             • _DAB_STAMP_BUDGET: max total bytes across all cached stamps (4 MB).
             • _DAB_STAMP_MAX:    hard cap on entry count (remains at 8).
             • On each new stamp build, evict LRU entries until both constraints
               are satisfied.
           The budget is checked every time we add a new stamp, not per-blit,
           so there is zero extra cost on the hot path (drawImage).
        */
        const _dabStampLRU    = [];
        const _DAB_STAMP_MAX  = 8;
        const _DAB_STAMP_BUDGET = 4 * 1024 * 1024;   // 4 MB total across all cached stamps
        let   _dabStampBytes  = 0;                    // running total of cached bytes

        // _buildDabStamp always renders at angle=0.  Rotation is applied at
        // drawImage time via ctx.setTransform so the stamp is reused across all
        // angle-jittered dabs — the previous design baked rad into the cache key,
        // guaranteeing a miss on every jittered dab.
        // MRU-1 slot for _buildDabStamp: stores the raw numeric values of the last
        // returned stamp so we can confirm a hit without building a string at all.
        // On a steady stroke (constant colour, no size-jitter) this fires every dab.
        let _stampMRU = null;   // { iSz, hardness, r, g, b, shape, canvas }

        function _buildDabStamp(sz, hardness, rgb, shape) {
            // Quantize to nearest even integer — absorbs sub-pixel size jitter
            const iSz = Math.max(2, Math.round((Math.ceil(sz) + 4) / 2) * 2);

            // MRU-1 check — avoids string construction + findIndex on every dab
            // during a steady stroke (most common case by far).
            if (_stampMRU &&
                _stampMRU.iSz      === iSz     &&
                _stampMRU.hardness === hardness &&
                _stampMRU.r        === rgb.r    &&
                _stampMRU.g        === rgb.g    &&
                _stampMRU.b        === rgb.b    &&
                _stampMRU.shape    === shape) {
                return _stampMRU.canvas;
            }

            const key = iSz + '|' + hardness.toFixed(2) + '|' + rgb.r + ',' + rgb.g + ',' + rgb.b +
                        '|' + shape;

            // LRU lookup
            const idx = _dabStampLRU.findIndex(function(e) { return e.key === key; });
            if (idx !== -1) {
                const hit = _dabStampLRU.splice(idx, 1)[0];
                _dabStampLRU.unshift(hit);
                _stampMRU = { iSz, hardness, r: rgb.r, g: rgb.g, b: rgb.b, shape, canvas: hit.canvas };
                return hit.canvas;
            }

            // Compute byte cost of the new stamp
            const stampBytes = iSz * iSz * 4;

            // Evict LRU entries until both count and memory budget fit
            while (_dabStampLRU.length >= _DAB_STAMP_MAX ||
                   (_dabStampBytes + stampBytes) > _DAB_STAMP_BUDGET) {
                if (!_dabStampLRU.length) break;
                const evicted = _dabStampLRU.pop();
                _dabStampBytes -= evicted.canvas.width * evicted.canvas.height * 4;
                _returnScratch(evicted.canvas);
            }

            const sc   = _borrowScratch(iSz, iSz);
            const sctx = sc._poolCtx;
            const mid  = iSz / 2;
            const r    = sz / 2;
            const fill = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';

            sctx.clearRect(0, 0, iSz, iSz);
            // No rotation here — stamp is always axis-aligned.
            // Asymmetric shapes (slash, line) are rotated at draw time.
            // Delegate shape rendering to the tip abstraction layer.
            // useSoftGradient=true so circles get the radial gradient at stamp-build time.
            _renderTipOntoCtx(sctx, mid, mid, r, sz, 0, fill, hardness, true);

            _dabStampLRU.unshift({ key: key, canvas: sc });
            _dabStampBytes += stampBytes;
            _stampMRU = { iSz, hardness, r: rgb.r, g: rgb.g, b: rgb.b, shape, canvas: sc };
            return sc;
        }

        function rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            let h = 0, s = 0;
            const l = (mx + mn) / 2;
            if (mx !== mn) {
                const d = mx - mn;
                s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
                if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                else if (mx === g) h = ((b - r) / d + 2) / 6;
                else h = ((r - g) / d + 4) / 6;
            }
            return { h: h * 360, s: s * 100, l: l * 100 };
        }

        // Static hex lookup table and helpers for hslToHex — hoisted outside the
        // function so no closure or array is allocated on each color-jitter dab.
        const _HEX16 = '0123456789abcdef';

        /* Hue channel helper for HSL→RGB (CSS spec algorithm). */
        function _hslHue(p, q, t) {
            if (t < 0) t += 1; else if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 0.5) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
        }

        /* Convert a 0–1 float to a two-character hex string without toString/padStart. */
        function _toHex2(v) {
            const n = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
            return _HEX16[n >> 4] + _HEX16[n & 15];
        }

        function hslToHex(h, s, l) {
            h /= 360; s /= 100; l /= 100;
            let r, g, b;
            if (s === 0) {
                r = g = b = l;
            } else {
                const q  = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p  = 2 * l - q;
                r = _hslHue(p, q, h + 1/3);
                g = _hslHue(p, q, h);
                b = _hslHue(p, q, h - 1/3);
            }
            return '#' + _toHex2(r) + _toHex2(g) + _toHex2(b);
        }

        function jitterColor(hex, t_fade) {
            if (!params.hueJitter && !params.satJitter && !params.briJitter && !params.colorFade) return hex;
            const rgb = hexToRgb(hex);
            let { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
            if (params.hueJitter)  h = (h + (Math.random() - 0.5) * 2 * params.hueJitter + 360) % 360;
            if (params.satJitter)  s = Math.max(0, Math.min(100, s + (Math.random() - 0.5) * 2 * params.satJitter));
            if (params.briJitter)  l = Math.max(0, Math.min(100, l + (Math.random() - 0.5) * 2 * params.briJitter));
            if (params.colorFade)  l = Math.min(95, l + t_fade * (params.colorFade / 100) * 50);
            return hslToHex(h, s, l);
        }

        /* Hot-path variant: accepts a pre-computed base HSL so the hex->RGB->HSL
           conversion is paid once per strokeMove call rather than once per dab. */
        function _jitterFromHsl(baseHsl, t_fade) {
            let h = baseHsl.h, s = baseHsl.s, l = baseHsl.l;
            if (params.hueJitter)  h = (h + (Math.random() - 0.5) * 2 * params.hueJitter + 360) % 360;
            if (params.satJitter)  s = Math.max(0, Math.min(100, s + (Math.random() - 0.5) * 2 * params.satJitter));
            if (params.briJitter)  l = Math.max(0, Math.min(100, l + (Math.random() - 0.5) * 2 * params.briJitter));
            if (params.colorFade)  l = Math.min(95, l + t_fade * (params.colorFade / 100) * 50);
            return hslToHex(h, s, l);
        }

        /* ── 4b. WET LAYER ───────────────────────────────────────────────── */

        /* Ensure the wet canvas matches the current document size */
        function _ensureWetCanvas() {
            const W = app.config.width  || 800;
            const H = app.config.height || 600;
            if (_wetCanvas && _wetW === W && _wetH === H) return;
            const oc = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(W, H)
                : (function () { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; })();
            _wetCanvas = oc;
            _wetCtx    = oc.getContext('2d');
            _wetW = W; _wetH = H;
        }

        /* Composite the wet layer beneath a dab region, then decay it slightly */
        function _applyWetLayer(ctx, cx, cy, sz) {
            if (!_wetCtx) return;
            const r = sz / 2 + 2;
            const x = Math.round(cx - r), y = Math.round(cy - r);
            const w = Math.round(r * 2),  h = Math.round(r * 2);
            if (w < 1 || h < 1) return;
            const wet = params.wetness / 100;
            // blend wet layer colour into the main canvas at this dab location
            ctx.save();
            ctx.globalAlpha = wet * 0.55;
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(_wetCanvas, x, y, w, h, x, y, w, h);
            ctx.restore();
        }

        /* After each dab, paint it back onto the wet canvas (accumulate).
           Decay is applied as a full-canvas pass at most once per second rather
           than as a per-dab arc fill, reducing draw calls on dense strokes. */
        function _feedWetLayer(cx, cy, sz, angleDeg, colorHex, alpha) {
            if (!_wetCtx) return;
            const wet = params.wetness / 100;
            // Throttled full-canvas decay — simulates gentle drying without a
            // per-dab arc path fill on every stamp.
            const now = performance.now();
            if (now - _wetDecayLastT >= 1000) {
                _wetDecayLastT = now;
                _wetCtx.save();
                _wetCtx.globalAlpha = 0.04;
                _wetCtx.globalCompositeOperation = 'destination-out';
                _wetCtx.fillRect(0, 0, _wetW, _wetH);
                _wetCtx.restore();
            }
            // Stamp current dab onto wet layer
            _wetCtx.save();
            _wetCtx.globalAlpha = Math.min(1, alpha * wet * 1.4);
            _wetCtx.globalCompositeOperation = 'source-over';
            const rgb = hexToRgb(colorHex);
            _wetCtx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
            _wetCtx.translate(cx, cy);
            _wetCtx.rotate(angleDeg * Math.PI / 180);
            _wetCtx.beginPath();
            _wetCtx.arc(0, 0, sz / 2, 0, TWO_PI);
            _wetCtx.fill();
            _wetCtx.restore();
        }

        /* ── 4b-ii. POLYGON-GROWTH WATERCOLOR BLOOM ─────────────────────────
           Runs once on strokeEnd when params.polyWatercolor is true.
           Algorithm:
             1. Sample strokePoints to build an outline polygon around the stroke path.
             2. Iteratively expand each polygon vertex outward with noise-perturbed
                displacement — the polygon "grows" organically outward.
             3. Each growth pass composites the polygon at very low opacity with
                colour shifted slightly toward the edge (warm/cool tinting).
             4. A final innermost pass adds a stronger core deposit.
           All compositing uses source-over at low alpha so it integrates with
           existing canvas content (the brush strokes drawn during the stroke).  */
        function _growWatercolorBloom(pts, colorHex, brushSz) {
            if (!pts || pts.length < 2) return;
            const ctx = getDrawCtx();
            const rgb = hexToRgb(colorHex);

            // ── 1. Build stroke outline polygon ──────────────────────────────
            // For each stroke point emit two vertices perpendicular to the path,
            // offset left and right by half the brush width.
            const halfW   = Math.max(6, brushSz * 0.55);
            const poly    = [];   // [{x,y}] — the outline polygon (closed loop)
            const left    = [];
            const right   = [];

            for (let i = 0; i < pts.length; i++) {
                const p    = pts[i];
                const next = pts[Math.min(i + 1, pts.length - 1)];
                const prev = pts[Math.max(i - 1, 0)];
                const dx   = next.x - prev.x;
                const dy   = next.y - prev.y;
                const len  = Math.sqrt(dx*dx + dy*dy) || 1;
                const nx   = -dy / len;
                const ny   =  dx / len;
                left.push ({ x: p.x + nx * halfW, y: p.y + ny * halfW });
                right.push({ x: p.x - nx * halfW, y: p.y - ny * halfW });
            }
            // Combine into a closed polygon: left side forward, right side backward
            for (let i = 0;            i < left.length;  i++) poly.push(left[i]);
            for (let i = right.length - 1; i >= 0; i--) poly.push(right[i]);

            // ── 2. Growth passes ──────────────────────────────────────────────
            // Each pass expands each vertex outward by a noise-perturbed amount
            // and renders the polygon at low opacity.
            const PASSES       = 7;
            const BASE_GROW    = halfW * 0.22;   // pixels to grow per pass
            const NOISE_SCALE  = 28;
            const NOISE_SEED_X = Math.random() * 1000;
            const NOISE_SEED_Y = Math.random() * 1000;

            // Working polygon — we mutate this across passes
            let wpoly = poly.map(v => ({ x: v.x, y: v.y }));

            for (let pass = 0; pass < PASSES; pass++) {
                const t         = pass / (PASSES - 1);   // 0 = innermost, 1 = outermost
                const growAmt   = BASE_GROW * (0.5 + t * 1.2);

                // Expand each vertex outward from the polygon centroid + noise
                const cx = wpoly.reduce((s, v) => s + v.x, 0) / wpoly.length;
                const cy = wpoly.reduce((s, v) => s + v.y, 0) / wpoly.length;
                const newPoly = wpoly.map(v => {
                    const dx  = v.x - cx, dy = v.y - cy;
                    const len = Math.sqrt(dx*dx + dy*dy) || 1;
                    // Noise-based perturbation — sample from the pre-built noise grid
                    const n = sampleNoise(v.x + NOISE_SEED_X, v.y + NOISE_SEED_Y, NOISE_SCALE);
                    const jitter = (n - 0.5) * growAmt * 2.2;
                    const outward = growAmt + jitter;
                    return {
                        x: v.x + (dx / len) * outward,
                        y: v.y + (dy / len) * outward,
                    };
                });

                // ── 3. Render this pass ───────────────────────────────────────
                // Opacity ramps down for outer passes (more transparent at edges)
                // and colour tints toward a slightly cooled/warm edge tone.
                const passAlpha = (1 - t) * 0.055 + 0.008;   // inner=5.5%, outer=0.8%
                // Edge colour shift: slightly desaturated & cooled at outer passes
                const edgeMix = t * 0.45;
                const er = Math.round(rgb.r * (1 - edgeMix) + 180 * edgeMix);
                const eg = Math.round(rgb.g * (1 - edgeMix) + 190 * edgeMix);
                const eb = Math.round(rgb.b * (1 - edgeMix) + 210 * edgeMix);

                ctx.save();
                ctx.globalAlpha = passAlpha;
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = 'rgb(' + er + ',' + eg + ',' + eb + ')';
                ctx.beginPath();
                ctx.moveTo(newPoly[0].x, newPoly[0].y);
                for (let i = 1; i < newPoly.length; i++) ctx.lineTo(newPoly[i].x, newPoly[i].y);
                ctx.closePath();
                ctx.fill();
                ctx.restore();

                wpoly = newPoly;
            }

            // ── 4. Strong inner core deposit ─────────────────────────────────
            // One final pass with the original (un-grown) polygon at slightly higher
            // opacity to reinforce the stroke centre the way real watercolor darkens
            // at the edge of a bead of paint.
            const coreCx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
            const coreCy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
            const corePoly = poly.map(v => {
                const dx = v.x - coreCx, dy = v.y - coreCy;
                const len = Math.sqrt(dx*dx + dy*dy) || 1;
                return { x: v.x - (dx/len) * halfW * 0.1, y: v.y - (dy/len) * halfW * 0.1 };
            });
            ctx.save();
            ctx.globalAlpha = 0.04;
            ctx.fillStyle = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';
            ctx.beginPath();
            ctx.moveTo(corePoly[0].x, corePoly[0].y);
            for (let i = 1; i < corePoly.length; i++) ctx.lineTo(corePoly[i].x, corePoly[i].y);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }

        /* ── 4c. CATMULL-ROM HELPERS ─────────────────────────────────────── */

        /* Centripetal Catmull-Rom spline (alpha=0.5).
           Parameterises knots by sqrt(chord distance), preventing cusps and loops
           when control points are unevenly spaced — exactly what happens with
           event coalescing on fast strokes.
           Zero-allocation: writes into out (or _crOut).

           ⚠️  ZERO-ALLOCATION TRAP — READ BEFORE MODIFYING ⚠️
           _crOut is a single, globally-shared object.  Every call to _crPoint()
           that does NOT pass an explicit `out` argument overwrites the SAME {x,y}.
           This means if you ever store the return value in an array:
               points.push(_crPoint(t))   // ← BUG: every element is the same ref!
           every entry in that array will silently update to the last calculated
           coordinate and your entire stroke will collapse to a single dot.
           ALWAYS clone before storing:
               const pt = _crPoint(t);  points.push({ x: pt.x, y: pt.y });
           Or pass a fresh object as the second argument:
               _crPoint(t, { x: 0, y: 0 }) */
        const _crOut = { x: 0, y: 0 };

        /* Pre-computed knot intervals shared across _crPoint and _crSegLen.
           Computing them once per segment (instead of once per _crPoint call)
           eliminates 3×(steps−1) redundant sqrt(sqrt()) evaluations per strokeMove. */
        const _crPrecomp = { t1: 0, t2: 0, t3: 0 };

        function _crPrecompute(p0, p1, p2, p3) {
            const d01 = Math.sqrt(Math.sqrt((p1.x-p0.x)*(p1.x-p0.x)+(p1.y-p0.y)*(p1.y-p0.y)));
            const d12 = Math.sqrt(Math.sqrt((p2.x-p1.x)*(p2.x-p1.x)+(p2.y-p1.y)*(p2.y-p1.y)));
            const d23 = Math.sqrt(Math.sqrt((p3.x-p2.x)*(p3.x-p2.x)+(p3.y-p2.y)*(p3.y-p2.y)));
            _crPrecomp.t1 = d01 < 1e-6 ? 1e-6 : d01;
            _crPrecomp.t2 = _crPrecomp.t1 + (d12 < 1e-6 ? 1e-6 : d12);
            _crPrecomp.t3 = _crPrecomp.t2 + (d23 < 1e-6 ? 1e-6 : d23);
            return _crPrecomp;
        }

        function _crPoint(p0, p1, p2, p3, t, out, precomp) {
            const ox = out || _crOut;

            let t1, t2, t3;
            if (precomp) {
                t1 = precomp.t1; t2 = precomp.t2; t3 = precomp.t3;
            } else {
                const d01 = Math.sqrt(Math.sqrt((p1.x-p0.x)*(p1.x-p0.x)+(p1.y-p0.y)*(p1.y-p0.y)));
                const d12 = Math.sqrt(Math.sqrt((p2.x-p1.x)*(p2.x-p1.x)+(p2.y-p1.y)*(p2.y-p1.y)));
                const d23 = Math.sqrt(Math.sqrt((p3.x-p2.x)*(p3.x-p2.x)+(p3.y-p2.y)*(p3.y-p2.y)));
                t1 = d01 < 1e-6 ? 1e-6 : d01;
                t2 = t1 + (d12 < 1e-6 ? 1e-6 : d12);
                t3 = t2 + (d23 < 1e-6 ? 1e-6 : d23);
            }

            const tm = t1 + t * (t2 - t1);

            const s10 = t1, s21 = t2-t1, s32 = t3-t2, s20 = t2, s31 = t3-t1;

            const A1x = ((t1-tm)/s10)*p0.x + (tm/s10)*p1.x;
            const A1y = ((t1-tm)/s10)*p0.y + (tm/s10)*p1.y;
            const A2x = ((t2-tm)/s21)*p1.x + ((tm-t1)/s21)*p2.x;
            const A2y = ((t2-tm)/s21)*p1.y + ((tm-t1)/s21)*p2.y;
            const A3x = ((t3-tm)/s32)*p2.x + ((tm-t2)/s32)*p3.x;
            const A3y = ((t3-tm)/s32)*p2.y + ((tm-t2)/s32)*p3.y;

            const B1x = ((t2-tm)/s20)*A1x + (tm/s20)*A2x;
            const B1y = ((t2-tm)/s20)*A1y + (tm/s20)*A2y;
            const B2x = ((t3-tm)/s31)*A2x + ((tm-t1)/s31)*A3x;
            const B2y = ((t3-tm)/s31)*A2y + ((tm-t1)/s31)*A3y;

            ox.x = ((t2-tm)/s21)*B1x + ((tm-t1)/s21)*B2x;
            ox.y = ((t2-tm)/s21)*B1y + ((tm-t1)/s21)*B2y;
            return ox;
        }

        /* Arc-length approximation — zero heap allocation via two reusable slots.
           Accepts an optional precomp from _crPrecompute() so the knot-interval
           sqrt(sqrt()) calls are paid once per segment, not once per sub-step. */
        const _crLenA = { x: 0, y: 0 }, _crLenB = { x: 0, y: 0 };
        function _crSegLen(p0, p1, p2, p3, steps, precomp) {
            const chordSq = (p2.x-p1.x)*(p2.x-p1.x)+(p2.y-p1.y)*(p2.y-p1.y);
            // Tiny chord: the CR curve barely differs from a straight line.
            // Skip the arc integration and return chord length directly.
            if (chordSq < 0.25) return Math.sqrt(chordSq);
            if (!steps) {
                steps = chordSq < 9 ? 3 : chordSq < 100 ? 6 : 10;
            }
            const pc = precomp || _crPrecompute(p0, p1, p2, p3);
            _crPoint(p0, p1, p2, p3, 0, _crLenA, pc);
            let len = 0;
            for (let i = 1; i <= steps; i++) {
                _crPoint(p0, p1, p2, p3, i / steps, _crLenB, pc);
                const dx = _crLenB.x-_crLenA.x, dy = _crLenB.y-_crLenA.y;
                len += Math.sqrt(dx*dx+dy*dy);
                _crLenA.x = _crLenB.x; _crLenA.y = _crLenB.y;
            }
            return len;
        }

        /* ── 4d. FLOW ACCUMULATION BUFFER ───────────────────────────────────── */

        /* Lazily create / resize the two full-document OffscreenCanvases used
           for the flow buffer.  Called once per stroke (if needed). */
        function _ensureFlowBufs(W, H) {
            if (_strokeBufW === W && _strokeBufH === H &&
                _strokeCanvas && _preStrokeCanvas) return;
            const make = (w, h) => {
                if (typeof OffscreenCanvas !== 'undefined')
                    return new OffscreenCanvas(w, h);
                const c = document.createElement('canvas');
                c.width = w; c.height = h; return c;
            };
            _strokeCanvas    = make(W, H);
            _strokeCtx       = _strokeCanvas.getContext('2d');
            _preStrokeCanvas = make(W, H);
            _preStrokeCtx    = _preStrokeCanvas.getContext('2d');
            _strokeBufW = W; _strokeBufH = H;
        }

        /* After every scatter-dab group, composite the stroke canvas onto the
           real canvas in the dirty region around (cx, cy, sz).
           Steps:
             1. Restore the pre-stroke snapshot in the dirty rect  →  undo any
                raw dabs that went to ctx via modes that bypass the buffer (wet,
                smudge etc. are minor exceptions and OK on ctx directly).
             2. Re-draw the accumulated stroke canvas at params.opacity.
           Result: dabs can never stack past the opacity ceiling within one stroke. */
        function _syncFlowBuf(realCtx, cx, cy, sz) {
            if (!_flowBufActive || !_preStrokeCanvas) return;
            const W   = _strokeBufW, H = _strokeBufH;
            const pad = Math.ceil(sz / 2 + params.scatterRadius + params.posJitter + 6);
            const rx  = Math.max(0, Math.floor(cx - pad));
            const ry  = Math.max(0, Math.floor(cy - pad));
            const rw  = Math.min(W - rx, Math.ceil(pad * 2 + sz + 4));
            const rh  = Math.min(H - ry, Math.ceil(pad * 2 + sz + 4));
            if (rw <= 0 || rh <= 0) return;
            // Restore pre-stroke pixels
            realCtx.drawImage(_preStrokeCanvas, rx, ry, rw, rh, rx, ry, rw, rh);
            // Overlay accumulated stroke dabs at the stroke's opacity ceiling
            realCtx.save();
            realCtx.globalAlpha = Math.min(1, params.opacity / 100);
            realCtx.globalCompositeOperation = 'source-over';
            realCtx.drawImage(_strokeCanvas, rx, ry, rw, rh, rx, ry, rw, rh);
            realCtx.restore();
        }

        /* Expand the pending dirty rect to include the bounding box of a dab at
           (cx, cy, sz).  Uses the same padding formula as _syncFlowBuf so the
           eventual flush covers exactly the region each per-dab call would have. */
        function _expandFlowDirty(cx, cy, sz) {
            if (!_flowBufActive || !_preStrokeCanvas) return;
            const W   = _strokeBufW, H = _strokeBufH;
            // sz/2 is the only per-dab variable; _flowPadBase (scatterRadius+posJitter+6)
            // is hoisted to strokeBegin so this line is now just one add + one ceil.
            const pad = Math.ceil(sz / 2 + _flowPadBase);
            const nx  = Math.max(0, Math.floor(cx - pad));
            const ny  = Math.max(0, Math.floor(cy - pad));
            const nw  = Math.min(W - nx, Math.ceil(pad * 2 + sz + 4));
            const nh  = Math.min(H - ny, Math.ceil(pad * 2 + sz + 4));
            if (nw <= 0 || nh <= 0) return;
            if (!_flowDirtyRect) {
                _flowDirtyRect = { x: nx, y: ny, w: nw, h: nh };
            } else {
                const x2 = Math.max(_flowDirtyRect.x + _flowDirtyRect.w, nx + nw);
                const y2 = Math.max(_flowDirtyRect.y + _flowDirtyRect.h, ny + nh);
                _flowDirtyRect.x = Math.min(_flowDirtyRect.x, nx);
                _flowDirtyRect.y = Math.min(_flowDirtyRect.y, ny);
                _flowDirtyRect.w = x2 - _flowDirtyRect.x;
                _flowDirtyRect.h = y2 - _flowDirtyRect.y;
            }
        }

        /* Schedule a single RAF-batched flow buffer flush.  All dabs stamped
           during the current JS turn are folded into one composite call.
           Safe to call multiple times per turn — only one RAF is queued. */
        function _scheduleFlowBufFlush(realCtx) {
            if (!_flowBufActive || !_preStrokeCanvas) return;
            _flowRAFCtx = realCtx;
            if (_flowRAFPending) return;   // already queued for this frame
            _flowRAFPending = true;
            requestAnimationFrame(function() {
                _flowRAFPending = false;
                if (!_flowDirtyRect || !_preStrokeCanvas) return;
                const r = _flowDirtyRect;
                _flowDirtyRect = null;
                const ctx = _flowRAFCtx;
                // Restore pre-stroke pixels in the dirty region
                ctx.drawImage(_preStrokeCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
                // Overlay accumulated stroke dabs at the stroke's opacity ceiling
                ctx.save();
                ctx.globalAlpha = Math.min(1, params.opacity / 100);
                ctx.globalCompositeOperation = 'source-over';
                ctx.drawImage(_strokeCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
                ctx.restore();
            });
        }

        /* ── 5. ACTIVE DRAWING CONTEXT ───────────────────────────────────── */

        function getDrawCtx() {
            const mgr = app.layerMgr;
            if (mgr && mgr.active) {
                const layer = mgr.layers[mgr.activeIdx];
                if (layer && layer.ctx) return layer.ctx;
            }
            return app.ctx;
        }

        /* ── 6. DAB RENDERER ─────────────────────────────────────────────── */

        /* ── DAB CANVAS POOL ─────────────────────────────────────────────────
           Instead of allocating a new OffscreenCanvas on every dab (which
           triggers GPU memory allocation each time), we keep a pool of
           reusable canvases bucketed by pixel size.  Borrow before a dab,
           return immediately after drawImage.  Pool is capped at 8 per size
           bucket to avoid unbounded growth.
           ─────────────────────────────────────────────────────────────────── */
        const _dabPool = new Map(); // (w<<16)|h  →  {canvas, ctx}[]

        function _borrowScratch(w, h) {
            const key  = (w << 16) | h;
            const pool = _dabPool.get(key);
            if (pool && pool.length) {
                const entry = pool.pop();
                entry.ctx.clearRect(0, 0, w, h);
                entry.canvas._poolCtx = entry.ctx;
                return entry.canvas;
            }
            const canvas = (typeof OffscreenCanvas !== 'undefined')
                ? new OffscreenCanvas(w, h)
                : (function(){ const c = document.createElement('canvas'); c.width = w; c.height = h; return c; })();
            canvas._poolCtx = canvas.getContext('2d');
            return canvas;
        }

        function _returnScratch(sc) {
            const key  = (sc.width << 16) | sc.height;
            if (!_dabPool.has(key)) _dabPool.set(key, []);
            const pool = _dabPool.get(key);
            if (pool.length < 8) pool.push({ canvas: sc, ctx: sc._poolCtx || sc.getContext('2d') });
        }
        /* Legacy alias — used by a few non-hot-path helpers (custom tip invert,
           layer merge, etc.) that don't need pooling.  New hot-path code should
           use _borrowScratch / _returnScratch instead. */
        function _makeScratch(w, h) {
            if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
            const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
        }

        /* ── TIP SOURCE ABSTRACTION ──────────────────────────────────────────
           All knowledge about *what shape to stamp* lives here.
           _getTipCanvas(sz, rgb, hardness) returns a pre-rendered OffscreenCanvas
           that is already colour-baked, greyscale-masked, or gradient-filled.
           The canvas is always iSz×iSz, centred, angle=0 (rotation applied at
           drawImage time by the callers that need it).

           Supported tip types (params.shape):
             'circle'  — soft or hard circle (gradient when hardness < 0.98)
             'square'  — axis-aligned square
             'diamond' — rotated square
             'slash'   — wide flat rectangle (calligraphy nib, angled at draw time)
             'line'    — thin flat rectangle (horizontal, angled at draw time)
             'custom'  — greyscale PNG mask; luminance→alpha, hardness falloff,
                         and invert are baked at load time by _rebakeTip() so
                         _renderTipOntoCtx is a plain two-drawImage composite.
             'bristle' — handled entirely by _paintBristleDabs; never reaches here

           Steps 2-5 of the upgrade plan add new tip types here without touching
           paintDab, _drawShape, or any other caller.
           ─────────────────────────────────────────────────────────────────── */

        /* Resolve which tip type is currently active.
           Returns a string matching the cases in _getTipCanvas. */
        function _activeTipType() {
            if (params.shape === 'custom' && params.customTipCanvas) return 'custom';
            return params.shape; // 'circle' | 'square' | 'diamond' | 'slash' | 'line'
        }

        /* Build (or return cached) a colour-baked tip stamp at the given size.
           rgb  — {r,g,b} for primitive shapes; ignored for 'custom' (colour applied
                  later via source-in in the stamp-cache fast path).
           Returns the pool canvas — callers must NOT return it to the pool; the
           stamp LRU owns it.  Use _getTipCanvasDirect for one-shot scratch use. */
        function _getTipCanvas(sz, rgb, hardness) {
            const tipType = _activeTipType();

            // Delegate to the existing LRU stamp cache for all primitive shapes.
            // Custom tips skip the cache — they are already baked at load time and
            // are trivially cheap to drawImage at any size.
            if (tipType !== 'custom') {
                return _buildDabStamp(sz, hardness, rgb, tipType);
            }

            // Custom tip: return the pre-processed canvas directly.
            // _drawShape will apply invert and colour-masking at draw time.
            return params.customTipCanvas;
        }

        /* One-shot tip render onto a scratch canvas at (ox, oy) with rotation rad.
           Used by _drawShape (slow path) so all stamp placement stays in one place.
           Caller owns the scratch canvas and must return it to the pool.
           Note: invert and hardness falloff are baked into params.customTipCanvas
           at load time by _rebakeTip(), so no per-dab processing is needed here. */
        function _renderTipOntoCtx(dctx, ox, oy, r, sz, rad, fill, hardness, useSoftGradient) {
            const tipType = _activeTipType();

            if (tipType === 'custom') {
                const tip  = params.customTipCanvas;
                const half = sz / 2;
                // Fill solid colour, then mask with pre-baked tip (already has
                // luminance, invert, and hardness falloff applied).
                dctx.fillStyle = fill;
                dctx.fillRect(ox - half, oy - half, sz, sz);
                dctx.save();
                dctx.globalCompositeOperation = 'destination-in';
                dctx.drawImage(tip, ox - half, oy - half, sz, sz);
                dctx.restore();
                return;
            }

            // Primitive shapes
            if (tipType === 'circle' && hardness < 0.98 && useSoftGradient) {
                const rgb = hexToRgb(fill);
                dctx.fillStyle = _getSoftGrad(dctx, r, hardness, rgb);
            } else {
                dctx.fillStyle = fill;
            }
            dctx.beginPath();
            if      (tipType === 'circle')  dctx.arc(ox, oy, r, 0, TWO_PI);
            else if (tipType === 'square')  dctx.rect(ox - r, oy - r, sz, sz);
            else if (tipType === 'diamond') { dctx.moveTo(ox, oy-r); dctx.lineTo(ox+r, oy); dctx.lineTo(ox, oy+r); dctx.lineTo(ox-r, oy); dctx.closePath(); }
            else if (tipType === 'slash')   dctx.rect(ox - r, oy - r * 0.22, sz, sz * 0.44);
            else if (tipType === 'line')    dctx.rect(ox - r, oy - Math.max(1, r * 0.28), sz, Math.max(2, sz * 0.56));
            else                            dctx.arc(ox, oy, r, 0, TWO_PI);
            dctx.fill();
        }

        /* ── END TIP SOURCE ABSTRACTION ───────────────────────────────────── */

        /* Helper: draw the dab shape onto any ctx, centred at (ox,oy).
           Shape selection is fully delegated to _renderTipOntoCtx so this
           function is now a thin rotation wrapper only. */
        function _drawShape(dctx, ox, oy, r, sz, rad, fill, hardness, useSoftGradient) {
            dctx.save();
            dctx.translate(ox, oy);
            dctx.rotate(rad);
            // Delegate all tip-type decisions to the abstraction layer.
            // Coordinates are now relative to the translated+rotated origin (0,0).
            _renderTipOntoCtx(dctx, 0, 0, r, sz, 0, fill, hardness, useSoftGradient);
            dctx.restore();
        }

        /* Helper: threshold all pixels in an ImageData to fully on or fully off */
        function _threshold(imgd, rgbFill, finalAlpha) {
            const d = imgd.data;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i + 3] >= 128) {
                    d[i]     = rgbFill.r;
                    d[i + 1] = rgbFill.g;
                    d[i + 2] = rgbFill.b;
                    d[i + 3] = Math.round(finalAlpha * 255);
                } else {
                    d[i + 3] = 0;
                }
            }
        }

        function paintDab(ctx, cx, cy, sz, angleDeg, colorHex, alpha) {
            if (sz < 0.5 || alpha <= 0.005) return;
            const hardness   = params.hardness / 100;
            const r          = sz / 2;
            const rad        = angleDeg * Math.PI / 180;
            const binaryMode = !!params.binaryMode;
            const smartBrush = !!params.smartBrush;
            // Binary mode forces full opacity
            const effectiveAlpha = binaryMode ? 1.0 : Math.min(1, Math.max(0, alpha));
            const useGrain       = params.texture > 0;
            const useSoft        = !binaryMode && !smartBrush;   // soft gradients only in normal mode

            // ── Smudge colour mix ─────────────────────────────────────────────
            // The smudge buffer (smudgeColor) carries picked-up canvas colour.
            // _smudgeAccum ramps from 0→1 as you drag, making the effect build
            // progressively like a finger dragging wet paint.  The user's chosen
            // smudge % is the maximum influence when fully accumulated.
            let fill = colorHex;
            if (!smartBrush && params.smudge > 0 && smudgeColor) {
                const f   = (params.smudge / 100) * _smudgeAccum;
                const base = hexToRgb(colorHex);
                fill = 'rgb(' + Math.round(base.r*(1-f)+smudgeColor.r*f) + ',' +
                                Math.round(base.g*(1-f)+smudgeColor.g*f) + ',' +
                                Math.round(base.b*(1-f)+smudgeColor.b*f) + ')';
            }

            // ── Wet layer (before dab) ────────────────────────────────────────
            if (!smartBrush && params.wetness > 0) {
                _ensureWetCanvas();
                _applyWetLayer(ctx, cx, cy, sz);
            }

            // ═══════════════════════════════════════════════════════════════════
            // MODE A: SMART BRUSH
            // Paint two concentric layers onto a scratch canvas:
            //   1. Outer ring  → c1 (outline colour)
            //   2. Inner fill  → c2 (fill colour)
            // The ring is produced by drawing the larger shape then punching out
            // the inner region with destination-out, leaving only the ring pixels.
            // We stamp fill first, then ring on top with source-over — the ring
            // is always the topmost paint and can never be covered by fill pixels
            // from subsequent overlapping dabs because ring pixels are fully opaque.
            // ═══════════════════════════════════════════════════════════════════
            if (smartBrush) {
                const thick     = Math.max(1, params.outlineThick || 3);
                const outerSz   = sz + thick * 2;
                const outerR    = outerSz / 2;
                const padded    = Math.max(1, Math.ceil(outerSz) + 4);
                const originX   = Math.round(cx - padded / 2);
                const originY   = Math.round(cy - padded / 2);
                const mid       = padded / 2;   // centre in scratch coords
                const c1        = (app.config && app.config.c1) ? app.config.c1 : '#000000';
                const c2        = (app.config && app.config.c2) ? app.config.c2 : '#ffffff';

                // ── Ring scratch canvas ────────────────────────────────────────
                const ringScratch = _borrowScratch(padded, padded);
                const ringCtx     = ringScratch._poolCtx;
                // Draw full outer shape in c1
                ringCtx.globalAlpha = 1;
                _drawShape(ringCtx, mid, mid, outerR, outerSz, rad, c1, 1, false);
                // Punch out inner region with destination-out → leaves only ring
                ringCtx.save();
                ringCtx.globalCompositeOperation = 'destination-out';
                ringCtx.globalAlpha = 1;
                _drawShape(ringCtx, mid, mid, r, sz, rad, '#000', hardness, false);
                ringCtx.restore();

                // ── Fill scratch canvas ────────────────────────────────────────
                const fillScratch = _borrowScratch(padded, padded);
                const fillCtx     = fillScratch._poolCtx;
                _drawShape(fillCtx, mid, mid, r, sz, rad, c2, hardness, false);

                // If binaryMode also threshold both layers
                if (binaryMode) {
                    const ri = ringCtx.getImageData(0, 0, padded, padded);
                    _threshold(ri, hexToRgb(c1), 1);
                    ringCtx.putImageData(ri, 0, 0);
                    const fi = fillCtx.getImageData(0, 0, padded, padded);
                    _threshold(fi, hexToRgb(c2), 1);
                    fillCtx.putImageData(fi, 0, 0);
                }

                // ── Stamp onto main canvas: fill first, then ring on top ───────
                // Using source-over for both — the ring paints over fill pixels
                // it overlaps, and because it's always stamped last it permanently
                // owns those pixels. A subsequent dab's fill is also stamped before
                // its own ring, so it can never overwrite a prior ring pixel because
                // the ring paint that follows it will repaint the ring boundary.
                ctx.save();
                ctx.globalAlpha = effectiveAlpha;
                ctx.drawImage(fillScratch, originX, originY);
                ctx.restore();
                ctx.save();
                ctx.globalAlpha = effectiveAlpha;
                ctx.drawImage(ringScratch, originX, originY);
                ctx.restore();
                _returnScratch(fillScratch);
                _returnScratch(ringScratch);

                // Smudge pickup after smart dab — throttled to 50 ms like the normal path.
                // Previously unthrottled: every dab fired getImageData, stalling the GPU pipeline.
                if (params.smudge > 0) {
                    const _smudgeNow = performance.now();
                    if (_smudgeNow - _lastSmudgeTime >= 50) {
                        _lastSmudgeTime = _smudgeNow;
                        try {
                            const W = app.config.width, H = app.config.height;
                            // Cap at 20px: reduces max read from 64×64=4096 px to 40×40=1600 px.
                            const sampleR = Math.max(4, Math.min(20, Math.round(sz * 0.45)));
                            const sampleD = sampleR * 2;
                            const sx = Math.max(0, Math.min(W-sampleD, Math.round(cx)-sampleR));
                            const sy = Math.max(0, Math.min(H-sampleD, Math.round(cy)-sampleR));
                            const smudgeSrc = (_flowBufActive && _preStrokeCtx) ? _preStrokeCtx : ctx;
                            const d  = smudgeSrc.getImageData(sx, sy, sampleD, sampleD).data;
                            let rr=0,gg=0,bb=0,cnt=0;
                            // Sample every other pixel (stride 8) — halves loop iterations with
                            // negligible colour accuracy loss on an averaged region.
                            for (let i=0;i<d.length;i+=8) { if(d[i+3]>8){rr+=d[i];gg+=d[i+1];bb+=d[i+2];cnt++;} }
                            if (cnt>0) {
                                const picked = {r:rr/cnt,g:gg/cnt,b:bb/cnt};
                                if (!smudgeColor) { smudgeColor = picked; }
                                else { const l=0.35; smudgeColor.r=smudgeColor.r*(1-l)+picked.r*l; smudgeColor.g=smudgeColor.g*(1-l)+picked.g*l; smudgeColor.b=smudgeColor.b*(1-l)+picked.b*l; }
                                _smudgeAccum = Math.min(1, _smudgeAccum + 0.12);
                            }
                        } catch(_) {}
                    }
                }
                return;
            }

            // ═══════════════════════════════════════════════════════════════════
            // MODE B: BINARY (no smart brush)
            // GPU-only path: two compositing passes produce hard on/off edges
            // without any CPU readback (no getImageData / putImageData).
            //
            // Pass 1 – draw the shape with hardness=1 (fully hard arc, no gradient).
            //          Sub-pixel AA fringe pixels will have partial alpha.
            // Pass 2 – source-in fill: paint the target colour over every pixel
            //          that landed inside the shape, preserving its alpha exactly.
            // Pass 3 – destination-in with a solid white rect drawn at threshold
            //          alpha (0.5): the '2d' canvas spec rounds destination alpha
            //          multiplied by source alpha, so pixels below ~50% alpha are
            //          zeroed and pixels above survive at full colour.  This snaps
            //          the AA fringe to hard 0 or 255 entirely on the GPU.
            // ═══════════════════════════════════════════════════════════════════
            if (binaryMode) {
                const iSz      = Math.max(1, Math.ceil(sz) + 4);
                const scratchX = Math.round(cx - iSz / 2);
                const scratchY = Math.round(cy - iSz / 2);
                const sc       = _borrowScratch(iSz, iSz);
                const sctx     = sc._poolCtx;

                // Pass 1: draw shape with forced hard edge (no soft gradient)
                sctx.globalAlpha = 1;
                _drawShape(sctx, iSz/2, iSz/2, r, sz, rad, fill, /*hardness*/1, /*useSoftGradient*/false);

                // Pass 2: replace colour of every pixel that survived, keeping alpha
                sctx.save();
                sctx.globalCompositeOperation = 'source-in';
                sctx.fillStyle = fill;
                sctx.fillRect(0, 0, iSz, iSz);
                sctx.restore();

                // Pass 3: snap partial-alpha AA fringe — destination-in with a rect
                // drawn at exactly 0.502 globalAlpha.  The compositing formula
                // (dst.a * src.a) means fringe pixels with alpha < 0.498 collapse
                // to 0, pixels fully inside (alpha ≈ 1) survive at ≈ 1.  This is
                // a pure GPU threshold with no CPU stall.
                sctx.save();
                sctx.globalCompositeOperation = 'destination-in';
                sctx.globalAlpha = 0.502;
                sctx.fillStyle = '#ffffff';
                sctx.fillRect(0, 0, iSz, iSz);
                sctx.restore();

                ctx.drawImage(sc, scratchX, scratchY);
                _returnScratch(sc);
                // Smudge pickup — throttled to 50 ms like the normal path.
                // Previously unthrottled: every binary-mode dab fired getImageData.
                if (params.smudge > 0) {
                    const _smudgeNow = performance.now();
                    if (_smudgeNow - _lastSmudgeTime >= 50) {
                        _lastSmudgeTime = _smudgeNow;
                        try {
                            const W = app.config.width, H = app.config.height;
                            const sampleR = Math.max(4, Math.min(20, Math.round(sz * 0.45)));
                            const sampleD = sampleR * 2;
                            const sx = Math.max(0, Math.min(W-sampleD, Math.round(cx)-sampleR));
                            const sy = Math.max(0, Math.min(H-sampleD, Math.round(cy)-sampleR));
                            const smudgeSrc = (_flowBufActive && _preStrokeCtx) ? _preStrokeCtx : ctx;
                            const d  = smudgeSrc.getImageData(sx, sy, sampleD, sampleD).data;
                            let rr=0,gg=0,bb=0,cnt=0;
                            for (let i=0;i<d.length;i+=8) { if(d[i+3]>8){rr+=d[i];gg+=d[i+1];bb+=d[i+2];cnt++;} }
                            if (cnt>0) {
                                const picked = {r:rr/cnt,g:gg/cnt,b:bb/cnt};
                                if (!smudgeColor) { smudgeColor = picked; }
                                else { const l=0.35; smudgeColor.r=smudgeColor.r*(1-l)+picked.r*l; smudgeColor.g=smudgeColor.g*(1-l)+picked.g*l; smudgeColor.b=smudgeColor.b*(1-l)+picked.b*l; }
                                _smudgeAccum = Math.min(1, _smudgeAccum + 0.12);
                            }
                        } catch(_) {}
                    }
                }
                return;
            }


            // ═══════════════════════════════════════════════════════════════════
            // MODE C: NORMAL (original AA path)
            // Render shape + grain onto a scratch canvas so destination-out grain
            // only erodes the fresh dab, not existing canvas content.
            // ═══════════════════════════════════════════════════════════════════

            // ── MODE C FAST PATH (stamp cache) ───────────────────────────────
            // When grain is off and the shape is a standard primitive (no custom
            // tip, no jitter that mutates fill mid-stroke), the dab bitmap is
            // identical for every stamp.  We build a color-baked stamp once per
            // distinct (size × hardness × color × shape) combination — a single
            // drawImage blit per dab with no scratch allocation at all.
            //
            // COLOR STRATEGY:
            //   • No color jitter (_baseHsl null): fill is constant for the whole
            //     stroke — bake it directly into the stamp (rgb variant).
            //   • Color jitter active: fill changes per dab — bake a white stamp
            //     and composite fill via source-in onto a per-dab scratch canvas
            //     (two blits vs arc+gradient, still a big win over mode C slow path).
            {
                // Custom tips bypass the stamp cache (rendered via _drawShape slow path).
                // Future tip types that can be pre-baked should set canUseStamp = true.
                const canUseStamp = !useGrain && _activeTipType() !== 'custom';

                if (canUseStamp) {
                    const iSz    = Math.max(1, Math.ceil(sz) + 4);
                    const half   = iSz / 2;
                    const originX = Math.round(cx - half);
                    const originY = Math.round(cy - half);

                    if (!_baseHsl) {
                        // ── ULTRA FAST PATH: baked-color single-blit ─────────────
                        // No jitter → same rgb every dab → stamp carries the real colour.
                        // One drawImage to ctx (and _strokeCtx). Zero scratch allocation.
                        const _tipType = _activeTipType();
                        const stamp = _buildDabStamp(sz, hardness, rgb, _tipType);

                        if (rad !== 0 && _tipType !== 'circle') {
                            // Asymmetric shape: need a rotated copy — borrow a scratch,
                            // rotate-blit the stamp, draw, return. Still only one blit to ctx.
                            const tsc  = _borrowScratch(iSz, iSz);
                            const tctx = tsc._poolCtx;
                            tctx.save();
                            tctx.setTransform(Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), half, half);
                            tctx.drawImage(stamp, -half, -half);
                            tctx.restore();

                            const _pa = ctx.globalAlpha;
                            ctx.globalAlpha = effectiveAlpha;
                            ctx.drawImage(tsc, originX, originY);
                            ctx.globalAlpha = _pa;

                            if (_flowBufActive && _strokeCtx) {
                                const flowAlpha = Math.min(1, effectiveAlpha / Math.max(0.01, params.opacity / 100));
                                const _spa = _strokeCtx.globalAlpha;
                                _strokeCtx.globalAlpha = flowAlpha;
                                _strokeCtx.drawImage(tsc, originX, originY);
                                _strokeCtx.globalAlpha = _spa;
                            }
                            _returnScratch(tsc);
                        } else {
                            // Circle or angle=0: stamp is already correct — pure single blit.
                            const _pa = ctx.globalAlpha;
                            ctx.globalAlpha = effectiveAlpha;
                            ctx.drawImage(stamp, originX, originY);
                            ctx.globalAlpha = _pa;

                            if (_flowBufActive && _strokeCtx) {
                                const flowAlpha = Math.min(1, effectiveAlpha / Math.max(0.01, params.opacity / 100));
                                const _spa = _strokeCtx.globalAlpha;
                                _strokeCtx.globalAlpha = flowAlpha;
                                _strokeCtx.drawImage(stamp, originX, originY);
                                _strokeCtx.globalAlpha = _spa;
                            }
                        }

                    } else {
                        // ── JITTER PATH: white stamp + per-dab source-in tint ────
                        // Color changes each dab; tint a white stamp with source-in.
                        const _tipType = _activeTipType();
                        const stamp = _buildDabStamp(sz, hardness, _WHITE_RGB, _tipType);
                        const tsc   = _borrowScratch(iSz, iSz);
                        const tctx  = tsc._poolCtx;
                        if (rad !== 0 && _tipType !== 'circle') {
                            tctx.save();
                            tctx.setTransform(Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), half, half);
                            tctx.drawImage(stamp, -half, -half);
                            tctx.restore();
                        } else {
                            tctx.drawImage(stamp, 0, 0);
                        }
                        tctx.globalCompositeOperation = 'source-in';
                        tctx.fillStyle = fill;
                        tctx.fillRect(0, 0, iSz, iSz);
                        tctx.globalCompositeOperation = 'source-over';

                        const _pa = ctx.globalAlpha;
                        ctx.globalAlpha = effectiveAlpha;
                        ctx.drawImage(tsc, originX, originY);
                        ctx.globalAlpha = _pa;

                        if (_flowBufActive && _strokeCtx) {
                            const flowAlpha = Math.min(1, effectiveAlpha / Math.max(0.01, params.opacity / 100));
                            const _spa = _strokeCtx.globalAlpha;
                            _strokeCtx.globalAlpha = flowAlpha;
                            _strokeCtx.drawImage(tsc, originX, originY);
                            _strokeCtx.globalAlpha = _spa;
                        }
                        _returnScratch(tsc);
                    }
                    // Fall through to wet layer / smudge below
                } else {

                const pad     = 2;
                const iSz     = Math.max(1, Math.ceil(sz) + pad * 2);
                const originX = Math.round(cx - iSz / 2);
                const originY = Math.round(cy - iSz / 2);
                const mid     = iSz / 2;

                const sc   = _borrowScratch(iSz, iSz);
                const sctx = sc._poolCtx;

                // Route through _drawShape so the 'custom' tip branch is reached
                _drawShape(sctx, mid, mid, r, sz, rad, fill, hardness, !binaryMode && hardness < 0.98);

                // Grain destination-out: only touches globalAlpha + compositeOp on scratch ctx
                if (useGrain) {
                    const grainCanvas = _getGrainCanvas(sz, params.grainScale, angleDeg);
                    const gSz = Math.max(1, Math.ceil(sz));
                    const _ga = sctx.globalAlpha, _gc = sctx.globalCompositeOperation;
                    sctx.globalAlpha = (params.texture / 100) * 0.85;
                    sctx.globalCompositeOperation = 'destination-out';
                    sctx.drawImage(grainCanvas, pad, pad, gSz, gSz);
                    sctx.globalAlpha = _ga;
                    sctx.globalCompositeOperation = _gc;
                }

                // ── 2c-2: Per-dab grain modulator ────────────────────────────────
                // Sample the noise field at the dab's world-space coordinates and
                // scale the entire dab's globalAlpha by the result.  This creates
                // macro-level breakup — some dabs land dimmer, others brighter —
                // that compounds with the intra-dab pixel erosion from 2c-1 for a
                // genuinely organic paper-grain feel.  Strength is proportional to
                // params.texture so the effect is zero when grain is off and
                // reaches full modulation at texture = 100.
                let dabAlpha = effectiveAlpha;
                if (useGrain) {
                    const noiseVal = sampleNoise(cx, cy, params.grainScale); // 0..1
                    const t        = params.texture / 100;
                    // Lerp between 1 (no change) and noiseVal (full modulation)
                    // so low texture values barely touch the alpha.
                    dabAlpha = effectiveAlpha * (1 - t + t * noiseVal);
                }

                const _pa = ctx.globalAlpha;
                ctx.globalAlpha = dabAlpha;
                ctx.drawImage(sc, originX, originY);
                ctx.globalAlpha = _pa;

                // ── Flow buffer: also stamp dab onto the stroke accumulation canvas ──
                // When active, the real composite to ctx happens in _syncFlowBuf().
                // Here we put the dab on _strokeCtx at flow-only alpha (opacity is
                // applied later as the ceiling during composite).
                if (_flowBufActive && _strokeCtx) {
                    // Strip opacity out of dabAlpha, leaving only the flow component.
                    // dabAlpha already carries grain modulation; dividing by opacity
                    // isolates the flow fraction so the stroke ceiling is respected.
                    const opacityScale = Math.max(0.01, params.opacity / 100);
                    const flowAlpha    = Math.min(1, dabAlpha / opacityScale);
                    const _spa = _strokeCtx.globalAlpha;
                    _strokeCtx.globalAlpha = flowAlpha;
                    _strokeCtx.drawImage(sc, originX, originY);
                    _strokeCtx.globalAlpha = _spa;
                }
                _returnScratch(sc);
                } // end else (full scratch path)
            }

            // ── Feed wet layer ────────────────────────────────────────────────
            if (params.wetness > 0) {
                _feedWetLayer(cx, cy, sz, angleDeg, fill, alpha);
            }

            // ── Smudge pickup — multi-bucket spatial system ───────────────────
            // Inspired by libmypaint's smudge bucket array.  We maintain N_SMUDGE_BUCKETS
            // spatial samples taken at evenly-spaced offsets across the brush width,
            // perpendicular to the local stroke direction (_dirDX/_dirDY).
            // One bucket is updated per dab-group (round-robin, throttled to 50ms)
            // so cost is always one getImageData, regardless of bucket count.
            // The bucket average is used in paintDab's fill mix — giving the illusion
            // that different parts of the brush edge pick up different canvas colours.
            if (params.smudge > 0) {
                const _smudgeNow = performance.now();
                if (_smudgeNow - _lastSmudgeTime >= 50) {
                    _lastSmudgeTime = _smudgeNow;
                    _smudgeSampleDist = 0;
                    const W  = app.config.width, H = app.config.height;
                    const sampleR = Math.max(4, Math.min(20, Math.round(sz * 0.45)));

                    // Compute offset for this bucket slot along the perpendicular axis.
                    // Buckets span [-spread, +spread] across brush width (0.4 × sz).
                    const spread    = sz * 0.4;
                    const bidx      = _smudgeBucketIdx % N_SMUDGE_BUCKETS;
                    const bucketT   = N_SMUDGE_BUCKETS > 1
                        ? (bidx / (N_SMUDGE_BUCKETS - 1)) * 2 - 1   // −1..+1
                        : 0;
                    // Perpendicular direction from filtered stroke angle
                    const dirLen = Math.sqrt(_dirDX * _dirDX + _dirDY * _dirDY) || 1;
                    const perpX  = -_dirDY / dirLen;
                    const perpY  =  _dirDX / dirLen;
                    const bx = cx + perpX * bucketT * spread;
                    const by = cy + perpY * bucketT * spread;

                    const picked = _sampleSmudgeBucket(ctx, bx, by, sampleR, W, H);
                    if (picked) {
                        if (_smudgeBuckets.length < N_SMUDGE_BUCKETS) {
                            _smudgeBuckets.push(picked);
                        } else {
                            _smudgeBuckets[bidx] = picked;
                        }
                        _smudgeBucketIdx++;
                        // Keep legacy smudgeColor in sync (scalar average of all buckets)
                        smudgeColor = _getSmudgeColor(params.smudge);
                    }
                    _smudgeAccum = Math.min(1, _smudgeAccum + 0.12);
                }
            }
        }

        function scatterDabs(ctx, cx, cy, sz, angleDeg, colorHex, alpha, t_fade) {
            // Bristle mode: replace the single dab with N lateral fiber strands
            if (_activeTipType() === 'bristle') {
                _paintBristleDabs(ctx, cx, cy, sz, angleDeg, colorHex, alpha);
                return;
            }
            // Main dab always goes through paintDab (handles smudge, taper, flow buf, etc.)
            paintDab(ctx, cx, cy, sz, angleDeg, colorHex, alpha);
            if (params.scatter > 0) {
                // Pre-compute base HSL once for all scatter particles
                const _sNeedsJitter = !!(params.hueJitter || params.satJitter || params.briJitter || params.colorFade);
                let _sBaseHsl = null;
                if (_sNeedsJitter) {
                    const _sRgb = hexToRgb(colorHex);
                    _sBaseHsl = rgbToHsl(_sRgb.r, _sRgb.g, _sRgb.b);
                }

                // ── SCATTER BATCH PATH ────────────────────────────────────────────
                // When grain is active every per-dab scatter call goes through Mode C:
                // scratch canvas + destination-out composite = one GPU pipeline flush
                // per sub-dab.  Instead, composite all scatter sub-dabs into a single
                // group canvas, apply destination-out grain ONCE across the group, then
                // blit the whole thing with two drawImage calls.
                // GPU flushes: scatter × Mode-C  →  1, regardless of scatter count.
                const useGrain = params.texture > 0;
                if (useGrain) {
                    const hardness   = params.hardness / 100;
                    const binaryMode = !!params.binaryMode;
                    const tFrac      = params.texture / 100;

                    // Group canvas must contain every possible scatter sub-dab:
                    // a dab of width sz can land up to scatterRadius from center.
                    const batchPad = Math.ceil(sz / 2 + params.scatterRadius + sz / 2) + 6;
                    const batchSz  = batchPad * 2;
                    const originX  = Math.round(cx - batchPad);
                    const originY  = Math.round(cy - batchPad);

                    const bc   = _borrowScratch(batchSz, batchSz);
                    const bctx = bc._poolCtx;

                    // Replicate smudge colour mix from paintDab so sub-dabs look
                    // consistent with the main dab drawn above.
                    let smudgedFill = colorHex;
                    if (params.smudge > 0 && smudgeColor) {
                        const f    = (params.smudge / 100) * _smudgeAccum;
                        const base = hexToRgb(colorHex);
                        smudgedFill = 'rgb(' +
                            Math.round(base.r * (1 - f) + smudgeColor.r * f) + ',' +
                            Math.round(base.g * (1 - f) + smudgeColor.g * f) + ',' +
                            Math.round(base.b * (1 - f) + smudgeColor.b * f) + ')';
                    }

                    // Draw each scatter sub-dab into the group canvas at its own alpha.
                    // Per-dab noise modulation (macro grain breakup) is applied here
                    // so individual sub-dabs still vary in brightness before the
                    // collective grain pass.
                    for (let i = 0; i < params.scatter; i++) {
                        const a    = Math.random() * TWO_PI;
                        const d    = Math.random() * params.scatterRadius;
                        const dsz  = sz * (0.25 + Math.random() * 0.75);
                        const dal  = alpha * (0.3 + Math.random() * 0.55);
                        const dang = angleDeg + (Math.random() - 0.5) * 2 * params.angleJitter;
                        const drad = dang * Math.PI / 180;
                        const sc   = _sBaseHsl ? _jitterFromHsl(_sBaseHsl, t_fade) : smudgedFill;

                        // Macro noise modulator — world-space coords of this sub-dab
                        const noiseVal = sampleNoise(cx + Math.cos(a) * d, cy + Math.sin(a) * d, params.grainScale);
                        const noiseMod = 1 - tFrac + tFrac * noiseVal;

                        bctx.globalAlpha = dal * noiseMod;
                        _drawShape(bctx,
                            batchPad + Math.cos(a) * d,
                            batchPad + Math.sin(a) * d,
                            dsz / 2, dsz, drad, sc,
                            hardness, !binaryMode && hardness < 0.98);
                    }

                    // ── Apply grain destination-out ONCE to the whole group ───────
                    const grainCanvas = _getGrainCanvas(sz, params.grainScale, angleDeg);
                    const _gc = bctx.globalCompositeOperation;
                    bctx.globalAlpha = tFrac * 0.85;
                    bctx.globalCompositeOperation = 'destination-out';
                    bctx.drawImage(grainCanvas, 0, 0, batchSz, batchSz);
                    bctx.globalCompositeOperation = _gc;
                    bctx.globalAlpha = 1;

                    // ── Single blit to ctx (dab alphas baked into group canvas) ──
                    const _pa = ctx.globalAlpha;
                    ctx.globalAlpha = 1;
                    ctx.drawImage(bc, originX, originY);
                    ctx.globalAlpha = _pa;

                    // ── Single blit to flow buffer if active ─────────────────────
                    // Multiply by 1/opacityScale to strip the opacity ceiling component,
                    // matching the per-dab flowAlpha logic in paintDab.
                    if (_flowBufActive && _strokeCtx) {
                        const opacityScale = Math.max(0.01, params.opacity / 100);
                        const _spa = _strokeCtx.globalAlpha;
                        _strokeCtx.globalAlpha = Math.min(1, 1 / opacityScale);
                        _strokeCtx.drawImage(bc, originX, originY);
                        _strokeCtx.globalAlpha = _spa;
                    }

                    _returnScratch(bc);
                    return;
                }

                // ── NO-GRAIN SCATTER BATCH PATH ───────────────────────────────────
                // Previously: called paintDab() for each sub-dab, which ran the full
                // mode-dispatch, wet-layer, and smudge-pickup pipeline N times.
                // Now: composite all sub-dabs onto a single group canvas (same approach
                // as the grain-batch path above), then blit once to ctx and _strokeCtx.
                // GPU flushes: N × paintDab overhead  →  1 drawImage each.
                // Smudge pickup: N × throttle check → 0 (the main dab above already
                // handles pickup; sub-dabs carry the already-mixed fill colour).
                const nbatchPad = Math.ceil(sz / 2 + params.scatterRadius + sz / 2) + 6;
                const nbatchSz  = nbatchPad * 2;
                const noriginX  = Math.round(cx - nbatchPad);
                const noriginY  = Math.round(cy - nbatchPad);

                const nbc   = _borrowScratch(nbatchSz, nbatchSz);
                const nbctx = nbc._poolCtx;

                const nhardness   = params.hardness / 100;
                const nbinaryMode = !!params.binaryMode;

                // Replicate smudge colour mix so sub-dabs match the main dab.
                let nsmudgedFill = colorHex;
                if (params.smudge > 0 && smudgeColor) {
                    const nf    = (params.smudge / 100) * _smudgeAccum;
                    const nbase = hexToRgb(colorHex);
                    nsmudgedFill = 'rgb(' +
                        Math.round(nbase.r * (1 - nf) + smudgeColor.r * nf) + ',' +
                        Math.round(nbase.g * (1 - nf) + smudgeColor.g * nf) + ',' +
                        Math.round(nbase.b * (1 - nf) + smudgeColor.b * nf) + ')';
                }

                for (let i = 0; i < params.scatter; i++) {
                    const na    = Math.random() * TWO_PI;
                    const nd    = Math.random() * params.scatterRadius;
                    const ndsz  = sz * (0.25 + Math.random() * 0.75);
                    const ndal  = alpha * (0.3 + Math.random() * 0.55);
                    const ndang = angleDeg + (Math.random() - 0.5) * 2 * params.angleJitter;
                    const ndrad = ndang * Math.PI / 180;
                    const nsc   = _sBaseHsl ? _jitterFromHsl(_sBaseHsl, t_fade) : nsmudgedFill;

                    nbctx.globalAlpha = ndal;
                    _drawShape(nbctx,
                        nbatchPad + Math.cos(na) * nd,
                        nbatchPad + Math.sin(na) * nd,
                        ndsz / 2, ndsz, ndrad, nsc,
                        nhardness, !nbinaryMode && nhardness < 0.98);
                }

                // Single blit to real canvas (sub-dab alphas already baked into group canvas)
                const _npa = ctx.globalAlpha;
                ctx.globalAlpha = 1;
                ctx.drawImage(nbc, noriginX, noriginY);
                ctx.globalAlpha = _npa;

                // Single blit to flow buffer if active
                if (_flowBufActive && _strokeCtx) {
                    const nopacityScale = Math.max(0.01, params.opacity / 100);
                    const _nspa = _strokeCtx.globalAlpha;
                    _strokeCtx.globalAlpha = Math.min(1, 1 / nopacityScale);
                    _strokeCtx.drawImage(nbc, noriginX, noriginY);
                    _strokeCtx.globalAlpha = _nspa;
                }

                _returnScratch(nbc);
            }
        }

        /* Bristle brush: paint N independent fiber strands for one dab group.
           cx/cy is the stroke centreline position. Each strand is offset laterally
           (perpendicular to the stroke direction) by its baked-in lateralFrac,
           scaled by bristleSpread and the current brush size.

           FAST PATH — strands are drawn directly onto ctx as thin fillRects with
           a single save/restore per strand.  We never call paintDab here, which
           previously allocated a full scratch OffscreenCanvas for every strand
           (up to 20 allocations per dab group).  fillStyle is set once outside
           the loop; only globalAlpha and rotate vary per strand. */
        function _paintBristleDabs(ctx, cx, cy, sz, angleDeg, colorHex, alpha) {
            if (!_bristleStrands.length) return;
            const spread  = (params.bristleSpread / 100) * sz * 0.5;
            const rad     = angleDeg * Math.PI / 180;
            // Precompute once — reused for both perpendicular offset AND strand transforms.
            const cosRad  = Math.cos(rad);
            const sinRad  = Math.sin(rad);
            // Perpendicular direction (rotate stroke angle 90°)
            const perpX   = -sinRad;
            const perpY   =  cosRad;
            const N       = _bristleStrands.length;
            const strandW = Math.max(1, sz / N * 1.6);

            // Resolve fill colour once per dab group (jitter shifts hue/sat/bri
            // per group, not per strand — individual strands get alpha variation
            // from their baked-in alphaScale instead).
            const groupColor = jitterColor(colorHex, 0);

            ctx.save();
            ctx.fillStyle = groupColor;   // set once for all strands

            for (let i = 0; i < N; i++) {
                const s         = _bristleStrands[i];
                const lat       = (s.lateralFrac + s.wobble) * spread;
                const sx2       = cx + perpX * lat;
                const sy2       = cy + perpY * lat;
                const sw        = strandW * s.sizeScale;
                const sh        = Math.max(2, sw * 0.56);

                // Per-strand angular jitter, capped at ±0.0525 rad (±3°).
                // At such small angles the linear approximation
                //   cos(θ+δ) ≈ cos(θ) − δ·sin(θ)
                // has error < 0.0001 (well below sub-pixel) so we avoid two
                // Math.cos/sin calls per strand without sacrificing visual quality.
                const delta     = (Math.random() - 0.5) * 0.105;
                const cosS      = cosRad - delta * sinRad;
                const sinS      = sinRad + delta * cosRad;

                ctx.globalAlpha = Math.min(1, Math.max(0, alpha * s.alphaScale));
                ctx.setTransform(cosS, sinS, -sinS, cosS, sx2, sy2);
                ctx.fillRect(-sw / 2, -sh / 2, sw, sh);
            }

            ctx.restore();
        }

        /* ── 7. SIZE COMPUTATION ─────────────────────────────────────────── */

        /* ── 7b. SMOOTH SPEED STATE ──────────────────────────────────────── */

        // ── Libmypaint-style lowpass filter states ────────────────────────────
        // libmypaint uses:  fac = exp(-dt/T);  output = fac*output + (1-fac)*input
        // This is time-correct: a 16ms frame and a 32ms frame produce the same
        // filtered result for the same T, unlike a fixed α EMA which doesn't.
        //
        // speed1: fine (short time constant) — reacts quickly to bursts
        // speed2: gross (long time constant)  — tracks overall stroke pace
        // These mirror libmypaint's NORM_SPEED1_SLOW / NORM_SPEED2_SLOW states.
        let _speed1Slow   = 0;   // lowpass of normalised speed (T1 ≈ 0.04 s)
        let _speed2Slow   = 0;   // lowpass of normalised speed (T2 ≈ 0.20 s)
        let _smoothSpeed  = 0;   // legacy alias kept for computeSize() — mirrors _speed1Slow
        // direction filter — prevents abrupt 180° angle flips on tiny wiggles
        // libmypaint calls this DIRECTION_ANGLE with its own filter time constant
        let _dirDX        = 0;   // lowpass of stroke delta-X (T ≈ 0.10 s)
        let _dirDY        = 0;   // lowpass of stroke delta-Y
        // pressure filter — raw stylus pressure is noisy; libmypaint filters it
        let _pressureSlow = 1;   // lowpass of pressure (T ≈ 0.05 s)
        // stroke progress input (0→1) — libmypaint's STROKE state.
        // Unlike _strokeDist/2000 this is dab-count-relative, not distance-relative,
        // so it saturates at the same rate regardless of brush size or spacing.
        let _strokeDabCount = 0;
        // Reference dab count at which stroke input reaches 1.0 (tunable).
        const STROKE_INPUT_DABS = 80;

        let _strokeDist    = 0;   // total distance drawn this stroke
        let _strokeEndDist = -1;  // distance at mouseup (-1 = still drawing)
        let _strokePoints  = [];  // lightweight ring of recent (x,y,t) for smooth end-taper

        // ── Lazy Needle Stabilizer state ─────────────────────────────────────
        let _lazyX        = 0;   // current position of the "lazy" trailing point
        let _lazyY        = 0;
        let _realX        = 0;   // actual cursor position (target the lazy point chases)
        let _realY        = 0;
        let _lazyRAF      = 0;   // requestAnimationFrame handle for catch-up loop
        let _lazyActive   = false; // true while a stabilized stroke is in progress

        /* Compute dab size at a given point in the stroke.
           - progressT : 0→1 over the full stroke distance, drives startSize→endSize blend
           - taperT    : 0→1 over just the taper-in phase at stroke start
           - endTaperT : 0→1 for the tail taper triggered on mouse-up (0 while drawing)
           - speed     : smoothed px/ms                                           */
        function computeSize(progressT, taperT, endTaperT, speed) {
            // Base: blend from startSize at stroke start toward endSize at stroke end
            let sz = params.startSize + (params.endSize - params.startSize) * progressT;

            // Taper-in: small at the very start, ramps to full over taper zone
            if (params.taper > 0) {
                sz *= taperT;
            }

            // Taper-out: commissioned on mouse-up — size shrinks back toward 1px at tip
            if (endTaperT > 0) {
                sz *= Math.max(0.04, 1 - endTaperT);
            }

            // Speed → Size: smoothed speed drives size up or down
            if (params.speedSize !== 0) {
                // Normalise speed: 0 = stopped, 1 = "normal" (~0.3 px/ms), 2+ = fast
                const normSpeed = Math.min(4, speed / 0.3);
                const influence = params.speedSize / 100;
                // influence > 0: fast = bigger; influence < 0: fast = smaller
                sz *= Math.max(0.05, 1 + influence * (normSpeed - 1));
            }

            if (params.sizeJitter > 0)
                sz *= 1 + (Math.random() - 0.5) * (params.sizeJitter / 50);

            return Math.max(0.5, sz);
        }

        /* ── 8. STROKE LIFECYCLE ─────────────────────────────────────────── */

        function strokeBegin(x, y, hexColor) {
            // Cancel any in-flight end-taper animation from a previous stroke
            if (_endTaperRAF) { cancelAnimationFrame(_endTaperRAF); _endTaperRAF = 0; }

            strokeActive    = true;
            lastDabX        = x; lastDabY = y;
            residualDist    = 0;
            strokeLength    = 0;
            _strokeDist     = 0;
            _strokeEndDist  = -1;
            _strokePoints   = [{ x, y, d: 0 }];
            prevT           = performance.now();
            // Reset libmypaint-style filter states
            _speed1Slow     = 0;
            _speed2Slow     = 0;
            _smoothSpeed    = 0;
            _dirDX          = 0;
            _dirDY          = 0;
            _pressureSlow   = 1;
            _strokeDabCount = 0;
            _smudgeAccum      = 0;
            _smudgeSampleDist = 0;
            _resetSmudgeBuckets();

            // Reseed grain texture each stroke so charcoal/texture brushes feel
            // alive rather than repeating the same static pattern forever.
            if (params.texture > 0) {
                _noiseData  = null;   // forces _buildNoise() on next dab
                _grainCache = null;   // forces rebuild with new random seed
            }

            // Cache the constant part of the flow dirty-rect pad for this stroke.
            _flowPadBase = params.scatterRadius + params.posJitter + 6;
            _gradCacheKey = '';
            _gradCacheCtx = null;
            _gradCacheVal = null;

            // Clear the dab stamp LRU — colour / size / shape may all change between
            // strokes, so we flush entirely to avoid stale stamps.
            while (_dabStampLRU.length) { _returnScratch(_dabStampLRU.pop().canvas); }
            _dabStampBytes = 0;
            _stampMRU = null;   // MRU entry now points to a returned canvas — must clear

            // Seed Catmull-Rom ring buffer — fill all 4 slots with the start point
            // so p0=p1=p2=start gives zero-length phantom segments until real moves arrive.
            _crBuf[0].x = _crBuf[1].x = _crBuf[2].x = _crBuf[3].x = x;
            _crBuf[0].y = _crBuf[1].y = _crBuf[2].y = _crBuf[3].y = y;
            _crHead = 0;   // next write goes to slot 0

            // Ensure wet canvas exists at current document size
            if (params.wetness > 0) { _ensureWetCanvas(); _wetDecayLastT = 0; }

            // ── Flow accumulation buffer setup ────────────────────────────────
            // Active when opacity or flow < 100% and we're in single-canvas mode.
            // Layers have their own compositing pass so we skip it there.
            {
                const _layersActive = app.layerMgr && app.layerMgr.active;
                _flowBufActive = !params.binaryMode && !params.smartBrush &&
                    !_layersActive &&
                    (params.opacity < 100 || params.flow < 100);
                if (_flowBufActive) {
                    const W = app.config.width, H = app.config.height;
                    _ensureFlowBufs(W, H);
                    _strokeCtx.clearRect(0, 0, W, H);
                    // Snapshot the canvas exactly as it looks before the first dab.
                    _preStrokeCtx.clearRect(0, 0, W, H);
                    _preStrokeCtx.drawImage(app.ui.cMain, 0, 0);
                }
            }

            // ── Build bristle strand layout ───────────────────────────────────
            // Even-spread N strands across [-1, +1] in lateral axis, each with a
            // tiny random wobble and alpha variation baked in for the whole stroke.
            if (params.shape === 'bristle') {
                const N = Math.max(2, Math.round(params.bristleCount));
                _bristleStrands = [];
                for (let i = 0; i < N; i++) {
                    const frac = N > 1 ? (i / (N - 1)) * 2 - 1 : 0;  // −1 to +1
                    _bristleStrands.push({
                        lateralFrac: frac,
                        wobble:      (Math.random() - 0.5) * 0.18,   // small per-strand bias
                        alphaScale:  0.6 + Math.random() * 0.4,      // 60–100% opacity variation
                        sizeScale:   0.55 + Math.random() * 0.45,    // 55–100% size variation
                    });
                }
            } else {
                _bristleStrands = [];
            }

            if (params.smudge > 0) {
                try {
                    const ctx  = getDrawCtx();
                    const W    = app.config.width, H = app.config.height;
                    const initSz    = computeSize(0, 1, 0, 0);
                    const sampleR   = Math.max(4, Math.min(32, Math.round(initSz * 0.45)));
                    const sampleD   = sampleR * 2;
                    const sx   = Math.max(0, Math.min(W - sampleD, Math.round(x) - sampleR));
                    const sy   = Math.max(0, Math.min(H - sampleD, Math.round(y) - sampleR));
                    const d    = ctx.getImageData(sx, sy, sampleD, sampleD).data;
                    let rr = 0, gg = 0, bb = 0, cnt = 0;
                    for (let i = 0; i < d.length; i += 4) {
                        if (d[i+3] > 8) { rr += d[i]; gg += d[i+1]; bb += d[i+2]; cnt++; }
                    }
                    smudgeColor = cnt > 0 ? { r: rr/cnt, g: gg/cnt, b: bb/cnt } : null;
                    _smudgeAccum = 0;   // influence starts at 0, builds as you drag
                } catch (_) { smudgeColor = null; _smudgeAccum = 0; }
            }

            const ctx    = getDrawCtx();
            const taperT = params.taper > 0 ? 0 : 1;
            const sz     = computeSize(0, taperT, 0, 0);
            const color  = jitterColor(hexColor, 0);
            const ang    = params.angle + (Math.random() - 0.5) * 2 * params.angleJitter;
            const alpha  = (params.opacity / 100) * (params.flow / 100);
            const jx     = x + (Math.random() - 0.5) * 2 * params.posJitter;
            const jy     = y + (Math.random() - 0.5) * 2 * params.posJitter;
            scatterDabs(ctx, jx, jy, sz, ang, color, alpha, 0);
            _syncFlowBuf(ctx, jx, jy, sz);

            // Airbrush: seed position and start the accumulation timer
            if (params.airbrushMode) {
                _airbrushX = x; _airbrushY = y; _airbrushColor = hexColor;
                _startAirbrushTimer();
            }
        }

        function strokeMove(x, y, hexColor, pressure) {
            if (!strokeActive) return;
            pressure = (pressure !== undefined && pressure > 0) ? pressure : 1.0;

            const now    = performance.now();
            const dt     = Math.max(1, now - prevT);
            prevT        = now;

            // ── Update Catmull-Rom ring buffer (zero allocation) ─────────────
            // The ring buffer holds 4 points: p0, p1, p2, p3.
            // Write the new point into the oldest slot, then advance the head pointer.
            _crBuf[_crHead].x = x;
            _crBuf[_crHead].y = y;
            _crHead = (_crHead + 1) & 3;
            // Read oldest→newest in order: head, head+1, head+2, head+3 (all &3)
            const p0 = _crBuf[_crHead];
            const p1 = _crBuf[(_crHead + 1) & 3];
            const p2 = _crBuf[(_crHead + 2) & 3];
            const p3 = _crBuf[(_crHead + 3) & 3];

            // ── Pre-compute CR knot intervals once for this segment ──────────
            // Shared by _crSegLen (arc-length integration) and every _crPoint
            // call in the dab loop, saving 3×sqrt(sqrt()) per integration step.
            const segPrecomp = _crPrecompute(p0, p1, p2, p3);

            // Chord length from p1→p2 (the segment we are about to render)
            const chordDx  = p2.x - p1.x, chordDy = p2.y - p1.y;
            const chordLen = Math.sqrt(chordDx*chordDx + chordDy*chordDy);
            if (chordLen < 0.01) return;
            const rawSpeed = chordLen / dt;   // px/ms — fed into lowpass filters below

            // ── Libmypaint-style time-correct lowpass filters ────────────────
            // fac = exp(-dt/T);  out = fac*out + (1-fac)*input
            // dt is in seconds. T is the time constant in seconds.
            // This is frame-rate-independent: the same T produces the same
            // frequency response at 30fps and 120fps, unlike a fixed-α EMA.
            const dtSec = dt / 1000;

            // Normalise speed so 1.0 = "comfortable brushing pace" (~0.3 px/ms).
            // Capped at 4.0 so extreme flicks don't blow out the filter state.
            const normRawSpeed = Math.min(4, rawSpeed / 0.3);

            // speed1: fine filter, T ≈ 40 ms  — reacts to bursts quickly
            const fac1   = Math.exp(-dtSec / 0.04);
            _speed1Slow  = fac1 * _speed1Slow + (1 - fac1) * normRawSpeed;

            // speed2: gross filter, T ≈ 200 ms — tracks overall stroke pace
            const fac2   = Math.exp(-dtSec / 0.20);
            _speed2Slow  = fac2 * _speed2Slow + (1 - fac2) * normRawSpeed;

            // Keep legacy alias in sync (computeSize uses _smoothSpeed)
            _smoothSpeed = _speed1Slow;

            // Direction filter, T ≈ 100 ms — smooths stroke angle, prevents
            // abrupt flips on tiny wiggles. Uses raw dx/dy, not normalised.
            // libmypaint filters DX and DY separately then derives the angle.
            const facDir = Math.exp(-dtSec / 0.10);
            _dirDX = facDir * _dirDX + (1 - facDir) * chordDx;
            _dirDY = facDir * _dirDY + (1 - facDir) * chordDy;

            // Pressure filter, T ≈ 50 ms — smooths jittery stylus pressure
            const facP    = Math.exp(-dtSec / 0.05);
            _pressureSlow = facP * _pressureSlow + (1 - facP) * pressure;
            const smoothPressure = _pressureSlow;

            const ctx        = getDrawCtx();
            const taperZone  = Math.max(10, params.startSize * 6 * (params.taper / 100));
            const endZone    = Math.max(8,  params.startSize * 4 * (params.taper / 100));

            // Approximate arc-length of the CR segment (reuses segPrecomp — no extra sqrt)
            const segArcLen = _crSegLen(p0, p1, p2, p3, undefined, segPrecomp);
            residualDist   += segArcLen;
            _strokeDist    += segArcLen;
            strokeLength    = _strokeDist;
            _strokePoints.push({ x: p2.x, y: p2.y, d: _strokeDist });
            if (_strokePoints.length > 120) _strokePoints.shift();
            _smudgeSampleDist += segArcLen;

            // Pre-compute base HSL once per strokeMove call so the hot dab loop
            // only pays for the random jitter offsets, not the hex->RGB->HSL parse.
            const _needsJitter = !!(params.hueJitter || params.satJitter || params.briJitter || params.colorFade);
            let _baseHsl = null;
            if (_needsJitter) {
                const _rgb = hexToRgb(hexColor);
                _baseHsl = rgbToHsl(_rgb.r, _rgb.g, _rgb.b);
            }

            // ── Hoist per-move-event constants out of the dab loop ───────────
            // progressT and taperT change very little across a single move event
            // (a few px of travel vs 2000px ramp), so compute them once here.
            // endTaperT is 0 during normal drawing and only non-zero during the
            // end-taper RAF, which is a separate code path — safe to hoist.
            //
            // progressT now uses _strokeDabCount / STROKE_INPUT_DABS (libmypaint's
            // "stroke" input), which is dab-count-relative rather than pixel-distance-
            // relative.  This makes the start/end size ramp consistent regardless of
            // how large or small the brush is — a small brush no longer needs to travel
            // 2000px to finish its taper in.
            const progressT   = Math.min(1, _strokeDabCount / STROKE_INPUT_DABS);
            const taperT      = params.taper > 0
                ? Math.min(1, _strokeDist / Math.max(1, taperZone)) : 1;
            let endTaperT = 0;
            if (_strokeEndDist >= 0) {
                const distPast = _strokeDist - _strokeEndDist;
                endTaperT = Math.min(1, distPast / Math.max(1, endZone));
            }

            // Use filtered pressure (smoothPressure) rather than the raw, noisy
            // value.  Raw pressure can jump ±0.1 on cheap styli causing visible
            // size/opacity flicker per dab; the filtered value is perceptibly cleaner.
            //
            // Phase 3 + Phase 5: Quantise to the nearest 1% before LUT lookup.
            // This collapses the continuous float to 100 discrete steps so that
            // consecutive dabs at similar pressures share the same LUT index and
            // (as a bonus) produce the same quantised stamp-cache key, boosting
            // the LRU hit rate for large custom tips.
            const _pQuant = Math.round(smoothPressure * 100) / 100;

            // Apply sensor-curve LUTs if they were parsed from the .kpp XML.
            // Null LUTs fall back to identity, preserving the legacy linear ramp.
            const _pressSize    = params._sizeLUT    ? _evalLUT(params._sizeLUT,    _pQuant) : _pQuant;
            const _pressOpacity = params._opacityLUT ? _evalLUT(params._opacityLUT, _pQuant) : _pQuant;

            // pressFactor drives computeSize; _pressFactorAl drives _baseAl.
            const pressFactor    = 0.3 + _pressSize    * 0.7;
            const _pressFactorAl = 0.3 + _pressOpacity * 0.7;

            // ── Auto-angle from filtered stroke direction ──────────────────────
            // When params.angle is 0 and the brush is asymmetric (slash, line,
            // bristle), libmypaint drives angle from DIRECTION_ANGLE.  We do the
            // same: if params.angle === 0 and the shape benefits from alignment,
            // replace the fixed angle with the lowpass-filtered stroke direction.
            // The filtered _dirDX/_dirDY already handles the 180° flip problem.
            let _autoAngle = params.angle;
            if (params.angle === 0 && (params.shape === 'slash' || params.shape === 'line' || params.shape === 'bristle')) {
                if (_dirDX !== 0 || _dirDY !== 0) {
                    _autoAngle = Math.atan2(_dirDY, _dirDX) * 180 / Math.PI;
                }
            }

            // Compute step once from the jitter-free base size so the spacing is
            // stable across dabs (jitter is still applied per-dab to sz only).
            const _baseSz  = computeSize(progressT, taperT, endTaperT, _smoothSpeed) * pressFactor;
            const step     = Math.max(0.5, _baseSz * params.spacing / 100);
            // speedOpacity uses _speed2Slow (gross speed) — libmypaint uses the
            // slower-filtered speed for opacity so it tracks overall stroke energy,
            // not momentary jitter.  Fine speed (_speed1Slow) is better for size.
            const _baseAl  = (params.opacity / 100) * (params.flow / 100) * _pressFactorAl *
                (params.speedOpacity !== 0
                    ? Math.max(0, 1 + (params.speedOpacity / 100) * (_speed2Slow - 1))
                    : 1);

            // Path2D batch optimisation for hard round brushes.
            //
            // At tight spacing a fast stroke can produce 500+ dabs per pointermove event.
            // Each drawImage() is a separate GPU flush; Chrome's Canvas 2D command buffer
            // saturates quickly and the call starts blocking the main thread — visible stutter.
            //
            // When the brush is a hard circle with no per-dab variation (hardness ≥ 98,
            // no grain/scatter/smudge/wetness/colour jitter), every dab arc is
            // accumulated into a single shared Path2D and flushed with one ctx.fill().
            // This collapses N GPU draw calls into 1 regardless of dab count.
            //
            // Visual note: for semi-transparent strokes this fills the union of all dabs
            // in one pass (no stacking), but the flow-buffer cap already prevents visible
            // double-painting so the output is perceptually identical.
            const canBatchPath2D =
                params.shape    === 'circle' &&
                params.hardness >=  98       &&
                params.texture  === 0        &&
                params.scatter  === 0        &&
                params.wetness  === 0        &&
                params.smudge   === 0        &&
                !params.smartBrush           &&
                !params.binaryMode           &&
                !_baseHsl;   // constant fill colour for this whole move event

            // One Path2D shared across both ctx and _strokeCtx — fill() only reads
            // geometry, so the same object is safe to pass to multiple contexts.
            let _batchPath    = canBatchPath2D ? new Path2D() : null;
            let _batchHadDabs = false;

            // Walk along the CR curve planting dabs at `step` intervals
            let walked = 0;
            const _dabPos = { x: 0, y: 0 };   // reused each iteration — zero alloc
            while (residualDist >= step) {
                // Current dab position along this CR segment (zero-alloc _crPoint)
                // Correct t_seg: distance along this segment = total segment len minus
                // remaining unconsumed distance after this step.  Clamped to [0,1]
                // so the centripetal CR is never asked to extrapolate backwards.
                const dabDist = segArcLen - (residualDist - step);
                const t_seg   = Math.max(0, Math.min(1, dabDist / Math.max(0.01, segArcLen)));
                _crPoint(p0, p1, p2, p3, t_seg, _dabPos, segPrecomp);

                // Per-dab size jitter applied on top of the stable base
                const sz  = params.sizeJitter > 0
                    ? Math.max(0.5, _baseSz * (1 + (Math.random() - 0.5) * (params.sizeJitter / 50)))
                    : _baseSz;

                // Position jitter — still per-dab even in batch mode
                const jx = params.posJitter
                    ? _dabPos.x + (Math.random() - 0.5) * 2 * params.posJitter
                    : _dabPos.x;
                const jy = params.posJitter
                    ? _dabPos.y + (Math.random() - 0.5) * 2 * params.posJitter
                    : _dabPos.y;

                if (canBatchPath2D) {
                    // moveTo() is required before each arc().
                    // Without it the Canvas 2D spec implicitly draws a lineTo() from
                    // the previous sub-path's end point to this arc's start — connecting
                    // all circles into one giant self-intersecting polygon. The winding-
                    // rule fill then produces unexpected filled blobs between dabs.
                    // moveTo(cx + r, cy) starts a fresh sub-path so each circle is independent.
                    const r = sz / 2;
                    _batchPath.moveTo(jx + r, jy);
                    _batchPath.arc(jx, jy, r, 0, TWO_PI);
                    _batchHadDabs = true;
                } else {
                    const color = _baseHsl ? _jitterFromHsl(_baseHsl, progressT) : hexColor;
                    // Skip Math.random() entirely when jitter params are zero — the call
                    // is cheap but not free, and it fires on every dab at low spacing.
                    const ang = params.angleJitter
                        ? _autoAngle + (Math.random() - 0.5) * 2 * params.angleJitter
                        : _autoAngle;
                    scatterDabs(ctx, jx, jy, sz, ang, color, _baseAl, progressT);
                }
                // Accumulate this dab's region into the dirty rect; the actual
                // composite to the real canvas is deferred to a single RAF flush.
                _expandFlowDirty(jx, jy, sz);

                residualDist     -= step;
                walked           += step;
                _strokeDabCount  += 1;   // libmypaint-style stroke-progress counter
                if (walked > segArcLen + 2) break;  // safety — don't loop forever
            }

            // ── Flush Path2D batch (1 fill call replaces N drawImage calls) ────
            if (canBatchPath2D && _batchHadDabs) {
                const rgb  = hexToRgb(hexColor);
                const fill = 'rgb(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ')';

                // Real canvas
                const _pa   = ctx.globalAlpha;
                ctx.globalAlpha = _baseAl;
                ctx.fillStyle   = fill;
                ctx.fill(_batchPath);
                ctx.globalAlpha = _pa;

                // Flow accumulation canvas — same Path2D geometry, different context.
                // opacity ceiling is applied later at the RAF flush.
                if (_flowBufActive && _strokeCtx) {
                    const opacityScale = Math.max(0.01, params.opacity / 100);
                    const flowAlpha    = Math.min(1, _baseAl / opacityScale);
                    const _spa         = _strokeCtx.globalAlpha;
                    _strokeCtx.globalAlpha = flowAlpha;
                    _strokeCtx.fillStyle   = fill;
                    _strokeCtx.fill(_batchPath);
                    _strokeCtx.globalAlpha = _spa;
                }
            }

            // Schedule the batched flow-buffer flush for everything stamped this turn.
            // Placed after the while loop so one RAF covers all dabs from this move event
            // (and all coalesced events processed in the same JS turn).
            _scheduleFlowBufFlush(ctx);

            lastDabX = p2.x; lastDabY = p2.y;

            // Keep airbrush target position and color current
            if (params.airbrushMode) { _airbrushX = p2.x; _airbrushY = p2.y; _airbrushColor = hexColor; }
        }

        function strokeEnd(hexColor) {
            // Mark where the mouse was released so the taper can compute endTaperT
            _strokeEndDist = _strokeDist;

            // Flush remaining dabs along end-taper zone via RAF
            const endZone    = Math.max(8, params.startSize * 4 * (params.taper / 100));
            const ctx        = getDrawCtx();
            const taperZone  = Math.max(10, params.startSize * 6 * (params.taper / 100));
            let   walked     = 0;

            function _taperTick() {
                if (!_strokeEndDist) return;   // cancelled
                const stepSize = Math.max(0.5, params.startSize * params.spacing / 100);
                const toWalk   = Math.min(stepSize * 6, endZone - walked);   // burst per frame
                let   sub      = 0;
                while (sub < toWalk) {
                    walked += stepSize; sub += stepSize;
                    if (walked > endZone) break;
                    const endTaperT = Math.min(1, walked / Math.max(1, endZone));
                    const progressT = Math.min(1, _strokeDist / 2000);
                    const taperT    = params.taper > 0
                        ? Math.min(1, _strokeDist / Math.max(1, taperZone)) : 1;
                    const sz    = computeSize(progressT, taperT, endTaperT, _smoothSpeed);
                    if (sz < 0.5) break;
                    const color = jitterColor(hexColor, progressT);
                    const ang   = params.angle + (Math.random() - 0.5) * 2 * params.angleJitter;
                    const al    = (params.opacity / 100) * (params.flow / 100) * Math.max(0.04, 1 - endTaperT);
                    // Continue along the last direction from the stroke-point ring
                    let lx = lastDabX, ly = lastDabY;
                    if (_strokePoints.length >= 2) {
                        const a = _strokePoints[_strokePoints.length - 2];
                        const b = _strokePoints[_strokePoints.length - 1];
                        const dl = Math.sqrt((b.x-a.x)**2 + (b.y-a.y)**2) || 1;
                        lx = lastDabX + (b.x-a.x)/dl * walked;
                        ly = lastDabY + (b.y-a.y)/dl * walked;
                    }
                    const jx = lx + (Math.random() - 0.5) * 2 * params.posJitter;
                    const jy = ly + (Math.random() - 0.5) * 2 * params.posJitter;
                    scatterDabs(ctx, jx, jy, sz, ang, color, al, progressT);
                    _syncFlowBuf(ctx, jx, jy, sz);
                }
                if (walked < endZone) {
                    _endTaperRAF = requestAnimationFrame(_taperTick);
                } else {
                    _endTaperRAF  = 0;
                    _strokeEndDist = -1;
                    _finaliseStrokeEnd();
                }
            }

            if (params.taper > 0 && endZone > 0) {
                _endTaperRAF = requestAnimationFrame(_taperTick);
            } else {
                _finaliseStrokeEnd();
            }
        }

        function _finaliseStrokeEnd() {
            strokeActive      = false;
            smudgeColor       = null;
            _smudgeAccum      = 0;
            _strokeEndDist    = -1;
            _resetSmudgeBuckets();

            // Polygon-growth watercolor bloom effect.
            // Uses the stroke path recorded in _strokePoints to grow colour outward
            // from the stroke edges. Must execute before _strokePoints is cleared.
            if (params.polyWatercolor && _strokePoints.length >= 2) {
                const color  = (app.config && app.config.c1) ? app.config.c1 : '#3a6ba0';
                const avgSz  = (params.startSize + params.endSize) / 2;
                // Subsample: keep at most 60 points evenly spaced for performance
                let bloomPts = _strokePoints;
                if (_strokePoints.length > 60) {
                    const step = _strokePoints.length / 60;
                    bloomPts   = [];
                    for (let i = 0; i < 60; i++)
                        bloomPts.push(_strokePoints[Math.round(i * step)]);
                }
                _growWatercolorBloom(bloomPts, color, avgSz);
            }

            _strokePoints     = [];
            _smoothSpeed      = 0;
            _speed1Slow       = 0;
            _speed2Slow       = 0;
            _dirDX            = 0;
            _dirDY            = 0;
            _pressureSlow     = 1;
            _strokeDabCount   = 0;
            _crHead           = 0;   // ring buffer position reset (slots reseeded at next strokeBegin)
            _smudgeAccum      = 0;
            _smudgeSampleDist = 0;
            _flowBufActive    = false;   // deactivate; buffers kept for reuse next stroke
            _flowDirtyRect    = null;    // discard any unflushed dirty region
            _flowRAFPending   = false;   // cancel conceptually (RAF may still fire but guard below handles it)
            _bristleStrands   = [];
            _stopAirbrushTimer();
            app.saveState();
        }

        /* ── 9. MOUSE HOOK ───────────────────────────────────────────────── */

        const _origDown = app.onMouseDown.bind(app);
        const _origMove = app.onMouseMove.bind(app);
        const _origUp   = app.onMouseUp.bind(app);

        function _isBrushTool() {
            return app.config.tool === 'pencil' || app.config.tool === 'eraser';
        }

        app.onMouseDown = function (e) {
            // Only intercept when the brush engine is enabled and a compatible tool is active
            if (!engineActive || !_isBrushTool()) { _origDown.call(this, e); return; }

            // Honour all the same guards as the original handler
            if (this.state.isPanning)        return;
            if (e.button === 1)              return;
            if (this.state.quantizeBusy)     return;
            if (this.state.isFileLoading)    return;
            if (this.state.isCanvasResizing) return;

            // Commit an active selection before drawing, just like the original pencil does
            if (this.state.selection) {
                this.commitSelection();
            }

            // Commit an active shape before drawing
            if (this.state.shapeEditMode && this.state.activeShape) {
                this.commitActiveShape();
            }

            const p       = this.getMouse(e);
            const isRight = e.button === 2;
            const color   = this.getActiveDrawColor(isRight || this.config.tool === 'eraser');

            this.state.isDrawing = true;
            this.state.startPos  = { x: p.x, y: p.y };
            this._lastPointerEvent = e;

            // Lazy Needle stabilizer: initialise the trailing "lazy" point at the cursor
            // position so the first dab is placed exactly where the user presses down.
            _lazyX = p.x; _lazyY = p.y;
            _realX = p.x; _realY = p.y;
            _lazyActive = params.stabilize > 0;
            strokeBegin(p.x, p.y, color);
            if (_lazyActive) { const _color = color; _startLazyRAF(_color); }
        };

        app.onMouseMove = function (e) {
            // Only intercept when actively drawing with the engine
            if (!engineActive || !_isBrushTool() || !this.state.isDrawing) {
                _origMove.call(this, e);
                return;
            }

            // Process coalesced pointer events, subsampling the interior when the
            // backlog is large.
            //
            // At 120 Hz stylus input the browser batches up to 10–20 coalesced events
            // per pointermove callback. Running all of them through the full
            // Catmull-Rom + dab pipeline is expensive and delivers no visible quality
            // improvement beyond ~6 events per frame. Strategy: always keep the first
            // and last event (so path endpoints are exact) and evenly subsample any
            // interior events to at most 5 slots (6 total).
            const coalesced = (e.getCoalescedEvents ? e.getCoalescedEvents() : null) || [e];
            let events = coalesced.length ? coalesced : [e];
            if (events.length > 8) {
                const step = (events.length - 1) / 5;   // 5 interior slots → 6 total incl. first
                const sub  = [events[0]];
                for (let k = 1; k <= 4; k++) sub.push(events[Math.round(k * step)]);
                sub.push(events[events.length - 1]);
                events = sub;
            }

            for (let i = 0; i < events.length; i++) {
                const ev      = events[i];
                const p       = this.getMouse(ev);
                const right   = e.buttons === 2;
                const color   = this.getActiveDrawColor(right || this.config.tool === 'eraser');
                // Pointer pressure (stylus / touch); falls back to 1.0 for mouse
                const pressure = (ev.pressure !== undefined && ev.pressure > 0) ? ev.pressure : 1.0;

                if (_lazyActive && params.stabilize > 0) {
                    // Update the target; the lazy RAF loop will move _lazyX/Y toward it
                    _realX = p.x; _realY = p.y;
                    // Step the lazy point once now (for responsiveness on fast machines)
                    _stepLazyNeedle(color, pressure);
                } else {
                    strokeMove(p.x, p.y, color, pressure);
                }
            }

            const last = events[events.length - 1];
            this.state.lastMouse   = { clientX: last.clientX, clientY: last.clientY };
            this._lastPointerEvent = last;
            const lp = this.getMouse(last);
            if (this.setCoordsStatus) this.setCoordsStatus(lp.x, lp.y);
            this.updateHoverPreview(lp.x, lp.y);
            this.updateEraserGhost(e);
        };

        app.onMouseUp = function (e) {
            // If the engine isn't active or no brush stroke is in progress, use original handler
            if (!engineActive || !_isBrushTool() || !strokeActive) {
                _origUp.call(this, e);
                return;
            }

            const right = e.button === 2;
            const color = this.getActiveDrawColor(right || this.config.tool === 'eraser');
            this.state.isDrawing = false;

            // ── Lazy Needle: cancel the RAF catch-up loop ─────────────────────
            if (_lazyRAF) { cancelAnimationFrame(_lazyRAF); _lazyRAF = 0; }
            _lazyActive = false;

            // strokeEnd now calls saveState itself (after the end-taper flush)
            strokeEnd(color);
        };

        /* ── 10. PREVIEW CANVAS ──────────────────────────────────────────── */

        function _drawDabOnCtx(ctx, cx, cy, sz, angleDeg, color, alpha) {
            const hardness = params.hardness / 100;
            const r = sz / 2;
            ctx.save();
            ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
            ctx.translate(cx, cy);
            ctx.rotate(angleDeg * Math.PI / 180);
            // Delegate all tip-type decisions to the abstraction layer
            _renderTipOntoCtx(ctx, 0, 0, r, sz, 0, color, hardness, hardness < 0.98);
            ctx.restore();
        }

        function refreshPreview() {
            const el = document.getElementById('brush-preview-canvas');
            if (!el) return;
            const ctx = el.getContext('2d');
            const W = el.width, H = el.height;
            ctx.clearRect(0, 0, W, H);
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
            const x0 = 14, x1 = W - 14, y0 = H * 0.62, y1 = H * 0.38;
            const totalD = Math.sqrt((x1-x0)*(x1-x0) + (y1-y0)*(y1-y0));
            const avgSz  = (params.startSize + params.endSize) / 2;
            const step   = Math.max(1, avgSz * params.spacing / 100);
            const color  = (app.config && app.config.c1) ? app.config.c1 : '#000000';
            let d = 0;
            while (d <= totalD) {
                const t    = totalD > 0 ? d / totalD : 0;
                const cx   = x0 + (x1 - x0) * t;
                const cy   = y0 + (y1 - y0) * t;
                const taperT = params.taper > 0 ? Math.min(1, t / Math.max(0.01, (params.taper/100) * 0.5)) : 1;
                const sz   = computeSize(t, taperT, 0, 0);
                const alpha = (params.opacity / 100) * (params.flow / 100);
                _drawDabOnCtx(ctx, cx, cy, sz, params.angle, color, alpha);
                d += step;
            }
        }

        /* Interactive scratch on the preview canvas */
        const _pvcEl = document.getElementById('brush-preview-canvas');
        if (_pvcEl) {
            let _pDown = false, _pLast = null, _pResidue = 0;
            _pvcEl.style.touchAction = 'none';
            _pvcEl.addEventListener('pointerdown', e => {
                _pDown = true; _pResidue = 0;
                const rc = _pvcEl.getBoundingClientRect();
                _pLast = { x: e.clientX - rc.left, y: e.clientY - rc.top };
                const ctx = _pvcEl.getContext('2d');
                ctx.clearRect(0, 0, _pvcEl.width, _pvcEl.height);
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, _pvcEl.width, _pvcEl.height);
            });
            _pvcEl.addEventListener('pointermove', e => {
                if (!_pDown || !_pLast) return;
                const rc = _pvcEl.getBoundingClientRect();
                const x = e.clientX - rc.left, y = e.clientY - rc.top;
                const dx = x - _pLast.x, dy = y - _pLast.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                if (dist < 0.1) return;
                const ctx   = _pvcEl.getContext('2d');
                const avgSz = (params.startSize + params.endSize) / 2;
                const step  = Math.max(1, avgSz * params.spacing / 100);
                const color = (app.config && app.config.c1) ? app.config.c1 : '#000000';
                _pResidue += dist;
                while (_pResidue >= step) {
                    const frac = (dist - _pResidue + step) / dist;
                    const px = _pLast.x + dx * frac, py = _pLast.y + dy * frac;
                    const sz = computeSize(0.5, 1, 0, 0);
                    const ang = params.angle + (Math.random()-0.5)*2*params.angleJitter;
                    const alpha = (params.opacity/100)*(params.flow/100);
                    _drawDabOnCtx(ctx, px, py, sz, ang, color, alpha);
                    if (params.scatter > 0) {
                        for (let i = 0; i < params.scatter; i++) {
                            const sa = Math.random()*TWO_PI, sd = Math.random()*params.scatterRadius;
                            const ss = sz*(0.25+Math.random()*0.75);
                            ctx.save();
                            ctx.globalAlpha = Math.min(1, alpha*(0.3+Math.random()*0.55));
                            ctx.translate(px+Math.cos(sa)*sd, py+Math.sin(sa)*sd);
                            ctx.fillStyle = color;
                            ctx.beginPath(); ctx.arc(0,0,ss/2,0,TWO_PI); ctx.fill();
                            ctx.restore();
                        }
                    }
                    _pResidue -= step;
                }
                _pLast = { x, y };
            });
            window.addEventListener('pointerup', () => { _pDown = false; _pLast = null; });
        }

        /* ── 10b. LAZY NEEDLE STABILIZER ───────────────────────────────────── */

        /* Move the lazy point one step toward the real cursor and call strokeMove.
           The lazy radius in pixels is derived from params.stabilize (0–100).
           At 0 the feature is bypassed entirely.
           At 100 the radius is ~200 px — very long leash, very smooth. */
        function _stepLazyNeedle(color, pressure) {
            if (!strokeActive || !_lazyActive) return;

            const radius = params.stabilize * 2;   // 0–200 px leash
            const dx = _realX - _lazyX;
            const dy = _realY - _lazyY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist <= radius) {
                // Real cursor is within the dead zone — lazy point stays put
                return;
            }

            // Move lazy point so it sits exactly  pixels behind the cursor
            const t = (dist - radius) / dist;
            _lazyX += dx * t;
            _lazyY += dy * t;

            strokeMove(_lazyX, _lazyY, color, pressure || 1.0);
        }

        /* requestAnimationFrame loop that keeps the lazy trailing point drifting toward
           the real cursor even when the pointer is stationary. This is important for
           slow, deliberate strokes where the leash tension drives the dab forward
           without any new pointer events. */
        function _startLazyRAF(color) {
            if (_lazyRAF) return; // already running
            function tick() {
                if (!_lazyActive || !strokeActive) { _lazyRAF = 0; return; }
                _stepLazyNeedle(color, 1.0);
                _lazyRAF = requestAnimationFrame(tick);
            }
            _lazyRAF = requestAnimationFrame(tick);
        }

        /* ── Airbrush Accumulation Timer ────────────────────────────────────
           When airbrushMode is enabled, we fire dabs on a setInterval even
           when the pointer is not moving.  Each tick places one dab at the
           current cursor position (_airbrushX/Y) using the normal scatterDabs
           path so all other params (scatter, texture, smudge…) keep working. */
        function _startAirbrushTimer() {
            _stopAirbrushTimer();
            const rate     = Math.max(1, Math.min(100, params.airbrushRate));
            const interval = Math.round(1000 / rate);   // ms between dabs
            _airbrushInterval = setInterval(function() {
                if (!strokeActive || !params.airbrushMode) { _stopAirbrushTimer(); return; }
                const ctx  = getDrawCtx();
                const sz   = computeSize(Math.min(1, _strokeDist / 2000), 1, 0, _smoothSpeed);
                const color = jitterColor(_airbrushColor, 0);
                const ang  = params.angle + (Math.random() - 0.5) * 2 * params.angleJitter;
                const al   = (params.opacity / 100) * (params.flow / 100);
                const jx   = _airbrushX + (Math.random() - 0.5) * 2 * params.posJitter;
                const jy   = _airbrushY + (Math.random() - 0.5) * 2 * params.posJitter;
                scatterDabs(ctx, jx, jy, sz, ang, color, al, 0);
                _syncFlowBuf(ctx, jx, jy, sz);
            }, interval);
        }
        function _stopAirbrushTimer() {
            if (_airbrushInterval) { clearInterval(_airbrushInterval); _airbrushInterval = 0; }
        }

        /* ── 11. PUBLIC API ──────────────────────────────────────────────── */

        const SLIDER_MAP = [
            ['startSize',     'bs-startSize',     function(v){ return v+'px'; }],
            ['endSize',       'bs-endSize',        function(v){ return v+'px'; }],
            ['spacing',       'bs-spacing',        function(v){ return v+'%'; }],
            ['angle',         'bs-angle',          function(v){ return v+'\u00b0'; }],
            ['speedSize',     'bs-speedSize',      function(v){ return (v>0?'+':'')+v+'%'; }],
            ['speedOpacity',  'bs-speedOpacity',   function(v){ return (v>0?'+':'')+v+'%'; }],
            ['taper',         'bs-taper',          function(v){ return v+'%'; }],
            ['stabilize',     'bs-stabilize',      function(v){ return ''+v; }],
            ['sizeJitter',    'bs-sizeJitter',     function(v){ return v+'%'; }],
            ['posJitter',     'bs-posJitter',      function(v){ return v+'px'; }],
            ['angleJitter',   'bs-angleJitter',    function(v){ return v+'\u00b0'; }],
            ['opacity',       'bs-opacity',        function(v){ return v+'%'; }],
            ['flow',          'bs-flow',           function(v){ return v+'%'; }],
            ['hardness',      'bs-hardness',       function(v){ return v+'%'; }],
            ['wetness',       'bs-wetness',        function(v){ return v+'%'; }],
            ['texture',       'bs-texture',        function(v){ return v+'%'; }],
            ['grainScale',    'bs-grainScale',     function(v){ return v+'px'; }],
            ['scatter',       'bs-scatter',        function(v){ return ''+v; }],
            ['scatterRadius', 'bs-scatterRadius',  function(v){ return v+'px'; }],
            ['smudge',        'bs-smudge',         function(v){ return v+'%'; }],
            ['hueJitter',     'bs-hueJitter',      function(v){ return v+'\u00b0'; }],
            ['satJitter',     'bs-satJitter',      function(v){ return v+'%'; }],
            ['briJitter',     'bs-briJitter',      function(v){ return v+'%'; }],
            ['colorFade',     'bs-colorFade',      function(v){ return v+'%'; }],
            ['outlineThick',  'bs-outlineThick',   function(v){ return v+'px'; }],
            ['bristleCount',  'bs-bristleCount',   function(v){ return ''+v; }],
            ['bristleSpread', 'bs-bristleSpread',  function(v){ return v+'%'; }],
            ['airbrushRate',  'bs-airbrushRate',   function(v){ return v+'/s'; }],
        ];

        function _syncSlidersToParams() {
            for (var i = 0; i < SLIDER_MAP.length; i++) {
                var key = SLIDER_MAP[i][0], id = SLIDER_MAP[i][1], fmt = SLIDER_MAP[i][2];
                var sl  = document.getElementById(id);
                var val = document.getElementById(id + '-v');
                var v   = params[key] !== undefined ? params[key] : DEFAULTS[key];
                if (sl)  sl.value = v;
                if (val) val.textContent = fmt(v);
            }
            // Sync the antialias checkbox
            var aaBox = document.getElementById('bs-antialias');
            var aaLbl = document.getElementById('bs-antialias-v');
            var aaOn  = params.antialias !== undefined ? params.antialias : DEFAULTS.antialias;
            if (aaBox) aaBox.checked = !!aaOn;
            if (aaLbl) aaLbl.textContent = aaOn ? 'On' : 'Off';
            // Sync binaryMode checkbox
            var bmBox = document.getElementById('bs-binaryMode');
            var bmLbl = document.getElementById('bs-binaryMode-v');
            var bmOn  = params.binaryMode !== undefined ? params.binaryMode : DEFAULTS.binaryMode;
            if (bmBox) bmBox.checked = !!bmOn;
            if (bmLbl) bmLbl.textContent = bmOn ? 'On' : 'Off';
            // Sync smartBrush checkbox + outline row visibility
            var sbBox = document.getElementById('bs-smartBrush');
            var sbLbl = document.getElementById('bs-smartBrush-v');
            var sbRow = document.getElementById('bs-outlineThick-row');
            var sbOn  = params.smartBrush !== undefined ? params.smartBrush : DEFAULTS.smartBrush;
            if (sbBox) sbBox.checked = !!sbOn;
            if (sbLbl) sbLbl.textContent = sbOn ? 'On' : 'Off';
            if (sbRow) sbRow.style.display = sbOn ? '' : 'none';
            // Sync bristle controls row visibility
            var bRow = document.getElementById('bs-bristle-row');
            if (bRow) bRow.style.display = (params.shape === 'bristle') ? '' : 'none';
            // Sync custom tip rows visibility
            var tipRow = document.getElementById('bs-custom-tip-row');
            var hRow   = document.getElementById('bs-tip-hardness-row');
            var isCustom = params.shape === 'custom' && !!params.customTipCanvas;
            if (tipRow) tipRow.style.display = isCustom ? '' : 'none';
            if (hRow)   hRow.style.display   = isCustom ? '' : 'none';
            // Sync tip hardness slider
            var thSl = document.getElementById('bs-tipHardness');
            var thVl = document.getElementById('bs-tipHardness-v');
            var thV  = params.tipHardness !== undefined ? params.tipHardness : 100;
            if (thSl) thSl.value = thV;
            if (thVl) thVl.textContent = thV + '%';
            // Sync polyWatercolor checkbox
            var pwBox = document.getElementById('bs-polyWatercolor');
            var pwLbl = document.getElementById('bs-polyWatercolor-v');
            var pwOn  = params.polyWatercolor !== undefined ? params.polyWatercolor : DEFAULTS.polyWatercolor;
            if (pwBox) pwBox.checked = !!pwOn;
            if (pwLbl) pwLbl.textContent = pwOn ? 'On' : 'Off';
            // Sync airbrushMode checkbox + rate row visibility
            var abBox = document.getElementById('bs-airbrushMode');
            var abLbl = document.getElementById('bs-airbrushMode-v');
            var abRow = document.getElementById('bs-airbrushRate-row');
            var abOn  = params.airbrushMode !== undefined ? params.airbrushMode : DEFAULTS.airbrushMode;
            if (abBox) abBox.checked = !!abOn;
            if (abLbl) abLbl.textContent = abOn ? 'On' : 'Off';
            if (abRow) abRow.style.display = abOn ? '' : 'none';
        }

        app.brush = {
            setParam: function(key, value) {
                params[key] = value;
                if (key === 'shape') {
                    document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                        btn.classList.toggle('active', btn.dataset.shape === value);
                    });
                    // Show/hide bristle controls
                    var bRow = document.getElementById('bs-bristle-row');
                    if (bRow) bRow.style.display = (value === 'bristle') ? '' : 'none';
                }
                refreshPreview();
            },

            loadPreset: function(name) {
                var p = PRESETS[name];
                if (!p) return;
                params = Object.assign({}, DEFAULTS, p);
                /* Changing preset clears any Krita-sourced texture tile and
                 * invalidates the grain cache so the new preset's noise is fresh. */
                params._kritaTextureTile = null;
                _grainCache = null; _grainCacheSize = -1;
                _syncSlidersToParams();
                document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                    btn.classList.toggle('active', btn.dataset.shape === params.shape);
                });
                document.querySelectorAll('.brush-preset-btn').forEach(function(btn) {
                    btn.classList.toggle('active', btn.dataset.preset === name);
                });
                refreshPreview();
            },

            activate: function() {
                engineActive = !engineActive;
                var btn = document.getElementById('brush-engine-toggle');
                if (btn) {
                    btn.textContent = engineActive ? 'Disable' : 'Enable';
                    btn.classList.toggle('brush-active', engineActive);
                    btn.classList.toggle('bs-action-btn', true);
                }
                refreshPreview();
            },

            clearPreview: function() {
                var el = document.getElementById('brush-preview-canvas');
                if (!el) return;
                var ctx = el.getContext('2d');
                ctx.clearRect(0, 0, el.width, el.height);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, el.width, el.height);
            },

            isActive:  function() { return engineActive; },
            getParams: function() { return Object.assign({}, params); },

            randomize: function() {
                /* Pick a random shape */
                var shapes = ['circle', 'square', 'diamond', 'slash', 'line'];
                var rShape = shapes[Math.floor(Math.random() * shapes.length)];

                /* Helper: random int in [lo, hi] */
                function ri(lo, hi) { return Math.round(lo + Math.random() * (hi - lo)); }

                /* Build a randomized params object.
                   Ranges match the slider min/max in the HTML.
                   A few parameters are biased toward sane values so the
                   result is a usable (if odd) brush rather than pure noise. */
                var startSz = ri(3, 32);
                var newP = {
                    shape:        rShape,
                    startSize:    startSz,
                    endSize:      ri(1, Math.max(1, startSz)),   /* endSize ≤ startSize for natural taper */
                    spacing:      ri(5, 60),
                    angle:        ri(0, 180),
                    speedSize:    ri(-60, 60),
                    speedOpacity: ri(-60, 60),
                    taper:        ri(0, 80),
                    sizeJitter:   ri(0, 60),
                    posJitter:    ri(0, 16),
                    angleJitter:  ri(0, 90),
                    opacity:      ri(30, 100),
                    flow:         ri(20, 100),
                    hardness:     ri(0, 100),
                    wetness:      ri(0, 60),
                    texture:      ri(0, 70),
                    grainScale:   ri(1, 12),
                    scatter:      ri(0, 10),
                    scatterRadius:ri(4, 40),
                    smudge:       ri(0, 50),
                    hueJitter:    ri(0, 90),
                    satJitter:    ri(0, 60),
                    briJitter:    ri(0, 50),
                    colorFade:    ri(0, 50),
                };

                params = Object.assign({}, DEFAULTS, newP);

                /* Deselect all presets */
                document.querySelectorAll('.brush-preset-btn').forEach(function(btn) {
                    btn.classList.remove('active');
                });

                _syncSlidersToParams();

                /* Sync shape buttons */
                document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                    btn.classList.toggle('active', btn.dataset.shape === params.shape);
                });

                refreshPreview();
            },
        };

        /* Public method to toggle antialiasing */
        app.brush.setAntialias = function(enabled) {
            params.antialias = !!enabled;
            var lbl = document.getElementById('bs-antialias-v');
            if (lbl) lbl.textContent = enabled ? 'On' : 'Off';
            refreshPreview();
        };

        /* Public method to toggle airbrush mode */
        app.brush.setAirbrushMode = function(enabled) {
            params.airbrushMode = !!enabled;
            var lbl = document.getElementById('bs-airbrushMode-v');
            if (lbl) lbl.textContent = enabled ? 'On' : 'Off';
            var row = document.getElementById('bs-airbrushRate-row');
            if (row) row.style.display = enabled ? '' : 'none';
            // If a stroke is currently active and we just toggled on, start the timer
            if (enabled && strokeActive) {
                _startAirbrushTimer();
            } else if (!enabled) {
                _stopAirbrushTimer();
            }
            refreshPreview();
        };

        /* Public method to toggle binary mode */
        app.brush.setBinaryMode = function(enabled) {
            params.binaryMode = !!enabled;
            var lbl = document.getElementById('bs-binaryMode-v');
            if (lbl) lbl.textContent = enabled ? 'On' : 'Off';
            refreshPreview();
        };

        /* Public method to toggle smart brush */
        app.brush.setSmartBrush = function(enabled) {
            params.smartBrush = !!enabled;
            var lbl = document.getElementById('bs-smartBrush-v');
            if (lbl) lbl.textContent = enabled ? 'On' : 'Off';
            var row = document.getElementById('bs-outlineThick-row');
            if (row) row.style.display = enabled ? '' : 'none';
            refreshPreview();
        };

        /* ── TIP BAKING ──────────────────────────────────────────────────────
           The "baked" tip canvas is a greyscale-alpha mask at its native
           resolution with three transforms applied:
             1. Luminance → alpha  (dark pixels become opaque)
             2. Invert    → flip alpha if params.tipInvert is set
             3. Hardness  → radial falloff multiplied into alpha so the tip
                            edge feathers like a soft brush.  tipHardness=100
                            means no falloff (sharp mask edge), tipHardness=0
                            means a full radial gradient from centre to edge.

           We store the RAW luminance mask (step 1 only) in params.customTipRaw
           so we can cheaply rebake when invert or tipHardness changes without
           re-reading the image file.
           ─────────────────────────────────────────────────────────────────── */

        /* Build a baked tip canvas from the raw mask already in params.customTipRaw.
           Called by loadCustomTip (initial load) and setTipHardness / setTipInvert. */
        function _rebakeTip() {
            var raw = params.customTipRaw;
            if (!raw) return;
            var W = raw.width, H = raw.height;
            var oc = _makeScratch(W, H);
            var ox = oc.getContext('2d');

            // Copy raw mask
            ox.drawImage(raw, 0, 0);
            var id = ox.getImageData(0, 0, W, H);
            var d  = id.data;

            var hardness = Math.max(0, Math.min(1, (params.tipHardness !== undefined ? params.tipHardness : 100) / 100));
            var invert   = !!params.tipInvert;

            // Centre of tip for radial falloff
            var cx = W / 2, cy = H / 2;
            var maxR = Math.sqrt(cx * cx + cy * cy);

            for (var i = 0; i < d.length; i += 4) {
                var a = d[i + 3] / 255;   // raw alpha from luminance step

                // Invert
                if (invert) a = 1 - a;

                // Hardness radial falloff:
                // At hardness=1 the multiplier is 1 everywhere (sharp mask).
                // At hardness=0 the multiplier is a linear gradient from 1 at
                // centre to 0 at the corner — full feather.
                // Between: lerp so mid-values give a partial feather.
                if (hardness < 0.999) {
                    var px = (i / 4) % W;
                    var py = Math.floor((i / 4) / W);
                    var dx = px - cx, dy = py - cy;
                    var dist = Math.sqrt(dx * dx + dy * dy);
                    var t    = Math.min(1, dist / maxR);   // 0 = centre, 1 = corner
                    // Feather zone starts at hardness fraction from centre
                    var feather = hardness < 0.001 ? (1 - t) : Math.max(0, 1 - Math.max(0, t - hardness) / (1 - hardness));
                    a *= feather;
                }

                d[i]     = 0;
                d[i + 1] = 0;
                d[i + 2] = 0;
                d[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
            }
            ox.putImageData(id, 0, 0);
            params.customTipCanvas = oc;
            // Flush LRU stamp cache so next dab doesn't reuse a stale stamp
            while (_dabStampLRU.length) { _returnScratch(_dabStampLRU.pop().canvas); }
            _dabStampBytes = 0;
            _stampMRU = null;
        }

        /* Public method: load a custom brush tip image from a File or data URL */
        app.brush.loadCustomTip = function(source, tipName, _fallbackShape) {
            var img = new Image();
            // If the image fails to load (CORS, 404, etc.), restore the fallback shape
            // so the brush still draws rather than silently painting nothing.
            img.onerror = function() {
                console.warn('[BrushTip] Failed to load tip:', source);
                if (_fallbackShape && params.shape === 'circle') {
                    params.shape = _fallbackShape;
                    document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                        btn.classList.toggle('active', btn.dataset.shape === params.shape);
                    });
                }
                refreshPreview();
            };
            img.onload = function() {
                // Step 1: build raw luminance→alpha mask (no hardness, no invert)
                var rawOc  = _makeScratch(img.width, img.height);
                var rawCtx = rawOc.getContext('2d');
                rawCtx.drawImage(img, 0, 0);
                var id = rawCtx.getImageData(0, 0, rawOc.width, rawOc.height);
                var d  = id.data;
                for (var i = 0; i < d.length; i += 4) {
                    var lum  = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
                    var srcA = d[i + 3] / 255;
                    d[i]     = 0;
                    d[i + 1] = 0;
                    d[i + 2] = 0;
                    // Dark = opaque; preserve original alpha channel as ceiling
                    d[i + 3] = Math.round((1 - lum) * srcA * 255);
                }
                rawCtx.putImageData(id, 0, 0);
                params.customTipRaw = rawOc;

                // Step 2: bake (applies current hardness + invert)
                _rebakeTip();

                params.shape = 'custom';

                // Sync shape button highlight
                document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                    btn.classList.toggle('active', btn.dataset.shape === 'custom');
                });
                // Sync tip library active state
                document.querySelectorAll('.bs-tip-thumb').forEach(function(c) {
                    c.classList.toggle('active', c.dataset.tipName === (tipName || ''));
                });
                // Show the tip-options row + hardness row
                var row = document.getElementById('bs-custom-tip-row');
                if (row) row.style.display = '';
                var hRow = document.getElementById('bs-tip-hardness-row');
                if (hRow) hRow.style.display = '';
                // Show/update filename label
                var lbl = document.getElementById('bs-custom-tip-name');
                var displayName = tipName || (source instanceof File ? source.name : 'custom');
                if (lbl) lbl.textContent = displayName;
                // Keep invert checkbox in sync
                var inv = document.getElementById('bs-tip-invert');
                if (inv) inv.checked = !!params.tipInvert;
                // Keep hardness slider in sync
                var hsl = document.getElementById('bs-tipHardness');
                var hvl = document.getElementById('bs-tipHardness-v');
                var hv  = params.tipHardness !== undefined ? params.tipHardness : 100;
                if (hsl) hsl.value = hv;
                if (hvl) hvl.textContent = hv + '%';
                refreshPreview();
            };
            if (source instanceof File) {
                var reader = new FileReader();
                reader.onload = function(e) { img.src = e.target.result; };
                reader.readAsDataURL(source);
            } else {
                img.src = source; // already a data URL
            }
        };

        /* Toggle tip invert — rebakes instead of allocating at draw time */
        app.brush.setTipInvert = function(v) {
            params.tipInvert = !!v;
            if (params.customTipRaw) _rebakeTip();
            refreshPreview();
        };

        /* Set tip hardness and rebake */
        app.brush.setTipHardness = function(v) {
            params.tipHardness = +v;
            if (params.customTipRaw) _rebakeTip();
            refreshPreview();
        };

        /* Clear custom tip, revert to circle */
        app.brush.clearCustomTip = function() {
            params.customTipCanvas = null;
            params.customTipRaw    = null;
            params.tipInvert = false;
            params.tipHardness = 100;
            params.shape = 'circle';
            document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                btn.classList.toggle('active', btn.dataset.shape === 'circle');
            });
            document.querySelectorAll('.bs-tip-thumb').forEach(function(c) {
                c.classList.remove('active');
            });
            var row = document.getElementById('bs-custom-tip-row');
            if (row) row.style.display = 'none';
            var hRow = document.getElementById('bs-tip-hardness-row');
            if (hRow) hRow.style.display = 'none';
            var lbl = document.getElementById('bs-custom-tip-name');
            if (lbl) lbl.textContent = '';
            refreshPreview();
        };

        /* ── BUILT-IN TIP LIBRARY ─────────────────────────────────────────────
           Six procedurally-generated tip masks, each 64×64px, drawn once and
           stored as data URLs.  No external files needed.
           ─────────────────────────────────────────────────────────────────── */
        (function _initTipLibrary() {
            var TIPS = [
                { name: 'Soft round',  draw: function(ctx, S) {
                    // Radial gradient: black centre, white edge → inverted luminance mask
                    var g = ctx.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
                    g.addColorStop(0,   '#000');
                    g.addColorStop(0.6, '#333');
                    g.addColorStop(1,   '#fff');
                    ctx.fillStyle = g;
                    ctx.fillRect(0, 0, S, S);
                }},
                { name: 'Chalk',  draw: function(ctx, S) {
                    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,S,S);
                    // Rough ellipse with noise patches
                    ctx.fillStyle = '#000';
                    ctx.beginPath(); ctx.ellipse(S/2,S/2,S*0.42,S*0.3,0.4,0,Math.PI*2); ctx.fill();
                    // Erode with small white circles
                    ctx.fillStyle = 'rgba(255,255,255,0.7)';
                    var rng = function(seed) { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
                    var s = 1;
                    for (var i = 0; i < 22; i++) {
                        var x = rng(s++) * S * 0.7 + S * 0.15;
                        var y = rng(s++) * S * 0.5 + S * 0.25;
                        var r = rng(s++) * 4 + 1;
                        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2); ctx.fill();
                    }
                }},
                { name: 'Splat',  draw: function(ctx, S) {
                    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,S,S);
                    ctx.fillStyle = '#000';
                    // Central blob + radiating spikes
                    ctx.beginPath(); ctx.arc(S/2,S/2,S*0.18,0,Math.PI*2); ctx.fill();
                    var N = 9;
                    for (var i = 0; i < N; i++) {
                        var a = (i / N) * Math.PI * 2;
                        var len = S * (0.28 + (i % 3) * 0.07);
                        var x = S/2 + Math.cos(a) * len;
                        var y = S/2 + Math.sin(a) * len;
                        var r2 = 2 + (i % 4);
                        ctx.beginPath(); ctx.arc(x, y, r2, 0, Math.PI*2); ctx.fill();
                        ctx.beginPath(); ctx.moveTo(S/2,S/2); ctx.lineTo(x,y); ctx.strokeStyle='#000'; ctx.lineWidth=1.5; ctx.stroke();
                    }
                }},
                { name: 'Star',  draw: function(ctx, S) {
                    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,S,S);
                    ctx.fillStyle = '#000';
                    ctx.beginPath();
                    var pts = 6, cx2 = S/2, cy2 = S/2, outer = S*0.44, inner = S*0.18;
                    for (var i2 = 0; i2 < pts * 2; i2++) {
                        var r3 = i2 % 2 === 0 ? outer : inner;
                        var a2 = (i2 / (pts * 2)) * Math.PI * 2 - Math.PI / 2;
                        if (i2 === 0) ctx.moveTo(cx2 + r3 * Math.cos(a2), cy2 + r3 * Math.sin(a2));
                        else          ctx.lineTo(cx2 + r3 * Math.cos(a2), cy2 + r3 * Math.sin(a2));
                    }
                    ctx.closePath(); ctx.fill();
                }},
                { name: 'Grass',  draw: function(ctx, S) {
                    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,S,S);
                    ctx.strokeStyle = '#000'; ctx.lineCap = 'round';
                    // Several tapered blade shapes
                    var blades = [
                        [S*0.25, S*0.95, S*0.18, S*0.05, 3],
                        [S*0.45, S*0.98, S*0.5,  S*0.02, 4],
                        [S*0.65, S*0.95, S*0.62, S*0.08, 3],
                        [S*0.35, S*0.97, S*0.1,  S*0.15, 2.5],
                        [S*0.75, S*0.96, S*0.85, S*0.1,  2],
                    ];
                    blades.forEach(function(b) {
                        ctx.beginPath();
                        ctx.moveTo(b[0], b[1]);
                        ctx.bezierCurveTo(b[0]-S*0.05, b[1]-S*0.3, b[2]-S*0.05, b[3]+S*0.2, b[2], b[3]);
                        ctx.lineWidth = b[4]; ctx.stroke();
                    });
                }},
                { name: 'Fur',  draw: function(ctx, S) {
                    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,S,S);
                    ctx.strokeStyle = '#000'; ctx.lineCap = 'round';
                    var rng2 = function(seed) { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };
                    var s2 = 42;
                    for (var i = 0; i < 18; i++) {
                        var bx = rng2(s2++) * S;
                        var by = S * 0.7 + rng2(s2++) * S * 0.3;
                        var tx = bx + (rng2(s2++) - 0.5) * S * 0.3;
                        var ty = rng2(s2++) * S * 0.5;
                        ctx.beginPath();
                        ctx.moveTo(bx, by);
                        ctx.bezierCurveTo(bx, by - S*0.1, tx, ty + S*0.1, tx, ty);
                        ctx.lineWidth = rng2(s2++) * 1.5 + 0.5;
                        ctx.stroke();
                    }
                }},
            ];

            var TIP_SIZE = 64;
            var library = document.getElementById('bs-tip-library');
            if (!library) return;

            TIPS.forEach(function(tip) {
                // Render to an offscreen canvas → data URL → img element for display
                var oc = document.createElement('canvas');
                oc.width = oc.height = TIP_SIZE;
                var octx = oc.getContext('2d');
                tip.draw(octx, TIP_SIZE);
                var dataUrl = oc.toDataURL('image/png');

                var thumb = document.createElement('canvas');
                thumb.width = thumb.height = TIP_SIZE;
                thumb.className = 'bs-tip-thumb';
                thumb.title = tip.name;
                thumb.dataset.tipName = tip.name;
                var tctx = thumb.getContext('2d');
                tctx.drawImage(oc, 0, 0);

                thumb.onclick = function() {
                    // tipHardness defaults to 100 for sharp built-in tips; user can soften
                    if (params.tipHardness === undefined) params.tipHardness = 100;
                    PaintApp.brush.loadCustomTip(dataUrl, tip.name);
                };
                library.appendChild(thumb);
            });
        })();

        setTimeout(refreshPreview, 120);

        /* ── 12. SAVED BRUSHES ───────────────────────────────────────────── */

        var _SAVED_KEY = 'paint.savedBrushes.v1';
        var _pendingSaveThumb = null; // data URL captured from preview canvas

        function _loadSavedBrushes() {
            try { return JSON.parse(this.lsGet(_SAVED_KEY) || '[]'); } catch(e) { return []; }
        }
        function _persistSavedBrushes(list) {
            try { this.lsSet(_SAVED_KEY, JSON.stringify(list)); } catch(e) {}
        }

        /* Render a tiny stroke onto a given canvas element using supplied params */
        function _renderThumbOnCanvas(canvas, p) {
            var ctx = canvas.getContext('2d');
            var W = canvas.width, H = canvas.height;
            ctx.clearRect(0,0,W,H);
            ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,W,H);
            var x0 = 10, x1 = W-10, y0 = H*0.65, y1 = H*0.35;
            var totalD = Math.sqrt((x1-x0)*(x1-x0)+(y1-y0)*(y1-y0));
            var avgSz = (p.startSize + p.endSize) / 2;
            // Scale size down to fit if huge
            var scale = Math.min(1, (H * 0.6) / Math.max(1, avgSz));
            var step = Math.max(1, avgSz * scale * p.spacing / 100);
            var color = (app.config && app.config.c1) ? app.config.c1 : '#000000';
            var d = 0;
            while (d <= totalD) {
                var t = totalD > 0 ? d / totalD : 0;
                var cx = x0 + (x1-x0)*t, cy = y0 + (y1-y0)*t;
                var sz = avgSz * scale;
                var alpha = (p.opacity/100)*(p.flow/100);
                var hardness = p.hardness/100;
                var r = sz/2;
                ctx.save();
                ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
                ctx.translate(cx, cy);
                ctx.rotate((p.angle||0) * Math.PI/180);
                if (p.shape === 'custom' && p.customTipCanvas) {
                    // Baked tip — colour fill then destination-in mask
                    ctx.fillStyle = color;
                    ctx.fillRect(-r, -r, sz, sz);
                    ctx.save();
                    ctx.globalCompositeOperation = 'destination-in';
                    ctx.drawImage(p.customTipCanvas, -r, -r, sz, sz);
                    ctx.restore();
                } else if (p.shape === 'circle' && hardness < 0.98) {
                    var rgb2 = hexToRgb(color);
                    var grad = ctx.createRadialGradient(0,0,r*hardness,0,0,r);
                    grad.addColorStop(0,'rgba('+rgb2.r+','+rgb2.g+','+rgb2.b+',1)');
                    grad.addColorStop(1,'rgba('+rgb2.r+','+rgb2.g+','+rgb2.b+',0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath(); ctx.arc(0,0,r,0,TWO_PI); ctx.fill();
                } else {
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    if      (p.shape==='circle')  ctx.arc(0,0,r,0,TWO_PI);
                    else if (p.shape==='square')  ctx.rect(-r,-r,sz,sz);
                    else if (p.shape==='diamond') { ctx.moveTo(0,-r);ctx.lineTo(r,0);ctx.lineTo(0,r);ctx.lineTo(-r,0);ctx.closePath(); }
                    else if (p.shape==='slash')   ctx.rect(-r,-r*0.22,sz,sz*0.44);
                    else if (p.shape==='line')    ctx.rect(-r,-Math.max(1,r*0.28),sz,Math.max(2,sz*0.56));
                    else ctx.arc(0,0,r,0,TWO_PI);
                    ctx.fill();
                }
                ctx.restore();
                d += step;
            }
        }

        function _rebuildRibbonBrushes() {
            var inner = document.getElementById('ribbon-brushes-inner');
            var empty = document.getElementById('ribbon-brushes-empty');
            if (!inner) return;
            // Remove existing cards
            Array.from(inner.querySelectorAll('.ribbon-brush-card')).forEach(function(el) { el.remove(); });
            var list = _loadSavedBrushes();
            if (empty) empty.style.display = list.length ? 'none' : '';
            list.forEach(function(brush, idx) {
                var card = document.createElement('div');
                card.className = 'ribbon-brush-card';
                card.title = brush.name;
                // Thumbnail canvas
                var thumb = document.createElement('canvas');
                thumb.width = 104; thumb.height = 72;
                card.appendChild(thumb);
                // Name label
                var label = document.createElement('div');
                label.className = 'rbc-name';
                label.textContent = brush.name;
                card.appendChild(label);
                // Delete button
                var del = document.createElement('div');
                del.className = 'rbc-delete';
                del.title = 'Remove';
                del.textContent = '×';
                del.onclick = function(e) {
                    e.stopPropagation();
                    var l = _loadSavedBrushes();
                    l.splice(idx, 1);
                    _persistSavedBrushes(l);
                    _rebuildRibbonBrushes();
                };
                card.appendChild(del);
                // Load on click
                card.onclick = function() {
                    params = Object.assign({}, DEFAULTS, brush.params);
                    // customTipCanvas can't survive localStorage serialisation; fall back to circle
                    if (params.shape === 'custom' && !params.customTipCanvas) {
                        params.shape = 'circle';
                    }
                    _syncSlidersToParams();
                    document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                        btn.classList.toggle('active', btn.dataset.shape === params.shape);
                    });
                    // Show/hide custom tip options row
                    var tipRow = document.getElementById('bs-custom-tip-row');
                    if (tipRow) tipRow.style.display = params.customTipCanvas ? '' : 'none';
                    document.querySelectorAll('.ribbon-brush-card').forEach(function(c) { c.classList.remove('active'); });
                    card.classList.add('active');
                    refreshPreview();
                };
                inner.insertBefore(card, empty || null);
                // Render thumb after DOM insert
                _renderThumbOnCanvas(thumb, brush.params);
            });
        }

        app.brush.saveCurrentBrush = function() {
            // Copy current preview canvas into modal preview
            var src = document.getElementById('brush-preview-canvas');
            var dest = document.getElementById('bnm-preview-canvas');
            if (src && dest) {
                var dctx = dest.getContext('2d');
                dctx.clearRect(0,0,dest.width,dest.height);
                dctx.fillStyle='#fff'; dctx.fillRect(0,0,dest.width,dest.height);
                dctx.drawImage(src, 0, 0, dest.width, dest.height);
            }
            _pendingSaveThumb = src ? src.toDataURL() : null;
            // Suggest a default name from shape
            var nameInput = document.getElementById('bnm-name-input');
            if (nameInput) {
                var shapes = { circle:'Round', square:'Square', diamond:'Diamond', slash:'Calligraphy', line:'Flat' };
                nameInput.value = (shapes[params.shape] || 'Custom') + ' ' + params.startSize + 'px';
                setTimeout(function(){ nameInput.select(); }, 50);
            }
            var modal = document.getElementById('brush-name-modal');
            if (modal) modal.classList.add('open');
        };

        app.brush._cancelSave = function() {
            var modal = document.getElementById('brush-name-modal');
            if (modal) modal.classList.remove('open');
            _pendingSaveThumb = null;
        };

        app.brush._confirmSave = function() {
            var nameInput = document.getElementById('bnm-name-input');
            var name = (nameInput ? nameInput.value.trim() : '') || 'My Brush';
            var list = _loadSavedBrushes();
            list.push({ name: name, params: Object.assign({}, params), thumb: _pendingSaveThumb });
            _persistSavedBrushes(list);
            _rebuildRibbonBrushes();
            var modal = document.getElementById('brush-name-modal');
            if (modal) modal.classList.remove('open');
            _pendingSaveThumb = null;
        };

        // Allow Enter key to confirm save
        (function() {
            var inp = document.getElementById('bnm-name-input');
            if (inp) inp.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') app.brush._confirmSave();
                if (e.key === 'Escape') app.brush._cancelSave();
            });
            // Click outside modal box to cancel
            var modal = document.getElementById('brush-name-modal');
            if (modal) modal.addEventListener('click', function(e) {
                if (e.target === modal) app.brush._cancelSave();
            });
        })();

        // Build ribbon on load
        _rebuildRibbonBrushes();

        /* ══════════════════════════════════════════════════════════════════════
         * KRITA PRESET COMPATIBILITY LAYER
         * ══════════════════════════════════════════════════════════════════════
         *
         * Adds support for loading Krita .kpp preset files and maps the David
         * Revoy "Krita 4 Extras" brush pack (davidrevoy.com/article742) to this
         * engine's parameters.
         *
         * Architecture overview
         * ─────────────────────
         * Krita presets are XML files.  Each <param> element carries a name and
         * value that together define one property of the brush (opacity, size,
         * spacing, smudge rate, etc.).  The mapping to this engine's params is
         * done in two steps:
         *
         *   1. _parseKppXml(xmlText)  → raw key/value map of all Krita params
         *   2. _kritaParamsToEngine(rawMap) → engine params object
         *
         * The second step handles the non-trivial conversions:
         *   • Krita spacing is 0–2 (fraction of diameter); engine spacing is
         *     0–200 (percentage of brush size).  Multiply by 100.
         *   • Krita opacity/flow are 0–1 (qreal); engine uses 0–100 integers.
         *   • Krita brush size (diameter) is in device pixels.  The engine uses
         *     startSize/endSize in the same pixel units, so we pass it through.
         *   • Krita smudge ("smudge_rate") is mapped to engine smudge (0–100).
         *   • Krita colorRate pigments the picked-up smudge colour with the
         *     foreground colour; translated to engine colorFade.
         *   • Krita scatter ("Scatter", "scatter_x", "scatter_y") maps to the
         *     engine's scatter + scatterRadius.
         *   • Krita texture options map to engine texture + grainScale.
         *   • Krita "use_pressure_opacity" / "use_pressure_size" sensor curves
         *     translate into speedOpacity / speedSize influences.
         *   • Krita softness / hardness are equivalent to engine hardness.
         *   • The "color smudge" paintop uses dulling mode: engine smudge is set
         *     to smudgeRate * 100, and colorFade is set to colorRate * 100.
         *   • Bristle brush maps to the engine's bristle shape.
         *   • Predefined (image) tips load as customTip when a dataURL is
         *     embedded; otherwise the engine falls back to the nearest primitive.
         *
         * David Revoy preset definitions
         * ──────────────────────────────
         * The 25 presets are defined below as pre-mapped engine param objects so
         * they load instantly without parsing XML.  The naming follows the
         * filenames in the Krita 4 Extras zip (e.g. "c_pencil-1_sketch-update",
         * "h_hardpainting-06_wet-on-wet-canvas", etc.).  Revoy's preset letters
         * are preserved as category hints (c=pencil, f=painting, g=drybrushing,
         * h=hardpainting, b=basic, j=inking, u=pixel, v=dashed, y=texture).
         */

        /* ── KPP XML parser ──────────────────────────────────────────────────
           Parses a Krita .kpp XML string into a flat key→value map.
           Handles both <param name="key" value="val"/> and nested <params> trees.
           Returns an object; all values are strings (convert as needed). */
        function _parseKppXml(xmlText) {
            var map = {};
            try {
                var parser = new DOMParser();
                var doc = parser.parseFromString(xmlText, 'text/xml');
                // Walk all <param> elements anywhere in the tree
                var params = doc.getElementsByTagName('param');
                for (var i = 0; i < params.length; i++) {
                    var el = params[i];
                    var name  = el.getAttribute('name');
                    var value = el.getAttribute('value');
                    // Some params embed inner XML/text
                    if (value === null) value = el.textContent || '';
                    if (name) map[name] = value;
                }
                // Also grab top-level attributes on <preset>
                var preset = doc.getElementsByTagName('preset')[0];
                if (preset) {
                    var attrs = preset.attributes;
                    for (var j = 0; j < attrs.length; j++) {
                        map['_' + attrs[j].name] = attrs[j].value;
                    }
                }
            } catch (e) {
                console.warn('[KritaCompat] XML parse error:', e);
            }
            return map;
        }

        /* ── Krita → engine param converter ─────────────────────────────────
           Takes a raw kpp param map and returns an engine params delta that can
           be merged with DEFAULTS via Object.assign({}, DEFAULTS, delta).

           Only parameters recognised by this engine are emitted; unknown Krita
           options (gradient, pattern, selection, etc.) are silently ignored. */
        function _kritaParamsToEngine(kpp) {
            // Helper: parse float with fallback
            function f(key, def) {
                var v = parseFloat(kpp[key]);
                return isNaN(v) ? def : v;
            }
            // Helper: bool string ('true'/'1'/'yes') → boolean
            function b(key, def) {
                var v = kpp[key];
                if (v === undefined) return def;
                return v === 'true' || v === '1' || v === 'yes';
            }

            var out = {};

            // ── Brush size (Krita: "PaintOp/size" in pixels) ──────────────
            var diameter = f('PaintOp/size', f('brush_definition/brush_size', 0));
            if (diameter > 0) {
                out.startSize = Math.round(diameter);
                out.endSize   = Math.round(diameter);
            }

            // ── Spacing (Krita: 0.01–2.0 fraction; engine: 5–200%) ────────
            var spacing = f('Spacing/spacing', f('spacing', -1));
            if (spacing >= 0) out.spacing = Math.round(Math.max(5, spacing * 100));
            if (b('Spacing/isotropic', false)) out.spacing = Math.max(5, out.spacing || 20);

            // ── Angle ─────────────────────────────────────────────────────
            var angleDeg = f('brush_definition/angle', f('Angle/angle', 0)) * 180 / Math.PI;
            // Krita angle is in radians in XML
            if (Math.abs(angleDeg) < 0.001) angleDeg = f('brush_definition/angle', 0); // might already be degrees
            if (Math.abs(angleDeg) > 360) angleDeg = angleDeg * 180 / Math.PI;
            out.angle = Math.round(angleDeg) % 360;

            // ── Opacity & Flow (Krita: 0–1 → engine: 0–100) ──────────────
            var op = f('Opacity/opacity', f('opacity', -1));
            if (op >= 0) out.opacity = Math.round(Math.min(100, op * 100));
            var fl = f('Flow/flow', f('flow', -1));
            if (fl >= 0) out.flow = Math.round(Math.min(100, fl * 100));

            // ── Hardness / Softness ───────────────────────────────────────
            // Krita softness is inverted (0=sharp, 1=soft); engine hardness same direction
            var softness = f('MaskGenerator/softness', -1);
            if (softness >= 0) out.hardness = Math.round((1 - softness) * 100);
            var hardness = f('hardness', -1);
            if (hardness >= 0) out.hardness = Math.round(hardness * 100);

            // ── Shape ─────────────────────────────────────────────────────
            var generatorType = kpp['MaskGenerator/type'] || kpp['brush_type'] || '';
            var predefinedFile = kpp['brush_definition/filename'] || kpp['filename'] || '';
            if (generatorType === 'rect' || generatorType === 'rectangle') {
                out.shape = 'square';
            } else if (predefinedFile) {
                // Predefined image tip — leave shape as circle (will be overridden by tip load)
                out.shape = 'circle';
            } else {
                out.shape = 'circle'; // 'circle' is the Krita default
            }

            // ── Smudge / Color Smudge (colorsmudge paintop) ───────────────
            // Krita "smudgeRate" = how much canvas colour is picked up (0–1)
            // Krita "colorRate"  = how much the foreground colour tints the smudge
            var smudgeRate = f('SmudgeLength/smudge_rate', f('smudge_rate', -1));
            if (smudgeRate >= 0) out.smudge = Math.round(smudgeRate * 100);
            var colorRate  = f('ColorRate/color_rate', f('color_rate', -1));
            if (colorRate  >= 0) out.colorFade = Math.round(colorRate * 100);

            // Krita "dulling mode": blends smeared colour with paint colour at colorRate
            // Map to engine wetness for the blending feel
            var useDulling = b('SmudgeLength/use_new_engine', false) ||
                             kpp['SmudgeLength/smudge_mode'] === 'dulling';
            if (useDulling && out.smudge > 0) {
                out.wetness = Math.round(Math.min(60, (out.smudge || 0) * 0.6));
            }

            // ── Scatter ───────────────────────────────────────────────────
            var scatterOn = b('Scatter/scatter_enabled', false);
            if (scatterOn) {
                var scatterX = f('Scatter/scatter_x', 0);
                var scatterY = f('Scatter/scatter_y', 0);
                var scatterCount = f('Scatter/count', 1);
                out.scatter = Math.round(Math.min(14, scatterCount * 3));
                out.scatterRadius = Math.round(Math.min(40, (scatterX + scatterY) * 0.5 * 20 + 6));
            }

            // ── Texture / Grain ───────────────────────────────────────────
            var textureOn = b('Texture/texture_enabled', false) || b('textureEnabled', false);
            if (textureOn) {
                var textureStrength = f('Texture/texture_strength', 0.5);
                out.texture = Math.round(textureStrength * 80);
                var textureScale = f('Texture/texture_scale', 1.0);
                out.grainScale = Math.max(1, Math.round(textureScale * 4));
            }

            // ── Pressure → Size sensor ────────────────────────────────────
            var sizeUsePressure = b('Size/size_sensor_pressure', false) ||
                                  b('use_pressure_size', false) ||
                                  kpp['Size/size_pressure_enabled'] === 'true';
            if (sizeUsePressure) {
                // Pressure-driven size: fast movement = larger brush analogue
                // Map as slight positive speedSize so the feel is pressure-like
                out.speedSize = 20;
            }

            // ── Pressure → Opacity sensor ─────────────────────────────────
            var opUsePressure = b('Opacity/opacity_sensor_pressure', false) ||
                                b('use_pressure_opacity', false);
            if (opUsePressure) {
                out.speedOpacity = 25;
            }

            // ── Airbrush accumulation ─────────────────────────────────────
            var airbrush = b('airbrush_enabled', false);
            if (airbrush) {
                out.airbrushMode = true;
                out.airbrushRate = Math.round(f('airbrush_rate', 0.25) * 100);
            }

            // ── Bristle brush ─────────────────────────────────────────────
            var paintopId = kpp['_paintopid'] || kpp['paintopid'] || '';
            if (paintopId === 'bristle' || paintopId.indexOf('bristle') !== -1) {
                out.shape = 'bristle';
                out.bristleCount  = Math.round(f('bristle_count', 8));
                out.bristleSpread = Math.round(f('bristle_spread', 40));
            }

            // ── Taper (Krita: fade-out via sensor curves) ─────────────────
            var taperFadeOut = b('Size/size_fade_enabled', false);
            if (taperFadeOut) out.taper = 50;

            // Strip undefined/default-identical values to keep the object lean
            return out;
        }

        /* ── Phase 3: Krita sensor-curve parser and LUT generator ────────────
         *
         * Krita pressure curves live in XML like:
         *   <param name="Size/size_sensor_pressure">
         *     <curve>
         *       <point x="0" y="0"/><point x="0.5" y="0.8"/><point x="1" y="1"/>
         *     </curve>
         *   </param>
         *
         * We parse the control points, build a monotone cubic spline (Fritsch-
         * Carlson), and sample it at 256 evenly-spaced pressure values to produce
         * a LUT.  The LUT is stored on params so the hot path can index it with
         * a single integer lookup instead of evaluating the spline live.
         *
         * LUTs are stored as:
         *   params._sizeLUT    — Float32Array[256]  (0→1 output) or null
         *   params._opacityLUT — Float32Array[256]  (0→1 output) or null
         *
         * A null LUT means "use the default linear ramp" (current behaviour).
         */

        /* Parse <curve>/<point> nodes from a raw kpp param string. */
        function _parseCurvePoints(xmlParamText) {
            var pts = [];
            try {
                var doc = (new DOMParser()).parseFromString(
                    '<root>' + xmlParamText + '</root>', 'text/xml');
                var nodes = doc.getElementsByTagName('point');
                for (var i = 0; i < nodes.length; i++) {
                    var x = parseFloat(nodes[i].getAttribute('x'));
                    var y = parseFloat(nodes[i].getAttribute('y'));
                    if (!isNaN(x) && !isNaN(y)) {
                        pts.push({ x: Math.max(0, Math.min(1, x)),
                                   y: Math.max(0, Math.min(1, y)) });
                    }
                }
                /* Sort ascending by x so the spline is well-behaved */
                pts.sort(function(a, b) { return a.x - b.x; });
            } catch (e) { /* ignore — returns empty array */ }
            return pts;
        }

        /* Monotone cubic (Fritsch-Carlson) spline evaluation.
         * pts: [{x,y}] sorted ascending, length ≥ 2.
         * t:   query value in [0,1].
         * Returns interpolated y clamped to [0,1]. */
        function _evalMonotoneCubic(pts, t) {
            var n = pts.length;
            if (n === 0) return t;
            if (n === 1) return pts[0].y;
            if (t <= pts[0].x) return pts[0].y;
            if (t >= pts[n - 1].x) return pts[n - 1].y;

            /* Find the segment */
            var k = 0;
            for (var i = 1; i < n - 1; i++) { if (pts[i].x <= t) k = i; }

            var p0 = pts[k], p1 = pts[k + 1];
            var dx = p1.x - p0.x;
            if (dx < 1e-8) return p0.y;

            /* Secant slopes */
            var m0 = (p1.y - p0.y) / dx;

            /* Use finite differences for tangents (Catmull-Rom style, clamped) */
            var t0 = m0, t1 = m0;
            if (k > 0) {
                var d = (p0.y - pts[k - 1].y) / (p0.x - pts[k - 1].x);
                t0 = (Math.sign(d) === Math.sign(m0)) ? (d + m0) / 2 : 0;
                /* Monotonicity constraint */
                if (Math.abs(t0) > 3 * Math.abs(m0)) t0 = 3 * m0;
            }
            if (k < n - 2) {
                var d2 = (pts[k + 2].y - p1.y) / (pts[k + 2].x - p1.x);
                t1 = (Math.sign(d2) === Math.sign(m0)) ? (m0 + d2) / 2 : 0;
                if (Math.abs(t1) > 3 * Math.abs(m0)) t1 = 3 * m0;
            }

            /* Hermite basis */
            var u  = (t - p0.x) / dx;
            var u2 = u * u, u3 = u2 * u;
            var h00 = 2*u3 - 3*u2 + 1;
            var h10 = u3  - 2*u2 + u;
            var h01 = -2*u3 + 3*u2;
            var h11 = u3  - u2;
            var y   = h00*p0.y + h10*dx*t0 + h01*p1.y + h11*dx*t1;
            return Math.max(0, Math.min(1, y));
        }

        /* Build a Float32Array[256] LUT from control points.
         * Index 0 = pressure 0.0, index 255 = pressure 1.0.
         * Returns null if pts is empty or trivially linear. */
        function _buildSensorLUT(pts) {
            if (!pts || pts.length < 2) return null;
            /* Check if the curve is trivially y=x (within 0.01 tolerance) */
            var trivial = pts.every(function(p) { return Math.abs(p.y - p.x) < 0.01; });
            if (trivial) return null;

            var lut = new Float32Array(256);
            for (var i = 0; i < 256; i++) {
                lut[i] = _evalMonotoneCubic(pts, i / 255);
            }
            return lut;
        }

        /* Evaluate a LUT at a pressure value in [0,1].
         * Quantises to the nearest 1% (100 steps) for cache friendliness. */
        function _evalLUT(lut, pressure) {
            if (!lut) return pressure;
            /* Quantise to nearest 1% before indexing */
            var pq  = Math.round(pressure * 100) / 100;
            var idx = Math.round(pq * 255);
            return lut[Math.max(0, Math.min(255, idx))];
        }

        /* Parse both sensor-curve blocks from the raw kpp map and store LUTs. */
        function _parseSensorCurves(raw) {
            /* Size sensor */
            var sizeCurveXml = raw['Size/size_sensor_pressure'] || raw['size_curve'] || '';
            params._sizeLUT = _buildSensorLUT(_parseCurvePoints(sizeCurveXml));

            /* Opacity sensor */
            var opCurveXml = raw['Opacity/opacity_sensor_pressure'] || raw['opacity_curve'] || '';
            params._opacityLUT = _buildSensorLUT(_parseCurvePoints(opCurveXml));
        }

        /* ── Phase 4: Krita texture pattern loader ────────────────────────────
         * Loads a PNG (from the ZIP's pattern section) into an OffscreenCanvas,
         * then stores it on params._kritaTextureTile.  _getGrainCanvas() checks
         * for this tile and uses it instead of the procedural noise when present.
         */
        function _loadKritaTexturePattern(url, onDone) {
            var img = new Image();
            img.onload = function() {
                var W = img.width || 128, H = img.height || 128;
                var oc = (typeof OffscreenCanvas !== 'undefined')
                    ? new OffscreenCanvas(W, H)
                    : (function(){ var c = document.createElement('canvas'); c.width=W; c.height=H; return c; })();
                oc.getContext('2d').drawImage(img, 0, 0);
                params._kritaTextureTile = oc;
                /* Invalidate grain cache so the next dab picks up the new tile */
                _grainCache = null;
                _grainCacheSize = -1;
                if (typeof onDone === 'function') onDone();
            };
            img.onerror = function() {
                console.warn('[KritaCompat] Failed to load texture pattern:', url);
                if (typeof onDone === 'function') onDone();
            };
            img.src = url;
        }


        /* ── Public API: load a .kpp file ───────────────────────────────────
         * We load JSZip on demand (CDN, cached on window._JSZipLib), unzip in
         * memory, extract maindoc.xml for the param parser, and collect any
         * PNG files under brush_tips/ for Phase 2 tip injection.
         *
         * Falls back to the legacy plain-XML path when JSZip is unavailable or
         * when the caller passes an XML string directly.
         */

        /* Lazily load JSZip from cdnjs, cache the constructor on window. */
        function _loadJSZip() {
            return new Promise(function(resolve, reject) {
                if (window._JSZipLib) { resolve(window._JSZipLib); return; }
                var s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
                s.onload  = function() { window._JSZipLib = window.JSZip; resolve(window.JSZip); };
                s.onerror = function() { reject(new Error('[KritaCompat] JSZip failed to load')); };
                document.head.appendChild(s);
            });
        }

        /* Apply a parsed XML string + an optional map of { filename → Uint8Array }
         * for any PNG tip files found in the ZIP. */
        function _applyKppXml(xmlText, tipPngs, presetName) {
            var raw   = _parseKppXml(xmlText);
            var delta = _kritaParamsToEngine(raw);
            params = Object.assign({}, DEFAULTS, delta);

            /* Phase 2: if the preset references a predefined image tip AND we
             * found matching PNGs in the archive, load the first one as a custom
             * tip instead of falling back to a primitive shape. */
            var tipFilename = raw['brush_definition/filename'] || raw['filename'] || '';
            if (tipFilename && tipPngs) {
                /* Match by basename (strip path, compare case-insensitively) */
                var tipBase = tipFilename.split('/').pop().split('\\').pop().toLowerCase();
                var matchKey = Object.keys(tipPngs).find(function(k) {
                    return k.split('/').pop().toLowerCase() === tipBase;
                });
                if (!matchKey) {
                    /* Second attempt: any PNG in the archive */
                    matchKey = Object.keys(tipPngs)[0];
                }
                if (matchKey) {
                    var pngData = tipPngs[matchKey];
                    var blob    = new Blob([pngData], { type: 'image/png' });
                    var url     = URL.createObjectURL(blob);
                    /* loadCustomTip will call _rebakeTip() and set params.shape = 'custom' */
                    app.brush.loadCustomTip(url, tipFilename.split('/').pop());
                    /* Revoke the object URL after the image has loaded (handled inside
                     * loadCustomTip via img.onload; we pass a cleanup callback via the
                     * _kppTipCleanup hook so the blob URL isn't leaked). */
                    params._kppTipBlobUrl = url;
                }
            }

            /* Phase 3: parse sensor-curve LUTs and store on params */
            _parseSensorCurves(raw);

            /* Phase 4: extract texture pattern PNG if texture is enabled */
            var textureOn = raw['Texture/texture_enabled'] === 'true' ||
                            raw['textureEnabled'] === 'true';
            if (textureOn && tipPngs) {
                var patKey = Object.keys(tipPngs).find(function(k) {
                    return k.indexOf('pattern') !== -1 || k.indexOf('texture') !== -1;
                });
                if (!patKey) {
                    /* Grab the first PNG that isn't the brush tip */
                    var tipMatchKey = Object.keys(tipPngs).find(function(k) {
                        var base = k.split('/').pop().toLowerCase();
                        return base === (tipFilename.split('/').pop().toLowerCase());
                    });
                    patKey = Object.keys(tipPngs).find(function(k) { return k !== tipMatchKey; });
                }
                if (patKey) {
                    var patBlob = new Blob([tipPngs[patKey]], { type: 'image/png' });
                    var patUrl  = URL.createObjectURL(patBlob);
                    _loadKritaTexturePattern(patUrl, function() { URL.revokeObjectURL(patUrl); });
                }
            }

            _syncSlidersToParams();
            document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                btn.classList.toggle('active', btn.dataset.shape === params.shape);
            });
            document.querySelectorAll('.brush-preset-btn').forEach(function(btn) {
                btn.classList.remove('active');
            });
            refreshPreview();
            if (presetName) {
                var nameEl = document.getElementById('brush-preset-name-label');
                if (nameEl) nameEl.textContent = presetName;
            }
        }

        app.brush.loadKritaPreset = function(kppTextOrFile, name) {
            /* Plain XML string — legacy fast path */
            if (typeof kppTextOrFile === 'string' && kppTextOrFile.trim().startsWith('<')) {
                _applyKppXml(kppTextOrFile, null, name || 'Krita Preset');
                return;
            }

            if (!(kppTextOrFile instanceof File) && !(kppTextOrFile instanceof ArrayBuffer)) {
                console.warn('[KritaCompat] loadKritaPreset: expected File, ArrayBuffer, or XML string');
                return;
            }

            var presetName = name || (kppTextOrFile instanceof File
                ? kppTextOrFile.name.replace(/\.kpp$/i, '')
                : 'Krita Preset');

            /* Read file as ArrayBuffer so we can try ZIP first */
            function _processBuffer(buf) {
                _loadJSZip().then(function(JSZip) {
                    return JSZip.loadAsync(buf);
                }).then(function(zip) {
                    /* Locate maindoc.xml (top-level entry in the ZIP) */
                    var xmlFile = zip.file('maindoc.xml') || zip.file(/maindoc\.xml$/i)[0];
                    if (!xmlFile) throw new Error('maindoc.xml not found in .kpp archive');

                    /* Collect all PNG files (brush tips + patterns) */
                    var pngFiles = {};
                    zip.forEach(function(relPath, entry) {
                        if (/\.png$/i.test(relPath) && !entry.dir) {
                            pngFiles[relPath] = entry;
                        }
                    });

                    /* Extract XML and all PNGs in parallel */
                    var xmlPromise  = xmlFile.async('string');
                    var pngKeys     = Object.keys(pngFiles);
                    var pngPromises = pngKeys.map(function(k) {
                        return pngFiles[k].async('uint8array');
                    });

                    return Promise.all([xmlPromise, Promise.all(pngPromises)]).then(function(results) {
                        var xmlText = results[0];
                        var pngDataArr = results[1];
                        var tipMap = {};
                        pngKeys.forEach(function(k, i) { tipMap[k] = pngDataArr[i]; });
                        return { xmlText: xmlText, tipMap: tipMap };
                    });
                }).then(function(data) {
                    _applyKppXml(data.xmlText, data.tipMap, presetName);
                }).catch(function(zipErr) {
                    /* Not a ZIP (or JSZip unavailable) — try reading as plain text */
                    console.warn('[KritaCompat] ZIP extraction failed, trying plain text:', zipErr.message);
                    try {
                        var text = new TextDecoder().decode(new Uint8Array(buf));
                        if (text.trim().startsWith('<')) {
                            _applyKppXml(text, null, presetName);
                        } else {
                            console.error('[KritaCompat] File is neither a ZIP nor XML:', presetName);
                        }
                    } catch(e) {
                        console.error('[KritaCompat] Could not decode file:', e);
                    }
                });
            }

            if (kppTextOrFile instanceof ArrayBuffer) {
                _processBuffer(kppTextOrFile);
            } else {
                var fr = new FileReader();
                fr.onload = function(e) { _processBuffer(e.target.result); };
                fr.readAsArrayBuffer(kppTextOrFile);
            }
        };

        /* ══════════════════════════════════════════════════════════════════════
         * DAVID REVOY "KRITA 4 EXTRAS" PRESET DEFINITIONS
         * ══════════════════════════════════════════════════════════════════════
         *
         * 25 presets mapped from the CC-BY 4.0 pack at:
         * https://www.davidrevoy.com/article742/krita-4-extras-brush-presets-pack
         *
         * Parameter mapping rationale per preset is documented inline.
         * All presets merge with DEFAULTS so only differing keys are listed.
         *
         * Naming follows Revoy's filename convention:
         *   c_ = pencil/drawing    f_ = painting       g_ = dry
         *   h_ = hardpainting      b_ = basic/fill      j_ = inking
         *   u_ = pixel/utility     v_ = special         y_ = texture
         */
        const REVOY_PRESETS = {

            // ── DRAWING TOOLS ───────────────────────────────────────────────

            /* c_pencil-1_sketch-update
               Soft pressure-sensitive pencil for sketching.  Krita original:
               predefined brush (bristle-like), opacity on pressure, subtle
               texture, 50% flow.  Mapped to: small circle with grain + speed
               opacity to simulate pressure, soft hardness for build-up feel. */
            'c_pencil-1_sketch': {
                shape: 'circle', startSize: 7, endSize: 1,
                spacing: 12, hardness: 70, opacity: 75, flow: 50,
                taper: 60, texture: 18, grainScale: 3,
                speedSize: -15, speedOpacity: 30,
                sizeJitter: 8, angleJitter: 5,
                scatter: 0, smudge: 0, wetness: 0,
            },

            /* c_pencil-2-update
               Line-art pencil with subtle grain, slightly more expressive than
               pencil-1.  Krita: predefined dirty-ellipse tip, mid hardness,
               pressure on size+opacity.  Softer grain, slightly wider. */
            'c_pencil-2': {
                shape: 'custom', _tipUrl: 'brush-packs/revoy-extras/tips/deevad-2019_ellipse-bold.png', _nativeShape: 'circle',
                startSize: 9, endSize: 1,
                spacing: 10, hardness: 60, opacity: 85, flow: 60,
                taper: 50, texture: 12, grainScale: 2,
                speedSize: -20, speedOpacity: 25,
                sizeJitter: 5, angleJitter: 3,
                smudge: 0, wetness: 0, scatter: 0,
            },

            /* c_super-soft-mechanical-pencil
               Very digital / smooth, no grain, very hard edges, pressure on
               size only.  Like a perfect mechanical pencil on bristol.  Krita:
               auto-ellipse tip, full hardness, minimal texture.  Maps to hard
               circle with taper and no texture. */
            'c_super-soft-mechanical-pencil': {
                shape: 'circle', startSize: 6, endSize: 1,
                spacing: 10, hardness: 98, opacity: 95, flow: 80,
                taper: 65, texture: 0,
                speedSize: -25, speedOpacity: 0,
                sizeJitter: 0, angleJitter: 0, smudge: 0, wetness: 0,
            },

            /* h_charcoal-pencil-broad-sketch
               Large, heavily textured charcoal pencil.  Krita: predefined
               charcoal tip, large diameter, very rough texture, slight scatter
               for organic feel.  Use with bright gray. */
            'h_charcoal-pencil-broad-sketch': {
                shape: 'line', startSize: 28, endSize: 18,
                spacing: 14, hardness: 22, opacity: 70, flow: 50,
                taper: 25, texture: 80, grainScale: 3,
                speedSize: -10, speedOpacity: 15,
                sizeJitter: 20, angleJitter: 30,
                scatter: 2, scatterRadius: 8, smudge: 0, wetness: 0,
            },

            // ── PAINTING ────────────────────────────────────────────────────

            /* f_soft-painting-small
               Revoy's most-used brush for smoothing + details.  Krita: soft
               round predefined tip, flow < opacity, low pressure fade, slight
               glazing capability.  Pressure drives opacity for build-up. */
            'f_soft-painting-small': {
                shape: 'circle', startSize: 22, endSize: 18,
                spacing: 15, hardness: 20, opacity: 65, flow: 30,
                taper: 20, texture: 0,
                speedSize: 0, speedOpacity: 20,
                smudge: 8, wetness: 10, scatter: 0,
                colorFade: 0,
            },

            /* f_bristles-gentle-rub
               Gouache-on-paper feel.  Krita: bristle predefined tip, mid flow,
               subtle grain, no smudge.  Mapped to bristle shape with grain. */
            'f_bristles-gentle-rub': {
                shape: 'custom', _tipUrl: 'brush-packs/revoy-extras/tips/deevad-2019_toka_05.png', _nativeShape: 'bristle',
                startSize: 24, endSize: 20,
                spacing: 8, hardness: 70, opacity: 75, flow: 55,
                taper: 15, texture: 22, grainScale: 3,
                bristleCount: 10, bristleSpread: 45,
                speedSize: 0, speedOpacity: 15,
                smudge: 5, wetness: 5, scatter: 0,
            },

            /* f_sharp-silhouette-shape
               Hard-edged dynamic strokes with rough edges.  Krita: predefined
               spatter tip, full hardness, high opacity.  Maps to circle with
               scatter for rough edge and sizeJitter for energy. */
            'f_sharp-silhouette-shape': {
                shape: 'circle', startSize: 20, endSize: 14,
                spacing: 12, hardness: 90, opacity: 95, flow: 85,
                taper: 35, texture: 8, grainScale: 2,
                speedSize: -20, speedOpacity: 0,
                scatter: 3, scatterRadius: 8,
                sizeJitter: 18, angleJitter: 15,
                smudge: 0, wetness: 0,
            },

            /* h_chalk-soft_update
               Big shape blocking with chalk texture.  Krita: chalk predefined
               tip, soft edges, heavy grain.  Wide, low opacity, high texture. */
            'h_chalk-soft': {
                shape: 'circle', startSize: 30, endSize: 25,
                spacing: 16, hardness: 12, opacity: 55, flow: 35,
                taper: 20, texture: 65, grainScale: 4,
                speedSize: 0, speedOpacity: 10,
                scatter: 2, scatterRadius: 10,
                sizeJitter: 15, angleJitter: 20,
                smudge: 0, wetness: 0,
            },

            /* g_dry-brushing-modeling
               Dry, soft for smoke/proto shapes.  Krita: soft dry-brush tip,
               very low flow, scatter-spread.  Maps to low-opacity scatter. */
            'g_dry-brushing-modeling': {
                shape: 'circle', startSize: 28, endSize: 20,
                spacing: 18, hardness: 5, opacity: 45, flow: 20,
                taper: 30, texture: 25, grainScale: 4,
                scatter: 5, scatterRadius: 16,
                sizeJitter: 20, angleJitter: 10,
                smudge: 0, wetness: 5,
            },

            /* j_simple-irregular-edges
               Gentle texture for colouring pencil art.  Krita: predefined
               semi-irregular round tip, mid-opacity, slight grain, very smooth.
               Less plastic than digital round. */
            'j_simple-irregular-edges': {
                shape: 'circle', startSize: 18, endSize: 14,
                spacing: 12, hardness: 55, opacity: 80, flow: 60,
                taper: 15, texture: 15, grainScale: 3,
                speedSize: 0, speedOpacity: 20,
                sizeJitter: 6, angleJitter: 8,
                smudge: 3, wetness: 0, scatter: 0,
            },

            // ── HARDPAINTING SERIES ─────────────────────────────────────────

            /* h_hardpainting-01-details
               Inking-style detail brush with subtle ghosting.  Krita: predefined
               slightly dirty ellipse, full opacity, slight taper.  Like the
               "ink" PRESET but with a soft ghost fringe from scatter. */
            'h_hardpainting-01-details': {
                shape: 'custom', _tipUrl: 'brush-packs/revoy-extras/tips/deevad-2019_ellipse-dots.png', _nativeShape: 'circle',
                startSize: 10, endSize: 1,
                spacing: 12, hardness: 95, opacity: 100, flow: 95,
                taper: 70, texture: 6, grainScale: 2,
                speedSize: -15, speedOpacity: 0,
                scatter: 1, scatterRadius: 5,
                sizeJitter: 5, angleJitter: 2,
                smudge: 0, wetness: 0,
            },

            /* h_hardpainting-02-textured-dry-details
               Canvas texture revealed by painting bright on dark.  Krita:
               predefined canvas tip, mid hardness, heavy grain.  High texture,
               works best with speedOpacity for build-up. */
            'h_hardpainting-02-textured-dry-details': {
                shape: 'circle', startSize: 14, endSize: 8,
                spacing: 14, hardness: 45, opacity: 75, flow: 50,
                taper: 30, texture: 70, grainScale: 3,
                speedSize: -10, speedOpacity: 20,
                scatter: 0, smudge: 0, wetness: 0,
                sizeJitter: 10, angleJitter: 5,
            },

            /* h_hardpainting-03-expressive-knife
               Palette-knife feel.  Krita: predefined flat knife tip, very hard,
               full opacity, angled with angleJitter.  Maps to slash shape with
               high hardness and slight position jitter. */
            'h_hardpainting-03-expressive-knife': {
                shape: 'custom', _tipUrl: 'brush-packs/revoy-extras/tips/flat-tip-dirty.png', _nativeShape: 'slash',
                startSize: 26, endSize: 20,
                spacing: 8, hardness: 88, opacity: 95, flow: 90,
                taper: 10, texture: 12, grainScale: 2,
                angle: 0, angleJitter: 35,
                posJitter: 3, sizeJitter: 12,
                smudge: 10, wetness: 15, scatter: 0,
            },

            /* h_hardpainting-04-soft-block-edges
               Volume modeling; slightly flat angular tip.  Krita: predefined
               broad soft tip, low-medium hardness.  Maps to slash with mid
               hardness and small angle jitter. */
            'h_hardpainting-04-soft-block-edges': {
                shape: 'slash', startSize: 22, endSize: 18,
                spacing: 12, hardness: 40, opacity: 80, flow: 60,
                taper: 20, texture: 8, grainScale: 3,
                angle: 0, angleJitter: 20,
                speedSize: 0, speedOpacity: 15,
                smudge: 5, wetness: 8, scatter: 0,
            },

            /* h_hardpainting-05-gentle-rub-soft-overlays
               Semi-transparent overlay brush that shows canvas texture.  Krita:
               predefined semi-dirty tip, low opacity, texture visible through
               paint.  Maps to low opacity/flow with high grain. */
            'h_hardpainting-05-gentle-rub-soft-overlays': {
                shape: 'circle', startSize: 26, endSize: 22,
                spacing: 14, hardness: 25, opacity: 45, flow: 25,
                taper: 15, texture: 55, grainScale: 4,
                speedSize: 0, speedOpacity: 10,
                smudge: 5, wetness: 5, scatter: 0,
                sizeJitter: 10, angleJitter: 5,
            },

            /* h_hardpainting-06-wet-on-wet-canvas
               Color-smudge / mixing brush.  Krita: colorsmudge paintop, dulling
               mode, mid smudge rate, some color rate.  Maps to high smudge with
               wetness + colorFade for canvas blending. */
            'h_hardpainting-06-wet-on-wet-canvas': {
                shape: 'circle', startSize: 24, endSize: 20,
                spacing: 12, hardness: 30, opacity: 80, flow: 55,
                taper: 10, texture: 20, grainScale: 3,
                smudge: 55, wetness: 35, colorFade: 20,
                speedSize: 0, speedOpacity: 10,
                scatter: 0, sizeJitter: 8,
            },

            /* h_hardpainting-07-dry-hard-rub-small
               Small dry rub for adding grain at end of painting.  Krita:
               canvas-texture predefined tip, hard edges, very dry.  High
               texture, low scatter, small size. */
            'h_hardpainting-07-dry-hard-rub-small': {
                shape: 'circle', startSize: 12, endSize: 10,
                spacing: 14, hardness: 75, opacity: 60, flow: 40,
                taper: 0, texture: 75, grainScale: 3,
                speedSize: 0, speedOpacity: 0,
                scatter: 2, scatterRadius: 8,
                sizeJitter: 12, angleJitter: 20,
                smudge: 0, wetness: 0,
            },

            /* h_hardpainting-08-dry-hard-rub-large
               Same as 07 but larger (Krita limitation workaround: no relative
               texture scale).  Same params, bigger size. */
            'h_hardpainting-08-dry-hard-rub-large': {
                shape: 'circle', startSize: 28, endSize: 22,
                spacing: 14, hardness: 75, opacity: 60, flow: 40,
                taper: 0, texture: 75, grainScale: 5,
                speedSize: 0, speedOpacity: 0,
                scatter: 3, scatterRadius: 14,
                sizeJitter: 15, angleJitter: 22,
                smudge: 0, wetness: 0,
            },

            /* h_hardpainting-09-brush-dynamic-tilt
               Rake with tilt dynamic (requires tilt-capable tablet).  Krita:
               bristle-like predefined tip, angle driven by tilt, expressive.
               Mapped to bristle with auto-angle and scatter. */
            'h_hardpainting-09-brush-dynamic-tilt': {
                shape: 'bristle', startSize: 30, endSize: 24,
                spacing: 8, hardness: 80, opacity: 80, flow: 65,
                taper: 20, texture: 18, grainScale: 3,
                bristleCount: 12, bristleSpread: 55,
                angle: 0, angleJitter: 40,
                speedSize: 0, speedOpacity: 10,
                scatter: 0, smudge: 0, wetness: 0,
            },

            /* h_hardpainting-10-sharp-rake
               Noise-adding rake, scratches canvas without blur.  Krita: thin
               predefined multi-tip, scatter, high roughness.  Maps to bristle
               with heavy scatter and angle jitter. */
            'h_hardpainting-10-sharp-rake': {
                shape: 'bristle', _tipUrl: 'brush-packs/revoy-extras/tips/3_rake.png', _nativeShape: 'bristle',
                startSize: 20, endSize: 16,
                spacing: 10, hardness: 90, opacity: 70, flow: 55,
                taper: 15, texture: 35, grainScale: 3,
                bristleCount: 9, bristleSpread: 50,
                scatter: 3, scatterRadius: 10,
                sizeJitter: 15, angleJitter: 30,
                smudge: 0, wetness: 0,
            },

            /* h_hardpainting-11-big-canvas-rub
               Large texture overlay; paint stuck in canvas fiber holes.  Krita:
               canvas predefined tip, very large, high grain, very soft edges.
               Maps to huge soft circle with maximum grain. */
            'h_hardpainting-11-big-canvas-rub': {
                shape: 'custom', _tipUrl: 'brush-packs/revoy-extras/tips/2018-10_square-block_001.png', _nativeShape: 'circle',
                startSize: 50, endSize: 40,
                spacing: 18, hardness: 8, opacity: 50, flow: 30,
                taper: 0, texture: 85, grainScale: 6,
                speedSize: 0, speedOpacity: 5,
                scatter: 3, scatterRadius: 18,
                sizeJitter: 20, angleJitter: 10,
                smudge: 0, wetness: 0,
            },

            // ── MISC ────────────────────────────────────────────────────────

            /* b_basic-5_size-fill
               Full-opacity fill with friction at pressure start.  Krita: auto
               circle, full hardness, pressure drives size from 0 to 100%.
               Maps to hard circle with speedSize simulating pressure friction. */
            'b_basic-5_size-fill': {
                shape: 'circle', startSize: 20, endSize: 20,
                spacing: 10, hardness: 100, opacity: 100, flow: 100,
                taper: 35, texture: 0,
                speedSize: -30, speedOpacity: 0,
                scatter: 0, smudge: 0, wetness: 0,
                sizeJitter: 0, angleJitter: 0,
            },

            /* u_pixel-art-fill-plus
               Aliased pixel-art marker for colorize mask lines.  Krita: auto
               circle, full hardness, binaryMode equivalent (no AA fringe).
               Maps to binaryMode circle. */
            'u_pixel-art-fill-plus': {
                shape: 'circle', startSize: 4, endSize: 4,
                spacing: 10, hardness: 100, opacity: 100, flow: 100,
                taper: 0, texture: 0,
                binaryMode: true,
                scatter: 0, smudge: 0, wetness: 0,
            },

            /* v_dashed
               Dashed line preset with high texture for non-vector feel.  Krita:
               custom dashed line tip, spacing >> 100%.  Maps to circle with
               spacing >> 100 for natural dashes and grain. */
            'v_dashed': {
                shape: 'circle', startSize: 8, endSize: 8,
                spacing: 120, hardness: 95, opacity: 95, flow: 95,
                taper: 0, texture: 20, grainScale: 2,
                scatter: 0, smudge: 0, wetness: 0,
                sizeJitter: 15, angleJitter: 0,
            },

            /* y_texture-starfield-bitmap
               Many tiny dots / stars.  Krita: bitmap splatter tip, heavy scatter.
               Maps to circle with extreme scatter, small size, high jitter.
               Use large size + blur for snow effect. */
            'y_texture-starfield-bitmap': {
                shape: 'custom', _tipUrl: 'brush-packs/revoy-extras/tips/stars.png', _nativeShape: 'circle',
                startSize: 2, endSize: 2,
                spacing: 55, hardness: 100, opacity: 90, flow: 90,
                taper: 0, texture: 0,
                scatter: 14, scatterRadius: 40,
                sizeJitter: 70, posJitter: 8,
                smudge: 0, wetness: 0,
            },
        };

        /* Register the Revoy presets so they can be accessed via
           PaintApp.brush.loadPreset('revoy:h_hardpainting-06-wet-on-wet-canvas')
           or via the loadRevoyPreset() convenience method below. */
        Object.keys(REVOY_PRESETS).forEach(function(key) {
            PRESETS['revoy:' + key] = REVOY_PRESETS[key];
        });

        /* ── Public convenience API ─────────────────────────────────────────
           PaintApp.brush.loadRevoyPreset('h_hardpainting-06-wet-on-wet-canvas')
           Loads one of the 25 Revoy presets by short name (without 'revoy:').
           Returns true on success, false if the name is unknown. */
        app.brush.loadRevoyPreset = function(name) {
            var key = 'revoy:' + name;
            if (!PRESETS[key]) {
                // Try fuzzy match (case-insensitive substring)
                var lower = name.toLowerCase();
                var found = Object.keys(PRESETS).find(function(k) {
                    return k.startsWith('revoy:') && k.toLowerCase().indexOf(lower) !== -1;
                });
                if (found) key = found;
                else { console.warn('[KritaCompat] Unknown Revoy preset:', name); return false; }
            }
            app.brush.loadPreset(key);
            return true;
        };

        /* ── List all Revoy presets ─────────────────────────────────────────
           PaintApp.brush.listRevoyPresets()
           Returns an array of short names (without the 'revoy:' prefix) for
           all 25 presets, suitable for building a picker UI. */
        app.brush.listRevoyPresets = function() {
            return Object.keys(REVOY_PRESETS);
        };

        /* ── Extend loadPreset() to handle 'revoy:*' keys ─────────────────── */
        (function() {
            var _originalLoadPreset = app.brush.loadPreset.bind(app.brush);
            app.brush.loadPreset = function(name) {
                // Revoy presets are already in PRESETS; loadPreset handles them
                // natively after the Object.keys loop above registered them.
                // But we also want to merge with DEFAULTS properly since Revoy
                // presets are deltas, not full param objects like PRESETS entries.
                if (name && name.startsWith('revoy:')) {
                    var p = PRESETS[name];
                    if (!p) return;
                    params = Object.assign({}, DEFAULTS, p);
                    // Clear any stale custom tip left over from a previously loaded
                    // brush. If this preset has its own _tipUrl it will be set below;
                    // if not, the brush must use its native procedural shape cleanly.
                    if (!p._tipUrl) {
                        params.customTipCanvas = null;
                        params.customTipRaw    = null;
                        var _tipRow = document.getElementById('bs-custom-tip-row');
                        var _hRow   = document.getElementById('bs-tip-hardness-row');
                        if (_tipRow) _tipRow.style.display = 'none';
                        if (_hRow)   _hRow.style.display   = 'none';
                    }
                    _syncSlidersToParams();
                    document.querySelectorAll('.brush-shape-btn').forEach(function(btn) {
                        btn.classList.toggle('active', btn.dataset.shape === params.shape);
                    });
                    document.querySelectorAll('.brush-preset-btn').forEach(function(btn) {
                        btn.classList.toggle('active', btn.dataset.preset === name);
                    });
                    if (p._tipUrl) {
                        // loadCustomTip is async (Image.onload); it calls refreshPreview
                        // itself once the image is ready. Calling refreshPreview here
                        // first would fire before customTipCanvas is set, crashing drawImage.
                        // Temporarily fall back to circle so the preview has something to
                        // show while the tip loads, then loadCustomTip will repaint.
                        params.shape = 'circle';
                        refreshPreview();
                        // In Tauri, relative file:// paths are cross-origin to the canvas
                        // and cause a SecurityError on getImageData. convertFileSrc converts
                        // them to https://asset.localhost/... which has correct CORS headers.
                        // Outside Tauri (plain browser) we fall back to the raw relative path.
                        var tipSrc = p._tipUrl;
                        try {
                            var _tauri = window.__TAURI__;
                            var _cvt = _tauri && _tauri.core && typeof _tauri.core.convertFileSrc === 'function'
                                ? _tauri.core.convertFileSrc : null;
                            if (_cvt) tipSrc = _cvt(p._tipUrl);
                        } catch(e) {}
                        // Pass the preset's native shape as the fallback so that if
                        // the tip image fails to load (CORS, 404, missing file), the
                        // brush still draws using its intended procedural shape instead
                        // of the temporary 'circle' placeholder we set above.
                        var _nativeShape = p._nativeShape || 'circle';
                        app.brush.loadCustomTip(tipSrc, p._tipUrl.split('/').pop().replace(/\.png$/i, ''), _nativeShape);
                    } else {
                        refreshPreview();
                    }
                    return;
                }
                _originalLoadPreset(name);
            };
        })();

        /* End of Krita compatibility layer */

        // Build ribbon on load
        _rebuildRibbonBrushes();

    })(PaintApp);
