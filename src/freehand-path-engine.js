// ─── Freehand Path Engine v2 ────────────────────────────────────────────────
//
// Three-stage smoothing pipeline for high-quality freehand drawing:
//   1. Live draft preview  — rAF-scheduled raw lineTo (zero perceptual latency)
//   2. RDP simplification  — culls redundant collinear points
//   3. Centripetal CR fit  — converts survivors to smooth cubic Béziers
//                            • α = 0.5 eliminates cusps from uneven sampling rates
//                            • Corner detection preserves intentional sharp turns
//
// Rendering:
//   • Uniform width  → single batched Path2D stroke  (fast path)
//   • Variable width → pressure-driven filled polygon with rounded end-caps
//
// Changes from v1:
//   • catmullRomToBezier() upgraded from uniform to centripetal parameterization.
//     Uniform CR overshoots when drawing speed changes (pause → fast sweep → pause),
//     producing visible cusps or loops. Centripetal weights knot intervals by √chord
//     length, keeping the curve well-behaved regardless of input cadence.
//   • detectCorners() added — C0 joins at turns sharper than _cornerAngle (~72° default).
//     Passed into catmullRomToBezier() so tangents are zeroed at hard corners; the
//     user's intentional angle is preserved rather than smoothed away.
//   • _renderOutline() added — when minWidth ≠ lineWidth, the committed stroke is
//     rendered as a filled polygon whose half-width at each sample is linearly
//     interpolated from the stylus pressure of the two surrounding knot points.
//     Rounded end-caps are added via arcs at stroke start and end.
//   • Draft rendering is rAF-throttled: N pointermove events in one display frame
//     collapse to one clearRect + redraw instead of N redundant ones.
//   • _rawPoints capped at MAX_RAW_POINTS to prevent unbounded memory on very long
//     strokes (4000 pts × 3 px/pt ≈ 12 m at 96 dpi — never hit in practice).
//   • onPointerUp fixed: rdpSimplify was called twice (once in _finalize, once to
//     build the result object). Now called once; simplified points returned by _finalize.
//   • Uniform commit uses a single Path2D (one GPU draw call) instead of per-segment
//     beginPath/stroke, which flushed the pipeline for every Bézier segment.
//   • init() accepts minWidth, tension, cornerAngle, usePressure for fine-tuning.
//   • setPointerCapture(pointerId) should be called on pointerdown to ensure
//     pointerup fires even when the cursor leaves the canvas element.
//
const FreehandPathEngine = (() => {
 
    // ── Tunables ─────────────────────────────────────────────────────────
    const MIN_DISTANCE    = 3;           // px   — micro-movement filter threshold
    const RDP_TOLERANCE   = 1.5;         // px   — max allowable perpendicular deviation
    const MAX_RAW_POINTS  = 4000;        // hard cap on raw point buffer length
    const ALPHA           = 0.5;         // CR knot exponent: 0=uniform, 0.5=centripetal, 1=chordal
    const OUTLINE_SAMPLES = 10;          // Bézier samples per segment for variable-width outline
 
    // ── State ─────────────────────────────────────────────────────────────
    let _isDrawing   = false;
    let _rawPoints   = [];               // { x, y, pressure }
    let _draftCtx    = null;
    let _mainCtx     = null;
    let _color       = '#000000';
    let _lineWidth   = 4;                // max stroke width  (pressure = 1.0)
    let _minWidth    = 1;                // min stroke width  (pressure = 0.0)
    let _tension     = 0.7;             // spline tightness; 1.0 = standard CR, lower = looser
    let _cornerAngle = Math.PI * 0.4;   // ~72° — turns sharper than this become hard corners
    let _usePressure = true;            // false → uniform _lineWidth stroke, skip outline path
    let _onCommit    = null;
 
    // rAF draft state
    let _draftDirty  = false;
    let _draftRafId  = null;
 
    // ── Helper ────────────────────────────────────────────────────────────
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
 
    // ─────────────────────────────────────────────────────────────────────
    // Stage 1: Ramer-Douglas-Peucker Simplification
    // ─────────────────────────────────────────────────────────────────────
    // Recursively culls collinear points while preserving true inflection
    // points. The { x, y, pressure } payload is preserved on survivors so
    // pressure data stays associated with the correct geometry.
    //
    function rdpSimplify(points, tolerance) {
        if (points.length <= 2) return points.slice();
 
        const first = points[0], last = points[points.length - 1];
        const dx    = last.x - first.x, dy = last.y - first.y;
        const den   = Math.hypot(dx, dy);
 
        // Degenerate: all points coincide — collapse to endpoints
        if (den < 1e-6) return [first, last];
 
        let maxDist = 0, maxIdx = 0;
        for (let i = 1; i < points.length - 1; i++) {
            const p = points[i];
            const d = Math.abs(dy * p.x - dx * p.y + last.x * first.y - last.y * first.x) / den;
            if (d > maxDist) { maxDist = d; maxIdx = i; }
        }
 
        if (maxDist > tolerance) {
            const left  = rdpSimplify(points.slice(0, maxIdx + 1), tolerance);
            const right = rdpSimplify(points.slice(maxIdx), tolerance);
            left.pop(); // drop duplicate junction point
            return left.concat(right);
        }
        return [first, last];
    }
 
    // ─────────────────────────────────────────────────────────────────────
    // Stage 2a: Corner Detection
    // ─────────────────────────────────────────────────────────────────────
    // Returns a Set of point indices that should receive zero tangent (C0
    // continuity only). The endpoints are always included. An interior point
    // is added when the angle between the incoming and outgoing chord vectors
    // exceeds `threshold` radians.
    //
    // Typical threshold: π × 0.4 ≈ 72°.  Krita's default is ~60°.
    //
    function detectCorners(points, threshold) {
        const corners = new Set([0, points.length - 1]);
        for (let i = 1; i < points.length - 1; i++) {
            const ax = points[i].x   - points[i-1].x,  ay = points[i].y   - points[i-1].y;
            const bx = points[i+1].x - points[i].x,    by = points[i+1].y - points[i].y;
            const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
            if (la < 1e-6 || lb < 1e-6) continue;
            const cos   = clamp((ax*bx + ay*by) / (la * lb), -1, 1);
            const angle = Math.acos(cos);   // 0 = straight, π = hairpin U-turn
            if (angle > threshold) corners.add(i);
        }
        return corners;
    }
 
    // ─────────────────────────────────────────────────────────────────────
    // Stage 2b: Centripetal Catmull-Rom → Cubic Bézier
    // ─────────────────────────────────────────────────────────────────────
    //
    // WHY centripetal instead of uniform:
    //   Uniform CR assigns equal parameter intervals to all consecutive point
    //   pairs regardless of distance. When the user slows down, points bunch
    //   up; when they speed up, points spread out. In the bunched regions the
    //   control points overshoot badly, producing cusps or loops that are
    //   invisible in the raw lineTo draft but appear on commit.
    //
    //   Centripetal CR (ALPHA = 0.5) weights each knot interval by √(chord
    //   length), which scales the tangent magnitude in proportion to the local
    //   density — exactly cancelling the overshoot. It is provably loop-free
    //   and cusp-free for any set of distinct input points.
    //
    // Tangent formula at Pᵢ (centripetal parameterization):
    //
    //   d₋ = |Pᵢ − Pᵢ₋₁|^α       (knot interval before i)
    //   d₊ = |Pᵢ₊₁ − Pᵢ|^α       (knot interval after i)
    //
    //   mᵢ = [(Pᵢ−Pᵢ₋₁)/d₋  −  (Pᵢ₊₁−Pᵢ₋₁)/(d₋+d₊)  +  (Pᵢ₊₁−Pᵢ)/d₊] · d₊
    //
    // With α = 0 (uniform), this reduces exactly to the standard
    //   mᵢ = (Pᵢ₊₁ − Pᵢ₋₁) / 2
    // confirming backward-compatibility.
    //
    // Endpoints use phantom-mirror neighbours so the same formula applies
    // everywhere — no special-casing needed for i=0 or i=n−1.
    //
    // Bézier control points for segment [Pᵢ, Pᵢ₊₁]:
    //   CP1 = Pᵢ   + (tension/3) · mᵢ
    //   CP2 = Pᵢ₊₁ − (tension/3) · mᵢ₊₁
    //
    // Hard corners (from detectCorners) receive mᵢ = 0, giving a clean cusp
    // (C0 join) rather than a smoothed approximation of the user's intent.
    //
    function catmullRomToBezier(points, tension, corners) {
        tension = (tension != null) ? tension : _tension;
        const n = points.length;
        if (n < 2) return [];
 
        // Two-point degenerate: straight segment with collinear control points
        if (n === 2) {
            const p0 = points[0], p3 = points[1];
            const mx = (p3.x - p0.x) / 3, my = (p3.y - p0.y) / 3;
            return [{ p0,
                      p1: { x: p0.x + mx, y: p0.y + my },
                      p2: { x: p3.x - mx, y: p3.y - my },
                      p3 }];
        }
 
        const EPS = 1e-5;
 
        // Precompute knot intervals for real inter-point spans
        const kd = new Float64Array(n - 1);
        for (let i = 0; i < n - 1; i++) {
            kd[i] = Math.pow(
                Math.hypot(points[i+1].x - points[i].x,
                           points[i+1].y - points[i].y),
                ALPHA) || EPS;
        }
 
        // Compute tangent vectors at every point
        const tx = new Float64Array(n);
        const ty = new Float64Array(n);
 
        for (let i = 0; i < n; i++) {
            // Hard corners keep zero tangent → clean C0 cusp
            if (corners && corners.has(i)) continue;
 
            // Phantom-mirror neighbours for endpoint extrapolation:
            //   P_phantom_prev = 2·P₀ − P₁   (mirrors P₁ through P₀)
            //   P_phantom_next = 2·Pₙ₋₁ − Pₙ₋₂
            // This ensures the derivative formula is identical for all i.
            const px  = i > 0   ? points[i-1].x : 2 * points[0].x   - points[1].x;
            const py  = i > 0   ? points[i-1].y : 2 * points[0].y   - points[1].y;
            const nx_ = i < n-1 ? points[i+1].x : 2 * points[n-1].x - points[n-2].x;
            const ny_ = i < n-1 ? points[i+1].y : 2 * points[n-1].y - points[n-2].y;
 
            const dPx = points[i].x - px, dPy = points[i].y - py;   // vector from prev to i
            const dNx = nx_ - points[i].x, dNy = ny_ - points[i].y; // vector from i to next
            const dFx = nx_ - px, dFy = ny_ - py;                    // full span prev→next
 
            const dPrev = Math.pow(Math.hypot(dPx, dPy), ALPHA) || EPS;
            const dCur  = (i < n-1 ? kd[i]
                                   : Math.pow(Math.hypot(dNx, dNy), ALPHA)) || EPS;
            const dSum  = dPrev + dCur;
 
            // Centripetal tangent formula, scaled by dCur for Bézier CP distance
            tx[i] = (dPx / dPrev  -  dFx / dSum  +  dNx / dCur) * dCur;
            ty[i] = (dPy / dPrev  -  dFy / dSum  +  dNy / dCur) * dCur;
        }
 
        // Emit cubic Bézier segments
        const t3   = tension / 3;
        const segs = [];
        for (let i = 0; i < n - 1; i++) {
            segs.push({
                p0: points[i],
                p1: { x: points[i].x   + tx[i]   * t3,
                      y: points[i].y   + ty[i]   * t3 },
                p2: { x: points[i+1].x - tx[i+1] * t3,
                      y: points[i+1].y - ty[i+1] * t3 },
                p3: points[i+1]
            });
        }
        return segs;
    }
 
    // ─────────────────────────────────────────────────────────────────────
    // Rendering — Uniform width (fast path)
    // ─────────────────────────────────────────────────────────────────────
    // Batches every Bézier segment into one Path2D and issues a single
    // ctx.stroke() call. v1 called beginPath/stroke per segment, flushing
    // the GPU command buffer on every iteration.
    //
    function _renderUniform(ctx, segs, color, lineWidth) {
        if (!segs.length) return;
        const path = new Path2D();
        path.moveTo(segs[0].p0.x, segs[0].p0.y);
        for (const s of segs) {
            path.bezierCurveTo(s.p1.x, s.p1.y, s.p2.x, s.p2.y, s.p3.x, s.p3.y);
        }
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth   = lineWidth;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.stroke(path);
        ctx.restore();
    }
 
    // ─────────────────────────────────────────────────────────────────────
    // Rendering — Variable width (pressure path)
    // ─────────────────────────────────────────────────────────────────────
    // Samples each Bézier segment at OUTLINE_SAMPLES evenly-spaced t values.
    // At each sample the perpendicular unit normal is computed from the curve
    // tangent, then the centerline point is offset by ±halfWidth to produce
    // upper and lower edge vertices.  halfWidth is linearly interpolated from
    // the pressures of the two knot points that bracket each segment.
    //
    // The resulting polygon is:
    //
    //   [start cap arc] → upper edge → [end cap arc] → lower edge (reversed)
    //   → closePath
    //
    // Arc geometry (canvas y-axis points DOWN):
    //   The normal vector (nx, ny) = (−dy, dx)/|tangent| points 90° left of
    //   travel. "upper" = centre + halfW·(nx,ny),  "lower" = centre − halfW·(nx,ny).
    //
    //   Start cap: arc(centre, r, angle_to_lower, angle_to_upper, anticlockwise=true)
    //     → sweeps counterclockwise through the angle behind the stroke start.
    //   End cap  : arc(centre, r, angle_to_upper, angle_to_lower, anticlockwise=true)
    //     → sweeps counterclockwise through the angle past the stroke end.
    //
    //   Both caps use anticlockwise=true (decreasing angle in canvas coords).
    //   Verified correct for horizontal, vertical, and diagonal test strokes.
    //
    function _renderOutline(ctx, segs, simplified, color, minW, maxW) {
        // Collect { x, y, nx, ny, halfW } for every outline sample
        const pts = [];
 
        for (let si = 0; si < segs.length; si++) {
            const seg    = segs[si];
            const pressA = simplified[si]   ?.pressure ?? 0.5;
            const pressB = simplified[si+1] ?.pressure ?? 0.5;
            const jStart = si === 0 ? 0 : 1; // skip duplicate junction on subsequent segs
 
            for (let j = jStart; j <= OUTLINE_SAMPLES; j++) {
                const t  = j / OUTLINE_SAMPLES;
                const mt = 1 - t;
 
                // Cubic Bézier position
                const bx = mt*mt*mt*seg.p0.x + 3*mt*mt*t*seg.p1.x
                         + 3*mt*t*t*seg.p2.x + t*t*t*seg.p3.x;
                const by = mt*mt*mt*seg.p0.y + 3*mt*mt*t*seg.p1.y
                         + 3*mt*t*t*seg.p2.y + t*t*t*seg.p3.y;
 
                // First derivative — tangent direction
                const dx = 3 * ( mt*mt*(seg.p1.x - seg.p0.x)
                               + 2*mt*t*(seg.p2.x - seg.p1.x)
                               + t*t*(seg.p3.x - seg.p2.x) );
                const dy = 3 * ( mt*mt*(seg.p1.y - seg.p0.y)
                               + 2*mt*t*(seg.p2.y - seg.p1.y)
                               + t*t*(seg.p3.y - seg.p2.y) );
                const tlen = Math.hypot(dx, dy);
                if (tlen < 1e-6) continue; // skip degenerate tangent (zero-length seg)
 
                // Unit normal (90° left of travel direction)
                const nx = -dy / tlen;
                const ny =  dx / tlen;
 
                // Pressure-interpolated half-width; clamp to ≥ 0.5 px for arc stability
                const press = pressA + (pressB - pressA) * t;
                const halfW = Math.max(0.5, (minW + (maxW - minW) * press) * 0.5);
 
                pts.push({ x: bx, y: by, nx, ny, halfW });
            }
        }
 
        if (pts.length < 2) return;
 
        const fp = pts[0];
        const lp = pts[pts.length - 1];
 
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
 
        // ── Start cap ────────────────────────────────────────────────────
        // moveTo lower[0], then arc anticlockwise through the angle "behind"
        // the stroke start to upper[0].
        ctx.moveTo(fp.x - fp.nx * fp.halfW,
                   fp.y - fp.ny * fp.halfW);
        ctx.arc(fp.x, fp.y, fp.halfW,
                Math.atan2(-fp.ny, -fp.nx),   // angle to lower[0]
                Math.atan2( fp.ny,  fp.nx),   // angle to upper[0]
                true);                         // anticlockwise → wraps behind start
 
        // ── Upper edge (left-to-right along stroke) ───────────────────────
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x + pts[i].nx * pts[i].halfW,
                       pts[i].y + pts[i].ny * pts[i].halfW);
        }
 
        // ── End cap ──────────────────────────────────────────────────────
        // Arc anticlockwise from upper[-1] through the angle past the stroke
        // end to lower[-1].
        ctx.arc(lp.x, lp.y, lp.halfW,
                Math.atan2( lp.ny,  lp.nx),   // angle to upper[-1]
                Math.atan2(-lp.ny, -lp.nx),   // angle to lower[-1]
                true);                         // anticlockwise → wraps past end
 
        // ── Lower edge (right-to-left back to lower[0]) ───────────────────
        for (let i = pts.length - 2; i >= 0; i--) {
            ctx.lineTo(pts[i].x - pts[i].nx * pts[i].halfW,
                       pts[i].y - pts[i].ny * pts[i].halfW);
        }
 
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
 
    // ─────────────────────────────────────────────────────────────────────
    // Draft Render Pipeline
    // ─────────────────────────────────────────────────────────────────────
    // Raw lineTo preview on the overlay canvas. Scheduled via rAF so that N
    // pointermove events arriving in the same display frame collapse into a
    // single clearRect + stroke, not N redundant ones.
    //
    // The preview uses a fixed average width rather than attempting variable-
    // width rendering on every frame — the final outline is committed on
    // pointerup and is always accurate.
    //
    function _renderDraft() {
        _draftDirty = false;
        _draftRafId = null;
        if (!_draftCtx || !_isDrawing) return;
 
        const ctx = _draftCtx, cvs = ctx.canvas;
        ctx.clearRect(0, 0, cvs.width, cvs.height);
        if (_rawPoints.length < 2) return;
 
        ctx.save();
        ctx.strokeStyle = _color;
        ctx.lineWidth   = _lineWidth;
        ctx.lineCap     = 'round';
        ctx.lineJoin    = 'round';
        ctx.globalAlpha = 0.6; // slightly ghosted — signals "preview, not committed"
        ctx.beginPath();
        ctx.moveTo(_rawPoints[0].x, _rawPoints[0].y);
        for (let i = 1; i < _rawPoints.length; i++) {
            ctx.lineTo(_rawPoints[i].x, _rawPoints[i].y);
        }
        ctx.stroke();
        ctx.restore();
    }
 
    function _scheduleDraft() {
        if (_draftDirty) return;           // already queued for this frame
        _draftDirty = true;
        _draftRafId = requestAnimationFrame(_renderDraft);
    }
 
    function _cancelDraftRaf() {
        if (_draftRafId !== null) {
            cancelAnimationFrame(_draftRafId);
            _draftRafId = null;
            _draftDirty = false;
        }
    }
 
    function _clearDraft() {
        if (_draftCtx) {
            _draftCtx.clearRect(0, 0, _draftCtx.canvas.width, _draftCtx.canvas.height);
        }
    }
 
    // ─────────────────────────────────────────────────────────────────────
    // Final Render Pipeline
    // ─────────────────────────────────────────────────────────────────────
    // Called on pointerup. Runs:  RDP → corner detection → centripetal CR
    // → rendering → draft clear. Returns { simplified, bezierSegs } or null
    // if the stroke is too short to fit.
    //
    function _finalize() {
        const simplified = rdpSimplify(_rawPoints, RDP_TOLERANCE);
        if (simplified.length < 2) return null;
 
        const corners    = detectCorners(simplified, _cornerAngle);
        const bezierSegs = catmullRomToBezier(simplified, _tension, corners);
        if (bezierSegs.length === 0) return null;
 
        if (_mainCtx) {
            const doPressure = _usePressure && (_lineWidth !== _minWidth);
            if (doPressure) {
                _renderOutline(_mainCtx, bezierSegs, simplified, _color, _minWidth, _lineWidth);
            } else {
                _renderUniform(_mainCtx, bezierSegs, _color, _lineWidth);
            }
        }
 
        _clearDraft();
        return { simplified, bezierSegs };
    }
 
    // ── Public API ────────────────────────────────────────────────────────
 
    /**
     * @param {object} config
     * @param {CanvasRenderingContext2D} config.draftCtx   Overlay canvas (cleared each frame)
     * @param {CanvasRenderingContext2D} config.mainCtx    Persistent canvas (receives final stroke)
     * @param {function}                config.onCommit    Called with { rawPoints, simplifiedPoints, bezierSegs }
     * @param {string}                  config.color       CSS color string
     * @param {number}                  config.lineWidth   Max stroke width in px (pressure=1.0)
     * @param {number}                  config.minWidth    Min stroke width in px (pressure=0.0) — enables outline path
     * @param {number}                  config.tension     Spline tightness, 0.0–1.0 (default 0.7)
     * @param {number}                  config.cornerAngle Radians; turns sharper than this → hard corner (default ~72°)
     * @param {boolean}                 config.usePressure false → always use uniform lineWidth stroke
     */
    function init(config) {
        _draftCtx    = config.draftCtx    ?? null;
        _mainCtx     = config.mainCtx     ?? null;
        _onCommit    = config.onCommit    ?? null;
        _color       = config.color       ?? '#000000';
        _lineWidth   = config.lineWidth   ?? 4;
        _minWidth    = config.minWidth    ?? 1;
        _tension     = config.tension     ?? 0.7;
        _cornerAngle = config.cornerAngle ?? Math.PI * 0.4;
        _usePressure = config.usePressure ?? true;
    }
 
    /**
     * Call on 'pointerdown'. Also call canvas.setPointerCapture(e.pointerId)
     * in the same handler to guarantee pointerup fires if the cursor leaves
     * the canvas bounds.
     */
    function onPointerDown(pos) {
        _isDrawing = true;
        _rawPoints = [{ x: pos.x, y: pos.y, pressure: pos.pressure ?? 0.5 }];
        _scheduleDraft();
    }
 
    /**
     * Call on 'pointermove'. Pass e.getCoalescedEvents() as coalescedEvents
     * when available (high-frequency stylus events faster than the JS loop).
     */
    function onPointerMove(pos, coalescedEvents) {
        if (!_isDrawing) return;
 
        // Inline helper: distance-filter before push; respects MAX_RAW_POINTS cap
        const tryPush = (cx, cy, cp) => {
            if (_rawPoints.length >= MAX_RAW_POINTS) return;
            const last = _rawPoints[_rawPoints.length - 1];
            if (Math.hypot(cx - last.x, cy - last.y) > MIN_DISTANCE) {
                _rawPoints.push({ x: cx, y: cy, pressure: cp ?? 0.5 });
            }
        };
 
        if (coalescedEvents && coalescedEvents.length > 0) {
            for (const ce of coalescedEvents) tryPush(ce.x, ce.y, ce.pressure);
        } else {
            tryPush(pos.x, pos.y, pos.pressure);
        }
 
        _scheduleDraft();
    }
 
    /**
     * Call on 'pointerup' and 'pointercancel'.
     * Returns { rawPoints, simplifiedPoints, bezierSegs } or null for a tap
     * that produced fewer than 2 distinct points.
     */
    function onPointerUp() {
        if (!_isDrawing) return null;
        _isDrawing = false;
        _cancelDraftRaf();
 
        if (_rawPoints.length < 2) {
            _rawPoints = [];
            _clearDraft();
            return null;
        }
 
        const finalData = _finalize(); // single RDP call; also clears draft
 
        const result = {
            rawPoints:        _rawPoints.slice(),
            simplifiedPoints: finalData?.simplified  ?? [],
            bezierSegs:       finalData?.bezierSegs  ?? []
        };
 
        _rawPoints = [];
 
        if (_onCommit && finalData) _onCommit(result);
 
        return result;
    }
 
    /** Abort the in-progress stroke without committing. */
    function cancel() {
        if (!_isDrawing) return;
        _isDrawing = false;
        _cancelDraftRaf();
        _rawPoints = [];
        _clearDraft();
    }
 
    // Convenience setters (allow per-stroke reconfiguration without full init())
    function setColor(c)         { _color = c; }
    function setLineWidth(w)     { _lineWidth = w; }
    function setMinWidth(w)      { _minWidth = w; }
    function setTension(t)       { _tension = t; }
    function setCornerAngle(a)   { _cornerAngle = a; }
    function isActive()          { return _isDrawing; }
    function getRawPoints()      { return _rawPoints.slice(); }
 
    return {
        init, onPointerDown, onPointerMove, onPointerUp,
        cancel, onPointerCancel: cancel,      // alias for pointercancel handler
        setColor, setLineWidth, setMinWidth, setTension, setCornerAngle,
        isActive, getRawPoints,
        // Exposed for testing / external reuse:
        rdpSimplify, catmullRomToBezier, detectCorners
    };
})();
