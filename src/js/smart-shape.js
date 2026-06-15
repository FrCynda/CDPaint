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