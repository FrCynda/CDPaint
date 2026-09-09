    // Wand mask algorithms imported from ./wand-algorithms.js (single source of truth).
    // Loaded as an ES module via an inline bootstrap in index.html, which sets window.__wandAlgorithms.
    const _wandMod = (typeof window !== 'undefined' && window.__wandAlgorithms) || {};
    const buildSortedDiffIndex = _wandMod.buildSortedDiffIndex;
    const applyToleranceIncremental = _wandMod.applyToleranceIncremental;
    const buildPriorityFlood = _wandMod.buildPriorityFlood;

    // Minimal seeded LCG (linear congruential generator) used for repeatable brush jitter and noise patterns.
    // Not cryptographically secure — only used for visual randomness.
    class SeededRNG {
        constructor(seed) { this.seed = seed; }
        next() {
            let t = this.seed += 0x6D2B79F5;
            t = Math.imul(t ^ t >>> 15, t | 1);
            t ^= t + Math.imul(t ^ t >>> 7, t | 61);
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        }
    }

    // PNG chunk builder used during export. Manually constructs sRGB and pHYs ancillary chunks
    // so exported files carry correct colour-space and DPI metadata.
    class PngMetadata {
        static get CRC_TABLE() {
            if (this._crcTable) return this._crcTable;
            this._crcTable = [];
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                this._crcTable[n] = c;
            }
            return this._crcTable;
        }

        static calcCRC(buf) {
            const table = this.CRC_TABLE;
            let crc = 0xffffffff;
            const u8 = new Uint8Array(buf);
            for (let i = 0; i < u8.length; i++) crc = table[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
            return (crc ^ 0xffffffff) >>> 0;
        }

        static createChunk(type, data) {
            const len = data.length;
            const buf = new Uint8Array(4 + 4 + len + 4);
            const view = new DataView(buf.buffer);

            view.setUint32(0, len, false);
            for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
            buf.set(data, 8);
            const crc = this.calcCRC(buf.subarray(4, 8 + len));
            view.setUint32(8 + len, crc, false);

            return buf;
        }

        static async inject(blob) {
            const buffer = await blob.arrayBuffer();
            const u8 = new Uint8Array(buffer);

            const physData = new Uint8Array([
                0x00, 0x00, 0x0E, 0xC3,
                0x00, 0x00, 0x0E, 0xC3,
                0x01
            ]);
            const physChunk = this.createChunk("pHYs", physData);
            const srgbChunk = this.createChunk("sRGB", new Uint8Array([0]));

            const insertPos = 33;

            return new Blob([
                u8.slice(0, insertPos),
                physChunk,
                srgbChunk,
                u8.slice(insertPos)
            ], { type: "image/png" });
        }
    }

    class CompressionCompat {
        static toBytes(input) {
            if (input instanceof Uint8Array) return input;
            if (input instanceof ArrayBuffer) return new Uint8Array(input);
            if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
            return new Uint8Array(0);
        }
        static async deflateWithCompressionStream(bytes, timeoutMs = 1200) {
            const stream = new CompressionStream('deflate');
            const writer = stream.writable.getWriter();
            const compress = (async () => {
                await writer.write(bytes);
                await writer.close();
                const compressed = await new Response(stream.readable).arrayBuffer();
                return new Uint8Array(compressed);
            })();
            if (!timeoutMs || timeoutMs <= 0) return compress;
            let timer = null;
            try {
                return await Promise.race([
                    compress,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('CompressionStream timed out')), timeoutMs);
                    })
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        }
        static adler32(bytes) {
            let a = 1;
            let b = 0;
            const MOD = 65521;
            const input = this.toBytes(bytes);
            const len = input.length;
            for (let i = 0; i < len; i++) {
                a += input[i];
                if (a >= MOD) a -= MOD;
                b += a;
                if (b >= MOD) b -= MOD;
            }
            return ((b << 16) | a) >>> 0;
        }
        static deflateStored(bytes) {
            const input = this.toBytes(bytes);
            const chunks = [];
            chunks.push(new Uint8Array([0x78, 0x01])); // zlib CMF+FLG: deflate with 32 KB window, no dict, low compression level
            let offset = 0;
            while (offset < input.length) {
                const remaining = input.length - offset;
                const blockLen = Math.min(0xffff, remaining);
                const isFinal = offset + blockLen >= input.length;
                const header = new Uint8Array(5);
                header[0] = isFinal ? 0x01 : 0x00; // BFINAL=1 on last block; BTYPE=00 means stored (uncompressed)
                header[1] = blockLen & 0xff;
                header[2] = (blockLen >>> 8) & 0xff;
                const nlen = (~blockLen) & 0xffff;
                header[3] = nlen & 0xff;
                header[4] = (nlen >>> 8) & 0xff;
                chunks.push(header);
                chunks.push(input.subarray(offset, offset + blockLen));
                offset += blockLen;
            }
            const adler = this.adler32(input);
            const trailer = new Uint8Array([
                (adler >>> 24) & 0xff,
                (adler >>> 16) & 0xff,
                (adler >>> 8) & 0xff,
                adler & 0xff
            ]);
            chunks.push(trailer);
            let total = 0;
            for (const part of chunks) total += part.length;
            const out = new Uint8Array(total);
            let writeAt = 0;
            for (const part of chunks) {
                out.set(part, writeAt);
                writeAt += part.length;
            }
            return out;
        }
        static async deflate(bytes) {
            const input = this.toBytes(bytes);
            if (window.pako && typeof window.pako.deflate === 'function') {
                return window.pako.deflate(input);
            }
            if (typeof CompressionStream === 'function') {
                try {
                    return await this.deflateWithCompressionStream(input, 1200);
                } catch (err) {
                    console.warn('CompressionStream failed, falling back to stored deflate', err);
                }
            }
            return this.deflateStored(input);
        }
        /* Mirror of deflate() for reading PNG image data back out.
           There is no stored-block fallback here: unlike writing, we don't get to
           choose the encoding, so a caller with neither pako nor DecompressionStream
           has to be told it can't read the pixels rather than handed wrong ones. */
        static async inflate(bytes) {
            const input = this.toBytes(bytes);
            if (window.pako && typeof window.pako.inflate === 'function') {
                return window.pako.inflate(input);
            }
            if (typeof DecompressionStream !== 'function') {
                throw new Error('No inflate available (needs DecompressionStream or pako)');
            }
            const stream = new DecompressionStream('deflate');
            const writer = stream.writable.getWriter();
            writer.write(input);
            writer.close();
            const out = await new Response(stream.readable).arrayBuffer();
            return new Uint8Array(out);
        }
    }

    /**
     * ============================================================================
     * SMARTSHAPE STANDALONE MODULE
     * ============================================================================
     * Integration notes:
     * - Feed canvas-local {x,y} into onPointerDown/onPointerMove/onPointerUp.
     * - Snapped output is always Bezier segments: { p0, p1, p2, p3 }.
     * - If you use a non-canvas renderer, provide your own render callback.
     * ============================================================================
     */
    const SmartShape = (() => {
        // --- CONFIGURATION ---
    // Tune these to change snapping sensitivity and hold-to-snap timing.
        let _tolerance  = 5;    // Shape-recognition sensitivity: 1 = strict match required, 10 = permissive.
                                    // Higher values snap to shapes even when the stroke is rough.
        let _holdDelay  = 500;  // Milliseconds the pointer must be stationary before a snap is confirmed.
                                    // Prevents snapping mid-stroke when the user merely pauses briefly.
        let _enabled    = true;
        let _curveOnly  = false;

        // --- HOST APP HOOKS ---
    // Callbacks supplied by PaintApp: getStyle(), onSnap(), onCommit().
    // These decouple SmartShape from the rest of the app.
        let _mainCtx    = null;
        let _overlayCtx = null;
        let _getStyle   = null;
        let _onSnap     = null;
        let _onCommit   = null;

        // --- STATE MACHINE ---
    // Phase 0: idle. Phase 1: drawing raw path. Phase 2: shape detected, waiting for confirmation.
    // Phase 3: user is adjusting the snapped result.
        const S = { IDLE: 0, DRAWING: 1, SNAPPED: 2, TRANSFORM: 3 };
        let _phase        = S.IDLE;
        let _rawPath      = [];    // Ordered array of {x,y} sample points collected during the current stroke.
        let _snapped      = null;  // Active detection result: { kind, segs, anchor }.
                                    // kind: 'line'|'circle'|'curve'|'polygon'|…
                                    // segs: array of cubic Bezier segments {p0,p1,p2,p3}.
        let _snappedBase  = null;  // Snapshot of segs at the moment the user starts dragging to adjust the snapped shape.
                                    // Used as the reference for computing the scale/rotation delta.
        let _anchor       = null;  // Pivot point {x,y} used when the user scales or rotates the snapped shape.
        let _baseDist     = 1;
        let _baseAngle    = 0;
        let _holdTimer    = null;

        // --- SECTION 1: MATH & PRE-PROCESSING ---

        const dst = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

        function pathLen(pts) {
            let l = 0;
            for (let i = 1; i < pts.length; i++) l += dst(pts[i-1], pts[i]);
            return l;
        }

        function centroid(pts) {
            return {
                x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
                y: pts.reduce((s, p) => s + p.y, 0) / pts.length
            };
        }

        function bbOf(pts) {
            let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
            for (const p of pts) {
                x0=Math.min(x0,p.x); y0=Math.min(y0,p.y);
                x1=Math.max(x1,p.x); y1=Math.max(y1,p.y);
            }
            return { cx:(x0+x1)/2, cy:(y0+y1)/2, rx:(x1-x0)/2, ry:(y1-y0)/2, x0, y0, x1, y1 };
        }

        function gaussSmooth(pts, sigma) {
            const k = Math.ceil(sigma * 3);
            const kernel = [];
            let ksum = 0;
            for (let i = -k; i <= k; i++) {
                const v = Math.exp(-i*i / (2*sigma*sigma));
                kernel.push(v);
                ksum += v;
            }
            kernel.forEach((_, i, a) => a[i] /= ksum);
            return pts.map((_, idx) => {
                let x = 0, y = 0;
                for (let i = -k; i <= k; i++) {
                    const p = pts[Math.min(Math.max(idx + i, 0), pts.length - 1)];
                    x += p.x * kernel[i + k];
                    y += p.y * kernel[i + k];
                }
                return { x, y };
            });
        }

        function resample(pts, N) {
            const total = pathLen(pts);
            if (total < 1 || pts.length < 2) return pts.slice();
            const step = total / (N - 1);
            const out = [{ x: pts[0].x, y: pts[0].y }];
            let acc = 0, j = 0;
            for (let i = 1; i < N - 1; i++) {
                const target = i * step;
                while (j < pts.length - 2 && acc + dst(pts[j], pts[j+1]) < target) {
                    acc += dst(pts[j], pts[j+1]);
                    j++;
                }
                const rem = target - acc;
                const seg = dst(pts[j], pts[j+1]) || 1;
                const t = rem / seg;
                out.push({
                    x: pts[j].x + (pts[j+1].x - pts[j].x) * t,
                    y: pts[j].y + (pts[j+1].y - pts[j].y) * t
                });
            }
            out.push({ x: pts[pts.length-1].x, y: pts[pts.length-1].y });
            return out;
        }

        // --- SECTION 2: DETECTION ALGORITHMS ---

        function turningAngles(rs, w) {
            const N = rs.length;
            return rs.map((_, i) => {
                const a = rs[Math.max(0, i - w)];
                const b = rs[i];
                const c = rs[Math.min(N - 1, i + w)];
                const v1x = b.x - a.x, v1y = b.y - a.y;
                const v2x = c.x - b.x, v2y = c.y - b.y;
                const cross = Math.abs(v1x * v2y - v1y * v2x);
                const dot   = v1x * v2x + v1y * v2y;
                return Math.atan2(cross, Math.max(dot, 1e-6));
            });
        }

        function findCornerIndices(pts, closed) {
            const w       = Math.round(6 + _tolerance * 0.5);
            const thresh  = (35 - _tolerance * 3) * Math.PI / 180;
            const minGapF = Math.max(0.04, 0.10 - _tolerance * 0.006);

            const N   = Math.min(Math.max(pts.length, 120), 350);
            const rs  = resample(pts, N);
            const scan   = closed ? [...rs, ...rs, ...rs] : rs;
            const ang    = turningAngles(scan, w);
            const minGap = Math.round(N * minGapF);
            const lo = w;
            const hi = closed ? N + N - w : N - w;

            const corners = [];
            for (let i = lo; i < hi; i++) {
                if (ang[i] > thresh && ang[i] >= ang[i-1] && ang[i] >= ang[i+1]) {
                    const normIdx = closed ? i % N : i;
                    const last = corners[corners.length - 1];
                    const gap = last ? Math.min(Math.abs(normIdx - last.normIdx), N - Math.abs(normIdx - last.normIdx)) : Infinity;
                    if (gap >= minGap) {
                        corners.push({ idx: normIdx, normIdx, k: ang[i], pt: rs[normIdx] });
                    } else if (ang[i] > last.k) {
                        corners[corners.length - 1] = { idx: normIdx, normIdx, k: ang[i], pt: rs[normIdx] };
                    }
                }
            }

            const seen = new Set();
            const unique = corners.filter(c => {
                if (seen.has(c.normIdx)) return false;
                seen.add(c.normIdx); return true;
            });

            return unique.map(c => {
                let best = 0, bd = Infinity;
                for (let i = 0; i < pts.length; i++) {
                    const d = dst(pts[i], c.pt);
                    if (d < bd) { bd = d; best = i; }
                }
                return { idx: best, pt: pts[best], k: c.k };
            });
        }

        function segMaxDev(raw, iA, iB, closed) {
            let slice;
            if (iB >= iA) { slice = raw.slice(iA, iB + 1); }
            else if (closed) { slice = [...raw.slice(iA), ...raw.slice(0, iB + 1)]; }
            else { slice = raw.slice(iA, raw.length); }

            if (slice.length < 2) return 0;
            const a = slice[0], b = slice[slice.length - 1];
            const dx = b.x - a.x, dy = b.y - a.y, den = Math.hypot(dx, dy) || 1;
            let mx = 0;
            for (const p of slice) {
                const d = Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / den;
                if (d > mx) mx = d;
            }
            return mx;
        }

        function scorePolygon(raw, cornerPts, closed) {
            const devLimit = 5 + _tolerance * 3.0;
            const nSides   = closed ? cornerPts.length : cornerPts.length - 1;
            if (nSides < 1) return null;

            let totalDev = 0, maxSideDev = 0;
            for (let i = 0; i < nSides; i++) {
                const ca = cornerPts[i % cornerPts.length];
                const cb = cornerPts[(i + 1) % cornerPts.length];
                const dev = segMaxDev(raw, ca.idx, cb.idx, closed);
                totalDev += dev;
                if (dev > maxSideDev) maxSideDev = dev;
                if (dev > devLimit * 2.0) return null;
            }
            const avgDev = totalDev / nSides;
            if (avgDev > devLimit) return null;

            return { avgDev, maxSideDev, cpts: cornerPts.map(c => c.pt), closed };
        }

        // Kasa algebraic circle fit: minimises the sum of squared radial residuals.
        // Produces a closed-form solution (one SVD-free eigenvalue step) at the cost of
        // slight bias toward larger circles when points are clustered near one arc.
        function fitCircleAlg(pts) {
            const n = pts.length;
            if (n < 5) return null;

            let sx=0, sy=0, sxx=0, syy=0, sxy=0, sz=0, sxz=0, syz=0;
            for (const p of pts) {
                const z = p.x*p.x + p.y*p.y;
                sx+=p.x; sy+=p.y; sxx+=p.x*p.x; syy+=p.y*p.y;
                sxy+=p.x*p.y; sz+=z; sxz+=p.x*z; syz+=p.y*z;
            }

            const M  = [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]];
            const rv = [-sxz, -syz, -sz];

            function det3(m) {
                return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])
                    -m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])
                    +m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0]);
            }

            const D = det3(M);
            if (Math.abs(D) < 1e-8) return null;

            const B = det3([[rv[0],M[0][1],M[0][2]],[rv[1],M[1][1],M[1][2]],[rv[2],M[2][1],M[2][2]]]) / D;
            const C = det3([[M[0][0],rv[0],M[0][2]],[M[1][0],rv[1],M[1][2]],[M[2][0],rv[2],M[2][2]]]) / D;
            const E = det3([[M[0][0],M[0][1],rv[0]],[M[1][0],M[1][1],rv[1]],[M[2][0],M[2][1],rv[2]]]) / D;

            const cx = -B/2, cy = -C/2;
            const r2 = cx*cx + cy*cy - E;
            if (r2 < 16) return null;

            const r = Math.sqrt(r2);
            let rms = 0;
            for (const p of pts) {
                const e = Math.hypot(p.x - cx, p.y - cy) - r;
                rms += e * e;
            }
            return { cx, cy, r, rms: Math.sqrt(rms / n) };
        }

        function fitCubic(pts) {
            const p0 = pts[0], p3 = pts[pts.length - 1];
            if (dst(p0, p3) < 2) {
                const mx = (p0.x+p3.x)/2, my = (p0.y+p3.y)/2;
                return { p0, p1:{x:mx,y:my}, p2:{x:mx,y:my}, p3 };
            }

            let total = 0;
            const tv = [0];
            for (let i = 1; i < pts.length; i++) { total += dst(pts[i-1], pts[i]); tv.push(total); }
            const tn = tv.map(t => total ? t / total : 0);

            let A1=0, A2=0, B2=0, C1x=0, C2x=0, C1y=0, C2y=0;
            for (let i = 0; i < pts.length; i++) {
                const t=tn[i], u=1-t;
                const b1 = 3*u*u*t, b2 = 3*u*t*t;
                const ax = pts[i].x - (u*u*u*p0.x + t*t*t*p3.x);
                const ay = pts[i].y - (u*u*u*p0.y + t*t*t*p3.y);
                A1+=b1*b1; A2+=b1*b2; B2+=b2*b2;
                C1x+=b1*ax; C2x+=b2*ax; C1y+=b1*ay; C2y+=b2*ay;
            }

            const det = A1*B2 - A2*A2;
            if (Math.abs(det) < 1e-6) {
                const d = { x: (p3.x-p0.x)/3, y: (p3.y-p0.y)/3 };
                return { p0, p1:{x:p0.x+d.x,y:p0.y+d.y}, p2:{x:p0.x+2*d.x,y:p0.y+2*d.y}, p3 };
            }

            const inv = 1 / det;
            return {
                p0,
                p1: { x: (C1x*B2 - C2x*A2)*inv, y: (C1y*B2 - C2y*A2)*inv },
                p2: { x: (A1*C2x - A2*C1x)*inv, y: (A1*C2y - A2*C1y)*inv },
                p3
            };
        }

        // --- SECTION 3: BEZIER SEGMENT BUILDERS ---

        const K = 0.5522847498;

        function circleSegs(cx, cy, r) {
            return [
                {p0:{x:cx+r,y:cy},   p1:{x:cx+r,y:cy+r*K}, p2:{x:cx+r*K,y:cy+r},   p3:{x:cx,y:cy+r}},
                {p0:{x:cx,y:cy+r},   p1:{x:cx-r*K,y:cy+r}, p2:{x:cx-r,y:cy+r*K},   p3:{x:cx-r,y:cy}},
                {p0:{x:cx-r,y:cy},   p1:{x:cx-r,y:cy-r*K}, p2:{x:cx-r*K,y:cy-r},   p3:{x:cx,y:cy-r}},
                {p0:{x:cx,y:cy-r},   p1:{x:cx+r*K,y:cy-r}, p2:{x:cx+r,y:cy-r*K},   p3:{x:cx+r,y:cy}},
            ];
        }

        function ellipseSegs(cx, cy, rx, ry) {
            return [
                {p0:{x:cx+rx,y:cy},  p1:{x:cx+rx,y:cy+ry*K}, p2:{x:cx+rx*K,y:cy+ry},  p3:{x:cx,y:cy+ry}},
                {p0:{x:cx,y:cy+ry},  p1:{x:cx-rx*K,y:cy+ry}, p2:{x:cx-rx,y:cy+ry*K},  p3:{x:cx-rx,y:cy}},
                {p0:{x:cx-rx,y:cy},  p1:{x:cx-rx,y:cy-ry*K}, p2:{x:cx-rx*K,y:cy-ry},  p3:{x:cx,y:cy-ry}},
                {p0:{x:cx,y:cy-ry},  p1:{x:cx+rx*K,y:cy-ry}, p2:{x:cx+rx,y:cy-ry*K},  p3:{x:cx+rx,y:cy}},
            ];
        }

        function polySegs(corners, closed) {
            const segs = [];
            const n = closed ? corners.length : corners.length - 1;
            for (let i = 0; i < n; i++) {
                const p0 = corners[i % corners.length];
                const p3 = corners[(i + 1) % corners.length];
                segs.push({ p0:{...p0}, p1:{...p0}, p2:{...p3}, p3:{...p3} });
            }
            return segs;
        }

        function lineSegs(a, b) {
            return [{ p0:{...a}, p1:{...a}, p2:{...b}, p3:{...b} }];
        }

        function evalBez(s, t) {
            const u = 1 - t;
            return {
                x: u*u*u*s.p0.x + 3*u*u*t*s.p1.x + 3*u*t*t*s.p2.x + t*t*t*s.p3.x,
                y: u*u*u*s.p0.y + 3*u*u*t*s.p1.y + 3*u*t*t*s.p2.y + t*t*t*s.p3.y,
            };
        }

        function sampleSegs(segs) {
            const out = [];
            for (const s of segs) {
                const steps = Math.max(10, Math.floor(dst(s.p0, s.p3) / 4));
                for (let i = 0; i <= steps; i++) out.push(evalBez(s, i / steps));
            }
            return out;
        }

        // --- SECTION 4: MASTER DETECTION ENGINE ---

        function isClosed(raw) {
            if (raw.length < 6) return false;
            const gap = dst(raw[0], raw[raw.length - 1]);
            const len = pathLen(raw);
            return gap < Math.min(64, len * 0.15 + 12 + _tolerance * 3);
        }

        function snapShape(raw) {
            if (raw.length < 6 || pathLen(raw) < 14) return null;

            const closed     = isClosed(raw);
            const candidates = [];

            if (_curveOnly) {
                const sm  = gaussSmooth(raw, 2);
                const bez = fitCubic(sm);
                return { kind: 'curve', segs: [bez], anchor: { x: raw[0].x, y: raw[0].y } };
            }

            // Candidate 1: Line
            {
                const p0 = raw[0], p1 = raw[raw.length - 1];
                const chordLen = dst(p0, p1);
                const dx = p1.x-p0.x, dy = p1.y-p0.y, den = Math.hypot(dx,dy) || 1;
                let maxDev = 0;
                for (const p of raw) {
                    const d = Math.abs(dy*p.x - dx*p.y + p1.x*p0.y - p1.y*p0.x) / den;
                    if (d > maxDev) maxDev = d;
                }
                const lineDevThresh = 4 + chordLen * 0.025;
                if (!closed && maxDev < lineDevThresh) {
                    const lineScore = 2.5 * (1 - maxDev / lineDevThresh);
                    candidates.push({ kind:'line', score:lineScore, segs:lineSegs(p0,p1), anchor:'start' });
                }
            }

            // Candidate 2: Polygon
            const maxPolyCorners = 3 + Math.floor(_tolerance / 1.5);
            const detectedCorners = findCornerIndices(raw, closed);
            const cornerSets = [detectedCorners];
            if (detectedCorners.length > 3) {
                const byStrength = [...detectedCorners].sort((a, b) => a.k - b.k);
                cornerSets.push(detectedCorners.filter(c => c !== byStrength[0]));
            }

            for (const cset of cornerSets) {
                if (cset.length < 2 || cset.length > maxPolyCorners + 1) continue;
                const fullCorners = closed ? cset : [{ idx:0, pt:raw[0], k:Math.PI }, ...cset, { idx:raw.length-1, pt:raw[raw.length-1], k:Math.PI }];
                if (fullCorners.length > maxPolyCorners + 1) continue;

                const polyResult = scorePolygon(raw, fullCorners, closed);
                if (!polyResult) continue;

                const nc = polyResult.cpts.length;
                const name = nc===3 ? 'triangle' : nc===4 ? 'quadrilateral' : nc===5 ? 'pentagon' : nc===6 ? 'hexagon' : `${nc}-polygon`;
                let score = 2.0 / (1 + polyResult.avgDev * 0.06);

                if (nc === 4) {
                    const avgDevFrom90 = polyResult.cpts.reduce((sum, _, i, a) => {
                        const prev = a[(i-1+4)%4], curr = a[i], next = a[(i+1)%4];
                        const v1x=prev.x-curr.x, v1y=prev.y-curr.y;
                        const v2x=next.x-curr.x, v2y=next.y-curr.y;
                        const dot = v1x*v2x + v1y*v2y;
                        const mag = Math.hypot(v1x,v1y)*Math.hypot(v2x,v2y) || 1;
                        return sum + Math.abs(Math.acos(Math.min(1, Math.max(-1, dot/mag))) - Math.PI/2);
                    }, 0) / 4;
                    if (avgDevFrom90 < 0.35) score *= 1.6;
                }
                candidates.push({ kind:name, score, segs:polySegs(polyResult.cpts, polyResult.closed), anchor:'centroid' });
            }

            // Candidate 3: Circle/Ellipse
            if (closed) {
                const sub = resample(raw, Math.min(raw.length, 80));
                const cf  = fitCircleAlg(sub);
                if (cf) {
                    const rmsRel       = cf.rms / cf.r;
                    const circleThresh = 0.10 + _tolerance * 0.015;
                    const bestPolyScore = candidates.reduce((m, c) => Math.max(m, c.score), 0);

                    if (rmsRel < circleThresh) {
                        const bb       = bbOf(raw);
                        const aspect   = Math.min(bb.rx, bb.ry) / Math.max(bb.rx, bb.ry);
                        const circScore = (1 - rmsRel / circleThresh) * 2.2;
                        if (circScore > bestPolyScore || bestPolyScore === 0) {
                            if (aspect > 0.82) {
                                candidates.push({ kind:'circle', score:circScore, segs:circleSegs(cf.cx,cf.cy,cf.r) });
                            } else {
                                candidates.push({ kind:'ellipse', score:circScore*0.9, segs:ellipseSegs(cf.cx,cf.cy,bb.rx,bb.ry) });
                            }
                        }
                    } else if (rmsRel < circleThresh * 2.5 && candidates.length === 0) {
                        const bb   = bbOf(raw);
                        const cent = centroid(sub);
                        if (bb.rx > 5 && bb.ry > 5) candidates.push({ kind:'ellipse', score:0.7, segs:ellipseSegs(cent.x,cent.y,bb.rx,bb.ry) });
                    }
                }
            }

            // Candidate 4: Curve
            if (!closed) {
                const sm  = gaussSmooth(raw, 2);
                const bez = fitCubic(sm);
                let rmsErr = 0;
                for (let i = 0; i < sm.length; i++) {
                    const t=i/(sm.length-1), u=1-t;
                    const bx = u*u*u*bez.p0.x + 3*u*u*t*bez.p1.x + 3*u*t*t*bez.p2.x + t*t*t*bez.p3.x;
                    const by = u*u*u*bez.p0.y + 3*u*u*t*bez.p1.y + 3*u*t*t*bez.p2.y + t*t*t*bez.p3.y;
                    rmsErr += (sm[i].x-bx)**2 + (sm[i].y-by)**2;
                }
                rmsErr = Math.sqrt(rmsErr / sm.length);
                const bb       = bbOf(raw);
                const pathW    = Math.max(bb.rx, bb.ry, 20);
                const relErr   = rmsErr / pathW;
                const curveScore = Math.max(0.4, 1.8 - relErr * 4);
                candidates.push({ kind:'curve', score:curveScore, segs:[bez], anchor:'start' });
            }

            if (candidates.length === 0) return null;

            candidates.sort((a, b) => b.score - a.score);

            const best = candidates[0];

            const isOpenStroke = best.kind === 'line' || best.kind === 'curve' || best.kind.endsWith('-segment');
            const shapeAnchor  = isOpenStroke ? { x: raw[0].x, y: raw[0].y } : centroid(sampleSegs(best.segs));

            return { kind: best.kind, segs: best.segs, anchor: shapeAnchor };
        }

        // --- SECTION 5: STATE & TRANSFORM LOGIC ---

        function _scheduleHold() {
            clearTimeout(_holdTimer);
            _holdTimer = setTimeout(() => {
                if (_phase !== S.DRAWING || _rawPath.length < 6) return;
                const result = snapShape(_rawPath);
                if (!result) return;

                _snapped     = result;
                _snappedBase = result.segs.map(s => ({...s}));
                _anchor      = result.anchor;

                const sampled   = sampleSegs(result.segs);
                const isOpen    = result.kind==='line'||result.kind==='curve'||result.kind.endsWith('-segment');
                const last      = _rawPath[_rawPath.length - 1];
                const baseEnd   = isOpen
                    ? sampled.reduce((b, p) => dst(p,last)  < dst(b,last)  ? p : b, sampled[0])
                    : sampled.reduce((b, p) => dst(p,_anchor) > dst(b,_anchor) ? p : b, sampled[0]);

                _baseDist  = Math.max(dst(_anchor, baseEnd), 1);
                _baseAngle = Math.atan2(baseEnd.y - _anchor.y, baseEnd.x - _anchor.x);
                _phase     = S.SNAPPED;

                if (_onSnap) _onSnap(result.kind, result.segs);
            }, _holdDelay);
        }

        function _applyTransform(cursor) {
            const dx = cursor.x - _anchor.x, dy = cursor.y - _anchor.y;
            const newDist  = Math.max(Math.hypot(dx, dy), 1);
            const newAngle = Math.atan2(dy, dx);
            const sc  = newDist  / _baseDist;
            const rot = newAngle - _baseAngle;
            const cosA = Math.cos(rot), sinA = Math.sin(rot);

            const tx = pt => {
                const rx = pt.x - _anchor.x, ry = pt.y - _anchor.y;
                return {
                    x: _anchor.x + (rx*cosA - ry*sinA) * sc,
                    y: _anchor.y + (rx*sinA + ry*cosA) * sc
                };
            };

            _snapped = {
                kind: _snapped.kind,
                segs: _snappedBase.map(s => ({ p0:tx(s.p0), p1:tx(s.p1), p2:tx(s.p2), p3:tx(s.p3) })),
                anchor: _anchor
            };
        }

        // --- SECTION 6: DEFAULT CANVAS RENDERING ---

        function drawSegs(c, segs, doFill, strokeStyle, fillStyle, lineWidth, alpha) {
            if (!segs || !segs.length) return;
            c.save();
            c.globalAlpha  = alpha;
            c.strokeStyle  = strokeStyle;
            c.fillStyle    = fillStyle || 'transparent';
            c.lineWidth    = lineWidth;
            c.lineCap      = 'round';
            c.lineJoin     = 'round';
            c.beginPath();
            c.moveTo(segs[0].p0.x, segs[0].p0.y);
            for (const s of segs) c.bezierCurveTo(s.p1.x,s.p1.y,s.p2.x,s.p2.y,s.p3.x,s.p3.y);
            if (doFill && fillStyle && fillStyle !== 'none') c.fill();
            c.stroke();
            c.restore();
        }

        function _drawFreehand(c, pts, strokeStyle, lineWidth, alpha) {
            if (pts.length < 2) return;
            c.save();
            c.globalAlpha = alpha;
            c.strokeStyle = strokeStyle;
            c.lineWidth   = lineWidth;
            c.lineCap     = 'round';
            c.lineJoin    = 'round';
            c.beginPath();
            c.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length - 1; i++) {
                const mx = (pts[i].x + pts[i+1].x) / 2;
                const my = (pts[i].y + pts[i+1].y) / 2;
                c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
            }
            c.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
            c.stroke();
            c.restore();
        }

        let _rafId = 0;

        function _startOverlayLoop() {
            if (_rafId) return; // already running
            (function loop() {
                _renderOverlay();
                // Keep looping only while active; self-terminate when back to idle.
                if (_phase !== S.IDLE) {
                    _rafId = requestAnimationFrame(loop);
                } else {
                    _rafId = 0;
                }
            })();
        }

        function _renderOverlay() {
            const c = _overlayCtx;
            if (!c) return;
            c.clearRect(0, 0, c.canvas.width, c.canvas.height);
            if (_phase === S.IDLE) return;

            const style = _getStyle ? _getStyle() : { strokeColor:'#000', fillColor:'none', lineWidth:2, opacity:1, doFill:false };

            if (_phase === S.DRAWING) {
                _drawFreehand(c, _rawPath, style.strokeColor, style.lineWidth, style.opacity * 0.9);
                return;
            }

            if (_phase === S.SNAPPED || _phase === S.TRANSFORM) {
                _drawFreehand(c, _rawPath, style.strokeColor, style.lineWidth * 0.5, style.opacity * 0.12);
                const sc = _phase === S.TRANSFORM ? '#38d7ff' : style.strokeColor;
                drawSegs(c, _snapped.segs, style.doFill, sc, style.fillColor, style.lineWidth, style.opacity);
            }
        }

        function _commit() {
            const c = _mainCtx;
            const style = _getStyle ? _getStyle() : { strokeColor:'#000', fillColor:'none', lineWidth:2, opacity:1, doFill:false };

            if (c) {
                if (_phase === S.SNAPPED || _phase === S.TRANSFORM) {
                    drawSegs(c, _snapped.segs, style.doFill, style.strokeColor, style.fillColor, style.lineWidth, style.opacity);
                } else if (_phase === S.DRAWING && _rawPath.length > 1) {
                    _drawFreehand(c, _rawPath, style.strokeColor, style.lineWidth, style.opacity);
                }
            }

            if (_overlayCtx) _overlayCtx.clearRect(0, 0, _overlayCtx.canvas.width, _overlayCtx.canvas.height);

            if (_onCommit) {
                const resultData = _phase !== S.DRAWING && _snapped ? _snapped.segs : _rawPath;
                const resultType = _phase !== S.DRAWING && _snapped ? _snapped.kind : 'freehand';
                _onCommit({ type: resultType, data: resultData });
            }
        }

        // --- PUBLIC API ---

        function init(config) {
            _mainCtx    = config.mainCtx || null;
            _overlayCtx = config.overlayCtx || null;
            _getStyle   = config.getStyle || null;
            _onSnap     = config.onSnap || null;
            _onCommit   = config.onCommit || null;

            if (_overlayCtx) {
                // Loop is started on demand in onPointerDown; no perpetual idle loop needed.
            }
        }

        function onPointerDown(pos) {
            _phase   = S.DRAWING;
            _rawPath = [pos];
            _snapped = null;
            if (_enabled) _scheduleHold();
            if (_overlayCtx) _startOverlayLoop();
        }

        function onPointerMove(pos) {
            if (_phase === S.IDLE) return;
            if (_phase === S.DRAWING) {
                _rawPath.push(pos);
                if (_enabled) _scheduleHold();
            } else if (_phase === S.SNAPPED || _phase === S.TRANSFORM) {
                _phase = S.TRANSFORM;
                _applyTransform(pos);
            }
        }

        function onPointerUp() {
            if (_phase === S.IDLE) return;
            clearTimeout(_holdTimer);
            _commit();
            _phase   = S.IDLE;
            _rawPath = [];
            _snapped = null;
        }

        function setTolerance(v)  { _tolerance = Math.min(10, Math.max(1, v)); }
        function setHoldDelay(ms) { _holdDelay = ms; }
        function setEnabled(bool) { _enabled = bool; }
        function setCurveOnly(bool) { _curveOnly = !!bool; }

        function getState() {
            return { phase: _phase, rawPath: _rawPath, snapped: _snapped };
        }

        return { init, onPointerDown, onPointerMove, onPointerUp, setTolerance, setHoldDelay, setEnabled, setCurveOnly, drawSegs, getState };
    })();

    // ─── Gradient Tool Engine ─────────────────────────────────────────────────
    // All gradient rendering and GRAD_HANDLE_RADIUS are in js/gradient-engine.js,
    // loaded before this file.  See that module for the optimised implementation.


    // PaintApp: the central application class.
    // Owns all tool state, canvas references, UI wiring, undo history, and feature modules.
    // Modules (brush engine, layers, hue-sat, etc.) are patched onto this class further down the file.
    class PaintEngine {
        constructor() {
            // Tool manifest — every clonable item for the customizable grid
            this.toolManifest = [
                { id:'pencil',         toolId:'pencil',     label:'Pencil',             iconSrc:'assets/toolbar-icons/pencil.png',       defaultSection:'tools' },
                { id:'pencil-smart',   toolId:'pencil',     label:'Smart Pencil',       iconSrc:'assets/toolbar-icons/pencil-smart.png',  defaultSection:'tools', mode:{pencilMode:'smart'} },
                { id:'fill',           toolId:'fill',       label:'Fill',               iconSrc:'assets/toolbar-icons/fill.png',         defaultSection:'tools' },
                { id:'wand',           toolId:'wand',       label:'Magic Wand (Contiguous)', iconSrc:'assets/toolbar-icons/wand-contig.png',defaultSection:'tools' },
                { id:'wand-global',    toolId:'wand',       label:'Magic Wand (Global)', iconSrc:'assets/toolbar-icons/wand-global.png',  defaultSection:'tools', mode:{wandMode:'global'} },
                { id:'eraser',         toolId:'eraser',     label:'Eraser',             iconSrc:'assets/toolbar-icons/eraser.png',       defaultSection:'tools' },
                { id:'picker',         toolId:'picker',     label:'Color Picker',       iconSrc:'assets/toolbar-icons/picker.png',       defaultSection:'tools' },
                { id:'zoom',           toolId:'zoom',       label:'Zoom',               iconSrc:'assets/toolbar-icons/zoom.png',         defaultSection:'tools' },
                { id:'gradient',       toolId:'gradient',   label:'Gradient',           iconSrc:'assets/Gradient.png',                   defaultSection:'tools' },
                { id:'freehand',       toolId:'freehand',   label:'Freehand Brush',     iconSrc:'assets/Freehand.png', iconSvg:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#0078d7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17 Q5 12 8 14 Q11 16 13 11 Q15 6 18 8"/><circle cx="18" cy="8" r="1.5" fill="#0078d7" stroke="none"/></svg>', defaultSection:'tools' },
                { id:'paintbrush',     toolId:'paintbrush', label:'Paint Brush',        iconSrc:'assets/Paintbrush.png', iconSvg:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#0078d7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16 L7 5 L16 3 L17 12 L9 14 Z" fill="rgba(0,120,215,0.15)"/><path d="M7 5 L16 3" stroke="#0078d7" stroke-width="1"/><path d="M9 14 L5 16" stroke="#0078d7" stroke-width="1"/><path d="M11 13 L12 9" stroke="#0078d7" stroke-width="1" stroke-dasharray="1 1"/></svg>', defaultSection:'tools' },
                { id:'anchor-toggle',  label:'Anchor/Free Toggle', isToggle:true,        iconSvg:'<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#0078d7" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="10" y1="3" x2="10" y2="17"/></svg>', defaultSection:'tools' },
                { id:'layers-toggle',  label:'Layers',           isToggle:true,        iconSrc:'assets/layers.png',                      defaultSection:'tools' },
                { id:'pokeproject',    label:'PokéProject — toggle asset browser', isToggle:true, iconSrc:'assets/PokéProject.png', defaultSection:'tools' },
                { id:'select-rect',    toolId:'select',     label:'Select (Rectangle)', iconSrc:'assets/toolbar-icons/rect.png',         defaultSection:'tools', mode:{selectTool:'select'} },
                { id:'select-lasso',   toolId:'lasso',      label:'Lasso Select',       iconSrc:'assets/toolbar-icons/poly.png',          defaultSection:'tools', mode:{selectTool:'lasso'} },
                { id:'line',           toolId:'line',       label:'Line',               iconSrc:'assets/toolbar-icons/line.png',          defaultSection:'shapes' },
                { id:'curve',          toolId:'curve',      label:'Curve',              iconSrc:'assets/toolbar-icons/curve.png',         defaultSection:'shapes' },
                { id:'poly',           toolId:'poly',       label:'Polyline',           iconSrc:'assets/toolbar-icons/poly.png',          defaultSection:'shapes' },
                { id:'rect',           toolId:'rect',       label:'Rectangle',          iconSrc:'assets/toolbar-icons/rect.png',          defaultSection:'shapes' },
                { id:'circle',         toolId:'circle',     label:'Circle',             iconSrc:'assets/toolbar-icons/circle.png',        defaultSection:'shapes' },
                { id:'tri',            toolId:'tri',        label:'Triangle',           iconSrc:'assets/toolbar-icons/tri.png',           defaultSection:'shapes' },
                { id:'path',           toolId:'path',       label:'Freehand Path',      iconSvg:'<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0078d7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c2-7 5-9 9-2s4 6 9-4" fill="none"/><circle cx="3" cy="17" r="1.5" fill="#0078d7" stroke="none"/><circle cx="21" cy="11" r="1.5" fill="#0078d7" stroke="none"/></svg>', defaultSection:'shapes' }
            ];
            this.config = {
                width: 800, height: 600, zoom: 1.0,
                tool: 'pencil',
                c1: '#000000', c2: '#ffffff', activeSlot: 1,
                // Which palette slot each colour holds, or -1 for a free colour.
                paletteSlot: { 1: -1, 2: -1 },
                lineWidth: 1.0, eraserWidth: 10.0, shapeWidth: 1.0,
                transparentSelection: true,
                dragRotate: false,
                transColor: null,
                transTol: 0,
                transMode: 'c2',
                transAutoPaste: false,
                anchorCanvas: true,
                wandMode: 'contiguous',
                wandTolerance: 0,
                debugWandPerf: false,
                lassoSelectMode: 'free',
                selectTool: 'select',
                pickerHoverPreview: true,
                pencilMode: 'standard',
                smartPencilCurveOnly: false,
                gradient: {
                    type: 'linear', repeat: 'none', reverse: false, dither: true, midpoint: 0.5, offset: 0, aspectRatio: 1,
                    staggerLevels: 256,
                    active: false,        // handles have been placed (live, not yet committed)
                    isPlacing: false,     // currently dragging to place a NEW gradient
                    draggingHandle: null, // 'start' | 'end' | null — which handle is being moved
                    startX: 0, startY: 0,
                    endX: 0,   endY: 0,
                    stops: null
                },
                freehand: {
                    size: 4, thinning: 0,
                    smoothing: 0.5, streamline: 0.5,
                    taperStart: 0, taperEnd: 0,
                    capStart: false, capEnd: false,
                    simulatePressure: true, easing: 'linear',
                    easingStart: 'linear', easingEnd: 'linear',
                    fillEnabled: true,
                    strokeWidth: 0,
                    strokeEnabled: true,
                    pixelMode: true
                }
            };
            this.state = {
                isDrawing: false, startPos: {x:0, y:0}, history: [], step: -1,
                isCanvasResizing: false, rDir: '',
                selection: null, isMovingSel: false, isRotatingSel: false, selStart: {x:0,y:0}, dragHandle: null,
                activeShape: null, shapeEditMode: false,
                curvePhase: 0, curvePts: [],
                freehandPathActive: false, freehandPathPoints: [], freehandPathSlot: 1,
                polyActive: false, polyPoints: [],
                lassoActive: false, lassoMode: null, lassoPoints: [], lassoIsDown: false, lassoStart: null,
                wandActive: false, wandStart: null, wandStartScreen: null, wandTol: 0, wandBase: null,
                wandDiff: null,
                wandVisited: null,
                wandMaskCanvas: null,
                wandMaskImageData: null,
                wandJobId: 0,
                curveUndo: null,
                pencilCtrlAxis: null,
                selectionOriginalPos: null,
                selectionRotateSession: null,
                selectionCutStep: null,
                selectionJustCreated: false,
                selectionIgnoreClickUntil: 0,
                selectionIgnoreNextClick: false,
                isPanning: false, panStart: {x:0,y:0}, scrollStart: {x:0,y:0},
                isCanvasDragging: false, canvasDragStart: {x:0,y:0}, canvasOffsetStart: {x:0,y:0},
                canvasOriginalSize: null,
                resizeStart: {x:0,y:0},
                resizeShift: {x:0,y:0},
                resizeAnchor: null,
                lastDrawTool: 'pencil',
                pickerArmed: false,
                pickerSlot: 1,
                pickerPreviewLastSample: 0,
                hoverPreviewLastSample: 0,
                hoverPreviewLastPoint: null,
                fileHandle: null,
                projectHandle: null,
                filePath: null,
                palettes: [],
                activePaletteId: null,
                previewPaletteId: null,
                previewSnapshot: null,
                projectFile: null,
                projectImage: false,
                projectBitDepth: 4,
                // Set by tiled-screen.js when this document was assembled out of
                // a tile sheet + tilemap. Document-scoped: two frames of one
                // animation are two tabs over the same sheet, and a single
                // shared value would save one tab's pixels into the other's
                // tilemap.
                screen: null,
                // The live index map of a project asset — one palette slot per
                // pixel, kept in step with the canvas by every committed edit.
                // Replaced wholesale, never written in place, so a history entry
                // can hold the array itself instead of a copy.
                projectIndices: null,
                projectTrns: null,
                projectTransparentIndex: -1,
                // Which frame of a multi-frame sheet is being worked on, and how
                // the sheet is read. See projectFrameLayout().
                activeFrame: 0,
                frameCountOverride: null,
                frameHold: 0,
                onionSkin: false,
                lastMouse: null,
                transPick: false,
                outlinePhase: 0,
                outlineAnimId: null,
                outlineLastTime: 0,
                smartPencilActive: false,
                smartPencilSlot: 1,
                activeShapePathHandle: null,
                shapeDragStart: null,
                shapeDragBase: null,
                isRotatingShape: false,
                shapeRotateSession: null,
                shapeResizeAnchor: null,
                shapeResizeBase: null,
                canvasOffset: { x: 0, y: 0 },
                savedFreeOffset: null,
                ribbonDrag: null,
                hueSatActive: false,
                hueSatApplied: false,
                hueSatChannel: 'Master',
                hueSatSplit: false,
                hueSatSplitRatio: 0.5,
                hueSatDragging: false,
                ribbonContextSection: null,
                busyOps: 0,
                isSaving: false,
                isFileLoading: false,
                isDirty: false,
                hasDocument: false,
                fileName: 'untitled.png',
                resizePreviewActive: false,
                resizePreviewRect: null,
                resizePreviewGhost: null,
                forceBusyIndicator: false,
                saveFeedbackActive: false,
                exportPalette: [],
                exportDraggingIndex: -1,
                exportPreset: 'gba-sprite',
                tempSelectionDrawRect: null,
                exportDir: null,
                recentFiles: [],
                freehandActive: false, freehandPoints: [],
                paintbrushActive: false
            };
            // Fields of `state` that describe *the document* rather than the app
            // session. These are the fields a document swap (tab switch) must
            // carry across; everything else is either app-global or in-progress
            // gesture state cleared by resetTransientEditState().
            //
            // Adding a field to `state` above means deciding which of the two it
            // is. If it belongs to the document, add it here — otherwise a second
            // document will silently inherit the first one's value.
            this.DOCUMENT_STATE_KEYS = Object.freeze([
                'history', 'step',
                'fileName', 'filePath', 'fileHandle',
                'projectFile', 'projectHandle', 'projectImage', 'projectBitDepth', 'screen',
                'projectIndices', 'projectTrns', 'projectTransparentIndex',
                'activeFrame', 'frameCountOverride', 'frameHold', 'onionSkin',
                'palettes', 'activePaletteId', 'previewPaletteId', 'previewSnapshot',
                'isDirty', 'canvasOffset'
            ]);
            this.resizeState = { w:0, h:0, ratio: 1 };
            this.resizeRatioState = true;
            this.hotkeys = {};
            this.hotkeyDefaults = {};
            this.hotkeyActions = [];
            this.hotkeyActionMap = {};
            this.hotkeyIndexSimple = {};
            this.hotkeyIndexComplex = {};
            this.hotkeyCapture = null;
            this.hotkeysDrag = null;
            this.modalDrag = null;
            this.keyState = new Set();
            this.keyOrder = [];
            this.pendingSimple = null;
            this.hotkeyToggleIndex = {};
            this.secretArmed = false;
            this.winColorQuantMode = null;
            this._antsPatternCanvas = null;
            this._colorCountPending = false;
            this._colorCountTimer = null;
            this._colorCountLastAt = 0;
            this._colorCountMinIntervalMs = 120;
            this._colorCountJobId = 0;
            this._colorCountWorker = null;
            this._colorCountWorkerFailed = false;
            this._overlayRaf = null;
            this._smartPencilRaf = null;
            this._smartPencilReady = false;
            this._pendingOverlayOverride = null;
            this._gridOverlayRaf = null;
            this._selectionRenderRaf = null;
            this._pathHandlesRaf = null;
            this._selectionUiCacheKey = '';
            this._selRotateColorCache = { px: null, py: null, at: 0 };
            this._gridOverlayCacheKey = '';
            this._tileOverlayCacheKey = '';
            this._activeShapeBoundsCache = null;
            this._activeShapeBoundsCacheShape = null;
            this._activeSidebarModalId = null;
            this._antsOverlayCache = {
                selection: null,
                path: '',
                transform: '',
                visible: false,
                clip: '0,0,0,0'
            };
            this._antsPattern = null;
            this._antsPatternCtx = null;
            this.colorPreviewState = new WeakMap();
            this.themeSelectActive = false;
            this.themeSelectHoverEl = null;
            this.themeSelectPickedRowKey = null;
            this.themeSelectPickedRowTimer = null;
            this.themeSelectBound = false;
            this.colorCustomizerSelectedKey = null;
            this.colorCustomizerFilterChangedOnly = false;
            this.colorCustomizerEditorBound = false;
            this.colorCustomizerHistory = [];
            this.colorStepperState = {
                signature: '',
                currentIndex: null,
                nextIndex: 0,
                currentKey: null,
                currentPrevOverride: null
            };
            this.colorShortcutBound = false;
            this._wandPreviewBuffer = null;
            this._wandPreviewImageData = null;
            this._wandStack = null;
            this._wandSelectRaf = null;
            this._wandPerfLog = null;
            this._wandSortedIdx = null;
            this._wandSelectedCutoff = -1;
            this._wandMaskBuf = null;
            this._wandEntered = null;
            // Preview worker back-pressure: the jobId currently being computed
            // (null when idle) and the newest request waiting for it to finish.
            this._wandWorkerInFlight = null;
            this._wandWorkerPending = null;
            this.saveReminderMinutes = 60;
            this.saveReminderEnabled = true;
            this.saveReminderTimer = null;
            this._saveReminderFlash = null;
            this.saveReminderNextAt = 0;
            this.saveReminderTick = null;
            this._saveReminderCheck = null;
            this._saveReminderActive = false;
            this.saveCursorFeedbackMs = 520;
            this._saveCursorFeedbackTimer = null;
            this._saveCursorFeedbackUntil = 0;
            this._lastMouseMoveAt = 0;
            this._lastPointerActivityAt = 0;
            this.gridlinesSize = 64;
            this.gridlinesEnabled = false;
            this.gridlinesColor = '#0044ff';
            this.gridlinesPickActive = false;
            this.tileModeEnabled = false;
            this.tileSize = 16;
            this.tileGrid = 3;
            this.tileDarkenEnabled = false;
            this.tileDarkenOpacity = 0.12;
            this.tileOffsets = null;
            this.cleanEdgeRotateGL = null;
            this.isForceClosing = false;
            this._unlistenCloseEvent = null;
            this._closeListenerInstalling = false;
            this._closeConfirmKeydown = null;
            this._startupWindowRevealed = false;
            this.appStartedAt = Date.now();
            this.recentFilesStorageKey = 'paint.recentFiles.v1';
            this.fileMenuRecentCollapsedStorageKey = 'paint.fileMenuRecentCollapsed.v1';
            this.maxRecentFiles = 12;
            this.fileMenuRecentCollapsed = false;
            this.ui = {
                stage: document.getElementById('canvas-stage'),
                cMain: /** @type {HTMLCanvasElement} */ (document.getElementById('layer-main')),
                cTemp: /** @type {HTMLCanvasElement} */ (document.getElementById('layer-temp')),
                frameOnion: /** @type {HTMLCanvasElement} */ (document.getElementById('frame-onion')),
                coords: document.getElementById('status-coords'),
                statusSelectionSize: document.getElementById('status-selection-size'),
                statusRotation: document.getElementById('status-rotation'),
                statusDims: document.getElementById('status-dims'),
                sizeInput: document.getElementById('pen-size-input'),
                palRec: document.getElementById('palette-recent'),
                selControls: document.getElementById('selection-controls'),
                pathHandles: document.getElementById('path-handles'),
                viewport: document.getElementById('viewport'),
                globalSvg: document.getElementById('global-overlay-svg'),
                gradVectorOverlay: document.getElementById('grad-vector-overlay'),
                svgGhostRect: document.getElementById('svg-ghost-rect'),
                svgSelRect: document.getElementById('svg-sel-rect'),
                svgSelRectBack: document.getElementById('svg-sel-rect-back'),
                svgAntsWrap: document.getElementById('svg-ants-wrap'),
                svgAntsPath: document.getElementById('svg-ants-path'),
                svgAntsPathBack: document.getElementById('svg-ants-path-back'),
                svgAntsClipRect: document.getElementById('ants-clip-rect'),
                eraserGhost: document.getElementById('eraser-ghost'),
                statusColors: document.getElementById('status-colors'),
                statusSelColors: document.getElementById('status-sel-colors'),
                statusReminder: document.getElementById('status-reminder'),
                saveReminderModal: document.getElementById('save-reminder-modal'),
                closeConfirmModal: document.getElementById('close-confirm-modal'),
                gridOverlay: document.getElementById('grid-overlay'),
                gridLines: document.getElementById('grid-lines-4'),
                gridClipRect: document.getElementById('grid-clip-rect'),
                tileOverlay: document.getElementById('tile-overlay'),
                tileShadeWrap: document.getElementById('tile-shade-wrap'),
                tileClipRect: document.getElementById('tile-clip-rect'),
                gridlineColorSwatch: document.getElementById('gridline-color-swatch'),
                hoverPreview: null,
                pencilIcon: document.getElementById('pencil-cursor-icon'),
                pencilSmartIcon: document.getElementById('pencil-smart-cursor-icon'),
                saveIndicator: document.getElementById('save-indicator'),
                statusZoom: document.getElementById('status-zoom'),
                canvasResizeHandles: document.getElementById('canvas-resize-handles'),
                resizerRight: document.querySelector('.resizer.r-right'),
                resizerBottom: document.querySelector('.resizer.r-bottom'),
                resizerCorner: document.querySelector('.resizer.r-corner'),
                resizerLeft: document.querySelector('.resizer.r-left'),
                resizerTop: document.querySelector('.resizer.r-top'),
                resizerTL: document.querySelector('.resizer.r-tl'),
                resizerTR: document.querySelector('.resizer.r-tr'),
                resizerBL: document.querySelector('.resizer.r-bl'),
                cqPalette: document.getElementById('cq-palette'),
                winBasic: document.getElementById('wincolor-basic'),
                winCustom: document.getElementById('wincolor-custom'),
                winWindow: document.getElementById('wincolor-window'),
                winRight: document.getElementById('wincolor-right'),
                winSpectrum: document.getElementById('wincolor-spectrum'),
                winLum: document.getElementById('wincolor-lum'),
                winCross: document.getElementById('wincolor-crosshair'),
                winLumArrow: document.getElementById('wincolor-lum-arrow'),
                winSample: document.getElementById('wincolor-sample'),
                winTitleBar: document.querySelector('#modal-wincolor .title-bar'),
                winTabSpec: document.getElementById('win-tab-spec'),
                winTabBpp: document.getElementById('win-tab-bpp'),
                winBppPanel: document.getElementById('wincolor-bpp-panel'),
                winBppPreview: document.getElementById('win-bpp-preview'),
                wandThreshold: document.getElementById('wand-threshold'),
                wandThresholdVal: document.getElementById('wand-threshold-val'),
                fileMenuRecentList: document.getElementById('file-menu-recent-list'),
                fileMenuRecentToggle: document.getElementById('file-menu-recent-toggle'),
            };
            this._lastCoordsText = this.ui.coords ? this.ui.coords.textContent : '';
            this._lastSelectionSizeText = this.ui.statusSelectionSize ? this.ui.statusSelectionSize.textContent : '-';
            this._lastRotationStatusText = this.ui.statusRotation ? this.ui.statusRotation.textContent : 'Rot: 0.00°';
            this.ctx = this.trackCtx(this.ui.cMain.getContext('2d', {willReadFrequently:true}));
            this.markAllDirty();
            this.ctxTemp = this.trackCtx(this.ui.cTemp.getContext('2d', { willReadFrequently: true }), 'temp');
            this.markCleanDirty('temp');
            this.disableSmoothing(this.ctx);
            this.disableSmoothing(this.ctxTemp);
            this.gl = null;
            this.glCanvas = null;
            this.glProgram = null;
            this.glBuffers = null;
            this.glBrush = null;
            this.glBrushCanvas = null;
            this.glBrushProgram = null;
            this.glBrushBuffers = null;
            this.glBrushQuadProgram = null;
            this.glBrushQuadBuffers = null;
            this.glBrushLimits = null;
            this.quantizeWorker = null;
            this.quantizeGL = null;
            this.transformGL = null;
            this.paletteGL = null;
            this.paletteGLFailed = false;
            this.strokeQueue = [];
            this.strokeRaf = null;
            this.brushCache = null;
            this._brushLRU = [];
            this.depthBackup = null;
            this.recentColors = Array(10).fill(null);
            this.palette = [];
            this.paletteLab = null;
            this.paletteLocked = false;
            this.bitDepth = 24;
            this.tileHistory = {
                enabled: false,
                tileSize: 256,
                // Tiled history breaks the canvas into independently-compressed tiles.
                // Threshold set low enough that typical working sizes (> 512×512) benefit;
                // anything smaller than a small sprite is stored as a flat snapshot instead.
                thresholdPixels: 200 * 200,
                // A step stores only the tiles it changed, plus a link to the
                // step before. Every Nth step instead stores the whole grid, so
                // restoring never walks back further than N steps. Raising this
                // makes steps cheaper and restores slower.
                anchorInterval: 20
            };
            this.historyLimitEnabled = true;
            // A count, not a memory guard — historyByteBudget() does that. Kept
            // generous so memory is what you run out of, not an arbitrary number.
            this.historyLimit = 500;
            this.HISTORY_MIN_STEPS = 8;
            this._historyAdaptive = false;
            this._tileCopyBuf = null;
            this.bounds = { left: 0, top: 0 };
            // Set once the startup layout has settled — until then nothing about
            // the canvas position is allowed to animate.
            this._startupSettled = false;
            this.zoomLevels = [6.25, 12.5, 25, 50];
            for(let i=100; i<=1000; i+=100) this.zoomLevels.push(i);
            for(let i=1200; i<=3000; i+=200) this.zoomLevels.push(i);
            this._tabWheelAt = 0;
            this._freehandPendingFrame = null;
            this._freehandInputPoints = [];
            this._freehandStrokePoints = null;
            this._fhPreviewing = false;
            this._loadFreehandConfig();
            this.init();
        }

        // --- perf instrumentation (debug-only, near-zero cost when disabled) ---
        get2dContext(canvas) {
            let ctx = null;
            try { ctx = canvas.getContext('2d', { colorSpace: 'srgb' }); } catch (e) { ctx = null; }
            if (!ctx) ctx = canvas.getContext('2d');
            return ctx;
        }

        disableSmoothing(ctx) {
            if (ctx._smoothingDisabled) return;
            ctx.imageSmoothingEnabled = false;
            ctx.mozImageSmoothingEnabled = false;
            ctx.webkitImageSmoothingEnabled = false;
            ctx.msImageSmoothingEnabled = false;
            ctx.oImageSmoothingEnabled = false;
            ctx._smoothingDisabled = true;
        }

        setCoordsStatus(x, y) {
            if (!this.ui.coords) return;
            const next = `${x}, ${y}px`;
            if (next === this._lastCoordsText) return;
            this._lastCoordsText = next;
            this.ui.coords.textContent = next;
        }

        requestGlobalOverlayUpdate(creatingOverride = null) {
            this._pendingOverlayOverride = creatingOverride ? {
                x: creatingOverride.x,
                y: creatingOverride.y,
                w: creatingOverride.w,
                h: creatingOverride.h
            } : null;
            if (this._overlayRaf) return;
            this._overlayRaf = requestAnimationFrame(() => {
                this._overlayRaf = null;
                const pending = this._pendingOverlayOverride;
                this._pendingOverlayOverride = null;
                this.updateGlobalOverlays(pending);
            });
        }

        requestBoundsUpdate() {
            if (this._boundsRaf) return;
            this._boundsRaf = requestAnimationFrame(() => {
                this._boundsRaf = null;
                this.updateBounds();
            });
        }

        requestPathHandlesUpdate() {
            if (this._pathHandlesRaf) return;
            this._pathHandlesRaf = requestAnimationFrame(() => {
                this._pathHandlesRaf = null;
                this.updatePathHandles();
            });
        }

        ensureColorCountWorker() {
            if (this._colorCountWorkerFailed) return null;
            if (this._colorCountWorker) return this._colorCountWorker;
            if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
                this._colorCountWorkerFailed = true;
                return null;
            }
            const code = `
                function countColors(data) {
                    const set = new Set();
                    for (let i = 0; i < data.length; i += 4) {
                        if (data[i + 3] === 0) continue;
                        set.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
                    }
                    return set.size;
                }
                // Reading a 13000x13000 canvas back costs ~125 ms and a 676 MB
                // allocation. Doing that here rather than on the main thread is
                // the difference between a hitch and no hitch, so an image is
                // preferred over a pixel buffer whenever one can be sent.
                function dataFromBitmap(bmp) {
                    const oc = new OffscreenCanvas(bmp.width, bmp.height);
                    const c = oc.getContext('2d', { willReadFrequently: true });
                    c.drawImage(bmp, 0, 0);
                    const d = c.getImageData(0, 0, bmp.width, bmp.height).data;
                    bmp.close();
                    return d;
                }
                self.onmessage = function (e) {
                    const payload = e && e.data ? e.data : {};
                    const jobId = payload.jobId || 0;
                    try {
                        let mainData;
                        if (payload.bitmap) {
                            mainData = dataFromBitmap(payload.bitmap);
                        } else {
                            mainData = payload.mainData ? new Uint8ClampedArray(payload.mainData) : new Uint8ClampedArray(0);
                        }
                        const selData = payload.selData ? new Uint8ClampedArray(payload.selData) : null;
                        const total = countColors(mainData);
                        const sel = selData ? countColors(selData) : null;
                        self.postMessage({ jobId, total, sel });
                    } catch (err) {
                        if (payload.bitmap && payload.bitmap.close) {
                            try { payload.bitmap.close(); } catch (e2) {}
                        }
                        self.postMessage({ jobId, failed: true });
                    }
                };
            `;
            try {
                const blob = new Blob([code], { type: 'application/javascript' });
                const url = URL.createObjectURL(blob);
                const worker = new Worker(url);
                const revokeUrl = () => {
                    URL.revokeObjectURL(url);
                    worker.removeEventListener('message', revokeUrl);
                    worker.removeEventListener('error', revokeUrl);
                };
                worker.addEventListener('error', revokeUrl);
                worker.addEventListener('message', revokeUrl);
                worker.onmessage = (event) => {
                    const payload = event && event.data ? event.data : null;
                    if (!payload) return;
                    if (payload.jobId !== this._colorCountJobId) return;
                    if (payload.failed) {
                        // The worker could not read the image; go back to
                        // reading it here, slow but correct.
                        this._colorCountNoBitmap = true;
                        return;
                    }
                    this.setColorCountStatus(payload.total, payload.sel, !!this.state.selection);
                };
                worker.onerror = () => {
                    this._colorCountWorkerFailed = true;
                    try { worker.terminate(); } catch (e) {}
                    this._colorCountWorker = null;
                };
                this._colorCountWorker = worker;
                return worker;
            } catch (e) {
                this._colorCountWorkerFailed = true;
                return null;
            }
        }

        /**
         * Blob-URL worker that computes the magic-wand threshold-drag preview
         * (mask + SVG boundary path) off the main thread, following the same
         * pattern as ensureColorCountWorker — no build changes, no separate
         * file, no SharedArrayBuffer/cross-origin-isolation requirement.
         *
         * The per-drag diff buffer (immutable for the life of the drag) is sent
         * once via _initWandPreviewWorker(); every subsequent frame only sends
         * a tiny {tolerance} message, so the main thread never blocks on mask
         * compute or boundary tracing — it only receives a finished path string
         * and writes it to the DOM, exactly as it did synchronously before.
         * Output is byte-for-byte identical to the synchronous fallback, so the
         * committed/marching-ants visuals are unaffected.
         */
        countColorsFromData(data) {
            if (!data || data.length === 0) return 0;
            const set = new Set();
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] === 0) continue;
                set.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
            }
            return set.size;
        }

        setColorCountStatus(total, selCount = null, hasSelection = false) {
            this._lastKnownColorCount = total;
            this.ui.statusColors.textContent = `Colors: ${total}`;
            if (hasSelection) {
                this.ui.statusSelColors.style.display = 'block';
                this.ui.statusSelColors.textContent = `Sel: ${selCount === null ? 0 : selCount}`;
            } else {
                this.ui.statusSelColors.style.display = 'none';
            }
            this.updateProjectConformance(total);
        }
        /* What still stands between this canvas and the ROM, as one line.
           It is always on screen for a project asset and never in the way, so the
           limits are something you glance at rather than something you discover
           when the build fails. */
        updateConformanceBanner(info) {
            const bar = this.ui.conformanceBanner
                || (this.ui.conformanceBanner = document.getElementById('conformance-banner'));
            if (!bar) return;
            const bad = info && !info.ok ? info.parts.filter(p => !p.ok) : [];
            if (!bad.length) {
                bar.style.display = 'none';
                this._conformanceDismissed = null;
                return;
            }
            const key = bad.map(p => p.text).join(' · ');
            if (this._conformanceDismissed === key) { bar.style.display = 'none'; return; }
            const text = bar.querySelector('#cb-text');
            if (text) text.textContent = `${info.label} won’t build: ${key}`;
            bar.style.display = 'flex';
        }
        dismissConformanceBanner() {
            const info = this.projectConformance();
            const bad = info && !info.ok ? info.parts.filter(p => !p.ok) : [];
            this._conformanceDismissed = bad.map(p => p.text).join(' · ');
            const bar = this.ui.conformanceBanner || document.getElementById('conformance-banner');
            if (bar) bar.style.display = 'none';
        }

        initializeBlankDocument() {
            if (this.state.hasDocument) return;
            this.state.history = [];
            this.state.step = -1;
            this.setSize(this.config.width, this.config.height);
            this.ctx.fillStyle = 'white';
            this.ctx.fillRect(0, 0, this.config.width, this.config.height);
            this.saveState();
            this.markClean();
            this.state.hasDocument = true;
        }

        init() {
            const colors = ['#000000','#7f7f7f','#880015','#ed1c24','#ff7f27','#fff200','#22b14c','#00a2e8','#3f48cc','#a349a4','#ffffff','#c3c3c3','#b97a57','#ffaec9','#ffc90e','#efe4b0','#b5e61d','#99d9ea','#7092be','#c8bfe7'];

            const p = document.getElementById('palette-std');
            colors.forEach(c => this.addSwatch(p, c));
            this._loadPaletteCustomizations();
            this.renderRecent();
            this.loadRecentFiles();
            this.renderFileMenuRecentFiles();
            this.setFileMenuRecentCollapsed(this.lsGet(this.fileMenuRecentCollapsedStorageKey) === 'true', false);
            const propsW = document.getElementById('pr-w');
            const propsH = document.getElementById('pr-h');
            if (propsW) propsW.addEventListener('input', () => this.refreshPropsModal(false));
            if (propsH) propsH.addEventListener('input', () => this.refreshPropsModal(false));
            document.getElementById('sys-color').addEventListener('change', e => {
                this.setColor(e.target.value, this.config.activeSlot);
                this.addRecentColor(e.target.value);
            });
            const palUpload = document.getElementById('pal-upload');
            if (palUpload) {
                palUpload.onchange = (e) => {
                    const file = e && e.target && e.target.files ? e.target.files[0] : null;
                    if (!file) return;
                    this.importPalette(file);
                    e.target.value = '';
                };
            }
            const swapBtn = document.getElementById('swap-colors-btn');
            if (swapBtn) {
                swapBtn.addEventListener('click', () => this.swapColors());
                swapBtn.addEventListener('keydown', e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.swapColors();
                    }
                });
            }
            const storedAnchor = this.lsGet('paint.anchorCanvas');
            if (storedAnchor === 'true' || storedAnchor === 'false') {
                this.config.anchorCanvas = storedAnchor === 'true';
            }
            this.toggleAnchorCanvas(this.config.anchorCanvas);
            this.updateAnchorStatus();
            const storedDragRotate = this.lsGet('paint.dragRotate');
            if (storedDragRotate === 'true' || storedDragRotate === 'false') {
                this.config.dragRotate = storedDragRotate === 'true';
            }
            this.updateDragRotateStatus();
            /* In free-canvas mode (no fixed viewport scroll), center the stage in the viewport
               after the initial layout pass so the canvas appears centred on first load. */
            if (!this.config.anchorCanvas) {
                requestAnimationFrame(() => requestAnimationFrame(() => this.centerCanvas()));
            }
            const c1Disp = document.getElementById('c1-disp');
            if (c1Disp && this.config.c1 === '#000000') c1Disp.dataset.fixedBlack = 'true';
            this.ui.pickerDot = document.createElement('div');
            this.ui.pickerDot.id = 'picker-hotspot';
            document.body.appendChild(this.ui.pickerDot);
            // Pointer Events (not Mouse Events) are used on the drawing surface because:
            //   • PointerEvents expose pressure, tilt, and pointerType for stylus support.
            //   • MouseEvent.pressure is always undefined.
            //   touch-action:none prevents the browser from consuming pen moves as
            //   scroll gestures before the app can read them.
            this.ui.stage.style.touchAction = 'none';
            this.ui.stage.addEventListener('pointerdown', e => this.onMouseDown(e));
            if (this.ui.selControls) {
                this.ui.selControls.addEventListener('contextmenu', e => {
                    const rotateEl = e.target && e.target.closest ? e.target.closest('.sel-rotate-handle') : null;
                    if (rotateEl && this.state.selection) {
                        e.preventDefault();
                        e.stopPropagation();
                        this.toggleSelRotateAnchorMode();
                    }
                });
                this.ui.selControls.addEventListener('pointerdown', e => this.onMouseDown(e));
            }
            this.initSmartPencil();

            this.ui.viewport.addEventListener('pointerdown', e => {
                if(e.button === 1) {
                    if (this.config.anchorCanvas) {
                        e.preventDefault();
                        this.updateBounds();
                        this.state.isPanning = true;
                        this.state.panStart = { x: e.clientX, y: e.clientY };
                        this.state.scrollStart = { x: this.ui.viewport.scrollLeft, y: this.ui.viewport.scrollTop };
                    } else {
                        e.preventDefault();
                        this.state.isCanvasDragging = true;
                        this.state.canvasDragStart = { x: e.clientX, y: e.clientY };
                        this.state.canvasOffsetStart = { x: this.state.canvasOffset.x, y: this.state.canvasOffset.y };
                    }
                }
                // When gradient tool is active, forward left-click to onMouseDown
                // so handles outside the canvas bounds remain clickable.
                if (this.config.tool === 'gradient' && (e.button === 0 || e.button === 2)) {
                    this.onMouseDown(e);
                }
            });

            window.addEventListener('pointermove', e => this.onMouseMove(e));
            window.addEventListener('pointerup', e => this.onMouseUp(e));
            this._lastMouseMoveAt = performance.now();
            window.addEventListener('mousedown', e => {
                if (this.handleHotkeyMouse(e)) return;
            });
            this.ui.stage.addEventListener('contextmenu', e => {
                e.preventDefault();
                if (this.config.tool === 'select') {
                    const m = document.getElementById('ctx-menu');
                    m.style.display = 'flex';
                    m.style.left = e.clientX + 'px';
                    m.style.top = e.clientY + 'px';
                }
            });
            this.ui.stage.addEventListener('dblclick', e => {
                if (this.config.tool === 'lasso' && this.state.lassoActive && this.state.lassoMode === 'poly') {
                    e.preventDefault();
                    this.finalizeLassoSelection();
                }
            });
            this.initCloseListener();
            window.addEventListener('contextmenu', e => {
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                }
            });
            window.addEventListener('resize', () => {
                this.updateBounds();
                this.updateGridOverlay();
                this.reclampOpenDraggableWindows();
                this.updateTitleBarMaximizeIcon();
            });
            setTimeout(() => this.updateBounds(), 100);

            window.addEventListener('wheel', e => { if(e.ctrlKey) { e.preventDefault(); this.setZoom(e.deltaY<0?0.1:-0.1, e); } }, {passive:false});
            window.addEventListener('paste', e => {
                if(e.clipboardData && e.clipboardData.items) {
                    for(let i=0; i<e.clipboardData.items.length; i++) {
                        if(e.clipboardData.items[i].type.includes('image')) {
                            this.handleFile(e.clipboardData.items[i].getAsFile(), true);
                            return;
                        }
                    }
                }
            });
            /* Take over from the boot-time paste catcher in index.html's <head>.
               Detaching it here, in the same statement run that installs the
               real handler, is what keeps a later paste from being both handled
               now and replayed again at the end of init(). Whatever it caught
               before this point is drained there — the engine is only part
               built at this line and cannot paste yet. */
            if (window.__earlyPaste) {
                window.removeEventListener('paste', window.__earlyPaste);
                window.__earlyPaste = null;
            }
            window.addEventListener('keydown', e => {
                this.updateKeyState(e, true);
                if (e.key === 'F5') {
                    e.preventDefault();
                    return;
                }
                if (e.key === 'F11') {
                    const hasTauri = !!(this.getTauriWindow() || this.getTauriInvokeFn());
                    if (hasTauri) {
                        e.preventDefault();
                        this.toggleWindowFullscreen().catch((err) => {
                            console.log('F11 fullscreen toggle failed', err);
                        });
                        return;
                    }
                }
                if (e.ctrlKey && e.key && e.key.toLowerCase() === 'r') {
                    e.preventDefault();
                    return;
                }
                if (this.checkSecretChord()) { e.preventDefault(); return; }
                if (this.captureHotkeyEvent(e)) return;
                if (e.key === 'Tab' && !(e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA'))) {
                    e.preventDefault();
                    this.toggleToolbar();
                    return;
                }
                if (this.isHotkeysOpen()) {
                    if (e.key === 'Escape') this.closeHotkeys();
                    return;
                }
                if (this.handleHotkeyEvent(e)) return;
                if (this.state.shapeEditMode && e.key === 'Enter') this.commitActiveShape();
                if (this.config.tool === 'poly' && this.state.polyActive && e.key === 'Enter') this.commitPolyline();
                if (this.config.tool === 'lasso' && this.state.lassoActive && this.state.lassoMode === 'poly' && e.key === 'Enter') this.finalizeLassoSelection();
                if (this.config.tool === 'gradient' && this.config.gradient.active && e.key === 'Enter') { this.gradientApply(); }
            });
            window.addEventListener('keyup', e => {
                this.updateKeyState(e, false);
                this.handleHotkeyKeyup(e);
            });
            window.addEventListener('blur', () => {
                this.keyState.clear();
                this.keyOrder = [];
                this.pendingSimple = null;
            });
            this.ui.sizeInput.addEventListener('input', e => this.changeSizeInput(e.target.value));
            this.ui.sizeInput.addEventListener('change', e => this.changeSizeInput(e.target.value));
            this.ui.sizeInput.addEventListener('wheel', e => {
                e.preventDefault();
                e.stopPropagation();
                const step = e.ctrlKey ? 10 : 1;
                const dir = e.deltaY < 0 ? step : -step;
                this.changeSize(dir);
            }, { passive: false });
            this.syncLineWidthMenu();
            // initDock removed — using single-slot exclusive sidebars

            // Apply initial tool UI state (panel visibility, active button, etc.)
            this.setTool(this.config.tool);

            if (this.ui.wandThreshold) {
                this.updateWandThreshold(this.config.wandTolerance, { applySelection: false });
                this.ui.wandThreshold.addEventListener('input', e => this.updateWandThreshold(e.target.value, { manual: true }));
            }
            const storedWandMode = this.lsGet('paint.wandMode');
            if (storedWandMode === 'global' || storedWandMode === 'contiguous') {
                this.config.wandMode = storedWandMode;
            }
            this.syncWandMenu();
            const wandBtn = document.getElementById('wand-tool-btn');
            if (wandBtn) {
                wandBtn.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    const nextMode = this.config.wandMode === 'global' ? 'contiguous' : 'global';
                    this.setWandMode(nextMode);
                    this.setTool('wand');
                });
            }
            const storedPencilMode = this.lsGet('paint.pencilMode');
            if (storedPencilMode === 'smart' || storedPencilMode === 'standard') {
                this.config.pencilMode = storedPencilMode;
            }
            this.syncPencilMode();
            const storedSmartPencilCurveOnly = this.lsGet('paint.smartPencilCurveOnly');
            if (storedSmartPencilCurveOnly !== null) {
                this.config.smartPencilCurveOnly = storedSmartPencilCurveOnly === 'true';
            }
            this.syncSmartPencilDebugOptions();
            const smartPencilCurveOnlyToggle = document.getElementById('debug-smart-pencil-curve-only');
            if (smartPencilCurveOnlyToggle) {
                smartPencilCurveOnlyToggle.addEventListener('change', (e) => {
                    this.setSmartPencilCurveOnly(!!(e.target && e.target.checked));
                });
            }
            const pencilBtn = document.getElementById('pencil-tool-btn');
            if (pencilBtn) {
                pencilBtn.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                    const nextMode = this.config.pencilMode === 'smart' ? 'standard' : 'smart';
                    this.setPencilMode(nextMode);
                    this.setTool('pencil');
                });
            }
            const storedPickerPreview = this.lsGet('paint.pickerHoverPreview');
            if (storedPickerPreview !== null) {
                this.config.pickerHoverPreview = storedPickerPreview === 'true';
            }
            this.lsRemove('paint.smoothZoom');
            this.syncPickerMenu();
            const pickerBtn = document.getElementById('picker-tool-btn');
            if (pickerBtn) {
                pickerBtn.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    this.openPickerMenu(e);
                });
            }
            this.initGapStitcherUI();
            // Gradient presets
            const _presetSelect = document.getElementById('grad-presets');
            const _presetSave   = document.getElementById('grad-preset-save');
            const _builtinPresets = [
                { name: 'FG→BG Linear', config: { type: 'linear', repeat: 'none', reverse: false, dither: true, midpoint: 0.5, offset: 0, staggerLevels: 256 } },
                { name: 'FG→BG Radial', config: { type: 'radial', repeat: 'none', reverse: false, dither: true, midpoint: 0.5, offset: 0, staggerLevels: 256 } },
                { name: 'FG→BG Conic', config: { type: 'conic', repeat: 'none', reverse: false, dither: true, midpoint: 0.5, offset: 0, staggerLevels: 256 } },
                { name: 'Black→White Linear', config: { type: 'linear', repeat: 'none', reverse: false, dither: true, midpoint: 0.5, offset: 0, staggerLevels: 256 } },
                { name: 'Reverse FG→BG', config: { type: 'linear', repeat: 'none', reverse: true, dither: true, midpoint: 0.5, offset: 0, staggerLevels: 256 } },
            ];
            const _loadUserPresets = () => {
                try { return JSON.parse(localStorage.getItem('cdpaint.gradPresets')) || []; }
                catch { return []; }
            };
            const _saveUserPresets = (presets) => {
                try { localStorage.setItem('cdpaint.gradPresets', JSON.stringify(presets)); } catch (e) {}
            };
            const _populatePresets = () => {
                if (!_presetSelect) return;
                _presetSelect.innerHTML = '';
                for (const p of _builtinPresets) {
                    const opt = document.createElement('option');
                    opt.value = 'builtin:' + _builtinPresets.indexOf(p);
                    opt.textContent = p.name;
                    _presetSelect.appendChild(opt);
                }
                const userPresets = _loadUserPresets();
                if (userPresets.length) {
                    const sep = document.createElement('option');
                    sep.disabled = true; sep.textContent = 'ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ'; sep.style.fontSize = '9px';
                    _presetSelect.appendChild(sep);
                }
                for (const p of userPresets) {
                    const opt = document.createElement('option');
                    opt.value = 'user:' + userPresets.indexOf(p);
                    opt.textContent = p.name;
                    _presetSelect.appendChild(opt);
                }
            };
            const _applyPreset = (config) => {
                const _g = this.config.gradient;
                for (const k of Object.keys(config)) {
                    if (k in _g) _g[k] = config[k];
                }
                _g.stops = null;
                const typeEl = document.getElementById('grad-type');
                if (typeEl && typeEl.value !== config.type) { typeEl.value = config.type;
                    const isStaggered = config.type === 'staggered';
                    const isRadial    = config.type === 'radial';
                    const _staggerCard = document.getElementById('grad-stagger-card');
                    const _aspectCard  = document.getElementById('grad-aspect-card');
                    const _ditherEl = document.getElementById('grad-dither');
                    const _ditherLabel = document.getElementById('grad-dither-label');
                    if (_staggerCard) _staggerCard.style.display = isStaggered ? 'flex' : 'none';
                    if (_aspectCard) _aspectCard.style.display = isRadial ? 'flex' : 'none';
                    if (_ditherEl) {
                        if (isStaggered) { _ditherEl.checked = false; _ditherEl.disabled = true; _g.dither = false; }
                        else { _ditherEl.disabled = false; }
                    }
                }
                const repeatEl = document.getElementById('grad-repeat');
                if (repeatEl) repeatEl.value = config.repeat || 'none';
                const ditherEl = document.getElementById('grad-dither');
                if (ditherEl && config.type !== 'staggered') ditherEl.checked = config.dither;
                const revEl = document.getElementById('grad-reverse');
                if (revEl) revEl.checked = config.reverse;
                const midEl = document.getElementById('grad-midpoint');
                if (midEl) midEl.value = Math.round((config.midpoint ?? 0.5) * 100);
                const midValEl = document.getElementById('grad-midpoint-val');
                if (midValEl) midValEl.textContent = Math.round((config.midpoint ?? 0.5) * 100) + '%';
                if (midEl) {
                    const pct = Math.round((midEl.value-1)/98*100) + '%';
                    midEl.style.setProperty('--pct', pct);
                    const wrap = midEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                }
                const offEl = document.getElementById('grad-offset');
                if (offEl) offEl.value = Math.round((config.offset ?? 0) * 100);
                const offValEl = document.getElementById('grad-offset-val');
                if (offValEl) offValEl.textContent = (config.offset ?? 0) === 0 ? '0%' : (((config.offset ?? 0) * 100) > 0 ? '+' : '') + Math.round((config.offset ?? 0) * 100) + '%';
                if (offEl) {
                    const v = parseInt(offEl.value, 10);
                    const pct = Math.round((v+99)/198*100) + '%';
                    offEl.style.setProperty('--pct', pct);
                    const wrap = offEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                }
                const aspectEl = document.getElementById('grad-aspect');
                const aspectValEl = document.getElementById('grad-aspect-val');
                if (aspectEl) aspectEl.value = Math.round((config.aspectRatio ?? 1) * 100);
                if (aspectValEl) aspectValEl.textContent = (config.aspectRatio ?? 1).toFixed(2);
                if (aspectEl) {
                    const v = parseInt(aspectEl.value, 10);
                    const pct = Math.round((v-1)/499*100) + '%';
                    aspectEl.style.setProperty('--pct', pct);
                    const wrap = aspectEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                }
                const stagEl = document.getElementById('grad-stagger-levels');
                if (stagEl) stagEl.value = config.staggerLevels ?? 256;
                const stagValEl = document.getElementById('grad-stagger-val');
                if (stagValEl) stagValEl.textContent = config.staggerLevels ?? 256;
                if (stagEl) {
                    const v = parseInt(stagEl.value, 10);
                    const pct = Math.round((v-2)/254*100) + '%';
                    stagEl.style.setProperty('--pct', pct);
                    const wrap = stagEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                }
                _gradRefresh();
            };
            _populatePresets();
            if (_presetSelect) {
                _presetSelect.addEventListener('change', () => {
                    const val = _presetSelect.value;
                    if (!val) return;
                    const [source, idxStr] = val.split(':');
                    const idx = parseInt(idxStr, 10);
                    let presets;
                    if (source === 'builtin') {
                        presets = _builtinPresets;
                    } else {
                        presets = _loadUserPresets();
                    }
                    if (idx >= 0 && idx < presets.length) {
                        _applyPreset(presets[idx].config);
                    }
                });
            }
            if (_presetSave) {
                _presetSave.addEventListener('click', () => {
                    this._promptName('Preset name:', (name) => {
                        if (!name) return;
                        const config = { ...this.config.gradient };
                    // Only save render-relevant keys, not state
                    const keys = ['type','repeat','reverse','dither','midpoint','offset','staggerLevels','aspectRatio'];
                    const entry = { name: name.trim(), config: {} };
                    for (const k of keys) entry.config[k] = config[k];
                    const userPresets = _loadUserPresets();
                    userPresets.push(entry);
                    _saveUserPresets(userPresets);
                    _populatePresets();
                    if (_presetSelect) _presetSelect.value = 'user:' + (userPresets.length - 1);
                    });
                });
            }
            // ÔöÇÔöÇ Gradient color bar (multi-stop editor) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
            const _gradBar = document.getElementById('grad-bar');
            const _gradStopAdd  = document.getElementById('grad-stop-add');
            const _gradStopDel  = document.getElementById('grad-stop-del');
            const _gradStopReset = document.getElementById('grad-stop-reset');
            const _gradStopColor = document.createElement('input');
            _gradStopColor.type = 'color';
            _gradStopColor.style.display = 'none';
            document.body.appendChild(_gradStopColor);
            let _gradStopSel = 0;
            let _dragStopIdx = -1;

            const _ensureGradStops = () => {
                const _g = this.config.gradient;
                if (!_g.stops || _g.stops.length < 2) {
                    _g.stops = [
                        { offset: 0, color: this.config.c1, alpha: 1 },
                        { offset: 1, color: this.config.c2, alpha: 1 }
                    ];
                }
                if (_gradStopSel >= _g.stops.length) _gradStopSel = _g.stops.length - 1;
            };

            const _hexToRgbaStr = (hex, alpha) => {
                let h = hex.replace('#','');
                if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
                const r = parseInt(h.slice(0,2),16);
                const g = parseInt(h.slice(2,4),16);
                const b = parseInt(h.slice(4,6),16);
                return `rgba(${r},${g},${b},${alpha})`;
            };

            const _renderGradBar = () => {
                if (!_gradBar) return;
                const _g = this.config.gradient;
                _ensureGradStops();
                const stops = _g.stops;

                const w = Math.max(1, _gradBar.offsetWidth || 200);
                const h = 28;
                if (_gradBar.width !== w) _gradBar.width = w;
                if (_gradBar.height !== h) _gradBar.height = h;

                const ctx = _gradBar.getContext('2d', { willReadFrequently: true });
                ctx.fillStyle = '#f0f0f0';
                ctx.fillRect(0, 0, w, h);

                const grad = ctx.createLinearGradient(0, 0, w, 0);
                for (const s of stops) {
                    grad.addColorStop(s.offset, _hexToRgbaStr(s.color, s.alpha ?? 1));
                }
                ctx.fillStyle = grad;
                ctx.fillRect(0, 0, w, h);

                for (let i = 0; i < stops.length; i++) {
                    const x = stops[i].offset * w;
                    ctx.beginPath();
                    ctx.moveTo(x - 5, h);
                    ctx.lineTo(x, h - 7);
                    ctx.lineTo(x + 5, h);
                    ctx.closePath();
                    ctx.fillStyle = i === _gradStopSel ? '#fff' : '#000';
                    ctx.fill();
                    ctx.strokeStyle = i === _gradStopSel ? '#000' : '#fff';
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }

                // Sync alpha slider to selected stop
                if (_gradStopAlpha) {
                    const a = Math.round((stops[_gradStopSel].alpha ?? 1) * 100);
                    _gradStopAlpha.value = a;
                    if (_gradStopAlphaVal) _gradStopAlphaVal.textContent = a + '%';
                    const pct = a + '%';
                    _gradStopAlpha.style.setProperty('--pct', pct);
                    const wrap = _gradStopAlpha.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                }
            };
            this._renderGradBar = _renderGradBar;
            this._gradStopEditTarget = null;
            this._gradStopEditBackup = null;

            const _getStopAtX = (clientX) => {
                const rect = _gradBar.getBoundingClientRect();
                const x = (clientX - rect.left) / rect.width;
                const stops = this.config.gradient.stops;
                let closest = 0;
                let minDist = Infinity;
                for (let i = 0; i < stops.length; i++) {
                    const d = Math.abs(stops[i].offset - x);
                    if (d < minDist) { minDist = d; closest = i; }
                }
                return { index: closest, offset: x, distance: minDist };
            };

            if (_gradBar) {
                _gradBar.addEventListener('mousedown', (e) => {
                    _ensureGradStops();
                    const hit = _getStopAtX(e.clientX);
                    const stops = this.config.gradient.stops;
                    if (hit.distance < 0.04) {
                        _gradStopSel = hit.index;
                        _dragStopIdx = hit.index;
                        _renderGradBar();
                        return;
                    }
                    if (hit.distance < 0.08) {
                        _gradStopSel = hit.index;
                        _renderGradBar();
                        return;
                    }
                    // Click on blank area → insert a stop at this position
                    const clamped = Math.max(0, Math.min(1, hit.offset));
                    const px = Math.round(clamped * _gradBar.width);
                    const imgData = _gradBar.getContext('2d').getImageData(Math.max(0, Math.min(px, _gradBar.width - 1)), 14, 1, 1).data;
                    const hex = '#' + [imgData[0],imgData[1],imgData[2]].map(v => v.toString(16).padStart(2,'0')).join('');
                    stops.push({ offset: clamped, color: hex, alpha: 1 });
                    stops.sort((a, b) => a.offset - b.offset);
                    _gradStopSel = stops.findIndex(s => s.offset >= clamped);
                    _renderGradBar();
                    _gradRefresh();
                });

                document.addEventListener('mousemove', (e) => {
                    if (_dragStopIdx < 0) return;
                    const hit = _getStopAtX(e.clientX);
                    const stops = this.config.gradient.stops;
                    let o = Math.max(0, Math.min(1, hit.offset));
                    if (_dragStopIdx === 0) o = 0;
                    if (_dragStopIdx === stops.length - 1) o = 1;
                    if (_dragStopIdx > 0) o = Math.max(o, stops[_dragStopIdx - 1].offset + 0.001);
                    if (_dragStopIdx < stops.length - 1) o = Math.min(o, stops[_dragStopIdx + 1].offset - 0.001);
                    stops[_dragStopIdx].offset = o;
                    _renderGradBar();
                    _gradRefresh();
                });

                document.addEventListener('mouseup', () => {
                    if (_dragStopIdx >= 0) {
                        _dragStopIdx = -1;
                        _gradRefresh();
                    }
                });

                _gradBar.addEventListener('dblclick', (e) => {
                    const hit = _getStopAtX(e.clientX);
                    if (hit.distance < 0.08) {
                        _gradStopSel = hit.index;
                        const stop = this.config.gradient.stops[hit.index];
                        this._gradStopEditTarget = hit.index;
                        this._gradStopEditBackup = stop.color;
                        this.updateWinFromHex(stop.color);
                        this.openWinColor();
                    }
                });
            }

            if (_gradStopAdd) {
                _gradStopAdd.addEventListener('click', () => {
                    _ensureGradStops();
                    const stops = this.config.gradient.stops;
                    const sel = stops[_gradStopSel];
                    const nxt = stops[Math.min(_gradStopSel + 1, stops.length - 1)];
                    const off = sel.offset + (nxt.offset - sel.offset) * 0.5;
                    stops.push({ offset: off, color: '#808080', alpha: 1 });
                    stops.sort((a, b) => a.offset - b.offset);
                    _gradStopSel = stops.findIndex(s => s.offset >= off);
                    _renderGradBar();
                    _gradRefresh();
                });
            }

            if (_gradStopDel) {
                _gradStopDel.addEventListener('click', () => {
                    _ensureGradStops();
                    const stops = this.config.gradient.stops;
                    if (stops.length <= 2) return;
                    stops.splice(_gradStopSel, 1);
                    if (_gradStopSel >= stops.length) _gradStopSel = stops.length - 1;
                    _renderGradBar();
                    _gradRefresh();
                });
            }

            if (_gradStopReset) {
                _gradStopReset.addEventListener('click', () => {
                    this.config.gradient.stops = null;
                    _ensureGradStops();
                    _renderGradBar();
                    _gradRefresh();
                });
            }

            // ÔöÇÔöÇ Alpha slider ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
            const _gradStopAlpha    = document.getElementById('grad-stop-alpha');
            const _gradStopAlphaVal = document.getElementById('grad-stop-alpha-val');
            if (_gradStopAlpha) {
                _gradStopAlpha.addEventListener('input', () => {
                    _ensureGradStops();
                    const v = parseInt(_gradStopAlpha.value, 10);
                    if (_gradStopAlphaVal) _gradStopAlphaVal.textContent = v + '%';
                    this.config.gradient.stops[_gradStopSel].alpha = v / 100;
                    _renderGradBar();
                    _gradRefresh();
                    const pct = v + '%';
                    _gradStopAlpha.style.setProperty('--pct', pct);
                    const wrap = _gradStopAlpha.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                });
            }

            // ÔöÇÔöÇ Keyboard shortcuts for stop editor ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
            window.addEventListener('keydown', (e) => {
                const sidebar = document.getElementById('gradient-sidebar');
                if (!sidebar || !sidebar.classList.contains('open')) return;
                if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
                _ensureGradStops();
                const stops = this.config.gradient.stops;
                if ((e.key === 'Delete' || e.key === 'Backspace') && stops.length > 2) {
                    stops.splice(_gradStopSel, 1);
                    if (_gradStopSel >= stops.length) _gradStopSel = stops.length - 1;
                    _renderGradBar();
                    _gradRefresh();
                    e.preventDefault();
                }
                if (e.key === 'Tab') {
                    _gradStopSel = (_gradStopSel + 1) % stops.length;
                    _renderGradBar();
                    e.preventDefault();
                }
                if (e.key === 'ArrowLeft' && _gradStopSel > 0) {
                    const prev = stops[_gradStopSel - 1];
                    stops[_gradStopSel].offset = Math.max(prev.offset + 0.003, stops[_gradStopSel].offset - 0.01);
                    _renderGradBar();
                    _gradRefresh();
                    e.preventDefault();
                }
                if (e.key === 'ArrowRight' && _gradStopSel < stops.length - 1) {
                    const nxt = stops[_gradStopSel + 1];
                    stops[_gradStopSel].offset = Math.min(nxt.offset - 0.003, stops[_gradStopSel].offset + 0.01);
                    _renderGradBar();
                    _gradRefresh();
                    e.preventDefault();
                }
            });
            // Gradient tool ribbon listeners
            const _gradTypeEl   = document.getElementById('grad-type');
            const _gradRepeatEl = document.getElementById('grad-repeat');
            const _gradDitherEl = document.getElementById('grad-dither');
            const _gradRevEl    = document.getElementById('grad-reverse');
            const _gradRefresh  = () => {
                const _g = this.config.gradient;
                if (_g.active) {
                    this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                    _gradientRender(this.ctxTemp, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                    this._clipGradientToSelection();
                    this._gradientDrawVectorSVG();
                }
                _renderGradBar();
            };
            this._gradRefresh = _gradRefresh;
            if (_gradTypeEl)   _gradTypeEl.addEventListener('change',   () => {
                this.config.gradient.type   = _gradTypeEl.value;
                // Show/hide staggered levels card, disable dither in staggered mode
                const isStaggered = _gradTypeEl.value === 'staggered';
                const isRadial    = _gradTypeEl.value === 'radial';
                const _staggerCard = document.getElementById('grad-stagger-card');
                const _aspectCard  = document.getElementById('grad-aspect-card');
                const _ditherEl     = document.getElementById('grad-dither');
                const _ditherLabel  = document.getElementById('grad-dither-label');
                if (_staggerCard) _staggerCard.style.display = isStaggered ? 'flex' : 'none';
                if (_aspectCard) _aspectCard.style.display = isRadial ? 'flex' : 'none';
                if (_ditherEl && _ditherLabel) {
                    if (isStaggered) {
                        _ditherEl.checked = false;
                        _ditherEl.disabled = true;
                        _ditherLabel.style.opacity = '0.4';
                        this.config.gradient.dither = false;
                    } else {
                        _ditherEl.disabled = false;
                        _ditherLabel.style.opacity = '';
                    }
                }
                _gradRefresh();
            });
            if (_gradRepeatEl) _gradRepeatEl.addEventListener('change', () => { this.config.gradient.repeat = _gradRepeatEl.value; _gradRefresh(); });
            if (_gradDitherEl) _gradDitherEl.addEventListener('change', () => { this.config.gradient.dither = _gradDitherEl.checked; _gradRefresh(); });
            if (_gradRevEl)    _gradRevEl.addEventListener('change',    () => { this.config.gradient.reverse = _gradRevEl.checked;  _gradRefresh(); });
            const _gradStaggerEl   = document.getElementById('grad-stagger-levels');
            const _gradStaggerVal  = document.getElementById('grad-stagger-val');
            if (_gradStaggerEl) {
                _gradStaggerEl.addEventListener('input', () => {
                    const v = parseInt(_gradStaggerEl.value, 10);
                    if (_gradStaggerVal) _gradStaggerVal.textContent = v;
                    this.config.gradient.staggerLevels = v;
                    _gradRefresh();
                    const pct = Math.round((v-2)/254*100) + '%';
                    _gradStaggerEl.style.setProperty('--pct', pct);
                    const wrap = _gradStaggerEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                });
            }
            const _gradMidEl    = document.getElementById('grad-midpoint');
            const _gradMidValEl = document.getElementById('grad-midpoint-val');
            const _gradMidReset = document.getElementById('grad-midpoint-reset');
            if (_gradMidEl) {
                _gradMidEl.addEventListener('input', () => {
                    const v = parseInt(_gradMidEl.value, 10);
                    if (_gradMidValEl) _gradMidValEl.textContent = v + '%';
                    this.config.gradient.midpoint = v / 100;
                    _gradRefresh();
                    const pct = Math.round((v-1)/98*100) + '%';
                    _gradMidEl.style.setProperty('--pct', pct);
                    const wrap = _gradMidEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                });
            }
            if (_gradMidReset) {
                _gradMidReset.addEventListener('click', () => {
                    if (_gradMidEl) { _gradMidEl.value = 50; _gradMidEl.dispatchEvent(new Event('input')); return; }
                    this.config.gradient.midpoint = 0.5;
                    _gradRefresh();
                });
            }
            const _gradOffEl    = document.getElementById('grad-offset');
            const _gradOffValEl = document.getElementById('grad-offset-val');
            const _gradOffReset = document.getElementById('grad-offset-reset');
            if (_gradOffEl) {
                _gradOffEl.addEventListener('input', () => {
                    const v = parseInt(_gradOffEl.value, 10);
                    if (_gradOffValEl) _gradOffValEl.textContent = (v > 0 ? '+' : '') + v + '%';
                    this.config.gradient.offset = v / 100;
                    _gradRefresh();
                    const pct = Math.round((v+99)/198*100) + '%';
                    _gradOffEl.style.setProperty('--pct', pct);
                    const wrap = _gradOffEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                });
            }
            if (_gradOffReset) {
                _gradOffReset.addEventListener('click', () => {
                    if (_gradOffEl) { _gradOffEl.value = 0; _gradOffEl.dispatchEvent(new Event('input')); return; }
                    this.config.gradient.offset = 0;
                    _gradRefresh();
                });
            }
            const _gradAspectEl    = document.getElementById('grad-aspect');
            const _gradAspectValEl = document.getElementById('grad-aspect-val');
            if (_gradAspectEl) {
                _gradAspectEl.addEventListener('input', () => {
                    const v = parseInt(_gradAspectEl.value, 10);
                    const ratio = v / 100;
                    if (_gradAspectValEl) _gradAspectValEl.textContent = ratio.toFixed(2);
                    this.config.gradient.aspectRatio = ratio;
                    _gradRefresh();
                    const pct = Math.round((v-1)/499*100) + '%';
                    _gradAspectEl.style.setProperty('--pct', pct);
                    const wrap = _gradAspectEl.parentElement;
                    if (wrap && wrap.classList.contains('pb-slider-wrap')) wrap.style.setProperty('--pct', pct);
                });
            }
            // Attach custom mousedown handlers to gradient sidebar sliders
            // so clicking anywhere on the wrap tracks the slider (thumb is hidden).
            const _attachGradSliderWrap = (id) => {
                const el = document.getElementById(id);
                if (!el) return;
                const wrap = el.parentElement;
                if (!wrap || !wrap.classList.contains('pb-slider-wrap')) return;
                wrap.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                    const min = parseFloat(el.min) || 0;
                    const max = parseFloat(el.max) || 100;
                    const step = parseFloat(el.step) || 1;
                    function updateFromClientX(cx) {
                        const rect = wrap.getBoundingClientRect();
                        const pct = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
                        let val = min + pct * (max - min);
                        val = Math.round(val / step) * step;
                        val = Math.max(min, Math.min(max, val));
                        el.value = val;
                        el.dispatchEvent(new Event('input'));
                    }
                    updateFromClientX(e.clientX);
                    function onMove(me) { updateFromClientX(me.clientX); }
                    function onUp() {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                    }
                    document.addEventListener('mousemove', onMove);
                    document.addEventListener('mouseup', onUp);
                });
            };
            _attachGradSliderWrap('grad-midpoint');
            _attachGradSliderWrap('grad-offset');
            _attachGradSliderWrap('grad-aspect');
            _attachGradSliderWrap('grad-stagger-levels');
            _attachGradSliderWrap('grad-stop-alpha');
            document.getElementById('file-upload').onchange = e => {
                const f = e.target.files[0];
                if (f && /\.ora$/i.test(f.name)) { this.loadORAFile(f); }
                else { this.handleFile(f, false); }
            };
            const oraUpload = document.getElementById('ora-upload');
            if (oraUpload) oraUpload.onchange = e => { if (e.target.files[0]) this.loadORAFile(e.target.files[0]); };
            const pickDroppedImage = (dt) => {
                if (!dt) return null;
                const files = Array.from(dt.files || []);
                let file = files.find(f => f && f.type === 'image/png');
                if (!file) file = files.find(f => f && f.type && f.type.startsWith('image/'));
                if (!file) file = files.find(f => f && f.name && /\.png$/i.test(f.name));
                if (!file) file = files.find(f => f && f.name && /\.ora$/i.test(f.name));
                if (!file && dt.items) {
                    for (const item of dt.items) {
                        if (item.kind !== 'file') continue;
                        const f = item.getAsFile();
                        if (!f) continue;
                        if (f.type === 'image/png' || (f.type && f.type.startsWith('image/')) || /\.png$/i.test(f.name) || /\.ora$/i.test(f.name)) {
                            file = f;
                            if (f.type === 'image/png' || /\.png$/i.test(f.name) || /\.ora$/i.test(f.name)) break;
                        }
                    }
                }
                return file;
            };
            let dropDepth = 0;
            this.ui.stage.addEventListener('dragover', (e) => {
                const hasFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
                if (!hasFiles) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
            });
            this.ui.stage.addEventListener('dragenter', (e) => {
                const hasFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
                if (!hasFiles) return;
                dropDepth += 1;
                this.ui.stage.classList.add('drop-highlight');
            });
            this.ui.stage.addEventListener('dragleave', (e) => {
                const hasFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
                if (!hasFiles) return;
                dropDepth = Math.max(0, dropDepth - 1);
                if (dropDepth === 0) this.ui.stage.classList.remove('drop-highlight');
            });
            this.ui.stage.addEventListener('drop', (e) => {
                e.preventDefault();
                dropDepth = 0;
                this.ui.stage.classList.remove('drop-highlight');
                const file = pickDroppedImage(e.dataTransfer);
                if (!file) return;
                if (/\.ora$/i.test(file.name)) { this.loadORAFile(file); }
                /* A project asset is open, so a dropped picture is art *for that
                   slot*. Opening it as its own document instead would discard the
                   destination, which is the one thing an import cannot re-derive. */
                else if (this.state.projectImage && this.state.projectFile) {
                    this.importIntoProjectSlot(file);
                }
                else { this.handleFile(file, false); }
            });
            window.addEventListener('dragover', (e) => {
                const hasFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
                if (!hasFiles) return;
                e.preventDefault();
            });
            window.addEventListener('drop', (e) => {
                const hasFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
                if (!hasFiles) return;
                e.preventDefault();
                dropDepth = 0;
                this.ui.stage.classList.remove('drop-highlight');
            });

            window.addEventListener('click', e => {
                if (this.state.selectionIgnoreNextClick) {
                    if ((this.state.selectionIgnoreClickUntil || 0) > Date.now()) {
                        this.state.selectionIgnoreNextClick = false;
                        return;
                    }
                    this.state.selectionIgnoreNextClick = false;
                }
                if (this.state.selection) {
                    if ((this.state.selectionIgnoreClickUntil || 0) > Date.now()) {
                        return;
                    }
                    if (this.state.selectionJustCreated) {
                        this.state.selectionJustCreated = false;
                        return;
                    }
                    const inCanvas = e.target.closest('#canvas-stage') || e.target.closest('#selection-controls');
                    const inUi = e.target.closest('#ribbon') || e.target.closest('.tab-row') || e.target.closest('#title-bar') || e.target.closest('.dropdown-menu') || e.target.closest('.modal-mask') || e.target.closest('#lsys-panel') || e.target.closest('#lsys-ctx');
                    if (!inCanvas && !inUi) this.commitSelection();
                }
                if(!e.target.closest('.dropdown-menu') && !e.target.closest('.tab') && !e.target.closest('.split-btn-bottom')) document.querySelectorAll('.dropdown-menu').forEach(m=>m.style.display='none');
            });

            this.ui.viewport.addEventListener('scroll', () => {
                this.clampViewportScroll();
                this.requestGlobalOverlayUpdate();
                this.requestBoundsUpdate();
                this.requestGridOverlayUpdate();
            });
            this.ui.viewport.addEventListener('transitionend', (e) => {
                if (e.propertyName === 'padding-left') {
                    this.updateBounds();
                    this.requestGlobalOverlayUpdate();
                }
            });
            this.initThemeSelectMode();
            this.initColorCustomizer();
            this.initThemeMode();
            this.deferHeavyInit();
            this.setTool(this.config.tool);
            this.updateModeButtons();
            this.initModalInteractions();
            document.getElementById('sidebar-close-btn')?.addEventListener('click', () => {
                if (this._activeSidebarModalId) this._closeUnifiedSidebar(true);
            });
            document.getElementById('sidebar-float-btn')?.addEventListener('click', () => {
                if (this._activeSidebarModalId) {
                    this._floatCurrentModal();
                }
            });
            document.querySelector('#unified-sidebar .sidebar-modes')?.addEventListener('click', (e) => {
                const btn = e.target.closest('button');
                if (!btn) return;
                const id = btn.dataset.modal;
                if (!id) return;
                this._trackFloated();
                if (this._activeSidebarModalId === id) return;
                // Skip hidden tabs — panels not in Docked Sidebar mode
                if (this._loadSidebarUIMode(id) !== 'sidebar') return;
                if (this._activeSidebarModalId) this._closeUnifiedSidebar(true);
                if (id === 'huesat') this.openHueSat();
                this._openUnifiedSidebar(id);
            });
            this._updateSidebarTabVisibility();
            this.initRibbonCustomization();
            this.initTabScrollSwitch();
            this.initSaveReminder();
            this.initGridlines();
            this.initTileMode();
            this.initHistoryLimitControls();
            this._applyMemoryBudget();
            this.initTitleBarControls();
            this.bindFreehandSettings();
            // Mark app as ready — fades out the startup loading bar
            document.body.classList.add('app-ready');
            this.revealStartupWindow();
            Promise.resolve(this.initTauriFileOpenListener());
            this.setActiveTab('home');
            /* One frame for the initial layout pass, one for the centring that
               rides on it — after that the canvas has stopped moving on its own,
               so the handles can be pinned to it and allowed to animate again. */
            requestAnimationFrame(() => requestAnimationFrame(() => {
                this._startupSettled = true;
                this.updateBounds();
                this.drainPendingPaste();
            }));
        }

        /* Replay a paste that arrived while the engine was still starting up,
           captured by the catcher in index.html's <head>. Called once startup
           has settled, because handleFile() paints into a document that only
           exists by the end of init(). */
        deferHeavyInit() {
            const run = () => {
                this.initWebGL();
                this.initWebGLBrush();
                this.initQuantizeWorker();
                this.initHotkeys();
                this.initWinColorDialog();
                this.initHueSat();
                // Pre-compile the clean-edge rotation WebGL2 shaders so the first
                // interactive rotation has no GPU driver compile stall.
                this.initCleanEdgeRotateGL();
            };
            if (window.requestIdleCallback) {
                requestIdleCallback(run, { timeout: 750 });
            } else {
                setTimeout(run, 0);
            }
        }

        updateBounds() {
            this.bounds = this.ui.stage.getBoundingClientRect();
            // Cache the viewport rect here too — it only changes on window resize,
            // same as bounds. This avoids a forced layout on every selection render frame.
            this.vpBounds = this.ui.viewport ? this.ui.viewport.getBoundingClientRect() : null;
            this.updateCanvasResizeHandles();
            this.refreshSelectionUiFromState();
        }
        setActiveTab(tab) {
            const home = document.getElementById('tab-home');
            const hot = document.getElementById('tab-hotkeys');
            const view = document.getElementById('tab-view');
            const themes = document.getElementById('tab-themes');
            const debug = document.getElementById('tab-debug');
            const homeRibbon = document.getElementById('ribbon');
            const viewRibbon = document.getElementById('ribbon-view');
            const themesRibbon = document.getElementById('ribbon-themes');
            const debugRibbon = document.getElementById('ribbon-debug');
            if (tab === 'hotkeys') {
                this.openHotkeys();
                return;
            }
            if (tab === 'view') {
                if (hot) hot.classList.remove('active');
                if (home) home.classList.remove('active');
                if (themes) themes.classList.remove('active');
                if (debug) debug.classList.remove('active');
                if (view) view.classList.add('active');
                if (homeRibbon) homeRibbon.style.display = 'none';
                if (viewRibbon) viewRibbon.style.display = '';
                if (themesRibbon) themesRibbon.style.display = 'none';
                if (debugRibbon) debugRibbon.style.display = 'none';
                this.closeHotkeys(true);
                return;
            }
            if (tab === 'themes') {
                if (hot) hot.classList.remove('active');
                if (home) home.classList.remove('active');
                if (view) view.classList.remove('active');
                if (debug) debug.classList.remove('active');
                if (themes) themes.classList.add('active');
                if (homeRibbon) homeRibbon.style.display = 'none';
                if (viewRibbon) viewRibbon.style.display = 'none';
                if (themesRibbon) themesRibbon.style.display = '';
                if (debugRibbon) debugRibbon.style.display = 'none';
                this.closeHotkeys(true);
                return;
            }
            if (tab === 'debug') {
                if (hot) hot.classList.remove('active');
                if (home) home.classList.remove('active');
                if (view) view.classList.remove('active');
                if (themes) themes.classList.remove('active');
                if (debug) debug.classList.add('active');
                if (homeRibbon) homeRibbon.style.display = 'none';
                if (viewRibbon) viewRibbon.style.display = 'none';
                if (themesRibbon) themesRibbon.style.display = 'none';
                if (debugRibbon) debugRibbon.style.display = '';
                this.closeHotkeys(true);
                return;
            }
            if (hot) hot.classList.remove('active');
            if (view) view.classList.remove('active');
            if (themes) themes.classList.remove('active');
            if (debug) debug.classList.remove('active');
            if (home) home.classList.add('active');
            if (homeRibbon) homeRibbon.style.display = '';
            if (viewRibbon) viewRibbon.style.display = 'none';
            if (themesRibbon) themesRibbon.style.display = 'none';
            if (debugRibbon) debugRibbon.style.display = 'none';
            this.closeHotkeys(true);
        }
        updateToolHoverTitles() {
            const defs = [
                { selector: '[data-tool="pencil"]', actionId: 'tool.pencil', extra: 'Right-click: switch pencil mode' },
                { selector: '[data-tool="fill"]', actionId: 'tool.fill' },
                { selector: '#wand-tool-btn', actionId: 'tool.wand', extra: 'Right-click: switch wand mode' },
                { selector: '[data-tool="eraser"]', actionId: 'tool.eraser' },
                { selector: '[data-tool="picker"]', actionId: 'tool.picker' },
                { selector: '[data-tool="zoom"]', actionId: 'tool.zoom' },
                { selector: '[data-tool="line"]', actionId: 'tool.line' },
                { selector: '[data-tool="curve"]', actionId: 'tool.curve' },
                { selector: '[data-tool="poly"]', actionId: 'tool.poly' },
                { selector: '[data-tool="path"]', actionId: 'tool.path' },
                { selector: '[data-tool="rect"]', actionId: 'tool.rect' },
                { selector: '[data-tool="circle"]', actionId: 'tool.circle' },
                { selector: '[data-tool="tri"]', actionId: 'tool.tri' },
                { selector: '#select-tool-main-btn', actionId: 'tool.select' }
            ];
            defs.forEach((def) => {
                const el = document.querySelector(def.selector);
                if (!el) return;
                const existing = el.getAttribute('title') || '';
                const baseTitle = el.dataset.baseTitle || existing;
                if (!el.dataset.baseTitle && baseTitle) el.dataset.baseTitle = baseTitle;
                const shortcut = this.getHotkeyTooltip(def.actionId);
                let title = baseTitle || '';
                if (shortcut) title += ` (${shortcut})`;
                if (def.extra) title += `\n${def.extra}`;
                if (title) el.setAttribute('title', title);
            });
        }
        initSaveReminder() {
            const minsInput = document.getElementById('save-reminder-mins');
            const toggle = document.getElementById('save-reminder-toggle');
            const savedEnabled = this.lsGet('paint.saveReminder.enabled');
            const savedMins = parseInt(this.lsGet('paint.saveReminder.mins') || '', 10);
            if (savedEnabled !== null) this.saveReminderEnabled = savedEnabled === 'true';
            if (Number.isFinite(savedMins) && savedMins >= 1) this.saveReminderMinutes = savedMins;
            if (minsInput) {
                minsInput.value = this.saveReminderMinutes;
                minsInput.addEventListener('change', () => this.setSaveReminderMinutes(minsInput.value));
            }
            if (toggle) {
                toggle.checked = this.saveReminderEnabled;
                toggle.addEventListener('change', () => this.setSaveReminderEnabled(toggle.checked));
            }
            this.setSaveReminderEnabled(this.saveReminderEnabled);
        }
        setSaveReminderMinutes(value) {
            let mins = parseInt(value, 10);
            if (!Number.isFinite(mins)) mins = this.saveReminderMinutes;
            if (mins < 1) mins = 1;
            this.saveReminderMinutes = mins;
            this.lsSet('paint.saveReminder.mins', String(mins));
            const minsInput = document.getElementById('save-reminder-mins');
            if (minsInput) minsInput.value = mins;
            this.applySaveReminderTimer();
        }
        setSaveReminderEnabled(enabled) {
            this.saveReminderEnabled = !!enabled;
            this.lsSet('paint.saveReminder.enabled', String(this.saveReminderEnabled));
            const minsInput = document.getElementById('save-reminder-mins');
            if (minsInput) minsInput.disabled = !this.saveReminderEnabled;
            this.applySaveReminderTimer();
        }
        applySaveReminderTimer() {
            if (this.saveReminderTimer) {
                clearInterval(this.saveReminderTimer);
                this.saveReminderTimer = null;
            }
            if (this.saveReminderTick) {
                clearInterval(this.saveReminderTick);
                this.saveReminderTick = null;
            }
            this.saveReminderNextAt = 0;
            if (!this.saveReminderEnabled) return;
            const intervalMs = Math.max(1, this.saveReminderMinutes) * 60 * 1000;
            this.saveReminderNextAt = Date.now() + intervalMs;
            this.saveReminderTimer = setInterval(() => this.triggerSaveReminder(), intervalMs);
            this.saveReminderTick = setInterval(() => this.updateSaveReminderCountdown(), 1000);
            this.updateSaveReminderCountdown();
        }
        triggerSaveReminder() {
            this.showSaveReminder('Reminder: save your work.');
            const intervalMs = Math.max(1, this.saveReminderMinutes) * 60 * 1000;
            this.saveReminderNextAt = Date.now() + intervalMs;
            this.updateSaveReminderCountdown();
        }
        showSaveReminder(message) {
            if (!this.ui.statusReminder) return;
            this.ui.statusReminder.textContent = message;
            this.queueSaveReminderModal();
            if (this._saveReminderFlash) clearTimeout(this._saveReminderFlash);
            this._saveReminderFlash = setTimeout(() => {
                this.updateSaveReminderCountdown();
            }, 5000);
        }
        getSaveReminderFilename() {
            const handle = this.state.fileHandle;
            if (handle && handle.name) return handle.name;
            if (this.state.fileName) return this.state.fileName;
            return 'untitled.png';
        }
        dismissSaveReminder() {
            if (!this.ui.saveReminderModal) return;
            this._saveReminderActive = false;
            this.ui.saveReminderModal.style.display = 'none';
        }
        setupCloseConfirmKeyNav() {
            const modal = this.ui.closeConfirmModal;
            if (!modal) return;
            this.teardownCloseConfirmKeyNav();
            this._closeConfirmKeydown = (e) => {
                if (!modal || modal.style.display !== 'flex') return;
                const buttons = Array.from(modal.querySelectorAll('.btn-row button'));
                if (!buttons.length) return;
                const key = e.key;
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key)) return;
                const active = document.activeElement;
                const current = buttons.indexOf(active);
                let next = current >= 0 ? current : 0;
                if (key === 'ArrowRight' || key === 'ArrowDown') next = (next + 1) % buttons.length;
                if (key === 'ArrowLeft' || key === 'ArrowUp') next = (next - 1 + buttons.length) % buttons.length;
                if (key === 'Home') next = 0;
                if (key === 'End') next = buttons.length - 1;
                e.preventDefault();
                e.stopPropagation();
                buttons[next].focus();
            };
            window.addEventListener('keydown', this._closeConfirmKeydown, true);
        }
        teardownCloseConfirmKeyNav() {
            if (!this._closeConfirmKeydown) return;
            window.removeEventListener('keydown', this._closeConfirmKeydown, true);
            this._closeConfirmKeydown = null;
        }
        showCloseConfirm() {
            this._pendingOpenAction = null;
            const modal = this.ui.closeConfirmModal;
            if (!modal) return;
            const label = document.getElementById('close-confirm-filename');
            if (label) label.textContent = this.getCurrentFilename();
            const ctx = document.getElementById('close-confirm-context');
            if (ctx) ctx.textContent = ' before closing';
            modal.style.display = 'flex';
            this.centerModal('close-confirm-modal');
            this.setupCloseConfirmKeyNav();
            const saveBtn = modal.querySelector('.btn-row .btn-primary');
            if (saveBtn) requestAnimationFrame(() => saveBtn.focus());
        }
        dismissCloseConfirm() {
            const modal = this.ui.closeConfirmModal;
            if (!modal) return;
            this.teardownCloseConfirmKeyNav();
            modal.style.display = 'none';
            this._pendingOpenAction = null;
            this.isForceClosing = false;
        }
        async confirmCloseSave() {
            const pendingAction = this._pendingOpenAction;
            this.dismissCloseConfirm();
            if (pendingAction) {
                try {
                    await this.saveFile();
                    await pendingAction();
                } catch (e) {}
                return;
            }
            try {
                await this.saveFile();
                if (this._unlistenCloseEvent) {
                    this._unlistenCloseEvent();
                    this._unlistenCloseEvent = null;
                }
                this.isForceClosing = true;
                this.forceCloseWindow();
            } catch (e) {
                // Save canceled or failed; keep the app open.
            }
        }
        confirmCloseDiscard() {
            const pendingAction = this._pendingOpenAction;
            this.dismissCloseConfirm();
            if (pendingAction) {
                this.state.isDirty = false;
                pendingAction();
                return;
            }
            if (this._unlistenCloseEvent) {
                this._unlistenCloseEvent();
                this._unlistenCloseEvent = null;
            }
            this.isForceClosing = true;
            this.forceCloseWindow();
        }
        showOpenConfirm(action, context) {
            this._pendingOpenAction = action;
            const modal = this.ui.closeConfirmModal;
            if (!modal) return;
            const label = document.getElementById('close-confirm-filename');
            if (label) label.textContent = this.getCurrentFilename();
            const ctx = document.getElementById('close-confirm-context');
            if (ctx) ctx.textContent = context || ' opening a new file';
            modal.style.display = 'flex';
            this.centerModal('close-confirm-modal');
            this.setupCloseConfirmKeyNav();
            const saveBtn = modal.querySelector('.btn-row .btn-primary');
            if (saveBtn) requestAnimationFrame(() => saveBtn.focus());
        }
        openMiscTab() {
            this.setActiveTab('view');
        }
        parseSemver(input) {
            const raw = String(input || '').trim();
            if (!raw) return null;
            const cleaned = raw.replace(/^v/i, '').split('+')[0];
            const main = cleaned.split('-')[0];
            const parts = main.split('.').map(p => parseInt(p, 10));
            if (parts.length < 1 || parts.some(n => !Number.isFinite(n))) return null;
            const [maj, min = 0, pat = 0] = parts;
            return { maj, min, pat };
        }
        isSemverGreater(a, b) {
            const va = this.parseSemver(a);
            const vb = this.parseSemver(b);
            if (!va || !vb) return null;
            if (va.maj !== vb.maj) return va.maj > vb.maj;
            if (va.min !== vb.min) return va.min > vb.min;
            if (va.pat !== vb.pat) return va.pat > vb.pat;
            return false;
        }
        async openLatestReleasePage() {
            const rel = this._latestGithubRelease;
            const url = rel && rel.html_url ? String(rel.html_url) : '';
            if (!url) return;
            try {
                await this.tauriInvoke('plugin:opener|open_url', { url });
            } catch (e) {
                // Fallback: only open known-good URLs
                if (url.startsWith('https://github.com/FrCynda/CDPaint/releases/')) {
                    window.open(url, '_blank');
                }
            }
        }
        async checkForUpdates() {
            const status = document.getElementById('update-status');
            const progress = document.getElementById('update-progress');
            const cur = document.getElementById('update-current-ver');
            const latest = document.getElementById('update-latest-ver');
            const notes = document.getElementById('update-notes');
            const btnInstall = document.getElementById('btn-update-install');
            const btnOpen = document.getElementById('btn-update-open-release');
            const btnCheck = document.getElementById('btn-update-check');

            if (status) {
                status.classList.remove('is-available', 'is-ok', 'is-warn', 'is-error');
                status.classList.add('is-checking');
                status.textContent = 'Checking for updates...';
            }
            if (progress) progress.style.display = '';
            if (btnInstall) btnInstall.disabled = true;
            if (btnCheck) btnCheck.disabled = true;

            try {
                let currentVersion = '';
                try {
                    currentVersion = await this.tauriInvoke('get_app_version');
                } catch (e) {
                    currentVersion = '';
                }
                if (cur) cur.textContent = currentVersion || '-';

                let gh = null;
                try {
                    const resp = await fetch('https://api.github.com/repos/FrCynda/CDPaint/releases/latest', {
                        headers: { 'Accept': 'application/vnd.github+json' }
                    });
                    if (resp.ok) gh = await resp.json();
                } catch (e) {
                    gh = null;
                }
                this._latestGithubRelease = gh;

                const ghTag = gh && gh.tag_name ? String(gh.tag_name) : '';
                const ghBody = gh && typeof gh.body === 'string' ? gh.body : '';
                if (latest) latest.textContent = ghTag || '-';
                if (notes && ghBody) notes.innerHTML = this.renderUpdateNotesMarkdown(ghBody);
                if (btnOpen) btnOpen.style.display = gh && gh.html_url ? '' : 'none';

                let manifest = null;
                let manifestError = null;
                try {
                    manifest = await this.tauriInvoke('updater_check');
                } catch (e) {
                    manifestError = this.getErrorText(e);
                    manifest = null;
                }
                this._latestUpdaterManifest = manifest;

                if (manifest && manifest.available) {
                    if (btnInstall) {
                        btnInstall.disabled = false;
                        btnInstall.textContent = `Update to ${manifest.version || 'latest'}`;
                    }
                    if (status) {
                        status.classList.remove('is-checking', 'is-ok', 'is-warn', 'is-error');
                        status.classList.add('is-available');
                        status.textContent = 'Update available.';
                    }
                    if (notes && manifest.notes) {
                        const ghText = (ghBody || '').trim();
                        if (!ghText) notes.innerHTML = this.renderUpdateNotesMarkdown(manifest.notes);
                    }
                    if (latest && manifest.version) latest.textContent = `v${manifest.version}`;
                    return;
                }

                const semverCompare = this.isSemverGreater(ghTag, currentVersion);
                if (semverCompare === true) {
                    if (status) {
                        status.classList.remove('is-checking', 'is-available', 'is-ok', 'is-error');
                        status.classList.add('is-warn');
                        status.textContent = 'A newer version is available on GitHub, but one-click update is not available for this build.';
                    }
                } else if (semverCompare === false) {
                    if (status) {
                        status.classList.remove('is-checking', 'is-available', 'is-warn', 'is-error');
                        status.classList.add('is-ok');
                        status.textContent = 'You are up to date.';
                    }
                } else {
                    if (status) {
                        status.classList.remove('is-checking', 'is-available', 'is-ok', 'is-warn');
                        status.classList.add('is-error');
                        status.textContent = manifestError ? `Update check unavailable: ${manifestError}` : 'Update check unavailable.';
                    }
                }
            } finally {
                if (progress) progress.style.display = 'none';
                if (btnCheck) btnCheck.disabled = false;
                if (status) status.classList.remove('is-checking');
            }
        }
        async installUpdate() {
            const status = document.getElementById('update-status');
            const progress = document.getElementById('update-progress');
            const btnInstall = document.getElementById('btn-update-install');
            const btnCheck = document.getElementById('btn-update-check');
            if (btnInstall) btnInstall.disabled = true;
            if (btnCheck) btnCheck.disabled = true;
            if (status) {
                status.classList.remove('is-available', 'is-ok', 'is-warn', 'is-error');
                status.classList.add('is-checking');
                status.textContent = 'Downloading update...';
            }
            if (progress) progress.style.display = '';
            try {
                const did = await this.tauriInvoke('updater_download_and_install');
                if (!did) {
                    if (status) {
                        status.classList.remove('is-checking', 'is-available', 'is-ok');
                        status.classList.add('is-error');
                        status.textContent = 'No update available.';
                    }
                    return;
                }
                if (status) {
                    status.classList.remove('is-checking', 'is-available', 'is-ok', 'is-error');
                    status.classList.add('is-ok');
                    status.textContent = 'Update started. The app may close while installing.';
                }
            } catch (e) {
                const msg = this.getErrorText(e);
                if (status) {
                    status.classList.remove('is-checking', 'is-available', 'is-ok');
                    status.classList.add('is-error');
                    status.textContent = `Update failed: ${msg}`;
                }
            } finally {
                if (progress) progress.style.display = 'none';
                if (btnCheck) btnCheck.disabled = false;
                // Re-enable only if modal is still open; safe default is to re-check.
                this.checkForUpdates();
            }
        }
        updateSaveReminderCountdown() {
            if (!this.ui.statusReminder) return;
            if (!this.saveReminderEnabled || !this.saveReminderNextAt) {
                this.ui.statusReminder.textContent = '';
                return;
            }
            const remaining = Math.max(0, this.saveReminderNextAt - Date.now());
            this.ui.statusReminder.textContent = `Next save reminder in ${this.formatReminderTime(remaining)}`;
        }
        formatReminderTime(ms) {
            const total = Math.ceil(ms / 1000);
            const hours = Math.floor(total / 3600);
            const mins = Math.floor((total % 3600) / 60);
            const secs = total % 60;
            if (hours > 0) {
                return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            }
            return `${mins}:${String(secs).padStart(2, '0')}`;
        }
        resetSaveReminderTimer() {
            if (!this.saveReminderEnabled) return;
            const intervalMs = Math.max(1, this.saveReminderMinutes) * 60 * 1000;
            this.saveReminderNextAt = Date.now() + intervalMs;
            this.updateSaveReminderCountdown();
        }

        initGridlines() {
            const savedSize = parseInt(this.lsGet('paint.gridlines.size') || '64', 10);
            const savedEnabled = this.lsGet('paint.gridlines.enabled') === 'true';
            const savedColor = this.lsGet('paint.gridlines.color');
            if (Number.isFinite(savedSize) && savedSize >= 4) this.gridlinesSize = savedSize;
            this.gridlinesEnabled = savedEnabled;
            if (savedColor && /^#([0-9a-fA-F]{6})$/.test(savedColor)) this.gridlinesColor = savedColor;
            const sizeInput = document.getElementById('gridlines-size');
            const toggle = document.getElementById('gridlines-toggle');
            if (sizeInput) {
                sizeInput.value = this.gridlinesSize;
                sizeInput.addEventListener('change', () => this.setGridlinesSize(sizeInput.value));
            }
            if (toggle) {
                toggle.checked = this.gridlinesEnabled;
                toggle.addEventListener('change', () => this.setGridlinesEnabled(toggle.checked));
            }
            if (this.ui.gridlineColorSwatch) {
                this.ui.gridlineColorSwatch.style.backgroundColor = this.gridlinesColor;
            }
            this.updateGridOverlay();
        }
        setGridlinesSize(value) {
            let size = parseInt(value, 10);
            if (!Number.isFinite(size)) size = this.gridlinesSize;
            if (size < 4) size = 4;
            this.gridlinesSize = size;
            this.lsSet('paint.gridlines.size', String(size));
            const sizeInput = document.getElementById('gridlines-size');
            if (sizeInput) sizeInput.value = size;
            this.updateGridOverlay();
        }
        setGridlinesEnabled(enabled) {
            this.gridlinesEnabled = !!enabled;
            this.lsSet('paint.gridlines.enabled', this.gridlinesEnabled ? 'true' : 'false');
            this.updateGridOverlay();
        }
        setGridlineColor(hex) {
            if (!/^#([0-9a-fA-F]{6})$/.test(hex)) return;
            this.gridlinesColor = hex;
            this.lsSet('paint.gridlines.color', hex);
            if (this.ui.gridlineColorSwatch) {
                this.ui.gridlineColorSwatch.style.backgroundColor = hex;
            }
            this.updateGridOverlay();
        }
        openGridlineColorPicker() {
            this.gridlinesPickActive = true;
            this.openWinColor();
            this.updateWinFromHex(this.gridlinesColor);
        }
        initColorCustomizer() {
            this.colorStyleEl = document.getElementById('app-styles');
            if (!this.colorStyleEl) return;
            this.colorBaseCss = this.colorStyleEl.textContent || '';
            this.colorTokenRegex = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)|\b(?:transparent|white|black|gray|grey|red|green|blue|yellow|orange|purple|pink|cyan|magenta|brown|silver|gold|teal|navy|maroon|olive|lime|aqua|fuchsia)\b/gi;
            this.colorVarTokens = this.extractColorVariableTokens(this.colorBaseCss);
            this.normalizeSelectIconThemeBindings();
            this.normalizeSaveIconThemeBindings();
            this.colorAttrTargets = [];
            const attrNames = ['style', 'fill', 'stroke', 'stop-color'];
            const nodes = document.querySelectorAll('[style], [fill], [stroke], [stop-color]');
            nodes.forEach(el => {
                const entry = { el, attrs: {}, excludeTheme: this.isThemeColorElementExcluded(el) };
                attrNames.forEach(attr => {
                    if (!el.hasAttribute(attr)) return;
                    const dataKey = 'colorDefault' + attr.replace('-', '');
                    if (!el.dataset[dataKey]) el.dataset[dataKey] = el.getAttribute(attr);
                    entry.attrs[attr] = el.dataset[dataKey];
                });
                this.colorAttrTargets.push(entry);
            });
            this.colorElementTokens = this.buildElementColorTokens();
            this.colorDefaults = this.collectUniqueColors();
            this.colorExamples = this.buildColorExamples();
            const sensitive = this.collectSensitiveColorKeys();
            this.colorSensitiveKeys = sensitive.sensitive;
            this.colorIconBackgroundKeys = sensitive.iconBackground;
            this.fileTabEl = document.querySelector('.tab.file');
            if (this.fileTabEl) {
                const cs = getComputedStyle(this.fileTabEl);
                this.fileTabDefault = {
                    bg: this.normalizeColor(cs.backgroundColor),
                    color: this.normalizeColor(cs.color)
                };
            }
            this.fileTabPresetColor = null;
            this.colorOverrides = this.loadColorOverrides();
            this.customColorPresets = this.loadCustomColorPresets();
            this.applyColorOverrides();
            this.initThemeSelectMode();
            this.updateThemeSelectUi();
        }
        buildElementColorTokens() {
            const tokenMap = new Map();
            if (!Array.isArray(this.colorAttrTargets)) return tokenMap;
            this.colorAttrTargets.forEach(entry => {
                if (!entry || !entry.el || !entry.attrs) return;
                if (entry.excludeTheme) return;
                const elementRef = this.getThemeColorElementRef(entry.el);
                Object.entries(entry.attrs).forEach(([attr, value]) => {
                    const colors = this.extractColorsFromText(value);
                    if (!colors || !colors.length) return;
                    const seenPerNorm = new Map();
                    colors.forEach((token, colorIndex) => {
                        const normalized = this.normalizeColor(token);
                        if (!normalized) return;
                        const occurrence = seenPerNorm.get(normalized) || 0;
                        seenPerNorm.set(normalized, occurrence + 1);
                        const key = `attrel(${elementRef}|${attr}|${normalized}|${occurrence})`;
                        if (!tokenMap.has(key)) {
                            tokenMap.set(key, {
                                key,
                                elementRef,
                                attr,
                                normalized,
                                occurrence,
                                defaultDisplay: this.formatColorDisplay(normalized),
                                label: `${elementRef} ${attr} [${occurrence + 1}]`,
                                targets: []
                            });
                        }
                        tokenMap.get(key).targets.push({
                            el: entry.el,
                            attr,
                            defaultRaw: value,
                            normalized,
                            occurrence,
                            order: colorIndex
                        });
                    });
                });
            });
            return tokenMap;
        }
        setTestMode(on) {
            this.testMode = !!on;
            this.lsSet('paint.testMode', this.testMode ? 'true' : 'false');
            // Mutual exclusivity: turn off other themes when enabling this one
            if (on) {
                if (this.darkRefinedMode) { this.darkRefinedMode = false; this.lsSet('paint.darkRefinedMode', 'false'); this.applyDarkRefinedMode(false); }
                const CUSTOM_THEMES = ['primeval-forest-mode','abyssal-ocean-mode','crimson-dusk-mode','gilded-obsidian-mode','violet-haze-mode'];
                const wasCustom = CUSTOM_THEMES.some(c => document.body.classList.contains(c));
                if (this.themeMode === 'dark' || wasCustom) { this.setThemeMode('light', { save: true }); }
            }
            this.applyTestMode(this.testMode);
        }
        applyTestMode(on) {
            document.body.classList.toggle('test-mode', !!on);
            const btn = document.getElementById('test-mode-btn');
            if (btn) btn.classList.toggle('is-on', !!on);
            const label = document.getElementById('test-mode-status');
            if (label) label.textContent = on ? 'On' : 'Off';
            // Apply chrome styles for the tab row / titlebar
            const chrome = this.themeChrome;
            if (!chrome) return;
            const CUSTOM_THEMES_TM = ['primeval-forest-mode','abyssal-ocean-mode','crimson-dusk-mode','gilded-obsidian-mode','violet-haze-mode'];
            const isCustomTM = CUSTOM_THEMES_TM.some(c => document.body.classList.contains(c));
            if (chrome.titleBar) {
                chrome.titleBar.style.backgroundColor = on ? '#1c1c1c' : (isCustomTM ? '' : (this.themeMode === 'dark' ? '#1b1b1d' : ''));
                chrome.titleBar.style.color = on ? '#e8e8e8' : (isCustomTM ? '' : (this.themeMode === 'dark' ? '#f2f2f2' : ''));
            }
            if (chrome.tabRow) {
                chrome.tabRow.style.backgroundColor = on ? '#1c1c1c' : (isCustomTM ? '' : (this.themeMode === 'dark' ? '#1f1f22' : ''));
                chrome.tabRow.style.borderBottomColor = on ? '#484848' : (isCustomTM ? '' : (this.themeMode === 'dark' ? '#2a2a2d' : ''));
                chrome.tabRow.style.color = on ? '#e8e8e8' : (isCustomTM ? '' : (this.themeMode === 'dark' ? '#f2f2f2' : ''));
            }
            if (chrome.tabArrows && chrome.tabArrows.length) {
                chrome.tabArrows.forEach(arrow => {
                    arrow.style.color = on ? '#e8e8e8' : (isCustomTM ? '' : (this.themeMode === 'dark' ? '#f2f2f2' : ''));
                });
            }
        }
        setDarkRefinedMode(on) {
            this.darkRefinedMode = !!on;
            this.lsSet('paint.darkRefinedMode', this.darkRefinedMode ? 'true' : 'false');
            // Mutual exclusivity: turn off other themes when enabling this one
            if (on) {
                if (this.testMode) { this.testMode = false; this.lsSet('paint.testMode', 'false'); this.applyTestMode(false); }
                const CUSTOM_THEMES = ['primeval-forest-mode','abyssal-ocean-mode','crimson-dusk-mode','gilded-obsidian-mode','violet-haze-mode'];
                const wasCustom = CUSTOM_THEMES.some(c => document.body.classList.contains(c));
                if (this.themeMode === 'dark' || wasCustom) { this.setThemeMode('light', { save: true }); }
            }
            this.applyDarkRefinedMode(this.darkRefinedMode);
        }
        applyDarkRefinedMode(on) {
            document.body.classList.toggle('dark-refined-mode', !!on);
            const btn = document.getElementById('dark-refined-btn');
            if (btn) btn.classList.toggle('is-on', !!on);
            const label = document.getElementById('dark-refined-status');
            if (label) label.textContent = on ? 'On' : 'Off';
            // Apply chrome styles for the tab row / titlebar
            const chrome = this.themeChrome;
            if (!chrome) return;
            const CUSTOM_THEMES_DR = ['primeval-forest-mode','abyssal-ocean-mode','crimson-dusk-mode','gilded-obsidian-mode','violet-haze-mode'];
            const isCustomDR = CUSTOM_THEMES_DR.some(c => document.body.classList.contains(c));
            if (chrome.titleBar) {
                chrome.titleBar.style.backgroundColor = on ? '#1F1F22' : (isCustomDR ? '' : (this.themeMode === 'dark' ? '#1b1b1d' : ''));
                chrome.titleBar.style.color = on ? '#EAEAEA' : (isCustomDR ? '' : (this.themeMode === 'dark' ? '#f2f2f2' : ''));
            }
            if (chrome.tabRow) {
                chrome.tabRow.style.backgroundColor = on ? '#43434A' : (isCustomDR ? '' : (this.themeMode === 'dark' ? '#1f1f22' : ''));
                chrome.tabRow.style.borderBottomColor = on ? '#6A6A75' : (isCustomDR ? '' : (this.themeMode === 'dark' ? '#2a2a2d' : ''));
                chrome.tabRow.style.color = on ? '#EAEAEA' : (isCustomDR ? '' : (this.themeMode === 'dark' ? '#f2f2f2' : ''));
            }
            if (chrome.tabArrows && chrome.tabArrows.length) {
                chrome.tabArrows.forEach(arrow => {
                    arrow.style.color = on ? '#EAEAEA' : (isCustomDR ? '' : (this.themeMode === 'dark' ? '#f2f2f2' : ''));
                });
            }
        }
        initTitleBarControls() {
            const minBtn = document.getElementById('title-minimize');
            const maxBtn = document.getElementById('title-maximize');
            const closeBtn = document.getElementById('title-close');
            const saveBtn = document.getElementById('title-save');
            const undoBtn = document.getElementById('title-undo');
            const redoBtn = document.getElementById('title-redo');
            if (minBtn) minBtn.addEventListener('click', () => this.titleBarMinimize());
            if (maxBtn) maxBtn.addEventListener('click', () => this.titleBarToggleMaximize());
            if (closeBtn) closeBtn.addEventListener('click', () => this.titleBarClose());
            if (saveBtn) saveBtn.addEventListener('click', () => this.saveFile());
            if (undoBtn) undoBtn.addEventListener('click', () => this.undo());
            if (redoBtn) redoBtn.addEventListener('click', () => this.redo());
            this.updateTitleBarActions();
            this.updateTitleBarMaximizeIcon();
        }
        revealStartupWindow(attempt = 0) {
            if (this._startupWindowRevealed) return;
            const tauri = window.__TAURI__;
            const canInvokeShow = !!this.getTauriInvokeFn();
            const win = this.getTauriWindow();
            const canWindowShow = !!(win && typeof win.show === 'function');
            if (!canInvokeShow && !canWindowShow) {
                // Browser/web demo path: no native window to reveal.
                return;
            }
            const tryAgain = () => {
                if (attempt < 20) {
                    setTimeout(() => this.revealStartupWindow(attempt + 1), 50);
                }
            };
            const doShow = canInvokeShow
                ? this.tauriInvoke('show_current_window')
                : win.show();
            this._startupWindowRevealed = true;
            Promise.resolve(doShow).catch((err) => {
                this._startupWindowRevealed = false;
                tryAgain();
                if (attempt >= 20) console.log('Failed to reveal startup window', err);
            });
        }
        async initCloseListener() {
            const win = this.getTauriWindow();
            if (!win || !win.onCloseRequested) {
                setTimeout(() => this.initCloseListener(), 200);
                return;
            }
            if (this._closeListenerInstalling) return;
            this._closeListenerInstalling = true;
            if (this._unlistenCloseEvent) {
                this._unlistenCloseEvent();
                this._unlistenCloseEvent = null;
            }
            this._unlistenCloseEvent = await win.onCloseRequested((event) => {
                if (this.isForceClosing) return;
                if (!this.hasUnsavedChanges()) {
                    event.preventDefault();
                    this.prepareForceClose();
                    return;
                }
                event.preventDefault();
                this.showCloseConfirm();
            });
            this._closeListenerInstalling = false;
        }

        updateTitleBarActions() {
            // Every path that changes history already calls this, so it is the
            // one place the usage readout needs hooking to.
            this.scheduleHistoryUsage();
            const undoBtn = document.getElementById('title-undo');
            const redoBtn = document.getElementById('title-redo');
            const canUndo = this.canUndo();
            const canRedo = this.canRedo();
            if (undoBtn) {
                undoBtn.disabled = !canUndo;
                undoBtn.classList.toggle('is-enabled', canUndo);
                const img = undoBtn.querySelector('img');
                if (img) img.src = canUndo ? (img.dataset.enabledSrc || img.src) : (img.dataset.disabledSrc || img.src);
            }
            if (redoBtn) {
                redoBtn.disabled = !canRedo;
                redoBtn.classList.toggle('is-enabled', canRedo);
                const img = redoBtn.querySelector('img');
                if (img) img.src = canRedo ? (img.dataset.enabledSrc || img.src) : (img.dataset.disabledSrc || img.src);
            }
        }
        async updateTitleBarMaximizeIcon() {
            const maxBtn = document.getElementById('title-maximize');
            if (!maxBtn) return;
            const win = this.getTauriWindow();
            if (!win || !win.isMaximized) {
                maxBtn.classList.remove('is-maximized');
                return;
            }
            try {
                const isMax = await win.isMaximized();
                maxBtn.classList.toggle('is-maximized', !!isMax);
            } catch (e) {
                maxBtn.classList.remove('is-maximized');
            }
        }
        hasUnsavedChanges() {
            return !!this.state.isDirty;
        }
        markClean() {
            this.state.isDirty = false;
            this.updateTitleFilename();
        }
        getCurrentFilename() {
            const handle = this.state.fileHandle;
            if (handle && handle.name) return handle.name;
            if (this.state.fileName) return this.state.fileName;
            return 'untitled.png';
        }
        updateTitleFilename() {
            const label = document.getElementById('title-filename');
            if (label) label.textContent = this.getCurrentFilename();
        }
        getFilenameFromPath(path) {
            if (!path) return 'untitled.png';
            const parts = String(path).split(/[/\\]+/);
            return parts[parts.length - 1] || 'untitled.png';
        }
        formatNumber(n) {
            const value = Number(n);
            if (!Number.isFinite(value)) return 'n/a';
            return value.toLocaleString('en-US');
        }
        formatBytes(bytes) {
            const value = Number(bytes);
            if (!Number.isFinite(value) || value < 0) return 'n/a';
            const units = ['B', 'KB', 'MB', 'GB', 'TB'];
            let size = value;
            let idx = 0;
            while (size >= 1024 && idx < units.length - 1) {
                size /= 1024;
                idx++;
            }
            const digits = size >= 100 ? 0 : (size >= 10 ? 1 : 2);
            return `${size.toFixed(digits)} ${units[idx]}`;
        }
        escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }
        // Safe localStorage wrappers — silently no-op when storage is unavailable
        // (Safari private mode, Firefox dom.storage.enabled=false, quota exceeded).
        lsSet(key, value) {
            try { localStorage.setItem(key, value); } catch (e) { /* storage unavailable */ }
        }
        lsGet(key, fallback = null) {
            try { return localStorage.getItem(key); } catch (e) { return fallback; }
        }
        lsRemove(key) {
            try { localStorage.removeItem(key); } catch (e) { /* storage unavailable */ }
        }
        getPropsDepthLabel() {
            const cfg = this.getDepthConfig();
            if (cfg.mode === 'full') return '24-bit (True Color)';
            if (cfg.mode === 'rgb565') return '16-bit (RGB565)';
            if (cfg.mode === 'rgb555') return '15-bit (RGB555)';
            return `${this.bitDepth}-bit (${cfg.colors} colors indexed)`;
        }
        normalizeIncomingPath(path) {
            if (!path) return '';
            let normalizedPath = String(path);
            if (normalizedPath.startsWith('\\\\?\\UNC\\')) {
                normalizedPath = '\\\\' + normalizedPath.slice('\\\\?\\UNC\\'.length);
            } else if (normalizedPath.startsWith('\\\\?\\')) {
                normalizedPath = normalizedPath.slice('\\\\?\\'.length);
            }
            return normalizedPath;
        }
        isSupportedImagePath(path) {
            return /\.(png|jpe?g|bmp|gif|webp|ora)$/i.test(String(path || ''));
        }
        addRecentFile(entry) {
            if (!entry) return;
            const name = entry.name ? String(entry.name).trim() : '';
            if (!name) return;
            const path = entry.path ? String(entry.path) : '';
            const pathKey = path.toLowerCase();
            const nameKey = name.toLowerCase();
            const next = (this.state.recentFiles || []).filter((item) => {
                if (!item) return false;
                if (pathKey && item.path && String(item.path).toLowerCase() === pathKey) return false;
                if (!pathKey && String(item.name || '').toLowerCase() === nameKey) return false;
                return true;
            });
            next.unshift({ name, path, ts: Date.now() });
            this.state.recentFiles = next.slice(0, this.maxRecentFiles);
            this.saveRecentFiles();
            this.renderFileMenuRecentFiles();
        }
        markSaved(filename = null) {
            if (filename) this.state.fileName = filename;
            this.state.isDirty = false;
            this.updateTitleFilename();
        }
        async titleBarMinimize() {
            const win = this.getTauriWindow();
            if (win && win.minimize) {
                await win.minimize();
                return;
            }
            console.log('TitleBar: minimize (wire to Tauri window API)');
        }
        async toggleWindowFullscreen() {
            if (this.getTauriInvokeFn()) {
                await this.tauriInvoke('toggle_current_window_fullscreen');
                return true;
            }
            const win = this.getTauriWindow();
            if (win && win.toggleFullscreen) {
                await win.toggleFullscreen();
                return true;
            }
            if (win && win.isFullscreen && win.setFullscreen) {
                const isFull = await win.isFullscreen();
                await win.setFullscreen(!isFull);
                return true;
            }
            return false;
        }
        async titleBarToggleMaximize() {
            const win = this.getTauriWindow();
            if (win && win.toggleMaximize) {
                await win.toggleMaximize();
                await this.updateTitleBarMaximizeIcon();
                return;
            }
            if (win && win.isMaximized && win.maximize && win.unmaximize) {
                const isMax = await win.isMaximized();
                await (isMax ? win.unmaximize() : win.maximize());
                await this.updateTitleBarMaximizeIcon();
                return;
            }
            console.log('TitleBar: toggle maximize (wire to Tauri window API)');
        }
        async titleBarClose() {
            this.requestClose();
        }
        requestClose() {
            if (this.hasUnsavedChanges()) {
                this.showCloseConfirm();
                return;
            }
            this.prepareForceClose();
        }
        performCloseWindow() {
            const win = this.getTauriWindow();
            if (win && win.close) {
                win.close();
                return;
            }
            console.log('TitleBar: close (wire to Tauri window API)');
        }
        forceCloseWindow() {
            const win = this.getTauriWindow();
            if (!win) return;
            if (win.close) {
                win.close();
            }
            if (win.destroy) {
                setTimeout(() => {
                    try { win.destroy(); } catch (e) {}
                }, 200);
            }
        }
        prepareForceClose() {
            if (this._unlistenCloseEvent) {
                this._unlistenCloseEvent();
                this._unlistenCloseEvent = null;
            }
            this.isForceClosing = true;
            this.forceCloseWindow();
        }
        buildColorExamples() {
            const map = new Map();
            const addExample = (color, el, prop) => {
                const norm = this.normalizeColor(color);
                if (!norm || map.has(norm)) return;
                map.set(norm, { el, prop });
            };
            this.colorAttrTargets.forEach(entry => {
                if (!entry || entry.excludeTheme) return;
                Object.entries(entry.attrs).forEach(([attr, value]) => {
                    this.extractColorsFromText(value).forEach(token => addExample(token, entry.el, attr));
                });
            });
            const props = [
                { prop: 'backgroundColor', label: 'background' },
                { prop: 'color', label: 'text' },
                { prop: 'borderTopColor', label: 'border' },
                { prop: 'outlineColor', label: 'outline' }
            ];
            const elements = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
            elements.forEach(el => {
                if (this.isThemeColorElementExcluded(el)) return;
                const cs = getComputedStyle(el);
                props.forEach(({ prop }) => {
                    const value = cs[prop];
                    if (value) addExample(value, el, prop);
                });
                if (el.hasAttribute && (el.hasAttribute('fill') || el.hasAttribute('stroke'))) {
                    const fill = el.getAttribute('fill');
                    const stroke = el.getAttribute('stroke');
                    if (fill) addExample(fill, el, 'fill');
                    if (stroke) addExample(stroke, el, 'stroke');
                }
            });
            return map;
        }
        getElementLabel(el, prop) {
            if (!el) return null;
            const id = el.id ? `#${el.id}` : '';
            const cls = !id && el.classList && el.classList.length ? `.${el.classList[0]}` : '';
            const tag = el.tagName ? el.tagName.toLowerCase() : 'element';
            const base = id || cls ? `${tag}${id}${cls}` : tag;
            return prop ? `${base} (${prop})` : base;
        }
        highlightColorExample(el, prop) {
            if (!el) return;
            const isAttr = prop === 'fill' || prop === 'stroke';
            const map = this.colorPreviewState || new WeakMap();
            this.colorPreviewState = map;
            let perEl = map.get(el);
            if (!perEl) {
                perEl = {};
                map.set(el, perEl);
            }
            const key = prop || 'style';
            if (!perEl[key]) {
                perEl[key] = {
                    original: isAttr ? el.getAttribute(prop) : (el.style ? el.style[prop] : ''),
                    isAttr,
                    prop,
                    timer: null,
                    timeout: null
                };
            }
            const state = perEl[key];
            if (state.timer) {
                clearInterval(state.timer);
                state.timer = null;
            }
            if (state.timeout) {
                clearTimeout(state.timeout);
                state.timeout = null;
            }
            el.classList.add('color-preview-highlight');
            if (el.scrollIntoView) {
                el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
            }
            const randomBright = () => {
                const h = Math.floor(Math.random() * 360);
                const s = 90 + Math.floor(Math.random() * 10);
                const l = 55 + Math.floor(Math.random() * 15);
                return `hsl(${h}, ${s}%, ${l}%)`;
            };
            const applyColor = (value) => {
                if (state.isAttr) el.setAttribute(state.prop, value);
                else if (el.style) el.style[state.prop] = value;
            };
            applyColor(randomBright());
            state.timer = setInterval(() => {
                applyColor(randomBright());
            }, 200);
            state.timeout = setTimeout(() => {
                clearInterval(state.timer);
                state.timer = null;
                applyColor(state.original || '');
                delete perEl[key];
                const stillActive = Object.values(perEl).some(entry => entry && entry.timer);
                if (!stillActive) el.classList.remove('color-preview-highlight');
            }, 5000);
        }
        isWinColorOpen() {
            const modal = document.getElementById('modal-wincolor');
            return !!(modal && modal.style.display === 'flex');
        }
        colorStringToRgba(color) {
            if (!color) return null;
            const normalized = this.normalizeColor(color);
            if (!normalized) return null;
            const match = normalized.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
            if (!match) return null;
            return {
                r: Math.max(0, Math.min(255, parseInt(match[1], 10))),
                g: Math.max(0, Math.min(255, parseInt(match[2], 10))),
                b: Math.max(0, Math.min(255, parseInt(match[3], 10))),
                a: match[4] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(match[4])))
            };
        }
        focusColorCustomizerRow(key) {
            if (!this.colorCustomizerRows) return;
            const row = this.colorCustomizerRows.get(key);
            if (!row) return;
            if (row.root.style.display === 'none') {
                const search = document.getElementById('color-customizer-search');
                if (search) {
                    search.value = '';
                    this.applyColorSearchFilter('');
                }
            }
            if (this.themeSelectPickedRowKey && this.colorCustomizerRows.has(this.themeSelectPickedRowKey)) {
                const prev = this.colorCustomizerRows.get(this.themeSelectPickedRowKey);
                if (prev && prev.root) prev.root.classList.remove('is-picked');
            }
            if (this.themeSelectPickedRowTimer) {
                clearTimeout(this.themeSelectPickedRowTimer);
                this.themeSelectPickedRowTimer = null;
            }
            row.root.classList.add('is-picked');
            if (row.root.scrollIntoView) {
                row.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
            this.selectColorCustomizerKey(key, { keepScroll: true });
            this.themeSelectPickedRowKey = key;
            this.themeSelectPickedRowTimer = setTimeout(() => {
                if (row.root) row.root.classList.remove('is-picked');
                this.themeSelectPickedRowTimer = null;
            }, 1500);
        }
        openColorPickerForKey(key) {
            const row = this.colorCustomizerRows ? this.colorCustomizerRows.get(key) : null;
            if (!row) return;
            const current = (this.colorOverrides && this.colorOverrides[key]) || row.defaultValue;
            this.colorPickTarget = { key, defaultValue: row.defaultValue };
            this.selectColorCustomizerKey(key);
            this.openWinColor();
            this.updateWinFromHex(current);
        }
        commitColorOverride(key, rawValue, options = {}) {
            const row = this.colorCustomizerRows ? this.colorCustomizerRows.get(key) : null;
            if (!row) return false;
            const defaultValue = row.defaultValue;
            const prevOverride = (this.colorOverrides && Object.prototype.hasOwnProperty.call(this.colorOverrides, key))
                ? this.colorOverrides[key]
                : null;
            const normalized = this.normalizeColor(rawValue);
            if (!normalized) return false;
            const asDisplay = this.formatColorDisplay(normalized);
            const nextOverride = this.normalizeColor(asDisplay) === this.normalizeColor(defaultValue) ? null : asDisplay;
            if ((prevOverride || null) === nextOverride) {
                this.refreshColorCustomizerUI();
                this.updateColorCustomizerEditor();
                return true;
            }
            if (options.recordHistory !== false) {
                this.pushColorCustomizerHistory({
                    type: 'token',
                    key,
                    prev: prevOverride,
                    next: nextOverride,
                    source: options.source || 'manual',
                    at: Date.now()
                });
            }
            if (nextOverride === null) delete this.colorOverrides[key];
            else this.colorOverrides[key] = nextOverride;
            this.saveColorOverrides();
            this.applyColorOverrides();
            this.refreshColorCustomizerUI();
            this.applyColorSearchFilter((document.getElementById('color-customizer-search') || {}).value || '');
            if (options.select !== false) this.selectColorCustomizerKey(key, { keepScroll: true });
            else this.updateColorCustomizerEditor();
            return true;
        }
        selectColorCustomizerKey(key, opts = {}) {
            if (!this.colorCustomizerRows || !this.colorCustomizerRows.has(key)) return;
            if (this.colorCustomizerSelectedKey && this.colorCustomizerRows.has(this.colorCustomizerSelectedKey)) {
                const prev = this.colorCustomizerRows.get(this.colorCustomizerSelectedKey);
                if (prev && prev.root) prev.root.classList.remove('is-active');
            }
            const row = this.colorCustomizerRows.get(key);
            if (!row || !row.root) return;
            this.colorCustomizerSelectedKey = key;
            row.root.classList.add('is-active');
            if (!opts.keepScroll && row.root.scrollIntoView) {
                row.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
            this.updateColorCustomizerEditor();
        }
        setColorEditorRgb(r, g, b) {
            const clamp = (v) => Math.max(0, Math.min(255, Number.isFinite(v) ? Math.round(v) : 0));
            const rr = clamp(r);
            const gg = clamp(g);
            const bb = clamp(b);
            const fields = [
                ['color-editor-r-range', rr], ['color-editor-r-num', rr],
                ['color-editor-g-range', gg], ['color-editor-g-num', gg],
                ['color-editor-b-range', bb], ['color-editor-b-num', bb]
            ];
            fields.forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el) el.value = String(val);
            });
            const hsl = this.rgbToHsl(rr / 255, gg / 255, bb / 255);
            const h = Math.round((hsl.h || 0) * 360);
            const s = Math.round((hsl.s || 0) * 100);
            const l = Math.round((hsl.l || 0) * 100);
            const hslFields = [
                ['color-editor-h-range', h], ['color-editor-h-num', h],
                ['color-editor-s-range', s], ['color-editor-s-num', s],
                ['color-editor-l-range', l], ['color-editor-l-num', l]
            ];
            hslFields.forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el) el.value = String(val);
            });
        }
        setColorEditorAlpha(alpha) {
            const a = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
            const aPct = Math.round(a * 100);
            const fields = [
                ['color-editor-a-range', aPct],
                ['color-editor-a-num', aPct]
            ];
            fields.forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el) el.value = String(val);
            });
        }
        getColorEditorRgbFromControls() {
            const read = (id, min, max) => {
                const el = document.getElementById(id);
                const raw = el ? parseInt(el.value, 10) : 0;
                return Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : 0));
            };
            return {
                r: read('color-editor-r-range', 0, 255),
                g: read('color-editor-g-range', 0, 255),
                b: read('color-editor-b-range', 0, 255)
            };
        }
        getColorEditorHslFromControls() {
            const read = (id, min, max) => {
                const el = document.getElementById(id);
                const raw = parseInt(el ? el.value : '0', 10);
                return Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : 0));
            };
            return {
                h: read('color-editor-h-range', 0, 360),
                s: read('color-editor-s-range', 0, 100),
                l: read('color-editor-l-range', 0, 100)
            };
        }
        getColorEditorAlphaFromControls() {
            const el = document.getElementById('color-editor-a-range');
            const raw = parseFloat(el ? el.value : '100');
            const pct = Math.max(0, Math.min(100, Number.isFinite(raw) ? raw : 100));
            return pct / 100;
        }
        formatRgbaOverride(r, g, b, a) {
            const alpha = Math.max(0, Math.min(1, Number.isFinite(a) ? a : 1));
            if (alpha >= 1) return this.rgbToHex(r, g, b);
            return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
        }
        updateColorCustomizerEditor() {
            const keyLabel = document.getElementById('color-customizer-editor-key');
            const stateLabel = document.getElementById('color-customizer-editor-state');
            const swatch = document.getElementById('color-customizer-editor-swatch');
            const hexInput = document.getElementById('color-customizer-editor-hex');
            const key = this.colorCustomizerSelectedKey;
            const row = (key && this.colorCustomizerRows) ? this.colorCustomizerRows.get(key) : null;
            if (!row) {
                if (keyLabel) keyLabel.textContent = 'Select a color token from the list';
                if (stateLabel) stateLabel.textContent = 'No selection';
                if (swatch) swatch.style.backgroundColor = '#ffffff';
                if (hexInput) hexInput.value = '';
                this.setColorEditorRgb(0, 0, 0);
                this.setColorEditorAlpha(1);
                return;
            }
            const value = (this.colorOverrides && this.colorOverrides[key]) || row.defaultValue;
            const rgba = this.colorStringToRgba(value);
            if (!rgba) return;
            this.colorCustomizerEditorSyncing = true;
            if (keyLabel) keyLabel.textContent = row.keyDisplay || key;
            if (stateLabel) stateLabel.textContent = this.colorOverrides && this.colorOverrides[key] ? 'Overridden' : 'Default';
            if (swatch) swatch.style.backgroundColor = value;
            if (hexInput) hexInput.value = this.formatRgbaOverride(rgba.r, rgba.g, rgba.b, rgba.a);
            this.setColorEditorRgb(rgba.r, rgba.g, rgba.b);
            this.setColorEditorAlpha(rgba.a);
            this.colorCustomizerEditorSyncing = false;
        }
        applyEditorRgbToSelectedColor() {
            const key = this.colorCustomizerSelectedKey;
            if (!key) return;
            const rgb = this.getColorEditorRgbFromControls();
            const a = this.getColorEditorAlphaFromControls();
            this.commitColorOverride(key, this.formatRgbaOverride(rgb.r, rgb.g, rgb.b, a), { source: 'rgb-slider' });
        }
        applyEditorHslToSelectedColor() {
            const key = this.colorCustomizerSelectedKey;
            if (!key) return;
            const hsl = this.getColorEditorHslFromControls();
            const rgb = this.hslToRgb((hsl.h % 360) / 360, hsl.s / 100, hsl.l / 100);
            const r = Math.round(rgb.r * 255);
            const g = Math.round(rgb.g * 255);
            const b = Math.round(rgb.b * 255);
            const a = this.getColorEditorAlphaFromControls();
            this.commitColorOverride(key, this.formatRgbaOverride(r, g, b, a), { source: 'hsl-slider' });
        }
        getVisibleColorCustomizerKeys() {
            if (!this.colorCustomizerRows || !this.colorCustomizerRows.size) return [];
            const visibleRows = [];
            this.colorCustomizerRows.forEach((row, key) => {
                if (row.root && row.root.style.display !== 'none') visibleRows.push(key);
            });
            return visibleRows;
        }
        stepVisibleColorToPureRed(direction = 1) {
            if (!this.colorCustomizerRows || !this.colorCustomizerRows.size) return;
            const visibleRows = this.getVisibleColorCustomizerKeys();
            if (!visibleRows.length) return;
            const signature = visibleRows.join('|');
            if (!this.colorStepperState) {
                this.colorStepperState = {
                    signature: '',
                    currentIndex: null,
                    nextIndex: 0,
                    currentKey: null,
                    currentPrevOverride: null
                };
            }
            const st = this.colorStepperState;
            if (st.signature !== signature) {
                if (st.currentKey) {
                    if (st.currentPrevOverride === null || st.currentPrevOverride === undefined) delete this.colorOverrides[st.currentKey];
                    else this.colorOverrides[st.currentKey] = st.currentPrevOverride;
                }
                st.signature = signature;
                st.currentIndex = null;
                st.nextIndex = 0;
                st.currentKey = null;
                st.currentPrevOverride = null;
            }
            // Keep only one stepped-red token active at a time.
            if (st.currentKey) {
                if (st.currentPrevOverride === null || st.currentPrevOverride === undefined) delete this.colorOverrides[st.currentKey];
                else this.colorOverrides[st.currentKey] = st.currentPrevOverride;
            }
            let targetIndex;
            if (direction < 0) {
                if (st.currentIndex === null || st.currentIndex === undefined) {
                    targetIndex = visibleRows.length - 1;
                } else {
                    targetIndex = (st.currentIndex - 1 + visibleRows.length) % visibleRows.length;
                }
            } else if (st.currentIndex === null || st.currentIndex === undefined) {
                targetIndex = st.nextIndex % visibleRows.length;
            } else {
                targetIndex = (st.currentIndex + 1) % visibleRows.length;
            }
            const key = visibleRows[targetIndex];
            st.currentIndex = targetIndex;
            st.nextIndex = (targetIndex + 1) % visibleRows.length;
            st.currentKey = key;
            st.currentPrevOverride = Object.prototype.hasOwnProperty.call(this.colorOverrides, key) ? this.colorOverrides[key] : null;
            this.colorOverrides[key] = '#ff0000';
            this.saveColorOverrides();
            this.applyColorOverrides();
            this.applyColorSearchFilter((document.getElementById('color-customizer-search') || {}).value || '');
            this.selectColorCustomizerKey(key);
        }
        setSelectedColorToPureRed() {
            const key = this.colorCustomizerSelectedKey;
            if (!key) return;
            this.commitColorOverride(key, '#ff0000', { source: 'selected-red' });
        }
        bindColorCustomizerEditorControls() {
            if (this.colorCustomizerEditorBound) return;
            this.colorCustomizerEditorBound = true;
            const clearBtn = document.getElementById('color-customizer-clear-search');
            if (clearBtn) {
                clearBtn.addEventListener('click', () => {
                    const search = document.getElementById('color-customizer-search');
                    if (search) search.value = '';
                    this.applyColorSearchFilter('');
                    if (search) search.focus();
                });
            }
            const changedOnly = document.getElementById('color-customizer-changed-only');
            if (changedOnly) {
                changedOnly.addEventListener('change', () => {
                    this.colorCustomizerFilterChangedOnly = !!changedOnly.checked;
                    this.applyColorSearchFilter((document.getElementById('color-customizer-search') || {}).value || '');
                });
            }
            const undoBtn = document.getElementById('color-customizer-undo-btn');
            if (undoBtn) undoBtn.addEventListener('click', () => this.undoLastColorCustomizerChange());
            const stepBtn = document.getElementById('color-customizer-step-red-btn');
            if (stepBtn) stepBtn.addEventListener('click', () => this.stepVisibleColorToPureRed(1));
            const stepBackBtn = document.getElementById('color-customizer-step-back-red-btn');
            if (stepBackBtn) stepBackBtn.addEventListener('click', () => this.stepVisibleColorToPureRed(-1));
            const selectedRedBtn = document.getElementById('color-customizer-set-selected-red');
            if (selectedRedBtn) selectedRedBtn.addEventListener('click', () => this.setSelectedColorToPureRed());
            const hexInput = document.getElementById('color-customizer-editor-hex');
            if (hexInput) {
                hexInput.addEventListener('change', () => {
                    const key = this.colorCustomizerSelectedKey;
                    if (!key) return;
                    if (!this.commitColorOverride(key, hexInput.value, { source: 'hex-input' })) {
                        this.updateColorCustomizerEditor();
                    }
                });
                hexInput.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    const key = this.colorCustomizerSelectedKey;
                    if (!key) return;
                    if (!this.commitColorOverride(key, hexInput.value, { source: 'hex-enter' })) {
                        this.updateColorCustomizerEditor();
                    }
                });
            }
            const pair = (rangeId, numId, applyFn) => {
                const rangeEl = document.getElementById(rangeId);
                const numEl = document.getElementById(numId);
                if (!rangeEl || !numEl) return;
                rangeEl.addEventListener('input', () => {
                    if (this.colorCustomizerEditorSyncing) return;
                    numEl.value = rangeEl.value;
                    applyFn();
                });
                numEl.addEventListener('input', () => {
                    if (this.colorCustomizerEditorSyncing) return;
                    rangeEl.value = numEl.value;
                    applyFn();
                });
            };
            pair('color-editor-r-range', 'color-editor-r-num', () => this.applyEditorRgbToSelectedColor());
            pair('color-editor-g-range', 'color-editor-g-num', () => this.applyEditorRgbToSelectedColor());
            pair('color-editor-b-range', 'color-editor-b-num', () => this.applyEditorRgbToSelectedColor());
            pair('color-editor-h-range', 'color-editor-h-num', () => this.applyEditorHslToSelectedColor());
            pair('color-editor-s-range', 'color-editor-s-num', () => this.applyEditorHslToSelectedColor());
            pair('color-editor-l-range', 'color-editor-l-num', () => this.applyEditorHslToSelectedColor());
            pair('color-editor-a-range', 'color-editor-a-num', () => this.applyEditorRgbToSelectedColor());
            if (!this.colorShortcutBound) {
                this.colorShortcutBound = true;
                window.addEventListener('keydown', (e) => {
                    if (!this.isColorModalOpen()) return;
                    if (this.isWinColorOpen()) return;
                    const target = e.target;
                    const isTyping = !!(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable));
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
                        e.preventDefault();
                        this.undoLastColorCustomizerChange();
                        return;
                    }
                    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                        const search = document.getElementById('color-customizer-search');
                        if (search) {
                            e.preventDefault();
                            search.focus();
                            search.select();
                        }
                        return;
                    }
                    if (!isTyping && e.key.toLowerCase() === 'r') {
                        e.preventDefault();
                        this.stepVisibleColorToPureRed(1);
                    }
                    if (!isTyping && e.key.toLowerCase() === 'u') {
                        e.preventDefault();
                        this.stepVisibleColorToPureRed(-1);
                    }
                }, true);
            }
            this.updateColorCustomizerUndoUi();
        }
        applyColorSearchFilter(query) {
            if (!this.colorCustomizerRows) return;
            const needle = (query || '').trim().toLowerCase();
            const tokens = needle ? needle.split(/\s+/).filter(Boolean) : [];
            let visibleCount = 0;
            this.colorCustomizerRows.forEach((row, key) => {
                const isChanged = !!(this.colorOverrides && Object.prototype.hasOwnProperty.call(this.colorOverrides, key));
                if (this.colorCustomizerFilterChangedOnly && !isChanged) {
                    row.root.style.display = 'none';
                    return;
                }
                const hay = `${row.searchText || ''} ${row.currentDisplay || ''} ${row.currentHex || ''} ${key}`.toLowerCase();
                const visible = !tokens.length || tokens.every((token) => {
                    if (token === 'changed' || token === 'changed:yes') return isChanged;
                    if (token === 'default' || token === 'changed:no') return !isChanged;
                    if (token.startsWith('hex:')) return (row.currentHex || '').toLowerCase().includes(token.slice(4));
                    if (token.startsWith('ui:') || token.startsWith('el:')) return (row.elementText || '').includes(token.split(':').slice(1).join(':'));
                    return hay.includes(token);
                });
                row.root.style.display = visible ? '' : 'none';
                if (visible) visibleCount += 1;
            });
            const resultLabel = document.getElementById('color-customizer-result-count');
            if (resultLabel) resultLabel.textContent = `${visibleCount}`;
            if (!this.colorCustomizerSelectedKey || !this.colorCustomizerRows.has(this.colorCustomizerSelectedKey)) {
                this.updateColorCustomizerEditor();
                return;
            }
            const selected = this.colorCustomizerRows.get(this.colorCustomizerSelectedKey);
            if (selected && selected.root && selected.root.style.display === 'none') {
                this.colorCustomizerSelectedKey = null;
                this.updateColorCustomizerEditor();
            }
        }
        randomizeColorOverrides() {
            if (!this.colorDefaults) return;
            const before = this.getColorCustomizerSnapshot();
            const rand = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
            this.colorOverrides = {};
            this.colorDefaults.forEach(item => {
                if (this.colorSensitiveKeys && this.colorSensitiveKeys.has(item.key)) return;
                if (this.colorIconBackgroundKeys && this.colorIconBackgroundKeys.has(item.key)) {
                    this.colorOverrides[item.key] = '#ffffff';
                    return;
                }
                const base = this.getHslFromColor(item.display);
                if (!base) return;
                const h = rand(0, 359) / 360;
                const s = rand(35, 80) / 100;
                const l = Math.max(0.1, Math.min(0.9, base.l + (rand(-18, 18) / 100)));
                const rgb = this.hslToRgb(h, s, l);
                const target = this.rgbToHex(Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255));
                const blended = this.blendPresetColor(item.display, target);
                this.colorOverrides[item.key] = blended || target;
            });
            this.fileTabPresetColor = this.buildRandomFileTabColor();
            this.saveColorOverrides();
            this.applyColorOverrides();
            this.pushColorCustomizerHistory({
                type: 'snapshot',
                prevSnapshot: before,
                source: 'randomize',
                at: Date.now()
            });
        }
        confirmResetColorOverrides() {
            const modal = document.getElementById('modal-confirm-reset');
            if (!modal) return;
            modal.style.display = 'flex';
            this.centerModal('modal-confirm-reset');
        }
        getHslFromColor(value) {
            const rgb = this.colorToRgb(value);
            if (!rgb) return null;
            return this.rgbToHsl(rgb.r, rgb.g, rgb.b);
        }
        colorToRgb(value) {
            if (!value) return null;
            const norm = this.normalizeColor(value);
            if (!norm) return null;
            const match = norm.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
            if (!match) return null;
            const r = Math.max(0, Math.min(255, parseInt(match[1], 10)));
            const g = Math.max(0, Math.min(255, parseInt(match[2], 10)));
            const b = Math.max(0, Math.min(255, parseInt(match[3], 10)));
            return { r: r / 255, g: g / 255, b: b / 255 };
        }
        buildRandomFileTabColor() {
            const h = Math.floor(Math.random() * 360) / 360;
            const s = 0.75;
            const l = 0.38;
            const rgb = this.hslToRgb(h, s, l);
            return this.rgbToHex(Math.round(rgb.r * 255), Math.round(rgb.g * 255), Math.round(rgb.b * 255));
        }
        ensureColorProbe() {
            if (this._colorProbe) return this._colorProbe;
            const probe = document.createElement('span');
            probe.style.position = 'fixed';
            probe.style.left = '-9999px';
            probe.style.top = '-9999px';
            probe.style.width = '1px';
            probe.style.height = '1px';
            probe.style.visibility = 'hidden';
            document.body.appendChild(probe);
            this._colorProbe = probe;
            return probe;
        }
        normalizeColor(value) {
            if (!value) return null;
            const probe = this.ensureColorProbe();
            probe.style.color = '';
            probe.style.color = value;
            if (!probe.style.color) return null;
            return getComputedStyle(probe).color;
        }
        escapeRegExp(value) {
            return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        extractColorVariableTokens(cssText) {
            const out = [];
            if (!cssText) return out;
            const regex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
            let match = null;
            while ((match = regex.exec(cssText)) !== null) {
                const name = match[1];
                const value = (match[2] || '').trim();
                const colors = this.extractColorsFromText(value);
                if (!colors.length) continue;
                const normalized = this.normalizeColor(colors[0]);
                if (!normalized) continue;
                out.push({
                    name,
                    key: `var(${name})`,
                    defaultRaw: value,
                    defaultDisplay: this.formatColorDisplay(normalized)
                });
            }
            return out;
        }
        applyCssVariableOverrides(cssText, overrides) {
            const tokens = Array.isArray(this.colorVarTokens) ? this.colorVarTokens : [];
            let out = cssText || '';
            tokens.forEach((token) => {
                if (!token || !token.key || !token.name) return;
                const next = overrides[token.key];
                if (!next) return;
                const pattern = new RegExp(`(${this.escapeRegExp(token.name)}\\s*:\\s*)([^;]+)(;)`, 'g');
                out = out.replace(pattern, `$1${next}$3`);
            });
            return out;
        }
        getColorVarTokenByKey(key) {
            if (!key || !Array.isArray(this.colorVarTokens)) return null;
            return this.colorVarTokens.find(token => token.key === key) || null;
        }
        getElementColorTokenByKey(key) {
            if (!key || !this.colorElementTokens || !(this.colorElementTokens instanceof Map)) return null;
            return this.colorElementTokens.get(key) || null;
        }
        formatColorDisplay(rgba) {
            const match = rgba.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
            if (!match) return rgba;
            const r = Math.max(0, Math.min(255, parseInt(match[1], 10)));
            const g = Math.max(0, Math.min(255, parseInt(match[2], 10)));
            const b = Math.max(0, Math.min(255, parseInt(match[3], 10)));
            const a = match[4] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(match[4])));
            if (a >= 1) {
                const toHex = (n) => n.toString(16).padStart(2, '0');
                return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
            }
            return `rgba(${r}, ${g}, ${b}, ${a})`;
        }
        extractColorsFromText(text) {
            if (!text) return [];
            this.colorTokenRegex.lastIndex = 0;
            const matches = text.match(this.colorTokenRegex);
            return matches ? matches : [];
        }
        collectUniqueColors() {
            const raw = [];
            raw.push(...this.extractColorsFromText(this.colorBaseCss));
            this.colorAttrTargets.forEach(entry => {
                // Inline style/fill/stroke tokens are represented as per-element tokens.
                // Skip adding them to shared raw-color rows.
                if (entry && entry.attrs) return;
            });
            const props = [
                'backgroundColor',
                'color',
                'borderTopColor',
                'borderRightColor',
                'borderBottomColor',
                'borderLeftColor',
                'outlineColor'
            ];
            const elements = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
            elements.forEach(el => {
                if (this.isThemeColorElementExcluded(el)) return;
                const cs = getComputedStyle(el);
                props.forEach(prop => {
                    const value = cs[prop];
                    if (value) raw.push(...this.extractColorsFromText(value));
                });
            });
            const seen = new Map();
            raw.forEach(token => {
                const norm = this.normalizeColor(token);
                if (!norm || seen.has(norm)) return;
                seen.set(norm, this.formatColorDisplay(norm));
            });
            const byKey = new Map();
            (this.colorVarTokens || []).forEach(token => {
                byKey.set(token.key, { key: token.key, display: token.defaultDisplay });
            });
            if (this.colorElementTokens && this.colorElementTokens.size) {
                this.colorElementTokens.forEach((token) => {
                    if (!token || !token.key) return;
                    byKey.set(token.key, { key: token.key, display: token.defaultDisplay });
                });
            }
            Array.from(seen.entries())
                .map(([key, display]) => ({ key, display }))
                .sort((a, b) => a.display.localeCompare(b.display))
                .forEach((item) => {
                    if (!byKey.has(item.key)) byKey.set(item.key, item);
                });
            return Array.from(byKey.values());
        }
        collectSensitiveColorKeys() {
            const sensitive = new Set();
            const iconBackground = new Set();
            const paletteSelector = '#palette-std, #palette-recent, #palette-custom, #palette, .mini-swatch';
            if (this.colorDefaults) {
                this.colorDefaults.forEach(item => {
                    const alpha = this.getAlphaFromNormalized(item.key);
                    if (alpha === 0) sensitive.add(item.key);
                });
            }
            if (this.colorExamples) {
                this.colorExamples.forEach((example, key) => {
                    if (example && example.el && example.el.closest && example.el.closest(paletteSelector)) {
                        sensitive.add(key);
                    }
                });
            }
            const fileTab = document.querySelector('.tab.file');
            if (fileTab) {
                const cs = getComputedStyle(fileTab);
                const bg = this.normalizeColor(cs.backgroundColor);
                const fg = this.normalizeColor(cs.color);
                if (bg) sensitive.add(bg);
                if (fg) sensitive.add(fg);
            }
            const iconHosts = document.querySelectorAll('img[src^="data:image"]');
            iconHosts.forEach(img => {
                const host = img.closest('button, .btn, .btn-large, .btn-text, .split-btn-container, .section, .tab, .tab-row, #title-bar') || img.parentElement;
                if (!host) return;
                const bg = getComputedStyle(host).backgroundColor;
                const norm = this.normalizeColor(bg);
                if (norm && norm !== 'rgba(0, 0, 0, 0)') {
                    iconBackground.add(norm);
                    sensitive.add(norm);
                }
            });
            return { sensitive, iconBackground };
        }
        getAlphaFromNormalized(rgba) {
            if (!rgba) return 1;
            const match = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/i);
            if (!match) return 1;
            const a = parseFloat(match[4]);
            if (!Number.isFinite(a)) return 1;
            return Math.max(0, Math.min(1, a));
        }
        replaceColorTokens(text, overrides) {
            if (!text) return text;
            this.colorTokenRegex.lastIndex = 0;
            return text.replace(this.colorTokenRegex, (match) => {
                const norm = this.normalizeColor(match);
                if (!norm) return match;
                const override = overrides[norm];
                return override ? override : match;
            });
        }
        replaceColorTokensExcept(text, overrides, excludedNormalized) {
            if (!text) return text;
            this.colorTokenRegex.lastIndex = 0;
            return text.replace(this.colorTokenRegex, (match) => {
                const norm = this.normalizeColor(match);
                if (!norm) return match;
                if (excludedNormalized && excludedNormalized.has(norm)) return match;
                const override = overrides[norm];
                return override ? override : match;
            });
        }
        replaceSpecificNormalizedColor(text, targetNorm, replacement) {
            if (!text || !targetNorm || !replacement) return text;
            this.colorTokenRegex.lastIndex = 0;
            return text.replace(this.colorTokenRegex, (match) => {
                const norm = this.normalizeColor(match);
                if (!norm) return match;
                return norm === targetNorm ? replacement : match;
            });
        }
        replaceSpecificNormalizedColorOccurrence(text, targetNorm, occurrence, replacement) {
            if (!text || !targetNorm || !replacement) return text;
            let seen = 0;
            this.colorTokenRegex.lastIndex = 0;
            return text.replace(this.colorTokenRegex, (match) => {
                const norm = this.normalizeColor(match);
                if (!norm || norm !== targetNorm) return match;
                const hit = seen;
                seen += 1;
                return hit === occurrence ? replacement : match;
            });
        }
        loadColorOverrides() {
            try {
                const raw = this.lsGet('paint.colorOverrides');
                if (!raw) return {};
                const data = JSON.parse(raw);
                return data && typeof data === 'object' ? data : {};
            } catch (e) {
                return {};
            }
        }
        saveColorOverrides() {
            this.lsSet('paint.colorOverrides', JSON.stringify(this.colorOverrides || {}));
        }
        applyColorOverrides() {
            if (!this.colorStyleEl || !this.colorBaseCss) return;
            const overrides = this.colorOverrides || {};
            const cssWithColorOverrides = this.replaceColorTokens(this.colorBaseCss, overrides);
            this.colorStyleEl.textContent = this.applyCssVariableOverrides(cssWithColorOverrides, overrides);
            this.colorAttrTargets.forEach(entry => {
                if (entry.excludeTheme) return;
                Object.entries(entry.attrs).forEach(([attr, value]) => {
                    entry.el.setAttribute(attr, this.replaceColorTokens(value, overrides));
                });
            });
            if (this.colorElementTokens && this.colorElementTokens.size) {
                const grouped = new Map();
                this.colorElementTokens.forEach((token) => {
                    const override = overrides[token.key];
                    if (!override || !token.targets || !token.targets.length) return;
                    token.targets.forEach((target) => {
                        if (!target || !target.el || !target.attr) return;
                        let byAttr = grouped.get(target.el);
                        if (!byAttr) {
                            byAttr = new Map();
                            grouped.set(target.el, byAttr);
                        }
                        let bucket = byAttr.get(target.attr);
                        if (!bucket) {
                            bucket = { defaultRaw: target.defaultRaw, excludes: new Set(), replacements: [] };
                            byAttr.set(target.attr, bucket);
                        }
                        bucket.excludes.add(target.normalized);
                        bucket.replacements.push({
                            normalized: target.normalized,
                            occurrence: target.occurrence,
                            override,
                            order: target.order
                        });
                    });
                });
                grouped.forEach((byAttr, el) => {
                    byAttr.forEach((bucket, attr) => {
                        let next = this.replaceColorTokensExcept(bucket.defaultRaw, overrides, bucket.excludes);
                        bucket.replacements
                            .sort((a, b) => a.order - b.order)
                            .forEach((rep) => {
                                next = this.replaceSpecificNormalizedColorOccurrence(next, rep.normalized, rep.occurrence, rep.override);
                            });
                        el.setAttribute(attr, next);
                    });
                });
            }
            document.querySelectorAll('[data-fixed-black="true"]').forEach(el => {
                el.style.backgroundColor = '#000000';
            });
            if (this.fileTabEl) {
                if (this.fileTabPresetColor) {
                    this.fileTabEl.style.backgroundColor = this.fileTabPresetColor;
                    this.fileTabEl.style.color = '#ffffff';
                } else {
                    this.fileTabEl.style.backgroundColor = '';
                    this.fileTabEl.style.color = '';
                }
            }
            this.enforceFixedPaletteSwatchStyles();
            this.refreshColorCustomizerUI();
        }
        buildColorCustomizer() {
            if (!this.colorDefaults) return;
            const list = document.getElementById('color-customizer-list');
            if (!list) return;
            list.innerHTML = '';
            this.colorCustomizerRows = new Map();
            this.colorDefaults.forEach(item => {
                const row = document.createElement('div');
                row.className = 'color-item';
                row.dataset.colorKey = item.key;
                const swatch = document.createElement('div');
                swatch.className = 'color-swatch';
                const label = document.createElement('div');
                label.className = 'color-label';
                label.textContent = item.display;
                const elementLabel = document.createElement('div');
                elementLabel.className = 'color-element-label';
                const varToken = this.getColorVarTokenByKey(item.key);
                const elementToken = varToken ? null : this.getElementColorTokenByKey(item.key);
                const example = (varToken || elementToken) ? null : (this.colorExamples ? this.colorExamples.get(item.key) : null);
                elementLabel.textContent = varToken
                    ? `CSS token ${varToken.name}`
                    : (elementToken ? `${elementToken.label}` : (example ? this.getElementLabel(example.el, example.prop) : 'No preview element'));
                const input = document.createElement('input');
                input.type = 'text';
                input.readOnly = true;
                input.className = 'color-input';
                input.dataset.colorKey = item.key;
                input.addEventListener('dblclick', () => {
                    this.selectColorCustomizerKey(item.key);
                    this.openColorPickerForKey(item.key);
                });
                const editBtn = document.createElement('button');
                editBtn.className = 'btn btn-small';
                editBtn.textContent = 'Edit';
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.selectColorCustomizerKey(item.key);
                    this.openColorPickerForKey(item.key);
                });
                const showBtn = document.createElement('button');
                showBtn.className = 'btn btn-small';
                showBtn.textContent = 'Show';
                showBtn.disabled = !example;
                if (example) {
                    showBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.selectColorCustomizerKey(item.key);
                        this.highlightColorExample(example.el, example.prop);
                    });
                }
                row.addEventListener('click', (e) => {
                    if (e.target && e.target.closest('button')) return;
                    this.selectColorCustomizerKey(item.key);
                });
                row.appendChild(swatch);
                row.appendChild(label);
                row.appendChild(elementLabel);
                row.appendChild(input);
                row.appendChild(editBtn);
                row.appendChild(showBtn);
                list.appendChild(row);
                const searchText = `${item.display} ${elementLabel.textContent}`.toLowerCase();
                this.colorCustomizerRows.set(item.key, {
                    input,
                    swatch,
                    defaultValue: item.display,
                    root: row,
                    keyDisplay: `${item.display}  |  ${elementLabel.textContent}`,
                    elementText: (elementLabel.textContent || '').toLowerCase(),
                    searchText,
                    currentDisplay: item.display,
                    currentHex: item.display,
                    currentNormalized: this.normalizeColor(item.display) || item.key
                });
            });
            const search = document.getElementById('color-customizer-search');
            if (search && !this.colorSearchBound) {
                search.addEventListener('input', () => this.applyColorSearchFilter(search.value));
                this.colorSearchBound = true;
            }
            if (search) this.applyColorSearchFilter(search.value);
            const preset = document.getElementById('color-customizer-preset');
            if (preset && !this.colorPresetBound) {
                preset.addEventListener('change', () => this.applyColorPresetFromUI());
                this.colorPresetBound = true;
            }
            this.bindColorCustomizerEditorControls();
            const changedOnly = document.getElementById('color-customizer-changed-only');
            if (changedOnly) changedOnly.checked = !!this.colorCustomizerFilterChangedOnly;
            this.refreshColorPresetOptions();
            this.refreshColorCustomizerUI();
            if (!this.colorCustomizerSelectedKey || !this.colorCustomizerRows.has(this.colorCustomizerSelectedKey)) {
                const first = this.colorCustomizerRows.keys().next();
                if (!first.done) this.colorCustomizerSelectedKey = first.value;
            }
            if (this.colorCustomizerSelectedKey) this.selectColorCustomizerKey(this.colorCustomizerSelectedKey, { keepScroll: true });
            this.updateThemeSelectUi();
            this.updateColorCustomizerUndoUi();
        }
        refreshColorCustomizerUI() {
            if (!this.colorCustomizerRows) return;
            this.colorCustomizerRows.forEach((row, key) => {
                const override = this.colorOverrides && this.colorOverrides[key];
                const value = override || row.defaultValue;
                row.input.value = value;
                row.swatch.style.backgroundColor = value;
                row.currentDisplay = value;
                const rgba = this.colorStringToRgba(value);
                row.currentHex = rgba ? this.rgbToHex(rgba.r, rgba.g, rgba.b) : '';
                row.currentNormalized = this.normalizeColor(value) || this.normalizeColor(row.defaultValue) || key;
            });
            this.updateColorCustomizerEditor();
            this.updateColorCustomizerUndoUi();
        }
        updateColorOverrideFromInput(input, swatch, defaultValue) {
            const key = input.dataset.colorKey;
            const raw = input.value.trim();
            if (!raw) {
                delete this.colorOverrides[key];
                input.value = defaultValue;
                swatch.style.backgroundColor = defaultValue;
                input.classList.remove('invalid');
                this.saveColorOverrides();
                this.applyColorOverrides();
                return;
            }
            const normalized = this.normalizeColor(raw);
            if (!normalized) {
                input.classList.add('invalid');
                return;
            }
            input.classList.remove('invalid');
            this.colorOverrides[key] = raw;
            swatch.style.backgroundColor = raw;
            this.saveColorOverrides();
            this.applyColorOverrides();
        }
        resetColorOverrides(opts = {}) {
            const before = this.getColorCustomizerSnapshot();
            this.colorOverrides = {};
            this.fileTabPresetColor = null;
            this.lsRemove('paint.colorOverrides');
            this.applyColorOverrides();
            if (opts.recordHistory !== false) {
                this.pushColorCustomizerHistory({
                    type: 'snapshot',
                    prevSnapshot: before,
                    source: 'reset',
                    at: Date.now()
                });
            }
        }
        cancelDepth() {
            const depthDocked = this._activeSidebarModalId === 'depth';
            if (depthDocked) {
                this._closeUnifiedSidebar(true);
            }
            this.depthBackup = null;
            if (!depthDocked) {
                const m = document.getElementById('modal-depth');
                if (m) m.style.display = 'none';
            }
        }
        _openUnifiedSidebar(id) {
            const modal = document.getElementById('modal-' + id);
            if (!modal) return;
            const sidebar = document.getElementById('unified-sidebar');
            if (!sidebar) return;
            if (id === 'huesat' || id === 'resize' || id === 'depth') {
                const content = sidebar.querySelector('.sidebar-content');
                const existing = content.querySelector('.modal-mask');
                if (existing && existing !== modal) {
                    document.body.appendChild(existing);
                    existing.style.display = 'none';
                }
                content.appendChild(modal);
                modal.style.display = '';
                this._saveSidebarUIMode(id, 'sidebar');
            }
            sidebar.classList.remove('hidden');
            this._updateSidebarViewportShift(true);
            this._trackFloated();
            delete this._floatedModals[id];
            this._updateSidebarTabVisibility();
            this._activeSidebarModalId = id;
            const btnId = id === 'huesat' ? 'hs-sidebar-toggle-btn' : id + '-sidebar-toggle-btn';
            const btn = document.getElementById(btnId);
            if (btn) { btn.title = 'Undock to floating window'; btn.innerHTML = this.getSidebarUndockIcon(); }
            this._updateSidebarModeButtons(id);
        }
        _closeUnifiedSidebar(quiet = false) {
            const id = this._activeSidebarModalId;
            if (!id) return;
            const modal = document.getElementById('modal-' + id);
            const sidebar = document.getElementById('unified-sidebar');
            if ((id === 'huesat' || id === 'resize' || id === 'depth') && sidebar) {
                if (modal && modal.parentNode !== document.body) {
                    document.body.appendChild(modal);
                }
                if (!quiet) {
                    modal.style.display = 'flex';
                    this.centerModal('modal-' + id);
                } else {
                    modal.style.display = 'none';
                }
            }
            if (sidebar) sidebar.classList.add('hidden');
            this._updateSidebarViewportShift(true);
            const btnId = id === 'huesat' ? 'hs-sidebar-toggle-btn' : id + '-sidebar-toggle-btn';
            const btn = document.getElementById(btnId);
            if (btn) { btn.title = 'Dock as sidebar'; btn.innerHTML = this.getSidebarDockIcon(); }
            this._activeSidebarModalId = null;
            this._updateSidebarModeButtons(null);
            this._updateSidebarTabVisibility();
        }
        _trackFloated() {
            if (!this._floatedModals) this._floatedModals = {};
        }
        _updateSidebarTabVisibility() {
            const modes = document.querySelector('#unified-sidebar .sidebar-modes');
            if (!modes) return;
            this._trackFloated();
            modes.querySelectorAll('button[data-modal]').forEach(b => {
                const mid = b.dataset.modal;
                b.style.display = this._loadSidebarUIMode(mid) !== 'sidebar' ? 'none' : '';
            });
        }
        _closeActiveSidebar(quiet = false) {
            if (this._activeSidebarModalId) {
                this._closeUnifiedSidebar(quiet);
            }
        }
        _saveSidebarUIMode(id, mode) {
            try { localStorage.setItem('paint.sidebar.' + id + '.uiMode', mode); } catch(e) {}
        }
        _loadSidebarUIMode(id) {
            try { return localStorage.getItem('paint.sidebar.' + id + '.uiMode') || 'floating'; } catch(e) { return 'floating'; }
        }
        _updateSidebarModeButtons(activeId) {
            document.querySelectorAll('#unified-sidebar .sidebar-modes button').forEach(b => {
                b.classList.toggle('active', b.dataset.modal === activeId);
            });
        }
        toggleUtilitySidebar(id) {
            if (id !== 'resize' && id !== 'depth') return;
            const sidebar = document.getElementById('unified-sidebar');
            if (!sidebar) return;
            if (this._activeSidebarModalId === id) {
                this._closeUnifiedSidebar();
            } else {
                if (this._activeSidebarModalId) this._closeUnifiedSidebar(true);
                this._openUnifiedSidebar(id);
            }
        }
        resetUtilitySidebars() {
            for (const id of ['resize', 'depth', 'huesat']) {
                const btnId = id === 'huesat' ? 'hs-sidebar-toggle-btn' : id + '-sidebar-toggle-btn';
                const btn = document.getElementById(btnId);
                if (btn) { btn.title = 'Dock as sidebar'; btn.innerHTML = this.getSidebarDockIcon(); }
            }
        }
        getSidebarDockIcon() { return '<img class="util-dock-icon" src="assets/anchor.png" alt="Dock as sidebar">'; }
        getSidebarUndockIcon() { return '<img class="util-dock-icon" src="assets/Free.png" alt="Undock to floating window">'; }

        _hsDrawRing() {
            const canvas = document.getElementById('hs-ring-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const cx = 62, cy = 62, size = 124;
            ctx.clearRect(0, 0, size, size);
            // Draw conic hue ring
            const outerR = 58, innerR = 32;
            const steps = 360;
            for (let i = 0; i < steps; i++) {
                const angle = (i / steps) * Math.PI * 2 - Math.PI / 2;
                const nextAngle = ((i + 1) / steps) * Math.PI * 2 - Math.PI / 2;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.arc(cx, cy, outerR, angle, nextAngle);
                ctx.closePath();
                ctx.fillStyle = `hsl(${i},100%,50%)`;
                ctx.fill();
            }
            // Punch inner hole
            ctx.globalCompositeOperation = 'destination-out';
            ctx.beginPath();
            ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalCompositeOperation = 'source-over';
            // Thin separator ring
            ctx.beginPath();
            ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,0,0,0.12)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0,0,0,0.08)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        _hsUpdateChannelBtnColors() {
            const channelHues = { R: 0, Y: 60, G: 120, C: 180, B: 240, M: 300 };
            const btnMap = { R: '.pos-r', Y: '.pos-y', G: '.pos-g', C: '.pos-c', B: '.pos-b', M: '.pos-m' };
            const ch = this.state.hueSatChannel || 'Master';
            const liveHue   = parseFloat(document.getElementById('hs-hue')?.value)   || 0;
            const liveSat   = parseFloat(document.getElementById('hs-sat')?.value)   || 0;
            const liveLight = parseFloat(document.getElementById('hs-light')?.value) || 0;
            for (const [key, baseHue] of Object.entries(channelHues)) {
                const btn = document.querySelector(`#modal-huesat ${btnMap[key]} .channel-btn`);
                if (!btn) continue;
                let hShift, sShift, lShift;
                if (ch === 'Master') {
                    hShift = liveHue; sShift = liveSat; lShift = liveLight;
                } else if (ch === key) {
                    hShift = liveHue; sShift = liveSat; lShift = liveLight;
                } else {
                    const s = this.hueSatChannels[key] || {};
                    hShift = s.hue || 0; sShift = s.sat || 0; lShift = s.light || 0;
                }
                const newHue   = ((baseHue + hShift) % 360 + 360) % 360;
                const newSat   = Math.max(0, Math.min(100, 100 + sShift));
                const newLight = Math.max(0, Math.min(100, 50 + lShift * 0.5));
                btn.style.background = `hsl(${newHue}, ${newSat}%, ${newLight}%)`;
            }
        }
        _hsUpdatePreviewColors() {
            this._hsUpdateChannelBtnColors();
            // Update the live before/after preview strip
            const orig = document.getElementById('hs-prev-original');
            const adj = document.getElementById('hs-prev-adjusted');
            if (!orig || !adj) return;
            // For named channels (R/Y/G/C/B/M) use the channel's pure reference hue as the
            // "before" colour. For Master, sample the average from the backup canvas.
            const channelPureColors = { R: [255,0,0], Y: [255,255,0], G: [0,255,0], C: [0,255,255], B: [0,0,255], M: [255,0,255] };
            const ch = this.state.hueSatChannel || 'Master';
            let origR, origG, origB;
            if (channelPureColors[ch]) {
                [origR, origG, origB] = channelPureColors[ch];
            } else {
                // Average a central region of the backup canvas (up to 80×80 px)
                // to get a representative "before" colour for the Master channel preview.
                origR = 128; origG = 128; origB = 128;
                if (this.hueSatBackup) {
                    try {
                        const bc = this.hueSatBackup;
                        const bctx = bc.getContext('2d');
                        const pw = Math.min(bc.width, 80), ph = Math.min(bc.height, 80);
                        const d = bctx.getImageData(Math.floor(bc.width/2 - pw/2), Math.floor(bc.height/2 - ph/2), pw, ph);
                        let r=0,g=0,b=0,cnt=0;
                        for (let i=0;i<d.data.length;i+=16) { r+=d.data[i]; g+=d.data[i+1]; b+=d.data[i+2]; cnt++; }
                        if (cnt) { origR=Math.round(r/cnt); origG=Math.round(g/cnt); origB=Math.round(b/cnt); }
                    } catch(e) {}
                }
            }
            orig.style.background = `rgb(${origR},${origG},${origB})`;
            // Compute the "after" preview colour by applying the current H/S/L sliders
            // to the "before" colour in HSL space.
            try {
                let [h,s,l] = this._rgbToHsl(origR, origG, origB);
                const hShift = (parseFloat(document.getElementById('hs-hue')?.value) || 0) / 360;
                const sShift = (parseFloat(document.getElementById('hs-sat')?.value) || 0) / 100;
                const lShift = (parseFloat(document.getElementById('hs-light')?.value) || 0) / 100;
                h = (h + hShift + 1) % 1;
                s = Math.max(0, Math.min(1, s + sShift));
                l = Math.max(0, Math.min(1, l + lShift));
                const [nr,ng,nb] = this._hslToRgb(h,s,l);
                adj.style.background = `rgb(${nr},${ng},${nb})`;
            } catch(e) { adj.style.background = `rgb(${origR},${origG},${origB})`; }
        }
        _rgbToHsl(r,g,b) {
            const {h,s,l} = this.rgbToHsl(r/255, g/255, b/255);
            return [h,s,l];
        }
        _hslToRgb(h,s,l) {
            const c = this.hslToRgb(h,s,l);
            return [Math.round(c.r*255), Math.round(c.g*255), Math.round(c.b*255)];
        }
        _toLinear(v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
        _toSrgb(v)   { return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1/2.4) - 0.055; }
        _labF(t)     { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16/116; }
        _labFInv(t)  { return t > 0.206897 ? t*t*t : (t - 16/116) / 7.787; }
        _rgbToLab(r, g, b) {
            const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
            const rl = this._toLinear(r), gl = this._toLinear(g), bl = this._toLinear(b);
            const X = (rl*0.4124564 + gl*0.3575761 + bl*0.1804375) / Xn;
            const Y = (rl*0.2126729 + gl*0.7151522 + bl*0.0721750) / Yn;
            const Z = (rl*0.0193339 + gl*0.1191920 + bl*0.9503041) / Zn;
            return { L: 116*this._labF(Y)-16, A: 500*(this._labF(X)-this._labF(Y)), B: 200*(this._labF(Y)-this._labF(Z)) };
        }
        _labToRgb(L, A, B) {
            const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
            const fy = (L+16)/116, fx = A/500+fy, fz = fy-B/200;
            const X = this._labFInv(fx)*Xn, Y = this._labFInv(fy)*Yn, Z = this._labFInv(fz)*Zn;
            return {
                r: Math.max(0, Math.min(1, this._toSrgb(Math.max(0, 3.2404542*X - 1.5371385*Y - 0.4985314*Z)))),
                g: Math.max(0, Math.min(1, this._toSrgb(Math.max(0, -0.9692660*X + 1.8760108*Y + 0.0415560*Z)))),
                b: Math.max(0, Math.min(1, this._toSrgb(Math.max(0, 0.0556434*X - 0.2040259*Y + 1.0572252*Z))))
            };
        }
        getToolManifestItem(id) {
            return this.toolManifest.find(t => t.id === id) || null;
        }
        _makeEmptyRow() { return new Array(20).fill(null); }
        getDefaultToolGrid() {
            const t = [
                ['pencil','fill','wand','paintbrush'],
                ['eraser','picker','zoom','layers-toggle'],
                ['gradient','anchor-toggle','freehand','pokeproject']
            ].map(arr => { const r = this._makeEmptyRow(); arr.forEach((v,i) => r[i]=v); return r; });
            const s = [
                ['line','curve','poly','rect'],
                ['circle','tri','path',null],
                []
            ].map(arr => { const r = this._makeEmptyRow(); arr.forEach((v,i) => r[i]=v); return r; });
            return { tools: t, shapes: s };
        }
        loadToolGridLayout() {
            const raw = this.lsGet('paint.toolGridLayout');
            if (raw) {
                try {
                    const p = JSON.parse(raw);
                    if (this.validateToolGridLayout(p)) return p;
                } catch (e) { /* fall through */ }
            }
            const def = this.getDefaultToolGrid();
            this.saveToolGridLayout(def);
            return def;
        }
        saveToolGridLayout(layout) {
            this.lsSet('paint.toolGridLayout', JSON.stringify(layout));
        }
        validateToolGridLayout(layout) {
            if (!layout || typeof layout !== 'object') return false;
            if (!Array.isArray(layout.tools) || !Array.isArray(layout.shapes)) return false;
            for (const key of ['tools', 'shapes']) {
                if (layout[key].length !== 3) return false;
                for (const row of layout[key]) {
                    if (!Array.isArray(row) || row.length > 20) return false;
                    for (const cell of row) {
                        if (cell !== null && !this.getToolManifestItem(cell)) return false;
                    }
                }
            }
            return true;
        }
        _buildSlot(item, id) {
            const slot = document.createElement('div');
            slot.className = 'tool-grid-slot btn btn-icon';
            slot.dataset.toolId = id;
            slot.title = item.label;
            if (id === 'anchor-toggle') slot.classList.add('toggle-btn');
            // Dual-icon tools: render both variants, sync functions toggle visibility
            if (id === 'pencil') {
                const isSmart = this.config.pencilMode === 'smart';
                slot.innerHTML = '<span class="pencil-icon pencil-icon-standard' + (isSmart ? '' : ' show') + '"><img class="toolbar-icon" alt="" src="assets/toolbar-icons/pencil.png"></span><span class="pencil-icon pencil-icon-smart' + (isSmart ? ' show' : '') + '"><img class="toolbar-icon" alt="" src="assets/toolbar-icons/pencil-smart.png"></span>';
            } else if (id === 'pencil-smart') {
                const img = document.createElement('img'); img.className = 'toolbar-icon'; img.alt = ''; img.src = 'assets/toolbar-icons/pencil-smart.png';
                slot.appendChild(img);
            } else if (id === 'wand') {
                const isContig = this.config.wandMode === 'contiguous';
                slot.innerHTML = '<span class="wand-icon wand-icon-contig' + (isContig ? ' show' : '') + '"><img class="toolbar-icon" alt="" src="assets/toolbar-icons/wand-contig.png"></span><span class="wand-icon wand-icon-global' + (isContig ? '' : ' show') + '"><img class="toolbar-icon icon-wand-global" src="assets/toolbar-icons/wand-global.png"></span>';
            } else if (id === 'wand-global') {
                const img = document.createElement('img'); img.className = 'toolbar-icon icon-wand-global'; img.alt = ''; img.src = 'assets/toolbar-icons/wand-global.png';
                slot.appendChild(img);
            } else if (id === 'anchor-toggle') {
                if (this.config.anchorCanvas) slot.classList.add('is-on');
                slot.innerHTML = '<span class="toggle-icons"><img class="icon-off toolbar-icon" src="assets/anchor.png"><img class="icon-on toolbar-icon" src="assets/Free.png"></span>';
            } else if (item.iconSrc && item.iconSvg) {
                const img = document.createElement('img');
                img.className = 'toolbar-icon pixel-perfect';
                img.src = item.iconSrc;
                img.alt = '';
                const svg = item.iconSvg;
                img.onerror = function() { this.insertAdjacentHTML('afterend', svg); this.remove(); };
                slot.appendChild(img);
            } else if (item.iconSrc) {
                const img = document.createElement('img');
                img.className = 'toolbar-icon pixel-perfect';
                img.src = item.iconSrc;
                img.alt = '';
                slot.appendChild(img);
            } else if (item.iconSvg) {
                slot.insertAdjacentHTML('beforeend', item.iconSvg);
            }
            if (item.isToggle) {
                slot.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (id === 'anchor-toggle') this.toggleAnchorCanvas();
                    else if (id === 'layers-toggle') this.layerMgr.openPanel();
                    else if (id === 'pokeproject') this.toggleProjectPanel();
                });
            } else if (item.mode && item.mode.selectTool) {
                slot.addEventListener('click', (e) => { e.stopPropagation(); this.setSelectTool(item.mode.selectTool); });
            } else {
                slot.addEventListener('click', (e) => { e.stopPropagation(); this._activateToolFromGrid(item); });
            }
            if (id === 'pencil') {
                slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); const n = this.config.pencilMode === 'smart' ? 'standard' : 'smart'; this.setPencilMode(n); this.setTool('pencil'); });
                slot.title += '\nRight-click: switch pencil mode';
            }
            if (id === 'pencil-smart') {
                slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); this.setPencilMode('smart'); this.setTool('pencil'); });
            }
            if (id === 'wand') {
                slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); const n = this.config.wandMode === 'global' ? 'contiguous' : 'global'; this.setWandMode(n); this.setTool('wand'); });
                slot.title += '\nRight-click: switch wand mode';
            }
            if (id === 'wand-global') {
                slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); this.setWandMode('global'); this.setTool('wand'); });
            }
            if (id === 'picker') {
                slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); this.openPickerMenu(e); });
            }
            if (id === 'paintbrush') {
                slot.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); this.openPaintbrushMenu(e); });
            }
            return slot;
        }
        _renderSectionGrid(sectionKey, containerId) {
            const container = document.getElementById(containerId);
            if (!container) return;
            const layout = this.loadToolGridLayout();
            const rows = layout[sectionKey] || [];
            let maxCol = -1;
            for (const row of rows) {
                for (let ci = row.length - 1; ci >= 0; ci--) {
                    if (row[ci] !== null) { if (ci > maxCol) maxCol = ci; break; }
                }
            }
            if (maxCol < 0) { container.innerHTML = ''; return; }
            container.style.gridTemplateColumns = `repeat(${maxCol + 1}, 24px)`;
            container.innerHTML = '';
            const bound = maxCol + 1;
            rows.forEach(row => {
                let hasAny = false;
                for (let ci = 0; ci < bound; ci++) {
                    const id = ci < row.length ? row[ci] : null;
                    if (id !== null) { hasAny = true; break; }
                }
                if (!hasAny) return;
                for (let ci = 0; ci < bound; ci++) {
                    const id = ci < row.length ? row[ci] : null;
                    if (id === null) {
                        const e = document.createElement('div');
                        e.className = 'tool-grid-slot tool-slot-empty';
                        e.style.width = '24px'; e.style.height = '24px';
                        container.appendChild(e);
                    } else {
                        const item = this.getToolManifestItem(id);
                        if (item) {
                            container.appendChild(this._buildSlot(item, id));
                        } else {
                            const e = document.createElement('div');
                            e.className = 'tool-grid-slot tool-slot-empty';
                            e.style.width = '24px'; e.style.height = '24px';
                            container.appendChild(e);
                        }
                    }
                }
            });
        }
        renderToolGrid() {
            this._renderSectionGrid('tools', 'dynamic-tools-grid');
            this._renderSectionGrid('shapes', 'dynamic-shapes-grid');
            this.syncToolGridActive();
        }
        syncToolGridActive() {
            const t = this.config.tool;
            const selTool = this.config.selectTool;
            document.querySelectorAll('.tool-grid-slot.btn-icon').forEach(b => {
                b.classList.remove('active');
                const id = b.dataset.toolId;
                if (!id) return;
                const item = this.getToolManifestItem(id);
                if (!item) return;
                if (id === 'pokeproject') {
                    if (document.getElementById('project-panel')?.classList.contains('open')) b.classList.add('active');
                    return;
                }
                if (item.toolId === t) {
                    let matched = false;
                    if (item.mode && item.mode.selectTool && selTool) {
                        if (item.mode.selectTool === selTool) { b.classList.add('active'); matched = true; }
                    } else if (item.mode && item.mode.pencilMode) {
                        if (item.mode.pencilMode === this.config.pencilMode) { b.classList.add('active'); matched = true; }
                    } else if (item.mode && item.mode.wandMode) {
                        if (item.mode.wandMode === this.config.wandMode) { b.classList.add('active'); matched = true; }
                    }
                    if (!matched) {
                        const hasModeSpecific = [...document.querySelectorAll('.tool-grid-slot.btn-icon')].some(el => {
                            const eid = el.dataset.toolId;
                            if (!eid || eid === id) return false;
                            const ei = this.getToolManifestItem(eid);
                            return ei && ei.toolId === t && ei.mode;
                        });
                        if (!hasModeSpecific) b.classList.add('active');
                    }
                }
            });
        }
        _activateToolFromGrid(item) {
            if (item.mode) {
                if (item.mode.pencilMode) this.setPencilMode(item.mode.pencilMode);
                if (item.mode.wandMode) this.setWandMode(item.mode.wandMode);
            }
            if (item.toolId) {
                const _togg = item.toolId === 'freehand' || item.toolId === 'paintbrush' || item.toolId === 'gradient';
                if (_togg && this.config.tool === item.toolId) this.setTool('pencil');
                else this.setTool(item.toolId);
            }
        }
        initToolGrid() {
            this.renderToolGrid();
        }
        // ─── Tool Customizer (Modal) ──────────────────────────────────────────────
        buildToolCustomizer() {
            this._customizerTab = 'tools';
            this._customizerState = JSON.parse(JSON.stringify(this.loadToolGridLayout()));
            this._setCustomizerTab('tools');
        }
        _setCustomizerTab(tab) {
            this._customizerTab = tab;
            document.querySelectorAll('.customizer-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
            this._renderCustomizerGrid();
            this._renderCustomizerDrawer();
        }
        _renderCustomizerGrid() {
            const list = document.getElementById('tool-customizer-grid');
            if (!list) return;
            list.style.gridTemplateColumns = 'repeat(20, 28px)';
            list.innerHTML = '';
            const rows = this._customizerState[this._customizerTab];
            if (!rows) return;
            for (let ri = 0; ri < 3; ri++) {
                const row = rows[ri] || [];
                for (let ci = 0; ci < 20; ci++) {
                    const id = ci < row.length ? row[ci] : null;
                    const slot = document.createElement('div');
                    slot.className = 'customizer-slot';
                    slot.dataset.row = ri;
                    slot.dataset.col = ci;
                    if (id === null) {
                        slot.classList.add('customizer-slot-empty');
                    } else {
                        const item = this.getToolManifestItem(id);
                        if (item) {
                            slot.classList.add('customizer-slot-filled');
                            slot.title = item.label;
                            if (item.iconSrc && item.iconSvg) {
                                const img = document.createElement('img');
                                img.className = 'toolbar-icon pixel-perfect';
                                img.src = item.iconSrc;
                                img.alt = '';
                                const svg = item.iconSvg;
                                img.onerror = function() { this.insertAdjacentHTML('afterend', svg); this.remove(); };
                                slot.appendChild(img);
                            } else if (item.iconSrc) {
                                const img = document.createElement('img');
                                img.className = 'toolbar-icon pixel-perfect';
                                img.src = item.iconSrc;
                                img.alt = '';
                                slot.appendChild(img);
                            } else if (item.iconSvg) {
                                slot.insertAdjacentHTML('beforeend', item.iconSvg);
                            }
                        }
                    }
                    slot.setAttribute('draggable', 'true');
                    this._attachDnD(slot, ri, ci);
                    slot.addEventListener('dblclick', () => { this._removeItem(ri, ci); });
                    slot.addEventListener('contextmenu', (e) => { e.preventDefault(); this._removeItem(ri, ci); });
                    list.appendChild(slot);
                }
            }
        }
        _renderCustomizerDrawer() {
            const drawer = document.getElementById('tool-customizer-drawer');
            if (!drawer) return;
            const used = new Set();
            ['tools','shapes'].forEach(k => {
                (this._customizerState[k] || []).forEach(row => row.forEach(id => { if (id) used.add(id); }));
            });
            drawer.innerHTML = '';
            this.toolManifest.forEach(item => {
                if (used.has(item.id)) return;
                const el = document.createElement('div');
                el.className = 'customizer-drawer-item';
                el.title = item.label;
                el.setAttribute('draggable', 'true');
                el.dataset.drawerId = item.id;
                if (item.iconSrc && item.iconSvg) {
                    const img = document.createElement('img');
                    img.className = 'toolbar-icon pixel-perfect';
                    img.src = item.iconSrc;
                    img.alt = '';
                    const svg = item.iconSvg;
                    img.onerror = function() { this.insertAdjacentHTML('afterend', svg); this.remove(); };
                    el.appendChild(img);
                } else if (item.iconSrc) {
                    const img = document.createElement('img');
                    img.className = 'toolbar-icon pixel-perfect';
                    img.src = item.iconSrc;
                    img.alt = '';
                    el.appendChild(img);
                } else if (item.iconSvg) {
                    el.insertAdjacentHTML('beforeend', item.iconSvg);
                }
                el.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'drawer', id: item.id }));
                    e.dataTransfer.effectAllowed = 'move';
                    el.classList.add('customizer-dragging');
                });
                el.addEventListener('dragend', () => { el.classList.remove('customizer-dragging'); });
                drawer.appendChild(el);
            });
        }
        _attachDnD(slot, row, col) {
            slot.addEventListener('dragstart', (e) => {
                const tab = this._customizerTab;
                const arr = this._customizerState[tab];
                const id = (arr[row] && col < arr[row].length) ? arr[row][col] : null;
                e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'grid', row, col, id }));
                e.dataTransfer.effectAllowed = 'move';
                slot.classList.add('customizer-dragging');
            });
            slot.addEventListener('dragend', () => {
                slot.classList.remove('customizer-dragging');
                document.querySelectorAll('.customizer-slot').forEach(s => s.classList.remove('customizer-over'));
            });
            slot.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                slot.classList.add('customizer-over');
            });
            slot.addEventListener('dragleave', () => { slot.classList.remove('customizer-over'); });
            slot.addEventListener('drop', (e) => {
                e.preventDefault();
                slot.classList.remove('customizer-over');
                try {
                    const data = JSON.parse(e.dataTransfer.getData('text/plain'));
                    const tab = this._customizerTab;
                    const arr = this._customizerState[tab];
                    while (arr.length < 3) arr.push(this._makeEmptyRow());
                    while (arr[row].length < 20) arr[row].push(null);
                    if (data.type === 'drawer') {
                        arr[row][col] = data.id;
                    } else if (data.type === 'grid') {
                        const sr = data.row, sc = data.col;
                        while (arr[sr].length < 20) arr[sr].push(null);
                        const tmp = arr[row][col];
                        arr[row][col] = arr[sr][sc];
                        arr[sr][sc] = tmp;
                    }
                    this._renderCustomizerGrid();
                    this._renderCustomizerDrawer();
                } catch (ex) { /* ignore */ }
            });
        }
        _removeItem(row, col) {
            const arr = this._customizerState[this._customizerTab];
            if (arr[row] && col < arr[row].length) {
                arr[row][col] = null;
                this._renderCustomizerGrid();
                this._renderCustomizerDrawer();
            }
        }
        applyToolGridLayout() {
            if (!this._customizerState) return;
            if (!this.validateToolGridLayout(this._customizerState)) {
                showToast('Invalid layout — some tools were not recognized.', 'warning');
                return;
            }
            this.saveToolGridLayout(this._customizerState);
            this.renderToolGrid();
        }
        resetToolGridLayout() {
            const def = this.getDefaultToolGrid();
            this._customizerState = JSON.parse(JSON.stringify(def));
            if (this._customizerTab) {
                this._renderCustomizerGrid();
                this._renderCustomizerDrawer();
            }
        }
        initWebGL() {
            const c = document.createElement('canvas');
            const gl = c.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });
            if (!gl) return;

            const vs = `
                attribute vec2 a_pos;
                attribute vec2 a_tex;
                varying vec2 v_tex;
                void main() {
                    v_tex = a_tex;
                    gl_Position = vec4(a_pos, 0.0, 1.0);
                }
            `;
            const fs = `
                precision mediump float;
                uniform sampler2D u_tex;
                varying vec2 v_tex;
                void main() {
                    gl_FragColor = texture2D(u_tex, v_tex);
                }
            `;
            const compile = (type, src) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
                return s;
            };
            const vsh = compile(gl.VERTEX_SHADER, vs);
            const fsh = compile(gl.FRAGMENT_SHADER, fs);
            if (!vsh || !fsh) return;

            const prog = gl.createProgram();
            gl.attachShader(prog, vsh);
            gl.attachShader(prog, fsh);
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
            gl.useProgram(prog);

            const posBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, -1,
                1, -1,
                -1, 1,
                1, 1
            ]), gl.STATIC_DRAW);

            const texBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                0, 1,
                1, 1,
                0, 0,
                1, 0
            ]), gl.DYNAMIC_DRAW);

            const aPos = gl.getAttribLocation(prog, 'a_pos');
            const aTex = gl.getAttribLocation(prog, 'a_tex');
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.enableVertexAttribArray(aPos);
            gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
            gl.enableVertexAttribArray(aTex);
            gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 0, 0);

            gl.disable(gl.DITHER);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.CULL_FACE);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            this.gl = gl;
            this.glCanvas = c;
            this.glProgram = prog;
            this.glBuffers = { posBuf, texBuf };
        }
        _computeAntsClipRect() {
            const clipRect = this.ui.svgAntsClipRect;
            const antsWrap = this.ui.svgAntsWrap;
            if (!clipRect || !antsWrap || !this.ui.viewport) {
                return { x: 0, y: 0, w: 1000000, h: 1000000, visible: true };
            }
            const stageRect = this.ui.stage ? this.ui.stage.getBoundingClientRect() : null;
            const vpRect = this.ui.viewport.getBoundingClientRect();
            if (!stageRect || !vpRect) {
                return { x: 0, y: 0, w: 1000000, h: 1000000, visible: true };
            }
            const left   = Math.max(stageRect.left,  vpRect.left);
            const top    = Math.max(stageRect.top,   vpRect.top);
            const right  = Math.min(stageRect.right, vpRect.right);
            const bottom = Math.min(stageRect.bottom,vpRect.bottom);
            if (right <= left || bottom <= top) {
                return { x: 0, y: 0, w: 0, h: 0, visible: false };
            }
            const ctm = antsWrap.getScreenCTM ? antsWrap.getScreenCTM() : null;
            let inv = null;
            if (ctm && typeof ctm.inverse === 'function') {
                try { inv = ctm.inverse(); } catch (_) { inv = null; }
            }
            if (!inv) {
                // CTM inversion failed — fail open (no culling).
                return { x: 0, y: 0, w: 1000000, h: 1000000, visible: true };
            }
            const map = (x, y) => ({
                x: (inv.a * x) + (inv.c * y) + inv.e,
                y: (inv.b * x) + (inv.d * y) + inv.f
            });
            const p1 = map(left, top),  p2 = map(right, top);
            const p3 = map(left, bottom), p4 = map(right, bottom);
            const minX = Math.min(p1.x, p2.x, p3.x, p4.x);
            const minY = Math.min(p1.y, p2.y, p3.y, p4.y);
            const maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
            const maxY = Math.max(p1.y, p2.y, p3.y, p4.y);
            const origin = map(0, 0);
            const unitX  = map(1, 0);
            const unitY  = map(0, 1);
            const localPerPxX = Math.hypot(unitX.x - origin.x, unitX.y - origin.y);
            const localPerPxY = Math.hypot(unitY.x - origin.x, unitY.y - origin.y);
            const pad = 2 * Math.max(localPerPxX, localPerPxY, 1e-6);
            const clipLeft   = Math.floor(minX - pad);
            const clipTop    = Math.floor(minY - pad);
            const clipRight  = Math.ceil(maxX  + pad);
            const clipBottom = Math.ceil(maxY  + pad);
            const w = Math.max(0, clipRight  - clipLeft);
            const h = Math.max(0, clipBottom - clipTop);
            return { x: clipLeft, y: clipTop, w, h, visible: w > 0 && h > 0 };
        }

        /**
         * The same viewport rectangle as _computeAntsClipRect(), but expressed
         * in canvas pixels instead of screen pixels.
         *
         * _computeAntsClipRect() returns the rectangle in the ants overlay's own
         * coordinate space, which is what the SVG clipPath on #svg-ants-wrap
         * needs — that space is screen pixels, because the zoom is applied by
         * the `matrix(z 0 0 z 0 0)` transform on the paths inside the wrapper,
         * not by the wrapper itself.
         *
         * Cropping a MASK is a different job: masks are indexed in canvas
         * pixels. The two spaces coincide at 100% zoom and nowhere else, so
         * using the screen-space rectangle directly cropped the preview to a
         * corner when zoomed out and to the wrong place when zoomed in.
         */
        _antsClipRectInCanvasPx() {
            const clip = this._computeAntsClipRect();
            if (!clip || !clip.visible) return clip;
            const z = this.config.zoom || 1;
            // A pixel of slack absorbs the rounding on both conversions; the
            // SVG clip trims the overshoot anyway.
            const margin = 1;
            return {
                x: (clip.x / z) - margin,
                y: (clip.y / z) - margin,
                w: (clip.w / z) + (margin * 2),
                h: (clip.h / z) + (margin * 2),
                visible: true
            };
        }

        updateGlobalOverlays(creatingOverride = null) {
            if (this._overlayRaf) {
                cancelAnimationFrame(this._overlayRaf);
                this._overlayRaf = null;
            }
            this._pendingOverlayOverride = null;
            const z = this.config.zoom || 1;
            const isCreating = !!creatingOverride;
            // overlayUnscaled=true means the SVG overlay is drawn at screen pixels (zoom applied
            // via CSS transform on the stage). overlayUnscaled=false means the SVG itself is in
            // canvas-pixel space and the caller handles the zoom.
            const overlayUnscaled = !isCreating;
            const alignOffset = overlayUnscaled ? 0.5 : (0.5 / z);
            const overlayScale = overlayUnscaled ? z : 1;

            let selX=0, selY=0, selW=0, selH=0, hasSel=false;
            let ghostX=0, ghostY=0, ghostW=0, ghostH=0, hasGhost=false;
            if (this.state.resizePreviewActive && this.state.resizePreviewRect && this.state.resizePreviewGhost) {
                const p = this.state.resizePreviewRect;
                const g = this.state.resizePreviewGhost;
                hasSel = true;
                selX = p.x; selY = p.y;
                selW = p.w; selH = p.h;
                hasGhost = true;
                ghostX = g.x; ghostY = g.y;
                ghostW = g.w; ghostH = g.h;
            }
            if (this.ui.svgSelRect) {
                this.ui.svgSelRect.classList.toggle('svg-marquee-invert', isCreating);
                this.ui.svgSelRect.classList.toggle('marquee-blue', !isCreating);
                this.ui.svgSelRect.style.strokeWidth = '1';
                const dashBase = z >= 8 ? 12 : 4;
                const dash = overlayUnscaled ? dashBase : (dashBase / z);
                const dashPattern = `${dash} ${dash}`;
                if (isCreating) {
                    this.ui.svgSelRect.style.strokeDasharray = dashPattern;
                    this.ui.svgSelRect.style.strokeDashoffset = '0';
                    if (this.ui.svgSelRectBack) {
                        this.ui.svgSelRectBack.style.strokeDasharray = 'none';
                        this.ui.svgSelRectBack.style.strokeDashoffset = '0';
                    }
                } else {
                    this.ui.svgSelRect.style.strokeDasharray = dashPattern;
                    this.ui.svgSelRect.style.strokeDashoffset = '0';
                    if (this.ui.svgSelRectBack) {
                        this.ui.svgSelRectBack.style.strokeDasharray = dashPattern;
                        this.ui.svgSelRectBack.style.strokeDashoffset = String(dash);
                    }
                }
            }
            if (this.ui.globalSvg) {
                this.ui.globalSvg.classList.toggle('svg-marquee-invert-mode', isCreating);
                this.ui.globalSvg.classList.toggle('overlay-unscaled', overlayUnscaled);
            }

            if (!hasSel && creatingOverride) {
                hasSel = true;
                selX = creatingOverride.x; selY = creatingOverride.y;
                selW = creatingOverride.w; selH = creatingOverride.h;
            }
            else if (!hasSel && this.state.selection && this.state.selectionOriginalPos) {
                hasSel = true;
                selX = this.state.selection.x; selY = this.state.selection.y;
                selW = this.state.selection.w; selH = this.state.selection.h;
                if (this.state.dragHandle) {
                    hasGhost = true;
                    ghostX = this.state.selectionOriginalPos.x; ghostY = this.state.selectionOriginalPos.y;
                    ghostW = this.state.selectionOriginalPos.w; ghostH = this.state.selectionOriginalPos.h;
                }
            }
            else if (!hasSel && this.state.selection) {
                hasSel = true;
                selX = this.state.selection.x; selY = this.state.selection.y;
                selW = this.state.selection.w; selH = this.state.selection.h;
            }
            else if (!hasSel && this.state.activeShape && this.state.shapeEditMode) {
                hasSel = true;
                const b = this.getActiveShapeBounds(this.state.activeShape);
                selX = b.x; selY = b.y;
                selW = b.w; selH = b.h;
            }

            if (this.state.isCanvasResizing && this.state.canvasOriginalSize) {
                const currentW = parseInt(this.ui.stage.style.width, 10) || this.config.width;
                const currentH = parseInt(this.ui.stage.style.height, 10) || this.config.height;
                hasSel = true;
                selX = 0; selY = 0;
                selW = currentW; selH = currentH;
                hasGhost = true;
                const origW = this.state.canvasOriginalSize.w;
                const origH = this.state.canvasOriginalSize.h;
                const rDir = this.state.rDir || '';
                ghostW = origW;
                ghostH = origH;
                // When resizing from the left or top edge, the original content shifts right/down
                // by (newSize - origSize). The ghost rect shows where the original content lands.
                ghostX = rDir.includes('l') ? (currentW - origW) : 0;
                ghostY = rDir.includes('t') ? (currentH - origH) : 0;
            }

            const updateRect = (el, x, y, w, h, show) => {
                if (!show) { el.style.display = 'none'; return; }
                el.style.display = 'block';
                const baseX = x * overlayScale;
                const baseY = y * overlayScale;
                const snap = overlayUnscaled ? Math.round : (isCreating ? Math.round : Math.floor);
                let sx = snap(baseX) + alignOffset;
                let sy = snap(baseY) + alignOffset;
                let sw = overlayUnscaled ? Math.round(w * overlayScale) : Math.floor(w * overlayScale);
                let sh = overlayUnscaled ? Math.round(h * overlayScale) : Math.floor(h * overlayScale);
                if (sw < 0) { sx += sw; sw = Math.abs(sw); }
                if (sh < 0) { sy += sh; sh = Math.abs(sh); }
                if (isCreating && el === this.ui.svgSelRect) {
                    const inset = 0.5; // Shrink the "creating" marquee by 0.5 screen-px per edge
                                               // so it sits entirely inside the selection rather than straddling the boundary.
                    sx += inset;
                    sy += inset;
                    sw = Math.max(0, sw - (inset * 2));
                    sh = Math.max(0, sh - (inset * 2));
                }
                el.setAttribute('x', sx);
                el.setAttribute('y', sy);
                el.setAttribute('width', sw);
                el.setAttribute('height', sh);
            };

            const sel = this.state.selection || (this.state.shapeEditMode ? this.state.activeShape : null);
            const isRotating = !!(this.state.isRotatingSel || this.state.isRotatingShape);
            // Hide the marching-ants marquee while the selection is rotating.
            // Showing a straight AABB box during rotation would be misleading; it reappears
            // as the correctly-oriented AABB once the mouse is released.
            const showRect = hasSel && !(sel && sel.mask) && !isRotating;
            const showFinalRect = showRect && !isCreating;

            // For rotated selections, replace selX/Y/W/H with the AABB so the marquee
            // stays straight.
            if (showRect && sel && sel === this.state.selection) {
                const rotDeg = this.getSelectionRotationDegrees(sel);
                if (Math.abs(rotDeg) > 0.01) {
                    const cx = selX + selW / 2;
                    const cy = selY + selH / 2;
                    const corners = [
                        { x: selX,        y: selY },
                        { x: selX + selW, y: selY },
                        { x: selX + selW, y: selY + selH },
                        { x: selX,        y: selY + selH }
                    ].map(pt => this.rotatePoint(pt, { x: cx, y: cy }, rotDeg));
                    let minX = corners[0].x, maxX = corners[0].x, minY = corners[0].y, maxY = corners[0].y;
                    for (let i = 1; i < corners.length; i++) {
                        minX = Math.min(minX, corners[i].x); maxX = Math.max(maxX, corners[i].x);
                        minY = Math.min(minY, corners[i].y); maxY = Math.max(maxY, corners[i].y);
                    }
                    selX = minX; selY = minY; selW = maxX - minX; selH = maxY - minY;
                }
            }
            updateRect(this.ui.svgSelRectBack, selX, selY, selW, selH, showFinalRect);
            updateRect(this.ui.svgSelRect, selX, selY, selW, selH, showRect);
            updateRect(this.ui.svgGhostRect, ghostX, ghostY, ghostW, ghostH, hasGhost);

            if (this.ui.svgAntsPath) {
                const useCanvasMaskAnts = this.shouldUseCanvasMaskAnts();
                if (sel && sel.mask && !useCanvasMaskAnts) {
                    this.ensureSelectionOutline(sel);
                    let d = sel._maskOutlinePath || '';
                    const offX = (sel.mask.width === this.config.width && sel.mask.height === this.config.height) ? 0 : selX;
                    const offY = (sel.mask.width === this.config.width && sel.mask.height === this.config.height) ? 0 : selY;
                    const rotDeg = sel === this.state.selection ? this.getSelectionRotationDegrees(sel) : 0;
                    const hasRot = Math.abs(rotDeg) > 0.01;
                    const nudge = 0;
                    const baseTx = (offX * overlayScale);
                    const baseTy = (offY * overlayScale);
                    const tx = (overlayUnscaled ? Math.round(baseTx) : baseTx) + nudge;
                    const ty = (overlayUnscaled ? Math.round(baseTy) : baseTy) + nudge;
                    const matScale = overlayUnscaled ? z : 1;
                    let transform = `matrix(${matScale} 0 0 ${matScale} ${tx} ${ty})`;
                    if (hasRot) {
                        const rad = rotDeg * Math.PI / 180;
                        const cr = Math.cos(rad);
                        const sr = Math.sin(rad);
                        const cx = (selX + (selW / 2)) - offX;
                        const cy = (selY + (selH / 2)) - offY;
                        const a = matScale * cr;
                        const b = matScale * sr;
                        const c = matScale * -sr;
                        const dMat = matScale * cr;
                        const e = tx + (matScale * (cx - (cr * cx) + (sr * cy)));
                        const f = ty + (matScale * (cy - (sr * cx) - (cr * cy)));
                        transform = `matrix(${a} ${b} ${c} ${dMat} ${e} ${f})`;
                    }
                    const clipRect = this.ui.svgAntsClipRect;
                    const antsWrap = this.ui.svgAntsWrap;
                    const clipResult = this._computeAntsClipRect();
                    let clipX = clipResult.x;
                    let clipY = clipResult.y;
                    let clipW = clipResult.w;
                    let clipH = clipResult.h;
                    let clipVisible = clipResult.visible;
                    if (clipVisible && clipRect && antsWrap && this.ui.viewport && !hasRot) {
                        const invPathScale = 1 / Math.max(Math.abs(matScale), 1e-6);
                        const qx1 = (clipX - tx) * invPathScale;
                        const qy1 = (clipY - ty) * invPathScale;
                        const qx2 = ((clipX + clipW) - tx) * invPathScale;
                        const qy2 = ((clipY + clipH) - ty) * invPathScale;
                        const queryX = Math.floor(Math.min(qx1, qx2));
                        const queryY = Math.floor(Math.min(qy1, qy2));
                        const queryRight = Math.ceil(Math.max(qx1, qx2));
                        const queryBottom = Math.ceil(Math.max(qy1, qy2));
                        const queryW = Math.max(0, queryRight - queryX);
                        const queryH = Math.max(0, queryBottom - queryY);
                        d = this.getVisibleMaskOutlinePath(sel, queryX, queryY, queryW, queryH);
                        clipVisible = !!d;
                    } else if (!clipVisible) {
                        d = '';
                    }
                    const clip = `${clipX},${clipY},${clipW},${clipH}`;
                    const visible = !!d && clipVisible;
                    const cache = this._antsOverlayCache || { selection: null, path: '', transform: '', visible: false, clip: '0,0,0,0' };
                    const changed = cache.selection !== sel || cache.path !== d || cache.transform !== transform || cache.visible !== visible || cache.clip !== clip;
                    if (changed) {
                        if (clipRect) {
                            clipRect.setAttribute('x', String(clipX));
                            clipRect.setAttribute('y', String(clipY));
                            clipRect.setAttribute('width', String(clipW));
                            clipRect.setAttribute('height', String(clipH));
                        }
                        if (this.ui.svgAntsPathBack) {
                            this.ui.svgAntsPathBack.setAttribute('d', d);
                            this.ui.svgAntsPathBack.setAttribute('transform', transform);
                            this.ui.svgAntsPathBack.style.display = visible ? 'block' : 'none';
                        }
                        this.ui.svgAntsPath.setAttribute('d', d);
                        this.ui.svgAntsPath.setAttribute('transform', transform);
                        this.ui.svgAntsPath.style.display = visible ? 'block' : 'none';
                        this._antsOverlayCache = { selection: sel, path: d, transform, visible, clip };
                    }
                } else {
                    // Do not touch the ants elements while the wand SVG preview owns them.
                    // _clearWandSvgPreview() relinquishes control and resets the flag.
                    if (!this._wandSvgPreviewActive) {
                        const cache = this._antsOverlayCache || { selection: null, path: '', transform: '', visible: false, clip: '0,0,0,0' };
                        if (cache.visible || cache.clip !== '0,0,0,0') {
                            if (this.ui.svgAntsClipRect) {
                                this.ui.svgAntsClipRect.setAttribute('x', '0');
                                this.ui.svgAntsClipRect.setAttribute('y', '0');
                                this.ui.svgAntsClipRect.setAttribute('width', '0');
                                this.ui.svgAntsClipRect.setAttribute('height', '0');
                            }
                            if (this.ui.svgAntsPathBack) {
                                this.ui.svgAntsPathBack.style.display = 'none';
                            }
                            this.ui.svgAntsPath.style.display = 'none';
                            this._antsOverlayCache = { selection: null, path: '', transform: '', visible: false, clip: '0,0,0,0' };
                        }
                    }
                }
            }
        }

        updateEraserGhost(e) {
            if(this.config.tool !== 'eraser') {
                this.ui.stage.classList.remove('eraser-active');
                this.ui.eraserGhost.style.display = 'none';
                return;
            }

            if (!e.target.closest('#canvas-stage')) {
                this.ui.stage.classList.remove('eraser-active');
                this.ui.eraserGhost.style.display = 'none';
                return;
            }

            const rect = this.bounds;
            if(e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
                this.ui.stage.classList.remove('eraser-active');
                this.ui.eraserGhost.style.display = 'none';
                return;
            }

            this.ui.stage.classList.add('eraser-active');
            this.ui.eraserGhost.style.display = 'block';

            const size = Math.ceil(this.config.eraserWidth);
            const offset = Math.floor(size / 2);
            const z = this.config.zoom;
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const cx = Math.floor(mx / z);
            const cy = Math.floor(my / z);
            const drawX = cx - offset;
            const drawY = cy - offset;
            const screenX = rect.left + (drawX * z);
            const screenY = rect.top + (drawY * z);
            const screenSize = size * z;

            this.ui.eraserGhost.style.width = screenSize + 'px';
            this.ui.eraserGhost.style.height = screenSize + 'px';
            this.ui.eraserGhost.style.backgroundColor = this.config.c2;
            this.ui.eraserGhost.style.left = screenX + 'px';
            this.ui.eraserGhost.style.top = screenY + 'px';
            this.ui.eraserGhost.style.transform = 'none';
        }
        refreshEraserGhost() {
            if (this.config.tool !== 'eraser') return;
            if (!this.state.lastMouse) return;
            this.updateEraserGhost({
                clientX: this.state.lastMouse.clientX,
                clientY: this.state.lastMouse.clientY,
                target: this.ui.stage
            });
        }

        renderRecent() {
            this.ui.palRec.innerHTML = '';
            this.recentColors.forEach(c => this.addSwatch(this.ui.palRec, c));
            this.enforceFixedPaletteSwatchStyles();
        }

        addRecentColor(c) {
            if (this.recentColors.includes(c)) return;
            const emptyIdx = this.recentColors.indexOf(null);
            if (emptyIdx !== -1) {
                this.recentColors[emptyIdx] = c;
            } else {
                this.recentColors.push(c);
                if (this.recentColors.length > 10) this.recentColors.shift();
            }
            this.renderRecent();
        }

        getMouse(e) {
            const r = this.bounds;
            return {
                x: Math.floor((e.clientX - r.left) / this.config.zoom),
                y: Math.floor((e.clientY - r.top) / this.config.zoom)
            };
        }
        getMousePrecise(e) {
            const r = this.bounds;
            return {
                x: (e.clientX - r.left) / this.config.zoom,
                y: (e.clientY - r.top) / this.config.zoom
            };
        }
        snapPointOrtho(start, p) {
            const dx = p.x - start.x;
            const dy = p.y - start.y;
            if (Math.abs(dx) >= Math.abs(dy)) {
                return { x: p.x, y: start.y };
            }
            return { x: start.x, y: p.y };
        }
        snapPointAngle(origin, p, stepDeg) {
            const dx = p.x - origin.x;
            const dy = p.y - origin.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 1) return { x: origin.x, y: origin.y };
            const angle = Math.atan2(dy, dx);
            const stepRad = stepDeg * Math.PI / 180;
            const snapped = Math.round(angle / stepRad) * stepRad;
            return {
                x: origin.x + Math.cos(snapped) * dist,
                y: origin.y + Math.sin(snapped) * dist
            };
        }
        snapPointVerticalDiagonal(start, p) {
            const dx = p.x - start.x;
            const dy = p.y - start.y;
            if (dx === 0 && dy === 0) return { x: p.x, y: p.y };
            if (dx === 0) return { x: start.x, y: p.y };
            if (dy === 0) return { x: p.x, y: start.y };
            const vert = { x: start.x, y: p.y };
            const horiz = { x: p.x, y: start.y };
            const t1 = Math.round((dx + dy) / 2);
            const t2 = Math.round((dx - dy) / 2);
            const diag1 = { x: Math.round(start.x + t1), y: Math.round(start.y + t1) };
            const diag2 = { x: Math.round(start.x + t2), y: Math.round(start.y - t2) };
            const dVert = (vert.x - p.x) ** 2 + (vert.y - p.y) ** 2;
            const dHoriz = (horiz.x - p.x) ** 2 + (horiz.y - p.y) ** 2;
            const dDiag1 = (diag1.x - p.x) ** 2 + (diag1.y - p.y) ** 2;
            const dDiag2 = (diag2.x - p.x) ** 2 + (diag2.y - p.y) ** 2;
            const diag = dDiag1 <= dDiag2 ? diag1 : diag2;
            const diagDist = Math.min(dDiag1, dDiag2);
            if (dVert <= Math.min(dHoriz, diagDist)) return vert;
            if (dHoriz <= Math.min(dVert, diagDist)) return horiz;
            return diag;
        }
        sampleBorderColorFromImageData(imgData, w, h) {
            if (!imgData || w <= 0 || h <= 0) return null;
            const d = imgData.data;
            const samples = [];
            const add = (x, y) => {
                const idx = (y * w + x) * 4;
                samples.push((d[idx] << 16) | (d[idx+1] << 8) | d[idx+2]);
            };
            for (let x = 0; x < w; x++) {
                add(x, 0);
                if (h > 1) add(x, h - 1);
            }
            for (let y = 1; y < h - 1; y++) {
                add(0, y);
                if (w > 1) add(w - 1, y);
            }
            if (!samples.length) return null;
            const counts = new Map();
            let best = samples[0];
            let bestCount = 0;
            for (const c of samples) {
                const next = (counts.get(c) || 0) + 1;
                counts.set(c, next);
                if (next > bestCount) { bestCount = next; best = c; }
            }
            return { r: (best >> 16) & 255, g: (best >> 8) & 255, b: best & 255 };
        }
        applyTransparencyKeyToCanvas(ctx, w, h, bg, tol, mode) {
            if (!ctx || !bg) return;
            const img = ctx.getImageData(0, 0, w, h);
            const d = img.data;
            if (mode === 'all') {
                for (let i = 0; i < d.length; i += 4) {
                    if (Math.abs(d[i] - bg.r) <= tol &&
                        Math.abs(d[i+1] - bg.g) <= tol &&
                        Math.abs(d[i+2] - bg.b) <= tol) {
                        d[i+3] = 0;
                    }
                }
            } else {
                const mask = this.buildEdgeTransparencyMask(img, w, h, bg, tol);
                for (let i = 0; i < mask.length; i++) {
                    if (mask[i]) d[i*4 + 3] = 0;
                }
            }
            ctx.putImageData(img, 0, 0);
        }
        normalizeCanvasColors(ctx, w, h) {
            if (!ctx || w <= 0 || h <= 0) return;
            const img = ctx.getImageData(0, 0, w, h);
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
                d[i] = d[i] & 0xFF;
                d[i+1] = d[i+1] & 0xFF;
                d[i+2] = d[i+2] & 0xFF;
                d[i+3] = d[i+3] & 0xFF;
            }
            ctx.putImageData(img, 0, 0);
        }

        countTransparencyKeyMatches(imgData, w, h, bg, tol, mode) {
            if (!imgData || !bg) return 0;
            if (mode === 'all') {
                let count = 0;
                const d = imgData.data;
                for (let i = 0; i < d.length; i += 4) {
                    if (Math.abs(d[i] - bg.r) <= tol &&
                        Math.abs(d[i+1] - bg.g) <= tol &&
                        Math.abs(d[i+2] - bg.b) <= tol) {
                        count++;
                    }
                }
                return count;
            }
            const mask = this.buildEdgeTransparencyMask(imgData, w, h, bg, tol);
            let count = 0;
            for (let i = 0; i < mask.length; i++) if (mask[i]) count++;
            return count;
        }

        clampPointToCanvas(p) {
            return {
                x: Math.max(0, Math.min(this.config.width, p.x)),
                y: Math.max(0, Math.min(this.config.height, p.y))
            };
        }
        clampPointToCanvasPixel(p) {
            const maxX = Math.max(0, this.config.width - 1);
            const maxY = Math.max(0, this.config.height - 1);
            return {
                x: Math.max(0, Math.min(maxX, p.x)),
                y: Math.max(0, Math.min(maxY, p.y))
            };
        }

        getInclusiveRectFromPoints(a, b) {
            const minX = Math.min(a.x, b.x);
            const minY = Math.min(a.y, b.y);
            const maxX = Math.max(a.x, b.x);
            const maxY = Math.max(a.y, b.y);
            return {
                x: minX,
                y: minY,
                w: (maxX - minX) + 1,
                h: (maxY - minY) + 1
            };
        }

        getNormalizedRect(s) {
            let rx = s.x;
            let ry = s.y;
            let rw = s.w;
            let rh = s.h;
            if(rw < 0) { rx += rw; rw = Math.abs(rw); }
            if(rh < 0) { ry += rh; rh = Math.abs(rh); }
            return { x: rx, y: ry, w: rw, h: rh };
        }
        cloneCanvas(source) {
            if (!source) return null;
            const copy = document.createElement('canvas');
            copy.width = source.width;
            copy.height = source.height;
            const ctx = copy.getContext('2d');
            this.disableSmoothing(ctx);
            ctx.drawImage(source, 0, 0);
            return copy;
        }
        getAngleDegrees(from, to) {
            return Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;
        }
        getSignedAngleDelta(fromDeg, toDeg) {
            let d = (toDeg - fromDeg) % 360;
            if (d <= -180) d += 360;
            if (d > 180) d -= 360;
            return d;
        }
        normalizeAngleDegrees(deg) {
            let out = deg % 360;
            if (out <= -180) out += 360;
            if (out > 180) out -= 360;
            return out;
        }
        renderCleanEdgeRotation(source, angleDeg, options = {}) {
            if (!source) return null;
            const normalizedAngle = this.normalizeAngleDegrees(angleDeg);
            const snapAngle = Math.round(normalizedAngle / 90) * 90;
            if (Math.abs(normalizedAngle - snapAngle) < 0.0001) {
                return this.rotateCanvasNearest(source, normalizedAngle, options);
            }
            const env = this.initCleanEdgeRotateGL();
            if (!env) return this.rotateCanvasNearest(source, normalizedAngle, options);
            const srcW = Math.max(1, source.width | 0);
            const srcH = Math.max(1, source.height | 0);
            const rad = normalizedAngle * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const outW = Math.max(1, Math.ceil((Math.abs(srcW * cos) + Math.abs(srcH * sin))));
            const outH = Math.max(1, Math.ceil((Math.abs(srcW * sin) + Math.abs(srcH * cos))));
            const gl = env.gl;
            env.canvas.width = outW;
            env.canvas.height = outH;
            gl.viewport(0, 0, outW, outH);
            gl.useProgram(env.prog);
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            gl.bindBuffer(gl.ARRAY_BUFFER, env.posBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -srcW / 2, -srcH / 2,
                srcW / 2, -srcH / 2,
                -srcW / 2,  srcH / 2,
                srcW / 2,  srcH / 2
            ]), gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(env.aPosition);
            gl.vertexAttribPointer(env.aPosition, 2, gl.FLOAT, false, 0, 0);

            gl.bindBuffer(gl.ARRAY_BUFFER, env.texBuf);
            gl.enableVertexAttribArray(env.aTexcoord);
            gl.vertexAttribPointer(env.aTexcoord, 2, gl.FLOAT, false, 0, 0);

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, env.texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            gl.uniform1i(env.uImage, 0);
            gl.uniform2f(env.uOutputSize, outW, outH);
            gl.uniform1f(env.uAngle, rad);
            gl.uniform2f(env.uResolution, srcW, srcH);
            gl.uniform1i(env.uSlope, options.slope === false ? 0 : 1);
            const highestColor = options.highestColor || [1, 1, 1];
            gl.uniform3f(env.uHighestColor, highestColor[0], highestColor[1], highestColor[2]);
            gl.uniform1f(env.uSimilarThreshold, options.similarThreshold || 0);
            gl.uniform1f(env.uLineWidth, options.lineWidth || 1);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            return this.cloneCanvas(env.canvas);
        }
        _clearSelAnchorMode() {
            if (!this.state.selRotateAnchorMode) return;
            this.state.selRotateAnchorMode = false;
            const el = this.ui.selControls;
            const rotateHandle = el ? el.querySelector('.sel-rotate-handle') : null;
            el && el.classList.remove('sel-anchor-mode');
            rotateHandle && rotateHandle.classList.remove('anchor-mode');
            rotateHandle && (rotateHandle.title = 'Rotate selection');
            this._selectionUiCacheKey = null;
        }

        getP(x, y, map, w, h) {
            if (x < 0 || y < 0 || x >= w || y >= h) return 0;
            return map[y * w + x];
        }
        traceLoop(startX, startY, map, edgeMap, w, h) {
            let x = startX, y = startY;
            let dir = 3;
            const points = [];
            points.push({ x, y });
            let steps = 0;
            const maxSteps = w * h * 4;
            do {
                let leftP, rightP;
                if (dir === 0) { leftP = this.getP(x, y - 1, map, w, h); rightP = this.getP(x, y, map, w, h); }
                else if (dir === 1) { leftP = this.getP(x, y, map, w, h); rightP = this.getP(x - 1, y, map, w, h); }
                else if (dir === 2) { leftP = this.getP(x - 1, y, map, w, h); rightP = this.getP(x - 1, y - 1, map, w, h); }
                else { leftP = this.getP(x - 1, y - 1, map, w, h); rightP = this.getP(x, y - 1, map, w, h); }

                if (dir === 3 && leftP === 0 && rightP === 1) {
                    const pIdx = (y - 1) * w + x;
                    if (pIdx >= 0) edgeMap[pIdx] = 1;
                }

                if (leftP === 1) {
                    dir = (dir + 3) % 4;
                } else if (rightP === 0) {
                    dir = (dir + 1) % 4;
                } else {
                    if (dir === 0) x++;
                    else if (dir === 1) y++;
                    else if (dir === 2) x--;
                    else if (dir === 3) y--;
                    points.push({ x, y });
                }
                steps++;
            } while ((x !== startX || y !== startY) && steps < maxSteps);
            return points;
        }
        initSmartPencil() {
            if (this._smartPencilReady) return;
            this._smartPencilReady = true;
            SmartShape.init({
                mainCtx: null,
                overlayCtx: null,
                getStyle: () => this.getSmartPencilStyle(),
                onSnap: () => {
                    if (this.state.smartPencilActive) this.renderSmartPencilPreview();
                },
                onCommit: (payload) => this.handleSmartPencilCommit(payload)
            });
            SmartShape.setCurveOnly(!!this.config.smartPencilCurveOnly);
        }

        getSmartPencilStyle() {
            const isRight = this.state.smartPencilSlot === 2;
            return {
                strokeColor: this.getActiveDrawColor(isRight),
                fillColor: 'none',
                lineWidth: this.config.lineWidth,
                opacity: 1,
                doFill: false
            };
        }

        setPencilMode(mode) {
            this.config.pencilMode = mode === 'smart' ? 'smart' : 'standard';
            this.lsSet('paint.pencilMode', this.config.pencilMode);
            this.syncPencilMode();
            this.updateCursorForTool(this.config.tool);
        }

        syncPencilMode() {
            const btn = document.getElementById('pencil-tool-btn');
            if (btn) {
                const std = btn.querySelector('.pencil-icon-standard');
                const smart = btn.querySelector('.pencil-icon-smart');
                const isSmart = this.config.pencilMode === 'smart';
                if (std) std.classList.toggle('show', !isSmart);
                if (smart) smart.classList.toggle('show', isSmart);
            }
            document.querySelectorAll('.tool-grid-slot[data-tool-id="pencil"]').forEach(slot => {
                const std = slot.querySelector('.pencil-icon-standard');
                const smart = slot.querySelector('.pencil-icon-smart');
                const isSmart = this.config.pencilMode === 'smart';
                if (std) std.classList.toggle('show', !isSmart);
                if (smart) smart.classList.toggle('show', isSmart);
            });
        }

        syncSmartPencilDebugOptions() {
            const curveOnly = document.getElementById('debug-smart-pencil-curve-only');
            if (curveOnly) curveOnly.checked = !!this.config.smartPencilCurveOnly;
            SmartShape.setCurveOnly(!!this.config.smartPencilCurveOnly);
        }

        setSmartPencilCurveOnly(enabled) {
            this.config.smartPencilCurveOnly = !!enabled;
            this.lsSet('paint.smartPencilCurveOnly', this.config.smartPencilCurveOnly ? 'true' : 'false');
            this.syncSmartPencilDebugOptions();
        }

        startSmartPencilStroke(p, button) {
            this.state.smartPencilActive = true;
            this.state.smartPencilSlot = button === 2 ? 2 : 1;
            SmartShape.setEnabled(true);
            SmartShape.onPointerDown({ x: p.x, y: p.y });
            this.renderSmartPencilPreview();
        }

        finishSmartPencilStroke() {
            if (!this.state.smartPencilActive) return;
            SmartShape.onPointerUp();
            this.state.smartPencilActive = false;
            this.state.isDrawing = false;
            if (!this.state.shapeEditMode || !this.state.activeShape) {
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
            }
        }

        startSmartPencilPreviewLoop() {
            // Deprecated: smart pencil preview now renders on pointer move to avoid stutter.
        }

        stopSmartPencilPreviewLoop() {
            // Deprecated: smart pencil preview now renders on pointer move to avoid stutter.
        }

        renderSmartPencilPreview() {
            const state = SmartShape.getState();
            const phase = state.phase;
            this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
            if (!phase) return;
            const color = this.getActiveDrawColor(this.state.smartPencilSlot === 2);
            const width = this.config.lineWidth;

            if (state.rawPath && state.rawPath.length > 1) {
                const alpha = (phase === 2 || phase === 3) ? 0 : 0.9;
                if (alpha > 0) {
                    this.drawSmartPencilRawPathFast(state.rawPath, color, width, alpha);
                }
            }
            if ((phase === 2 || phase === 3) && state.snapped && state.snapped.segs) {
                const snapColor = color;
                this.drawSmartPencilSegs(state.snapped.segs, snapColor, width, true);
            }
        }

        drawSmartPencilRawPathFast(path, color, width, alpha) {
            if (path.length < 2) return;
            const pts = this.decimateSmartPencilPath(path, Math.max(1, width * 0.6));
            if (pts.length < 2) return;
            this.ctxTemp.save();
            this.ctxTemp.globalAlpha = alpha;
            for (let i = 1; i < pts.length; i++) {
                const a = pts[i - 1];
                const b = pts[i];
                this.drawBinaryLine(a.x, a.y, b.x, b.y, color, true, width, false);
            }
            this.ctxTemp.restore();
        }

        decimateSmartPencilPath(path, minDist) {
            const out = [path[0]];
            let last = path[0];
            const minD2 = minDist * minDist;
            for (let i = 1; i < path.length; i++) {
                const p = path[i];
                const dx = p.x - last.x;
                const dy = p.y - last.y;
                if ((dx * dx + dy * dy) >= minD2) {
                    out.push(p);
                    last = p;
                }
            }
            if (out[out.length - 1] !== path[path.length - 1]) {
                out.push(path[path.length - 1]);
            }
            return out;
        }

        drawSmartPencilRawPath(path, color, width, preview) {
            for (let i = 1; i < path.length; i++) {
                const a = path[i - 1];
                const b = path[i];
                this.drawBinaryLine(a.x, a.y, b.x, b.y, color, preview, width, false);
            }
        }

        drawSmartPencilSegs(segs, color, width, preview) {
            for (const seg of segs) {
                this.drawBinaryBezier(seg.p0, seg.p1, seg.p2, seg.p3, color, preview, width, false);
            }
        }

        handleSmartPencilCommit(payload) {
            const data = payload ? payload.data : null;
            if (!data || data.length === 0) {
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                return;
            }
            const color = this.getActiveDrawColor(this.state.smartPencilSlot === 2);
            const width = this.config.lineWidth;
            if (payload.type === 'freehand') {
                if (data.length > 1) {
                    this.drawSmartPencilRawPath(data, color, width, false);
                    this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                    this.saveState();
                }
                return;
            }

            const shape = this.buildActiveShapeFromSmartShape(payload.type, data, color, width);
            if (!shape) {
                this.drawSmartPencilSegs(data, color, width, false);
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                this.saveState();
                return;
            }
            this.state.activeShape = shape;
            this.state.shapeEditMode = true;
            this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
            this.renderActiveShape();
        }

        buildActiveShapeFromSmartShape(kind, segs, color, width) {
            if (!segs || !segs.length) return null;
            const k = (kind || '').toLowerCase();
            if (k === 'line' && segs[0]) {
                const p0 = segs[0].p0;
                const p3 = segs[0].p3;
                return { type: 'line', x: p0.x, y: p0.y, w: p3.x - p0.x, h: p3.y - p0.y, c: color, lw: width, colorSlot: this.state.smartPencilSlot };
            }
            if (k === 'curve' && segs[0]) {
                const s = segs[0];
                // Cubic Bezier point layout: p0 = start, p3 = end, p1 = ctrl1, p2 = ctrl2.
                const pts = [s.p0, s.p3, s.p1, s.p2];
                // Compute the tight analytical AABB of the curve (not the convex hull of control
                // points). Control points can extend well outside the visible arc, which would
                // make the selection box and hit-test rect much larger than the drawn curve.
                // cubicBezierAABB() solves the derivative for extrema and checks only those.
                const aabb = this.cubicBezierAABB(pts[0], pts[2], pts[3], pts[1]);
                let minX = aabb.minX, maxX = aabb.maxX, minY = aabb.minY, maxY = aabb.maxY;
                let w = maxX - minX; let h = maxY - minY;
                if (w === 0) w = 1;
                if (h === 0) h = 1;
                const norm = pts.map(pt => ({ x: (pt.x - minX) / w, y: (pt.y - minY) / h }));
                return { type: 'curve', x: minX, y: minY, w, h, c: color, lw: width, points: norm, colorSlot: this.state.smartPencilSlot };
            }
            if (k === 'circle' || k === 'ellipse') {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const s of segs) {
                    const pts = [s.p0, s.p1, s.p2, s.p3];
                    for (const p of pts) {
                        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
                        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
                    }
                }
                let w = maxX - minX; let h = maxY - minY;
                if (w === 0) w = 1;
                if (h === 0) h = 1;
                return { type: 'circle', x: minX, y: minY, w, h, c: color, lw: width, colorSlot: this.state.smartPencilSlot };
            }
            const polyKinds = k.includes('polygon') || k === 'triangle' || k === 'quadrilateral' || k === 'pentagon' || k === 'hexagon';
            if (polyKinds) {
                const pts = [];
                for (const s of segs) {
                    const p = s.p0;
                    const last = pts[pts.length - 1];
                    if (!last || last.x !== p.x || last.y !== p.y) pts.push({ x: p.x, y: p.y });
                }
                if (pts.length < 2) return null;
                let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
                for (let i = 1; i < pts.length; i++) {
                    minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
                    minY = Math.min(minY, pts[i].y); maxY = Math.max(maxY, pts[i].y);
                }
                let w = maxX - minX; let h = maxY - minY;
                if (w === 0) w = 1;
                if (h === 0) h = 1;
                const norm = pts.map(pt => ({ x: (pt.x - minX) / w, y: (pt.y - minY) / h }));
                return { type: 'poly', x: minX, y: minY, w, h, c: color, lw: width, points: norm, closed: true, colorSlot: this.state.smartPencilSlot };
            }
            return null;
        }

        onMouseDown(e) {
            this._lastPointerActivityAt = performance.now();
            this._lastDrawMoveAt = this._lastPointerActivityAt;
            this.flushDeferredSave();
            if (this.state.isPanning) return;
            if (e.button === 1) return;
            if (this.state.quantizeBusy) return;
            if (this.state.isFileLoading) return;
            if (this.state.previewPaletteId) {
                showToast('Exit palette preview to edit', 'warning');
                return;
            }
            this._lastPointerEvent = e;

            if(this.state.isCanvasResizing) return;
            if (this.config.tool === 'zoom') {
                if (e.button === 0) this.setZoom(0.1, e);
                if (e.button === 2) this.setZoom(-0.1, e);
                return;
            }
            const p = this.getMouse(e);
            const pp = this.getMousePrecise(e);
            if (this.config.tool === 'wand') {
                if (this.state.selection && this.getSelectionOp(e) === 'replace') {
                    this.commitSelection();
                }
                this.state.wandActive = true;
                this.state.wandStart = { x: p.x, y: p.y };
                this.state.wandStartScreen = { x: e.clientX, y: e.clientY };
                this.state.wandTol = this.config.wandTolerance || 0;
                this.state.wandBase = this.ctx.getImageData(0, 0, this.config.width, this.config.height);
                const w = this.config.width;
                const h = this.config.height;
                const data = this.state.wandBase.data;
                const startIdx = (Math.floor(p.y) * w + Math.floor(p.x)) * 4;
                const tr = data[startIdx], tg = data[startIdx + 1], tb = data[startIdx + 2], ta = data[startIdx + 3];
                const diff = new Uint8Array(w * h);
                for (let i = 0, j = 0; i < diff.length; i++, j += 4) {
                    const dr = Math.abs(data[j] - tr);
                    const dg = Math.abs(data[j + 1] - tg);
                    const db = Math.abs(data[j + 2] - tb);
                    const da = Math.abs(data[j + 3] - ta);
                    let m = dr > dg ? dr : dg;
                    m = db > m ? db : m;
                    m = da > m ? da : m;
                    diff[i] = m;
                }
                this.state.wandDiff = diff;
                this._wandEntered = this.config.wandMode === 'contiguous'
                    ? buildPriorityFlood(diff, w, h, Math.floor(p.x), Math.floor(p.y)) : null;
                const keyArr = this._wandEntered || diff;
                this._wandSortedIdx = buildSortedDiffIndex(keyArr);
                this._wandMaskBuf = new Uint8Array(w * h);
                this._wandSelectedCutoff = -1;
                this._initWandPreviewWorker(diff, keyArr, this._wandSortedIdx, w, h);
                // Preview only — the pointer is still down. Building the real
                // selection here would lift the matched pixels and leave a
                // C2-filled hole behind, and the first preview frame clears
                // cTemp (where the lifted pixels are drawn), so the hole shows
                // through as a C2-coloured blob until pointer-up rebuilds
                // everything from wandBase. The commit happens in onMouseUp.
                this.state.wandOp = this.getSelectionOp(e);
                this._scheduleWandFrame();
                return;
            }
            if(this.state.shapeEditMode && this.state.activeShape) {
                const pathHandleEl = e.target && e.target.closest ? e.target.closest('.path-handle') : null;
                if (pathHandleEl) {
                    const idx = parseInt(pathHandleEl.getAttribute('data-idx') || '0', 10);
                    const kind = pathHandleEl.getAttribute('data-kind') || '';
                    const role = pathHandleEl.getAttribute('data-role') || '';
                    const t = parseFloat(pathHandleEl.getAttribute('data-t') || '0');
                    this.state.isDrawing = true;
                    this.state.dragMode = 'edit_path';
                    this.state.activeShapePathHandle = { kind, idx, role, t };
                    this.state.shapeDragStart = { x: pp.x, y: pp.y };
                    this.state.shapeDragBase = this.cloneShapeForDrag(this.state.activeShape);
                    return;
                }
                const handleEl = e.target && e.target.closest ? e.target.closest('.sel-handle') : null;
                const hHit = handleEl ? handleEl.getAttribute('data-id') : null;
                const rotateEl = e.target && e.target.closest ? e.target.closest('.sel-rotate-handle') : null;
                if (hHit) {
                    this.state.isDrawing = true;
                    this.state.dragMode = 'resize_shape_' + hHit;
                    const s = this.state.activeShape;
                    const nr = this.getActiveShapeBounds(s);
                    this.state.shapeDragStart = { x: pp.x, y: pp.y };
                    this.state.shapeDragBase = this.cloneShapeForDrag(s);
                    // resizeAnchor is the canvas coordinate of the edge opposite the
                    // handle being dragged. It stays fixed so that only the dragged edge moves.
                    this.state.shapeResizeAnchor = {
                        x: hHit.includes('w') ? nr.x + nr.w : nr.x,
                        y: hHit.includes('n') ? nr.y + nr.h : nr.y
                    };
                    this.state.shapeResizeBase = {
                        x: s.x, y: s.y, w: s.w, h: s.h,
                        bounds: { x: nr.x, y: nr.y, w: nr.w, h: nr.h },
                        baseShape: this.state.shapeDragBase
                    };
                    return;
                }
                if (rotateEl) {
                    this.beginShapeRotation(this.getMousePrecise(e), e);
                    return;
                }

                if(this.pointInActiveShapeRect(p.x, p.y, this.state.activeShape)) {
                    if (this.config.dragRotate) {
                        this.beginShapeRotation(this.getMousePrecise(e), e);
                    } else {
                        this.state.isDrawing = true;
                        this.state.dragMode = 'move_shape';
                        this.state.selStart = {x: p.x, y: p.y};
                        this.state.shapeDragStart = { x: pp.x, y: pp.y };
                        this.state.shapeDragBase = this.cloneShapeForDrag(this.state.activeShape);
                    }
                    return;
                }
                // The click hit the AABB overlay (#selection-controls) but missed the
                // actual rotated shape geometry. Do not commit the shape — treat it as a
                // move or rotate gesture on the shape bounding box.
                if (e.target && e.target.closest && e.target.closest('#selection-controls')) {
                    const rot = this.getShapeRotationDegrees(this.state.activeShape);
                    if (Math.abs(rot) > 0.01) {
                        if (this.config.dragRotate) {
                            this.beginShapeRotation(this.getMousePrecise(e), e);
                        } else {
                            this.state.isDrawing = true;
                            this.state.dragMode = 'move_shape';
                            this.state.selStart = {x: p.x, y: p.y};
                            this.state.shapeDragStart = { x: pp.x, y: pp.y };
                            this.state.shapeDragBase = this.cloneShapeForDrag(this.state.activeShape);
                        }
                        return;
                    }
                }
                this.commitActiveShape();
            }
            if(this.state.selection) {
                // When gradient tool is active, clicking inside the selection starts
                // gradient placement — don't move/resize the selection.
                if (this.config.tool !== 'gradient') {
                const handleEl = e.target && e.target.closest ? e.target.closest('.sel-handle') : null;
                const hHit = handleEl ? handleEl.getAttribute('data-id') : null;
                const rotateEl = e.target && e.target.closest ? e.target.closest('.sel-rotate-handle') : null;

                if(hHit) {
                    // If the selection is rotated, stamp it to raster and re-lift as a
                    // straight AABB first so resize math works in screen-aligned coords.
                    if (Math.abs(this.getSelectionRotationDegrees(this.state.selection)) > 0.01) {
                        this.commitSelectionRotationInPlace();
                    }
                    // Bake the current flip state (negative w or h) into the canvas pixels
                    // before starting a new resize operation. If the flip is left as a logical
                    // negative dimension, dragging a different handle would silently revert it
                    // because the resize math always works in positive-rect space.
                    this.normalizeSelectionFlipInPlace();
                    this.state.isDrawing = true;
                    this.state.dragHandle = hHit;
                    this.state.selectionOriginalPos = { x: this.state.selection.x, y: this.state.selection.y, w: this.state.selection.w, h: this.state.selection.h, rotation: this.getSelectionRotationDegrees(this.state.selection) };
                    const nr = this.getNormalizedRect(this.state.selection);
                    this.state.resizeAnchor = { x: (hHit.includes('w') ? nr.x + nr.w : nr.x), y: (hHit.includes('n') ? nr.y + nr.h : nr.y) };
                    return;
                }
                if (rotateEl) {
                    this.beginSelectionRotation(this.getMousePrecise(e), e);
                    return;
                }

                if(this.pointInSelection(p.x, p.y, this.state.selection)) {
                    if(e.ctrlKey && !this.state.selRotateAnchorMode) {
                        // Ctrl+drag: stamp (flatten) the current selection onto the canvas and
                        // then move a copy. Works regardless of dragRotate or anchor mode.
                        this.state.isMovingSel = true;
                        this.state.selStart = {x: p.x, y: p.y};
                        this.state.selectionOriginalPos = { x: this.state.selection.x, y: this.state.selection.y, w: this.state.selection.w, h: this.state.selection.h, rotation: this.getSelectionRotationDegrees(this.state.selection) };
                        this.stampSelection();
                    } else if (this.config.dragRotate || this.state.selRotateAnchorMode) {
                        this.beginSelectionRotation(this.getMousePrecise(e), e);
                    } else {
                        this.state.isMovingSel = true;
                        this.state.selStart = {x: p.x, y: p.y};
                        this.state.selectionOriginalPos = { x: this.state.selection.x, y: this.state.selection.y, w: this.state.selection.w, h: this.state.selection.h, rotation: this.getSelectionRotationDegrees(this.state.selection) };
                    }
                    return;
                }

                // The click landed inside the bounding-box overlay (selection-controls div)
                // but pointInSelection() returned false — meaning the user clicked a corner
                // of the axis-aligned bounding box that falls outside the rotated content.
                // Treat this as a click inside: start a move (or rotation in dragRotate/anchor
                // mode) rather than committing the selection.
                if (e.target && e.target.closest && e.target.closest('#selection-controls')) {
                    const rot = this.getSelectionRotationDegrees(this.state.selection);
                    if (this.config.dragRotate || this.state.selRotateAnchorMode) {
                        this.beginSelectionRotation(this.getMousePrecise(e), e);
                    } else {
                        this.state.isMovingSel = true;
                        this.state.selStart = {x: p.x, y: p.y};
                        this.state.selectionOriginalPos = { x: this.state.selection.x, y: this.state.selection.y, w: this.state.selection.w, h: this.state.selection.h, rotation: rot };
                    }
                    return;
                }

                if (this.config.tool === 'select') {
                    this.commitSelection();
                    this.state.isDrawing = true;
                    const cp = this.clampPointToCanvasPixel(p);
                    this.state.startPos = { x: cp.x, y: cp.y };
                    this.ui.selControls.classList.add('creating');
                    this.updateSelectionUI(this.state.startPos.x, this.state.startPos.y, 0, 0, 0);
                    this.setStatusSelectionSize(0, 0);
                    this.requestGlobalOverlayUpdate({x:this.state.startPos.x, y:this.state.startPos.y, w:0, h:0});
                    return;
                }
                if (this.config.tool === 'lasso') {
                    this.commitSelection();
                } else {
                    this.commitSelection();
                    return;
                }
                } // end gradient guard
            }
            if (this.config.tool === 'lasso') {
                if (!this.state.lassoActive) {
                    this.startLassoSelection(p);
                } else if (this.state.lassoMode === 'poly') {
                    if (e.button === 2) {
                        this.finalizeLassoSelection();
                        return;
                    }
                    this.appendLassoPoint(p);
                }
                this.renderLassoPreview(p);
                return;
            }
            if(e.button !== 0 && e.button !== 2) return;
            if(this.state.shapeEditMode) this.commitActiveShape();

            if(this.config.tool === 'poly') {
                if (e.button !== 0) return;
                if (!this.state.polyActive) {
                    this.state.polyActive = true;
                    this.state.polyPoints = [{ x: p.x, y: p.y }];
                    this.state.isDrawing = true;
                    this.state.startPos = { x: p.x, y: p.y };
                    this.renderPolylinePreview(p);
                    return;
                }
                let nextPoint = { x: p.x, y: p.y };
                if (e.ctrlKey && this.state.polyPoints.length > 0) {
                    nextPoint = { x: this.state.polyPoints[0].x, y: this.state.polyPoints[0].y };
                }
                this.state.polyPoints.push(nextPoint);
                if (e.detail >= 2) {
                    this.commitPolyline();
                    return;
                }
                if (e.ctrlKey) {
                    this.commitPolyline();
                    return;
                }
                this.renderPolylinePreview(p);
                return;
            }

            if (this.config.tool === 'pencil' && this.config.pencilMode === 'smart') {
                if (e.button !== 0 && e.button !== 2) return;
                this.state.isDrawing = true;
                this.startSmartPencilStroke(p, e.button);
                return;
            }

            this.state.isDrawing = true;
            if (this.config.tool === 'select') {
                const cp = this.clampPointToCanvasPixel(p);
                this.state.startPos = { x: cp.x, y: cp.y };
            } else {
                this.state.startPos = { x: p.x, y: p.y };
            }
            if (this.config.tool === 'pencil') {
                this.state.pencilCtrlAxis = null;
            }

            if(this.config.tool === 'select') {
                this.ui.selControls.classList.add('creating');
                this.updateSelectionUI(this.state.startPos.x, this.state.startPos.y, 0, 0, 0);
                this.requestGlobalOverlayUpdate({x:this.state.startPos.x, y:this.state.startPos.y, w:0, h:0});
                return;
            }

            if(this.config.tool === 'curve') {
                this.state.curveDrawSlot = e.button === 2 ? 2 : 1;
                if(this.state.curvePhase===0) this.state.curvePts = [{x:p.x,y:p.y}, {x:p.x,y:p.y}];
                return;
            }

            if(this.config.tool === 'path') {
                if (e.button !== 0 && e.button !== 2) return;
                const pos = { x: p.x, y: p.y, pressure: e.pressure || 0.5 };
                const bounds = this.bounds;
                const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents().map(ce => ({
                    x: (ce.clientX - bounds.left) / this.config.zoom,
                    y: (ce.clientY - bounds.top) / this.config.zoom,
                    pressure: ce.pressure || 0.5
                })) : null;
                FreehandPathEngine.init({
                    draftCtx: this.ctxTemp,
                    mainCtx: null,  // don't auto-render — we use drawBinaryBezier via activeShape
                    color: this.getActiveDrawColor(e.button === 2),
                    lineWidth: this.config.shapeWidth,
                    onCommit: null
                });
                FreehandPathEngine.onPointerDown(pos);
                this.state.isDrawing = true;
                this.state.freehandPathActive = true;
                this.state.freehandPathSlot = e.button === 2 ? 2 : 1;
                return;
            }

            if (this.config.tool === 'freehand') {
                if (e.button !== 0 && e.button !== 2) return;
                this.state.isDrawing = true;
                this.state.freehandActive = true;
                this.state.freehandSlot = e.button === 2 ? 2 : 1;
                this.state.freehandPoints = [];
                this._freehandInputPoints = [];
                this._freehandStrokePoints = null;
                this._fhPreviewing = false;
                this.state.freehandPoints.push({ x: p.x, y: p.y, pressure: e.pressure != null ? e.pressure : 0.5 });
                this.scheduleFreehandPreview();
                return;
            }

            if (this.config.tool === 'paintbrush') {
                if (e.button !== 0 && e.button !== 2) return;
                this.state.isDrawing = true;
                this.state.paintbrushActive = true;
                this.state.paintbrushSlot = e.button === 2 ? 2 : 1;
                if (this.brush && this.brush.beginStroke) {
                    this.brush.beginStroke(pp.x, pp.y, e.pressure != null ? e.pressure : 0.5, this.getActiveDrawColor(this.state.paintbrushSlot === 2));
                }
                return;
            }

            const isRight = e.button===2;
            const color = this.getActiveDrawColor(isRight || this.config.tool==='eraser');

            if(['pencil','eraser'].includes(this.config.tool)) {
                if(this.config.tool==='eraser') {
                    if(isRight) this.replaceColorAt(p.x, p.y);
                    else this.drawBinaryPoint(p.x, p.y, color);
                } else {
                    this.drawBinaryPoint(p.x, p.y, color);
                }
                this.updateHoverPreview(p.x, p.y);
            } else if(this.config.tool==='fill') {
                this.floodFill(Math.floor(p.x), Math.floor(p.y), this.hexToRgb(color));
                this.state.isDrawing=false;
                this.updateHoverPreview(p.x, p.y);
            } else if(this.config.tool==='gradient') {
                const _g = this.config.gradient;
                if (_g.active) {
                    if (e.button === 2) {
                        this.gradientDiscard();
                        e.preventDefault();
                        return;
                    }
                    if (e.button === 0) {
                        const _dStart = Math.hypot(p.x - _g.startX, p.y - _g.startY);
                        const _dEnd   = Math.hypot(p.x - _g.endX,   p.y - _g.endY);
                        const _hitR   = GRAD_HANDLE_RADIUS + 6;
                        const _mp  = (_g.midpoint != null) ? _g.midpoint : 0.5;
                        const _mpx = _g.startX + (_g.endX - _g.startX) * _mp;
                        const _mpy = _g.startY + (_g.endY - _g.startY) * _mp;
                        const _dMid = Math.hypot(p.x - _mpx, p.y - _mpy);
                        if (_dMid <= _hitR && _dMid < _dStart && _dMid < _dEnd) {
                            _g.draggingHandle = 'midpoint';
                            e.preventDefault();
                            return;
                        }
                        if (_dStart <= _hitR || _dEnd <= _hitR) {
                            _g.draggingHandle = _dStart <= _dEnd ? 'start' : 'end';
                            e.preventDefault();
                            return;
                        }
                        this.gradientApply();
                        e.preventDefault();
                        return;
                    }
                    return;
                }
                // Start placing a new gradient
                if (e.button !== 0) return;
                _g.isPlacing = true;
                _g.active = false;
                _g.draggingHandle = null;
                _g.midpoint = 0.5;
                _g.startX = p.x; _g.startY = p.y;
                _g.endX   = p.x; _g.endY   = p.y;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                // Sync slider back to 50%
                const _slReset = document.getElementById('grad-midpoint');
                const _lbReset = document.getElementById('grad-midpoint-val');
                if (_slReset) _slReset.value = 50;
                if (_lbReset) _lbReset.textContent = '50%';
                e.preventDefault();
                return;
            } else if(this.config.tool==='picker') {
                this.state.pickerArmed = true;
                this.state.pickerSlot = isRight ? 2 : 1;
                this.state.isDrawing = false;
                this.updatePickerPreviewAt((e.clientX - this.bounds.left - 2) / this.config.zoom, p.y);
            }
        }

        onMouseMove(e) {
            this._lastMouseMoveAt = performance.now();
            this._lastPointerActivityAt = this._lastMouseMoveAt;
            const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
            const lastEvent = (coalesced && coalesced.length) ? coalesced[coalesced.length - 1] : e;
            this.state.lastMouse = { clientX: lastEvent.clientX, clientY: lastEvent.clientY };
            if (this.config.tool === 'picker' && this.state.pickerArmed) {
                const p = this.getMouse(lastEvent);
                this.setCoordsStatus(p.x, p.y);
                const now = performance.now();
                if (now - (this.state.pickerPreviewLastSample || 0) >= 16) {
                    this.state.pickerPreviewLastSample = now;
                    this.updatePickerPreviewAt((lastEvent.clientX - this.bounds.left - 2) / this.config.zoom, p.y);
                }
                if (this.ui.pickerDot) {
                    this.ui.pickerDot.style.display = 'block';
                    this.ui.pickerDot.style.left = `${lastEvent.clientX}px`;
                    this.ui.pickerDot.style.top = `${lastEvent.clientY}px`;
                }
                this._lastPointerEvent = lastEvent;
                return;
            }
            this.updateEraserGhost(e);
            this._lastPointerEvent = lastEvent;
            if (this.ui.pickerDot) {
                if (this.config.tool === 'picker') {
                    this.ui.pickerDot.style.display = 'block';
                    this.ui.pickerDot.style.left = `${lastEvent.clientX}px`;
                    this.ui.pickerDot.style.top = `${lastEvent.clientY}px`;
                } else {
                    this.ui.pickerDot.style.display = 'none';
                }
            }

            if(this.state.isPanning) {
                e.preventDefault();
                const dx = e.clientX - this.state.panStart.x;
                const dy = e.clientY - this.state.panStart.y;
                this.ui.viewport.scrollLeft = this.state.scrollStart.x - dx;
                this.ui.viewport.scrollTop = this.state.scrollStart.y - dy;
                this.requestGlobalOverlayUpdate();
                return;
            }
            if (this.state.isCanvasDragging) {
                e.preventDefault();
                const dx = e.clientX - this.state.canvasDragStart.x;
                const dy = e.clientY - this.state.canvasDragStart.y;
                this.state.canvasOffset = this.clampCanvasOffset({
                    x: this.state.canvasOffsetStart.x + dx,
                    y: this.state.canvasOffsetStart.y + dy
                });
                this.applyStageTransform();
                this.updateBounds();
                this.requestGlobalOverlayUpdate();
                this.requestGridOverlayUpdate();
                return;
            }

            if(this.state.isCanvasResizing) { this.doCanvasResize(e); return; }
            const p = this.getMouse(e);
            const pp = this.getMousePrecise(e);
            this.setCoordsStatus(p.x, p.y);
            if (this.config.tool === 'pencil' && !e.ctrlKey && this.state.pencilCtrlAxis) {
                this.state.pencilCtrlAxis = null;
            }

            if (this.config.tool === 'lasso' && this.state.lassoActive) {
                if (this.state.lassoMode === 'free' && this.state.lassoIsDown) {
                    const last = this.state.lassoPoints[this.state.lassoPoints.length - 1];
                    const dx = last ? p.x - last.x : 0;
                    const dy = last ? p.y - last.y : 0;
                    if (!last || (dx * dx + dy * dy) >= 1) {
                        this.appendLassoPoint(p);
                    }
                }
                this.renderLassoPreview(p);
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if (this.state.wandActive && this.config.tool === 'wand') {
                const dx = e.clientX - this.state.wandStartScreen.x;
                const base = this.config.wandTolerance;
                const tol = Math.max(0, Math.min(255, Math.round((base + dx / 3.3333333333) * 10) / 10));
                if (tol !== this.state.wandTol) {
                    this.state.wandTol = tol;
                    this.state.wandOp = this.getSelectionOp(e);
                    this.updateWandThreshold(tol, { setConfig: false, applySelection: false });
                    this._scheduleWandFrame();
                }
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if (this.state.smartPencilActive && this.config.tool === 'pencil' && this.config.pencilMode === 'smart') {
                SmartShape.onPointerMove({ x: p.x, y: p.y });
                this.renderSmartPencilPreview();
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if (this.state.isRotatingSel) {
                this.updateSelectionRotation(this.getMousePrecise(e), e);
                return;
            }
            if (this.state.isRotatingShape) {
                this.updateShapeRotation(this.getMousePrecise(e), e);
                return;
            }
            if(!this.state.isDrawing && !this.state.isMovingSel) {
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if(this.config.tool === 'poly' && this.state.polyActive) {
                if (e.ctrlKey && this.state.polyPoints.length > 0) {
                    this.renderPolylinePreview(this.state.polyPoints[0]);
                } else {
                    this.renderPolylinePreview(p);
                }
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if(this.state.shapeEditMode && this.state.activeShape) {
                if(this.state.dragMode === 'move_shape') {
                    const base = this.state.shapeDragBase;
                    const start = this.state.shapeDragStart;
                    if (base && start) {
                        const dx = pp.x - start.x;
                        const dy = pp.y - start.y;
                        // Pixel-snap the position only for whole-shape moves (selection-box drag).
                        // Path handle edits and rotations stay sub-pixel so control points stay accurate.
                        this.state.activeShape.x = Math.round(base.x + dx);
                        this.state.activeShape.y = Math.round(base.y + dy);
                    }
                } else if (this.state.dragMode === 'edit_path' && this.state.activeShapePathHandle) {
                    this.updateActiveShapePathHandle(this.state.activeShapePathHandle, pp, this.state.shapeDragBase);
                } else if(this.state.dragMode && this.state.dragMode.startsWith('resize_shape')) {
                    const type = this.state.dragMode.split('_')[2];
                    const s = this.state.activeShape;
                    const cp = this.clampPointToCanvasPixel(pp);
                    const base = this.state.shapeResizeBase;
                    const baseBounds = base && base.bounds ? base.bounds : this.getActiveShapeBounds(s);
                    // baseBounds is always a normalised rect: .x/.y = visual top-left, .w/.h > 0.
                    const baseShapeW = (base && typeof base.w === 'number') ? base.w : s.w;
                    const baseShapeH = (base && typeof base.h === 'number') ? base.h : s.h;
                    // anchor = the fixed opposite visual edge, set on mousedown from the normalised rect.
                    const anchor = this.state.shapeResizeAnchor || { x: baseBounds.x, y: baseBounds.y };

                    const rotSource = base && base.baseShape ? base.baseShape : s;
                    const rot = this.getShapeRotationDegrees(rotSource);
                    if (Math.abs(rot) > 0.01) {
                        // Rotated path: recompute scale from visual bounds and delegate to point-transform.
                        let boundsW = baseBounds.w;
                        let boundsH = baseBounds.h;
                        if (type.includes('w')) { boundsW = anchor.x - cp.x; }
                        else if (type.includes('e')) { boundsW = cp.x - anchor.x; }
                        if (type.includes('n')) { boundsH = anchor.y - cp.y; }
                        else if (type.includes('s')) { boundsH = cp.y - anchor.y; }
                        // Keep the sign so that crossing the anchor produces a negative scale,
                        // which mirrors the shape through the anchor point (flip behaviour).
                        // Only clamp the magnitude to avoid a zero/degenerate shape.
                        const signX = boundsW < 0 ? -1 : 1;
                        const signY = boundsH < 0 ? -1 : 1;
                        const scaleX = signX * Math.max(1, Math.abs(boundsW)) / Math.max(1, baseBounds.w);
                        const scaleY = signY * Math.max(1, Math.abs(boundsH)) / Math.max(1, baseBounds.h);
                        // Use the fixed anchor corner (opposite edge from the handle being dragged)
                        // as the scaling pivot so the far edge stays stationary during the drag.
                        this.applyAabbScaleToShape(s, anchor, scaleX, scaleY, base && base.baseShape ? base.baseShape : null);
                    } else {
                        // Unrotated path.
                        //
                        // The renderer maps shape coords to canvas as:
                        //   world_x = s.x + pt.x * s.w   (pt.x in [0,1] for curve/poly)
                        //   world_x = s.x  or  s.x + s.w  (for rect/tri/circle endpoints)
                        //
                        // So {s.x, s.x+s.w} are the two horizontal canvas endpoints of the bounding box,
                        // and {s.y, s.y+s.h} are the two vertical endpoints — regardless of sign.
                        // Negative s.w/s.h flips the normalised control points (mirror effect).
                        //
                        // Strategy: fix one endpoint at anchor, move the other to follow the cursor.
                        // The "cross" flag tracks whether the cursor has passed the anchor, which
                        // inverts the flip state vs the base shape.
                        //
                        // For a handle on this axis: dragged endpoint = cp, fixed endpoint = anchor.x.
                        // For no handle on this axis: both endpoints stay at base values.

                        // --- X axis ---
                        let nextW, nextX;
                        if (type.includes('w') || type.includes('e')) {
                            // cursor has crossed the anchor when it moves to the anchor's own side
                            const crossX = type.includes('w') ? cp.x > anchor.x : cp.x < anchor.x;
                            const signW = (baseShapeW < 0) !== crossX ? -1 : 1;
                            // magnitude = distance between the two endpoints, minimum 1px
                            const magW = Math.max(1, Math.abs(cp.x - anchor.x));
                            nextW = magW * signW;
                            // s.x is the canvas x-coordinate of the pt.x=0 endpoint:
                            //   signW > 0 (unflipped): pt.x=0 maps to the left/min edge
                            //   signW < 0 (flipped):   pt.x=0 maps to the right/max edge
                            // This keeps normalised control points (0..1) rendering correctly
                            // whether or not the shape has been mirrored.
                            nextX = signW >= 0 ? Math.min(anchor.x, cp.x) : Math.max(anchor.x, cp.x);
                        } else {
                            // axis not being resized — preserve base endpoints exactly
                            nextW = baseShapeW;
                            nextX = base ? base.x : s.x;
                        }

                        // --- Y axis ---
                        let nextH, nextY;
                        if (type.includes('n') || type.includes('s')) {
                            const crossY = type.includes('n') ? cp.y > anchor.y : cp.y < anchor.y;
                            const signH = (baseShapeH < 0) !== crossY ? -1 : 1;
                            const magH = Math.max(1, Math.abs(cp.y - anchor.y));
                            nextH = magH * signH;
                            nextY = signH >= 0 ? Math.min(anchor.y, cp.y) : Math.max(anchor.y, cp.y);
                        } else {
                            nextH = baseShapeH;
                            nextY = base ? base.y : s.y;
                        }

                        s.x = nextX; s.y = nextY; s.w = nextW; s.h = nextH;
                    }
                }
                this.renderActiveShape();
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if(this.state.isMovingSel) {
                const dx = p.x - this.state.selStart.x;
                const dy = p.y - this.state.selStart.y;
                if(dx !== 0 || dy !== 0) {
                    this.state.selection.x += dx; this.state.selection.y += dy;
                    this.state.selStart.x += dx; this.state.selStart.y += dy;
                    if(e.shiftKey) this.stampSelection();
                    this.requestSelectionRenderFast();
                }
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if(this.state.selection && this.state.dragHandle) {
                const s = this.state.selection;
                const h = this.state.dragHandle;
                const anchor = this.state.resizeAnchor;
                const cp = this.clampPointToCanvasPixel(p);
                let newX = s.x, newY = s.y, newW = s.w, newH = s.h;

                if (h.includes('w')) {
                    newX = cp.x; newW = anchor.x - cp.x;
                } else if (h.includes('e')) {
                    newX = anchor.x; newW = cp.x - anchor.x;
                }

                if (h.includes('n')) {
                    newY = cp.y; newH = anchor.y - cp.y;
                } else if (h.includes('s')) {
                    newY = anchor.y; newH = cp.y - anchor.y;
                }

                if (e.ctrlKey && (h.includes('w') || h.includes('e')) && (h.includes('n') || h.includes('s'))) {
                    const size = Math.min(Math.abs(newW), Math.abs(newH));
                    newW = (newW < 0 ? -1 : 1) * size;
                    newH = (newH < 0 ? -1 : 1) * size;
                    if (h.includes('w')) {
                        newX = anchor.x - newW;
                    } else if (h.includes('e')) {
                        newX = anchor.x;
                    }
                    if (h.includes('n')) {
                        newY = anchor.y - newH;
                    } else if (h.includes('s')) {
                        newY = anchor.y;
                    }
                }

                s.x = newX; s.y = newY; s.w = newW; s.h = newH;
                const nr = this.getNormalizedRect(s);
                const maxX = Math.max(0, this.config.width - nr.w);
                const maxY = Math.max(0, this.config.height - nr.h);
                nr.x = Math.min(Math.max(nr.x, 0), maxX);
                nr.y = Math.min(Math.max(nr.y, 0), maxY);
                if (s.w < 0) s.x = nr.x - s.w;
                else s.x = nr.x;
                if (s.h < 0) s.y = nr.y - s.h;
                else s.y = nr.y;
                this.updateSelectionUI(s.x, s.y, s.w, s.h, this.getSelectionRotationDegrees(s));
                this.requestSelectionRenderFast();
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if(this.config.tool === 'gradient' && (this.config.gradient.isPlacing || this.config.gradient.draggingHandle)) {
                const _g = this.config.gradient;
                if (_g.isPlacing) {
                    // Constrain to 45° increments if Shift held
                    if (e.shiftKey) {
                        const _snap = this.snapPointOrtho({ x: _g.startX, y: _g.startY }, p);
                        _g.endX = _snap.x; _g.endY = _snap.y;
                    } else {
                        _g.endX = p.x; _g.endY = p.y;
                    }
                } else if (_g.draggingHandle === 'start') {
                    if (e.ctrlKey) {
                        const _snap = this.snapPointAngle({ x: _g.endX, y: _g.endY }, p, 22.5);
                        _g.startX = _snap.x; _g.startY = _snap.y;
                    } else {
                        _g.startX = p.x; _g.startY = p.y;
                    }
                } else if (_g.draggingHandle === 'end') {
                    if (e.ctrlKey) {
                        const _snap = this.snapPointAngle({ x: _g.startX, y: _g.startY }, p, 22.5);
                        _g.endX = _snap.x; _g.endY = _snap.y;
                    } else {
                        _g.endX = p.x; _g.endY = p.y;
                    }
                } else if (_g.draggingHandle === 'midpoint') {
                    // Project mouse onto the gradient axis and clamp to [0.01, 0.99]
                    const _dx = _g.endX - _g.startX, _dy = _g.endY - _g.startY;
                    const _len2 = _dx * _dx + _dy * _dy;
                    if (_len2 > 0) {
                        const _t = Math.max(0.01, Math.min(0.99,
                            ((p.x - _g.startX) * _dx + (p.y - _g.startY) * _dy) / _len2));
                        _g.midpoint = _t;
                        // Sync ribbon slider + label
                        const _slEl = document.getElementById('grad-midpoint');
                        const _lbEl = document.getElementById('grad-midpoint-val');
                        if (_slEl) _slEl.value = Math.round(_t * 100);
                        if (_lbEl) _lbEl.textContent = Math.round(_t * 100) + '%';
                    }
                }
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                _gradientRender(this.ctxTemp, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                this._clipGradientToSelection();
                this._gradientDrawVectorSVG();
                return;
            }
            // Cursor hint: change cursor when hovering near a handle
            // Also guard here so the unconditional ctxTemp.clearRect below never wipes an active gradient
            if (this.config.tool === 'gradient' && this.config.gradient.active) {
                const _g = this.config.gradient;
                const _dS = Math.hypot(p.x - _g.startX, p.y - _g.startY);
                const _dE = Math.hypot(p.x - _g.endX,   p.y - _g.endY);
                const _mp2  = (_g.midpoint != null) ? _g.midpoint : 0.5;
                const _mpx2 = _g.startX + (_g.endX - _g.startX) * _mp2;
                const _mpy2 = _g.startY + (_g.endY - _g.startY) * _mp2;
                const _dM = Math.hypot(p.x - _mpx2, p.y - _mpy2);
                this.ui.stage.style.cursor = (_dS <= GRAD_HANDLE_RADIUS + 6 || _dE <= GRAD_HANDLE_RADIUS + 6 || _dM <= GRAD_HANDLE_RADIUS + 6) ? 'move' : 'crosshair';
                return; // gradient is live on ctxTemp — don't let shape-tool code clear it
            }
            if(this.config.tool === 'curve') {
                this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                const color = this.getActiveDrawColor(this.state.curveDrawSlot === 2);
                if(this.state.curvePhase===0) {
                    const q = e.ctrlKey ? this.snapPointVerticalDiagonal(this.state.curvePts[0], p) : p;
                    this.state.curvePts[1] = { x: q.x, y: q.y };
                    this.state.curvePreviewPoint = { x: q.x, y: q.y };
                    this.drawBinaryLine(this.state.curvePts[0].x, this.state.curvePts[0].y, q.x, q.y, color, true, this.config.shapeWidth, false);
                } else if(this.state.curvePhase===1) {
                    this.state.curvePreviewPoint = { x: p.x, y: p.y };
                    this.drawBinaryBezier(this.state.curvePts[0], {x:p.x,y:p.y}, {x:p.x,y:p.y}, this.state.curvePts[1], color, true, this.config.shapeWidth, false);
                } else if(this.state.curvePhase===2) {
                    this.state.curvePreviewPoint = { x: p.x, y: p.y };
                    this.drawBinaryBezier(this.state.curvePts[0], this.state.curvePts[2], {x:p.x,y:p.y}, this.state.curvePts[1], color, true, this.config.shapeWidth, false);
                }
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if(this.config.tool === 'path' && FreehandPathEngine.isActive()) {
                const pos = { x: p.x, y: p.y, pressure: e.pressure || 0.5 };
                const bounds = this.bounds;
                const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents().map(ce => ({
                    x: (ce.clientX - bounds.left) / this.config.zoom,
                    y: (ce.clientY - bounds.top) / this.config.zoom,
                    pressure: ce.pressure || 0.5
                })) : null;
                FreehandPathEngine.onPointerMove(pos, coalesced);
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if (this.config.tool === 'freehand' && this.state.isDrawing) {
                const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
                if (coalesced && coalesced.length > 0) {
                    for (const ce of coalesced) {
                        const cp = this.getMouse(ce);
                        this.state.freehandPoints.push({ x: cp.x, y: cp.y, pressure: ce.pressure != null ? ce.pressure : 0.5 });
                    }
                } else {
                    this.state.freehandPoints.push({ x: p.x, y: p.y, pressure: e.pressure != null ? e.pressure : 0.5 });
                }
                this.scheduleFreehandPreview();
                this.updateHoverPreview(p.x, p.y);
                return;
            }

            if (this.config.tool === 'paintbrush' && this.state.isDrawing) {
                var _color = this.getActiveDrawColor(this.state.paintbrushSlot === 2);
                var _coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
                if (_coalesced && _coalesced.length > 0) {
                    for (var _ci = 0; _ci < _coalesced.length; _ci++) {
                        var _cp = this.getMousePrecise(_coalesced[_ci]);
                        if (this.brush && this.brush.moveStroke) {
                            this.brush.moveStroke(_cp.x, _cp.y, _coalesced[_ci].pressure != null ? _coalesced[_ci].pressure : 0.5, _color);
                        }
                    }
                } else {
                    if (this.brush && this.brush.moveStroke) {
                        this.brush.moveStroke(pp.x, pp.y, e.pressure != null ? e.pressure : 0.5, _color);
                    }
                }
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if(['pencil','eraser'].includes(this.config.tool)) {
                const isRight = e.buttons===2;
                const color = this.getActiveDrawColor(isRight || this.config.tool==='eraser');

                // When a frame is lost — a big brush takes real time to paint —
                // the browser delivers one move holding the latest position with
                // the skipped ones folded inside it. Using only the latest turns
                // that whole gap into one straight segment.
                //
                // Only when a frame was actually lost, though. Pointers sample
                // far faster than the display refreshes, and positions are whole
                // pixels here, so drawing through every raw sample turns one
                // clean line into a chain of short rounded ones — visibly bumpy
                // on a 1px pencil. Keeping up means keeping the old behaviour.
                // Constrained (ctrl) strokes are straight by definition.
                const now = performance.now();
                const gap = now - (this._lastDrawMoveAt || now);
                this._lastDrawMoveAt = now;
                const fellBehind = gap > 24;      // more than about a frame and a half
                const coalesced = (fellBehind && !e.ctrlKey && e.getCoalescedEvents)
                    ? e.getCoalescedEvents() : null;
                if (coalesced && coalesced.length > 1) {
                    for (const ce of coalesced) {
                        const cp = this.getMouse(ce);
                        if (this.config.tool === 'eraser' && isRight) {
                            this.replaceColorLine(this.state.startPos.x, this.state.startPos.y, cp.x, cp.y);
                        } else {
                            this.enqueueStroke({
                                x0: this.state.startPos.x,
                                y0: this.state.startPos.y,
                                x1: cp.x,
                                y1: cp.y,
                                color,
                                width: this.config.tool === 'eraser'
                                    ? this.config.eraserWidth : this.config.lineWidth,
                                isEraser: this.config.tool === 'eraser'
                            });
                        }
                        this.state.startPos = { x: cp.x, y: cp.y };
                    }
                    this.updateHoverPreview(this.state.startPos.x, this.state.startPos.y);
                    return;
                }

                let endP = p;
                if (this.config.tool === 'pencil' && e.ctrlKey) {
                    if (!this.state.pencilCtrlAxis) {
                        const dx = p.x - this.state.startPos.x;
                        const dy = p.y - this.state.startPos.y;
                        if (dx !== 0 || dy !== 0) {
                            this.state.pencilCtrlAxis = Math.abs(dx) >= Math.abs(dy) ? 'h' : 'v';
                        }
                    }
                    if (this.state.pencilCtrlAxis === 'h') {
                        endP = { x: p.x, y: this.state.startPos.y };
                    } else if (this.state.pencilCtrlAxis === 'v') {
                        endP = { x: this.state.startPos.x, y: p.y };
                    } else {
                        endP = this.snapPointOrtho(this.state.startPos, p);
                    }
                }
                if(this.config.tool==='eraser') {
                    if(isRight) this.replaceColorLine(this.state.startPos.x, this.state.startPos.y, p.x, p.y);
                    else this.enqueueStroke({
                        x0: this.state.startPos.x,
                        y0: this.state.startPos.y,
                        x1: endP.x,
                        y1: endP.y,
                        color,
                        width: this.config.eraserWidth,
                        isEraser: true
                    });
                }
                else this.enqueueStroke({
                    x0: this.state.startPos.x,
                    y0: this.state.startPos.y,
                    x1: endP.x,
                    y1: endP.y,
                    color,
                    width: this.config.lineWidth,
                    isEraser: false
                });
                this.state.startPos = { x: endP.x, y: endP.y };
                this.updateHoverPreview(endP.x, endP.y);
                return;
            }
            this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
            let w = p.x - this.state.startPos.x, h = p.y - this.state.startPos.y;
            const color = this.getActiveDrawColor(e.buttons===2);
            let drawX = this.state.startPos.x;
            let drawY = this.state.startPos.y;
            if (e.ctrlKey && ['rect','circle','tri'].includes(this.config.tool)) {
                const s = Math.round(Math.hypot(w, h));
                const signX = w < 0 ? -1 : 1;
                const signY = h < 0 ? -1 : 1;
                w = signX * s * 2;
                h = signY * s * 2;
                drawX = this.state.startPos.x - (w / 2);
                drawY = this.state.startPos.y - (h / 2);
            }
            if (e.shiftKey && this.config.tool === 'select') {
                const s = Math.min(Math.abs(w), Math.abs(h));
                w = w < 0 ? -s : s;
                h = h < 0 ? -s : s;
            }
            if (e.ctrlKey && this.config.tool === 'line') {
                const q = this.snapPointVerticalDiagonal(this.state.startPos, p);
                w = q.x - this.state.startPos.x;
                h = q.y - this.state.startPos.y;
            }
            if (e.shiftKey && this.config.tool === 'line') {
                const angle = Math.atan2(h, w);
                const snap = Math.round(angle / (Math.PI/4)) * (Math.PI/4);
                const dist = Math.sqrt(w*w + h*h);
                w = Math.cos(snap) * dist; h = Math.sin(snap) * dist;
            }
            if(this.config.tool === 'select') {
                const sp = this.clampPointToCanvasPixel(this.state.startPos);
                const cp = this.clampPointToCanvasPixel(p);
                const rect = this.getInclusiveRectFromPoints(sp, cp);
                this.updateSelectionUI(rect.x, rect.y, rect.w, rect.h);
                this.updateHoverPreview(p.x, p.y);
                return;
            }

            if(this.config.tool==='line') this.drawBinaryLine(this.state.startPos.x, this.state.startPos.y, this.state.startPos.x+w, this.state.startPos.y+h, color, true, this.config.shapeWidth, false);

            else if(this.config.tool==='rect') this.drawBinaryRect(drawX, drawY, w, h, color, true, this.config.shapeWidth);

            else if(this.config.tool==='circle') this.drawBinaryEllipse(drawX, drawY, w, h, color, true, this.config.shapeWidth);
            else if(this.config.tool==='tri') this.drawBinaryTri(drawX, drawY, w, h, color, true, this.config.shapeWidth);
            this.updateHoverPreview(p.x, p.y);
        }

        updateHoverPreview(x, y) { /* disabled — overridden by layer patch */ }

        renderPolylinePreview(p) {
            if (!this.state.polyActive || this.state.polyPoints.length === 0) return;
            this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
            const color = this.getActiveDrawColor(false);
            const pts = this.state.polyPoints;
            for (let i = 1; i < pts.length; i++) {
                this.drawBinaryLine(pts[i-1].x, pts[i-1].y, pts[i].x, pts[i].y, color, true, this.config.shapeWidth, false);
            }
            if (p) {
                const last = pts[pts.length - 1];
                this.drawBinaryLine(last.x, last.y, p.x, p.y, color, true, this.config.shapeWidth, false);
            }
        }

        commitPolyline() {
            if (!this.state.polyActive || this.state.polyPoints.length < 2) {
                this.state.polyActive = false;
                this.state.polyPoints = [];
                this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                return;
            }
            const pts = this.state.polyPoints.slice();
            const first = pts[0];
            const last = pts[pts.length - 1];
            const closed = (first.x === last.x && first.y === last.y);
            let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
            for (let i = 1; i < pts.length; i++) {
                minX = Math.min(minX, pts[i].x);
                maxX = Math.max(maxX, pts[i].x);
                minY = Math.min(minY, pts[i].y);
                maxY = Math.max(maxY, pts[i].y);
            }
            const w = (maxX - minX) || 1;
            const h = (maxY - minY) || 1;
            const norm = pts.map(pt => ({ x: (pt.x - minX) / w, y: (pt.y - minY) / h }));
            this.state.activeShape = { type: 'poly', x: minX, y: minY, w: w, h: h, c: this.getActiveDrawColor(false), lw: this.config.shapeWidth, points: norm, closed, colorSlot: 1 };
            this.state.shapeEditMode = true;
            this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
            this.state.polyActive = false;
            this.state.polyPoints = [];
            this.state.isDrawing = false;
            this.renderActiveShape();
        }
        cancelPolyline() {
            this.state.polyActive = false;
            this.state.polyPoints = [];
            this.state.isDrawing = false;
            this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
        }

        // Commit the live gradient to the main canvas (+ undo history)
        onMouseUp(e) {
            this._lastPointerActivityAt = performance.now();
            if(this.state.isPanning) { this.state.isPanning = false; return; }
            if(this.state.isCanvasDragging) { this.state.isCanvasDragging = false; return; }
            if(this.state.isCanvasResizing) { this.endCanvasResize(); return; }
            if(this.state.isMovingSel) { this.state.isMovingSel = false; return; }
            if (this.state.isRotatingSel) { this.endSelectionRotation(); return; }
            if (this.state.isRotatingShape) { this.endShapeRotation(); return; }
            if (this.state.smartPencilActive && this.config.tool === 'pencil' && this.config.pencilMode === 'smart') {
                this.finishSmartPencilStroke();
                const p = this.getMouse(e);
                this.updateHoverPreview(p.x, p.y);
                return;
            }
            if (this.config.tool === 'pencil') { this.state.pencilCtrlAxis = null; }
            if (this.config.tool === 'gradient' && !this.config.gradient.isPlacing && !this.config.gradient.draggingHandle) return;
            if (this.config.tool === 'gradient' && (this.config.gradient.isPlacing || this.config.gradient.draggingHandle)) {
                const _g = this.config.gradient;
                const _p = this.getMouse(e);
                if (_g.isPlacing) {
                    if (e.shiftKey) {
                        const _snap = this.snapPointOrtho({ x: _g.startX, y: _g.startY }, _p);
                        _g.endX = _snap.x; _g.endY = _snap.y;
                    } else {
                        _g.endX = _p.x; _g.endY = _p.y;
                    }
                    _g.isPlacing = false;
                    const _dist = Math.hypot(_g.endX - _g.startX, _g.endY - _g.startY);
                    if (_dist > 2) {
                        _g.active = true;
                        // Re-render to remove the placing animation artifacts and show clean state
                        this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                        _gradientRender(this.ctxTemp, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                        this._clipGradientToSelection();
                        this._gradientDrawVectorSVG();
                        this._gradientUpdateApplyCard(true);
                    } else {
                        // Too small — discard
                        _g.active = false;
                        this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                        this._gradientClearVectorSVG();
                        this._gradientUpdateApplyCard(false);
                    }
                } else {
                    // Finished dragging a handle
                    _g.draggingHandle = null;
                    this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                    _gradientRender(this.ctxTemp, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                    this._clipGradientToSelection();
                    this._gradientDrawVectorSVG();
                }
                this.state.isDrawing = false;
                return;
            }
            if (this.config.tool === 'picker' && this.state.pickerArmed) {
                const p = this.getMouse(e);
                if (p.x >= 0 && p.y >= 0 && p.x < this.config.width && p.y < this.config.height) {
                    this.pickColor((e.clientX - this.bounds.left - 2) / this.config.zoom, p.y, this.state.pickerSlot || (e.button === 2 ? 2 : 1));
                }
                this.state.pickerArmed = false;
                this.setTool(this.state.lastDrawTool || 'pencil');
                return;
            }

            if(this.state.shapeEditMode && this.state.dragMode) {
                this.state.isDrawing = false;
                this.state.dragMode = null;
                this.state.activeShapePathHandle = null;
                this.state.shapeResizeAnchor = null;
                this.state.shapeResizeBase = null;
                this.state.shapeDragStart = null;
                this.state.shapeDragBase = null;
                return;
            }
            if (this.state.wandActive) {
                const wandBase   = this.state.wandBase;
                const wandStart  = this.state.wandStart;
                const wandTol    = this.state.wandTol;
                const selOp      = this.getSelectionOp(e);
                this.state.wandJobId++;
                this.state.wandActive      = false;
                this.state.wandBase        = null;
                this.state.wandDiff        = null;
                this.state.wandStartScreen = null;
                if (this._wandSelectRaf) { cancelAnimationFrame(this._wandSelectRaf); this._wandSelectRaf = null; }
                // The drag is over: a preview queued behind the running job
                // would be computed for a threshold nobody will ever see, and
                // would compete with the commit below for the worker.
                this._wandWorkerPending = null;
                if (wandBase && wandStart) {
                    this._clearWandSvgPreview();
                    this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                    this.magicWandSelect(wandStart.x, wandStart.y, wandTol, selOp, wandBase, true);
                }
                this.updateWandThreshold(this.config.wandTolerance, { applySelection: false, setConfig: false });
                return;
            }
            if (this.config.tool === 'lasso' && this.state.lassoActive) {
                if (this.state.lassoMode === 'free') {
                    const releasePoint = this.clampPointToCanvasPixel(this.getMouse(e));
                    this.appendLassoPoint(releasePoint);
                    this.state.lassoIsDown = false;
                    this.finalizeLassoSelection();
                }
                return;
            }

            if(this.state.dragHandle) {
                this.state.isDrawing=false;
                this.state.dragHandle=null;
                this.state.selectionOriginalPos = null;
                // Suppress the click event that fires right after mouseup.
                // If the user dragged a resize handle past the opposite edge (flipping the
                // selection) the resulting click would otherwise commit/deselect it.
                this.state.selectionIgnoreNextClick = true;
                this.state.selectionIgnoreClickUntil = Date.now() + 1000;
                this.renderSelection();
                this.deferSelectionRenderFinalize(this.state.selection);
                this.deferColorCounts();
                return;
            }

            if(this.config.tool === 'poly' && this.state.polyActive) {
                this.state.isDrawing = true;
                return;
            }

            if (this.config.tool === 'freehand' && this.state.freehandActive) {
                this.state.freehandActive = false;
                this.state.isDrawing = false;
                if (this._freehandPendingFrame) {
                    cancelAnimationFrame(this._freehandPendingFrame);
                    this._freehandPendingFrame = null;
                }
                this.renderFreehandPreview();
                this.commitFreehandStroke();
                this.state.freehandPoints = [];
                this._freehandInputPoints = [];
                this._freehandStrokePoints = null;
                this._fhPreviewing = false;
                return;
            }

            if (this.config.tool === 'paintbrush' && this.state.paintbrushActive) {
                this.state.paintbrushActive = false;
                this.state.isDrawing = false;
                if (this.brush && this.brush.endStroke) {
                    this.brush.endStroke();
                }
                return;
            }

            if(!this.state.isDrawing) return;
            this.state.isDrawing = false;
            const p = this.getMouse(e);
            const color = (this.config.tool === 'curve' && this.state.curveDrawSlot)
                ? this.getActiveDrawColor(this.state.curveDrawSlot === 2)
                : this.getActiveDrawColor(e.button===2);
            if(this.config.tool === 'curve') {
                if(this.state.curvePhase===0) {
                    const q = e.ctrlKey ? this.snapPointVerticalDiagonal(this.state.startPos, p) : p;
                    const d=Math.sqrt(Math.pow(q.x-this.state.startPos.x,2)+Math.pow(q.y-this.state.startPos.y,2));

                    if(d<4){ this.state.curvePhase=0; this.ctxTemp.clearRect(0,0,this.config.width,this.config.height); return; }
                    this.state.curvePts[1]={x:q.x,y:q.y};
                    this.state.curvePhase=1;
                } else if(this.state.curvePhase===1) {
                    this.state.curvePts[2]={x:p.x,y:p.y};
                    this.state.curvePhase=2;
                } else if(this.state.curvePhase===2) {
                    const pts = this.state.curvePts; const p2 = {x:p.x,y:p.y};
                    // Use tight analytical Bézier bounds (not control-point envelope)
                    // points order: start=pts[0], ctrl1=pts[2], ctrl2=p2, end=pts[1]
                    const _aabb = this.cubicBezierAABB(pts[0], pts[2] || p2, p2, pts[1]);
                    const minX = _aabb.minX, maxX = _aabb.maxX, minY = _aabb.minY, maxY = _aabb.maxY;
                    const w = maxX-minX || 1, h = maxY-minY || 1;
                    const norm = [pts[0], pts[1], pts[2], p2].map(pt => ({ x:(pt.x-minX)/w, y:(pt.y-minY)/h }));

                    this.state.activeShape = { type: 'curve', x:minX, y:minY, w:w, h:h, c:color, lw:this.config.shapeWidth, points: norm, colorSlot: this.state.curveDrawSlot || 1 };
                    this.state.shapeEditMode = true;
                    this.state.curvePhase=0;
                    this.state.curvePreviewPoint = null;
                    this.renderActiveShape();
                }
                return;
            }
            if(this.config.tool === 'path' && FreehandPathEngine.isActive()) {
                const result = FreehandPathEngine.onPointerUp();
                this.state.isDrawing = false;
                this.state.freehandPathActive = false;
                if (!result || !result.bezierSegs || result.bezierSegs.length === 0) return;

                const bezierSegs = result.bezierSegs;
                // Compute tight AABB across all Bezier segments
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const seg of bezierSegs) {
                    const aabb = this.cubicBezierAABB(seg.p0, seg.p1, seg.p2, seg.p3);
                    minX = Math.min(minX, aabb.minX); maxX = Math.max(maxX, aabb.maxX);
                    minY = Math.min(minY, aabb.minY); maxY = Math.max(maxY, aabb.maxY);
                }
                let w = maxX - minX || 1, h = maxY - minY || 1;

                // Normalize all control points into [0,1] relative space
                const flatPoints = [];
                for (const seg of bezierSegs) {
                    flatPoints.push({ x: (seg.p0.x - minX) / w, y: (seg.p0.y - minY) / h });
                    flatPoints.push({ x: (seg.p3.x - minX) / w, y: (seg.p3.y - minY) / h });
                    flatPoints.push({ x: (seg.p1.x - minX) / w, y: (seg.p1.y - minY) / h });
                    flatPoints.push({ x: (seg.p2.x - minX) / w, y: (seg.p2.y - minY) / h });
                }

                const color = this.getActiveDrawColor(this.state.freehandPathSlot === 2);
                this.state.activeShape = { type: 'curve', x:minX, y:minY, w:w, h:h, c:color, lw:this.config.shapeWidth, points: flatPoints, colorSlot: this.state.freehandPathSlot, multiSeg: true };
                this.state.shapeEditMode = true;
                this.renderActiveShape();
                return;
            }
            if(this.config.tool === 'select') {
                this.ui.selControls.classList.remove('creating');
                const sp = this.clampPointToCanvasPixel(this.state.startPos);
                const cp = this.clampPointToCanvasPixel(p);
                const rect = this.getInclusiveRectFromPoints(sp, cp);
                const w = rect.w;
                const h = rect.h;

                if(Math.abs(w) <= 1 || Math.abs(h) <= 1) {
                    this.ui.selControls.style.display = 'none';
                    this.clearStatusSelectionSize();
                    this.requestGlobalOverlayUpdate();
                    return;
                }
                this.createSelection(rect.x, rect.y, rect.w, rect.h);
                this.state.selectionJustCreated = true;
                this.renderSelection();
            } else if(['rect','circle','tri','line'].includes(this.config.tool)) {
                let w = p.x - this.state.startPos.x, h = p.y - this.state.startPos.y;
                if(w===0 && h===0) return;
                let drawX = this.state.startPos.x;
                let drawY = this.state.startPos.y;
                if (e.ctrlKey && ['rect','circle','tri'].includes(this.config.tool)) {
                    const s = Math.round(Math.hypot(w, h));
                    const signX = w < 0 ? -1 : 1;
                    const signY = h < 0 ? -1 : 1;
                    w = signX * s * 2;
                    h = signY * s * 2;
                    drawX = this.state.startPos.x - (w / 2);
                    drawY = this.state.startPos.y - (h / 2);
                }
                if (e.ctrlKey && this.config.tool === 'line') {
                    const q = this.snapPointVerticalDiagonal(this.state.startPos, p);
                    w = q.x - this.state.startPos.x;
                    h = q.y - this.state.startPos.y;
                }
                if (e.shiftKey && this.config.tool === 'line') {
                    const a = Math.atan2(h, w);
                    const s = Math.round(a / (Math.PI/4)) * (Math.PI/4);
                    const d = Math.sqrt(w*w + h*h);
                    w = Math.cos(s) * d; h = Math.sin(s) * d;
                }

                this.state.activeShape = { type:this.config.tool, x:drawX, y:drawY, w:w, h:h, c:color, lw:this.config.shapeWidth, colorSlot: (e.button === 2 ? 2 : 1) };
                this.state.shapeEditMode = true;
                this.renderActiveShape();
            } else {
                if (['pencil','eraser'].includes(this.config.tool)) {
                    this.flushPendingStrokes();
                }
                this.stampTempCanvas();
                this.clearTempCanvas();
                this.saveStateDeferred();
            }
        }

        renderActiveShape() {
            this.clearTempCanvas();
            const s = this.state.activeShape;
            if (!s) return;
            this.drawActiveShape(s, true);
            const b = this.getActiveShapeBounds(s);
            // Cache the bounds so handle layout doesn't recompute rotated poly bounds twice per frame.
            this._activeShapeBoundsCache = b;
            this._activeShapeBoundsCacheShape = s;
            this.updateSelectionUI(b.x, b.y, b.w, b.h, 0);
        }

        refreshCurvePreview() {
            if (this.config.tool !== 'curve') return;
            if (!this.state.curvePts || this.state.curvePts.length < 2) return;
            if (this.state.curvePhase === null || this.state.curvePhase === undefined) return;
            if (!this.state.curvePreviewPoint) return;
            const p = this.state.curvePreviewPoint;
            const color = this.getActiveDrawColor(this.state.curveDrawSlot === 2);
            this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
            if (this.state.curvePhase === 0) {
                this.drawBinaryLine(this.state.curvePts[0].x, this.state.curvePts[0].y, p.x, p.y, color, true, this.config.shapeWidth, false);
            } else if (this.state.curvePhase === 1) {
                this.drawBinaryBezier(this.state.curvePts[0], {x:p.x,y:p.y}, {x:p.x,y:p.y}, this.state.curvePts[1], color, true, this.config.shapeWidth, false);
            } else if (this.state.curvePhase === 2) {
                this.drawBinaryBezier(this.state.curvePts[0], this.state.curvePts[2], {x:p.x,y:p.y}, this.state.curvePts[1], color, true, this.config.shapeWidth, false);
            }
        }

        commitActiveShape() {
            if(!this.state.activeShape) return;
            const s = this.state.activeShape;
            this.drawActiveShape(s, false);
            this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
            this.state.activeShape = null; this.state.shapeEditMode = false;
            this._activeShapeBoundsCache = null;
            this._activeShapeBoundsCacheShape = null;
            this.ui.selControls.style.display = 'none';
            if (this.ui.pathHandles) this.ui.pathHandles.replaceChildren();
            this.state.activeShapePathHandle = null;
            this.state.isRotatingShape = false;
            this.state.shapeRotateSession = null;
            this.state.shapeResizeAnchor = null;
            this.state.shapeResizeBase = null;
            this.clearStatusSelectionSize();
            this.requestGlobalOverlayUpdate();
            this.saveState();
            this.collapseSelectionCutStep();
        }

        drawActiveShape(s, preview) {
            const rot = this.getShapeRotationDegrees(s);
            /* For curves use the tight AABB center as pivot so rotation matches
               the visible selection box. For all other shapes s.x+s.w/2 is fine. */
            let center;
            if (s.type === 'curve' && s.points && s.points.length >= 4) {
                let minXf = Infinity, maxXf = -Infinity, minYf = Infinity, maxYf = -Infinity;
                if (s.multiSeg) {
                    for (let i = 0; i < s.points.length; i += 4) {
                        if (i + 3 >= s.points.length) break;
                        const wp0 = { x: s.x + s.points[i].x * s.w,     y: s.y + s.points[i].y * s.h };
                        const wp1 = { x: s.x + s.points[i+1].x * s.w,   y: s.y + s.points[i+1].y * s.h };
                        const wp2 = { x: s.x + s.points[i+2].x * s.w,   y: s.y + s.points[i+2].y * s.h };
                        const wp3 = { x: s.x + s.points[i+3].x * s.w,   y: s.y + s.points[i+3].y * s.h };
                        const aabb = this.cubicBezierAABB(wp0, wp2, wp3, wp1);
                        minXf = Math.min(minXf, aabb.minX); maxXf = Math.max(maxXf, aabb.maxX);
                        minYf = Math.min(minYf, aabb.minY); maxYf = Math.max(maxYf, aabb.maxY);
                    }
                } else {
                    const wp = s.points.map(pt => ({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h }));
                    const aabb = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]);
                    minXf = aabb.minX; maxXf = aabb.maxX; minYf = aabb.minY; maxYf = aabb.maxY;
                }
                center = { x: (minXf + maxXf) / 2, y: (minYf + maxYf) / 2 };
            } else {
                center = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
            }
            const rotate = (pt) => this.rotatePoint(pt, center, rot);

            if (s.type === 'rect') {
                const p0 = rotate({ x: s.x, y: s.y });
                const p1 = rotate({ x: s.x + s.w, y: s.y });
                const p2 = rotate({ x: s.x + s.w, y: s.y + s.h });
                const p3 = rotate({ x: s.x, y: s.y + s.h });
                this.drawBinaryLine(p0.x, p0.y, p1.x, p1.y, s.c, preview, s.lw, false);
                this.drawBinaryLine(p1.x, p1.y, p2.x, p2.y, s.c, preview, s.lw, false);
                this.drawBinaryLine(p2.x, p2.y, p3.x, p3.y, s.c, preview, s.lw, false);
                this.drawBinaryLine(p3.x, p3.y, p0.x, p0.y, s.c, preview, s.lw, false);
                return;
            }
            if (s.type === 'circle') {
                const cx = s.x + s.w / 2;
                const cy = s.y + s.h / 2;
                const rx = Math.abs(s.w / 2);
                const ry = Math.abs(s.h / 2);
                const segs = this.buildEllipseSegs(cx, cy, rx, ry);
                for (const seg of segs) {
                    const p0 = rotate(seg.p0);
                    const p1 = rotate(seg.p1);
                    const p2 = rotate(seg.p2);
                    const p3 = rotate(seg.p3);
                    this.drawBinaryBezier(p0, p1, p2, p3, s.c, preview, s.lw, false);
                }
                return;
            }
            if (s.type === 'tri') {
                const p0 = rotate({ x: s.x + s.w / 2, y: s.y });
                const p1 = rotate({ x: s.x, y: s.y + s.h });
                const p2 = rotate({ x: s.x + s.w, y: s.y + s.h });
                this.drawBinaryLine(p0.x, p0.y, p1.x, p1.y, s.c, preview, s.lw, false);
                this.drawBinaryLine(p1.x, p1.y, p2.x, p2.y, s.c, preview, s.lw, false);
                this.drawBinaryLine(p2.x, p2.y, p0.x, p0.y, s.c, preview, s.lw, false);
                return;
            }
            if (s.type === 'line') {
                const p0 = rotate({ x: s.x, y: s.y });
                const p1 = rotate({ x: s.x + s.w, y: s.y + s.h });
                this.drawBinaryLine(p0.x, p0.y, p1.x, p1.y, s.c, preview, s.lw, false);
                return;
            }
            if (s.type === 'curve') {
                if (s.multiSeg) {
                    // Multi-segment Bezier: points is [p0, p3, p1, p2] per segment
                    for (let i = 0; i < s.points.length; i += 4) {
                        if (i + 3 >= s.points.length) break;
                        const p0 = rotate({ x: s.x + s.points[i].x * s.w,     y: s.y + s.points[i].y * s.h });
                        const p3 = rotate({ x: s.x + s.points[i+1].x * s.w,   y: s.y + s.points[i+1].y * s.h });
                        const p1 = rotate({ x: s.x + s.points[i+2].x * s.w,   y: s.y + s.points[i+2].y * s.h });
                        const p2 = rotate({ x: s.x + s.points[i+3].x * s.w,   y: s.y + s.points[i+3].y * s.h });
                        this.drawBinaryBezier(p0, p1, p2, p3, s.c, preview, s.lw, false);
                    }
                } else {
                    // Single Bezier: points = [p0, p3, p1, p2]
                    const p = s.points.map(pt => rotate({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h }));
                    this.drawBinaryBezier(p[0], p[2], p[3], p[1], s.c, preview, s.lw, false);
                }
                return;
            }
            if (s.type === 'poly') {
                const p = s.points.map(pt => rotate({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h }));
                for (let i = 1; i < p.length; i++) {
                    this.drawBinaryLine(p[i-1].x, p[i-1].y, p[i].x, p[i].y, s.c, preview, s.lw, false);
                }
                if (s.closed && p.length > 1) {
                    this.drawBinaryLine(p[p.length - 1].x, p[p.length - 1].y, p[0].x, p[0].y, s.c, preview, s.lw, false);
                }
            }
        }

        buildEllipseSegs(cx, cy, rx, ry) {
            const K = 0.5522847498;
            return [
                {p0:{x:cx+rx,y:cy},  p1:{x:cx+rx,y:cy+ry*K}, p2:{x:cx+rx*K,y:cy+ry},  p3:{x:cx,y:cy+ry}},
                {p0:{x:cx,y:cy+ry},  p1:{x:cx-rx*K,y:cy+ry}, p2:{x:cx-rx,y:cy+ry*K},  p3:{x:cx-rx,y:cy}},
                {p0:{x:cx-rx,y:cy},  p1:{x:cx-rx,y:cy-ry*K}, p2:{x:cx-rx*K,y:cy-ry},  p3:{x:cx,y:cy-ry}},
                {p0:{x:cx,y:cy-ry},  p1:{x:cx+rx*K,y:cy-ry}, p2:{x:cx+rx,y:cy-ry*K},  p3:{x:cx+rx,y:cy}}
            ];
        }

        applyAabbScaleToShape(s, anchor, scaleX, scaleY, baseShape = null) {
            const src = baseShape || s;
            const rot = this.getShapeRotationDegrees(src);
            let center;
            if (src.type === 'curve' && src.points && src.points.length >= 4) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                if (src.multiSeg) {
                    for (let i = 0; i < src.points.length; i += 4) {
                        if (i + 3 >= src.points.length) break;
                        const wp0 = { x: src.x + src.points[i].x * src.w,   y: src.y + src.points[i].y * src.h };
                        const wp1 = { x: src.x + src.points[i+1].x * src.w, y: src.y + src.points[i+1].y * src.h };
                        const wp2 = { x: src.x + src.points[i+2].x * src.w, y: src.y + src.points[i+2].y * src.h };
                        const wp3 = { x: src.x + src.points[i+3].x * src.w, y: src.y + src.points[i+3].y * src.h };
                        const aabb = this.cubicBezierAABB(wp0, wp2, wp3, wp1);
                        minX = Math.min(minX, aabb.minX); maxX = Math.max(maxX, aabb.maxX);
                        minY = Math.min(minY, aabb.minY); maxY = Math.max(maxY, aabb.maxY);
                    }
                } else {
                    const wp = src.points.map(pt => ({ x: src.x + pt.x*src.w, y: src.y + pt.y*src.h }));
                    const aabb = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]);
                    minX = aabb.minX; maxX = aabb.maxX; minY = aabb.minY; maxY = aabb.maxY;
                }
                center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
            } else {
                center = { x: src.x + src.w / 2, y: src.y + src.h / 2 };
            }
            const rotate = (pt) => this.rotatePoint(pt, center, rot);
            const scale = (pt) => ({
                x: anchor.x + (pt.x - anchor.x) * scaleX,
                y: anchor.y + (pt.y - anchor.y) * scaleY
            });

            const worldPoints = this.getShapeWorldPoints(src).map(rotate).map(scale);
            if (!worldPoints.length) return;

            let minX = worldPoints[0].x, maxX = worldPoints[0].x, minY = worldPoints[0].y, maxY = worldPoints[0].y;
            for (let i = 1; i < worldPoints.length; i++) {
                minX = Math.min(minX, worldPoints[i].x); maxX = Math.max(maxX, worldPoints[i].x);
                minY = Math.min(minY, worldPoints[i].y); maxY = Math.max(maxY, worldPoints[i].y);
            }
            let w = maxX - minX; let h = maxY - minY;
            if (w === 0) w = 1;
            if (h === 0) h = 1;

            if (src.type === 'line') {
                const p0 = worldPoints[0];
                const p1 = worldPoints[1] || worldPoints[0];
                s.type = 'line';
                s.rotation = 0;
                s.x = p0.x; s.y = p0.y;
                s.w = p1.x - p0.x; s.h = p1.y - p0.y;
                return;
            }

            if (src.type === 'curve' && worldPoints.length >= 4) {
                s.type = 'curve';
                s.rotation = 0;
                // worldPoints order: [start, end, ctrl1, ctrl2] — re-derive tight bounds
                const _aabb = this.cubicBezierAABB(worldPoints[0], worldPoints[2], worldPoints[3], worldPoints[1]);
                const minX = _aabb.minX, maxX = _aabb.maxX, minY = _aabb.minY, maxY = _aabb.maxY;
                const w = maxX - minX || 1, h = maxY - minY || 1;
                s.x = minX; s.y = minY; s.w = w; s.h = h;
                s.points = [
                    { x: (worldPoints[0].x - minX) / w, y: (worldPoints[0].y - minY) / h },
                    { x: (worldPoints[1].x - minX) / w, y: (worldPoints[1].y - minY) / h },
                    { x: (worldPoints[2].x - minX) / w, y: (worldPoints[2].y - minY) / h },
                    { x: (worldPoints[3].x - minX) / w, y: (worldPoints[3].y - minY) / h }
                ];
                return;
            }

            s.type = 'poly';
            s.rotation = 0;
            s.closed = (src.type === 'poly' && typeof src.closed === 'boolean') ? src.closed : true;
            s.x = minX; s.y = minY; s.w = w; s.h = h;
            s.points = worldPoints.map(pt => ({ x: (pt.x - minX) / w, y: (pt.y - minY) / h }));
        }

        getShapeWorldPoints(s) {
            if (!s) return [];
            if (s.type === 'line') {
                return [
                    { x: s.x, y: s.y },
                    { x: s.x + s.w, y: s.y + s.h }
                ];
            }
            if (s.type === 'curve' && s.points && s.points.length >= 4) {
                return s.points.map(pt => ({ x: s.x + pt.x * s.w, y: s.y + pt.y * s.h }));
            }
            if (s.type === 'poly' && s.points && s.points.length) {
                return s.points.map(pt => ({ x: s.x + pt.x * s.w, y: s.y + pt.y * s.h }));
            }
            if (s.type === 'rect') {
                return [
                    { x: s.x, y: s.y },
                    { x: s.x + s.w, y: s.y },
                    { x: s.x + s.w, y: s.y + s.h },
                    { x: s.x, y: s.y + s.h }
                ];
            }
            if (s.type === 'tri') {
                return [
                    { x: s.x + s.w / 2, y: s.y },
                    { x: s.x, y: s.y + s.h },
                    { x: s.x + s.w, y: s.y + s.h }
                ];
            }
            if (s.type === 'circle') {
                const cx = s.x + s.w / 2;
                const cy = s.y + s.h / 2;
                const rx = Math.abs(s.w / 2);
                const ry = Math.abs(s.h / 2);
                const pts = [];
                const steps = 16;
                for (let i = 0; i < steps; i++) {
                    const t = (i / steps) * Math.PI * 2;
                    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
                }
                return pts;
            }
            return [];
        }

        cloneShapeForDrag(s) {
            if (!s) return null;
            const clone = {
                type: s.type,
                x: s.x,
                y: s.y,
                w: s.w,
                h: s.h,
                rotation: s.rotation || 0
            };
            if (s.points && s.points.length) {
                clone.points = s.points.map(pt => ({ x: pt.x, y: pt.y }));
            }
            if (s.closed !== undefined) clone.closed = s.closed;
            return clone;
        }

        updateColorCounts() {
            const width = this.config.width;
            const height = this.config.height;
            const hasSelection = !!this.state.selection;
            let mainData = null;
            let selData = null;
            let selCtx = null;
            let selW = 0;
            let selH = 0;
            // Skip this read entirely when the worker can take the image
            // instead — it is the single most expensive thing in the app.
            const canSendBitmap = !this._colorCountNoBitmap &&
                typeof createImageBitmap === 'function' &&
                !!this.ensureColorCountWorker();
            if (!canSendBitmap) {
                try {
                    mainData = this.ctx.getImageData(0, 0, width, height).data;
                } catch (e) {}
            }
            if (hasSelection) {
                const s = this.state.selection;
                selCtx = s.canvas.getContext('2d', { willReadFrequently: true });
                selW = Math.max(0, Math.floor(Math.abs(s.w)));
                selH = Math.max(0, Math.floor(Math.abs(s.h)));
                try {
                    if (selW > 0 && selH > 0) selData = selCtx.getImageData(0, 0, selW, selH).data;
                } catch (e) {}
            }

            const jobId = ++this._colorCountJobId;
            const worker = this.ensureColorCountWorker();

            // Preferred path: hand the worker the image and let IT do the
            // expensive read. Nothing large is allocated on this thread, so a
            // recount can no longer land on the start of a stroke.
            if (worker && !this._colorCountNoBitmap &&
                typeof createImageBitmap === 'function' && !mainData) {
                createImageBitmap(this.ui.cMain).then((bmp) => {
                    if (jobId !== this._colorCountJobId) { bmp.close(); return; }
                    const transfer = [bmp];
                    const payload = { jobId, bitmap: bmp, selData: null };
                    if (selData) { payload.selData = selData.buffer; transfer.push(selData.buffer); }
                    worker.postMessage(payload, transfer);
                }).catch(() => {
                    this._colorCountNoBitmap = true;
                });
                return;
            }

            if (worker && mainData) {
                try {
                    const transfer = [mainData.buffer];
                    const payload = { jobId, mainData: mainData.buffer, selData: null };
                    if (selData) {
                        payload.selData = selData.buffer;
                        transfer.push(selData.buffer);
                    }
                    worker.postMessage(payload, transfer);
                    return;
                } catch (e) {}
            }

            const total = mainData ? this.countColorsFromData(mainData) : this.countColors(this.ctx, width, height);
            let selCount = null;
            if (hasSelection) {
                selCount = selData ? this.countColorsFromData(selData) : this.countColors(selCtx, selW, selH);
            }
            this.setColorCountStatus(total, selCount, hasSelection);
        }

        countColors(ctx, w, h) {
            if(w <= 0 || h <= 0) return 0;
            const d = ctx.getImageData(0,0,w,h).data;
            return this.countColorsFromData(d);
        }

        unionRects(a, b) {
            if (!a) return b ? { ...b } : null;
            if (!b) return { ...a };
            const x1 = Math.min(a.x, b.x);
            const y1 = Math.min(a.y, b.y);
            const x2 = Math.max(a.x + a.w, b.x + b.w);
            const y2 = Math.max(a.y + a.h, b.y + b.h);
            return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
        }
        simplifyAxisAlignedPath(points, closed = false) {
            if (!Array.isArray(points) || points.length <= 2) return Array.isArray(points) ? points.slice() : [];
            const out = points.map((p) => ({ x: p.x, y: p.y }));
            const isCollinear = (a, b, c) => (
                (a.x === b.x && b.x === c.x) ||
                (a.y === b.y && b.y === c.y)
            );

            if (!closed) {
                const simple = [out[0]];
                for (let i = 1; i < out.length - 1; i++) {
                    if (!isCollinear(out[i - 1], out[i], out[i + 1])) {
                        simple.push(out[i]);
                    }
                }
                simple.push(out[out.length - 1]);
                return simple;
            }

            if (out.length > 1) {
                const first = out[0];
                const last = out[out.length - 1];
                if (first.x === last.x && first.y === last.y) {
                    out.pop();
                }
            }
            if (out.length <= 3) return out;

            let changed = true;
            while (changed && out.length > 3) {
                changed = false;
                for (let i = 0; i < out.length; i++) {
                    const prev = out[(i - 1 + out.length) % out.length];
                    const curr = out[i];
                    const next = out[(i + 1) % out.length];
                    if (isCollinear(prev, curr, next)) {
                        out.splice(i, 1);
                        changed = true;
                        break;
                    }
                }
            }
            return out;
        }
        getAntsPattern(ctx) {
            if (!this._antsPatternCanvas) {
                const p = document.createElement('canvas');
                p.width = 2;
                p.height = 2;
                const pctx = p.getContext('2d');
                pctx.fillStyle = '#000';
                pctx.fillRect(0, 0, 1, 1);
                pctx.fillRect(1, 1, 1, 1);
                pctx.fillStyle = '#fff';
                pctx.fillRect(1, 0, 1, 1);
                pctx.fillRect(0, 1, 1, 1);
                this._antsPatternCanvas = p;
            }
            if (!this._antsPattern || this._antsPatternCtx !== ctx) {
                this._antsPattern = ctx.createPattern(this._antsPatternCanvas, 'repeat');
                this._antsPatternCtx = ctx;
            }
            return this._antsPattern;
        }
        startOutlineAnimation() {
            if (this.state.outlineAnimId) return;
            // Match prior CSS ants speed: 30 px dash travel over 3.5s.
            const stepMs = 117;
            const phaseSpan = 30;
            const tick = (ts) => {
                if (!this.state.selection || !this.state.selection.mask) {
                    this.stopOutlineAnimation();
                    return;
                }
                if (!this.state.outlineLastTime) this.state.outlineLastTime = ts;
                if (ts - this.state.outlineLastTime >= stepMs) {
                    this.state.outlinePhase = (this.state.outlinePhase + 1) % phaseSpan;
                    this.state.outlineLastTime = ts;
                    this.renderSelectionFast();
                }
                this.state.outlineAnimId = requestAnimationFrame(tick);
            };
            this.state.outlineAnimId = requestAnimationFrame(tick);
        }
        stopOutlineAnimation() {
            if (this.state.outlineAnimId) cancelAnimationFrame(this.state.outlineAnimId);
            this.state.outlineAnimId = null;
            this.state.outlineLastTime = 0;
        }
        /* Counting the colours in use means reading the whole canvas back — at
         * 13000x13000 that is a 676 MB allocation and about 140 ms, and the
         * allocation churn costs more again. It is a status-bar number, so it
         * does not need to keep up with the brush. How long to leave it alone
         * scales with how expensive it is. */
        colorCountIntervalMs() {
            const px = (this.config.width || 0) * (this.config.height || 0);
            const mp = px / (1024 * 1024);
            if (mp <= 1) return this._colorCountMinIntervalMs;   // 1 MP or less: as before
            if (mp <= 4) return 400;
            if (mp <= 16) return 900;
            // Past that the read dominates and scales with area, so the wait
            // does too — roughly 30 ms of quiet per megapixel, up to 4 s.
            return Math.min(4000, Math.round(mp * 30));
        }
        /* How still the pointer has to be before a recount is allowed. Between
         * two strokes there is often a pause of a few hundred milliseconds
         * while the hand repositions; starting a ~124 ms read in that gap lands
         * squarely on the beginning of the next stroke, which then loses its
         * first moves and comes out straight. */
        colorCountQuietMs() {
            return Math.min(1500, this.colorCountIntervalMs());
        }
        deferColorCounts() {
            if (this._colorCountPending) return;
            const now = performance.now();
            const interval = this.colorCountIntervalMs();
            const elapsed = now - this._colorCountLastAt;
            const quiet = now - (this._lastPointerActivityAt || 0);
            const quietNeeded = this.colorCountQuietMs();
            // Never mid-stroke, never before the interval, and never until the
            // pointer has actually been still.
            if (this.state.isDrawing || elapsed < interval || quiet < quietNeeded) {
                if (this._colorCountTimer) return;
                const wait = Math.max(
                    this.state.isDrawing ? interval : 0,
                    Math.round(interval - elapsed),
                    Math.round(quietNeeded - quiet),
                    16
                );
                this._colorCountTimer = setTimeout(() => {
                    this._colorCountTimer = null;
                    this.deferColorCounts();
                }, wait);
                return;
            }
            this._colorCountPending = true;
            const run = () => {
                this._colorCountPending = false;
                this._colorCountLastAt = performance.now();
                this.updateColorCounts();
            };
            if (window.requestIdleCallback) {
                // A big canvas waits for genuine idle rather than forcing itself
                // in after 200 ms, which lands right on the end of a stroke.
                requestIdleCallback(run, { timeout: Math.max(200, interval) });
            } else {
                setTimeout(run, 0);
            }
        }
        getRotationDisplayDegrees(deg) {
            let v = deg % 360;
            if (v < 0) v += 360;
            if (v >= 360) v -= 360;
            return v;
        }
        setStatusRotation(deg) {
            if (!this.ui.statusRotation) return;
            const v = this.getRotationDisplayDegrees(deg);
            const next = `Rot: ${v.toFixed(2)}°`;
            if (next === this._lastRotationStatusText) return;
            this._lastRotationStatusText = next;
            this.ui.statusRotation.textContent = next;
        }
        clearStatusRotation() {
            if (!this.ui.statusRotation) return;
            const next = 'Rot: 0.00°';
            if (next === this._lastRotationStatusText) return;
            this._lastRotationStatusText = next;
            this.ui.statusRotation.textContent = next;
        }

        compositeRgbOver(bg, fg) {
            const a = Math.max(0, Math.min(1, (fg.a || 0)));
            const inv = 1 - a;
            return {
                r: (fg.r * a) + (bg.r * inv),
                g: (fg.g * a) + (bg.g * inv),
                b: (fg.b * a) + (bg.b * inv)
            };
        }
        sampleCompositedCanvasPixel(x, y) {
            const w = Math.max(1, this.config.width | 0);
            const h = Math.max(1, this.config.height | 0);
            const px = Math.max(0, Math.min(w - 1, Math.floor(x)));
            const py = Math.max(0, Math.min(h - 1, Math.floor(y)));
            let out = { r: 255, g: 255, b: 255 };
            try {
                const main = this.ctx.getImageData(px, py, 1, 1).data;
                out = this.compositeRgbOver(out, {
                    r: main[0], g: main[1], b: main[2], a: main[3] / 255
                });
                const temp = this.ctxTemp.getImageData(px, py, 1, 1).data;
                out = this.compositeRgbOver(out, {
                    r: temp[0], g: temp[1], b: temp[2], a: temp[3] / 255
                });
            } catch (err) {
                // Keep a stable fallback if pixel readback is unavailable.
                out = { r: 255, g: 255, b: 255 };
            }
            return {
                r: Math.max(0, Math.min(255, Math.round(out.r))),
                g: Math.max(0, Math.min(255, Math.round(out.g))),
                b: Math.max(0, Math.min(255, Math.round(out.b)))
            };
        }
        discardActiveShape() {
            if (!this.state.activeShape) return;
            this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
            this.state.activeShape = null;
            this.state.shapeEditMode = false;
            this._activeShapeBoundsCache = null;
            this._activeShapeBoundsCacheShape = null;
            this.ui.selControls.style.display = 'none';
            if (this.ui.pathHandles) this.ui.pathHandles.replaceChildren();
            this.state.activeShapePathHandle = null;
            this.state.isRotatingShape = false;
            this.state.shapeRotateSession = null;
            this.state.shapeResizeAnchor = null;
            this.state.shapeResizeBase = null;
            this.clearStatusSelectionSize();
            this.requestGlobalOverlayUpdate();
        }

        // Every field below describes an edit that is *in progress*, not the
        // document itself. It is scoped to one editing gesture and must never
        // survive a document swap (tab switch, open, new) — carrying any of it
        // across makes undo() take a branch that belongs to the other document.
        // Keep this list next to the state initializer it mirrors.
        resetTransientEditState() {
            const s = this.state;
            s.isDrawing = false;
            s.startPos = { x: 0, y: 0 };
            s.isCanvasResizing = false; s.rDir = '';
            // Selection gesture
            s.selection = null;
            s.isMovingSel = false; s.isRotatingSel = false;
            s.selStart = { x: 0, y: 0 }; s.dragHandle = null;
            s.selectionOriginalPos = null;
            s.selectionRotateSession = null;
            s.selectionCutStep = null;
            s.selectionJustCreated = false;
            s.selectionIgnoreClickUntil = 0;
            s.selectionIgnoreNextClick = false;
            s.tempSelectionDrawRect = null;
            // Shape gesture
            s.activeShape = null; s.shapeEditMode = false;
            s.activeShapePathHandle = null;
            s.shapeDragStart = null; s.shapeDragBase = null;
            s.isRotatingShape = false; s.shapeRotateSession = null;
            s.shapeResizeAnchor = null; s.shapeResizeBase = null;
            // Curve gesture — curveUndo is the redo draft and is the single
            // worst offender: it makes redo() replay another document's curve.
            s.curvePhase = 0; s.curvePts = [];
            s.curveUndo = null;
            // Freehand / brush gestures
            s.freehandPathActive = false; s.freehandPathPoints = [];
            s.freehandActive = false; s.freehandPoints = [];
            s.paintbrushActive = false;
            s.smartPencilActive = false;
            s.pencilCtrlAxis = null;
            // Polyline / lasso / wand gestures
            s.polyActive = false; s.polyPoints = [];
            s.lassoActive = false; s.lassoMode = null;
            s.lassoPoints = []; s.lassoIsDown = false; s.lassoStart = null;
            s.wandActive = false; s.wandStart = null; s.wandStartScreen = null;
            s.wandBase = null; s.wandDiff = null; s.wandVisited = null;
            s.wandMaskCanvas = null; s.wandMaskImageData = null;
            // Viewport / canvas drag gestures
            s.isPanning = false; s.isCanvasDragging = false;
            s.canvasOriginalSize = null;
            s.resizeAnchor = null;
            s.resizePreviewActive = false;
            s.resizePreviewRect = null; s.resizePreviewGhost = null;
            // Adjustment-dialog live preview
            s.hueSatActive = false; s.hueSatApplied = false; s.hueSatDragging = false;
            // NOTE: wandJobId is deliberately not reset — it is a monotonic
            // counter used to invalidate in-flight async wand jobs.
        }

        // Land every in-progress edit so the document is in a quiescent, fully
        // described state. Call before snapshotting or replacing the document.
        // commit:false discards drafts instead of stamping them.
        endInteractiveEdit(opts) {
            const commit = !opts || opts.commit !== false;
            // Queued stroke frames first — they still have pixels to land.
            if (commit && this.state.isDrawing) {
                try { this.flushStrokes(); } catch (e) { /* transient stroke state */ }
            }
            this.cancelPendingStrokes();
            if (this.brush && typeof this.brush.endStroke === 'function') {
                try { this.brush.endStroke(); } catch (e) { /* ignore */ }
            }
            // A freehand path still active here means the gesture never reached
            // pointer-up, so there is no committable result either way.
            try {
                if (typeof FreehandPathEngine !== 'undefined' &&
                    FreehandPathEngine.isActive && FreehandPathEngine.isActive()) {
                    FreehandPathEngine.cancel();
                }
            } catch (e) { /* ignore */ }
            // A palette preview repaints the canvas without recording history, so
            // while one is live the canvas does not match history[step]. It is
            // transient hover UI, never part of the document — always drop it.
            try { if (this.state.previewPaletteId) this.exitPreview(); } catch (e) { /* ignore */ }
            // Point-collection drafts have no pixels until finalized.
            try { if (this.state.polyActive) this.cancelPolyline(); } catch (e) { /* ignore */ }
            try { if (this.state.lassoActive) this.resetLassoState(); } catch (e) { /* ignore */ }
            // Gradient must be resolved before the selection is: gradientApply()
            // clips to the live selection mask.
            try {
                if (this.config.gradient && this.config.gradient.active) {
                    if (commit) this.gradientApply(); else this.gradientDiscard();
                }
            } catch (e) { console.warn('[Doc] gradient finalize failed', e); }
            // Shapes and selections carry real pixels — these are the only two
            // that respect the commit flag.
            try {
                if (this.state.activeShape) {
                    if (commit) this.commitActiveShape(); else this.discardActiveShape();
                }
            } catch (e) { console.warn('[Doc] shape finalize failed', e); }
            try {
                if (this.state.selection) {
                    if (commit) this.commitSelection(); else this.cancelSelection();
                }
            } catch (e) { console.warn('[Doc] selection finalize failed', e); }
            // Whatever is left is pure draft bookkeeping.
            this.resetTransientEditState();
        }

        // Bakes any negative w/h flip into s.canvas so that s.w and s.h are
        // always positive before a new resize drag begins. Without this, starting
        // a side-handle drag after a corner flip (or vice-versa) would revert the
        // flip because the resize math recalculates w/h from scratch as a positive distance.
        setPickerPreviewEnabled(enabled) {
            this.config.pickerHoverPreview = !!enabled;
            this.lsSet('paint.pickerHoverPreview', this.config.pickerHoverPreview ? 'true' : 'false');
            this.syncPickerMenu();
            if (!this.config.pickerHoverPreview) this.setPickerCursorBase();
        }
        togglePickerPreview() {
            this.setPickerPreviewEnabled(!this.config.pickerHoverPreview);
            this.closeMenus();
        }
        ensurePickerCursorAssets() {
            if (!this.pickerCursorBase) return false;
            if (!this.pickerCursorImg) {
                this.pickerCursorImg = new Image();
                this.pickerCursorImg.src = this.pickerCursorBase;
            }
            if (!this.pickerCursorImg.complete) return false;
            if (!this.pickerCursorCanvas || this.pickerCursorCanvas.width !== this.pickerCursorImg.width || this.pickerCursorCanvas.height !== this.pickerCursorImg.height) {
                this.pickerCursorCanvas = document.createElement('canvas');
                this.pickerCursorCanvas.width = this.pickerCursorImg.width;
                this.pickerCursorCanvas.height = this.pickerCursorImg.height;
                this.pickerCursorCtx = this.pickerCursorCanvas.getContext('2d');
            }
            return true;
        }
        setPickerCursorBase() {
            if (this.pickerCursorBase) {
                const hx = this.pickerCursorHotspot ? this.pickerCursorHotspot.x : 2;
                const hy = this.pickerCursorHotspot ? this.pickerCursorHotspot.y : 21;
                this.ui.stage.style.cursor = `url("${this.pickerCursorBase}") ${hx} ${hy}, crosshair`;
            }
            this.pickerCursorHex = null;
        }
        updatePickerPreviewAt(x, y) {
            if (!this.config.pickerHoverPreview) return;
            if (x < 0 || y < 0 || x >= this.config.width || y >= this.config.height) {
                return;
            }
            const px = Math.floor(x);
            const py = Math.floor(y);
            const data = this.ctx.getImageData(px, py, 1, 1).data;
            const hex = this.rgbToHex(data[0], data[1], data[2]);
            this.updatePickerCursorSwatch(hex);
        }
        flattenCanvasAlpha(ctx, w, h) {
            const img = ctx.getImageData(0, 0, w, h);
            const data = img.data;
            for (let i = 0; i < data.length; i += 4) {
                const a = data[i + 3];
                if (a === 255) continue;
                const inv = 255 - a;
                data[i] = Math.round((data[i] * a + 255 * inv) / 255);
                data[i + 1] = Math.round((data[i + 1] * a + 255 * inv) / 255);
                data[i + 2] = Math.round((data[i + 2] * a + 255 * inv) / 255);
                data[i + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
        }

        getHandles(s) {
            const r = this.getNormalizedRect(s);
            const x = r.x, y = r.y, w = r.w, h = r.h;
            return [
                {x:x, y:y, id:'nw'}, {x:x+w/2, y:y, id:'n'}, {x:x+w, y:y, id:'ne'},
                {x:x+w, y:y+h/2, id:'e'}, {x:x+w, y:y+h, id:'se'}, {x:x+w/2, y:y+h, id:'s'},
                {x:x, y:y+h, id:'sw'}, {x:x, y:y+h/2, id:'w'}
            ];
        }

        checkHandles(mx, my) {
            const t = this.state.activeShape || this.state.selection;
            if(!t) return null;
            const tolerance = 5;
            for(let h of this.getHandles(t)) {
                if(Math.abs(mx-h.x) < tolerance && Math.abs(my-h.y) < tolerance) return h.id;
            }
            return null;
        }

        getActiveShapePathHandles() {
            const s = this.state.activeShape;
            if (!s) return [];
            if (s.type === 'line') {
                return [
                    { x: s.x, y: s.y, kind: 'line', idx: 0, role: 'start' },
                    { x: s.x + s.w, y: s.y + s.h, kind: 'line', idx: 1, role: 'end' }
                ];
            }
            if (s.type === 'curve' && s.points && s.points.length >= 4) {
                // Multi-segment paths don't get individual control handles yet —
                // the user can use the resize and rotate handles instead.
                if (s.multiSeg) return [];
                const pts = s.points.map(pt => ({ x: s.x + pt.x * s.w, y: s.y + pt.y * s.h }));
                const p0 = pts[0], p3 = pts[1], c1 = pts[2], c2 = pts[3];
                return [
                    { x: p0.x, y: p0.y, kind: 'curve', idx: 0, role: 'start' },
                    { x: this.evalCubic(p0, c1, c2, p3, 1/3).x, y: this.evalCubic(p0, c1, c2, p3, 1/3).y, kind: 'curve', idx: 1, role: 'ctrl1', t: 1/3 },
                    { x: this.evalCubic(p0, c1, c2, p3, 2/3).x, y: this.evalCubic(p0, c1, c2, p3, 2/3).y, kind: 'curve', idx: 2, role: 'ctrl2', t: 2/3 },
                    { x: p3.x, y: p3.y, kind: 'curve', idx: 3, role: 'end' }
                ];
            }
            if (s.type === 'poly' && s.points && s.points.length) {
                return s.points.map((pt, idx) => ({
                    x: s.x + pt.x * s.w,
                    y: s.y + pt.y * s.h,
                    kind: 'poly',
                    idx,
                    role: 'vertex'
                }));
            }
            return [];
        }

        updatePathHandles() {
            const container = this.ui.pathHandles;
            if (!container) return;
            const s = this.state.activeShape;
            const clear = () => {
                if (container.childElementCount) container.replaceChildren();
                container._pathHandlesSig = '';
                container._phType = null;
                container._phCount = 0;
                container._phW = null;
                container._phH = null;
                container._phRot = null;
                container._phZoom = null;
                container._phPointsRef = null;
            };
            if (!this.state.shapeEditMode || !s) {
                clear();
                return;
            }

            let count = 0;
            if (s.type === 'line') {
                count = 2;
            } else if (s.type === 'curve' && s.points && s.points.length >= 4) {
                count = 4;
            } else if (s.type === 'poly' && s.points && s.points.length) {
                count = s.points.length;
            }
            if (!count) {
                clear();
                return;
            }

            const sig = `${s.type}|${count}`;
            let didRebuild = false;
            if (container._pathHandlesSig !== sig || container.childElementCount !== count) {
                didRebuild = true;
                container._pathHandlesSig = sig;
                container.replaceChildren();
                const frag = document.createDocumentFragment();
                if (s.type === 'line') {
                    const a = document.createElement('div');
                    a.className = 'path-handle';
                    a.setAttribute('data-idx', '0');
                    a.setAttribute('data-kind', 'line');
                    a.setAttribute('data-role', 'start');
                    frag.appendChild(a);
                    const b = document.createElement('div');
                    b.className = 'path-handle';
                    b.setAttribute('data-idx', '1');
                    b.setAttribute('data-kind', 'line');
                    b.setAttribute('data-role', 'end');
                    frag.appendChild(b);
                } else if (s.type === 'curve') {
                    const roles = [
                        { idx: 0, role: 'start' },
                        { idx: 1, role: 'ctrl1', t: 1/3 },
                        { idx: 2, role: 'ctrl2', t: 2/3 },
                        { idx: 3, role: 'end' }
                    ];
                    for (const r of roles) {
                        const el = document.createElement('div');
                        el.className = 'path-handle';
                        el.setAttribute('data-idx', String(r.idx));
                        el.setAttribute('data-kind', 'curve');
                        el.setAttribute('data-role', r.role);
                        if (r.t !== undefined) el.setAttribute('data-t', String(r.t));
                        frag.appendChild(el);
                    }
                } else if (s.type === 'poly') {
                    for (let i = 0; i < count; i++) {
                        const el = document.createElement('div');
                        el.className = 'path-handle';
                        el.setAttribute('data-idx', String(i));
                        el.setAttribute('data-kind', 'poly');
                        el.setAttribute('data-role', 'vertex');
                        frag.appendChild(el);
                    }
                }
                container.appendChild(frag);
            }

            const rot = this.getShapeRotationDegrees(s);
            const zoom = this.config.zoom || 1;
            // If only the shape translation changed, the selection UI moving is enough to carry the
            // handle elements with it (relative positions are unchanged). Avoid O(N) per-frame DOM writes.
            const pointsRef = (s.type === 'poly' || s.type === 'curve') ? (s.points || null) : null;
            if (!didRebuild
                && container._phType === s.type
                && container._phCount === count
                && container._phW === s.w
                && container._phH === s.h
                && container._phRot === rot
                && container._phZoom === zoom
                && container._phPointsRef === pointsRef
            ) {
                return;
            }
            container._phType = s.type;
            container._phCount = count;
            container._phW = s.w;
            container._phH = s.h;
            container._phRot = rot;
            container._phZoom = zoom;
            container._phPointsRef = pointsRef;

            const rect = (this._activeShapeBoundsCacheShape === s && this._activeShapeBoundsCache)
                ? this._activeShapeBoundsCache
                : this.getActiveShapeBounds(s);
            const centerX = (s.type === 'curve' && s.points && s.points.length >= 4)
                ? (() => { const wp = s.points.map(pt => ({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h })); const a = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]); return (a.minX + a.maxX) / 2; })()
                : s.x + s.w / 2;
            const centerY = (s.type === 'curve' && s.points && s.points.length >= 4)
                ? (() => { const wp = s.points.map(pt => ({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h })); const a = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]); return (a.minY + a.maxY) / 2; })()
                : s.y + s.h / 2;
            const useRot = Math.abs(rot) > 0.01;
            const rad = useRot ? (rot * Math.PI / 180) : 0;
            const cos = useRot ? Math.cos(rad) : 1;
            const sin = useRot ? Math.sin(rad) : 0;

            const children = container.children;
            if (s.type === 'line') {
                const pts = [
                    { x: s.x, y: s.y },
                    { x: s.x + s.w, y: s.y + s.h }
                ];
                for (let i = 0; i < 2; i++) {
                    const baseX = pts[i].x;
                    const baseY = pts[i].y;
                    let wx = baseX;
                    let wy = baseY;
                    if (useRot) {
                        const dx = baseX - centerX;
                        const dy = baseY - centerY;
                        wx = centerX + (dx * cos - dy * sin);
                        wy = centerY + (dx * sin + dy * cos);
                    }
                    const el = children[i];
                    el.style.left = `${Math.round((wx - rect.x) * zoom) - 3}px`;
                    el.style.top = `${Math.round((wy - rect.y) * zoom) - 3}px`;
                }
                return;
            }

            if (s.type === 'curve' && s.points && s.points.length >= 4) {
                const pts = s.points;
                const p0 = { x: s.x + pts[0].x * s.w, y: s.y + pts[0].y * s.h };
                const p3 = { x: s.x + pts[1].x * s.w, y: s.y + pts[1].y * s.h };
                const c1 = { x: s.x + pts[2].x * s.w, y: s.y + pts[2].y * s.h };
                const c2 = { x: s.x + pts[3].x * s.w, y: s.y + pts[3].y * s.h };
                const mid1 = this.evalCubic(p0, c1, c2, p3, 1/3);
                const mid2 = this.evalCubic(p0, c1, c2, p3, 2/3);
                const handles = [p0, mid1, mid2, p3];
                for (let i = 0; i < 4; i++) {
                    const baseX = handles[i].x;
                    const baseY = handles[i].y;
                    let wx = baseX;
                    let wy = baseY;
                    if (useRot) {
                        const dx = baseX - centerX;
                        const dy = baseY - centerY;
                        wx = centerX + (dx * cos - dy * sin);
                        wy = centerY + (dx * sin + dy * cos);
                    }
                    const el = children[i];
                    el.style.left = `${Math.round((wx - rect.x) * zoom) - 3}px`;
                    el.style.top = `${Math.round((wy - rect.y) * zoom) - 3}px`;
                }
                return;
            }

            if (s.type === 'poly' && s.points && s.points.length) {
                const pts = s.points;
                for (let i = 0; i < pts.length; i++) {
                    const baseX = s.x + pts[i].x * s.w;
                    const baseY = s.y + pts[i].y * s.h;
                    let wx = baseX;
                    let wy = baseY;
                    if (useRot) {
                        const dx = baseX - centerX;
                        const dy = baseY - centerY;
                        wx = centerX + (dx * cos - dy * sin);
                        wy = centerY + (dx * sin + dy * cos);
                    }
                    const el = children[i];
                    el.style.left = `${Math.round((wx - rect.x) * zoom) - 3}px`;
                    el.style.top = `${Math.round((wy - rect.y) * zoom) - 3}px`;
                }
            }
        }

        updateActiveShapePathHandle(handle, p, baseShape = null) {
            const s = this.state.activeShape;
            if (!s) return;
            const source = baseShape || s;
            const cp = this.clampPointToCanvasPixel(p);
            const rot = this.getShapeRotationDegrees(source);
            let center;
            if (source.type === 'curve' && source.points && source.points.length >= 4) {
                const wp = source.points.map(pt => ({ x: source.x + pt.x*source.w, y: source.y + pt.y*source.h }));
                const aabb = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]);
                center = { x: (aabb.minX + aabb.maxX) / 2, y: (aabb.minY + aabb.maxY) / 2 };
            } else {
                center = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
            }
            // Path handle drags should be stable regardless of any prior rotate/resize operations.
            // Work in world space (what the user sees) and bake rotation into the geometry.
            const toWorld = (pt) => rot ? this.rotatePoint(pt, center, rot) : pt;
            if (source.type === 'line') {
                const p0w = toWorld({ x: source.x, y: source.y });
                const p1w = toWorld({ x: source.x + source.w, y: source.y + source.h });
                const n0 = handle.idx === 0 ? { x: cp.x, y: cp.y } : p0w;
                const n1 = handle.idx === 0 ? p1w : { x: cp.x, y: cp.y };
                s.type = 'line';
                s.rotation = 0;
                s.x = n0.x;
                s.y = n0.y;
                s.w = n1.x - n0.x;
                s.h = n1.y - n0.y;
                return;
            }
            if (source.type === 'curve' && source.points && source.points.length >= 4) {
                const pts = source.points.map(pt => toWorld({ x: source.x + pt.x * source.w, y: source.y + pt.y * source.h }));
                const p0 = pts[0];
                const p3 = pts[1];
                const c1 = pts[2];
                const c2 = pts[3];
                const t1 = 1 / 3;
                const t2 = 2 / 3;
                const mid1 = this.evalCubic(p0, c1, c2, p3, t1);
                const mid2 = this.evalCubic(p0, c1, c2, p3, t2);
                let newP0 = { x: p0.x, y: p0.y };
                let newP3 = { x: p3.x, y: p3.y };
                let target1 = { x: mid1.x, y: mid1.y };
                let target2 = { x: mid2.x, y: mid2.y };

                if (handle.role === 'start') {
                    newP0 = { x: cp.x, y: cp.y };
                } else if (handle.role === 'end') {
                    newP3 = { x: cp.x, y: cp.y };
                } else if (handle.role === 'ctrl1') {
                    target1 = { x: cp.x, y: cp.y };
                } else if (handle.role === 'ctrl2') {
                    target2 = { x: cp.x, y: cp.y };
                }

                const a1 = Math.pow(1 - t1, 3);
                const b1 = 3 * Math.pow(1 - t1, 2) * t1;
                const c1w = 3 * (1 - t1) * t1 * t1;
                const d1 = t1 * t1 * t1;
                const a2 = Math.pow(1 - t2, 3);
                const b2 = 3 * Math.pow(1 - t2, 2) * t2;
                const c2w = 3 * (1 - t2) * t2 * t2;
                const d2 = t2 * t2 * t2;
                const det = (b1 * c2w) - (b2 * c1w);

                let out = [
                    { x: newP0.x, y: newP0.y },
                    { x: newP3.x, y: newP3.y },
                    { x: c1.x, y: c1.y },
                    { x: c2.x, y: c2.y }
                ];
                if (Math.abs(det) > 1e-6) {
                    const r1x = target1.x - (a1 * newP0.x + d1 * newP3.x);
                    const r1y = target1.y - (a1 * newP0.y + d1 * newP3.y);
                    const r2x = target2.x - (a2 * newP0.x + d2 * newP3.x);
                    const r2y = target2.y - (a2 * newP0.y + d2 * newP3.y);
                    const nc1x = (r1x * c2w - r2x * c1w) / det;
                    const nc1y = (r1y * c2w - r2y * c1w) / det;
                    const nc2x = (b1 * r2x - b2 * r1x) / det;
                    const nc2y = (b1 * r2y - b2 * r1y) / det;
                    out = [
                        { x: newP0.x, y: newP0.y },
                        { x: newP3.x, y: newP3.y },
                        { x: nc1x, y: nc1y },
                        { x: nc2x, y: nc2y }
                    ];
                }

                let minX, maxX, minY, maxY;
                { const ab = this.cubicBezierAABB(out[0], out[2], out[3], out[1]);
                  minX = ab.minX; maxX = ab.maxX; minY = ab.minY; maxY = ab.maxY; }
                let w = maxX - minX; let h = maxY - minY;
                if (w === 0) w = 1;
                if (h === 0) h = 1;
                s.type = 'curve';
                s.rotation = 0;
                s.x = minX; s.y = minY; s.w = w; s.h = h;
                s.points = out.map(pt => ({ x: (pt.x - minX) / w, y: (pt.y - minY) / h }));
                return;
            }
            if (source.type === 'poly' && source.points && source.points.length) {
                const pts = source.points.map(pt => toWorld({ x: source.x + pt.x * source.w, y: source.y + pt.y * source.h }));
                const idx = Math.min(Math.max(handle.idx, 0), pts.length - 1);
                pts[idx] = { x: cp.x, y: cp.y };
                let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
                for (let i = 1; i < pts.length; i++) {
                    minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
                    minY = Math.min(minY, pts[i].y); maxY = Math.max(maxY, pts[i].y);
                }
                let w = maxX - minX; let h = maxY - minY;
                if (w === 0) w = 1;
                if (h === 0) h = 1;
                s.type = 'poly';
                s.rotation = 0;
                if (typeof source.closed === 'boolean') s.closed = source.closed;
                s.x = minX; s.y = minY; s.w = w; s.h = h;
                s.points = pts.map(pt => ({ x: (pt.x - minX) / w, y: (pt.y - minY) / h }));
                return;
            }
        }

        pointInRect(x,y,r) {
            const nr = this.getNormalizedRect(r);
            return x>=nr.x && x<=nr.x+nr.w && y>=nr.y && y<=nr.y+nr.h;
        }
        pointInActiveShapeRect(x, y, s) {
            if (!s) return false;
            const rot = this.getShapeRotationDegrees(s);
            let center;
            if (s.type === 'curve' && s.points && s.points.length >= 4) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                if (s.multiSeg) {
                    for (let i = 0; i < s.points.length; i += 4) {
                        if (i + 3 >= s.points.length) break;
                        const wp0 = { x: s.x + s.points[i].x * s.w,     y: s.y + s.points[i].y * s.h };
                        const wp1 = { x: s.x + s.points[i+1].x * s.w,   y: s.y + s.points[i+1].y * s.h };
                        const wp2 = { x: s.x + s.points[i+2].x * s.w,   y: s.y + s.points[i+2].y * s.h };
                        const wp3 = { x: s.x + s.points[i+3].x * s.w,   y: s.y + s.points[i+3].y * s.h };
                        const aabb = this.cubicBezierAABB(wp0, wp2, wp3, wp1);
                        minX = Math.min(minX, aabb.minX); maxX = Math.max(maxX, aabb.maxX);
                        minY = Math.min(minY, aabb.minY); maxY = Math.max(maxY, aabb.maxY);
                    }
                } else {
                    const wp = s.points.map(pt => ({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h }));
                    const aabb = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]);
                    minX = aabb.minX; maxX = aabb.maxX; minY = aabb.minY; maxY = aabb.maxY;
                }
                center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
            } else {
                center = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
            }
            const p = rot ? this.rotatePoint({ x, y }, center, -rot) : { x, y };
            return this.pointInRect(p.x, p.y, s);
        }

        evalCubic(p0, p1, p2, p3, t) {
            const u = 1 - t;
            const a = u * u * u;
            const b = 3 * u * u * t;
            const c = 3 * u * t * t;
            const d = t * t * t;
            return {
                x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
                y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
            };
        }

        cubicBezierAABB(p0, c1, c2, p3) {
            const extrema = (a, b, c, d) => {
                const da = -3*a + 9*b - 9*c + 3*d;
                const db =  6*a - 12*b + 6*c;
                const dc = -3*a + 3*b;
                const ts = [];
                if (Math.abs(da) < 1e-10) {
                    if (Math.abs(db) > 1e-10) ts.push(-dc / db);
                } else {
                    const disc = db*db - 4*da*dc;
                    if (disc >= 0) {
                        const sq = Math.sqrt(disc);
                        ts.push((-db + sq) / (2*da));
                        ts.push((-db - sq) / (2*da));
                    }
                }
                return ts.filter(t => t > 0 && t < 1);
            };
            const evalT = (t, a, b, c, d) => {
                const mt = 1 - t;
                return mt*mt*mt*a + 3*mt*mt*t*b + 3*mt*t*t*c + t*t*t*d;
            };
            const txs = extrema(p0.x, c1.x, c2.x, p3.x);
            const tys = extrema(p0.y, c1.y, c2.y, p3.y);
            const xs = [p0.x, p3.x, ...txs.map(t => evalT(t, p0.x, c1.x, c2.x, p3.x))];
            const ys = [p0.y, p3.y, ...tys.map(t => evalT(t, p0.y, c1.y, c2.y, p3.y))];
            return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
        }

        getActiveShapeBounds(s) {
            if (!s) return { x: 0, y: 0, w: 0, h: 0 };
            const rot = this.getShapeRotationDegrees(s);
            if (Math.abs(rot) <= 0.01) {
                if (s.type === 'curve' && s.points && s.points.length >= 4) {
                    if (s.multiSeg) {
                        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                        for (let i = 0; i < s.points.length; i += 4) {
                            if (i + 3 >= s.points.length) break;
                            const wp0 = { x: s.x + s.points[i].x * s.w,     y: s.y + s.points[i].y * s.h };
                            const wp1 = { x: s.x + s.points[i+1].x * s.w,   y: s.y + s.points[i+1].y * s.h };
                            const wp2 = { x: s.x + s.points[i+2].x * s.w,   y: s.y + s.points[i+2].y * s.h };
                            const wp3 = { x: s.x + s.points[i+3].x * s.w,   y: s.y + s.points[i+3].y * s.h };
                            const aabb = this.cubicBezierAABB(wp0, wp2, wp3, wp1);
                            minX = Math.min(minX, aabb.minX); maxX = Math.max(maxX, aabb.maxX);
                            minY = Math.min(minY, aabb.minY); maxY = Math.max(maxY, aabb.maxY);
                        }
                        return { x: minX, y: minY, w: maxX - minX || 1, h: maxY - minY || 1 };
                    }
                    const wp = s.points.map(pt => ({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h }));
                    // draw order: (wp[0]=start, wp[2]=ctrl1, wp[3]=ctrl2, wp[1]=end)
                    const { minX, maxX, minY, maxY } = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]);
                    return { x: minX, y: minY, w: maxX - minX || 1, h: maxY - minY || 1 };
                }
                return this.getNormalizedRect(s);
            }
            const center = { x: s.x + s.w / 2, y: s.y + s.h / 2 };
            const rotate = (pt) => this.rotatePoint(pt, center, rot);
            const pts = [];

            if (s.type === 'rect') {
                pts.push(
                    rotate({ x: s.x, y: s.y }),
                    rotate({ x: s.x + s.w, y: s.y }),
                    rotate({ x: s.x + s.w, y: s.y + s.h }),
                    rotate({ x: s.x, y: s.y + s.h })
                );
            } else if (s.type === 'tri') {
                pts.push(
                    rotate({ x: s.x + s.w / 2, y: s.y }),
                    rotate({ x: s.x, y: s.y + s.h }),
                    rotate({ x: s.x + s.w, y: s.y + s.h })
                );
            } else if (s.type === 'line') {
                pts.push(
                    rotate({ x: s.x, y: s.y }),
                    rotate({ x: s.x + s.w, y: s.y + s.h })
                );
            } else if (s.type === 'circle') {
                const cx = s.x + s.w / 2;
                const cy = s.y + s.h / 2;
                const rx = Math.abs(s.w / 2);
                const ry = Math.abs(s.h / 2);
                const segs = this.buildEllipseSegs(cx, cy, rx, ry);
                for (const seg of segs) {
                    pts.push(rotate(seg.p0), rotate(seg.p1), rotate(seg.p2), rotate(seg.p3));
                }
            } else if (s.type === 'curve') {
                if (s.multiSeg) {
                    for (let i = 0; i < s.points.length; i += 4) {
                        if (i + 3 >= s.points.length) break;
                        const wp0 = rotate({ x: s.x + s.points[i].x * s.w,     y: s.y + s.points[i].y * s.h });
                        const wp1 = rotate({ x: s.x + s.points[i+1].x * s.w,   y: s.y + s.points[i+1].y * s.h });
                        const wp2 = rotate({ x: s.x + s.points[i+2].x * s.w,   y: s.y + s.points[i+2].y * s.h });
                        const wp3 = rotate({ x: s.x + s.points[i+3].x * s.w,   y: s.y + s.points[i+3].y * s.h });
                        const aabb = this.cubicBezierAABB(wp0, wp2, wp3, wp1);
                        pts.push({ x: aabb.minX, y: aabb.minY }, { x: aabb.maxX, y: aabb.maxY });
                    }
                } else {
                    const wp = s.points.map(pt => rotate({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h }));
                    // draw order: (wp[0]=start, wp[2]=ctrl1, wp[3]=ctrl2, wp[1]=end)
                    const { minX, maxX, minY, maxY } = this.cubicBezierAABB(wp[0], wp[2], wp[3], wp[1]);
                    return { x: minX, y: minY, w: maxX - minX || 1, h: maxY - minY || 1 };
                }
            } else if (s.type === 'poly') {
                const p = s.points.map(pt => rotate({ x: s.x + pt.x*s.w, y: s.y + pt.y*s.h }));
                pts.push(...p);
            }

            if (!pts.length) return this.getNormalizedRect(s);
            let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
            for (let i = 1; i < pts.length; i++) {
                minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
                minY = Math.min(minY, pts[i].y); maxY = Math.max(maxY, pts[i].y);
            }
            const w = maxX - minX || 1;
            const h = maxY - minY || 1;
            return { x: minX, y: minY, w, h };
        }

        getShapeRotationDegrees(shape = this.state.activeShape) {
            if (!shape) return 0;
            return this.normalizeAngleDegrees(shape.rotation || 0);
        }

        applyShapeRotation(angleDeg, options = {}) {
            const shape = this.state.activeShape;
            if (!shape) return;
            shape.rotation = this.normalizeAngleDegrees(angleDeg);
            const session = options.session || null;
            if (session) session.angle = shape.rotation;
            this.renderActiveShape();
        }

        beginShapeRotation(pointer, event) {
            if (!this.state.activeShape) return;
            const s = this.state.activeShape;
            /* Use the displayed bounds center (tight AABB for curves) so the
               rotation pivot matches the visible selection box exactly. */
            const b = this.getActiveShapeBounds(s);
            const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
            const baseRotation = this.getShapeRotationDegrees(s);
            const pointerAngle = this.getAngleDegrees(center, pointer);
            this.state.isDrawing = false;
            this.state.isMovingSel = false;
            this.state.dragHandle = null;
            this.state.isRotatingShape = true;
            this.state.shapeRotateSession = {
                center,
                lastPointerAngle: pointerAngle,
                accumulatedDelta: 0,
                baseRotation,
                angle: 0
            };
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
        }

        updateShapeRotation(pointer, event) {
            const session = this.state.shapeRotateSession;
            if (!this.state.activeShape || !session) return;
            const currentAngle = this.getAngleDegrees(session.center, pointer);
            const rawStep = this.getSignedAngleDelta(session.lastPointerAngle, currentAngle);
            session.lastPointerAngle = currentAngle;

            // 1:1 angular tracking — Alt key enables fine/slow mode.
            const step = rawStep * (event && event.altKey ? 0.2 : 1);

            session.accumulatedDelta += step;
            let delta = session.accumulatedDelta;

            let angle = (session.baseRotation || 0) + delta;
            if (event && event.ctrlKey) angle = Math.round(angle / 45) * 45;
            else if (event && event.shiftKey) angle = Math.round(angle / 15) * 15;
            this.applyShapeRotation(angle, { session });
            this.updateHoverPreview(Math.round(pointer.x), Math.round(pointer.y));
        }

        endShapeRotation() {
            if (!this.state.isRotatingShape) return;
            this.state.isRotatingShape = false;
            this.state.shapeRotateSession = null;
            this.state.selectionIgnoreNextClick = true;
            this.state.selectionIgnoreClickUntil = Date.now() + 1000;
            if (!this.state.activeShape) return;
            this.renderActiveShape();
        }

        drawBinaryPoint(x, y, color) {
            const isEraser = this.config.tool === 'eraser';
            if(isEraser) {

                if (!this.brushCache || this.brushCache.color !== color || this.brushCache.size !== this.config.eraserWidth || !this.brushCache.isSquare) {
                    this.updateBrushCache(color, true, this.config.eraserWidth);
                }
            }

            const width = isEraser ? this.config.eraserWidth : this.config.lineWidth;
            if (!this.brushCache || this.brushCache.color !== color || this.brushCache.size !== width || (isEraser !== this.brushCache.isSquare)) {
                this.updateBrushCache(color, isEraser, width);
            }
            const sprite = this.brushCache.canvas;
            this.disableSmoothing(this.ctx);
            this.drawSpriteTiled(this.ctx, sprite, Math.floor(x), Math.floor(y), this.brushCache.offset);
        }

        plot(ctx, x, y, c) { }

        drawBinaryLine(x0, y0, x1, y1, color, isPreview, widthOverride = null, isEraserOverride = null) {
            const ctx = isPreview ? this.ctxTemp : this.ctx;
            const isEraser = isEraserOverride !== null ? isEraserOverride : (this.config.tool === 'eraser');
            let width;
            if (widthOverride !== null) width = widthOverride;
            else width = this.getToolWidth(this.config.tool);


            if (!this.brushCache || this.brushCache.color !== color || this.brushCache.size !== width || (isEraser !== this.brushCache.isSquare)) {
                this.updateBrushCache(color, isEraser, width);
            }
            const sprite = this.brushCache.canvas, offset = this.brushCache.offset;
            let ix0 = Math.floor(x0), iy0 = Math.floor(y0), ix1 = Math.floor(x1), iy1 = Math.floor(y1);
            const dx = Math.abs(ix1 - ix0), dy = Math.abs(iy1 - iy0);
            const sx = (ix0 < ix1) ? 1 : -1, sy = (iy0 < iy1) ? 1 : -1;
            let err = dx - dy;
            this.disableSmoothing(ctx);
            while (true) {
                this.drawSpriteTiled(ctx, sprite, ix0, iy0, offset);
                if (ix0 === ix1 && iy0 === iy1) break;
                const e2 = 2 * err;
                if (e2 > -dy) { err -= dy; ix0 += sx; }
                if (e2 < dx) { err += dx; iy0 += sy; }
            }
        }

        drawBinaryRect(x,y,w,h,c,p,widthOverride = null) { this.drawBinaryLine(x,y,x+w,y,c,p,widthOverride,false); this.drawBinaryLine(x+w,y,x+w,y+h,c,p,widthOverride,false); this.drawBinaryLine(x+w,y+h,x,y+h,c,p,widthOverride,false); this.drawBinaryLine(x,y+h,x,y,c,p,widthOverride,false); }
        drawBinaryEllipse(x, y, w, h, c, p, widthOverride = null) {
            const ctx = p ? this.ctxTemp : this.ctx;
            const width = widthOverride !== null ? widthOverride : this.config.shapeWidth;
            if (!this.brushCache || this.brushCache.color !== c || this.brushCache.size !== width || this.brushCache.isSquare) {
                this.updateBrushCache(c, false, width);
            }
            const sprite = this.brushCache.canvas, offset = this.brushCache.offset;

            const cx = x + w / 2, cy = y + h / 2, rx = Math.abs(w / 2), ry = Math.abs(h / 2);
            const steps = Math.ceil(2 * Math.PI * Math.max(rx, ry));

            let lastPlotX = -99999, lastPlotY = -99999;
            this.disableSmoothing(ctx);

            for (let i = 0; i <= steps; i++) {
                const t = (i / steps) * Math.PI * 2;
                const plotX = Math.floor(cx + rx * Math.cos(t));
                const plotY = Math.floor(cy + ry * Math.sin(t));

                if (plotX !== lastPlotX || plotY !== lastPlotY) {
                    this.drawSpriteTiled(ctx, sprite, plotX, plotY, offset);
                    lastPlotX = plotX;
                    lastPlotY = plotY;
                }
            }
        }

        drawBinaryTri(x,y,w,h,c,p,widthOverride = null) { this.drawBinaryLine(x+w/2,y,x,y+h,c,p,widthOverride,false); this.drawBinaryLine(x,y+h,x+w,y+h,c,p,widthOverride,false); this.drawBinaryLine(x+w,y+h,x+w/2,y,c,p,widthOverride,false); }
        drawBinaryBezier(p0, p1, p2, p3, c, p, widthOverride = null, isEraserOverride = null) {
            const ctx = p ? this.ctxTemp : this.ctx;
            const isEraser = isEraserOverride !== null ? isEraserOverride : (this.config.tool === 'eraser');
            let width;
            if (widthOverride !== null) width = widthOverride;
            else width = this.getToolWidth(this.config.tool);

            // 1. STANDARD RENDERING (Width > 1)
            // Use the brush cache and standard interpolation
            if (width > 1.0 || isEraser) {
                if (!this.brushCache || this.brushCache.color !== c || this.brushCache.size !== width || (isEraser !== this.brushCache.isSquare)) {
                    this.updateBrushCache(c, isEraser, width);
                }
                const sprite = this.brushCache.canvas;
                const offset = this.brushCache.offset;

                const len = (Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) + Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y) + Math.abs(p3.x - p2.x) + Math.abs(p3.y - p2.y)) || 1;
                const steps = Math.ceil(len * 2);

                this.disableSmoothing(ctx);
                for(let i=0; i<=steps; i++) {
                    const t = i / steps, it = 1 - t;
                    const a = it*it*it, b = 3*it*it*t, cCoeff = 3*it*t*t, d = t*t*t;
                    const x = a*p0.x + b*p1.x + cCoeff*p2.x + d*p3.x;
                    const y = a*p0.y + b*p1.y + cCoeff*p2.y + d*p3.y;
                    this.drawSpriteTiled(ctx, sprite, Math.floor(x), Math.floor(y), offset);
                }
                return;
            }

            // 2. PIXEL-PERFECT RENDERING (Width == 1)
            // We traverse the curve and allow ONLY single-axis moves or pure diagonal moves.
            // No L-shapes allowed.

            ctx.fillStyle = c;
            this.disableSmoothing(ctx);

            // Calculate length to determine steps (oversampling ensures continuity)
            const len = (Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) + Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y) + Math.abs(p3.x - p2.x) + Math.abs(p3.y - p2.y)) || 1;
            const steps = Math.ceil(len * 3);
            this.disableSmoothing(ctx);

            // --- PIXEL PERFECT DRAWING (1px, No Shoulders) ---
            // Algorithm: Buffer the "pending" pixel. If adding the NEXT pixel
            // creates an L-turn (shoulder) with the LAST drawn pixel,
            // skip the pending pixel.

            let lastX = Math.floor(p0.x);
            let lastY = Math.floor(p0.y);

            // Draw start point
            this.fillRectTiled(ctx, lastX, lastY, 1, 1);

            let pendingX = null;
            let pendingY = null;

            for(let i=1; i<=steps; i++) {
                const t = i / steps, it = 1 - t;
                const a = it*it*it, b = 3*it*it*t, cCoeff = 3*it*t*t, d = t*t*t;
                const x = a*p0.x + b*p1.x + cCoeff*p2.x + d*p3.x;
                const y = a*p0.y + b*p1.y + cCoeff*p2.y + d*p3.y;
                const currX = Math.floor(x);
                const currY = Math.floor(y);

                // Skip if same as last committed or same as currently pending
                if (currX === lastX && currY === lastY) continue;
                if (pendingX !== null && currX === pendingX && currY === pendingY) continue;

                if (pendingX !== null) {
                    // We have a pending pixel. Let's see if we should commit it or skip it.
                    // Check move from Last -> Pending
                    const d1x = pendingX - lastX;
                    const d1y = pendingY - lastY;
                    // Check move from Pending -> Current
                    const d2x = currX - pendingX;
                    const d2y = currY - pendingY;

                    // Check for Orthogonal moves (Up/Down/Left/Right only)
                    const isD1Ortho = (d1x === 0 && d1y !== 0) || (d1x !== 0 && d1y === 0);
                    const isD2Ortho = (d2x === 0 && d2y !== 0) || (d2x !== 0 && d2y === 0);

                    // Check if direction changed (e.g., Horizontal then Vertical)
                    const isTurn = (d1x !== 0 && d2y !== 0) || (d1y !== 0 && d2x !== 0);

                    if (isD1Ortho && isD2Ortho && isTurn) {
                        // SHOULDER DETECTED (L-shape).
                        // Skip the 'pending' pixel. It was just a bridge.
                        // The diagonal connection (Last -> Curr) looks better.
                        pendingX = currX;
                        pendingY = currY;
                    } else {
                        // No shoulder. Commit the pending pixel.
                        this.fillRectTiled(ctx, pendingX, pendingY, 1, 1);
                        lastX = pendingX;
                        lastY = pendingY;
                        pendingX = currX;
                        pendingY = currY;
                    }
                } else {
                    // First new pixel found
                    pendingX = currX;
                    pendingY = currY;
                }
            }

            // Draw any remaining pending pixel
            if (pendingX !== null) {
                this.fillRectTiled(ctx, pendingX, pendingY, 1, 1);
            }
        }

        async setMode(mode) {
            if(this.state.selection) this.commitSelection();
            if(this.state.activeShape) this.commitActiveShape();

            if (mode === 'full') {
                this.bitDepth = 24;
                this.palette = [];
                this.paletteLab = null;
                this.paletteLocked = false;
            } else if (mode === 'rgb565') {
                this.bitDepth = 16;
                this.paletteLocked = false;
            } else if (mode === 'rgb555') {
                this.bitDepth = 15;
                this.paletteLocked = false;
            } else if (mode === '256') {
                this.bitDepth = 8;
                this.paletteLocked = false;
            } else if (mode === '16') {
                this.bitDepth = 4; // 16 colors (4bpp)
                this.paletteLocked = false;
            } else if (mode === '2') {
                this.bitDepth = 1; // 2 colors (1bpp)
                this.paletteLocked = false;
            }
            await this.applyCurrentModeToCanvasAsync(this.ctx, this.config.width, this.config.height, true);
            this.updateModeButtons();
            this.saveState();
        }
        updateModeButtons() {
            let mode = 'full';
            if (this.bitDepth === 16) mode = 'rgb565';
            else if (this.bitDepth === 15) mode = 'rgb555';
            else if (this.bitDepth === 8) mode = '256';
            else if (this.bitDepth === 4) mode = '16';
            else if (this.bitDepth === 1) mode = '2';
            document.querySelectorAll('#btn-grid-modes .btn-small').forEach(b => {
                b.classList.toggle('active', b.dataset.mode === mode);
            });
        }

        applyColorSpace(type) {
            const targetCtx = this.state.selection ? this.state.selection.canvas.getContext('2d') : this.ctx;
            const w = this.state.selection ? this.state.selection.w : this.config.width;
            const h = this.state.selection ? this.state.selection.h : this.config.height;
            const imgData = targetCtx.getImageData(0, 0, w, h);
            const d = imgData.data;
            for(let i = 0; i < d.length; i += 4) {
                let r = d[i], g = d[i+1], b = d[i+2];
                if(type === 'cmyk') {
                    let c = 1 - (r / 255), m = 1 - (g / 255), y = 1 - (b / 255), k = Math.min(c, m, y);
                    r = 255 * (1 - c) * (1 - k); g = 255 * (1 - m) * (1 - k); b = 255 * (1 - y) * (1 - k);
                } else if(type === 'adobe') {
                    r = r * 0.57 + g * 0.2 + b * 0.23; g = r * 0.1 + g * 0.9; b = b * 0.95;
                } else if(type === 'p3') {
                    r = r * 1.05; g = g * 1.05; b = b * 1.05;
                } else if(type === 'rec2020') {
                    r = (r - 128) * 1.2 + 128; g = (g - 128) * 1.2 + 128; b = (b - 128) * 1.2 + 128;
                } else if(type === 'aces') {
                    r = Math.pow(r / 255, 2.2) * 255; g = Math.pow(g / 255, 2.2) * 255; b = Math.pow(b / 255, 2.2) * 255;
                } else if(type === 'lab') {
                    let avg = (r+g+b)/3; r = avg * 0.5 + r * 0.5; g = avg * 0.5 + g * 0.5; b = avg * 0.5 + b * 0.5;
                } else if(type === 'grayscale' || type === '1bit') {
                    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
                    r = g = b = (type === '1bit') ? (gray > 127 ? 255 : 0) : gray;
                }

                d[i] = Math.min(255, Math.max(0, r)); d[i+1] = Math.min(255, Math.max(0, g)); d[i+2] = Math.min(255, Math.max(0, b));
            }
            targetCtx.putImageData(imgData, 0, 0);
            if(this.state.selection) this.renderSelection(); else this.saveState();
        }

        updateDepthUI() {
            const isHigh = false;
            const isBest = false;
            document.getElementById('chk-dither').disabled = isHigh;
            document.getElementById('chk-quality').disabled = true;
            document.getElementById('lblDither').classList.toggle('disabled', isHigh);
            document.getElementById('lblQuality').classList.add('disabled');
            const adv = document.getElementById('advControls');
            if (adv) {
                if(!isBest || isHigh) adv.classList.add('disabled');
                else adv.classList.remove('disabled');
            }
            document.getElementById('darkSlider').disabled = true;
            document.getElementById('rngSeed').disabled = true;
            const reuseBtn = document.getElementById('depth-reuse-seed');
            if (reuseBtn) reuseBtn.disabled = true;
        }

        reuseSeed() {
            const last = document.getElementById('lastSeed').value;
            if(last) document.getElementById('rngSeed').value = last;
        }

        srgbToLinear(c) { const v = c/255; return v<=0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }

        linearToSrgb(v) { const c = v<=0.0031308 ? 12.92*v : 1.055*Math.pow(v, 1/2.4)-0.055; return Math.max(0,Math.min(255,Math.round(c*255))); }
        rgbToOklab(r,g,b){
            let lr=this.srgbToLinear(r), lg=this.srgbToLinear(g), lb=this.srgbToLinear(b);
            let l=0.4122214708*lr+0.5363325363*lg+0.0514459929*lb;
            let m=0.2119034982*lr+0.6806995451*lg+0.1073969566*lb;
            let s=0.0883024619*lr+0.2817188376*lg+0.6299787005*lb;
            l=Math.cbrt(l); m=Math.cbrt(m); s=Math.cbrt(s);

            return { L:0.2104542553*l+0.7936177850*m-0.0040720468*s, a:1.9779984951*l-2.4285922050*m+0.4505937099*s, b:0.0259040371*l+0.7827717662*m-0.8086757660*s };
        }
        oklabToRgb(L,a,b){
            let l=L+0.3963377774*a+0.2158037573*b;
            let m=L-0.1055613458*a-0.0638541728*b;
            let s=L-0.0894841775*a-1.2914855480*b;
            l=l*l*l; m=m*m*m; s=s*s*s;
            return [
                this.linearToSrgb(4.0767416621*l-3.3077115913*m+0.2309699292*s),
                this.linearToSrgb(-1.2684380046*l+2.6097574011*m-0.3413193965*s),
                this.linearToSrgb(-0.0041960863*l-0.7034186147*m+1.7076147010*s)
            ];
        }
        distOklab(c1,c2) { return (c1.L-c2.L)**2 + (c1.a-c2.a)**2 + (c1.b-c2.b)**2; }
        distRgb(c1,c2) { return (c1.r-c2.r)**2 + (c1.g-c2.g)**2 + (c1.b-c2.b)**2; }
        rgbToHex(r, g, b) {
            const toHex = (v) => v.toString(16).padStart(2, '0');
            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }
        getDepthConfig() {
            if (this.bitDepth === 15) return { mode: 'rgb555' };
            if (this.bitDepth === 16) return { mode: 'rgb565' };
            if (this.bitDepth >= 24) return { mode: 'full' };
            const colors = 1 << this.bitDepth;
            return { mode: 'indexed', colors };
        }
        mapRgbToIndexed(r, g, b, limit) {
            if (!this.palette) this.palette = [];
            if (!this.paletteLocked && this.palette.length < limit && !this.paletteHasColor(r, g, b)) {
                this.addPaletteColor(r, g, b);
                return { r, g, b };
            }
            this.ensurePaletteLab();
            const pLab = this.rgbToOklab(r, g, b);
            let bestIdx = 0;
            let bestDist = Infinity;
            for (let i = 0; i < this.paletteLab.length; i++) {
                const dist = this.distOklab(pLab, this.paletteLab[i]);
                if (dist < bestDist) { bestDist = dist; bestIdx = i; }
            }
            const c = this.palette[bestIdx] || { r, g, b };
            return { r: c.r, g: c.g, b: c.b };
        }
        mapRgbToMode(r, g, b) {
            const cfg = this.getDepthConfig();
            if (cfg.mode === 'full') return { r, g, b };
            if (cfg.mode === 'rgb555') return this.quantizeRgb555(r, g, b);
            if (cfg.mode === 'rgb565') return this.quantizeRgb565(r, g, b);
            return this.mapRgbToIndexed(r, g, b, cfg.colors);
        }
        mapHexToMode(hex) {
            const rgb = this.hexToRgb(hex);
            const out = this.mapRgbToMode(rgb.r, rgb.g, rgb.b);
            return this.rgbToHex(out.r, out.g, out.b);
        }
        getActiveDrawColor(isRight = false) {
            const base = isRight ? this.config.c2 : this.config.c1;
            return this.mapHexToMode(base);
        }
        initTransformGL() {
            if (this.transformGL) return this.transformGL;
            const canvas = document.createElement('canvas');
            const gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
            if (!gl) return null;
            const vsSrc = `
attribute vec2 aPos;
attribute vec2 aTex;
varying vec2 vTex;
void main() {
    vTex = aTex;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`;
            const fsSrc = `
precision mediump float;
varying vec2 vTex;
uniform sampler2D uImage;
void main() {
    gl_FragColor = texture2D(uImage, vTex);
}
`;
            const compile = (type, src) => {
                const sh = gl.createShader(type);
                gl.shaderSource(sh, src);
                gl.compileShader(sh);
                if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
                return sh;
            };
            const vs = compile(gl.VERTEX_SHADER, vsSrc);
            const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
            if (!vs || !fs) return null;
            const prog = gl.createProgram();
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
            const posBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                -1, -1, 1, -1, -1, 1, 1, 1
            ]), gl.STATIC_DRAW);
            const texBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                0, 0, 1, 0, 0, 1, 1, 1
            ]), gl.DYNAMIC_DRAW);
            const tex = gl.createTexture();
            this.transformGL = {
                canvas, gl, prog, tex, posBuf, texBuf,
                aPos: gl.getAttribLocation(prog, 'aPos'),
                aTex: gl.getAttribLocation(prog, 'aTex'),
                // Pre-allocated 8-float buffer for the tex-coord upload on every transform call.
                texCoordBuf: new Float32Array(8),
            };
            canvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                this.transformGL = null;
                if (this._transformOutCanvas) { this._transformOutCanvas.width = 0; this._transformOutCanvas.height = 0; this._transformOutCanvas = null; }
            }, { once: true });
            return this.transformGL;
        }
        applyWebGLTransform(srcCanvas, outW, outH, texCoords) {
            const t = this.initTransformGL();
            if (!t) return null;
            const { canvas, gl, prog, tex, posBuf, texBuf, texCoordBuf } = t;
            canvas.width = outW;
            canvas.height = outH;
            gl.viewport(0, 0, outW, outH);
            gl.useProgram(prog);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcCanvas);
            gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
            gl.enableVertexAttribArray(t.aPos);
            gl.vertexAttribPointer(t.aPos, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, texBuf);
            // Write into the pre-allocated buffer rather than wrapping texCoords in a new Float32Array.
            for (let _i = 0; _i < 8; _i++) texCoordBuf[_i] = texCoords[_i];
            gl.bufferData(gl.ARRAY_BUFFER, texCoordBuf, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(t.aTex);
            gl.vertexAttribPointer(t.aTex, 2, gl.FLOAT, false, 0, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            // Re-use a single persistent output canvas rather than allocating a new
            // one on every call (which would create a detached backing store each time).
            if (!this._transformOutCanvas) {
                this._transformOutCanvas = document.createElement('canvas');
            }
            const out = this._transformOutCanvas;
            out.width = outW;
            out.height = outH;
            out.getContext('2d').drawImage(canvas, 0, 0);
            return out;
        }

        applyCurrentModeToCanvas(targetCtx, w, h, regenPalette = false) {
            const cfg = this.getDepthConfig();
            if (cfg.mode === 'full') return;
            const imgData = targetCtx.getImageData(0, 0, w, h);
            const d = imgData.data;
            if (cfg.mode === 'rgb555' || cfg.mode === 'rgb565') {
                for (let i = 0; i < d.length; i += 4) {
                    const r = d[i], g = d[i + 1], b = d[i + 2];
                    const q = cfg.mode === 'rgb555' ? this.quantizeRgb555(r, g, b) : this.quantizeRgb565(r, g, b);
                    d[i] = q.r; d[i + 1] = q.g; d[i + 2] = q.b;
                }
                targetCtx.putImageData(imgData, 0, 0);
                return;
            }
            if (regenPalette || !this.palette || this.palette.length === 0) {
                this.palette = this.buildWuPalette(imgData, w, h, cfg.colors);
                this.paletteLab = null;
            }
            const paletteLookup = this.buildPaletteLookup(this.palette);
            for (let i = 0; i < d.length; i += 4) {
                const r = d[i], g = d[i + 1], b = d[i + 2];
                const out = this.quantizeRgbWithLookup(r, g, b, paletteLookup);
                d[i] = out.r; d[i + 1] = out.g; d[i + 2] = out.b;
            }
            targetCtx.putImageData(imgData, 0, 0);
        }
        async applyCurrentModeToCanvasAsync(targetCtx, w, h, regenPalette = false) {
            this.applyCurrentModeToCanvas(targetCtx, w, h, regenPalette);
        }

        swapColors() {
            const temp = this.config.c1;
            this.config.c1 = this.config.c2;
            this.config.c2 = temp;
            document.getElementById('c1-disp').style.backgroundColor = this.config.c1;
            document.getElementById('c2-disp').style.backgroundColor = this.config.c2;
            const _swapStops = this.config.gradient.stops;
            if (_swapStops && _swapStops.length >= 2) {
                _swapStops[0].color = this.config.c1;
                _swapStops[_swapStops.length - 1].color = this.config.c2;
            }
            if (this.config.tool === 'gradient' && (this.config.gradient.active || this.config.gradient.isPlacing)) {
                const _g = this.config.gradient;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                _gradientRender(this.ctxTemp, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                this._clipGradientToSelection();
                this._gradientDrawVectorSVG();
            }
            if (this._renderGradBar) this._renderGradBar();
        }

        replaceColorAt(x, y) {
            const width = this.config.eraserWidth;
            const s = Math.ceil(width);
            const half = Math.floor(s/2);
            const startX = Math.floor(x - half);
            const startY = Math.floor(y - half);
            const img = this.ctx.getImageData(startX, startY, s, s);

            const t = this.hexToRgb(this.mapHexToMode(this.config.c1));
            const r = this.hexToRgb(this.mapHexToMode(this.config.c2));

            for(let i=0; i<img.data.length; i+=4) {
                if(img.data[i]===t.r && img.data[i+1]===t.g && img.data[i+2]===t.b) {
                    img.data[i]=r.r;
                    img.data[i+1]=r.g;
                    img.data[i+2]=r.b;
                }
            }
            this.ctx.putImageData(img, startX, startY);
        }
        replaceColorLine(x0,y0,x1,y1) {
            const width = this.config.eraserWidth;
            const s = Math.ceil(width);
            const half = Math.floor(s/2);
            let minX = Math.floor(Math.min(x0, x1) - half);
            let minY = Math.floor(Math.min(y0, y1) - half);
            let maxX = Math.floor(Math.max(x0, x1) + half + s);
            let maxY = Math.floor(Math.max(y0, y1) + half + s);
            minX = Math.max(0, minX); minY = Math.max(0, minY);
            maxX = Math.min(this.config.width, maxX); maxY = Math.min(this.config.height, maxY);
            const w = maxX - minX, h = maxY - minY;
            if(w<=0 || h<=0) return;

            const img = this.ctx.getImageData(minX, minY, w, h);
            const d = img.data;
            const tr = this.hexToRgb(this.mapHexToMode(this.config.c1)), rr = this.hexToRgb(this.mapHexToMode(this.config.c2));
            if(tr.r===rr.r && tr.g===rr.g && tr.b===rr.b) return;

            const dx=x1-x0, dy=y1-y0, steps=Math.ceil(Math.sqrt(dx*dx+dy*dy));
            const xInc=dx/steps, yInc=dy/steps;
            let cx=x0, cy=y0;

            for(let i=0; i<=steps; i++) {
                const sx = Math.floor(cx - half) - minX, sy = Math.floor(cy - half) - minY;
                for(let ry=0; ry<s; ry++) {
                    const yLoc = sy + ry;
                    if(yLoc < 0 || yLoc >= h) continue;
                    let idx = (yLoc * w + sx) * 4;
                    for(let rx=0; rx<s; rx++) {
                        const xLoc = sx + rx;
                        if(xLoc >= 0 && xLoc < w) {
                            if(d[idx]===tr.r && d[idx+1]===tr.g && d[idx+2]===tr.b) {
                                d[idx]=rr.r; d[idx+1]=rr.g; d[idx+2]=rr.b;
                            }
                        }
                        idx += 4;
                    }
                }
                cx+=xInc; cy+=yInc;
            }
            this.ctx.putImageData(img, minX, minY);
        }
        hexToRgb(h) {
            // 16-slot map cache — handles rapid alternation between multiple colors
            // (e.g. foreground + eraser) without repeated parseInt parsing.
            if (!this._hexRgbCache) this._hexRgbCache = new Map();
            const cached = this._hexRgbCache.get(h);
            if (cached) return cached;
            const r = parseInt(h.slice(1,3), 16);
            const g = parseInt(h.slice(3,5), 16);
            const b = parseInt(h.slice(5,7), 16);
            const rgb = { r, g, b };
            if (this._hexRgbCache.size >= 16) {
                this._hexRgbCache.delete(this._hexRgbCache.keys().next().value);
            }
            this._hexRgbCache.set(h, rgb);
            return rgb;
        }
        pickColor(x,y,slot) {
            const p = this.ctx.getImageData(x,y,1,1).data;
            const hex = "#" + ((1 << 24) + (p[0] << 16) + (p[1] << 8) + p[2]).toString(16).slice(1);
            this.setColor(hex, slot);
        }
        applyStageTransform() {
            var off = this.state.canvasOffset || { x: 0, y: 0 };
            this.ui.stage.style.transform = 'translate(' + off.x + 'px, ' + off.y + 'px) scale(' + this.config.zoom + ')';
        }
        _followCanvasWhileShifting() {
            // The transition is 240ms; the margin covers the frame it starts on
            // and leaves the handles settled on the final position.
            this._canvasFollowUntil = performance.now() + 400;
            if (this._canvasFollowRaf) return;
            const step = () => {
                this.updateBounds();
                this.updateGlobalOverlays();
                if (performance.now() >= this._canvasFollowUntil) {
                    this._canvasFollowRaf = null;
                    return;
                }
                this._canvasFollowRaf = requestAnimationFrame(step);
            };
            this._canvasFollowRaf = requestAnimationFrame(step);
        }
        clampCanvasOffset(off) {
            if (!this.config.anchorCanvas || !this.ui.viewport) return off;
            const zoom = this.config.zoom || 1;
            const stageW = this.config.width * zoom;
            const stageH = this.config.height * zoom;
            const vpW = this.ui.viewport.clientWidth;
            const vpH = this.ui.viewport.clientHeight;
            const minX = Math.min(0, vpW - stageW);
            const topPad = this.getToolbarHeight();
            const minY = Math.min(0, vpH - stageH) - topPad;
            return { x: Math.max(off.x, minX), y: Math.max(off.y, minY) };
        }
        rectsIntersect(a, b) {
            return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
        }
        ensureCanvasVisible(vpRect) {
            if (!this.ui.stage || this.config.anchorCanvas) return;
            const rect = this.ui.stage.getBoundingClientRect();
            const pad = 20;
            let dx = 0;
            let dy = 0;
            if (rect.right < vpRect.left + pad) dx = (vpRect.left + pad) - rect.right;
            else if (rect.left > vpRect.right - pad) dx = (vpRect.right - pad) - rect.left;
            if (rect.bottom < vpRect.top + pad) dy = (vpRect.top + pad) - rect.bottom;
            else if (rect.top > vpRect.bottom - pad) dy = (vpRect.bottom - pad) - rect.top;
            if (dx || dy) {
                this.state.canvasOffset = {
                    x: (this.state.canvasOffset?.x || 0) + dx,
                    y: (this.state.canvasOffset?.y || 0) + dy
                };
                this.applyStageTransform();
            }
        }
        toggleAnchorCanvas(isAnchored) {
            const next = isAnchored === undefined ? !this.config.anchorCanvas : !!isAnchored;
            const vp = this.ui.viewport;
            if (vp) vp.classList.add('no-pad-transition');
            this.config.anchorCanvas = next;
            this.lsSet('paint.anchorCanvas', this.config.anchorCanvas ? 'true' : 'false');
            // Free mode removes fixed padding so the stage can move within the viewport.
            if (vp) {
                vp.classList.toggle('free-canvas', !this.config.anchorCanvas);
            }
            if (this.config.anchorCanvas) {
                this.state.savedFreeOffset = { x: this.state.canvasOffset.x, y: this.state.canvasOffset.y };
                this.state.canvasOffset = { x: 0, y: 0 };
            } else {
                if (this.state.savedFreeOffset) {
                    this.state.canvasOffset = { x: this.state.savedFreeOffset.x, y: this.state.savedFreeOffset.y };
                }
            }
            this._updateSidebarViewportShift();
            this.applyStageTransform();
            this.updateBounds();
            this.requestGlobalOverlayUpdate();
            this.updateGridOverlay();
            this.updateAnchorStatus();
            if (vp) vp.classList.remove('no-pad-transition');
            /* Auto-center when entering free canvas mode */
            if (!this.config.anchorCanvas) {
                requestAnimationFrame(() => this.centerCanvas());
            }
        }
        updateAnchorStatus() {
            const btn = document.getElementById('anchor-toggle-btn');
            const label = document.getElementById('anchor-toggle-status');
            if (btn) btn.classList.toggle('is-on', this.config.anchorCanvas);
            const toolBtn = document.getElementById('anchor-rotate-toggle-btn');
            if (toolBtn) toolBtn.classList.toggle('is-on', this.config.anchorCanvas);
            if (label) label.textContent = this.config.anchorCanvas ? 'Anchored' : 'Free';
            document.querySelectorAll('.tool-grid-slot[data-tool-id="anchor-toggle"]').forEach(slot => {
                slot.classList.toggle('is-on', this.config.anchorCanvas);
            });
        }
        centerCanvas() {
            if (!this.ui.viewport || !this.ui.stage) return;
            const zoom = this.config.zoom || 1;
            const vp = this.ui.viewport;
            const vpW = vp.clientWidth;
            const vpH = vp.clientHeight;
            const stageW = this.config.width * zoom;
            const stageH = this.config.height * zoom;
            const centerX = Math.max(0, Math.round((stageW - vpW) / 2));
            const centerY = Math.max(0, Math.round((stageH - vpH) / 2));
            vp.scrollLeft = centerX;
            vp.scrollTop = centerY;
            /* In free mode, also translate the stage so it appears centered. */
            if (!this.config.anchorCanvas) {
                this.state.canvasOffset = {
                    x: Math.round((vpW - stageW) / 2),
                    y: Math.round((vpH - stageH) / 2)
                };
                this.applyStageTransform();
                this.updateBounds();
            }
            this.requestGlobalOverlayUpdate();
        }
        setTool(t) {
            // Don't commit selection when entering/exiting gradient — it clips the gradient
            if(this.state.selection && t !== 'gradient' && this.config.tool !== 'gradient' && (t!=='select' || this.config.tool==='select')) this.commitSelection();
            if(this.state.activeShape && t!==this.state.activeShape.type) this.commitActiveShape();
            if(this.state.polyActive && t!=='poly') this.commitPolyline();
            if (this.state.lassoActive && t!=='lasso') {
                this.state.lassoActive = false;
                this.state.lassoPoints = [];
                this.state.lassoIsDown = false;
                this.state.lassoMode = null;
                this.ctxTemp.clearRect(0,0,this.config.width, this.config.height);
                if (this.ui && this.ui.cTemp) this.ui.cTemp.style.mixBlendMode = 'normal';
            }
            if (this.state.wandActive && t!=='wand') {
                this.state.wandActive = false;
                this.state.wandBase = null;
                this.state.wandVisited = null;
                this.state.wandMaskCanvas = null;
                this.state.wandMaskImageData = null;
                this.state.wandDiff = null;
                if (this._wandSelectRaf) { cancelAnimationFrame(this._wandSelectRaf); this._wandSelectRaf = null; }
                this._wandPreviewImageData = null;
                this._wandPreviewBuffer = null;
                this._wandStack = null;
                this._clearWandSvgPreview();
            }
            if (this.state.smartPencilActive && t !== 'pencil') {
                this.finishSmartPencilStroke();
            }
            if (this.state.freehandPathActive && t !== 'path') {
                FreehandPathEngine.cancel();
                this.state.freehandPathActive = false;
            }
            if (this.state.isRotatingShape) {
                this.state.isRotatingShape = false;
                this.state.shapeRotateSession = null;
            }
            // Commit a live gradient when switching away
            if (this.config.tool === 'gradient' && t !== 'gradient') {
                this.state.isDrawing = false;
                if (this.config.gradient.active) this.gradientApply();
                else { this.config.gradient.isPlacing = false; this.config.gradient.draggingHandle = null; this.ctxTemp.clearRect(0,0,this.config.width,this.config.height); this._gradientClearVectorSVG(); }
                // Restore selection handles when leaving gradient tool
                if (this.state.selection) {
                    this.state.selection.noHandles = false;
                    this.renderSelection();
                }
                _cacheClear();
            }
            // Hide selection handles when entering gradient tool (handleless marching ants)
            if (t === 'gradient' && this.state.selection) {
                this.state.selection.noHandles = true;
                this.renderSelection();
            }
            if (this.state.freehandActive && t !== 'freehand') {
                this.state.freehandActive = false;
                if (this._freehandPendingFrame) {
                    cancelAnimationFrame(this._freehandPendingFrame);
                    this._freehandPendingFrame = null;
                }
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                if (this.ui.cTemp) this.ui.cTemp.style.opacity = '1';
                this._freehandInputPoints = [];
                this._freehandStrokePoints = null;
                this._fhPreviewing = false;
            }
            if (this.state.paintbrushActive && t !== 'paintbrush') {
                this.state.paintbrushActive = false;
                if (this.brush && this.brush.endStroke) {
                    this.brush.endStroke();
                }
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
            }
            if (t === 'pencil' || t === 'eraser' || t === 'fill' || this.isShapeTool(t) || t === 'freehand' || t === 'paintbrush') this.state.lastDrawTool = t;
            this.config.tool = t;
            if (t !== 'picker') this.pickerCursorHex = null;
            const _gradPanel = document.getElementById('gradient-options');
            if (_gradPanel) _gradPanel.classList.toggle('section-hidden', t !== 'gradient');
            const _wandSection = document.getElementById('wand-threshold-section');
            if (_wandSection) _wandSection.classList.toggle('section-hidden', t !== 'wand');
            const _freehandSidebar = document.getElementById('freehand-sidebar');
            if (_freehandSidebar) {
                _freehandSidebar.classList.toggle('open', t === 'freehand');
            }
            const _freehandReopen = document.getElementById('freehand-reopen-btn');
            if (_freehandReopen) _freehandReopen.classList.remove('show');
            const _pbSidebar = document.getElementById('paintbrush-sidebar');
            if (_pbSidebar) {
                _pbSidebar.classList.toggle('open', t === 'paintbrush');
            }
            const _pbReopen = document.getElementById('pb-reopen-btn');
            if (_pbReopen) _pbReopen.classList.remove('show');
            const _gradSidebar = document.getElementById('gradient-sidebar');
            if (_gradSidebar) {
                _gradSidebar.classList.toggle('open', t === 'gradient');
            }
            const _gradReopen = document.getElementById('gradient-reopen-btn');
            if (_gradReopen) _gradReopen.classList.remove('show');
            if (_gradSidebar && t === 'gradient' && this._renderGradBar) {
                this._renderGradBar();
            }
            this._updateSidebarViewportShift(true);
            document.querySelectorAll('.btn, .btn-icon, .split-btn-container').forEach(b=>b.classList.remove('active'));
            const b = document.querySelector(`[data-tool="${t}"]`);
            if(b) b.classList.add('active');
            if (t === 'lasso') {
                const selectBtn = document.querySelector('[data-tool="select"]');
                if (selectBtn) selectBtn.classList.add('active');
            }
            this.syncToolGridActive();
            this.state.curvePhase = 0;
            this.ui.sizeInput.value = this.getToolWidth(t);
            this.syncLineWidthMenu();
            this.updateCursorForTool(t);
            if (t === 'eraser') {
                this.refreshEraserGhost();
            } else {
                this.ui.stage.classList.remove('eraser-active');
                this.ui.eraserGhost.style.display = 'none';
            }
            const rectIcon = document.getElementById('select-icon-rect');
            const freeIcon = document.getElementById('select-icon-free');
            const polyIcon = document.getElementById('select-icon-poly');
            const useLasso = this.config.selectTool === 'lasso';
            const usePoly = useLasso && this.config.lassoSelectMode === 'poly';
            const useFree = useLasso && !usePoly;
            if (rectIcon) rectIcon.classList.toggle('show', !useLasso);
            if (freeIcon) freeIcon.classList.toggle('show', useFree);
            if (polyIcon) polyIcon.classList.toggle('show', usePoly);
            const selectSplit = document.querySelector('.split-btn-container.select-split');
            const selectDrop = selectSplit ? selectSplit.querySelector('.split-btn-bottom.select-dropdown') : null;
            const selectActive = t === 'select' || t === 'lasso';
            if (selectSplit) selectSplit.classList.toggle('selection-highlight', selectActive);
            if (selectDrop) selectDrop.classList.toggle('selection-highlight', selectActive);
            this.strokeQueue = [];
            if (this.strokeRaf) {
                cancelAnimationFrame(this.strokeRaf);
                this.strokeRaf = null;
            }
        }
        triggerColorPicker() {
            const cfg = this.getDepthConfig();
            if (cfg.mode === 'full' || cfg.mode === 'rgb565' || cfg.mode === 'rgb555') {
                this.openWinColor();
                return;
            }
            this.openQuantColorPicker();
        }
        openWinColor() {
            const cfg = this.getDepthConfig();
            this.winColorQuantMode = (cfg.mode === 'rgb565' || cfg.mode === 'rgb555') ? cfg.mode : null;
            const modal = document.getElementById('modal-wincolor');
            this.ui.winWindow.classList.add('expanded');
            const btn = document.getElementById('wincolor-define-btn');
            if (btn) btn.disabled = true;
            this.winColorCustom = Array(16).fill('#ffffff');
            this.winColorCustomCursor = 0;
            this.winColorCustomIndex = 0;
            this.renderWinColorGrids();
            const hex = this.config.activeSlot === 1 ? this.config.c1 : this.config.c2;
            const rgb = this.hexToRgb(hex);
            const q = this.quantizeWinColorRgb(rgb.r, rgb.g, rgb.b);
            this.winColorSelected = this.rgbToHex(q.r, q.g, q.b);
            const hsl = this.rgbToWinHsl(q.r, q.g, q.b);
            this.setWinInputs(q, hsl);
            this.renderWinSpectrum(120);
            this.renderWinLum(hsl.H, hsl.S);
            this.positionWinMarkers(hsl.H, hsl.S, hsl.L);
            if (this.ui.winSample) this.ui.winSample.style.backgroundColor = this.winColorSelected;
            this._livePreviewSwatch();
            this.updateWinBppUI();
            modal.style.display = 'flex';
            this.centerWinColor();
        }
        closeWinColor() {
            if (this._paletteSwatchEditTarget) {
                // Restore the swatch to the color it had before editing (undo live preview)
                const orig = this._paletteSwatchEditTarget.dataset.fixedPaletteColor;
                if (orig) this._paletteSwatchEditTarget.style.backgroundColor = orig;
                this.enforceFixedPaletteSwatchStyles();
            } else {
                // Restore ribbon and sidebar swatches to their pre-edit colors
                const slot = this.config.activeSlot;
                const origHex = slot === 1 ? this.config.c1 : this.config.c2;
                const el = document.getElementById('c' + slot + '-disp');
                if (el) el.style.backgroundColor = origHex;
                const swatchId = slot === 1 ? 'fh-fill-swatch' : 'fh-stroke-swatch';
                const swatch = document.getElementById(swatchId);
                if (swatch) swatch.style.backgroundColor = origHex;
            }
            if (this._gradStopEditTarget != null) {
                const idx = this._gradStopEditTarget;
                const bak = this._gradStopEditBackup;
                this._gradStopEditTarget = null;
                this._gradStopEditBackup = null;
                if (bak && this.config.gradient.stops && this.config.gradient.stops[idx]) {
                    this.config.gradient.stops[idx].color = bak;
                    if (this._renderGradBar) this._renderGradBar();
                }
            }
            this._paletteSwatchEditTarget = null;
            document.getElementById('modal-wincolor').style.display = 'none';
            this.gridlinesPickActive = false;
            this.colorPickTarget = null;
        }
        centerWinColor() {
            const modal = document.getElementById('modal-wincolor');
            const win = this.ui.winWindow;
            if (!modal || !win) return;
            const rect = win.getBoundingClientRect();
            const w = rect.width || win.offsetWidth;
            const h = rect.height || win.offsetHeight;
            win.style.left = ((window.innerWidth - w) / 2) + 'px';
            win.style.top = ((window.innerHeight - h) / 2) + 'px';
        }
        startWinColorDrag(e) {
            if (e.button !== 0) return;
            const win = this.ui.winWindow;
            if (!win) return;
            const rect = win.getBoundingClientRect();
            this.winColorDrag = {
                offsetX: e.clientX - rect.left,
                offsetY: e.clientY - rect.top
            };
            e.preventDefault();
        }
        moveWinColorDrag(e) {
            if (!this.winColorDrag) return;
            const win = this.ui.winWindow;
            if (!win) return;
            const x = e.clientX - this.winColorDrag.offsetX;
            const y = e.clientY - this.winColorDrag.offsetY;
            this.setClampedWindowPosition(win, x, y);
        }
        endWinColorDrag() {
            this.winColorDrag = null;
        }
        setClampedWindowPosition(win, desiredLeft, desiredTop) {
            if (!win) return;
            const rect = win.getBoundingClientRect();
            const w = rect.width || win.offsetWidth || 0;
            const h = rect.height || win.offsetHeight || 0;
            const title = win.querySelector('.title-bar');
            const titleH = Math.max(24, title ? (title.offsetHeight || 0) : 0);

            const minLeft = Math.min(0, window.innerWidth - w);
            const maxLeft = Math.max(0, window.innerWidth - w);
            const minTop = 0;
            const maxTop = Math.max(0, h > window.innerHeight ? (window.innerHeight - titleH) : (window.innerHeight - h));

            const left = Math.round(Math.min(maxLeft, Math.max(minLeft, desiredLeft)));
            const top = Math.round(Math.min(maxTop, Math.max(minTop, desiredTop)));
            win.style.left = left + 'px';
            win.style.top = top + 'px';
        }
        reclampOpenDraggableWindows() {
            const ids = [
                'modal-hotkeys',
                'modal-resize',
                'modal-depth',
                'modal-export',
                'modal-huesat',
                'save-reminder-modal',
                'close-confirm-modal',
                'modal-info',
                'modal-colors',
                'modal-confirm-reset',
                'modal-toolbar',
                'modal-wincolor'
            ];
            ids.forEach((id) => {
                const modal = document.getElementById(id);
                if (!modal || modal.style.display !== 'flex') return;
                const win = modal.querySelector('.window');
                if (!win) return;
                const rect = win.getBoundingClientRect();
                this.setClampedWindowPosition(win, rect.left, rect.top);
            });
        }
        toggleWinColor() {
            this.ui.winWindow.classList.add('expanded');
            document.getElementById('wincolor-define-btn').disabled = true;
        }
        applyWinColor() {
            if (this._gradStopEditTarget != null) {
                const idx = this._gradStopEditTarget;
                this._gradStopEditTarget = null;
                const chosen = this.winColorSelected;
                if (this.config.gradient.stops && this.config.gradient.stops[idx]) {
                    this.config.gradient.stops[idx].color = chosen;
                    if (this._renderGradBar) this._renderGradBar();
                    if (this._gradRefresh) this._gradRefresh();
                    const _gs = this.config.gradient.stops;
                    if (_gs && _gs.length >= 2) {
                        if (idx === 0) {
                            this.config.c1 = _gs[0].color;
                            const el = document.getElementById('c1-disp');
                            if (el) el.style.backgroundColor = _gs[0].color;
                        }
                        if (idx === _gs.length - 1) {
                            this.config.c2 = _gs[idx].color;
                            const el = document.getElementById('c2-disp');
                            if (el) el.style.backgroundColor = _gs[idx].color;
                        }
                    }
                }
                this.closeWinColor();
                return;
            }
            if (this._paletteSwatchEditTarget) {
                const swatchEl = this._paletteSwatchEditTarget;
                this._paletteSwatchEditTarget = null;
                const chosen = this.winColorSelected;
                swatchEl.dataset.fixedPaletteColor = chosen;
                swatchEl.style.backgroundColor = chosen;
                if (chosen.toLowerCase() === '#000000') swatchEl.dataset.fixedBlack = 'true';
                else delete swatchEl.dataset.fixedBlack;
                this.enforceFixedPaletteSwatchStyles();
                this._savePaletteCustomizations();
                this.closeWinColor();
                return;
            }
            if (this.colorPickTarget) {
                const target = this.colorPickTarget;
                this.colorPickTarget = null;
                const chosen = this.winColorSelected;
                this.commitColorOverride(target.key, chosen, { source: 'picker' });
                this.closeWinColor();
                return;
            }
            if (this.gridlinesPickActive) {
                this.gridlinesPickActive = false;
                this.setGridlineColor(this.winColorSelected);
                this.closeWinColor();
                return;
            }
            this.setColor(this.winColorSelected, this.config.activeSlot);
            this.addRecentColor(this.winColorLastAdded || this.winColorSelected);
            this.closeWinColor();
        }
        addCustomWinColor() {
            const col = Math.floor(this.winColorCustomCursor / 2);
            const row = this.winColorCustomCursor % 2;
            const idx = row * 8 + col;
            this.winColorCustom[idx] = this.winColorSelected;
            this.winColorLastAdded = this.winColorSelected;
            this.winColorCustomCursor = (this.winColorCustomCursor + 1) % this.winColorCustom.length;
            this.renderWinColorGrids();
        }
        renderWinColorGrids() {
            const basic = [
                '#ff8080','#ffff80','#80ff80','#00ff80','#80ffff','#0080ff','#ff80c0','#ff80ff',
                '#ff0000','#ffff00','#80ff00','#00ff00','#00ffff','#0080c0','#8080c0','#ff00ff',
                '#804040','#ff8040','#00ff40','#008080','#004080','#8080ff','#800040','#ff0080',
                '#800000','#ff8000','#008000','#008040','#0000ff','#0000a0','#800080','#8000ff',
                '#400000','#804000','#004000','#004040','#000080','#000040','#400040','#400080',
                '#000000','#808000','#808040','#808080','#408080','#c0c0c0','#400040','#ffffff'
            ];
            this.ui.winBasic.innerHTML = '';
            basic.forEach((c, i) => {
                const d = document.createElement('div');
                d.className = 'swatch' + (this.winColorSelected === c ? ' selected' : '');
                d.style.backgroundColor = c;
                d.onclick = () => { this.winColorSelected = c; this.updateWinFromHex(c); };
                d.ondblclick = () => { this.winColorSelected = c; this.applyWinColor(); };
                this.ui.winBasic.appendChild(d);
            });
            this.ui.winCustom.innerHTML = '';
            this.winColorCustom.forEach((c, i) => {
                const d = document.createElement('div');
                d.className = 'swatch' + (i === this.winColorCustomIndex ? ' selected' : '');
                d.style.backgroundColor = c;
                d.onclick = () => {
                    this.winColorCustomIndex = i;
                    const row = Math.floor(i / 8);
                    const col = i % 8;
                    this.winColorCustomCursor = col * 2 + row;
                    this.winColorSelected = c;
                    this.updateWinFromHex(c);
                    this.renderWinColorGrids();
                };
                d.ondblclick = () => { this.winColorCustomIndex = i; this.winColorSelected = c; this.applyWinColor(); };
                this.ui.winCustom.appendChild(d);
            });
        }
        updateWinFromHex(hex) {
            const rgb = this.hexToRgb(hex);
            const q = this.quantizeWinColorRgb(rgb.r, rgb.g, rgb.b);
            const hsl = this.rgbToWinHsl(q.r, q.g, q.b);
            this.setWinInputs(q, hsl);
            this.winColorSelected = this.rgbToHex(q.r, q.g, q.b);
            this.renderWinSpectrum(120);
            this.renderWinLum(hsl.H, hsl.S);
            this.positionWinMarkers(hsl.H, hsl.S, hsl.L);
            if (this.ui.winSample) this.ui.winSample.style.backgroundColor = this.winColorSelected;
            this.updateWinBppUI();
            this._livePreviewPaletteSwatchEdit();
            this._livePreviewSwatch();
        }
        setWinInputs(rgb, hsl) {
            document.getElementById('win-r').value = Math.round(rgb.r);
            document.getElementById('win-g').value = Math.round(rgb.g);
            document.getElementById('win-b').value = Math.round(rgb.b);
            document.getElementById('win-h').value = Math.round(hsl.H);
            document.getElementById('win-s').value = Math.round(hsl.S);
            document.getElementById('win-l').value = Math.round(hsl.L);
        }
        setWinRgbInputs(rgb) {
            document.getElementById('win-r').value = Math.round(rgb.r);
            document.getElementById('win-g').value = Math.round(rgb.g);
            document.getElementById('win-b').value = Math.round(rgb.b);
        }
        updateWinFromRgb() {
            const r = Math.max(0, Math.min(255, parseInt(document.getElementById('win-r').value, 10) || 0));
            const g = Math.max(0, Math.min(255, parseInt(document.getElementById('win-g').value, 10) || 0));
            const b = Math.max(0, Math.min(255, parseInt(document.getElementById('win-b').value, 10) || 0));
            const q = this.quantizeWinColorRgb(r, g, b);
            const hsl = this.rgbToWinHsl(q.r, q.g, q.b);
            this.winColorSelected = this.rgbToHex(q.r, q.g, q.b);
            this.setWinInputs(q, hsl);
            this.renderWinSpectrum(120);
            this.renderWinLum(hsl.H, hsl.S);
            this.positionWinMarkers(hsl.H, hsl.S, hsl.L);
            if (this.ui.winSample) this.ui.winSample.style.backgroundColor = this.winColorSelected;
            this.updateWinBppUI();
            this._livePreviewPaletteSwatchEdit();
            this._livePreviewSwatch();
        }
        updateWinFromHsl(keepHsl = false) {
            const H = Math.max(0, Math.min(239, parseInt(document.getElementById('win-h').value, 10) || 0));
            const S = Math.max(0, Math.min(240, parseInt(document.getElementById('win-s').value, 10) || 0));
            const L = Math.max(0, Math.min(240, parseInt(document.getElementById('win-l').value, 10) || 0));
            const rgb = this.winHslToRgb(H, S, L);
            const q = this.quantizeWinColorRgb(rgb.r, rgb.g, rgb.b);
            const hsl = this.rgbToWinHsl(q.r, q.g, q.b);
            this.winColorSelected = this.rgbToHex(q.r, q.g, q.b);
            if (keepHsl) {
                this.setWinRgbInputs(q);
            } else {
                this.setWinInputs(q, hsl);
            }
            const useH = keepHsl ? H : hsl.H;
            const useS = keepHsl ? S : hsl.S;
            const useL = keepHsl ? L : hsl.L;
            this.renderWinSpectrum(120);
            this.renderWinLum(useH, useS);
            this.positionWinMarkers(useH, useS, useL);
            if (this.ui.winSample) this.ui.winSample.style.backgroundColor = this.winColorSelected;
            this.updateWinBppUI();
            this._livePreviewPaletteSwatchEdit();
            this._livePreviewSwatch();
        }
        setWinColorTab(tab) {
            const isBpp = !!this.winColorQuantMode;
            if (!isBpp) tab = 'spec';
            this.winColorTab = tab;
            if (this.ui.winTabSpec) this.ui.winTabSpec.classList.toggle('active', tab === 'spec');
            if (this.ui.winTabBpp) this.ui.winTabBpp.classList.toggle('active', tab === 'bpp');
            if (this.ui.winBppPanel) this.ui.winBppPanel.style.display = tab === 'bpp' ? 'block' : 'none';
            const specWrap = document.getElementById('wincolor-spectrum-wrap');
            const lumWrap = this.ui.winLum ? this.ui.winLum.parentElement : null;
            if (specWrap) specWrap.style.display = tab === 'spec' ? 'block' : 'none';
            if (lumWrap) lumWrap.style.display = tab === 'spec' ? 'block' : 'none';
        }
        updateWinBppUI() {
            const isBpp = !!this.winColorQuantMode;
            if (this.ui.winTabBpp) this.ui.winTabBpp.style.display = isBpp ? 'inline-block' : 'none';
            if (!isBpp) {
                this.setWinColorTab('spec');
                return;
            }
            if (!this.winColorTab) this.winColorTab = 'bpp';
            const cfg = this.winColorQuantMode;
            const gMax = cfg === 'rgb565' ? 63 : 31;
            const rgb = this.hexToRgb(this.winColorSelected);
            const rN = Math.round((rgb.r / 255) * 31);
            const gN = Math.round((rgb.g / 255) * gMax);
            const bN = Math.round((rgb.b / 255) * 31);
            const rEl = document.getElementById('win-bpp-r');
            const gEl = document.getElementById('win-bpp-g');
            const bEl = document.getElementById('win-bpp-b');
            const rn = document.getElementById('win-bpp-rn');
            const gn = document.getElementById('win-bpp-gn');
            const bn = document.getElementById('win-bpp-bn');
            if (gEl) gEl.max = gMax;
            if (gn) gn.max = gMax;
            if (rEl) rEl.value = rN;
            if (gEl) gEl.value = gN;
            if (bEl) bEl.value = bN;
            if (rn) rn.value = rN;
            if (gn) gn.value = gN;
            if (bn) bn.value = bN;
            if (this.ui.winBppPreview) this.ui.winBppPreview.style.backgroundColor = this.winColorSelected;
            this.setWinColorTab(this.winColorTab);
        }
        updateWinFromBpp(fromNumber = false) {
            if (!this.winColorQuantMode) return;
            const gMax = this.winColorQuantMode === 'rgb565' ? 63 : 31;
            const rEl = document.getElementById('win-bpp-r');
            const gEl = document.getElementById('win-bpp-g');
            const bEl = document.getElementById('win-bpp-b');
            const rn = document.getElementById('win-bpp-rn');
            const gn = document.getElementById('win-bpp-gn');
            const bn = document.getElementById('win-bpp-bn');
            if (fromNumber) {
                rEl.value = rn.value;
                gEl.value = gn.value;
                bEl.value = bn.value;
            } else {
                rn.value = rEl.value;
                gn.value = gEl.value;
                bn.value = bEl.value;
            }
            const rN = parseInt(rEl.value, 10);
            const gN = parseInt(gEl.value, 10);
            const bN = parseInt(bEl.value, 10);
            const r = Math.round((rN / 31) * 255);
            const g = Math.round((gN / gMax) * 255);
            const b = Math.round((bN / 31) * 255);
            this.winColorSelected = this.rgbToHex(r, g, b);
            const hsl = this.rgbToWinHsl(r, g, b);
            this.setWinInputs({ r, g, b }, hsl);
            this.renderWinSpectrum(120);
            this.renderWinLum(hsl.H, hsl.S);
            this.positionWinMarkers(hsl.H, hsl.S, hsl.L);
            if (this.ui.winSample) this.ui.winSample.style.backgroundColor = this.winColorSelected;
            if (this.ui.winBppPreview) this.ui.winBppPreview.style.backgroundColor = this.winColorSelected;
            this._livePreviewPaletteSwatchEdit();
            this._livePreviewSwatch();
        }
        handleWinSpectrum(e) {
            const rect = this.ui.winSpectrum.getBoundingClientRect();
            const w = this.ui.winSpectrum.width;
            const h = this.ui.winSpectrum.height;
            const x = Math.max(0, Math.min(w - 1, Math.floor(e.clientX - rect.left)));
            const y = Math.max(0, Math.min(h - 1, Math.floor(e.clientY - rect.top)));
            this.winColorDragging = 'spec';
            const H = Math.round((x / (w - 1)) * 239);
            const S = Math.round((1 - (y / (h - 1))) * 240);
            document.getElementById('win-h').value = H;
            document.getElementById('win-s').value = S;
            this.updateWinFromHsl(true);
        }
        handleWinLum(e) {
            const rect = this.ui.winLum.getBoundingClientRect();
            const h = this.ui.winLum.height;
            const y = Math.max(0, Math.min(h - 1, Math.floor(e.clientY - rect.top)));
            this.winColorDragging = 'lum';
            const L = Math.round((1 - (y / (h - 1))) * 240);
            document.getElementById('win-l').value = L;
            this.updateWinFromHsl(true);
        }
        positionWinMarkers(H, S, L) {
            const w = this.ui.winSpectrum.width;
            const h = this.ui.winSpectrum.height;
            const x = Math.round((H / 239) * (w - 1));
            const y = Math.round((1 - (S / 240)) * (h - 1));
            this.ui.winCross.style.left = (x - 9) + 'px';
            this.ui.winCross.style.top = (y - 9) + 'px';
            const ly = Math.round((1 - (L / 240)) * (this.ui.winLum.height - 1));
            this.ui.winLumArrow.style.top = ly + 'px';
        }
        renderWinSpectrum(L) {
            const ctx = this.ui.winSpectrum.getContext('2d');
            const w = this.ui.winSpectrum.width;
            const h = this.ui.winSpectrum.height;
            const img = ctx.createImageData(w, h);
            const d = img.data;
            const hSteps = 60;
            const sSteps = 30;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const H = Math.round((x / (w - 1)) * 239);
                    const S = Math.round((1 - (y / (h - 1))) * 240);
                    const rgb = this.winHslToRgb(H, S, L);
                    const idx = (y * w + x) * 4;
                    d[idx] = rgb.r; d[idx+1] = rgb.g; d[idx+2] = rgb.b; d[idx+3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);

            if (!this._winCrushCanvas) {
                this._winCrushCanvas = document.createElement('canvas');
            }
            const crush = this._winCrushCanvas;
            if (crush.width !== hSteps || crush.height !== sSteps) {
                crush.width = hSteps;
                crush.height = sSteps;
            }
            const cctx = crush.getContext('2d');
            const cimg = cctx.createImageData(hSteps, sSteps);
            const cd = cimg.data;
            for (let y = 0; y < sSteps; y++) {
                const S = Math.round((1 - (y / (sSteps - 1))) * 240);
                for (let x = 0; x < hSteps; x++) {
                    const H = Math.round((x / (hSteps - 1)) * 239);
                    const rgb = this.winHslToRgb(H, S, L);
                    const idx = (y * hSteps + x) * 4;
                    cd[idx] = rgb.r; cd[idx+1] = rgb.g; cd[idx+2] = rgb.b; cd[idx+3] = 255;
                }
            }
            cctx.putImageData(cimg, 0, 0);
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = 0.65;
            ctx.drawImage(crush, 0, 0, w, h);
            ctx.restore();
        }
        renderWinLum(H, S) {
            const ctx = this.ui.winLum.getContext('2d');
            const w = this.ui.winLum.width;
            const h = this.ui.winLum.height;
            const img = ctx.createImageData(w, h);
            const d = img.data;
            for (let y = 0; y < h; y++) {
                const L = Math.round((1 - (y / (h - 1))) * 240);
                const rgb = this.winHslToRgb(H, S, L);
                for (let x = 0; x < w; x++) {
                    const idx = (y * w + x) * 4;
                    d[idx] = rgb.r; d[idx+1] = rgb.g; d[idx+2] = rgb.b; d[idx+3] = 255;
                }
            }
            ctx.putImageData(img, 0, 0);

            if (!this._winLumCrushCanvas) {
                this._winLumCrushCanvas = document.createElement('canvas');
            }
            const crush = this._winLumCrushCanvas;
            const steps = 31;
            if (crush.width !== 1 || crush.height !== steps) {
                crush.width = 1;
                crush.height = steps;
            }
            const cctx = crush.getContext('2d');
            const cimg = cctx.createImageData(1, steps);
            const cd = cimg.data;
            for (let y = 0; y < steps; y++) {
                const L = Math.round((1 - (y / (steps - 1))) * 240);
                const rgb = this.winHslToRgb(H, S, L);
                const idx = y * 4;
                cd[idx] = rgb.r; cd[idx+1] = rgb.g; cd[idx+2] = rgb.b; cd[idx+3] = 255;
            }
            cctx.putImageData(cimg, 0, 0);
            ctx.save();
            ctx.imageSmoothingEnabled = false;
            ctx.globalAlpha = 0.65;
            ctx.drawImage(crush, 0, 0, w, h);
            ctx.restore();
        }
        rgbToWinHsl(r, g, b) {
            const rf = r/255, gf = g/255, bf = b/255;
            const max = Math.max(rf, gf, bf);
            const min = Math.min(rf, gf, bf);
            let h = 0, s = 0, l = (max + min) / 2;
            const d = max - min;
            if (d !== 0) {
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case rf: h = (gf - bf) / d + (gf < bf ? 6 : 0); break;
                    case gf: h = (bf - rf) / d + 2; break;
                    case bf: h = (rf - gf) / d + 4; break;
                }
                h /= 6;
            }
            return { H: Math.round(h * 239), S: Math.round(s * 240), L: Math.round(l * 240) };
        }
        winHslToRgb(H, S, L) {
            let h = (H / 239);
            let s = (S / 240);
            let l = (L / 240);
            let r, g, b;
            if (s === 0) {
                r = g = b = l;
            } else {
                const hue2rgb = (p, q, t) => {
                    if (t < 0) t += 1;
                    if (t > 1) t -= 1;
                    if (t < 1/6) return p + (q - p) * 6 * t;
                    if (t < 1/2) return q;
                    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                    return p;
                };
                const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                const p = 2 * l - q;
                r = hue2rgb(p, q, h + 1/3);
                g = hue2rgb(p, q, h);
                b = hue2rgb(p, q, h - 1/3);
            }
            return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
        }
        openQuantColorPicker() {
            const cfg = this.getDepthConfig();
            const modal = document.getElementById('modal-color-quant');
            const panel15 = document.getElementById('color-quant-15-16');
            const panel8 = document.getElementById('color-quant-8');
            if (cfg.mode === 'indexed') {
                panel15.style.display = 'none';
                panel8.style.display = 'block';
                this.renderQuantPalette();
            } else {
                panel15.style.display = 'block';
                panel8.style.display = 'none';
                this.initQuantSliders();
            }
            modal.style.display = 'flex';
        }
        initQuantSliders() {
            const cfg = this.getDepthConfig();
            const hex = this.config.activeSlot === 1 ? this.config.c1 : this.config.c2;
            const rgb = this.hexToRgb(hex);
            const r5 = Math.round((rgb.r / 255) * 31);
            const gMax = cfg.mode === 'rgb565' ? 63 : 31;
            const gVal = Math.round((rgb.g / 255) * gMax);
            const b5 = Math.round((rgb.b / 255) * 31);
            document.getElementById('cq-r').max = 31;
            document.getElementById('cq-g').max = gMax;
            document.getElementById('cq-b').max = 31;
            document.getElementById('cq-r').value = r5;
            document.getElementById('cq-g').value = gVal;
            document.getElementById('cq-b').value = b5;
            document.getElementById('cq-rn').value = r5;
            document.getElementById('cq-gn').value = gVal;
            document.getElementById('cq-bn').value = b5;
        }
        updateQuantPreview(fromNumber = false) {
            const cfg = this.getDepthConfig();
            const gMax = cfg.mode === 'rgb565' ? 63 : 31;
            const rEl = document.getElementById('cq-r');
            const gEl = document.getElementById('cq-g');
            const bEl = document.getElementById('cq-b');
            const rn = document.getElementById('cq-rn');
            const gn = document.getElementById('cq-gn');
            const bn = document.getElementById('cq-bn');
            if (fromNumber) {
                rEl.value = rn.value;
                gEl.value = gn.value;
                bEl.value = bn.value;
            } else {
                rn.value = rEl.value;
                gn.value = gEl.value;
                bn.value = bEl.value;
            }
            rEl.max = 31; gEl.max = gMax; bEl.max = 31;
        }
        applyQuantColor() {
            const cfg = this.getDepthConfig();
            if (cfg.mode === 'indexed') {
                this.closeModals();
                return;
            }
            const r5 = parseInt(document.getElementById('cq-r').value, 10);
            const gN = parseInt(document.getElementById('cq-g').value, 10);
            const b5 = parseInt(document.getElementById('cq-b').value, 10);
            const r = Math.round((r5 / 31) * 255);
            const gMax = cfg.mode === 'rgb565' ? 63 : 31;
            const g = Math.round((gN / gMax) * 255);
            const b = Math.round((b5 / 31) * 255);
            const hex = this.rgbToHex(r, g, b);
            this.setColor(hex, this.config.activeSlot);
            this.closeModals();
        }
        setColor(c, s) {
            // A colour arriving from anywhere but the palette strip (picker,
            // eyedropper, swap) is just a colour — it no longer names a slot.
            // pickPaletteSlot() re-establishes the link straight after this call.
            if (this.config.paletteSlot) this.config.paletteSlot[s === 2 ? 2 : 1] = -1;
            if(s===1) {
                this.config.c1=c;
                const c1 = document.getElementById('c1-disp');
                if (c1) {
                    c1.style.backgroundColor = c;
                    if (c.toLowerCase() === '#000000') c1.dataset.fixedBlack = 'true';
                    else delete c1.dataset.fixedBlack;
                }
            } else {
                this.config.c2=c;
                document.getElementById('c2-disp').style.backgroundColor=c;
            }
            if (this.state.activeShape && this.state.shapeEditMode && this.state.activeShape.colorSlot === s) {
                this.state.activeShape.c = this.mapHexToMode(c);
                this.renderActiveShape();
            }
            if (this.config.tool === 'curve' && this.state.curveDrawSlot === s) {
                this.refreshCurvePreview();
            }
            if (this.config.tool === 'path' && FreehandPathEngine.isActive() && this.state.freehandPathSlot === s) {
                FreehandPathEngine.setColor(this.getActiveDrawColor(s === 2));
            }
            // Sync gradient stop colors with c1/c2 when stops are initialized
            const _stops = this.config.gradient.stops;
            if (_stops && _stops.length >= 2) {
                if (s === 1) _stops[0].color = c;
                else _stops[_stops.length - 1].color = c;
            }
            // Live-update gradient preview when a color changes while the gradient is active or being placed
            if (this.config.tool === 'gradient' && (this.config.gradient.active || this.config.gradient.isPlacing)) {
                const _g = this.config.gradient;
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
                _gradientRender(this.ctxTemp, _g, this.config.width, this.config.height, this.config.c1, this.config.c2);
                this._clipGradientToSelection();
                this._gradientDrawVectorSVG();
            }
            if (this._renderGradBar) this._renderGradBar();
            this.selectSlot(s);
        }
        isShapeTool(t) {
            return ['line','rect','circle','tri','curve','poly','path'].includes(t);
        }
        showSaveIndicator(show) {
            if (!this.ui.saveIndicator) return;
            this.ui.saveIndicator.style.display = show ? 'block' : 'none';
            if (show) {
                this.ui.stage.style.cursor = 'wait';
                document.body.style.cursor = 'wait';
                document.body.classList.add('busy-cursor');
            } else {
                this.updateCursorForTool(this.config.tool);
                document.body.style.cursor = '';
                document.body.classList.remove('busy-cursor');
            }
        }
        queueSaveCursorFeedback(durationMs = this.saveCursorFeedbackMs) {
            const ms = Math.max(0, Math.round(Number(durationMs) || 0));
            const until = Date.now() + ms;
            this._saveCursorFeedbackUntil = Math.max(this._saveCursorFeedbackUntil || 0, until);
            this.state.saveFeedbackActive = true;
            if (this._saveCursorFeedbackTimer) {
                clearTimeout(this._saveCursorFeedbackTimer);
                this._saveCursorFeedbackTimer = null;
            }
            const release = () => {
                const remaining = this._saveCursorFeedbackUntil - Date.now();
                if (remaining > 0) {
                    this._saveCursorFeedbackTimer = setTimeout(release, remaining);
                    return;
                }
                this._saveCursorFeedbackTimer = null;
                this._saveCursorFeedbackUntil = 0;
                this.state.saveFeedbackActive = false;
                this.updateBusyIndicator();
            };
            const delay = Math.max(0, this._saveCursorFeedbackUntil - Date.now());
            this._saveCursorFeedbackTimer = setTimeout(release, delay);
            this.updateBusyIndicator();
        }
        updateBusyIndicator() {
            const show = !!this.state.isSaving || !!this.state.isFileLoading || (this.state.busyOps > 0) || !!this.state.forceBusyIndicator || !!this.state.saveFeedbackActive;
            this.showSaveIndicator(show);
        }
        beginOperation() {
            this.state.busyOps++;
            this.updateBusyIndicator();
        }
        endOperation() {
            this.state.busyOps = Math.max(0, this.state.busyOps - 1);
            this.updateBusyIndicator();
        }
        toggleBusyIndicatorTest() {
            this.state.forceBusyIndicator = !this.state.forceBusyIndicator;
            this.updateBusyIndicator();
        }
        debugLogConfig() {
            console.log('PaintApp config', JSON.parse(JSON.stringify(this.config)));
        }
        debugLogState() {
            const s = this.state;
            const selection = s.selection ? {
                x: s.selection.x, y: s.selection.y, w: s.selection.w, h: s.selection.h,
                mask: !!s.selection.mask,
                paletteSize: s.selection.palette && s.selection.palette.list ? s.selection.palette.list.length : 0
            } : null;
            const activeShape = s.activeShape ? {
                type: s.activeShape.type || s.activeShape.tool || 'shape'
            } : null;
            console.log('PaintApp state', {
                tool: this.config.tool,
                zoom: this.config.zoom,
                isDrawing: s.isDrawing,
                isMovingSel: s.isMovingSel,
                polyActive: s.polyActive,
                lassoActive: s.lassoActive,
                wandActive: s.wandActive,
                selection,
                activeShape,
                historySize: s.history ? s.history.length : 0,
                step: s.step
            });
        }
        debugCanvasInfo() {
            const main = this.ui.cMain;
            const temp = this.ui.cTemp;
            console.log('PaintApp canvas', {
                width: this.config.width,
                height: this.config.height,
                zoom: this.config.zoom,
                main: main ? { w: main.width, h: main.height } : null,
                temp: temp ? { w: temp.width, h: temp.height } : null,
                devicePixelRatio: window.devicePixelRatio || 1
            });
        }
        debugClearTempCanvas() {
            this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
            if (this.ui && this.ui.cTemp) this.ui.cTemp.style.mixBlendMode = 'normal';
        }
        debugResetBlendMode() {
            if (this.ui && this.ui.cTemp) this.ui.cTemp.style.mixBlendMode = 'normal';
        }
        updateCursorForTool(t) {
            if (t === 'pencil') {
                if (this.ui.pencilIcon && this.ui.pencilIcon.src) {
                    this.ui.stage.style.cursor = `url("${this.ui.pencilIcon.src}") 1 16, crosshair`;
                    return;
                }
            }
            if (t === 'fill') {
                // [THIRD-PARTY ASSET: EXCLUDED FROM MIT LICENSE - PROPERTY OF MICROSOFT]
                const fillCursor = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAQCAYAAADwMZRfAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kb9Lw0AcxV9TtSKVInYQcchQneyiIo6likWwUNoKrTqYXPoLmjQkKS6OgmvBwR+LVQcXZ10dXAVB8AeIf4A4KbpIid9LCi1iPDjuw7t7j7t3gNCsMtXsiQGqZhnpRFzM5VfFwCsE9CGEIQQkZurJzGIWnuPrHj6+3kV5lve5P8egUjAZ4BOJY0w3LOIN4tlNS+e8TxxmZUkhPieeNOiCxI9cl11+41xyWOCZYSObnicOE4ulLpa7mJUNlXiGOKKoGuULOZcVzluc1Wqdte/JXxgsaCsZrtMcQwJLSCIFETLqqKAKC1FaNVJMpGk/7uEfdfwpcsnkqoCRYwE1qJAcP/gf/O7WLE5PuUnBOND7Ytsf40BgF2g1bPv72LZbJ4D/GbjSOv5aE5j7JL3R0SJHQGgbuLjuaPIecLkDjDzpkiE5kp+mUCwC72f0TXlg+BYYWHN7a+/j9AHIUlfLN8DBITBRoux1j3f3d/f275l2fz84T3KPL6Lu2QAAAAZiS0dEAD8AQQBJpGqK6wAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAAd0SU1FB+oCBhEJLa1ZsIMAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAABaUlEQVQ4y52TPU/CQBjH/6Ul/QwQwktQYDBuxkVT61ZXnOBzOCmvrQvubrrBR9BFRVqHGomJsvBigpIIg23ijvFcbHPAtRj/yz157u53z9vxWKJUOpNbW994FkVhYNtWB/+RJCuEXlni/CIIhRN12tdqXjLPB/wAtzcXAAC1WnL9fwo/lc7kJFkhjhxbN0wiyQrxBKlajahajUiyQmgADfEF0ZclWSG6YXpCvED8NxHKLvA391g0AgDQjk9wfnY682gsGkEyuYKH9lPWaTuzsMbdvWvv7O4t7G9vbUKtlhAKJ+qpdCbnQibjYb5QrKDV0l3Q0eEBnA75iY8nVssA8Ng290VRGHxYn1k+EEA8HsNo9O6mNh9poVjBZDzM93vdBuan0WmxqtWIbpgLhWYVdqEm/V63MRkP81fXzZnUPCMAwAPA2+tLhQbZttVhpcYC+P4devw5jgMhhAlYCnFA0+kXgkEBLAAA/AALFxCMGaf/5QAAAABJRU5ErkJggg==';
                this.ui.stage.style.cursor = `url("${fillCursor}") 1 12, crosshair`;
                return;
            }
            if (this.state && (this.state.selection || this.state.activeShape)) {
                const selCursor = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABUAAAAVCAYAAACpF6WWAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kb1Lw1AUxU/TlopUHOwg4pChOtlFRRxLLRbBQmkrtOpg8tIvaNKQpLg4Cq4FBz8Wqw4uzro6uAqC4AeIf4A4KbpIifclhRYxPri8H+e9c7jvPkBo15lqBuKAqllGNpUQC8VVMfQKAUGEqAISM/V0bjEPz/V1Dx/f72I8y/ven2tIKZkM8InEcaYbFvEG8dympXPeJ46wqqQQnxNPGdQg8SPXZZffOFccFnhmxMhnF4gjxGKlj+U+ZlVDJZ4ljiqqRvlCwWWF8xZntd5k3T75C8MlbSXHdapxpLCENDIQIaOJGuqwEKNdI8VEls4THv4xx58hl0yuGhg5kmhAheT4wf/g92zN8sy0mxROAMEX2/6YAEK7QKdl29/Htt05AfzPwJXW8zfawPwn6a2eFj0ChreBi+ueJu8BlzvA6JMuGZIj+amEchl4P6NvKgIjt8Dgmju37jlOH4A8zWr5Bjg4BCYrlL3u8e6B/rn9e6c7vx/8SnJ3TRqVAAAAAAZiS0dEAAAAAAAA+UO7fwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAAd0SU1FB+oCBQcGMEPZsLkAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAAeklEQVQ4y+2UQQ6AIAwE2+pT4KT/f4kn3gKsB6JBE7QxqSaGvUHKhG03JVIIAJybAACaeiEDdejH0Jx0dayJk/fzfg5hIRHmxzZyLvms71R5RUMpHoE1aAO3NNbW7loAAMzF+uU7i5+a9PT96Z+3VIoGW0qGvlB+BV0Bely/RqNtJIAAAAAASUVORK5CYII=';
                this.ui.stage.style.cursor = `url("${selCursor}") 10 10, crosshair`;
                return;
            }
            if (['rect','ellipse','tri','line','curve','poly','roundrect','select','lasso','wand'].includes(t)) {
                const selCursor = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABUAAAAVCAYAAACpF6WWAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kb1Lw1AUxU/TlopUHOwg4pChOtlFRRxLLRbBQmkrtOpg8tIvaNKQpLg4Cq4FBz8Wqw4uzro6uAqC4AeIf4A4KbpIifclhRYxPri8H+e9c7jvPkBo15lqBuKAqllGNpUQC8VVMfQKAUGEqAISM/V0bjEPz/V1Dx/f72I8y/ven2tIKZkM8InEcaYbFvEG8dympXPeJ46wqqQQnxNPGdQg8SPXZZffOFccFnhmxMhnF4gjxGKlj+U+ZlVDJZ4ljiqqRvlCwWWF8xZntd5k3T75C8MlbSXHdapxpLCENDIQIaOJGuqwEKNdI8VEls4THv4xx58hl0yuGhg5kmhAheT4wf/g92zN8sy0mxROAMEX2/6YAEK7QKdl29/Htt05AfzPwJXW8zfawPwn6a2eFj0ChreBi+ueJu8BlzvA6JMuGZIj+amEchl4P6NvKgIjt8Dgmju37jlOH4A8zWr5Bjg4BCYrlL3u8e6B/rn9e6c7vx/8SnJ3TRqVAAAAAAZiS0dEAAAAAAAA+UO7fwAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAAd0SU1FB+oCBQcGMEPZsLkAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAAeklEQVQ4y+2UQQ6AIAwE2+pT4KT/f4kn3gKsB6JBE7QxqSaGvUHKhG03JVIIAJybAACaeiEDdejH0Jx0dayJk/fzfg5hIRHmxzZyLvms71R5RUMpHoE1aAO3NNbW7loAAMzF+uU7i5+a9PT96Z+3VIoGW0qGvlB+BV0Bely/RqNtJIAAAAAASUVORK5CYII=';
                this.ui.stage.style.cursor = `url("${selCursor}") 10 10, crosshair`;
                return;
            }
            if (t === 'picker') {
                const pickerCursor = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA8AAAAPCAYAAAA71pVKAAABhGlDQ1BJQ0MgcHJvZmlsZQAAKJF9kb9Lw0AcxV9Ta0UqDnYQ6ZChOrWLijiWKhbBQmkrtOpgcukvaGJIUlwcBdeCgz8Wqw4uzro6uAqC4A8Q/wBxUnSREr+XFFrEeHDch3f3HnfvAKFVZ6rZlwBUzTKyqaRYKK6IwVcICKAfEcQkZurp3EIenuPrHj6+3sV5lve5P8eQUjIZ4BOJE0w3LOJ14plNS+e8TxxmVUkhPieOGXRB4keuyy6/ca44LPDMsJHPzhGHicVKD8s9zKqGSjxNHFVUjfKFgssK5y3Oar3BOvfkLwyVtOUc12lGkMIi0shAhIwGaqjDQpxWjRQTWdpPevjHHH+GXDK5amDkmMcGVEiOH/wPfndrlqcm3aRQEgi82PbHOBDcBdpN2/4+tu32CeB/Bq60rn+jBcx+kt7satEjYHgbuLjuavIecLkDjD7pkiE5kp+mUC4D72f0TUVg5BYYXHV76+zj9AHIU1dLN8DBITBRoew1j3cP9Pb275lOfz+WyXK1+DFMDQAAAAZiS0dEABcAAAD/BoEfYAAAAAlwSFlzAAAuIwAALiMBeKU/dgAAAAd0SU1FB+oCBQYgAKccaQYAAAAZdEVYdENvbW1lbnQAQ3JlYXRlZCB3aXRoIEdJTVBXgQ4XAAAAqUlEQVQoz73QvQ3CMBAF4Of00NAnygogUWK59ASMkYqKP4FdeRImIF1CkiZbHZUjFGTja3iVZenTuzsBRtab7WOxXO0BoGtrkXGhuV8BAFJpElx4vtym/yiWSpN/z2EUG+sIAKTcAcAX7NpaJDfPIQBkseZX8wzCIDbW0el4mHZNjrGOfPphJD96aIWfMKmxH8Y/wrwoKz8uC362Gut40F9RKk15UVZg5g11jIQCdP10IAAAAABJRU5ErkJggg==';
                this.pickerCursorBase = pickerCursor;
                this.pickerCursorHotspot = { x: 2, y: 21 };
                this.setPickerCursorBase();
                // [END THIRD-PARTY ASSET - LICENSED LOGIC RESUMES BELOW]
                return;
            }
            if (t === 'paintbrush') {
                if (this.brush && this.brush.updateCursor) {
                    this.brush.updateCursor();
                } else {
                    this.ui.stage.style.cursor = 'crosshair';
                }
                return;
            }
            this.ui.stage.style.cursor = 'crosshair';
        }
        enqueueStroke(seg) {
            this.strokeQueue.push(seg);
            if (!this.strokeRaf) {
                this.strokeRaf = requestAnimationFrame(() => this.flushStrokes());
            }
        }
        flushPendingStrokes() {
            // Finish queued stroke frames before we save or merge layers.
            if (this.strokeRaf) {
                cancelAnimationFrame(this.strokeRaf);
                this.strokeRaf = null;
            }
            if (this.strokeQueue.length) {
                this.flushStrokes();
            }
        }
        cancelPendingStrokes() {
            // Drop queued stroke frames when undo/redo interrupts drawing.
            if (this.strokeRaf) {
                cancelAnimationFrame(this.strokeRaf);
            }
            this.strokeRaf = null;
            this.strokeQueue = [];
        }
        flushStrokes() {
            const q = this.strokeQueue;
            this.strokeQueue = [];
            this.strokeRaf = null;
            const webglGroups = new Map();
            const webglQuadGroups = new Map();
            const cpu = [];
            const threshold = 16;
            const maxPointSize = this.glBrushLimits && this.glBrushLimits.maxPointSize
                ? Math.floor(this.glBrushLimits.maxPointSize)
                : threshold;
            const pointSpriteCap = Math.max(0, Math.min(maxPointSize || 0, 15));
            const glThreshold = pointSpriteCap ? Math.max(1, Math.min(threshold, pointSpriteCap)) : Infinity;
            const quadAreaLimit = 33177600;
            const canQuadByArea = (this.config.width * this.config.height) < quadAreaLimit;
            const useWebGL = !!this.glBrush && this.canUseWebGLBrushForSize(this.config.width, this.config.height);
            const canQuad = !!this.glBrushQuadProgram && !!this.glBrushQuadBuffers && canQuadByArea;
            const quadFallbackToCpu = !canQuad;
            for (let i = 0; i < q.length; i++) {
                const s = q[i];
                if (useWebGL && s.width >= glThreshold) {
                    const key = `${s.width}|${s.isEraser}|${s.color}`;
                    if (s.width <= pointSpriteCap) {
                        if (!webglGroups.has(key)) webglGroups.set(key, []);
                        webglGroups.get(key).push(s);
                    } else if (canQuad) {
                        if (!webglQuadGroups.has(key)) webglQuadGroups.set(key, []);
                        webglQuadGroups.get(key).push(s);
                        if (quadFallbackToCpu) cpu.push(s);
                    } else {
                        cpu.push(s);
                    }
                } else {
                    cpu.push(s);
                }
            }
            for (let i = 0; i < cpu.length; i++) {
                const s = cpu[i];
                this.drawBinaryLine(s.x0, s.y0, s.x1, s.y1, s.color, false, s.width, s.isEraser);
            }
            if (webglGroups.size > 0 || webglQuadGroups.size > 0) {
                this.renderWebGLStrokes(webglGroups, webglQuadGroups);
            }
        }
        collectLinePoints(x0, y0, x1, y1) {
            let ix0 = Math.floor(x0), iy0 = Math.floor(y0), ix1 = Math.floor(x1), iy1 = Math.floor(y1);
            const dx = Math.abs(ix1 - ix0), dy = Math.abs(iy1 - iy0);
            const sx = (ix0 < ix1) ? 1 : -1, sy = (iy0 < iy1) ? 1 : -1;
            let err = dx - dy;
            const pts = [];
            while (true) {
                pts.push(ix0 + 0.5, iy0 + 0.5);
                if (ix0 === ix1 && iy0 === iy1) break;
                const e2 = 2 * err;
                if (e2 > -dy) { err -= dy; ix0 += sx; }
                if (e2 < dx) { err += dx; iy0 += sy; }
            }
            return pts;
        }
        // Compute the pixel-aligned bounding box covering all segments in both group maps,
        // expanded by half the brush width so every stroke is fully contained.
        _strokesBBox(groups, quadGroups) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const expand = (segs, halfW) => {
                for (let i = 0; i < segs.length; i++) {
                    const s = segs[i];
                    const x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1);
                    const y0 = Math.min(s.y0, s.y1), y1 = Math.max(s.y0, s.y1);
                    if (x0 - halfW < minX) minX = x0 - halfW;
                    if (y0 - halfW < minY) minY = y0 - halfW;
                    if (x1 + halfW > maxX) maxX = x1 + halfW;
                    if (y1 + halfW > maxY) maxY = y1 + halfW;
                }
            };
            if (groups) groups.forEach((segs, key) => {
                const w = parseFloat(key.split('|')[0]);
                expand(segs, Math.ceil(w / 2) + 1);
            });
            if (quadGroups) quadGroups.forEach((segs, key) => {
                const w = parseFloat(key.split('|')[0]);
                expand(segs, Math.ceil(w / 2) + 1);
            });
            const cw = this.config.width, ch = this.config.height;
            const x = Math.max(0, Math.floor(minX));
            const y = Math.max(0, Math.floor(minY));
            const x2 = Math.min(cw, Math.ceil(maxX));
            const y2 = Math.min(ch, Math.ceil(maxY));
            return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
        }
        renderWebGLStrokes(groups, quadGroups) {
            if (!this.glBrush || !this.glBrushCanvas) return;
            const gl = this.glBrush;

            // Size the GL canvas to just the stroke bounding box instead of the full
            // canvas — on a 4000×4000 canvas this can cut VRAM usage by 99% per flush.
            const bbox = this._strokesBBox(groups, quadGroups);
            if (this.glBrushCanvas.width !== bbox.w || this.glBrushCanvas.height !== bbox.h) {
                this.glBrushCanvas.width  = bbox.w;
                this.glBrushCanvas.height = bbox.h;
            }
            // Offset all coordinates so they are relative to the bbox origin.
            const ox = bbox.x, oy = bbox.y;

            gl.viewport(0, 0, bbox.w, bbox.h);
            gl.clearColor(0,0,0,0);
            gl.clear(gl.COLOR_BUFFER_BIT);

            if (groups && groups.size > 0) {
                gl.useProgram(this.glBrushProgram);
                const { uRes, uSize, uColor, uIsSquare } = this.glBrushUniforms;
                gl.uniform2f(uRes, bbox.w, bbox.h);
                if (this.glBrushBuffers && this.glBrushBuffers.posBuf !== null) {
                    const aPos = this.glBrushBuffers.aPos;
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBrushBuffers.posBuf);
                    gl.enableVertexAttribArray(aPos);
                    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
                }

                groups.forEach((segs, key) => {
                    const [widthStr, isEraserStr, color] = key.split('|');
                    const width = parseFloat(widthStr);
                    const isEraser = isEraserStr === 'true';
                    let ptCount = 0;
                    for (let i = 0; i < segs.length; i++) {
                        const p = this.collectLinePoints(segs[i].x0, segs[i].y0, segs[i].x1, segs[i].y1);
                        const needed = ptCount + p.length;
                        if (needed > this._strokePtsBuf.length) {
                            const next = new Float32Array(Math.max(needed * 2, this._strokePtsBuf.length * 2));
                            next.set(this._strokePtsBuf.subarray(0, ptCount));
                            this._strokePtsBuf = next;
                        }
                        // Shift points into bbox-local space.
                        for (let j = 0; j < p.length; j += 2) {
                            this._strokePtsBuf[ptCount + j]     = p[j]     - ox;
                            this._strokePtsBuf[ptCount + j + 1] = p[j + 1] - oy;
                        }
                        ptCount += p.length;
                    }
                    if (ptCount === 0) return;
                    const rgb = this.hexToRgb(color);
                    gl.uniform4f(uColor, rgb.r/255, rgb.g/255, rgb.b/255, 1.0);
                    gl.uniform1f(uSize, width);
                    gl.uniform1f(uIsSquare, isEraser ? 1.0 : 0.0);
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBrushBuffers.posBuf);
                    gl.bufferData(gl.ARRAY_BUFFER, this._strokePtsBuf.subarray(0, ptCount), gl.DYNAMIC_DRAW);
                    gl.drawArrays(gl.POINTS, 0, ptCount / 2);
                });
            }

            if (quadGroups && quadGroups.size > 0 && this.glBrushQuadProgram && this.glBrushQuadBuffers) {
                gl.useProgram(this.glBrushQuadProgram);
                const { uRes, uColor, uIsSquare } = this.glBrushQuadUniforms;
                gl.uniform2f(uRes, bbox.w, bbox.h);
                const quadBufs = this.glBrushQuadBuffers;
                gl.bindBuffer(gl.ARRAY_BUFFER, quadBufs.posBuf);
                gl.enableVertexAttribArray(quadBufs.aPos);
                gl.vertexAttribPointer(quadBufs.aPos, 2, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, quadBufs.texBuf);
                gl.enableVertexAttribArray(quadBufs.aTex);
                gl.vertexAttribPointer(quadBufs.aTex, 2, gl.FLOAT, false, 0, 0);

                quadGroups.forEach((segs, key) => {
                    const [widthStr, isEraserStr, color] = key.split('|');
                    const width = parseFloat(widthStr);
                    const isEraser = isEraserStr === 'true';
                    const size = Math.ceil(width);
                    const half = size / 2;
                    const verts = [];
                    const tex = [];
                    for (let i = 0; i < segs.length; i++) {
                        const s = segs[i];
                        const p = this.collectLinePoints(s.x0, s.y0, s.x1, s.y1);
                        for (let j = 0; j < p.length; j += 2) {
                            // Shift into bbox-local space.
                            const x = p[j] - ox;
                            const y = p[j + 1] - oy;
                            const left = x - half;
                            const right = x + half;
                            const top = y - half;
                            const bottom = y + half;
                            verts.push(left, top, right, top, left, bottom, left, bottom, right, top, right, bottom);
                            tex.push(0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1);
                        }
                    }
                    if (verts.length === 0) return;
                    const rgb = this.hexToRgb(color);
                    gl.uniform4f(uColor, rgb.r/255, rgb.g/255, rgb.b/255, 1.0);
                    gl.uniform1f(uIsSquare, isEraser ? 1.0 : 0.0);
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBrushQuadBuffers.posBuf);
                    if (verts.length > this._strokeVertsBuf.length) {
                        this._strokeVertsBuf = new Float32Array(verts.length * 2);
                    }
                    this._strokeVertsBuf.set(verts);
                    gl.bufferData(gl.ARRAY_BUFFER, this._strokeVertsBuf.subarray(0, verts.length), gl.DYNAMIC_DRAW);
                    gl.bindBuffer(gl.ARRAY_BUFFER, this.glBrushQuadBuffers.texBuf);
                    if (tex.length > this._strokeTexBuf.length) {
                        this._strokeTexBuf = new Float32Array(tex.length * 2);
                    }
                    this._strokeTexBuf.set(tex);
                    gl.bufferData(gl.ARRAY_BUFFER, this._strokeTexBuf.subarray(0, tex.length), gl.DYNAMIC_DRAW);
                    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
                });
            }

            // Draw the bbox-sized GL canvas onto the main canvas at the correct offset.
            this.ctx.drawImage(this.glBrushCanvas, ox, oy);
        }
        getToolWidth(t) {
            if (t === 'eraser') return this.config.eraserWidth;
            if (this.isShapeTool(t)) return this.config.shapeWidth;
            if (t === 'freehand') return this.config.freehand?.size ?? 4;
            if (t === 'paintbrush') return this.config.paintbrush?.size ?? 12;
            return this.config.lineWidth;
        }
        setToolWidth(t, val) {
            if (!Number.isFinite(val)) return;
            const n = Math.max(1.0, val);
            let didUpdateActiveShape = false;
            if (t === 'eraser') {
                this.config.eraserWidth = n;
            } else             if (t === 'freehand') {
                if (!this.config.freehand) this.config.freehand = { size: 4 };
                this.config.freehand.size = n;
                this.updateFreehandPanel();
                this._saveFreehandConfig();
            } else if (t === 'paintbrush') {
                if (!this.config.paintbrush) this.config.paintbrush = { size: 12 };
                this.config.paintbrush.size = n;
                if (this.brush && typeof this.brush.setParam === 'function') {
                    this.brush.setParam('size', n);
                }
            } else if (this.isShapeTool(t)) {
                this.config.shapeWidth = n;
                if(this.state.activeShape) {
                    this.state.activeShape.lw = n;
                    didUpdateActiveShape = true;
                    this.renderActiveShape();
                }
                if (this.config.tool === 'curve') {
                    this.refreshCurvePreview();
                }
            } else {
                this.config.lineWidth = n;
            }

            if (!didUpdateActiveShape && this.state.shapeEditMode && this.state.activeShape) {
                // Smart Pencil can create editable vector shapes while the current tool is still "pencil".
                // Keep the active shape stroke width in sync with the global size control (Ctrl+Plus/Minus).
                const s = this.state.activeShape;
                if (Number.isFinite(s.lw) && s.lw !== n) {
                    s.lw = n;
                    this.renderActiveShape();
                }
            }
            this.syncLineWidthMenu();
        }
        selectSlot(s) {
            this.config.activeSlot=s;
            document.getElementById('c1-wrap').classList.toggle('selected', s===1);
            document.getElementById('c2-wrap').classList.toggle('selected', s===2);
        }
        changeSizeInput(v) {
            const val = parseFloat(v);
            this.setToolWidth(this.config.tool, val);
            this.ui.sizeInput.value = this.getToolWidth(this.config.tool);
            this.brushCache = null; this._brushLRU = [];
            this.refreshEraserGhost();
        }
        changeSize(d) {
            let current = this.getToolWidth(this.config.tool);

            let n = current + d;
            if(n < 1.0) n = 1.0;
            n = parseFloat(n.toFixed(1));

            this.setToolWidth(this.config.tool, n);
            this.ui.sizeInput.value = n;
            this.brushCache = null; this._brushLRU = [];
            this.refreshEraserGhost();
        }
        setSize(w,h) {
            // Resizing clears the canvas; no prior knowledge survives it.
            this.markAllDirty();
            this.config.width=w;
            this.config.height=h;
            this.tileHistory.enabled = this.shouldUseTiledHistory(w, h);
            this.tileHistory.tileSize = this._chooseTileSize(w, h);
            this.ui.cMain.width=w;
            this.ui.cMain.height=h;
            this.ui.cTemp.width=w;
            this.ui.cTemp.height=h;
            if (this.ui.frameOnion) { this.ui.frameOnion.width=w; this.ui.frameOnion.height=h; }
            // Resizing a canvas resets its context state — clear the smoothing guard
            // so disableSmoothing() re-applies the properties on the next call.
            this.ctx._smoothingDisabled = false;
            this.ctxTemp._smoothingDisabled = false;
            if (this.glBrushCanvas) {
                if (this.canUseWebGLBrushForSize(w, h)) {
                    // GL canvas is now bbox-sized per flush — no need to resize it here.
                    // Just ensure it stays valid for the new canvas dimensions.
                } else {
                    this.disableWebGLBrush();
                }
            } else if (!this.glBrush && this.canUseWebGLBrushForSize(w, h) && this.glBrushLimits) {
                this.initWebGLBrush();
            }
            this.disableSmoothing(this.ctx);
            this.disableSmoothing(this.ctxTemp);
            this.ui.stage.style.width=w+'px';
            this.ui.stage.style.height=h+'px';
            this.updateBounds();
            this.ui.statusDims.textContent = `${Math.floor(w)} x ${Math.floor(h)}px`;
            this.deferColorCounts();
            this.updateViewportScrollability();
            this.updateGridOverlay();
            this._applyMemoryBudget();
        }
        _applyMemoryBudget() {
            this._syncHistoryLimitInput();
            this.updateHistoryUsage();
        }
        _rleEncode(data) {
            const out = [];
            let i = 0;
            while (i < data.length) {
                let run = 1;
                const maxRun = Math.min(255, (data.length - i) / 4);
                while (run < maxRun && data[i] === data[i+run*4] && data[i+1] === data[i+run*4+1]
                    && data[i+2] === data[i+run*4+2] && data[i+3] === data[i+run*4+3]) run++;
                out.push(run, data[i], data[i+1], data[i+2], data[i+3]);
                i += run * 4;
            }
            return new Uint8Array(out);
        }
        _rleDecode(rle, w, h) {
            const out = new Uint8ClampedArray(w * h * 4);
            let di = 0;
            for (let i = 0; i < rle.length; i += 5) {
                const count = rle[i];
                for (let j = 0; j < count; j++) {
                    out[di] = rle[i+1]; out[di+1] = rle[i+2];
                    out[di+2] = rle[i+3]; out[di+3] = rle[i+4];
                    di += 4;
                }
            }
            return out;
        }
        _rleEqual(a, b) {
            if (a === b) return true;
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }
        /* Capture the canvas as tiles. With `prevMap` supplied, only tiles that
         * differ from it are returned — the entry becomes a delta on the step
         * before it. With `anchor` set, every tile is returned, so the entry
         * stands alone and bounds how far a restore has to walk back. */
        saveStateDeferred() {
            if (this._deferredSave) return;
            this._deferredSave = true;
            const run = () => {
                if (!this._deferredSave) return;      // already flushed
                this._deferredSave = false;
                this._deferredSaveTimer = null;
                this.saveState();
            };
            // One frame lets the paint land, then idle time does the recording.
            requestAnimationFrame(() => {
                if (!this._deferredSave) return;
                if (window.requestIdleCallback) {
                    this._deferredSaveTimer = requestIdleCallback(run, { timeout: 120 });
                } else {
                    this._deferredSaveTimer = setTimeout(run, 0);
                }
            });
        }
        flushDeferredSave() {
            if (!this._deferredSave) return;
            this._deferredSave = false;
            if (this._deferredSaveTimer != null) {
                if (window.cancelIdleCallback) { try { cancelIdleCallback(this._deferredSaveTimer); } catch (e) {} }
                clearTimeout(this._deferredSaveTimer);
                this._deferredSaveTimer = null;
            }
            this.saveState();
        }

        /* Copy the preview onto the artwork, but only the part a stroke
         * actually reached. Copying the whole preview told history that the
         * entire canvas had changed — on a 13000x13000 document that meant
         * reading back every pixel, which is what made the app freeze after
         * letting go of the mouse. Pencil and eraser draw straight to the
         * artwork, so for them the preview is empty and there is nothing to
         * copy at all. Falls back to the whole surface if the region is
         * unknown. */
        stampTempCanvas() {
            const r = this.currentDirtyRect('temp');
            if (r === null) {
                this.ctx.drawImage(this.ui.cTemp, 0, 0);
                return;
            }
            if (r.x1 < r.x0 || r.y1 < r.y0) return;   // nothing was drawn on it
            const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
            this.ctx.drawImage(this.ui.cTemp, r.x0, r.y0, w, h, r.x0, r.y0, w, h);
        }

        /* Wipe the preview canvas. Only the part holding something is cleared:
         * on a 13000x13000 document clearing all of it costs about 100 ms, and
         * a stroke covers a tiny fraction of that. Falls back to the whole
         * surface whenever the tracked region is unknown. */
        clearTempCanvas() {
            const r = this.currentDirtyRect('temp');
            if (r === null) {
                this.ctxTemp.clearRect(0, 0, this.config.width, this.config.height);
            } else if (r.x1 >= r.x0 && r.y1 >= r.y0) {
                this.ctxTemp.clearRect(r.x0, r.y0, r.x1 - r.x0 + 1, r.y1 - r.y0 + 1);
            }
            this.markCleanDirty('temp');
        }

        /* Two surfaces are tracked separately: 'main' is the artwork, which is
         * what history captures, and 'temp' is the preview a stroke is drawn on
         * before being stamped down. Knowing the preview's extent is what keeps
         * that stamp from claiming the whole canvas. */
        _region(key) {
            if (!this._dirtyRegions) this._dirtyRegions = {};
            let r = this._dirtyRegions[key || 'main'];
            if (!r) r = this._dirtyRegions[key || 'main'] = { rect: null, known: false };
            return r;
        }
        markAllDirty(key) {
            const r = this._region(key);
            r.rect = null;               // null means "unknown — read it all"
            r.known = false;
            if (!key || key === 'main') { this._dirtyRect = null; this._dirtyKnown = false; }
        }
        markCleanDirty(key) {
            const r = this._region(key);
            r.rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
            r.known = true;
            if (!key || key === 'main') { this._dirtyRect = r.rect; this._dirtyKnown = true; }
        }
        markDirtyRect(x0, y0, x1, y1, key) {
            const reg = this._region(key);
            if (!reg.known) return;                    // already unknown; stays that way
            if (!(isFinite(x0) && isFinite(y0) && isFinite(x1) && isFinite(y1))) {
                this.markAllDirty(key);
                return;
            }
            const r = reg.rect;
            if (x0 < r.x0) r.x0 = x0;
            if (y0 < r.y0) r.y0 = y0;
            if (x1 > r.x1) r.x1 = x1;
            if (y1 > r.y1) r.y1 = y1;
        }
        /* The rectangle to capture, clamped to the canvas, or null for all of
         * it. An empty region means nothing was drawn since the last step. */
        currentDirtyRect(key) {
            const reg = this._region(key);
            if (!reg.known || !reg.rect) return null;
            const r = reg.rect;
            if (r.x1 < r.x0 || r.y1 < r.y0) return { x0: 0, y0: 0, x1: -1, y1: -1 };
            return {
                x0: Math.max(0, Math.floor(r.x0)),
                y0: Math.max(0, Math.floor(r.y0)),
                x1: Math.min(this.config.width  - 1, Math.ceil(r.x1)),
                y1: Math.min(this.config.height - 1, Math.ceil(r.y1))
            };
        }

        /* Wrap a 2D context so every drawing call reports the area it affects.
         * The wrapper follows the transform itself, so a rotated or scaled
         * brush stamp still reports where it actually landed. */
        trackCtx(ctx, key) {
            if (!ctx || ctx.__tracked) return ctx;
            const app = this;
            const K = key || 'main';
            // Current transform, plus a stack for save()/restore().
            let m = [1, 0, 0, 1, 0, 0];
            const stack = [];
            const mul = (n) => [
                n[0] * m[0] + n[1] * m[2],       n[0] * m[1] + n[1] * m[3],
                n[2] * m[0] + n[3] * m[2],       n[2] * m[1] + n[3] * m[3],
                n[4] * m[0] + n[5] * m[2] + m[4], n[4] * m[1] + n[5] * m[3] + m[5]
            ];
            // Map a user-space rect through the transform and report its bounds.
            const emit = (x, y, w, h, pad) => {
                if (!(isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h))) {
                    app.markAllDirty(K); return;
                }
                const px = [x, x + w, x, x + w], py = [y, y, y + h, y + h];
                let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                for (let i = 0; i < 4; i++) {
                    const tx = px[i] * m[0] + py[i] * m[2] + m[4];
                    const ty = px[i] * m[1] + py[i] * m[3] + m[5];
                    if (tx < x0) x0 = tx; if (tx > x1) x1 = tx;
                    if (ty < y0) y0 = ty; if (ty > y1) y1 = ty;
                }
                // Antialiasing, line width and rounding all bleed outwards.
                const g = (pad || 0) + 2;
                app.markDirtyRect(x0 - g, y0 - g, x1 + g, y1 + g, K);
            };
            // A blur or a filter paints outside the geometry it was given.
            const spreads = () => (ctx.shadowBlur > 0) ||
                (typeof ctx.filter === 'string' && ctx.filter !== 'none');
            const lw = () => (ctx.lineWidth || 1) / 2 + 1;

            // Everything that draws and whose extent we can work out.
            const geo = {
                fillRect:   (a) => emit(a[0], a[1], a[2], a[3], 0),
                clearRect:  (a) => {
                    // Wiping the whole preview leaves it empty, so its region
                    // resets rather than growing to cover the canvas. A partial
                    // clear still expands it, which over-reports and is safe.
                    if (K === 'temp' && a[0] <= 0 && a[1] <= 0 &&
                        a[2] >= app.config.width && a[3] >= app.config.height) {
                        app.markCleanDirty('temp');
                        return;
                    }
                    emit(a[0], a[1], a[2], a[3], 0);
                },
                strokeRect: (a) => emit(a[0], a[1], a[2], a[3], lw()),
                fillText:     () => app.markAllDirty(K),
                strokeText:   () => app.markAllDirty(K),
                putImageData: (a) => {
                    // putImageData ignores the transform entirely.
                    const img = a[0];
                    if (!img) { app.markAllDirty(K); return; }
                    app.markDirtyRect(a[1], a[2], a[1] + img.width, a[2] + img.height, K);
                },
                drawImage: (a) => {
                    const src = a[0];
                    const sw = (src && (src.width  || src.videoWidth))  || 0;
                    const sh = (src && (src.height || src.videoHeight)) || 0;
                    if (a.length >= 9)      emit(a[5], a[6], a[7], a[8], 0);
                    else if (a.length >= 5) emit(a[1], a[2], a[3], a[4], 0);
                    else                    emit(a[1], a[2], sw, sh, 0);
                }
            };
            // Path building: remember the extent of the points as they arrive.
            let pb = null;
            const pt = (x, y) => {
                if (!pb) pb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
                if (!(isFinite(x) && isFinite(y))) { pb = false; return; }
                if (pb === false) return;
                if (x < pb.x0) pb.x0 = x; if (x > pb.x1) pb.x1 = x;
                if (y < pb.y0) pb.y0 = y; if (y > pb.y1) pb.y1 = y;
            };
            const paintPath = (pad) => {
                if (!pb || pb === false) { app.markAllDirty(K); return; }
                emit(pb.x0, pb.y0, pb.x1 - pb.x0, pb.y1 - pb.y0, pad);
            };
            const path = {
                beginPath: () => { pb = null; },
                moveTo: (a) => pt(a[0], a[1]),
                lineTo: (a) => pt(a[0], a[1]),
                rect:   (a) => { pt(a[0], a[1]); pt(a[0] + a[2], a[1] + a[3]); },
                arc:    (a) => { pt(a[0] - a[2], a[1] - a[2]); pt(a[0] + a[2], a[1] + a[2]); },
                arcTo:  (a) => { pt(a[0], a[1]); pt(a[2], a[3]); },
                ellipse:(a) => { pt(a[0] - a[2], a[1] - a[3]); pt(a[0] + a[2], a[1] + a[3]); },
                quadraticCurveTo: (a) => { pt(a[0], a[1]); pt(a[2], a[3]); },
                bezierCurveTo:    (a) => { pt(a[0], a[1]); pt(a[2], a[3]); pt(a[4], a[5]); },
                closePath: () => {},
                fill:   () => paintPath(0),
                stroke: () => paintPath(lw()),
                clip:   () => {}
            };
            // Transform bookkeeping, and state that does not paint.
            const xform = {
                save:    () => { stack.push(m.slice()); },
                restore: () => { if (stack.length) m = stack.pop(); },
                translate: (a) => { m = mul([1, 0, 0, 1, a[0], a[1]]); },
                scale:     (a) => { m = mul([a[0], 0, 0, a[1], 0, 0]); },
                rotate:    (a) => { const c = Math.cos(a[0]), s = Math.sin(a[0]);
                                    m = mul([c, s, -s, c, 0, 0]); },
                transform: (a) => { m = mul(a); },
                setTransform: (a) => {
                    m = (a.length >= 6) ? a.slice(0, 6)
                      : (a[0] && typeof a[0].a === 'number'
                            ? [a[0].a, a[0].b, a[0].c, a[0].d, a[0].e, a[0].f]
                            : [1, 0, 0, 1, 0, 0]);
                },
                resetTransform: () => { m = [1, 0, 0, 1, 0, 0]; }
            };
            // Reads and pure state: no effect on the canvas.
            const inert = new Set([
                'getImageData', 'createImageData', 'measureText', 'getLineDash',
                'setLineDash', 'createLinearGradient', 'createRadialGradient',
                'createConicGradient', 'createPattern', 'isPointInPath',
                'isPointInStroke', 'getTransform', 'getContextAttributes'
            ]);

            const cache = new Map();
            return new Proxy(ctx, {
                get(target, prop) {
                    const v = target[prop];
                    if (prop === '__tracked') return true;
                    if (prop === '__raw') return target;
                    if (typeof v !== 'function') return v;
                    if (cache.has(prop)) return cache.get(prop);
                    const handler = geo[prop] || path[prop] || xform[prop];
                    const fn = (...args) => {
                        if (handler) {
                            // A shadow or filter paints beyond the geometry, so
                            // the computed rectangle would be too small.
                            if ((geo[prop] || path[prop]) && spreads()) app.markAllDirty(K);
                            else handler(args);
                        } else if (!inert.has(prop)) {
                            // Something that draws in a way this wrapper does
                            // not model. Assume the worst; correctness first.
                            app.markAllDirty(K);
                        }
                        return v.apply(target, args);
                    };
                    cache.set(prop, fn);
                    return fn;
                },
                set(target, prop, value) { target[prop] = value; return true; }
            });
        }

        /* A tiled entry stores only the tiles that step CHANGED, plus a link to
         * the step before it. Resolving walks back to the nearest anchor — an
         * entry holding a full grid — and replays forward so newer tiles win.
         *
         * Before this, every entry carried a slot for every tile in the
         * document whether or not anything had happened to it: ~10,000 slots,
         * about 81 KB, on a 13000px canvas, paid per step even for a single dab.
         */
        async getBitmap(source) {
            if (!window.createImageBitmap) return null;
            try {
                return await createImageBitmap(source);
            } catch {
                return null;
            }
        }
        // ── Wand step-by-step undo/redo helpers ─────────────────────────────────
        // Dismiss a wand selection without committing its pixel content to the
        // canvas.  Called during undo() so the canvas snapshot stored in the
        // history entry remains the single source of truth for pixel data.
        saveState() {
            // An outstanding record describes the canvas as it was BEFORE
            // whatever is being recorded now, so it has to go in first. Safe
            // against recursion: flushDeferredSave clears its flag before it
            // calls back in here.
            this.flushDeferredSave();
            // Fold the canvas into the index map BEFORE the snapshot is taken:
            // snapping can move pixels, and the entry has to record the pixels
            // that the map describes, or undo would restore the two out of step.
            this.commitProjectIndices();
            // Truncate forward history and release the discarded entries. Refs
            // always point backwards, so nothing kept can reference a dropped
            // entry — but go through the ref-aware path anyway so this stays
            // correct if that ever changes.
            if (this.state.step < this.state.history.length - 1) {
                const dropped = this.state.history.splice(this.state.step + 1);
                this._releaseHistoryEntries(dropped, this.state.history);
            }
            if (this.tileHistory.enabled) {
                const prevEntry = this.state.history[this.state.step];
                // Only build on the previous step when it describes the same
                // grid; a resize or a different tile size has to start fresh.
                const canChain = !!(prevEntry && prevEntry.tiles &&
                    prevEntry.width === this.ui.cMain.width &&
                    prevEntry.height === this.ui.cMain.height &&
                    prevEntry.tileSize === this.tileHistory.tileSize);
                const chainLen = canChain ? (prevEntry._chain || 0) + 1 : 0;
                // Anchor periodically so a restore never walks back further
                // than this many steps. The anchor is built by flattening the
                // chain in memory afterwards, NOT by re-reading the canvas —
                // otherwise every 20th stroke would pay the old full price.
                const needAnchor = !canChain || chainLen >= this.tileHistory.anchorInterval;
                const prevMap = canChain ? this._resolveTiles(prevEntry) : null;
                // Only meaningful when building on a previous step: with nothing
                // to fall back on, everything has to be read.
                const dirty = canChain ? this.currentDirtyRect() : null;
                const tiles = this.captureTiledSnapshot(
                    this.ui.cMain, prevMap, !canChain, dirty);
                const entry = {
                    tiles: tiles.tiles, width: tiles.width, height: tiles.height,
                    tileSize: tiles.tileSize,
                    base: canChain ? prevEntry : null,
                    _chain: canChain ? chainLen : 0,
                    _bytes: tiles.ownedBytes
                };
                if (needAnchor && canChain) this._anchorEntry(entry);
                this.state.history.push(entry);
                // The canvas and this step now agree; start accumulating afresh.
                this.markCleanDirty();
                this.state.step++;
                this.enforceHistoryLimit();
                this.state.isDirty = true;
                this.deferColorCounts();
                this.updateTitleBarActions();
            } else {
                const w = this.config.width, h = this.config.height;
                // Eagerly push a canvas snapshot so undo is never blocked on the async path.
                // Use OffscreenCanvas + transferToImageBitmap for zero-copy GPU handles.
                let entry;
                if (window.OffscreenCanvas && window.ImageBitmap) {
                    const oc = new OffscreenCanvas(w, h);
                    const octx = oc.getContext('2d');
                    this.disableSmoothing(octx);
                    octx.drawImage(this.ui.cMain, 0, 0);
                    const bmp = oc.transferToImageBitmap();
                    entry = { bitmap: bmp, width: w, height: h };
                } else {
                    const snap = document.createElement('canvas');
                    snap.width = w; snap.height = h;
                    const sctx = snap.getContext('2d');
                    this.disableSmoothing(sctx);
                    sctx.drawImage(this.ui.cMain, 0, 0);
                    entry = { canvas: snap, width: w, height: h };
                    if (window.createImageBitmap) {
                        createImageBitmap(snap).then(bmp => {
                            if (this.state.history.includes(entry)) {
                                entry.bitmap = bmp;
                                if (entry.canvas) { entry.canvas.width = 0; entry.canvas.height = 0; }
                                entry.canvas = null;
                            } else {
                                bmp.close();
                            }
                        }).catch(() => {});
                    }
                }
                this.state.history.push(entry);
                this.state.step++;
                this.enforceHistoryLimit();
                this.state.isDirty = true;
                this.deferColorCounts();
                this.updateTitleBarActions();
            }
            // The slots this step describes travel with it, so undo puts the index
            // map back as well as the pixels.
            this.attachProjectStep(this.state.history[this.state.step]);
            // Attach a wand-selection snapshot to the current history entry so that
            // step-by-step undo/redo can restore the exact selection state after each
            // individual Magic Wand click rather than clearing the whole selection at once.
            const _wandEntry = this.state.history[this.state.step];
            if (_wandEntry && this.state.selection && this.state.selection.source === 'wand') {
                const _ws = this.state.selection;
                const _wsc = document.createElement('canvas');
                _wsc.width = _ws.canvas.width; _wsc.height = _ws.canvas.height;
                _wsc.getContext('2d').drawImage(_ws.canvas, 0, 0);
                const _wsm = document.createElement('canvas');
                _wsm.width = _ws.mask.width; _wsm.height = _ws.mask.height;
                _wsm.getContext('2d').drawImage(_ws.mask, 0, 0);
                _wandEntry.wandSelSnap = { x: _ws.x, y: _ws.y, w: _ws.w, h: _ws.h, canvas: _wsc, mask: _wsm };
            }
            // Free the brush engine's full-canvas offscreen buffers (flow/scratch/bg) once a
            // committed state no longer needs them. They are recreated lazily on the next
            // stroke. Skipped while a stroke is mid-flight (isDrawing) to avoid yanking a
            // buffer out from under an active dab paint.
            if (!this.state.isDrawing && this.brush && typeof this.brush.releaseOffscreenBuffers === 'function') {
                this.brush.releaseOffscreenBuffers();
            }
        }
        // Collapse history down to a single entry describing the current canvas,
        // so the document has nothing to undo. For setup work that legitimately
        // paints the canvas before the user has touched it (restoring tile mode
        // at boot, adopting a document that reused another's history array).
        _promptName(title, cb) {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);z-index:99999;';
            const box = document.createElement('div');
            box.className = 'modal';
            box.style.cssText = 'background:var(--bg,#1e1e1e);color:var(--fg,#eee);padding:16px;border-radius:8px;min-width:260px;box-shadow:0 4px 24px rgba(0,0,0,0.4);';
            const label = document.createElement('div');
            label.textContent = title;
            label.style.cssText = 'margin-bottom:8px;font-weight:600;';
            const input = document.createElement('input');
            input.type = 'text';
            input.style.cssText = 'width:100%;box-sizing:border-box;padding:6px;margin-bottom:12px;';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            const cancel = document.createElement('button');
            cancel.textContent = 'Cancel';
            const ok = document.createElement('button');
            ok.textContent = 'OK';
            ok.style.cssText = 'font-weight:600;';
            row.appendChild(cancel);
            row.appendChild(ok);
            box.appendChild(label);
            box.appendChild(input);
            box.appendChild(row);
            overlay.appendChild(box);
            document.body.appendChild(overlay);
            input.focus();
            const onKey = (e) => { if (e.key === 'Escape') { close(); } else if (e.key === 'Enter') { done(); } };
            const close = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); document.removeEventListener('keydown', onKey); };
            const done = () => { const v = input.value.trim(); if (!v) { showToast('Please enter a name.', 'warning'); input.focus(); return; } close(); cb(v); };
            ok.addEventListener('click', done);
            cancel.addEventListener('click', () => { close(); });
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
            document.addEventListener('keydown', onKey);
        }
        _enterPopupMode(id) {
            this._inPopup = true;
            ['title-bar','huesat-split-handle','ribbon','viewport','status-bar'].forEach(eid => {
                const el = document.getElementById(eid);
                if (el) el.style.display = 'none';
            });
            document.querySelectorAll('.tab-row').forEach(el => el.style.display = 'none');
            this.openModal(id);
        }
        safeHttpUrl(url) {
            const raw = String(url || '').trim();
            if (!raw) return '';
            try {
                const u = new URL(raw, window.location.href);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
                return u.toString();
            } catch (e) {
                return '';
            }
        }
        renderUpdateNotesMarkdown(md) {
            // Minimal, safe Markdown -> HTML for GitHub release notes.
            // Escape all content first, then emit only a small allowlist of tags.
            const input = String(md || '').replace(/\r\n?/g, '\n');
            if (!input.trim()) return '<div class="empty">Release notes will appear here.</div>';

            const lines = input.split('\n');
            const out = [];
            let inCode = false;
            let codeBuf = [];
            let listType = null; // 'ul' | 'ol'
            let para = [];

            const flushPara = () => {
                if (!para.length) return;
                out.push(`<p>${para.join('<br>')}</p>`);
                para = [];
            };
            const closeList = () => {
                if (!listType) return;
                out.push(listType === 'ol' ? '</ol>' : '</ul>');
                listType = null;
            };
            const inline = (text) => {
                // Security: escape the ENTIRE input first so no raw HTML can survive.
                // Then re-apply only our known-safe markdown patterns on the escaped text.
                // Markdown patterns match on unescaped chars ([, ], *, `) which are not
                // altered by escapeHtml, so the patterns work correctly after escaping.
                let t = this.escapeHtml(text);
                // Links: [text](url)  — label/url were already escaped above
                t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
                    const safe = this.safeHttpUrl(url);
                    if (!safe) return label; // label already escaped
                    return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`;
                });
                // Inline code: `code`
                t = t.replace(/`([^`]+)`/g, (m, code) => `<code>${code}</code>`);
                // Bold: **text**
                t = t.replace(/\*\*([^*]+)\*\*/g, (m, b) => `<strong>${b}</strong>`);
                // Italic: *text* (keep simple; avoids most bold conflicts)
                t = t.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, (m, a, i, b) => `${a}<em>${i}</em>${b}`);
                return t;
            };

            for (const rawLine of lines) {
                const line = rawLine || '';
                const trimmed = line.trimEnd();

                if (trimmed.startsWith('```')) {
                    if (!inCode) {
                        flushPara();
                        closeList();
                        inCode = true;
                        codeBuf = [];
                    } else {
                        inCode = false;
                        const code = this.escapeHtml(codeBuf.join('\n'));
                        out.push(`<pre><code>${code}</code></pre>`);
                        codeBuf = [];
                    }
                    continue;
                }
                if (inCode) {
                    codeBuf.push(line);
                    continue;
                }

                if (!trimmed.trim()) {
                    flushPara();
                    closeList();
                    continue;
                }

                const heading = trimmed.match(/^(#{1,4})\\s+(.+)$/);
                if (heading) {
                    flushPara();
                    closeList();
                    const level = heading[1].length; // 1..4
                    const tag = level === 1 ? 'h1' : level === 2 ? 'h2' : level === 3 ? 'h3' : 'h4';
                    out.push(`<${tag}>${inline(heading[2])}</${tag}>`);
                    continue;
                }

                const ol = trimmed.match(/^(\\d+)\\.\\s+(.+)$/);
                const ul = trimmed.match(/^[-*+]\\s+(.+)$/);
                if (ol || ul) {
                    flushPara();
                    const want = ol ? 'ol' : 'ul';
                    if (listType !== want) {
                        closeList();
                        listType = want;
                        out.push(want === 'ol' ? '<ol>' : '<ul>');
                    }
                    out.push(`<li>${inline((ol ? ol[2] : ul[1]) || '')}</li>`);
                    continue;
                }

                para.push(inline(trimmed));
            }

            flushPara();
            closeList();
            if (inCode && codeBuf.length) {
                const code = this.escapeHtml(codeBuf.join('\n'));
                out.push(`<pre><code>${code}</code></pre>`);
            }

            return out.join('');
        }
        async applyProps() {
            const w = parseInt(document.getElementById('pr-w').value, 10);
            const h = parseInt(document.getElementById('pr-h').value, 10);
            if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 65535 || h > 65535) {
                showToast('Please enter valid width and height values between 1 and 65535.', 'warning');
                return;
            }
            const bitmap = await this.getBitmap(this.ui.cMain);
            let t = null;
            if (!bitmap) {
                t = document.createElement('canvas');
                t.width = this.config.width;
                t.height = this.config.height;
                const tCtx = t.getContext('2d');
                this.disableSmoothing(tCtx);
                tCtx.drawImage(this.ui.cMain, 0, 0);
            }
            this.setSize(w, h);
            this.ctx.fillStyle = 'white';
            this.ctx.fillRect(0, 0, w, h);
            this.disableSmoothing(this.ctx);
            if (bitmap) {
                this.ctx.drawImage(bitmap, 0, 0);
                if (bitmap.close) bitmap.close();
            } else {
                this.ctx.drawImage(t, 0, 0);
            }
            this.saveState();
            this.closeModals();
        }
        detectAssetTypes(w, h) {
            let options = [];
            if (w === 64 && h === 64) {
                options.push({ val: 'front', label: 'Front Sprite (64x64)' });
                options.push({ val: 'back', label: 'Back Sprite (64x64)' });
            } else if (w === 128 && h === 64) {
                options.push({ val: 'front-back', label: 'Front & Back (Auto-split 128x64)' });
            } else if (w === 64 && h === 128) {
                options.push({ val: 'anim_front', label: 'Anim Front Sheet (64x128)' });
            } else if (w === 16 && h === 16) {
                options.push({ val: 'footprint', label: 'Footprint (16x16)' });
            } else if (w === 32 && h === 32) {
                options.push({ val: 'icon', label: 'Icon (32x32)' });
            }
            // Always offer a generic fallback
            options.push({ val: 'custom', label: `Custom Image (${w}x${h})` });
            return options;
        }
        autoDetectBackground(mode) {
            const pal = this.state.exportPalette;
            const h = this.config.height;
            const ctx = this.ui.cMain.getContext('2d');
            let px = 0, py = 0;
            if (mode === 'bl') py = h - 1;
            const pixel = ctx.getImageData(px, py, 1, 1).data;
            const r = pixel[0], g = pixel[1], b = pixel[2];

            const existingIdx = pal.findIndex(c => Math.abs(c.r - r) < 2 && Math.abs(c.g - g) < 2 && Math.abs(c.b - b) < 2);

            if (existingIdx > 0) {
                const temp = pal[0];
                pal[0] = pal[existingIdx];
                pal[existingIdx] = temp;
                this.renderExportPaletteUI();
                this.updateExportPreview();
            } else if (existingIdx === 0) {
                this.updateExportPreview();
            }
        }
        transparentIndexFromTrns(trns) {
            if (!trns) return -1;
            for (let i = 0; i < trns.length; i++) if (trns[i] === 0) return i;
            return -1;
        }
        get spriteIndices() { return this.state ? this.state.projectIndices : null; }
        set spriteIndices(v) { if (this.state) this.state.projectIndices = v; }

        /* Where a project asset's pixels actually are.
           Single-layer editing draws straight onto cMain, so `ctx` is the surface
           and can be written back to. With layers active `ctx` is the *active
           layer* while the file gets the composite, so read cMain instead — and
           don't snap it, because the layers underneath still hold the unsnapped
           pixels and would paint them straight back on the next composite. */
        planFitToTarget(colorCount, docIn) {
            const doc = docIn || this.projectDocValue();
            if (!doc || !this.state.projectFile) return null;
            const profile = this.inferProfile(this.state.projectFile);
            const steps = [];

            const sizes = profile.allowedResolutions;
            if (sizes && !sizes.some(r => r[0] === doc.w && r[1] === doc.h)) {
                // The nearest allowed box by area, so a 64×72 goes to 64×64 rather
                // than to whatever happens to be first in the list.
                const target = sizes.slice().sort((a, b) =>
                    Math.abs(a[0] * a[1] - doc.w * doc.h) - Math.abs(b[0] * b[1] - doc.w * doc.h))[0];
                const loses = target[0] < doc.w || target[1] < doc.h;
                steps.push({
                    id: 'size', target,
                    label: `Resize to ${target[0]}×${target[1]}`,
                    detail: loses
                        ? `crops ${doc.w}×${doc.h} — artwork outside the box is lost`
                        : `pads ${doc.w}×${doc.h} with transparency, bottom-anchored`,
                    destructive: loses
                });
            } else if (profile.tileAligned && (doc.w % 8 || doc.h % 8)) {
                const target = [Math.ceil(doc.w / 8) * 8, Math.ceil(doc.h / 8) * 8];
                steps.push({
                    id: 'size', target,
                    label: `Pad to ${target[0]}×${target[1]}`,
                    detail: 'tilesets are cut into 8×8 tiles; a partial tile will not build',
                    destructive: false
                });
            }

            const max = this.maxColorsForProfile(profile);
            const used = Number.isFinite(colorCount) ? colorCount : doc.colors.length;
            if (doc.colors.length > max) {
                steps.push({
                    id: 'colors', target: max,
                    label: `Reduce to ${max} colours`,
                    detail: `${doc.colors.length} in the palette; the least-used merge into their nearest neighbour`,
                    destructive: true
                });
            }

            if (doc.transparentIdx >= 0) {
                let clear = 0;
                for (let q = 0; q < doc.map.length; q++) if (doc.map[q] === doc.transparentIdx) clear++;
                if (!clear) {
                    steps.push({
                        id: 'slot0', target: doc.transparentIdx,
                        label: `Clear slot ${doc.transparentIdx}`,
                        detail: 'the background is opaque; the border colour becomes transparency',
                        destructive: false
                    });
                }
            }
            return { profile, doc, steps, used, max };
        }

        /* Apply one fix to a document value and hand back a new one. */
        fitStepApply(doc, step) {
            if (step.id === 'slot0') return this._fitClearSlot0(doc);
            if (step.id === 'colors') return this._fitReduceColors(doc, step.target);
            if (step.id === 'size') return this._fitResize(doc, step.target[0], step.target[1]);
            return doc;
        }

        /* Send the background to the transparency slot. Flood-fills inwards from
           the edges through whichever slot the border is mostly made of, so a
           colour that also appears INSIDE the sprite is not hollowed out with it. */
        _fitClearSlot0(doc) {
            const t = doc.transparentIdx;
            if (t < 0) return doc;
            const { w, h, map } = doc;
            const tally = new Map();
            const note = (q) => tally.set(map[q], (tally.get(map[q]) || 0) + 1);
            for (let x = 0; x < w; x++) { note(x); if (h > 1) note((h - 1) * w + x); }
            for (let y = 1; y < h - 1; y++) { note(y * w); if (w > 1) note(y * w + w - 1); }
            let bg = -1, best = 0;
            for (const [slot, n] of tally) if (n > best) { best = n; bg = slot; }
            if (bg < 0 || bg === t) return doc;

            const out = new Uint8Array(map);
            const seen = new Uint8Array(w * h);
            const stack = [];
            for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
            for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }
            while (stack.length) {
                const q = stack.pop();
                if (q < 0 || q >= w * h || seen[q] || map[q] !== bg) continue;
                seen[q] = 1;
                out[q] = t;
                const x = q % w;
                if (x > 0) stack.push(q - 1);
                if (x < w - 1) stack.push(q + 1);
                if (q >= w) stack.push(q - w);
                if (q < w * (h - 1)) stack.push(q + w);
            }
            return { ...doc, map: out };
        }

        /* Merge the least-used slots into their nearest surviving neighbour until
           the palette fits. Least-used first because that is the smallest number of
           pixels that have to change colour; the transparency slot never merges. */
        _fitReduceColors(doc, budget) {
            if (doc.colors.length <= budget) return doc;
            const counts = new Array(doc.colors.length).fill(0);
            for (let q = 0; q < doc.map.length; q++) counts[doc.map[q]]++;

            const keep = doc.colors.map((_, i) => i)
                .sort((a, b) => (counts[b] - counts[a]) || (a - b))
                .slice(0, budget);
            if (doc.transparentIdx >= 0 && !keep.includes(doc.transparentIdx)) {
                keep[keep.length - 1] = doc.transparentIdx;
            }
            keep.sort((a, b) => a - b);

            const table = new Array(doc.colors.length);
            keep.forEach((from, to) => { table[from] = to; });
            for (let i = 0; i < doc.colors.length; i++) {
                if (table[i] !== undefined) continue;
                const c = doc.colors[i];
                let bestTo = 0, bestDist = Infinity;
                keep.forEach((k, to) => {
                    const o = doc.colors[k];
                    const d = (c.r - o.r) ** 2 + (c.g - o.g) ** 2 + (c.b - o.b) ** 2;
                    if (d < bestDist) { bestDist = d; bestTo = to; }
                });
                table[i] = bestTo;
            }
            const out = new Uint8Array(doc.map.length);
            for (let q = 0; q < doc.map.length; q++) out[q] = table[doc.map[q]];
            return {
                ...doc,
                map: out,
                colors: keep.map(i => doc.colors[i]),
                transparentIdx: doc.transparentIdx >= 0 ? table[doc.transparentIdx] : -1
            };
        }

        /* Pad or crop to an exact box. Horizontally centred and bottom-anchored,
           because a Gen 3 sprite's y_offset is measured up from the bottom edge —
           top-anchoring would move the sprite in game even though the file is the
           right size. Padding is the transparency slot where there is one. */
        docFromImageData(data, w, h) {
            const counts = new Map();
            for (let p = 0; p < data.length; p += 4) {
                if (data[p + 3] < 128) continue;
                const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
                counts.set(key, (counts.get(key) || 0) + 1);
            }
            const colors = [{ r: 0, g: 0, b: 0, a: 0 }];
            const slotOf = new Map();
            Array.from(counts.entries())
                .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
                .slice(0, 255)
                .forEach(([key]) => {
                    slotOf.set(key, colors.length);
                    colors.push({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255, a: 255 });
                });

            const map = new Uint8Array(w * h);
            for (let p = 0, q = 0; q < map.length; p += 4, q++) {
                if (data[p + 3] < 128) continue;   // already 0
                const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
                const hit = slotOf.get(key);
                if (hit !== undefined) { map[q] = hit; continue; }
                // Past the 255 that fit. Nearest surviving colour, memoised on the
                // way out — a photograph repeats its colours millions of times.
                let best = 1, bestDist = Infinity;
                for (let i = 1; i < colors.length; i++) {
                    const c = colors[i];
                    const dr = data[p] - c.r, dg = data[p + 1] - c.g, db = data[p + 2] - c.b;
                    const d = dr * dr + dg * dg + db * db;
                    if (d < bestDist) { bestDist = d; best = i; }
                }
                slotOf.set(key, best);
                map[q] = best;
            }
            return { w, h, map, colors, transparentIdx: 0 };
        }

        /* Drop outside art onto the slot that is open and it becomes that asset:
           sized to the slot's box, cut to its colour budget, background on slot 0.
           The destination is `state.projectFile` — the thing every decomp rule
           keys on — which is exactly what opening the file normally would throw
           away, and why a drop is not just another open while one is loaded. */
        applyFitToTarget(stepIds, colorCount, docIn) {
            const plan = this.planFitToTarget(colorCount, docIn);
            if (!plan) return null;
            const wanted = stepIds && stepIds.length
                ? plan.steps.filter(s => stepIds.includes(s.id))
                : plan.steps;
            // Nothing to fix is a reason to do nothing for the open document, but
            // an import still has to land — the pixels are the point of it.
            if (!wanted.length && !docIn) return null;
            // Order matters: clearing the background first drops a colour, which can
            // make the palette fit without merging anything; padding last, so the
            // pixels it adds are already on the final transparency slot.
            const order = { slot0: 0, colors: 1, size: 2 };
            const sorted = wanted.slice().sort((a, b) => order[a.id] - order[b.id]);
            let doc = plan.doc;
            for (const step of sorted) doc = this.fitStepApply(doc, step);
            this.applyProjectDoc(doc);
            showToast(sorted.length
                ? 'Fitted to ' + plan.profile.label.toLowerCase()
                : 'Imported', 'info');
            return { applied: sorted.map(s => s.id), doc };
        }

        /* Redraw whatever is showing the frames — the ghost over the canvas and the
           strip's thumbnails. Cheap and idempotent: both bail immediately when the
           open asset has no frames, which is most of them. */
        joinPath(base, name) {
            const left = String(base || '');
            const right = String(name || '');
            if (!left) return right;
            const sep = left.includes('\\') ? '\\' : '/';
            if (left.endsWith('\\') || left.endsWith('/')) return `${left}${right}`;
            return `${left}${sep}${right}`;
        }
        toUint8Array(data) {
            if (data instanceof Uint8Array) return data;
            if (data instanceof ArrayBuffer) return new Uint8Array(data);
            if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
            return new TextEncoder().encode(String(data || ''));
        }
        getErrorText(error) {
            const raw = (error && error.message) || error;
            const text = String(raw || '').trim();
            return text || 'Unknown error';
        }
        getParentDirectory(path) {
            const raw = this.normalizeExportDirectoryPath(path);
            if (!raw) return '';
            const trimmed = raw.replace(/[\\/]+$/, '');
            const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
            if (idx < 0) return '';
            const parent = trimmed.slice(0, idx);
            if (/^[a-zA-Z]:$/.test(parent)) return `${parent}\\`;
            if (parent === '') return trimmed.startsWith('/') ? '/' : '';
            return parent;
        }
        revealInExplorer(dir) {
            const d = this.normalizeExportDirectoryPath(dir);
            if (!d) return;
            const invoke = this.getTauriInvokeFn();
            if (!invoke) return;
            Promise.resolve(invoke('plugin:opener|reveal_item_in_dir', { path: d })).catch(function () {});
        }
        transform(t,v) {
            if (this.state.selection) {
                const sel = this.state.selection;
                if (t === 'rotate') {
                    this.applySelectionRotation(this.getSelectionRotationDegrees(sel) + v);
                    this.renderSelection();
                    this.deferSelectionRenderFinalize(sel);
                    return;
                }
                const sw = sel.canvas.width;
                const sh = sel.canvas.height;
                const c = document.createElement('canvas');
                const x = c.getContext('2d');
                this.disableSmoothing(x);
                c.width = sw;
                c.height = sh;
                x.translate(v === 'h' ? sw : 0, v === 'v' ? sh : 0);
                x.scale(v === 'h' ? -1 : 1, v === 'v' ? -1 : 1);
                x.drawImage(sel.canvas, 0, 0);
                sel.canvas = c;
                sel.w = c.width;
                sel.h = c.height;
                sel._glTexDirty = true;
                if (sel.palette) sel._needsPaletteEnforce = true;
                sel._cache = null;
                // Clear _baseRect so selectionChangedFromBase() returns true — without this,
                // commitSelection() would see "no position change" and skip drawing when the
                // selection was deferred, silently dropping the flipped pixels.
                sel._baseRect = null;
                this.updateSelectionUI(sel.x, sel.y, sel.w, sel.h, this.getSelectionRotationDegrees(sel));
                this.renderSelectionFast();
                this.deferSelectionRenderFinalize(sel);
                return;
            }
            const w=this.config.width, h=this.config.height;
            if (t === 'rotate' || t === 'flip') {
                const outW = (t === 'rotate' && Math.abs(v) === 90) ? h : w;
                const outH = (t === 'rotate' && Math.abs(v) === 90) ? w : h;
                let tex = null;
                if (t === 'rotate' && v === 90) tex = [0,1, 0,0, 1,1, 1,0];
                else if (t === 'rotate' && v === -90) tex = [1,0, 1,1, 0,0, 0,1];
                else if (t === 'rotate' && Math.abs(v) === 180) tex = [1,1, 0,1, 1,0, 0,0];
                else if (t === 'flip' && v === 'h') tex = [1,0, 0,0, 1,1, 0,1];
                else if (t === 'flip' && v === 'v') tex = [0,1, 1,1, 0,0, 1,0];
                if (tex) {
                    const glOut = this.applyWebGLTransform(this.ui.cMain, outW, outH, tex);
                    if (glOut) {
                        this.setSize(outW, outH);
                        this.disableSmoothing(this.ctx);
                        this.ctx.clearRect(0, 0, this.config.width, this.config.height);
                        this.ctx.drawImage(glOut, 0, 0);
                        this.saveState();
                        return;
                    }
                }
            }
            const c=document.createElement('canvas'); const x=c.getContext('2d');
            this.disableSmoothing(x);
            if(t==='rotate' && Math.abs(v)===90) { c.width=h; c.height=w; } else { c.width=w; c.height=h; }

            if(t==='rotate') { x.translate(c.width/2, c.height/2); x.rotate(v*Math.PI/180); x.drawImage(this.ui.cMain, -w/2, -h/2); }

            else { x.translate(v==='h'?w:0, v==='v'?h:0); x.scale(v==='h'?-1:1, v==='v'?-1:1); x.drawImage(this.ui.cMain, 0, 0); }
            this.setSize(c.width, c.height); this.ctx.drawImage(c,0,0); this.saveState();
        }
        // Lazily create a Worker containing the scanline flood-fill algorithm.
        // The worker receives the pixel buffer via transfer (zero-copy), runs the
        // fill entirely off the main thread, then transfers the result back.
        _ensureFloodFillWorker() {
            if (this._floodFillWorkerFailed) return null;
            if (this._floodFillWorker) return this._floodFillWorker;
            const src = `
self.onmessage = function(e) {
    const { buffer, width, height, startX, startY, fillR, fillG, fillB,
            minX, maxX, minY, maxY } = e.data;
    const data = new Uint8ClampedArray(buffer);
    const startIdx = (startY * width + startX) * 4;
    const targetR = data[startIdx], targetG = data[startIdx+1];
    const targetB = data[startIdx+2], targetA = data[startIdx+3];
    if (targetR === fillR && targetG === fillG && targetB === fillB && targetA === 255) {
        self.postMessage({ buffer, changed: false }, [buffer]);
        return;
    }
    // If the target pixel is transparent, only match other fully transparent pixels
    const match = targetA === 0
        ? (idx) => data[idx+3] === 0
        : (idx) =>
            data[idx]===targetR && data[idx+1]===targetG &&
            data[idx+2]===targetB && data[idx+3]===targetA;
    const fill = (idx) => {
        data[idx]=fillR; data[idx+1]=fillG; data[idx+2]=fillB; data[idx+3]=255;
    };
    // Strict 4-connected scanline: seed forward row by scanning for matching
    // sub-spans, so diagonal-only pixels are never reached.
    function seedRow(y, xFrom, xTo, dy) {
        let i = xFrom;
        while (i <= xTo) {
            if (match((y * width + i) * 4)) {
                const s = i;
                while (i <= xTo && match((y * width + i) * 4)) i++;
                stack.push(y, s, i - 1, dy);
            } else { i++; }
        }
    }
    const stack = [];
    if (match(startIdx)) {
        stack.push(startY, startX, startX,  1);
        stack.push(startY, startX, startX, -1);
    }
    let si = 0;
    while (si < stack.length) {
        const y  = stack[si++], x1 = stack[si++],
              x2 = stack[si++], dy = stack[si++];
        if (y < minY || y > maxY) continue;
        let x = x1;
        while (x > minX && match((y * width + x - 1) * 4)) x--;
        let xr = x2;
        while (xr < maxX && match((y * width + xr + 1) * 4)) xr++;
        for (let i = x; i <= xr; i++) {
            const idx = (y * width + i) * 4;
            if (match(idx)) fill(idx);
        }
        const fy = y + dy;
        if (fy >= minY && fy <= maxY) seedRow(fy, x, xr, dy);
        const oy = y - dy;
        if (oy >= minY && oy <= maxY) {
            if (x  < x1) seedRow(oy, x,      x1 - 1, -dy);
            if (xr > x2) seedRow(oy, x2 + 1, xr,     -dy);
        }
    }
    self.postMessage({ buffer, changed: true }, [buffer]);
};`;
            const blob = new Blob([src], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const worker = new Worker(url);
            this._floodFillWorker = worker;
            const revokeUrl = () => {
                URL.revokeObjectURL(url);
                worker.removeEventListener('message', revokeUrl);
                worker.removeEventListener('error', revokeUrl);
            };
            worker.addEventListener('error', revokeUrl);
            worker.addEventListener('message', revokeUrl);
            return worker;
        }

        floodFill(startX, startY, targetColor) {
            const width = this.config.width;
            const height = this.config.height;
            let tileBounds = null;
            if (this.tileModeEnabled) {
                const size = Math.max(1, this.tileSize);
                const tiles = Math.max(3, this.tileGrid);
                const center = Math.floor(tiles / 2);
                const originX = center * size;
                const originY = center * size;
                const localX = this.getTileLocalCoord(startX, size);
                const localY = this.getTileLocalCoord(startY, size);
                startX = originX + localX;
                startY = originY + localY;
                tileBounds = { x: originX, y: originY, w: size, h: size };
            }
            startX = Math.floor(startX);
            startY = Math.floor(startY);

            const minX = tileBounds ? tileBounds.x : 0;
            const maxX = tileBounds ? tileBounds.x + tileBounds.w - 1 : width - 1;
            const minY = tileBounds ? tileBounds.y : 0;
            const maxY = tileBounds ? tileBounds.y + tileBounds.h - 1 : height - 1;

            // Fast path: single-color canvas — no-op if clicking the same color.
            if (this._lastKnownColorCount === 1) {
                const probe = this.ctx.getImageData(startX, startY, 1, 1).data;
                const sameColor = probe[0] === targetColor.r && probe[1] === targetColor.g
                               && probe[2] === targetColor.b && probe[3] === 255;
                if (sameColor) return;
            }

            const imageData = this.ctx.getImageData(0, 0, width, height);

            // Try to offload to a Worker for zero main-thread blocking.
            let worker = null;
            try { worker = this._ensureFloodFillWorker(); } catch (_) {}

            if (worker) {
                // Transfer the pixel buffer to the worker (zero-copy).
                const buffer = imageData.data.buffer.slice(0);
                this.beginOperation();
                worker.onmessage = (e) => {
                    this.endOperation();
                    if (!e.data.changed) return;
                    const filled = new ImageData(new Uint8ClampedArray(e.data.buffer), width, height);
                    this.ctx.putImageData(filled, 0, 0);
                    if (this.tileModeEnabled) this.replicateCenterTile();
                    this.saveState();
                };
                worker.onerror = () => {
                    this.endOperation();
                    // Worker failed — mark permanently so we never try again,
                    // then run the synchronous fill directly (avoids infinite recursion).
                    try { worker.terminate(); } catch (_) {}
                    this._floodFillWorker = null;
                    this._floodFillWorkerFailed = true;
                    this._floodFillSync(startX, startY, targetColor, imageData, minX, maxX, minY, maxY);
                };
                worker.postMessage({
                    buffer, width, height, startX, startY,
                    fillR: targetColor.r, fillG: targetColor.g, fillB: targetColor.b,
                    minX, maxX, minY, maxY
                }, [buffer]);
                return;
            }

            // Synchronous fallback (no Worker support).
            this._floodFillSync(startX, startY, targetColor, imageData, minX, maxX, minY, maxY);
        }

        // Synchronous scanline flood fill. Shared by the no-worker path and the
        // worker onerror fallback. Takes pre-read imageData so we don't double-read.
        _floodFillSync(startX, startY, targetColor, imageData, minX, maxX, minY, maxY) {
            const width  = this.config.width;
            const height = this.config.height;
            const data   = imageData.data;
            const startIdx = (startY * width + startX) * 4;
            const targetR = data[startIdx], targetG = data[startIdx+1];
            const targetB = data[startIdx+2], targetA = data[startIdx+3];
            if (targetR === targetColor.r && targetG === targetColor.g && targetB === targetColor.b && targetA === 255) return;
            // If the target pixel is transparent, only match other fully transparent pixels
            const match = targetA === 0
                ? (idx) => data[idx+3] === 0
                : (idx) =>
                    data[idx]===targetR && data[idx+1]===targetG &&
                    data[idx+2]===targetB && data[idx+3]===targetA;
            const fill = (idx) => {
                data[idx]=targetColor.r; data[idx+1]=targetColor.g;
                data[idx+2]=targetColor.b; data[idx+3]=255;
            };
            const seedRow = (y, xFrom, xTo, dy) => {
                let i = xFrom;
                while (i <= xTo) {
                    if (match((y * width + i) * 4)) {
                        const s = i;
                        while (i <= xTo && match((y * width + i) * 4)) i++;
                        stack.push(y, s, i - 1, dy);
                    } else { i++; }
                }
            };
            const stack = [];
            if (match(startIdx)) {
                stack.push(startY, startX, startX,  1);
                stack.push(startY, startX, startX, -1);
            }
            let si = 0;
            // Strict 4-connected scanline flood fill.
            while (si < stack.length) {
                const y  = stack[si++], x1 = stack[si++],
                      x2 = stack[si++], dy = stack[si++];
                if (y < minY || y > maxY) continue;
                let x = x1;
                while (x > minX && match((y * width + x - 1) * 4)) x--;
                let xr = x2;
                while (xr < maxX && match((y * width + xr + 1) * 4)) xr++;
                for (let i = x; i <= xr; i++) {
                    const idx = (y * width + i) * 4;
                    if (match(idx)) fill(idx);
                }
                const fy = y + dy;
                if (fy >= minY && fy <= maxY) seedRow(fy, x, xr, dy);
                const oy = y - dy;
                if (oy >= minY && oy <= maxY) {
                    if (x  < x1) seedRow(oy, x,      x1 - 1, -dy);
                    if (xr > x2) seedRow(oy, x2 + 1, xr,     -dy);
                }
            }
            this.ctx.putImageData(imageData, 0, 0);
            if (this.tileModeEnabled) this.replicateCenterTile();
            this.saveState();
        }
        invertColor() {
            const targetCtx = this.state.selection ? this.state.selection.canvas.getContext('2d') : this.ctx;
            const w = this.state.selection ? this.state.selection.canvas.width : this.config.width;
            const h = this.state.selection ? this.state.selection.canvas.height : this.config.height;
            let imgData;
            if (!this.state.selection) {
                const temp = document.createElement('canvas');
                temp.width = w; temp.height = h;
                const tctx = temp.getContext('2d');
                this.disableSmoothing(tctx);
                tctx.drawImage(this.ui.cMain, 0, 0);
                imgData = tctx.getImageData(0, 0, w, h);
                const d = imgData.data;
                for(let i=0; i<d.length; i+=4) {
                    d[i] = 255 - d[i];
                    d[i+1] = 255 - d[i+1];
                    d[i+2] = 255 - d[i+2];
                }
                tctx.putImageData(imgData, 0, 0);
                this.ctx.clearRect(0,0,w,h);
                this.ctx.drawImage(temp, 0, 0);
                this.saveState();
                if (this.bitDepth !== 24) {
                    this.applyCurrentModeToCanvas(this.ctx, w, h, false);
                }
                return;
            }
            imgData = targetCtx.getImageData(0, 0, w, h);
            const d = imgData.data;
            for(let i=0; i<d.length; i+=4) {
                d[i] = 255 - d[i];
                d[i+1] = 255 - d[i+1];
                d[i+2] = 255 - d[i+2];
            }
            targetCtx.putImageData(imgData, 0, 0);
            if(this.state.selection) {
                this.state.selection._forceOpaque = true;
                this.state.selection.palette = null;
                this.state.selection._needsPaletteEnforce = false;
                this.state.selection._glTexDirty = true;
                this.state.selection._cache = null;
                this.renderSelection();
                this.deferSelectionRenderFinalize(this.state.selection);
            } else {
                this.saveState();
            }
        }
        rgbToHsl(r, g, b) {
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            let h = 0;
            let s = 0;
            const l = (max + min) / 2;
            if (max !== min) {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                    case g: h = (b - r) / d + 2; break;
                    case b: h = (r - g) / d + 4; break;
                }
                h /= 6;
            }
            return { h, s, l };
        }
        hslToRgb(h, s, l) {
            if (s === 0) return { r: l, g: l, b: l };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            const hue2rgb = (t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };
            return { r: hue2rgb(h + 1/3), g: hue2rgb(h), b: hue2rgb(h - 1/3) };
        }

        createNewCanvas() {
            const w = parseInt(document.getElementById('new-w').value, 10);
            const h = parseInt(document.getElementById('new-h').value, 10);
            const depth = parseInt(document.getElementById('new-depth').value, 10);
            if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > 65535 || h > 65535) {
                showToast('Please enter valid width and height values between 1 and 65535.', 'warning');
                return;
            }
            // The layer stack is global. A new document starts with one layer —
            // without this the new tab opens holding the previous document's
            // layers, and because there is only one stack, adding a layer in one
            // tab appears in every other tab too.
            if (this.layerMgr && typeof this.layerMgr.collapseToBase === 'function') {
                this.layerMgr.collapseToBase({ fresh: true });
            }
            this.clearProjectAssetState();
            this.setSize(w, h);
            this.bitDepth = depth;
            const bg = document.getElementById('new-bg').value;
            if (bg === 'transparent' && depth > 8) {
                this.ctx.clearRect(0, 0, w, h);
            } else {
                if (bg === 'transparent') {
                    showToast('Transparent background is only available at 24bpp; using white.', 'info');
                }
                this.ctx.fillStyle = (bg === 'custom') ? document.getElementById('new-bg-color').value : '#ffffff';
                this.ctx.fillRect(0, 0, w, h);
            }
            this.palette = [];
            this.paletteLab = null;
            this.paletteLocked = false;
            this.state.fileHandle = null;
            this.state.filePath = null;
            this.state.fileName = 'untitled.png';
            // A brand-new document starts a brand-new history. Every other
            // document-replacing path (initializeBlankDocument, handleLoadedImage,
            // applyProjectImageBytes) does this; without it the new canvas
            // inherits the previous document's whole undo stack — and because
            // tabs capture state.history by reference, the old tab and the new
            // tab end up sharing a single undo stack.
            //
            // Detach only — do NOT release the old entries. By the time we get
            // here a tab record may already own this exact array, and closing
            // its bitmaps would leave that tab unable to draw itself.
            // Ownership is released by the tab system when a tab is closed.
            this.state.history = [];
            this.state.step = -1;
            this.saveState();
            this.state.hasDocument = true;
            this.state.resizePreviewActive = false;
            this.state.resizePreviewRect = null;
            this.state.resizePreviewGhost = null;
            this.requestGlobalOverlayUpdate();
            this.markClean();
            this.closeModals();
        }

        swapNewDimensions() {
            const w = document.getElementById('new-w');
            const h = document.getElementById('new-h');
            const t = w.value; w.value = h.value; h.value = t;
            document.getElementById('new-preset').value = 'custom';
        }

        onNewBgChange() {
            const bg = document.getElementById('new-bg').value;
            document.getElementById('new-bg-custom-group').style.display = (bg === 'custom') ? '' : 'none';
        }

        async readPalNodeText(node) {
            if (node && node.handle) {
                const file = node.handle instanceof File ? node.handle : (await node.handle.getFile());
                return await file.text();
            }
            if (node && node.path) {
                return await this.tauriInvoke('read_text_file', { path: this.normalizeIncomingPath(node.path) });
            }
            throw new Error('No palette source');
        }
        getTargetProfiles() {
            return {
                // 202 stock files, every one 64×64.
                'pokemon-front': { label: 'Pokémon front sprite', bitDepth: 4, palettes: ['Normal', 'Shiny'], strictResolution: true, allowedResolutions: [[64, 64]], wantsTransparency: true },
                // 1,211 stock files, every one 64×128 (two stacked 64×64 frames).
                'pokemon-anim-front': { label: 'Pokémon animated front sprite', bitDepth: 4, palettes: ['Normal', 'Shiny'], strictResolution: true, allowedResolutions: [[64, 128], [64, 64]], frames: { size: [64, 64] }, wantsTransparency: true },
                // 1,409 at 64×64 and one at 64×128 (deoxys, whose forms share a sheet).
                'pokemon-back': { label: 'Pokémon back sprite', bitDepth: 4, palettes: ['Normal', 'Shiny'], strictResolution: true, allowedResolutions: [[64, 64], [64, 128]], wantsTransparency: true },
                // 1,414 stock files, every one 32×64. Expansion writes these 8bpp
                // with a 16-entry palette; the depth is the target's, not the file's.
                'pokemon-icon': { label: 'Pokémon icon', bitDepth: 4, palettes: ['Icon palette'], strictResolution: true, allowedResolutions: [[32, 64], [32, 32]], frames: { size: [32, 32] }, wantsTransparency: true },
                // Form icons (deoxys' 128×64 speed icon) are not the standard slot.
                'pokemon-icon-variant': { label: 'Pokémon form icon', bitDepth: 4, palettes: ['Icon palette'], strictResolution: false, wantsTransparency: true },
                'pokemon-footprint': { label: 'Pokémon footprint', bitDepth: 1, maxColors: 2, palettes: [], strictResolution: true, allowedResolutions: [[16, 16]] },
                // 192×32 (1,039), 256×32 (57) and 384×64 (27) all occur. Frame width
                // is the sheet's height in the square cases, so no fixed box.
                'pokemon-overworld': { label: 'Pokémon overworld sprite', bitDepth: 4, palettes: ['Overworld normal', 'Overworld shiny'], strictResolution: false, frames: { axis: 'x', counts: [9, 6, 4, 3, 2] }, wantsTransparency: true },
                /* A palette stored as a picture: one row of pixels, one per slot.
                   pawmi/normal.png is 16×1, which is neither tile-aligned nor
                   artwork, and reading it as a sprite produced a build error for a
                   file that is not a sprite at all. */
                'palette-image': { label: 'Palette image', bitDepth: 4, palettes: [], strictResolution: false, tileAligned: false, notArtwork: true },
                'object-event': { label: 'Overworld object sprite', bitDepth: 4, palettes: [], strictResolution: false, frames: { axis: 'x', counts: [9, 6, 4, 3, 2] }, wantsTransparency: true },
                // 180 stock front pics, every one 64×64.
                'trainer-front': { label: 'Trainer front sprite', bitDepth: 4, palettes: [], strictResolution: true, allowedResolutions: [[64, 64]], wantsTransparency: true },
                // Back pics are animation sheets: 64×256 (8) and 64×320 (2).
                'trainer-back': { label: 'Trainer back sprite', bitDepth: 4, palettes: [], strictResolution: false, frames: { axis: 'y', size: [64, 64] }, wantsTransparency: true },
                // 619 stock icons, every one 24×24.
                'item-icon': { label: 'Item icon', bitDepth: 4, palettes: [], strictResolution: true, allowedResolutions: [[24, 24]], wantsTransparency: true },
                // 138 stock tile sheets, every one 128px wide.
                'tileset': { label: 'Tileset', bitDepth: 4, palettes: [], strictResolution: false, requiredWidth: 128, tileAligned: true },
                /* Tileset *animation* frames live under the tileset but are not the
                   sheet: 176 of them, in shapes from 16×16 to 64×48. Holding them to
                   the 128px sheet rule was 216 of the false alarms on a stock repo. */
                'tileset-anim': { label: 'Tileset animation frame', bitDepth: 4, palettes: [], strictResolution: false, tileAligned: true },
                /* `depthGuessed` means exactly that: nothing about the path says
                   what depth the slot is, and 4 is only the common case. 32 stock
                   assets are 8bpp and would be judged against 16 colours here. */
                'interface': { label: 'Interface graphic', bitDepth: 4, palettes: [], strictResolution: false, depthGuessed: true },
                'default': { label: 'Project asset', bitDepth: 4, palettes: [], strictResolution: false, depthGuessed: true }
            };
        }
        /* Path → profile. Deliberately anchored rather than substring-matched:
           `base === 'tiles'` used to claim the map_preview folder's own tiles.png
           for the tileset profile and then fail it for not being 128px wide. */
        inferProfile(sourcePath) {
            const profiles = this.getTargetProfiles();
            const low = (sourcePath || '').replace(/\\/g, '/').toLowerCase();
            const file = low.split('/').pop() || '';
            const base = file.replace(/\.[^.]+$/, '').replace(/_gba$/, '');

            /* Inside a tileset folder only `tiles.png` is the sheet. The animation
               frames sit beside it — sometimes under `anim/`, sometimes just as
               0.png, 1.png, 2.png — and they are 16×256 or 8×24 or whatever the
               animation needs. Keying on the folder alone held six of those to the
               sheet's 128px width. */
            if (low.includes('data/tilesets/') || low.includes('/tilesets/')) {
                return base === 'tiles' ? profiles['tileset'] : profiles['tileset-anim'];
            }
            /* Species folders nest: graphics/pokemon/<species>/ and, for alternate
               forms, graphics/pokemon/<species>/<form>/. Both end in the same set of
               file names, so matching on the name still works. */
            if (low.includes('graphics/pokemon/')) {
                if (base === 'footprint') return profiles['pokemon-footprint'];
                if (base === 'normal' || base === 'shiny') return profiles['palette-image'];
                if (base === 'icon') return profiles['pokemon-icon'];
                if (base.startsWith('icon')) return profiles['pokemon-icon-variant'];
                if (base.includes('overworld')) return profiles['pokemon-overworld'];
                if (base.startsWith('anim_front')) return profiles['pokemon-anim-front'];
                if (base.includes('back')) return profiles['pokemon-back'];
                if (base.includes('front')) return profiles['pokemon-front'];
                return profiles['default'];
            }
            if (low.includes('graphics/object_events/')) return profiles['object-event'];
            if (low.includes('graphics/trainers/')) {
                return low.includes('/back_pics/') ? profiles['trainer-back'] : profiles['trainer-front'];
            }
            if (low.includes('graphics/items/icons')) return profiles['item-icon'];
            if (low.includes('graphics/interface')) return profiles['interface'];
            return profiles['default'];
        }
        /* ── Frames ─────────────────────────────────────────────────────────
           Gen 3 animation is not a file format. A two-frame front sprite is one
           64×128 PNG holding two 64×64 pictures; a walking overworld sprite is
           one 144×32 PNG holding nine 16×32 ones. So a frame here is a rectangle
           of the canvas, not a separate document — which is also why every frame
           shares a palette by construction. There is one image and one index map
           underneath the lot, and 1.1's work applies to all of it unchanged. */

        // The GBA's real refresh, so "8 game frames" means what it means in game.
        static get GBA_HZ() { return 59.7275; }
        // Hold per frame, in game frames. The exact per-animation timing lives in
        // the decomp's anim tables (sMonIconAnims and friends), which nothing here
        // reads yet — this is the common walking/icon cadence, and it is adjustable.
        static get DEFAULT_FRAME_HOLD() { return 8; }

        setActiveFrame(index) {
            const layout = this.projectFrameLayout();
            if (!layout) return;
            const next = ((index % layout.count) + layout.count) % layout.count;
            if (next === this.state.activeFrame) return;
            this.state.activeFrame = next;
            // Which frame you are looking at is navigation, not an edit — it does
            // not touch a pixel, so it does not belong in the undo stack.
            this.updateFrameOverlays();
            if (this.onFramesChanged) this.onFramesChanged();
        }
        stepFrame(delta) { this.setActiveFrame(this.activeFrameIndex() + (delta || 1)); }

        toggleOnionSkin(on) {
            this.state.onionSkin = on === undefined ? !this.state.onionSkin : !!on;
            this.updateFrameOverlays();
            if (this.onFramesChanged) this.onFramesChanged();
        }

        /* Draw one frame into a target canvas at an integer scale, straight off the
           display surface — so it shows exactly what is on the canvas, palette edits
           and all, with no second rendering path to drift out of step. */
        maxColorsForProfile(profile) {
            if (profile && Number.isFinite(profile.maxColors)) return profile.maxColors;
            const depth = (profile && !profile.depthGuessed && profile.bitDepth)
                || this.state.projectBitDepth
                || (profile && profile.bitDepth) || 4;
            return 1 << depth;
        }
        findOffendingColors(paletteColors, d, tol) {
            const exact = new Map();
            for (let i = 0; i < paletteColors.length; i++) {
                const c = paletteColors[i];
                exact.set((c.r << 16) | (c.g << 8) | c.b, true);
            }
            const seen = new Map();
            const out = [];
            for (let p = 0; p < d.length; p += 4) {
                const a = d[p + 3];
                if (a < 128) continue;
                const r = d[p], g = d[p + 1], b = d[p + 2];
                const key = (r << 16) | (g << 8) | b;
                if (exact.has(key)) continue;
                if (seen.has(key)) continue;
                let best = Infinity;
                for (let i = 0; i < paletteColors.length; i++) {
                    const c = paletteColors[i];
                    const dr = r - c.r, dg = g - c.g, db = b - c.b;
                    const dist = (dr > dg ? dr : dg); const m = db > dist ? db : dist;
                    if (m < best) best = m;
                }
                seen.set(key, true);
                if (best > tol) {
                    out.push({ r, g, b });
                    if (out.length >= 6) break;
                }
            }
            return out;
        }
        toGbaChannel(v) {
            const five = Math.max(0, Math.min(255, Math.round(v))) >> 3;
            return Math.floor((five * 255) / 31);
        }
        serializeJascPal(colors) {
            let out = 'JASC-PAL\r\n0100\r\n' + colors.length + '\r\n';
            for (let i = 0; i < colors.length; i++) {
                const c = colors[i];
                out += this.toGbaChannel(c.r) + ' ' + this.toGbaChannel(c.g) + ' ' + this.toGbaChannel(c.b) + '\r\n';
            }
            return out;
        }
        _recolorPreview() {
            const id = this.state.previewPaletteId;
            if (!id) return;
            const target = this.getPaletteById(id);
            if (!target || !this.state.previewSnapshot) return;
            const w = this.config.width, h = this.config.height;
            const snap = this.state.previewSnapshot;
            const idx = (this.spriteIndices && this.spriteIndices.length === w * h)
                ? this.spriteIndices
                : this.quantizeToIndices(snap.data, w, h, this.basePalette || this.palette);
            const out = this.ctx.createImageData(w, h);
            const od = out.data, sd = snap.data, tcol = target.colors;
            for (let q = 0; q < w * h; q++) {
                const i = idx[q];
                const c = tcol[i] || tcol[0] || { r: 0, g: 0, b: 0 };
                const b4 = q * 4;
                od[b4] = c.r; od[b4 + 1] = c.g; od[b4 + 2] = c.b; od[b4 + 3] = sd[b4 + 3];
            }
            this.ctx.putImageData(out, 0, 0);
        }
        enterPreview(id) {
            if (this.state.previewPaletteId) return;
            const target = this.getPaletteById(id);
            if (!target) return;
            if (!this.state.previewSnapshot) {
                this.state.previewSnapshot = this.ctx.getImageData(0, 0, this.config.width, this.config.height);
            }
            this.state.previewPaletteId = id;
            this._recolorPreview();
            if (this.onPalettesChanged) this.onPalettesChanged();
        }
        exitPreview() {
            if (!this.state.previewPaletteId) return;
            if (this.state.previewSnapshot) this.ctx.putImageData(this.state.previewSnapshot, 0, 0);
            this.state.previewSnapshot = null;
            this.state.previewPaletteId = null;
            if (this.onPalettesChanged) this.onPalettesChanged();
        }
        static _freehandEasingMap = {
            linear: t => t,
            easeInQuad: t => t * t,
            easeOutQuad: t => t * (2 - t),
            easeInOutQuad: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
            easeInCubic: t => t * t * t,
            easeOutCubic: t => --t * t * t + 1,
            easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
            easeInQuart: t => t * t * t * t,
            easeOutQuart: t => 1 - --t * t * t * t,
            easeInOutQuart: t => t < 0.5 ? 8 * t * t * t * t : 1 - 8 * --t * t * t * t,
            easeInQuint: t => t * t * t * t * t,
            easeOutQuint: t => 1 + --t * t * t * t * t,
            easeInOutQuint: t => t < 0.5 ? 16 * t * t * t * t * t : 1 + 16 * --t * t * t * t * t,
            easeInSine: t => 1 - Math.cos((t * Math.PI) / 2),
            easeOutSine: t => Math.sin((t * Math.PI) / 2),
            easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
            easeInExpo: t => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
            easeOutExpo: t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
            easeInOutExpo: t => t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2
        };

        _getSmoothParams() {
            const fh = this.config.freehand || {};
            return {
                smoothing: fh.smoothing ?? 0.5,
                streamline: fh.streamline ?? 0.5,
                isStabilizer: false
            };
        }

        _isStabilizerActive() {
            return false;
        }

    }
