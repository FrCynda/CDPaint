(function (app) {
    'use strict';

    if (!app) return;

    /* ------------------------------------------------------------------ */
    /*  Math helpers                                                       */
    /* ------------------------------------------------------------------ */
    var _PI = Math.PI;
    var _abs = Math.abs;
    var _hypot = Math.hypot;
    var _round = Math.round;
    var _max = Math.max;
    var _min = Math.min;
    var _floor = Math.floor;
    var _clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
    var _cos = Math.cos;
    var _sin = Math.sin;
    var _exp = Math.exp;
    var _pow = Math.pow;
    var _atan2 = Math.atan2;
    var _lerp = function (a, b, t) { return a + (b - a) * t; };

    // Stroke-direction EMA smoother (reset per stroke).
    var _smoothAngle = NaN;
    // Module-level dab-distance tracker so preview batches are continuous.
    var _lastDabDist = 0;
    /* Live-pass frame budget. _schedulePaint sets _paintDeadline to now plus
     * _paintBudgetMs before each preview pass; the in-dab loop suspends into
     * _state.suspend past it, and the next frame resumes from the checkpoint.
     * Zero means no budget: the endStroke drain and the final replay always
     * run their segments whole. _suspendCount is the chunk counter the hash
     * suite asserts on. */
    var _paintDeadline = 0;
    var _paintBudgetMs = 8;
    var _suspendCount = 0;
    // Stroke smoothing (EMA) state — reset each stroke.
    var _smoothPosX = 0, _smoothPosY = 0;
    var _smoothBuffer = [];
    var _stabilizerX = 0, _stabilizerY = 0;
    var _lastRawX = 0, _lastRawY = 0;
    var _smoothSpeed = 0, _spLast = null, _spTime = 0, _spDists = [0], _spDts = [];
    var _lazyX = 0, _lazyY = 0;

    /* ------------------------------------------------------------------ */
    /*  Smoothing helpers                                                  */
    /* ------------------------------------------------------------------ */

    function _computeWeightedAverage(buffer, amount) {
        var len = buffer.length;
        if (len < 2) return buffer[len - 1] || { x: 0, y: 0, pressure: 0.5 };
        var last = buffer[len - 1];
        var sigma = amount * 0.5 + 1;
        var sumW = 0, sumX = 0, sumY = 0, sumP = 0;
        for (var i = 0; i < len; i++) {
            var dx = last.x - buffer[i].x;
            var dy = last.y - buffer[i].y;
            var dist2 = dx * dx + dy * dy;
            var w = _exp(-dist2 / (2 * sigma * sigma));
            sumX += buffer[i].x * w;
            sumY += buffer[i].y * w;
            sumP += (buffer[i].pressure || 0.5) * w;
            sumW += w;
        }
        if (sumW < 0.001) return last;
        return { x: sumX / sumW, y: sumY / sumW, pressure: sumP / sumW };
    }

    function _stabilizerDeadZone(amount) {
        return amount <= 0 ? 0 : amount;
    }

    /* Pen speed in px/ms, worked out as Krita does (KisSpeedSmoother):
     * the distance of the last few samples -- at least four and 5px --
     * over that many ticks of the tablet's own rate, which is a trimmed
     * mean of the gaps between events (KisFilteredRollingMean, the middle
     * 80% of the last 200). One late event then cannot spike the reading.
     * The rate is the pen's, so it outlives the stroke. */
    function _strokeSpeed(x, y) {
        var now = performance.now();
        if (!_spLast) {
            _spLast = { x: x, y: y }; _spTime = now;
            return (_smoothSpeed = 0);
        }
        var dist = _hypot(x - _spLast.x, y - _spLast.y);
        if (dist < 1e-9) return _smoothSpeed;       // the same point, reported again
        _spDts.push(now - _spTime);
        if (_spDts.length > 200) _spDts.shift();
        _spLast.x = x; _spLast.y = y; _spTime = now;
        _spDists.push(dist);
        if (_spDists.length > 512) _spDists.shift();

        var sorted = _spDts.slice().sort(function (a, b) { return a - b; });
        var keep = _max(1, _round(0.8 * sorted.length)), lo = _round((sorted.length - keep) / 2);
        var tick = 0;
        for (var i = lo; i < lo + keep; i++) tick += sorted[i];
        tick /= keep;

        var total = 0, n = 0;
        for (var k = _spDists.length - 1; k >= 0; k--) {
            n++; total += _spDists[k];
            if (n > 3 && total > 5) break;
        }
        if (tick > 0 && total > 5) _smoothSpeed = total / (n * tick);
        return _smoothSpeed;
    }

    /* ------------------------------------------------------------------ */
    /*  Dab mask generation & cache                                        */
    /* ------------------------------------------------------------------ */
    var _dabCache = (function () {
        /* A Map remembers the order things went in, and re-inserting a key
         * moves it to the end -- so it is the whole LRU. The array this
         * replaced needed an indexOf per dab to find the entry it had just
         * looked up, which is a scan of the cache on every single dab. */
        var _map = new Map();
        var _bytes = 0;
        var MAX_BYTES = 4 * 1024 * 1024;

        /* How finely a tip's turn is worth distinguishing: the step that
         * moves its outermost pixel by one. A 24px rake can be quantised to
         * 5 degrees and nobody can tell; a 200px one cannot.
         *
         * Rounding to the whole degree, as this used to, gave every brush
         * 360 buckets whatever its size -- and any brush whose angle rides a
         * sensor (a bristle fan, anything with angleSrc "random") then built
         * a fresh mask canvas for practically every dab. 228 canvases went
         * into one brush swatch against 8 for a brush that does not turn,
         * which is most of why the brush panel stuttered on those tiles. */
        function _quantAngle(angle, size) {
            var step = _clamp(114.6 / _max(1, size), 0.25, 6), a = angle || 0, r = _round(a / 90) * 90;
            /* A square turned square stays square: the 3.82-degree step (30px)
             * put X1DC Chalk's 270 at 271.2, its edges leaning a pixel, and
             * its grain ate the leaning edge. */
            return _abs(a - r) < step / 2 ? r : _round(a / step) * step;
        }

        function _key(shape, size, hardness, angle, aspect, phase) {
            return shape + '|' + (/^(k(circle|gauss|grect|lrect)|cspaa)/.test(shape) ? size : _round(size)) + '|' + _round(hardness) + '|'
                + angle.toFixed(2) + '|' + (aspect || 1).toFixed(2) + (phase ? '|' + phase : '');
        }

        return {
            get: function (shape, size, hardness, angle, aspect, phase) {
                angle = _quantAngle(angle, size);
                var k = _key(shape, size, hardness, angle, aspect, phase);
                var entry = _map.get(k);
                if (entry) {
                    _map.delete(k);
                    _map.set(k, entry);
                    return entry.canvas;
                }
                var canvas = _generateMask(shape, size, hardness, angle, aspect, phase);
                var est = canvas.width * canvas.height * 4;
                _map.set(k, { canvas: canvas, bytes: est });
                _bytes += est;
                while (_bytes > MAX_BYTES && _map.size > 1) {
                    var oldest = _map.keys().next().value;
                    _bytes -= _map.get(oldest).bytes;
                    _map.delete(oldest);
                }
                return canvas;
            },
            clear: function () {
                _map.clear();
                _bytes = 0;
            }
        };
    })();

    function _ceil(v) { return Math.ceil(v); }

    function _generateMask(shape, size, hardness, angleDeg, aspectRatio, phase) {
        /* Squash, never stretch. Aspect is width-to-height, and the long
         * axis is always `size` -- so a flat brush is a flat brush, not one
         * four times too big. This used to multiply the HEIGHT by aspect:
         * asking for 4 on a 40px tip rendered 40x160 instead of 40x10, which
         * put every preset that used it several times over its own size.
         * Krita's ratio means the same thing this now means. */
        var aspect = aspectRatio || 1;
        var w = _max(1, _round(size));
        var h = _max(1, _round(size / aspect));
        if (aspect < 1) { w = _max(1, _round(size * aspect)); h = _max(1, _round(size)); }

        var ang = (angleDeg || 0) * _PI / 180;
        // '*n': Krita's spikes, for the generator below (_fold)
        var si = shape.indexOf('*');
        _spk = si < 0 ? 2 : +shape.slice(si + 1);
        if (si >= 0) shape = shape.slice(0, si);
        /* A round tip is the same tip whichever way you turn it, so turning
         * it buys nothing and costs the accuracy of a second resample --
         * which at the sizes a swatch draws at (a pixel or two across) is
         * the difference between a visible stroke and an empty tile. */
        var tc = shape.indexOf('curve:') === 0;
        var kc = shape.indexOf('kcircle') === 0 || shape.indexOf('kgauss') === 0;
        if ((shape === 'circle' || kc || shape === 'gauss' || shape === 'gimp' || tc) && w === h && _spk < 3) ang = 0;
        var needRotation = _abs(ang) > 0.001;
        if (shape.indexOf('kgrect') === 0 || shape.indexOf('klrect') === 0) {
            var hy = shape.split(':')[1];
            return _kritaGaussRectMask(size, aspect, hardness / 100, (hy ? +hy : hardness) / 100, ang,
                                       shape.charAt(1) === 'l', shape.charAt(6) === 'a', phase);
        }
        if (shape === 'kmarker') return _kritaMarkerMask(size, phase);
        if (shape.indexOf('cspaa') === 0) return _cspCircleMask(size, +shape.slice(5), phase, aspect, ang, _min(1, hardness / 100));
        if (shape.indexOf('rcurve') === 0) return _kritaCurveRectMask(size, aspect, ang, _tcNow, shape.charAt(6) === 'a', phase);
        if (shape.indexOf('ccurve') === 0) return _kritaCurveCircleMask(size, aspect, ang, _tcNow, shape.charAt(6) === 'a', phase);
        if (kc) return _kritaCircleMask(size, aspect, hardness / 100, phase,
                                        shape.slice(-3) === ':aa', shape.charAt(1) === 'g', ang);
        if (shape === 'gimp' && aspect === 1) return _gimpCircleMask(size, hardness / 100);
        var canvas, ctx, rx, ry;

        if (needRotation) {
            var diag = _ceil(_hypot(w, h));
            canvas = new OffscreenCanvas(diag, diag);
            ctx = canvas.getContext('2d');
            rx = w / 2;
            ry = h / 2;
            ctx.translate(diag / 2, diag / 2);
            ctx.rotate(ang);
        } else if (phase) {
            /* Drawn where the dab really sits within its pixel, one pixel
             * wider to make room; _paintDab then places it on whole pixels.
             * See _maskFor. */
            canvas = new OffscreenCanvas(w + 1, h + 1);
            ctx = canvas.getContext('2d');
            rx = w / 2;
            ry = h / 2;
            canvas._cx = rx + (((phase[0] - rx) % 1) + 1) % 1;
            canvas._cy = ry + (((phase[1] - ry) % 1) + 1) % 1;
            ctx.translate(canvas._cx, canvas._cy);
        } else {
            canvas = new OffscreenCanvas(w, h);
            ctx = canvas.getContext('2d');
            rx = w / 2;
            ry = h / 2;
            ctx.translate(rx, ry);
        }

        var hard = _clamp(hardness / 100, 0, 1);

        switch (shape) {
            case 'square': _drawRect(ctx, -rx, -ry, rx * 2, ry * 2, hard); break;
            case 'diamond': _drawDiamond(ctx, rx, ry, hard); break;
            case 'line':
            case 'slash': _drawLine(ctx, rx, ry, hard); break;
            case 'gauss':
            case 'gimp': _drawCircle(ctx, rx, ry, hard, shape); break;
            case 'circle':
            default:
                if (tc) _drawCircle(ctx, rx, ry, 0, 'curve');
                else _drawCircle(ctx, rx, ry, hard);
                break;
        }

        return canvas;
    }

    // Abramowitz-Stegun 7.1.26, |error| < 1.5e-7.
    function _erf(x) {
        var s = x < 0 ? -1 : 1; x = _abs(x);
        var t = 1 / (1 + 0.3275911 * x);
        return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t
            - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
    }

    /* KisGaussCircleMaskGenerator, radius normalised to 1. Its `fade` is
     * one minus Krita's fade slider, which is our hardness. */
    function _gaussAt(t, hard) {
        var f = _clamp(1 - hard, 1e-6, 1 - 1e-6);
        var c = 2.5 * (6761 * f - 10000) / (Math.SQRT2 * 6761 * f);
        var k = Math.SQRT2 * 12500 / (6761 * f);
        return _clamp((_erf(t * k + c) - _erf(t * k - c)) / (2 * _erf(c)), 0, 1);
    }

    /* GIMP's generated round brush, pixel for pixel (test/gimp/probe.mjs,
     * "circ": lone dabs of Circle (01) to (11) and Circle Fuzzy (07), every
     * pixel matched). An odd grid, 2 * ceil(r - 1/2) + 1 across, centred on
     * its middle pixel; each pixel's distance from there rounded to a
     * quarter pixel and the profile averaged at four points round it, an
     * eighth and three eighths either side -- the quarter levels 64, 128,
     * 191 on a hard edge. GIMP then shifts the whole mask to the dab's
     * sub-pixel position bilinearly, which the transparent rim lets
     * drawImage do: without it a 1px dab at a pixel corner filled one
     * pixel at 192 where GIMP splits it into four at 64. */
    function _gimpCircleMask(size, hard) {
        var r = _max(0.5, size / 2), half = _ceil(r - 0.5 - 1e-9), N = 2 * half + 1;
        var c = new OffscreenCanvas(N + 2, N + 2), g = c.getContext('2d');
        var img = g.createImageData(N + 2, N + 2), d = img.data;
        for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) {
            var dist = _round(_hypot(i - half, j - half) * 4) / 4, v = 0;
            for (var k = 0; k < 4; k++) {
                var t = _abs(dist + (k - 1.5) / 4) / r;
                if (t < 1) v += BrushPack.gimpCurve(t, hard);
            }
            var o = ((j + 1) * (N + 2) + i + 1) * 4;
            d[o] = d[o + 1] = d[o + 2] = 255;
            d[o + 3] = _round(v / 4 * 255);
        }
        g.putImageData(img, 0, 0);
        return c;
    }

    /* Krita's default circle, pixel for pixel (KisCircleMaskGenerator, and
     * KisBrushMaskScalarApplicator which drives it for small tips), at the
     * tip's real size rather than rounded to a whole pixel.
     *
     * With "anti-alias edges" on, the fade is worked out one pixel further
     * from the centre on each axis than the pixel really is, so the edge
     * fades INSIDE the radius where a filled ellipse fades half a pixel
     * either side. A tip under 10px is also supersampled, 3x3 (6x6 under
     * 1px) -- from the pixel's corner, not around its centre, which puts
     * the dab a third of a pixel up and left of the cursor. Measured on
     * Ink-3 G-Pen's 5px line: rows 164,254,254,254,229 in Krita, fitted by
     * exactly this and by nothing centred. Not radially symmetric, hence
     * per pixel rather than a gradient.
     *
     * `gauss` is its gauss generator (KisGaussCircleMaskGenerator), whose
     * anti-aliasing is instead a linear fade over the last pixel of the
     * radius (KisAntialiasingFadeMaker1D). */
    /* Krita's spikes (KisMaskGenerator::fixRotation): a point past the
     * first wedge (pi / spikes either side of the tip's axis) is turned back
     * a whole wedge at a time until it lies in it, so every wedge repeats
     * the first -- a star of `spikes` points, each the shape's own tip.
     * The circles fold (x, |y|), the plain square (|x|, |y|). BB-Chalk
     * pencil's 3-spiked oval is a rounded triangle in Krita, not an oval.
     * _spk is set for the one generator call (_generateMask). */
    var _spk = 2, _sfx = 0, _sfy = 0;
    function _fold(x, y) {
        var a = Math.atan2(y, x), w = _PI / _spk, c = _cos(-2 * w), s = _sin(-2 * w);
        while (a > w) { var t = x; x = c * t - s * y; y = s * t + c * y; a -= 2 * w; }
        _sfx = x; _sfy = y;
    }
    function _kritaCircleMask(size, aspect, hard, phase, aa, gauss, ang) {
        var rx = size / 2, ry = size / aspect / 2;
        if (aspect < 1) { rx = size * aspect / 2; ry = size / 2; }
        // Sized for the TURNED oval: sized for the upright one, a turned
        // Ink Calligraphic lost both ends of its long axis.
        var c0 = _cos(ang || 0), s0 = _sin(ang || 0);
        var W = _ceil(2 * Math.sqrt(rx * rx * c0 * c0 + ry * ry * s0 * s0)) + 3;
        var H = _ceil(2 * Math.sqrt(rx * rx * s0 * s0 + ry * ry * c0 * c0)) + 3;
        if (_spk > 2) W = H = _ceil(2 * _max(rx, ry)) + 3;   // a star reaches its radius every way
        var canvas = new OffscreenCanvas(W, H), cx = W / 2, cy = H / 2;
        if (phase) { canvas._cx = cx = _floor(W / 2) + phase[0]; canvas._cy = cy = _floor(H / 2) + phase[1]; }
        var ss = aa && (rx < 5 || ry < 5) ? (rx < 0.5 || ry < 0.5 ? 6 : 3) : 1, e = aa ? 1 : 0;
        var fx = hard > 0 ? 1 / (hard * rx) : 1, fy = hard > 0 ? 1 / (hard * ry) : 1;
        // Each sample is turned into the tip's own frame, as Krita does it
        // (MaskProcessingData's cosa/sina, applied before valueAt).
        var ca = _cos(ang || 0), sa = -_sin(ang || 0);
        var fs = _max(0, rx - 1), fsv = gauss ? _gaussAt(fs / rx, hard) : 0;
        var ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H), d = img.data;
        for (var j = 0; j < H; j++) {
            for (var i = 0; i < W; i++) {
                var sum = 0, tsum = 0;
                for (var sy = 0; sy < ss; sy++) {
                    var y0 = j + 0.5 - cy + sy / ss;
                    for (var sx = 0; sx < ss; sx++) {
                        var x0 = i + 0.5 - cx + sx / ss;
                        var x = ca * x0 - sa * y0, y = sa * x0 + ca * y0;
                        if (_spk > 2) { _fold(x, _abs(y)); x = _sfx; y = _sfy; }
                        var n = (x / rx) * (x / rx) + (y / ry) * (y / ry), ay = (_abs(y) + e) * fy;
                        if (n > 1) { tsum += 255; continue; }
                        if (gauss) {
                            var dist = Math.sqrt(n) * rx;
                            sum += aa && dist > fs ? fsv * (rx - dist) / (rx - fs) : _gaussAt(dist / rx, hard);
                            continue;
                        }
                        var ax = (_abs(x) + e) * fx, nf = ax * ax + ay * ay;
                        sum += nf < 1 ? 1 : 1 - n * (nf - 1) / (nf - n);
                        if (nf >= 1) tsum += Math.trunc(255 * n * (nf - 1) / (nf - n));
                    }
                }
                /* Supersampled, Krita adds up each sample's transparency as a
                 * whole byte, cut down, and cuts the mean down again: a level
                 * above a rounded mean of the coverage (hairy probes, 245 -> 246). */
                if (ss > 1 && !gauss) sum = (255 - _floor(tsum / (ss * ss))) / 255 * ss * ss;
                if (sum) { var k = (j * W + i) * 4; d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = _round(sum / (ss * ss) * 255); }
            }
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    /* Clip Studio's anti-aliased round dab: solid, then falling in a
     * straight line to nothing at the rim over `w` px (never past the
     * centre), sampled at pixel centres. Fitted to G-pen lines at every
     * AA level and sizes 5-40 (w = AA + 0.5), all within a grey level. */
    /* Softer than 100 (hard < 1), a raised cosine runs past the size: out
     * to 1 + 0.414 x softness of the radius (root 2 at 0), from 1 - 1.245 x
     * softness of that, and the same ramp still fades its new rim. Single
     * dabs at hardness 0-80, sizes 6-200: within 3 grey levels and 3% of
     * ink with anti-aliasing off, 7% with it on (level 2, the smallest). */
    function _cspCircleMask(size, w, phase, aspect, ang, hard) {
        // An oval (thickness) keeps the same ramp, measured in px to its rim.
        var rx = size / 2, ry = size / aspect / 2;
        if (aspect < 1) { rx = size * aspect / 2; ry = size / 2; }
        var soft = 1 - hard, ro = 1 + (Math.SQRT2 - 1) * soft, ri = ro * (1 - 1.245 * soft);
        var W = _ceil(size * ro) + 3, canvas = new OffscreenCanvas(W, W), c = W / 2;
        if (phase) { canvas._cx = _floor(c) + phase[0]; canvas._cy = _floor(c) + phase[1]; }
        var cx = phase ? canvas._cx : c, cy = phase ? canvas._cy : c, k = 1 / _min(w, rx * ro, ry * ro);
        var ca = _cos(ang), sa = -_sin(ang), qx = 1 / (rx * rx), qy = 1 / (ry * ry);
        var ctx = canvas.getContext('2d'), img = ctx.createImageData(W, W), d = img.data;
        for (var j = 0; j < W; j++) for (var i = 0; i < W; i++) {
            var x0 = i + 0.5 - cx, y0 = j + 0.5 - cy, x = ca * x0 - sa * y0, y = sa * x0 + ca * y0;
            var n = Math.sqrt(x * x * qx + y * y * qy);
            // (ro - n) over n's slope: px to the rim, r - d on a circle
            var a = n ? _min(1, (ro - n) * n / _hypot(x * qx, y * qy) * k) : 1;
            if (soft > 0) a *= 0.5 + 0.5 * _cos(_PI * _clamp((n - ri) / (ro - ri), 0, 1));
            if (a <= 0) continue;
            var o = (j * W + i) * 4;
            d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = _round(_min(1, a) * 255);
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    /* Krita's round marker (KisMarkerPainter::fillFullCircle): solid to
     * the radius, then a fade over the next pixel that is linear in the
     * squared distance, cut to a whole level, not rounded. */
    function _kritaMarkerMask(size, phase) {
        var r = size / 2, W = _ceil(2 * r) + 5, canvas = new OffscreenCanvas(W, W), c = W / 2;
        if (phase) { canvas._cx = _floor(c) + phase[0]; canvas._cy = _floor(c) + phase[1]; }
        var cx = phase ? canvas._cx : c, cy = phase ? canvas._cy : c, k = 1 / (2 * r + 1);
        var ctx = canvas.getContext('2d'), img = ctx.createImageData(W, W), d = img.data;
        for (var j = 0; j < W; j++) for (var i = 0; i < W; i++) {
            var dx = i + 0.5 - cx, dy = j + 0.5 - cy, f = (dx * dx + dy * dy - r * r) * k;
            if (f > 1) continue;
            var o = (j * W + i) * 4;
            d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = f > 0 ? _floor((1 - f) * 255) : 255;
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    /* Krita's gauss square (KisGaussRectangleMaskGenerator): an erf edge
     * whose half-way line sits 2.5 fade-widths INSIDE the box, the fade
     * width being (1 - fade/2) tenths of the side. ZBlocks' 30px square is
     * 18px of ink in Krita; the plain square edge painted all 30.
     * lin: Krita's default square instead -- each axis solid out to its fade
     * share of the half side, then a straight ramp to nothing at the edge,
     * the lower of the two winning (test/krita/probes/defrect: within a grey
     * level of Krita's lone dabs at fades 0-0.9, ratio 0.15-1). This was a
     * solid box whatever the fade: Grease Charcoal's 5px bar painted as 4
     * rows of full ink. Under 10px on a side and anti-aliased it is
     * supersampled from the pixel's corner like the circle (_kritaCircleMask),
     * a third of a pixel up and left: that bar's rows 46,209,254,236,104. */
    function _kritaGaussRectMask(size, aspect, hard, hardY, ang, lin, aa, phase) {
        var w = size, h = size / aspect;
        if (aspect < 1) { w = size * aspect; h = size; }
        var xf = _max(1e-6, (1 - hard / 2) * w * 0.1), yf = _max(1e-6, (1 - hardY / 2) * h * 0.1);
        var kx = 1 / (Math.SQRT2 * xf), ky = 1 / (Math.SQRT2 * yf);
        var hw = w / 2 - 2.5 * xf, hh = h / 2 - 2.5 * yf;
        var af = 1 / (4 * _erf(hw * kx) * _erf(hh * ky));
        if (!isFinite(af)) af = 0;
        // even, so the centre is a pixel corner and a whole-pixel dab is not smeared across two
        var D = 2 * _ceil(_hypot(w, h) / 2) + 2, canvas = new OffscreenCanvas(D, D), c = D / 2, cy = c;
        if (phase) { canvas._cx = c += phase[0]; canvas._cy = cy += phase[1]; }   // at the dab's sub-pixel phase, as the circle
        var ca = _cos(ang || 0), sa = -_sin(ang || 0), ss = aa && (w < 10 || h < 10) ? (w < 1 || h < 1 ? 6 : 3) : 1;
        /* The plain square (KisRectangleMaskGenerator::valueAt): per axis,
         * n = 2|x|/w and F = |x| * 2/(fade w) (1 at no fade), clear by
         * n(F - 1)/(F - n) once F passes 1, the more-cleared axis winning.
         * Unsmoothed that is a straight ramp from the fade to the edge;
         * anti-aliased |x| is a pixel further out in F alone, which clears
         * a thin tip right through its middle: Grease Charcoal's 4px bar. */
        var tfx = hard > 0 ? 2 / (hard * w) : 1, tfy = hardY > 0 ? 2 / (hardY * h) : 1, ea = aa ? 1 : 0;
        var ctx = canvas.getContext('2d'), img = ctx.createImageData(D, D), d = img.data;
        for (var j = 0; j < D; j++) {
            for (var i = 0; i < D; i++) {
                if (lin) {
                    var v = 0;
                    for (var sy = 0; sy < ss; sy++) for (var sx = 0; sx < ss; sx++) {
                        var x1 = i + 0.5 - c + sx / ss, y1 = j + 0.5 - cy + sy / ss;
                        var ux = _abs(ca * x1 - sa * y1), uy = _abs(sa * x1 + ca * y1);
                        if (_spk > 2) { _fold(ux, uy); ux = _abs(_sfx); uy = _abs(_sfy); }
                        var nx = ux * 2 / w, ny = uy * 2 / h;
                        if (nx > 1 || ny > 1) continue;
                        var Fx = (ux + ea) * tfx, Fy = (uy + ea) * tfy;
                        var cx = Fx > 1 ? nx * (Fx - 1) / _max(1e-9, Fx - nx) : 0, cy2 = Fy > 1 ? ny * (Fy - 1) / _max(1e-9, Fy - ny) : 0;
                        v += _clamp(1 - _max(cx, cy2), 0, 1);
                    }
                    v /= ss * ss;
                } else {
                    /* Anti-aliased, the gauss square fades its last pixel to
                     * nothing (KisAntialiasingFadeMaker2D) and is supersampled
                     * from the pixel's corner under 10px, as the plain one:
                     * Poska Square's small dabs sat a third of a pixel up and
                     * left in Krita. */
                    var v = 0;
                    for (var sy2 = 0; sy2 < ss; sy2++) for (var sx2 = 0; sx2 < ss; sx2++) {
                        var x0 = i + 0.5 - c + sx2 / ss, y0 = j + 0.5 - cy + sy2 / ss;
                        var x = _abs(ca * x0 - sa * y0), y = _abs(sa * x0 + ca * y0);
                        if (_spk > 2) { _fold(ca * x0 - sa * y0, y); x = _abs(_sfx); y = _abs(_sfy); }
                        if (x > w / 2 || y > h / 2) continue;
                        var g = af * (_erf((hw + x) * kx) + _erf((hw - x) * kx)) * (_erf((hh + y) * ky) + _erf((hh - y) * ky));
                        if (aa) g *= _min(1, w / 2 - x) * _min(1, h / 2 - y);
                        v += g;
                    }
                    v /= ss * ss;
                }
                if (v > 0) { var k = (j * D + i) * 4; d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = _round(_min(1, v) * 255); }
            }
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    /* Krita's "soft" circle (KisCurveCircleMaskGenerator), pixel for pixel:
     * opacity is the curve at the squared radius, read from a table of
     * 4x the tip's size plus 2 samples by a lookup that runs one sample
     * short of its end, so the rim reads the curve a little inside 1.
     * Anti-aliased, it fades linearly in the squared radius from
     * ((w/2 - 1) / (w/2))^2 to nothing at the rim, and under 10px it is
     * supersampled from the pixel's corner like _kritaCircleMask. Drawn as
     * a gradient, Layout_circle_soft's 8px line lost an eighth of its ink. */
    function _kritaCurveCircleMask(size, aspect, ang, curve, aa, phase) {
        var w = size, h = size / aspect;
        if (aspect < 1) { w = size * aspect; h = size; }
        var R = _round(_max(w, h) * 4), lut = new Float64Array(R + 2);
        for (var li = 0; li <= R + 1; li++) lut[li] = _clamp(_curveAt(curve, li / (R + 1), true), 0, 1);
        var tr = function (dist) { var q = dist * R, k = q | 0, f = q - k; return _floor((1 - ((1 - f) * lut[k] + f * lut[_min(R + 1, k + 1)])) * 255); };
        var xc = 2 / w, yc = 2 / h, fs = _pow(0.5 * (_max(0, 1 - xc) + _max(0, 1 - yc)), 2);
        var f0 = tr(fs), fk = _max(0, 255 - f0) / (1 - fs);
        var D = 2 * _ceil(_max(w, h) / 2) + 3, canvas = new OffscreenCanvas(D, D), c = D / 2, cy = c;
        if (phase) { canvas._cx = c = _floor(c) + phase[0]; canvas._cy = cy = _floor(D / 2) + phase[1]; }
        var ca = _cos(ang || 0), sa = -_sin(ang || 0), ss = aa && (w < 10 || h < 10) ? (w < 1 || h < 1 ? 6 : 3) : 1;
        var ctx = canvas.getContext('2d'), img = ctx.createImageData(D, D), d = img.data;
        for (var j = 0; j < D; j++) {
            for (var i = 0; i < D; i++) {
                var t = 0;
                for (var sy = 0; sy < ss; sy++) for (var sx = 0; sx < ss; sx++) {
                    var x0 = i + 0.5 - c + sx / ss, y0 = j + 0.5 - cy + sy / ss;
                    var x = ca * x0 - sa * y0, y = sa * x0 + ca * y0;
                    if (_spk > 2) { _fold(x, _abs(y)); x = _sfx; y = _sfy; }
                    x *= xc; y *= yc; var dist = x * x + y * y;
                    t += dist > 1 ? 255 : aa && dist > fs ? _min(255, _floor(f0 + (dist - fs) * fk)) : tr(dist);
                }
                var a = 255 - _floor(t / (ss * ss));
                if (a > 0) { var k = (j * D + i) * 4; d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = a; }
            }
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    /* Krita's "soft" square (KisCurveRectangleMaskGenerator): the drawn
     * curve c read on each axis as c(t) (1 - c(1 - t)), multiplied, the
     * curve a table of 4 entries a pixel read at the nearest. A curve that
     * falls away late keeps only the middle: Block tilt fill's 26px bar
     * paints a few pixels. Supersampled and edge-faded as the gauss one. */
    function _kritaCurveRectMask(size, aspect, ang, curve, aa, phase) {
        var w = size, h = size / aspect;
        if (aspect < 1) { w = size * aspect; h = size; }
        var N = _round(_max(w, h) * 4), lut = new Float64Array(N + 1);
        for (var li = 0; li <= N; li++) lut[li] = _clamp(_curveAt(curve, li / N, true), 0, 1);
        var D = 2 * _ceil(_hypot(w, h) / 2) + 2, canvas = new OffscreenCanvas(D, D), c = D / 2, cy = c;
        if (phase) { canvas._cx = c += phase[0]; canvas._cy = cy += phase[1]; }
        var ca = _cos(ang || 0), sa = -_sin(ang || 0), ss = aa && (w < 10 || h < 10) ? (w < 1 || h < 1 ? 6 : 3) : 1;
        var ctx = canvas.getContext('2d'), img = ctx.createImageData(D, D), d = img.data;
        for (var j = 0; j < D; j++) {
            for (var i = 0; i < D; i++) {
                var v = 0;
                for (var sy = 0; sy < ss; sy++) for (var sx = 0; sx < ss; sx++) {
                    var x0 = i + 0.5 - c + sx / ss, y0 = j + 0.5 - cy + sy / ss;
                    var x = _abs(ca * x0 - sa * y0), y = _abs(sa * x0 + ca * y0);
                    if (_spk > 2) { _fold(ca * x0 - sa * y0, y); x = _abs(_sfx); y = _abs(_sfy); }
                    if (x > w / 2 || y > h / 2) continue;
                    var si = _round(x * 2 / w * N), ti = _round(y * 2 / h * N);
                    var g = lut[si] * (1 - lut[N - si]) * lut[ti] * (1 - lut[N - ti]);
                    if (aa) g *= _min(1, w / 2 - x) * _min(1, h / 2 - y);
                    v += g;
                }
                v /= ss * ss;
                if (v > 0) { var k = (j * D + i) * 4; d[k] = d[k + 1] = d[k + 2] = 255; d[k + 3] = _round(_min(1, v) * 255); }
            }
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    function _drawCircle(ctx, rx, ry, hard, kind) {
        if (hard >= 0.99) {
            ctx.beginPath();
            ctx.ellipse(0, 0, rx, ry, 0, 0, _PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            return;
        }
        // Scale to make gradient elliptical
        ctx.save();
        ctx.scale(1, ry / _max(1, rx));
        var r = rx;
        var grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        /* Krita's default circle (KisCircleMaskGenerator::valueAt), which is
         * where most imported round brushes come from: solid out to `hard`
         * of the radius, then (1 - r^2) / (1 - hard^2) to nothing at the rim.
         * `gauss` is its gauss generator -- an erf bell whose half-way point
         * sits at 1 - 0.6761 * (1 - hard) of the radius. Sampled into stops;
         * 16 is past what a canvas gradient can tell apart. */
        var stops = 32;     // GIMP's curve is steep near the centre
        for (var i = 0; i <= stops; i++) {
            var t = i / stops, a;
            if (kind === 'gauss') a = _gaussAt(t, hard);
            else if (kind === 'gimp') a = BrushPack.gimpCurve(t, hard);
            // Krita's "soft" generator: opacity is the curve at the SQUARED
            // radius (KisCurveCircleMaskGenerator::norme is a*a + b*b).
            else if (kind === 'curve') a = _curveAt(_tcNow || _params.tipCurve, t * t, true);
            else a = t <= hard ? 1 : _clamp((1 - t * t) / _max(1e-6, 1 - hard * hard), 0, 1);
            grad.addColorStop(t, 'rgba(255,255,255,' + a.toFixed(4) + ')');
        }
        // The circle's knee, which falls between stops at most hardnesses.
        if (!kind) grad.addColorStop(hard, '#fff');
        ctx.fillStyle = grad;
        /* the disc, not its box: past the rim a gradient keeps its last stop,
         * and a curve can end above nothing (Bold_marker's 0.38 filled the
         * corners, squaring its ends); Krita's mask is clear there */
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, _PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function _drawRect(ctx, x, y, w, h, hard) {
        if (hard >= 0.99) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(x, y, w, h);
            return;
        }
        var blur = (1 - hard) * _min(w, h) * 0.3;
        ctx.shadowColor = '#fff';
        ctx.shadowBlur = blur;
        ctx.fillStyle = '#fff';
        ctx.fillRect(x, y, w, h);
        ctx.shadowBlur = 0;
    }

    function _drawDiamond(ctx, rx, ry, hard) {
        ctx.save();
        ctx.rotate(_PI / 4);
        var sx = _max(1, rx / 1.414);
        var sy = _max(1, ry / 1.414);
        if (hard >= 0.99) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(-sx, -sy, sx * 2, sy * 2);
        } else {
            var blur = (1 - hard) * _min(sx, sy) * 0.3;
            ctx.shadowColor = '#fff';
            ctx.shadowBlur = blur;
            ctx.fillStyle = '#fff';
            ctx.fillRect(-sx, -sy, sx * 2, sy * 2);
            ctx.shadowBlur = 0;
        }
        ctx.restore();
    }

    function _drawLine(ctx, rx, ry, hard) {
        var lw = _max(1, _min(rx, ry) * 0.3);
        if (hard >= 0.99) {
            ctx.fillStyle = '#fff';
            ctx.fillRect(-rx, -lw / 2, rx * 2, lw);
        } else {
            var blur = (1 - hard) * lw * 0.5;
            ctx.shadowColor = '#fff';
            ctx.shadowBlur = blur;
            ctx.fillStyle = '#fff';
            ctx.fillRect(-rx, -lw / 2, rx * 2, lw);
            ctx.shadowBlur = 0;
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Flow buffer + scratch canvases + compositing                       */
    /* ------------------------------------------------------------------ */
    var _flowCanvas = null;
    var _flowCtx = null;
    var _dirtyRect = null;
    var _clearBounds = null;
    /* What of the flow buffer has ink in it, across strokes. Wiping the
     * whole buffer at every stroke cost 8ms at 4000x4000 to clear a few
     * hundred pixels of last stroke. */
    var _flowUsed = null;
    var _scratchCanvas = null;
    var _scratchCtx = null;
    var _bgCanvas = null;
    var _bgCtx = null;
    var _grainCanvas = null;
    var _grainCtx = null;
    var _edgeCanvas = null;
    var _edgeCtx = null;
    var _washCanvas = null;
    var _washCtx = null;

    var SHRINK_THRESHOLD = 0.5;
    function _ensureFlowBuffer(w, h) {
        if (!_flowCanvas || _flowCanvas.width < w || _flowCanvas.height < h
            || (_flowCanvas.width > w * 2 && _flowCanvas.width * SHRINK_THRESHOLD > w)) {
            _flowCanvas = new OffscreenCanvas(_max(1, w), _max(1, h));
            /* float16: a dab a few 8-bit levels deep rounded to whole levels
             * on every landing, so faint build-up drifted far from Krita's
             * and GIMP's (X1BB at pressure 0.5 laid 0.37 of Krita's ink,
             * GIMP's dither brushes scored 0.06 IoU; test/krita/probes/addop).
             * The alpha-darken and masking buffers stay 8-bit: there Krita
             * rounds too, and hard pixel presets lost IoU with float16.
             * A browser without float16 canvases ignores the option.
             * ponytail: ~18% slower on a 300px soft brush, nothing at usual sizes. */
            _flowCtx = _flowCanvas.getContext('2d', { colorType: 'float16' });
            _flowUsed = null;   // a new buffer is already blank
            _adCanvas = null; _adCtx = null; _mkCanvas = null; _mkCtx = null;
        }
    }

    /* Krita's "creamy" alpha darken (KoCompositeOpAlphaDarken.h), the
     * default way its dabs build a stroke: a' = a + (o - a) * mask * flow
     * while a < o, else a unchanged. The stroke's ink rises toward the dab's
     * opacity `o` and never past it, so pressure-driven opacity sets how dark
     * the line gets, not how fast it stacks.
     *
     * Canvas has no alpha operator like that, but it has one for colour:
     * 'lighten' over an opaque backdrop is dst + s * max(0, src - dst), which
     * is the formula exactly. So the stroke's alpha is kept as grey in an
     * opaque buffer, each dab lightens it with grey level o at alpha
     * mask * flow, and the flush turns grey back into alpha on the flow
     * buffer. With o = 1 throughout this equals plain source-over, which is
     * why only presets with a per-dab opacity sensor take this path.
     *
     * A stroke whose colour changes (a jitter, Clip Studio's sub colour
     * mix) keeps its colours beside it in _adCol, each dab laid over the
     * last at its own alpha -- Generic Flower BG's flowers went out at one
     * grey, the last one's. Started the first time a dab's colour differs,
     * so a one-colour stroke pays nothing.
     * A colour picture tip lays its own shading there from its first dab.
     * ponytail: smudge on such a preset flattens it to one colour.
     *
     * Falling pressure: Krita caps the dab at the stroke's running opacity
     * instead, which jumps up with the dab's and eases a tenth of the way
     * down toward a lower one (KisPainter::blendAverageOpacity, from 0 each
     * stroke). Its alpha darken then reads a + (avg - a) * mask * flow * o/avg,
     * the same lighten at grey avg, the dab thinned by o/avg. */
    var _adCanvas = null, _adCtx = null, _adO = 1, _adAvg = 0, _adColor = '#000000';
    var _adCol = null, _adColCtx = null, _adColOn = 0;   // 0 no dab yet, 1 one colour, 2 colours in _adCol
    var _adPic = null, _adPicCtx = null;                 // a colour picture's dab, its own shading
    function _alphaDarken(p) {
        return !!((p.dabOpacitySrc && p.dabOpacitySrc !== 'none') || p.dabOpacitySensors || p.maskOp || p.hatch)
            && p.engineKind !== 'shape' && p.engineKind !== 'deform';
    }
    /* A dab on whole pixels takes Krita's alpha darken as its 8-bit RGBA
     * does it (KoOptimizedCompositeOpAlphaDarken32, creamy): in floats from
     * the stored level, rounded once. At Basic Paint's 3% flow a step under
     * half a level is lost, so the stroke stalls about 16 levels short of
     * its opacity and steps up as the pressure does; the browser's lighten
     * rounds its own way (Basic Paint IoU 0.897 -> 0.952). */
    /* Clip Studio's second brush in mode 3 is a stroke of its own taken off
     * the first's, a - d floored at 0, once both are whole (cdp-csp/pr-dt,
     * pr-dd, Dappled light: on one dab 0.90 / 0.68 / 0.45 of ink under the
     * same second dab leave 0.25 / 0.02 / 0; along a line the first stroke
     * less what is left is the second laid on its own, to a level). Mode 4
     * with the second brush's colour change off ('min') keeps the lesser of
     * the two strokes: Watercolor splash's dense first stroke is left only
     * where its second dabs lie, and to their own levels (cdp-csp/pr-du,
     * against min 0.005 off a pixel, against a x d 0.137). Mode 12 ('cut')
     * takes d x min(a, 1 - a): faint ink goes as a x (1 - d), a dense
     * stroke only loses what it lacks of solid, 2a - 1 under a solid cut,
     * so Wet blotting ink's band stays black (to a level on three probes,
     * cdp-csp/fitcut.py: isolated faint dabs, a dense flow-30 line, Wet
     * blotting ink's own picture; a x (1 - d) missed the dense two by 66
     * and 140). With the colour change off ('contrast') it is
     * a + (1 - 2d) x min(a, 1 - a): under half a second brush the ink
     * gains, over half it loses -- Wet blotting ink's dark rim round a
     * lighter band (cdp-csp/qw: fitcut3.py 0.6 levels; the cut rule
     * missed by 15, and by 0.06 with the change on). The second paints
     * into _subCanvas; the final flush takes it off, or under. */
    var _subCanvas = null, _subCtx = null, _subOn = false;   // false, 'subtract', 'min', 'cut' or 'contrast'
    /* Clip Studio's "blend by darken" lays each dab by the darker of it and
     * what is there: on one colour the stronger alpha wins and dabs never
     * pile up (cdp-csp/pr-sb, Soft bleed: a hard round at flow 25/50 holds
     * 0.37/0.75 the whole stroke, a soft one its own dab's profile). */
    function _maxDab(ctx, ox, oy, mw, mh, f) {
        var x0 = _max(0, ox), y0 = _max(0, oy), x1 = _min(ctx.canvas.width, ox + mw), y1 = _min(ctx.canvas.height, oy + mh);
        if (x1 <= x0 || y1 <= y0) return;
        var w = x1 - x0, h = y1 - y0, m = _scratchCtx.getImageData(x0 - ox, y0 - oy, w, h).data;
        var img = ctx.getImageData(x0, y0, w, h), d = img.data;
        for (var i = 0; i < d.length; i += 4) {
            var a = m[i + 3] * f;
            if (a > d[i + 3]) { d[i] = m[i]; d[i + 1] = m[i + 1]; d[i + 2] = m[i + 2]; d[i + 3] = a; }
        }
        ctx.putImageData(img, x0, y0);
    }
    function _adDab(ox, oy, mw, mh, flow) {
        var x0 = _max(0, ox), y0 = _max(0, oy), x1 = _min(_adCanvas.width, ox + mw), y1 = _min(_adCanvas.height, oy + mh);
        if (x1 <= x0 || y1 <= y0) return;
        var w = x1 - x0, h = y1 - y0, m = _scratchCtx.getImageData(x0 - ox, y0 - oy, w, h).data;
        var img = _adCtx.getImageData(x0, y0, w, h), d = img.data;
        var o = _adO, f = _clamp(flow, 0, 1), av = _adAvg;
        for (var i = 0; i < d.length; i += 4) {
            if (!m[i + 3]) continue;
            var mk = m[i + 3] / 255, dst = d[i] / 255, full;
            if (av > o) full = av > dst ? mk * o + (av - mk * o) * dst / av : dst;
            else full = o > dst ? dst + (o - dst) * mk : dst;
            d[i] = d[i + 1] = d[i + 2] = _round((dst + (full - dst) * f) * 255);
        }
        _adCtx.putImageData(img, x0, y0);
    }
    function _ensureAdBuffer() {
        if (_adCanvas && _adCanvas.width === _flowCanvas.width && _adCanvas.height === _flowCanvas.height) return;
        _adCanvas = new OffscreenCanvas(_flowCanvas.width, _flowCanvas.height);
        _adCtx = _adCanvas.getContext('2d', { willReadFrequently: true });
        _adCtx.fillStyle = '#000';
        _adCtx.fillRect(0, 0, _adCanvas.width, _adCanvas.height);
    }
    /* Krita's masking brush (KisMaskingBrushRenderer) in the modes that
     * are not a tip stamped through each dab: the masking preset paints a
     * whole stroke of its own into a separate buffer, which is then laid on
     * the finished stroke's alpha --
     *   subtract:     max(0, a - mask)   Waterpaint Soft Edges, hollow;
     *   add:          a ? min(1, a + mask) : 0   (linear dodge), Charcoal;
     *   multiply:     a * mask           RGBA Impasto;
     *   min:          min(a, mask)       (darken) RGBA Rake.
     * The mask is built the way Krita builds any stroke, alpha darken
     * included, so it is kept as grey on black like _adCanvas and its dabs
     * cap at their own opacity. Applied in _adToFlow, which rebuilds the
     * stroke from the grey buffer on every flush, so it never compounds.
     *
     * The mask keeps its own spacing between main dabs: Waterpaint Hard
     * Edges' main step outruns its mask's, and riding the main dabs took a
     * quarter off its erosion. No mirror on the mask. */
    var _mkCanvas = null, _mkCtx = null, _mkLast = null, _mkStamp = null, _mkDab = null;
    function _maskStrokeDab(p, x, y, sc) {
        var d = p.size * p.maskSize / 100 * _dyn(p, 'maskSize', 1, sc, 15), pic = p.maskPicture && _tip2CanvasFor();
        if (d < 0.5 || (p.maskPicture && !pic)) return;
        var step = _max(0.5, d * p.maskSpacing / 100), l = _mkLast, dx = l ? x - l.x : 0, dy = l ? y - l.y : 0, len = Math.hypot(dx, dy), t;
        if (!l) { _mkLast = { x: x, y: y }; _maskDabAt(p, x, y, sc, d, pic); return; }
        for (t = step; t <= len; t += step) _maskDabAt(p, l.x + dx * t / len, l.y + dy * t / len, sc, d, pic);
        if (t > step) _mkLast = { x: l.x + dx * (t - step) / len, y: l.y + dy * (t - step) / len };
    }
    function _maskDabAt(p, x, y, sc, d, pic) {
        if (p.maskScatter) {   // as the brush's own scatter, in a direction at random
            var sd = p.maskScatter / 100 * _dyn(p, 'maskScatter', 1, sc, 18) * d * (_dabRand(x, y, 41) * 2 - 1), sa = _dabRand(x, y, 42) * _PI * 2;
            x += _cos(sa) * sd; y += _sin(sa) * sd;
        }
        if (!_mkCanvas || _mkCanvas.width !== _flowCanvas.width || _mkCanvas.height !== _flowCanvas.height) {
            _mkCanvas = new OffscreenCanvas(_flowCanvas.width, _flowCanvas.height);
            _mkCtx = _mkCanvas.getContext('2d', { willReadFrequently: true });
            _mkCtx.fillStyle = '#000';
            _mkCtx.fillRect(0, 0, _mkCanvas.width, _mkCanvas.height);
        }
        var hard = _clamp((p.maskHardness == null ? 100 : p.maskHardness) / 100, 0, 1);
        if (!_mkStamp || _mkStamp.curve !== p.maskTipCurve || _mkStamp.hard !== hard) {
            var N = 128, c = new OffscreenCanvas(N, N), g = c.getContext('2d');
            var grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
            for (var i = 0; i <= 32; i++) {
                var t = i / 32, a = p.maskTipCurve ? _curveAt(p.maskTipCurve, t * t, true)
                    : t <= hard ? 1 : (1 - t * t) / _max(1e-6, 1 - hard * hard);   // Krita's circle
                grad.addColorStop(t, 'rgba(255,255,255,' + a.toFixed(4) + ')');
            }
            g.fillStyle = grad;
            g.fillRect(0, 0, N, N);
            _mkStamp = { curve: p.maskTipCurve, hard: hard, canvas: c };
        }
        // The dab in grey at its opacity, then lightened on: alpha darken.
        var o = _clamp(p.maskOpacity / 100 * _dyn(p, 'maskOpacity', 1, sc, 17), 0, 1);
        var n = _max(1, _ceil(d * (pic && (p.maskSpin || p.maskAlong) ? Math.SQRT2 : 1)) + 2);
        if (!_mkDab || _mkDab.width < n || _mkDab.height < n) _mkDab = new OffscreenCanvas(n, n);
        var dc = _mkDab.getContext('2d');
        dc.clearRect(0, 0, n, n);
        dc.fillStyle = _greyHex(o);
        dc.fillRect(0, 0, n, n);
        dc.globalCompositeOperation = 'destination-in';
        if (pic) {   // a picture keeps its shape, its long side the dab's size; a strip, one cell of it
            var nc = p.maskCells > 1 ? p.maskCells : 1, cw = pic.width / nc, ci = nc > 1 ? _floor(_dabRand(x, y, 44) * nc) : 0;
            var pk = d / _max(cw, pic.height), pw = cw * pk, ph = pic.height * pk;
            dc.save(); dc.translate(n / 2, n / 2);
            if (p.maskSpin) dc.rotate((_dabRand(x, y, 43) * 2 - 1) * _PI * p.maskSpin);
            else if (p.maskAlong) dc.rotate((sc.strokeAngle || 0) * _PI / 180);
            dc.drawImage(pic, ci * cw, 0, cw, pic.height, -pw / 2, -ph / 2, pw, ph); dc.restore();
        } else dc.drawImage(_mkStamp.canvas, n / 2 - d / 2, n / 2 - d / 2, d, d);
        dc.globalCompositeOperation = 'source-over';
        _mkCtx.globalCompositeOperation = 'lighten';
        _mkCtx.globalAlpha = _clamp(_dyn(p, 'maskFlow', p.maskFlow / 100, sc, 16), 0, 1);
        _mkCtx.drawImage(_mkDab, 0, 0, n, n, x - n / 2, y - n / 2, n, n);
        _mkCtx.globalAlpha = 1;
        _mkCtx.globalCompositeOperation = 'source-over';
    }

    function _greyHex(o) {
        var v = _round(_clamp(o, 0, 1) * 255).toString(16);
        if (v.length < 2) v = '0' + v;
        return '#' + v + v + v;
    }
    // Grey in the alpha-darken buffer becomes alpha in the flow buffer.
    function _adToFlow(x, y, w, h) {
        var img = _adCtx.getImageData(x, y, w, h), d = img.data, c = _hexToRgb(_adColor);
        var op = getParams().maskOp;
        var m = op && _mkCtx ? _mkCtx.getImageData(x, y, w, h).data : null;
        var col = _adColOn === 2 ? _adColCtx.getImageData(x, y, w, h).data : null;
        for (var i = 0; i < d.length; i += 4) {
            d[i + 3] = !m ? d[i] : op === 'add' ? (d[i] ? _min(255, d[i] + m[i]) : 0)
                : op === 'multiply' ? _round(d[i] * m[i] / 255) : op === 'min' ? _min(d[i], m[i]) : _max(0, d[i] - m[i]);
            if (col) { d[i] = col[i]; d[i + 1] = col[i + 1]; d[i + 2] = col[i + 2]; }
            else { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; }
        }
        _flowCtx.putImageData(img, x, y);
    }

    var _shiftCanvas = null, _shiftCtx = null;   // _paintDab's grained dab, before its sub-pixel move
    function _ensureScratch(w, h) {
        if (!_scratchCanvas || _scratchCanvas.width < w || _scratchCanvas.height < h
            || (_scratchCanvas.width > w * 2 && _scratchCanvas.width * SHRINK_THRESHOLD > w)) {
            _scratchCanvas = new OffscreenCanvas(w, h);
            _scratchCtx = _scratchCanvas.getContext('2d');
        }
    }

    /* The dual tip grains the FINISHED stroke, so it needs somewhere to do
     * that which is not the flow buffer itself: the flow buffer is
     * re-composited whole on every flush, and graining it in place would
     * apply the grain again to everything already flushed, squaring it. */
    function _ensureGrainCanvas(w, h) {
        if (!_grainCanvas || _grainCanvas.width < w || _grainCanvas.height < h
            || (_grainCanvas.width > w * 2 && _grainCanvas.width * SHRINK_THRESHOLD > w)) {
            _grainCanvas = new OffscreenCanvas(_max(1, w), _max(1, h));
            _grainCtx = _grainCanvas.getContext('2d');
        }
    }

    /* Scratch copy for the watercolour edge (W2): same lazy sizing as grain. */
    function _ensureEdgeCanvas(w, h) {
        if (!_edgeCanvas || _edgeCanvas.width < w || _edgeCanvas.height < h
            || (_edgeCanvas.width > w * 2 && _edgeCanvas.width * SHRINK_THRESHOLD > w)) {
            _edgeCanvas = new OffscreenCanvas(_max(1, w), _max(1, h));
            _edgeCtx = _edgeCanvas.getContext('2d');
        }
    }

    /* Scratch copy for the watercolour wash: same reason as the edge ring
     * above -- scaling the flow buffer in place would compound on every
     * live flush of the same stroke (each pass scaling what the last pass
     * already scaled down). A fresh copy of the raw, un-washed ink every
     * flush keeps the scale a single pass no matter how many times a long
     * drag flushes. */
    function _ensureWashCanvas(w, h) {
        if (!_washCanvas || _washCanvas.width < w || _washCanvas.height < h
            || (_washCanvas.width > w * 2 && _washCanvas.width * SHRINK_THRESHOLD > w)) {
            _washCanvas = new OffscreenCanvas(_max(1, w), _max(1, h));
            _washCtx = _washCanvas.getContext('2d');
        }
    }

    /* Wet-blend coverage (W1): per-pixel memory of what this stroke has
     * already landed, gating new dabs as they paint rather than diffing at
     * flush time. Flush time cannot do this: every flush restores clean
     * background and repaints the whole accumulated region from
     * _clearBounds (clearFlow is never true), so there is no "already on
     * the layer" state a post-hoc diff could compare against — a version
     * that tried that wiped the background under the WHOLE growing region
     * every flush but only redrew the newest sliver, erasing everything the
     * stroke had already painted. Gating each dab against this canvas as it
     * is painted keeps the flow buffer itself free of self-restacking, so
     * the ordinary full-region flush (already correct for every other
     * brush) just works. */
    var _covCanvas = null, _covCtx = null, _covUsed = null;
    function _ensureCovCanvas(w, h) {
        if (!_covCanvas || _covCanvas.width < w || _covCanvas.height < h
            || (_covCanvas.width > w * 2 && _covCanvas.width * SHRINK_THRESHOLD > w)) {
            _covCanvas = new OffscreenCanvas(_max(1, w), _max(1, h));
            _covCtx = _covCanvas.getContext('2d');
            _covUsed = null;   // a new buffer is already blank
        }
    }
    function _clearCovUsed() {
        if (!_covCtx) return;
        if (!_covUsed) return;
        var x = _floor(_covUsed.x1) - 1, y = _floor(_covUsed.y1) - 1;
        var w = _ceil(_covUsed.x2) - x + 2, h = _ceil(_covUsed.y2) - y + 2;
        _covCtx.clearRect(x, y, w, h);
        _covUsed = null;
    }
    function _growCovUsed(x, y, w, h) {
        if (!_covUsed) { _covUsed = { x1: x, y1: y, x2: x + w, y2: y + h }; return; }
        if (x < _covUsed.x1) _covUsed.x1 = x;
        if (y < _covUsed.y1) _covUsed.y1 = y;
        if (x + w > _covUsed.x2) _covUsed.x2 = x + w;
        if (y + h > _covUsed.y2) _covUsed.y2 = y + h;
    }

    /* Blank the flow buffer where the last stroke left ink, not end to end. */
    function _clearFlowUsed() {
        if (!_flowCtx) return;
        if (!_flowUsed) return;
        var x = _floor(_flowUsed.x1) - 1, y = _floor(_flowUsed.y1) - 1;
        var w = _ceil(_flowUsed.x2) - x + 2, h = _ceil(_flowUsed.y2) - y + 2;
        _flowCtx.clearRect(x, y, w, h);
        if (_adCtx) { _adCtx.fillStyle = '#000'; _adCtx.fillRect(x, y, w, h); }
        if (_mkCtx) { _mkCtx.fillStyle = '#000'; _mkCtx.fillRect(x, y, w, h); }
        _flowUsed = null;
    }

    function _ensureBgCanvas(w, h) {
        if (!_bgCanvas || _bgCanvas.width < w || _bgCanvas.height < h
            || (_bgCanvas.width > w * 2 && _bgCanvas.width * SHRINK_THRESHOLD > w)) {
            _bgCanvas = new OffscreenCanvas(w, h);
            _bgCtx = _bgCanvas.getContext('2d');
        }
    }

    // Release the full-canvas offscreen buffers (flow/scratch/bg) so they aren't held
    // resident while idle. The _ensure* functions recreate them lazily on the next stroke.
    function _releaseOffscreenBuffers() {
        _flowCanvas = null; _flowCtx = null; _flowUsed = null;
        _adCanvas = null; _adCtx = null; _mkCanvas = null; _mkCtx = null; _adCol = null; _adColCtx = null; _adPic = null; _adPicCtx = null;
        _covCanvas = null; _covCtx = null; _covUsed = null;
        _scratchCanvas = null; _scratchCtx = null;
        _tintMask = null; _tintColor = null;
        _bgCanvas = null; _bgCtx = null;
        _grainCanvas = null; _grainCtx = null;
        _edgeCanvas = null; _edgeCtx = null;
        _washCanvas = null; _washCtx = null;
    }

    var _hexColorCache = {};
    var _hexCacheKeys = [];
    var _hexCacheMax = 500;
    function _hexToRgb(hex) {
        if (_hexColorCache[hex]) {
            var idx = _hexCacheKeys.indexOf(hex);
            if (idx > 0) {
                _hexCacheKeys.splice(idx, 1);
                _hexCacheKeys.push(hex);
            }
            return _hexColorCache[hex];
        }
        var r = parseInt(hex.slice(1, 3), 16) || 0;
        var g = parseInt(hex.slice(3, 5), 16) || 0;
        var b = parseInt(hex.slice(5, 7), 16) || 0;
        if (_hexCacheKeys.length >= _hexCacheMax) {
            var old = _hexCacheKeys.shift();
            delete _hexColorCache[old];
        }
        _hexColorCache[hex] = [r, g, b];
        _hexCacheKeys.push(hex);
        return _hexColorCache[hex];
    }

    function _rgbToHex(r, g, b) {
        r = _clamp(_round(r), 0, 255);
        g = _clamp(_round(g), 0, 255);
        b = _clamp(_round(b), 0, 255);
        return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    }

    /* Per-dab colour variation.
     *
     * Krita's HSV options, Procreate's jitter family, Clip Studio's hue,
     * saturation and value change, and Photoshop's colour dynamics are all
     * the same idea: every dab -- or every stroke -- paints a slightly
     * different colour. Four of the formats we read ask for it and the
     * engine had none of it, so four readers had to report it as lost.
     *
     * The wobble comes from the same per-position hash as scatter and the
     * tip cell, so a stroke that is drawn again comes out identical; per
     * stroke it drops the position and keeps only the stroke's own seed.
     *
     * ponytail: one set of three dials with a per-dab/per-stroke switch,
     * rather than a separate set for each. Procreate is the only format that
     * asks for both at once; give it its own set if that ever matters. */
    function _jitterColor(p, hex, x, y) {
        var hj = p.hueJitter || 0, sj = p.satJitter || 0, vj = p.valJitter || 0;
        if (!hj && !sj && !vj) return hex;
        var perDab = p.colorJitterPer !== 'stroke';
        var jx = perDab ? x : 0, jy = perDab ? y : 0;

        var rgb = _hexToRgb(hex), r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
        var mx = _max(r, _max(g, b)), mn = _min(r, _min(g, b)), d = mx - mn;
        var h = 0, sat = mx ? d / mx : 0, val = mx;
        if (d) {
            if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0));
            else if (mx === g) h = (b - r) / d + 2;
            else h = (r - g) / d + 4;
            h *= 60;
        }
        var rg = p.colorJitterRange;
        if (rg) {
            /* Clip Studio: evenly between x + lo*dial and x + hi*dial, each
             * end cut at 0 and 1 first (see _sutJitter in brush-pack.js).
             * A grey stays grey: Glitter's saturation 50 on black painted
             * greys from black to white with no tint at all. */
            var ds = d ? sj / 100 : 0;
            var sa = _clamp(sat + rg[1][0] * ds, 0, 1), sb = _clamp(sat + rg[1][1] * ds, 0, 1);
            var va = _clamp(val + rg[2][0] * vj / 100, 0, 1), vb = _clamp(val + rg[2][1] * vj / 100, 0, 1);
            h = ((h + (rg[0][0] + _dabRand(jx, jy, 31) * (rg[0][1] - rg[0][0])) * hj) % 360 + 360) % 360;
            sat = sa + _dabRand(jx, jy, 32) * (sb - sa);
            val = va + _dabRand(jx, jy, 33) * (vb - va);
        } else {
            h = (h + (_dabRand(jx, jy, 31) * 2 - 1) * hj + 360) % 360;
            sat = _clamp(sat + (_dabRand(jx, jy, 32) * 2 - 1) * (sj / 100), 0, 1);
            val = _clamp(val + (_dabRand(jx, jy, 33) * 2 - 1) * (vj / 100), 0, 1);
        }

        var c = val * sat, hh = h / 60, xx = c * (1 - _abs(hh % 2 - 1)), m = val - c;
        var t = hh < 1 ? [c, xx, 0] : hh < 2 ? [xx, c, 0] : hh < 3 ? [0, c, xx]
              : hh < 4 ? [0, xx, c] : hh < 5 ? [xx, 0, c] : [c, 0, xx];
        return _rgbToHex((t[0] + m) * 255, (t[1] + m) * 255, (t[2] + m) * 255);
    }

    /* The last (mask, colour) pair the scratch canvas was tinted for.
     *
     * Masks are bucketed, so a 300-point stroke is served by about nine
     * distinct ones and the colour is constant -- yet every dab redid the
     * clearRect + fillRect + drawImage tint. Skipping the repeats is free:
     * the scratch is a pure function of the pair, and nothing between two
     * dabs reads or writes it except the drawImage that copies it out.
     *
     * Textured dabs opt out. `_applyTextureNoise` modifies the scratch in
     * place, and now that the grain is anchored to the document its phase
     * differs at every position -- so a textured dab must always start from
     * a clean tint. */
    var _tintMask = null, _tintColor = null;

    function _colorizeMask(maskCanvas, colorHex, mode) {
        var mw = maskCanvas.width;
        var mh = maskCanvas.height;
        _ensureScratch(mw, mh);
        /* Only the corner this dab uses. The scratch is as big as the
         * largest mask the session has seen, so clearing all of it charged
         * every small dab for the biggest brush ever loaded. */
        _scratchCtx.clearRect(0, 0, mw, mh);
        mode = mode || _params.tipMode || 'alpha';
        if (mode === 'color') {
            /* The tip paints itself: its picture IS the dab, and the chosen
             * colour has no say. Krita calls this an image stamp. */
            _scratchCtx.drawImage(maskCanvas, 0, 0);
            /* A sub colour mix greys the ink: Clip Studio paints a picture's
             * darks in the ink and its lights in the sub colour, white,
             * which is screen -- c(1 - p) + p. A jitter on the sub colour
             * shades its whites instead: multiply by the jittered white.
             * Pixel by pixel, on the colour alone: a canvas blend over the
             * scratch mixes a half-clear pixel with the fill, and a picture
             * of thin lines shrunk to a dab is mostly half-clear pixels --
             * Rubble at size 40 kept 0.64 of Clip Studio's ink. */
            if (_params.subMix || _params.jitterSub) {
                var c = _hexToRgb(colorHex), id = _scratchCtx.getImageData(0, 0, mw, mh), d = id.data;
                var sm = !!_params.subMix, js = !!_params.jitterSub;
                for (var i = 0; i < d.length; i += 4) {
                    if (!d[i + 3]) continue;
                    for (var n = 0; n < 3; n++) {
                        var v = d[i + n];
                        if (sm) v = 255 - (255 - c[n]) * (255 - v) / 255;
                        if (js) v = v * c[n] / 255;
                        d[i + n] = v;
                    }
                }
                _scratchCtx.putImageData(id, 0, 0);
            }
            return;
        }
        _scratchCtx.fillStyle = colorHex;
        _scratchCtx.fillRect(0, 0, mw, mh);
        if (mode === 'lightness') {
            /* The tip's greys are lightness, not coverage: mid grey leaves
             * the colour alone, darker darkens it, lighter lightens it.
             * hard-light over the flat colour is exactly that curve. */
            _scratchCtx.globalCompositeOperation = 'hard-light';
            _scratchCtx.drawImage(maskCanvas, 0, 0);
        }
        _scratchCtx.globalCompositeOperation = 'destination-in';
        _scratchCtx.drawImage(maskCanvas, 0, 0);
        _scratchCtx.globalCompositeOperation = 'source-over';
    }

    /* Texture grains.
     *
     * There was one tile: white noise, built with Math.random(), so a textured
     * brush looked different in every session and nothing about it could be
     * reproduced or tested. The generator is seeded now, and there is a grain
     * per surface rather than one noise for everything — which is what lets a
     * chalk read as chalk and a canvas read as weave instead of all textured
     * brushes sharing the same fizz.
     *
     * Generated rather than shipped as images: these are 64x64 tiles of pure
     * pattern, and a generator is smaller than the PNGs would be. */
    var _TEX_SIZE = 64;
    var _TEX_TYPES = ['grain', 'chalk', 'canvas', 'spray', 'hatch'];
    var _texTiles = {};

    function _seededRand(seed) {
        var a = seed >>> 0;
        return function () {
            a += 0x6D2B79F5;
            var t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /* A grain the user supplied, rather than one we generated.
     *
     * Krita's Texture option paints through a pattern IMAGE, and eight of
     * David Revoy's thirty-eight brushes lean on one -- they were the single
     * biggest reason his pack did not come across. A pattern lands here as a
     * tile in exactly the shape `_texTile` produces (opaque grey, dark means
     * more bite) so everything downstream is indifferent to where its grain
     * came from. A Krita import (textureMode set) reads the same tile
     * through _kritaTexMask instead, brightness/contrast/invert included. */
    var _patTiles = {};
    var _patWanted = null;
    /* Which imported pattern tiles are removal masks (sparse specks living
     * in the alpha channel, e.g. CSP paper grain) rather than opaque RGB
     * noise. Keyed by tile canvas like _texPatterns, so entries die with
     * their tiles and generated grain (never inserted) keeps the tint path. */
    var _patIsMask = new WeakMap();

    function _grainTile(type) {
        if (_patWanted && _patTiles[_patWanted]) return _patTiles[_patWanted];
        return _texTile(type);
    }

    /* A tip or paper is its bytes. Krita reads a PNG's pixels as they are,
     * its colour profile ignored; the browser applies it, and square_rough.png's
     * GIMP profile took a third off Waterpaint Hard Edges' eroding tip. */
    function _drawRaw(img, use) {
        createImageBitmap(img, { colorSpaceConversion: 'none' }).then(use, function () { use(img); });
    }

    /* Defined locally and published next to the other engine methods: this
     * sits far above `var engine`, and assigning onto it here would throw at
     * module evaluation and take the whole brush engine down with it. */
    function _loadTexturePattern(url, forPreset) {
        if (!url) { _patWanted = null; return; }
        if (_patTiles[url]) { _patWanted = url; return; }
        var img = new Image();
        _pendingLoads.push(img);
        function done() {
            var i = _pendingLoads.indexOf(img);
            if (i >= 0) _pendingLoads.splice(i, 1);
        }
        img.onerror = done;
        img.onload = function () { _drawRaw(img, function (img) {
            try {
                var oc = new OffscreenCanvas(img.width, img.height);
                oc.getContext('2d').drawImage(img, 0, 0);
                _patTiles[url] = oc;
                /* One-time mask check: a paper-grain tile carries its specks
                 * in the alpha channel over transparency (mean well under
                 * opaque); an RGB noise tile is fully opaque. Sampled, not
                 * exhaustive — a 300px tile costs ~22k adds, once per import. */
                try {
                    var _pd = oc.getContext('2d').getImageData(0, 0, oc.width, oc.height).data;
                    var _as = 0, _an = 0;
                    for (var _ai = 3; _ai < _pd.length; _ai += 16) { _as += _pd[_ai]; _an++; }
                    _patIsMask.set(oc, _an > 0 && (_as / _an) < 250);
                } catch (_me) { /* unreadable tile keeps the tint path */ }
                /* Same trap the tips hit: the image arrives whenever it
                 * arrives, and by then the user may be on another brush.
                 * A late pattern must not grain somebody else's paint. */
                if (!forPreset || forPreset === engine._currentPreset) {
                    _patWanted = url;
                    _invalidateSwatch(forPreset);
                }
            } catch (e) { /* a pattern that will not decode just stays absent */ }
            done();
        }); };
        // an imported paper is filed away like a tip (Clip Studio's are 1001px)
        _tipResolve(url, function (u) { if (u) img.src = u; else done(); });
    }

    /* Krita's Texture option, to the letter (KisTextureMaskInfo::
     * recalculateMask and KisMaskingBrushCompositeOp.h). The pattern becomes
     * a mask m: grey (r*11 + g*16 + b*5)/32 over white where transparent,
     * minus brightness, contrast about 0.5, then inverted if asked. With
     * strength s it then cuts the dab's alpha a:
     *   multiply   a*m*s             soft: a*(m + (1-s)(1-m))
     *   subtract   a - (m + 1 - s)   soft: a - m*s
     * Anchored to the canvas, so the grain stays put under the stroke.
     * Returns false when the pattern has not arrived yet.
     *
     * ponytail: CPU per dab (one getImageData each); a GPU pass would be
     * the upgrade if huge textured brushes get slow. Neutral point and
     * pattern offsets are not modelled; the importer warns about them. */
    var _ktMask = null;
    function _kritaTexMask(p) {
        var tile = _patWanted && _patTiles[_patWanted];
        if (!tile) return null;
        var sc = p.textureScale || 1;
        var cut = p.textureCutoff || 0, lo = p.textureCutoffLo || 0, hi = p.textureCutoffHi == null ? 255 : p.textureCutoffHi;
        var key = _patWanted + '|' + sc + '|' + p.textureBrightness + '|' + p.textureContrast + '|' + !!p.textureInvert +
            '|' + cut + '|' + lo + '|' + hi;
        if (_ktMask && _ktMask.key === key) return _ktMask;
        var w = _max(2, _round(tile.width * sc)), h = _max(2, _round(tile.height * sc));
        var c = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }), d;
        if (sc > 1) {
            /* Enlarged, Qt's smooth scale is plain bilinear between pixel
             * centres, clamped at the edge: a lone Krita dab over
             * texture_fabric's 1.47 pattern divided by the bare dab is that
             * to half a grey level; the canvas's own filter is 3.8 off. */
            var tw = tile.width, th = tile.height;
            c.drawImage(tile, 0, 0);
            var s0 = c.getImageData(0, 0, tw, th).data;
            d = new Uint8ClampedArray(w * h * 4);
            for (var yy = 0; yy < h; yy++) {
                var Y = _clamp((yy + 0.5) * th / h - 0.5, 0, th - 1), y0 = _floor(Y), y1 = _min(y0 + 1, th - 1), fy = Y - y0;
                for (var xx = 0; xx < w; xx++) {
                    var X = _clamp((xx + 0.5) * tw / w - 0.5, 0, tw - 1), x0 = _floor(X), x1 = _min(x0 + 1, tw - 1), fx = X - x0;
                    var q00 = (y0 * tw + x0) * 4, q01 = (y0 * tw + x1) * 4, q10 = (y1 * tw + x0) * 4, q11 = (y1 * tw + x1) * 4, o = (yy * w + xx) * 4;
                    for (var ch = 0; ch < 4; ch++) {
                        d[o + ch] = (s0[q00 + ch] * (1 - fx) + s0[q01 + ch] * fx) * (1 - fy) + (s0[q10 + ch] * (1 - fx) + s0[q11 + ch] * fx) * fy;
                    }
                }
            }
        } else if (sc < 1) {
            /* Shrunk, Qt's smooth scale averages each pixel's footprint
             * (area, not the canvas's own filter), one axis then the other. */
            var tw2 = tile.width, th2 = tile.height;
            c.canvas.width = tw2; c.canvas.height = th2;
            c.drawImage(tile, 0, 0);
            var s1 = c.getImageData(0, 0, tw2, th2).data, t = new Float32Array(w * th2 * 4);
            var box = function (n, N, i, f) {   // footprint of i in 0..n over 0..N, f(index, weight)
                var a = i * N / n, b = (i + 1) * N / n;
                for (var k = _floor(a); k < b && k < N; k++) f(k, (_min(b, k + 1) - _max(a, k)) * n / N);
            };
            for (var ry = 0; ry < th2; ry++) for (var cx = 0; cx < w; cx++) {
                var o1 = (ry * w + cx) * 4;
                box(w, tw2, cx, function (k, wt) { var q = (ry * tw2 + k) * 4; for (var ch = 0; ch < 4; ch++) t[o1 + ch] += s1[q + ch] * wt; });
            }
            d = new Uint8ClampedArray(w * h * 4);
            for (var cy2 = 0; cy2 < h; cy2++) for (var cx2 = 0; cx2 < w; cx2++) {
                var o2 = (cy2 * w + cx2) * 4, acc = [0, 0, 0, 0];
                box(h, th2, cy2, function (k, wt) { var q = (k * w + cx2) * 4; for (var ch = 0; ch < 4; ch++) acc[ch] += t[q + ch] * wt; });
                for (var ch2 = 0; ch2 < 4; ch2++) d[o2 + ch2] = _round(acc[ch2]);
            }
        } else {
            c.drawImage(tile, 0, 0, w, h);
            d = c.getImageData(0, 0, w, h).data;
        }
        var m = new Uint8Array(w * h);
        var br = p.textureBrightness || 0, ct = p.textureContrast == null ? 1 : p.textureContrast;
        for (var i = 0; i < m.length; i++) {
            var a = d[i * 4 + 3] / 255;
            var g = ((d[i * 4] * 11 + d[i * 4 + 1] * 16 + d[i * 4 + 2] * 5) >> 5) / 255;
            var v = _clamp(((g * a + 1 - a) - br - 0.5) * ct + 0.5, 0, 1);
            /* Cutoff, measured on Krita's renders of a grey ramp
             * (test/krita/probes/texture): outside [lo, hi] of the pattern's
             * grey, policy 1 reads it as black and 2 as white; inside, and
             * under policy 0, nothing changes. The range tests the grey
             * after Invert (KisTextureMaskInfo): tested before it, Natural
             * Media Pastel's inverted paper cut every pixel and painted nothing.
             * ponytail: brightness/contrast against the cutoff unmeasured. */
            if (p.textureInvert) v = 1 - v;
            if (cut) {
                var gv = v * 255;
                if (gv < lo || gv > hi) v = cut === 1 ? 0 : 1;
            }
            m[i] = _round(v * 255);
        }
        _ktMask = { key: key, w: w, h: h, m: m };
        return _ktMask;
    }
    /* Krita's hatching brush (HatchingBrush::hatch). Each dab draws its own
     * lines across its own box -- Krita's dab rect: the cursor less half the
     * size, floored, and as wide as that fraction plus the size, rounded up
     * -- one every `sep` px along the normal from the line through the
     * origin, edge to edge. A line's ends are rounded to whole pixels and it
     * is drawn with KisPainter::drawThickLine (anti-aliased) or drawLine,
     * each pixel composited over the last in 8 bits. The dab's mask then cuts
     * the box, and the lines are the dab's alpha: every dab's line rounds its
     * ends a little differently, and alpha darken builds each one's soft edge
     * toward the full opacity, so a 1px line lands about 2px solid (low01). */
    var _hatchT = 1, _hatchSep = 6, _hatchD = 1, _hatchAsp = 1, _hatchX = -1, _hatchBuf = new Uint8Array(4096);
    function _hq(v) { return _floor(v + 0.5); }   // qRound
    function _hput(W, H, x, y, a) {   // COMPOSITE_OVER, one pixel, 8 bits
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        var i = y * W + x, d = _hatchBuf[i], t = a * d + 0x80;
        _hatchBuf[i] = a + d - (((t >> 8) + t) >> 8);
    }
    function _hmix(W, H, x, y, b) {   // opacity b over what is there, as drawThickLine blends it
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        _hput(W, H, x, y, _clamp(_hq(Math.fround(b + (1 - b) * _hatchBuf[y * W + x] / 255) * 255), 0, 255));
    }
    function _hThick(W, H, sx, sy, ex, ey, T) {
        var f = Math.fround, i, t;
        var tp = T >> 1, tn = (T >> 1) - (T % 2 ? 0 : 1), thin = T === 1;
        var x0 = _hq(sx), y0 = _hq(sy), x1 = _hq(ex), y1 = _hq(ey);
        var hor = _abs(x1 - x0) > _abs(y1 - y0);
        var x0a = x0, y0a = y0, x0b = x0, y0b = y0, x1a = x1, y1a = y1, x1b = x1, y1b = y1;
        if (hor) { y0a -= tn; y0b += tp; y1a -= tn; y1b += tp; }
        else { x0a -= tn; x0b += tp; x1a -= tn; x1b += tp; }
        if (hor) {
            for (i = y0a; i <= y0b; i++) _hput(W, H, x0, i, 255);
            for (i = y1a; i <= y1b; i++) _hput(W, H, x1, i, 255);
        } else {
            for (i = x0a; i <= x0b; i++) _hput(W, H, i, y0, 255);
            for (i = x1a; i <= x1b; i++) _hput(W, H, i, y1, 255);
        }
        if (x1 !== x0 && y1 !== y0) {
            if (hor) { _hmix(W, H, x0a, y0a - 1, 0.25); _hmix(W, H, x1b, y1b + 1, 0.25); }
            else { _hmix(W, H, x0a - 1, y0a, 0.25); _hmix(W, H, x1b + 1, y1b, 0.25); }
        }
        var ga, gb, fa, fb, k, lo, hi;
        if (hor) {
            ga = f((y1a - y0a) / (x1a - x0a)); gb = f((y1b - y0b) / (x1b - x0b));
            if (x1 < x0) { t = x0; x0 = x1; x1 = t; y0a = y1a; y0b = y1b; }
            fa = f(y0a + ga); fb = f(y0b + gb);
            for (k = x0 + 1; k <= x1 - 1; k++) {
                lo = _floor(fa); hi = _floor(fb);
                _hmix(W, H, k, lo, 1 - (fa - lo));
                if (!thin) _hmix(W, H, k, hi, 1 - (fb - hi));
                if (ga !== 0 && ga !== 1) _hmix(W, H, k, lo + 1, fa - lo);
                if (gb !== 0 && gb !== 1 && !thin) _hmix(W, H, k, hi + 1, fb - hi);
                if (!thin) {
                    if (fa < fb) for (i = lo + 1; i <= hi; i++) _hput(W, H, k, i, 255);
                    else for (i = lo + 1; i >= hi; i--) _hput(W, H, k, i, 255);
                }
                fa = f(fa + ga); fb = f(fb + gb);
            }
        } else {
            ga = f((x1a - x0a) / (y1a - y0a)); gb = f((x1b - x0b) / (y1b - y0b));
            if (y1 < y0) { t = y0; y0 = y1; y1 = t; x0a = x1a; x0b = x1b; }
            fa = f(x0a + ga); fb = f(x0b + gb);
            for (k = y0 + 1; k <= y1 - 1; k++) {
                lo = _floor(fa); hi = _floor(fb);
                _hmix(W, H, lo, k, 1 - (fa - lo));
                if (!thin) _hmix(W, H, hi, k, 1 - (fb - hi));
                if (ga !== 0 && ga !== 1) _hmix(W, H, lo + 1, k, fa - lo);
                if (gb !== 0 && gb !== 1 && !thin) _hmix(W, H, hi + 1, k, fb - hi);
                if (!thin) {
                    if (fa < fb) for (i = lo + 1; i <= hi; i++) _hput(W, H, i, k, 255);
                    else for (i = hi; i <= lo + 1; i++) _hput(W, H, i, k, 255);
                }
                fa = f(fa + ga); fb = f(fb + gb);
            }
        }
    }
    function _hLine(W, H, sx, sy, ex, ey, w) {   // KisPainter::drawLine, not anti-aliased
        var x1 = _floor(sx), y1 = _floor(sy), x2 = _floor(ex), y2 = _floor(ey);
        if (x1 === x2 && y1 === y2) return;
        var dX = x2 - x1, dY = y2 - y1, uni = dX * y1 - dY * x1, pd = 1 / (dX * dX + dY * dY);
        var hw = w * 0.5 + (_abs(dX) > _abs(dY) ? sx - x1 : sy - y1), R = _hq(hw) + 1, den = 1 / Math.sqrt(dX * dX + dY * dY);
        var lx = _min(x1, x2), hx = _max(x1, x2), ly = _min(y1, y2), hy = _max(y1, y2);
        for (var y = ly - R; y < hy + R; y++) for (var x = lx - R; x < hx + R; x++) {
            var pr = ((x - x1) * dX + (y - y1) * dY) * pd, qx = x1 + pr * dX, qy = y1 + pr * dY;
            var dd = qx < lx || qx > hx || qy < ly || qy > hy
                ? _min(_hypot(x - x1, y - y1), _hypot(x - x2, y - y2)) : _abs(dY * x - dX * y + uni) * den;
            if (dd <= hw) _hput(W, H, x, y, 255);
        }
    }
    var _hXs = [], _hYs = [];
    function _hRound(v) { return v - _floor(v) >= 0.5 ? _ceil(v) : _floor(v); }   // myround
    function _hSpin(a, spin) {   // KisHatchingPaintOp::spinAngle
        var t = a + spin, s = t < 0 ? -1 : 1;
        t = _abs(t % 180);
        return t <= 90 ? s * t : s * -(180 - t);
    }
    function _hatchInto(W, H, x, y, ang, sep, T, P) {
        var draw = function (ax, ay, bx, by) { if (P.aa) _hThick(W, H, ax, ay, bx, by, T); else _hLine(W, H, ax, ay, bx, by, T); };
        var run;
        if (ang === 90 || ang === -90) {
            var hot = (P.ox - x) % sep;
            run = function (fwd, idx, one) {
                for (; ; idx++) {
                    var v = fwd ? hot + sep * idx : hot - sep * idx, yd = H;
                    if (v < 0 || v > W) break;
                    if (P.whole) { v = _hRound(v); yd = _hRound(yd); }
                    draw(v, 0, v, yd);
                    if (one) break;
                }
            };
        } else {
            var sl = Math.tan(ang * _PI / 180), dy = _abs(sep / _cos(ang * _PI / 180));
            if (P.whole) dy = Math.trunc(dy);
            var hotI = ((P.oy - sl * P.ox) - (y - sl * x)) % dy;
            run = function (fwd, idx, one) {
                for (; ; idx++) {
                    var b = fwd ? hotI + dy * idx : hotI - dy * idx, xs = _hXs, ys = _hYs;
                    xs.length = ys.length = 0;
                    if (b >= 0 && b <= H) { xs.push(0); ys.push(b); }
                    if (sl * W + b <= H && sl * W + b >= 0) { xs.push(W); ys.push(b + sl * W); }
                    if (-b / sl > 0 && -b / sl < W) { xs.push(-b / sl); ys.push(0); }
                    if ((H - b) / sl > 0 && (H - b) / sl < W) { xs.push((H - b) / sl); ys.push(H); }
                    if (!xs.length) break;
                    if (xs.length !== 2) continue;   // a corner, or worse: Krita skips it
                    if (P.whole) { xs[0] = _hRound(xs[0]); xs[1] = _hRound(xs[1]); ys[0] = _hRound(ys[0]); ys[1] = _hRound(ys[1]); }
                    draw(xs[0], ys[0], xs[1], ys[1]);
                    if (one) break;
                }
            };
        }
        run(true, 1, false); run(true, 0, true); run(false, 1, false);
    }
    function _applyHatch(ctx, w, h, ox, oy, p, cx, cy) {
        var P = p.hatch, T = _max(1, _hq(_hatchT));
        var dw = _max(1, _hatchD), dh = _max(1, _hatchD / _hatchAsp);
        if (_hatchAsp < 1) { dw = _max(1, _hatchD * _hatchAsp); dh = _max(1, _hatchD); }
        var px = cx - dw / 2, py = cy - dh / 2, bx = _floor(px), by = _floor(py);
        var W = _max(1, _ceil(px - bx + dw - 1e-6)), H = _max(1, _ceil(py - by + dh - 1e-6));
        if (_hatchBuf.length < W * H) _hatchBuf = new Uint8Array(W * H * 2);
        _hatchBuf.fill(0, 0, W * H);
        // KisHatchingPaintOp::paintAt's passes: X is the crosshatching sensor, or -1 with the option off
        var X = _hatchX, S = P.style, pass = function (spin) { _hatchInto(W, H, bx, by, _hSpin(P.angle, spin), _hatchSep, T, P); };
        if (S === 'perpendicular' && (X < 0 || X > 0.5)) pass(90);
        else if (S === 'minusthenplus' || S === 'plusthenminus') {
            var s1 = S === 'minusthenplus' ? -45 : 45;
            if (X < 0 || X > 0.33) pass(s1);
            if (X < 0 || X > 0.67) pass(-s1);
        } else if (S === 'moirepattern') pass(X < 0 ? -10 : X * 360);
        if (S !== 'moirepattern') _hatchInto(W, H, bx, by, P.angle, _hatchSep, T, P);
        var img = ctx.getImageData(0, 0, w, h), d = img.data;
        for (var j = 0; j < h; j++) {
            var yy = oy + j - by;
            for (var i = 0; i < w; i++) {
                var o = (j * w + i) * 4;
                if (!d[o + 3]) continue;
                var xx = ox + i - bx, c = xx >= 0 && yy >= 0 && xx < W && yy < H ? _hatchBuf[yy * W + xx] / 255 : 0;
                d[o + 3] = _round(d[o + 3] * c);
            }
        }
        ctx.putImageData(img, 0, 0);
    }
    /* Krita's grid brush, from the bank's own render (Grid_square_25): the
     * canvas is cut into gridWidth x gridHeight cells, and every
     * gridWidth px along the stroke -- from its first point, never at its
     * last -- a dab is laid (_gridCell).
     * ponytail: ellipse and rectangle only; no borders, colour options or
     * pressure division (the importer warns). */
    var _gridSt = null, _gridMask = null;
    /* A 1px sharp tip (Pixel Art's pixel1) draws a pixel line: Krita snaps
     * the stroke's start to the pixel grid (a half rounds down) and steps a
     * whole pixel along the stroke's major axis, rounding a half across it
     * up. Measured (test/krita/probes/pixel), 32 lines at quarter-pixel
     * offsets, every direction: all match to the pixel. Unsnapped, a
     * shallow diagonal sat a row off along half its length. */
    var _pxOff = null;
    function _gridDab(p, x, y, color) {
        var G = p.grid, gw = G.w * G.scale, st = _gridSt;
        if (!st) { st = _gridSt = { x: x, y: y, acc: 0, next: gw, seen: {} }; _gridCell(p, x, y, color); return; }
        var d = Math.hypot(x - st.x, y - st.y);
        while (d > 0 && st.acc + d > st.next + 1e-6) {
            var t = (st.next - st.acc) / d;
            _gridCell(p, st.x + (x - st.x) * t, st.y + (y - st.y) * t, color);
            st.next += gw;
        }
        st.acc += d; st.x = x; st.y = y;
    }
    /* kis_grid_paintop.cpp: a dab covers the brush's diameter (our size),
     * its corner snapped to the cell grid (fmod, so toward zero), cut into
     * cell/divisionLevel tiles. A rectangle tile is filled at whole pixels
     * truncated from its corner and size -- a 3px cell in halves fills
     * "##." (HatiGamedev's pixel vertical-rect). Each tile once a stroke. */
    function _gridCell(p, x, y, color) {
        var G = p.grid, cw = G.w * G.scale, ch = G.h * G.scale, D = _max(1, p.size) * G.scale;
        var px = x - D / 2 + cw / 2, py = y - D / 2 + ch / 2;
        px -= px % cw; py -= py % ch;
        var n = _max(1, _round(G.scale * G.div)), xs = cw / n, ys = ch / n, rect = G.shape === 1;
        var mw = rect ? _max(1, ~~xs) : _max(1, _ceil(xs) + 1), mh = rect ? _max(1, ~~ys) : _max(1, _ceil(ys) + 1);
        for (var j = 0; j < D / ys; j++) for (var i = 0; i < D / xs; i++) {
            var tx = px + i * xs, ty = py + j * ys, ix = rect ? ~~tx : _floor(tx), iy = rect ? ~~ty : _floor(ty);
            var key = ix + ',' + iy;
            if (_gridSt.seen[key]) continue;
            _gridSt.seen[key] = 1;
            var fx = rect ? 0 : tx - ix, fy = rect ? 0 : ty - iy;
            var mk = mw + ',' + mh + ',' + xs + ',' + ys + ',' + fx + ',' + fy + ',' + rect;
            if (!_gridMask || _gridMask._key !== mk) {
                var c = new OffscreenCanvas(mw, mh), g = c.getContext('2d');
                g.fillStyle = '#fff';
                if (rect) g.fillRect(0, 0, mw, mh);
                else { g.beginPath(); g.ellipse(fx + xs / 2, fy + ys / 2, xs / 2, ys / 2, 0, 0, 2 * _PI); g.fill(); }
                c._cx = 0; c._cy = 0; c._key = mk;
                _gridMask = c;
            }
            _paintDab(_flowCtx, ix, iy, _gridMask, color, _clamp(p.flow / 100, 0, 1), 0);
        }
    }
    /* Krita's spray (kis_spray_paintop.cpp, spray_brush.cpp). Every
     * diameter/2 * spacing px of the stroke -- the size sensor plays no part
     * in it -- a dab of particles thrown over a disc of the diameter times
     * the size sensor, stretched by Spray/scale and squashed by its aspect.
     * Each is a shape (SprayShape on) or the brush tip at its own size,
     * either times a random scale; all of a dab's particles pile up over
     * each other and the pile is laid down as one dab. A random opacity is
     * the particle's colour AND its painter's, so it lands squared. Shares
     * the grid's stepping state: no brush is both.
     * ponytail: positions come from our position hash, not Krita's random
     * source -- same spread, other specks. No colour options, curve or
     * cluster distributions, wu-particles (painted as pixels) or images. */
    var _ksBuf = new Float32Array(6 * 256), _ksCanvas = null, _ksCtx = null;
    function _ksprayDab(p, x, y, color, sc, hard, asp, strokeAngle) {
        var K = p.kspray, D = _max(1, p.size), st = _gridSt;
        var step = D / 2 > 1 ? _max(0.5, D / 2 * K.spacing) : 1;
        if (!st) { _gridSt = { x: x, y: y, acc: 0, next: step }; _ksprayAt(p, x, y, color, sc, hard, asp, strokeAngle, D); return; }
        var d = Math.hypot(x - st.x, y - st.y);
        while (d > 0 && st.acc + d > st.next + 1e-6) {
            var t = (st.next - st.acc) / d;
            _ksprayAt(p, st.x + (x - st.x) * t, st.y + (y - st.y) * t, color, sc, hard, asp, strokeAngle, D);
            st.next += step;
        }
        st.acc += d; st.x = x; st.y = y;
    }
    function _ksprayAt(p, x, y, color, sc, hard, asp, strokeAngle, D) {
        var K = p.kspray, k = 101, R = D / 2 * _dyn(p, 'size', 1, sc, 1);
        if (K.jitter) {
            x += (2 * R * _dabRand(x, y, 99) - R) * K.jitter;
            y += (2 * R * _dabRand(x, y, 100) - R) * K.jitter;
        }
        var n = _min(20000, ~~(K.density ? K.density * _PI * R * R : K.count));
        if (!n) return;
        if (_ksBuf.length < n * 6) _ksBuf = new Float32Array(n * 6);
        var B = _ksBuf, ra = K.rot - (_dynAngle(p, p.angle || 0, sc) - (p.angle || 0)) * _PI / 180,
            mc = _cos(ra) * K.scale, ms = _sin(ra) * K.scale, da = (strokeAngle || 0) * _PI / 180,
            ew = K.prop ? _round(K.w * D * K.scale / 100) : K.w, eh = K.prop ? _round(K.h * D * K.scale / 100) : K.h,
            x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, al = 1;
        for (var i = 0; i < n; i++) {
            var ang = _dabRand(x, y, k++) * 2 * _PI, u = _dabRand(x, y, k++), len;
            if (K.radial === 0) len = u;
            else if (K.radial === 1) len = Math.sqrt(u);
            else {
                // a half-normal (Box-Muller) and its polar form, a Rayleigh, both cut at 5 sd
                len = K.radial === 2 ? Math.abs(K.sd * Math.sqrt(-2 * Math.log(1 - u)) * _cos(2 * _PI * _dabRand(x, y, k++)))
                    : K.sd * Math.sqrt(-2 * Math.log(1 - u));
                len = _min(len, 5 * K.sd);
            }
            var rz = K.fixedRot, ps = 1;
            if (K.randomRot) rz += (2 * _PI * _dabRand(x, y, k++) - rz) * K.randomRot;
            if (K.followCursor) rz += (ang - rz) * K.followCursor;
            if (K.followDrawing) rz += (da - rz) * K.followDrawing;
            if (K.randomSize) ps = _dabRand(x, y, k++);
            if (K.randomOpacity && (K.perParticle || !i)) { al = _dabRand(x, y, k++); al *= al; }
            var nx = R * _cos(ang) * len, ny = R * _sin(ang) * len * K.aspect,
                px = x + nx * mc - ny * ms, py = y + nx * ms + ny * mc;
            var a = K.shape < 0 ? K.tip * ps : _max(1, ew * ps), b = K.shape < 0 ? a : _max(1, eh * ps),
                m = (K.shape < 0 ? 0.75 * a : 0.71 * _max(a, b)) + 2;
            B[i * 6] = px; B[i * 6 + 1] = py; B[i * 6 + 2] = a; B[i * 6 + 3] = b; B[i * 6 + 4] = rz; B[i * 6 + 5] = al;
            if (px - m < x0) x0 = px - m; if (px + m > x1) x1 = px + m;
            if (py - m < y0) y0 = py - m; if (py + m > y1) y1 = py + m;
        }
        x0 = _floor(x0); y0 = _floor(y0);
        var w = _ceil(x1 - x0), h = _ceil(y1 - y0);
        if (!_ksCanvas) { _ksCanvas = new OffscreenCanvas(w, h); _ksCtx = _ksCanvas.getContext('2d'); }
        if (_ksCanvas.width !== w || _ksCanvas.height !== h) { _ksCanvas.width = w; _ksCanvas.height = h; }
        else _ksCtx.clearRect(0, 0, w, h);
        var g = _ksCtx;
        g.fillStyle = '#fff';
        for (i = 0; i < n; i++) {
            px = B[i * 6] - x0; py = B[i * 6 + 1] - y0; a = B[i * 6 + 2]; b = B[i * 6 + 3]; rz = B[i * 6 + 4];
            g.globalAlpha = B[i * 6 + 5];
            if (K.shape < 0) {
                if (a < 0.05) continue;
                if (p.shape === 'custom') _pickTipCell(p, B[i * 6], B[i * 6 + 1]);
                var mk = _maskFor(p.shape, a, hard, (p.angle || 0) - rz * 180 / _PI, asp, B[i * 6], B[i * 6 + 1]);
                if (mk && (p.tipDensity < 1 || p.tipRandomness)) mk = _noisyMask(mk, B[i * 6], B[i * 6 + 1], p);
                if (mk) g.drawImage(mk, px - (mk._cx != null ? mk._cx : mk.width / 2), py - (mk._cy != null ? mk._cy : mk.height / 2));
            } else if (K.shape === 0) {
                g.beginPath();
                // equal sizes are Krita's circle, which ignores the particle's turn
                g.ellipse(px, py, a / 2, (ew === eh ? a : b) / 2, ew === eh ? 0 : rz, 0, 2 * _PI);
                g.fill();
            } else if (K.shape === 1) {
                g.setTransform(_cos(rz), _sin(rz), -_sin(rz), _cos(rz), px, py);
                g.fillRect(-_round(a) / 2, -_round(b) / 2, _round(a), _round(b));
                g.setTransform(1, 0, 0, 1, 0, 0);
            } else if (K.shape < 4) g.fillRect(_round(px), _round(py), 1, 1);
        }
        g.globalAlpha = 1;
        _ksCanvas._cx = x - x0; _ksCanvas._cy = y - y0;
        _tintMask = null;   // the same canvas, redrawn
        _paintDab(_flowCtx, x, y, _ksCanvas, color, _clamp(_dyn(p, 'flow', p.flow / 100, sc, 4), 0, 1), 0);
    }
    function _applyKritaTexture(ctx, w, h, ox, oy, s, p) {
        var t = _kritaTexMask(p);
        if (!t) return false;
        s = _clamp(s, 0, 1);
        var img = ctx.getImageData(0, 0, w, h), d = img.data;
        // KisTextureOption::apply reads the pattern at the canvas less its offset
        var x0 = _round(ox) - (p.textureOffsetX || 0), y0 = _round(oy) - (p.textureOffsetY || 0);
        for (var j = 0; j < h; j++) {
            var row = (((y0 + j) % t.h) + t.h) % t.h * t.w;
            for (var i = 0; i < w; i++) {
                var k = (j * w + i) * 4 + 3, a = d[k];
                if (!a) continue;
                a = _kritaTexCut(a, t.m[row + (((x0 + i) % t.w) + t.w) % t.w] / 255, s, p);
                d[k] = a < 0 ? 0 : a;
            }
        }
        ctx.putImageData(img, 0, 0);
        return true;
    }
    /* One texel's cut on a dab alpha a (0-255), texture m (0-1), strength s.
     * Height (mode 12), measured on lone dabs (test/krita/probes/texmode):
     * with u = 1 - s, a/u - u - m * 0.5/neutral, in 0-1 units -- the tip
     * rises with strength until the grain can no longer reach it. */
    function _kritaTexCut(a, m, s, p) {
        if (p.textureMode === 'height') {
            var u = 1 - s;
            if (u <= 0) return a > 0 ? 255 : 0;
            return (a / 255 / u - u - m * 0.5 / (p.textureNeutral || 0.5)) * 255;
        }
        if (p.textureMode === 'subtract') return p.textureSoft ? a - m * s * 255 : a - (m + 1 - s) * 255;
        return p.textureSoft ? a * (m + (1 - s) * (1 - m)) : a * m * s;
    }

    function _texTile(type) {
        var key = type || 'grain';
        if (_texTiles[key]) return _texTiles[key];

        var N = _TEX_SIZE;
        var c = new OffscreenCanvas(N, N);
        var ctx = c.getContext('2d');
        var rnd = _seededRand(0x9E3779B9);
        var img = ctx.createImageData(N, N);
        var d = img.data;
        var x, y, i, v;

        function put(px, py, val) {
            var o = ((py + N) % N * N + (px + N) % N) * 4;
            d[o] = d[o + 1] = d[o + 2] = val;
            d[o + 3] = 255;
        }

        if (key === 'chalk') {
            // Low-frequency clumps: soft blotches rather than even fizz.
            var field = new Float32Array(N * N);
            for (i = 0; i < 90; i++) {
                var cx = rnd() * N, cy = rnd() * N, r = 3 + rnd() * 9;
                for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
                    var dx = _min(_abs(x - cx), N - _abs(x - cx));
                    var dy = _min(_abs(y - cy), N - _abs(y - cy));
                    var dd = _hypot(dx, dy);
                    if (dd < r) field[y * N + x] += (1 - dd / r);
                }
            }
            for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
                v = _clamp(70 + field[y * N + x] * 90, 0, 255);
                put(x, y, v | 0);
            }
        } else if (key === 'canvas') {
            // Over-under weave.
            for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
                var warp = _sin(x / N * _PI * 16) * 0.5 + 0.5;
                var weft = _sin(y / N * _PI * 16) * 0.5 + 0.5;
                var w = ((x >> 2) + (y >> 2)) % 2 === 0 ? warp : weft;
                put(x, y, (110 + w * 120 + rnd() * 18) | 0);
            }
        } else if (key === 'spray') {
            // Sparse specks on a light ground.
            for (y = 0; y < N; y++) for (x = 0; x < N; x++) put(x, y, 236);
            for (i = 0; i < 340; i++) {
                put((rnd() * N) | 0, (rnd() * N) | 0, (30 + rnd() * 70) | 0);
            }
        } else if (key === 'hatch') {
            // Crossed diagonals.
            for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
                var a1 = (x + y) % 9 < 2 ? 1 : 0;
                var a2 = (x - y + N) % 13 < 2 ? 1 : 0;
                put(x, y, (245 - (a1 + a2) * 78 - rnd() * 20) | 0);
            }
        } else {
            // grain — the original white noise, now reproducible.
            for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
                put(x, y, _floor(rnd() * 200 + 28));
            }
        }

        ctx.putImageData(img, 0, 0);
        _texTiles[key] = c;
        return c;
    }

    function _texTileForTest(t) { return _texTile(t); }

    /* One CanvasPattern per grain, not one per dab.
     *
     * This used to call createPattern on every textured dab -- an allocation
     * in the hot loop, which AGENTS.md forbids outright. A pattern is not
     * bound to the context that made it, so one per tile type is enough even
     * though the scratch context is rebuilt whenever the scratch canvas
     * resizes. */
    var _texPatterns = new WeakMap();

    function _texPattern(ctx, tile) {
        var p = _texPatterns.get(tile);
        if (!p) { p = ctx.createPattern(tile, 'repeat'); _texPatterns.set(tile, p); }
        return p;
    }

    /* ponytail: quick polarity flip for mask tiles, requested to check
     * against CSP.png — speck alpha inverted (255-a) once per tile, cached
     * like the pattern itself. Revert by making _applyTextureNoise use
     * `tile` instead of `_invertedTile(tile)` again. */
    var _texInverted = new WeakMap();
    /* Contrast on the speck values themselves, not a multiplier on top of
     * them: the destination-out strength below is already clamped at 1 (full
     * removal at full speck density), so once a brush's own texture dial is
     * anywhere near 60-100 that multiplier is already saturated and has no
     * headroom left to push darker/more contrasty -- confirmed directly,
     * not assumed (two different multiplier values that both landed above
     * 1 after clamping rendered pixel-identical). Squaring the speck alpha
     * (gamma 2) spreads the distribution instead: faint paper noise gets
     * pushed further toward "barely removes anything" while the strong
     * specks stay close to full strength, so the punched holes read
     * starker against the untouched ink instead of a uniform light peppering. */
    var _TEX_CONTRAST_GAMMA = 2.4;
    function _invertedTile(tile) {
        var inv = _texInverted.get(tile);
        if (inv) return inv;
        inv = new OffscreenCanvas(tile.width, tile.height);
        var ictx = inv.getContext('2d');
        ictx.drawImage(tile, 0, 0);
        var id = ictx.getImageData(0, 0, tile.width, tile.height);
        var d = id.data;
        for (var i = 3; i < d.length; i += 4) {
            var v = (255 - d[i]) / 255;
            d[i] = _round(Math.pow(v, _TEX_CONTRAST_GAMMA) * 255);
        }
        ictx.putImageData(id, 0, 0);
        _texInverted.set(tile, inv);
        return inv;
    }

    /* Grain belongs to the paper, not to the brush.
     *
     * The grain was tiled onto the dab's own scratch canvas, whose origin
     * moves with the cursor -- so the texture slid along under the stroke and
     * the same patch of canvas grained differently depending on which way you
     * crossed it. Krita anchors texture to the canvas, and the dual tip here
     * already does (`_dualTile` works in document coordinates) for exactly
     * this reason. Offsetting the pattern by the dab's document origin buys
     * the same anchoring without a document-sized buffer.
     *
     * The phase is taken modulo the tile so a dab at x=30000 shifts the
     * pattern by the same sub-tile amount as one at x=30, without handing
     * the rasteriser a huge translate to lose precision in. */
    /* How coarse the paper reads, on top of what the brush's own dial asks
     * for. The dial says how many tile-widths fit across the stroke; this says
     * how big a tile-width actually is, and there is nothing in a .sut that
     * pins it -- Clip Studio renders its papers against its own canvas
     * resolution, not ours. So it is a calibration knob, set by eye against
     * CSP.png and then by the user against real strokes (1.71 -> 2.05, "a bit
     * too small, maybe 20%"). Turn this, not the dial, when imported grain
     * comes out the wrong coarseness across the board.
     *
     * 2.05 -> 1.83 is NOT a further calibration, it is that same look kept
     * while a bug underneath it was fixed. The .sut importer used to round
     * the brush's own scale to an integer, which turned this preset's 2.24
     * into 2, and most of the "maybe 20%" above was really the user's eye
     * recovering that 11% by pushing on this constant instead. With the
     * rounding gone the dial arrives at its true 2.24, so this comes down by
     * the same ratio (2 * 2.05 = 4.10 = 2.24 * 1.83) and a correctly
     * re-imported brush renders exactly as it did before. An ALREADY-imported
     * one does not: presets are saved to localStorage with the old rounded
     * 2, so those read about 11% finer until re-imported. */
    var _TEX_GRAIN_SCALE = 1.83;
    /* Clip Studio's paper on each dab, measured there one dab at a time
     * (Dry Gouache's paper, a flat 200px tip, flow 100/75/50/25): with s the
     * paper's alpha and a the dab's, each blend is a textbook one -- 0 is
     * a x (s + 0.5), 1 multiply, 2 linear burn, 3 darken, 4 linear light,
     * 5 hard light, 6 colour dodge, 7 colour burn -- and the density mixes
     * it with the bare dab (checked at 50 on 1 and 4), except linear burn,
     * where it scales the paper taken away, and 0, where it scales the paper
     * in: a (1.5 - d (1 - s)), half again the dab at density 0 (a hard
     * round at flow 50 under Soft bleed's paper, cdp-csp/pr-sb: 0.75 at 0,
     * 0.55 at 50, the same on each dab or on the stroke). Linear light is
     * why Pastel's soft tip lands as scattered specks and a full-flow dab
     * shows no grain at all -- and it is mixed before it is clipped: under
     * Pastel's paper at 60 a flat flow-25 dab holds 0/15/31/46 at the 5th/
     * 25th/50th/75th of the paper (cdp-csp/pr-dab pfF25), where clipped
     * first it never went under 26. */
    function _cspPaper(m, a, s, d) {
        if (m === 2) return _max(0, a - d * (1 - s));
        if (m === 0) return _min(1, a * (1.5 - d * (1 - s)));
        if (m === 4) return a + d * (a + s - 1);
        return a + d * (_cspPaperFull(m, a, s) - a);
    }
    function _cspPaperFull(m, a, s) {
        switch (m) {
            case 0: return _min(1, a * (s + 0.5));
            case 1: return a * s;
            case 3: return _min(a, s);
            case 4: return _clamp(2 * a + s - 1, 0, 1);
            case 5: return a <= 0.5 ? 2 * a * s : 1 - 2 * (1 - a) * (1 - s);
            case 6: return s >= 1 ? 1 : _min(1, a / (1 - s));
            default: return a >= 1 ? 1 : s <= 0 ? 0 : _max(0, 1 - (1 - a) / s);
        }
    }
    var _tileA = new WeakMap();

    // `at`: work on ctx's own pixels at (ox, oy), a whole stroke rather than a dab-local scratch
    function _applyTextureNoise(ctx, w, h, textureLevel, textureScale, textureType, ox, oy, blend, flow, at) {
        if (textureLevel <= 0) return;
        var tile = _grainTile(textureType);
        /* textureScale is a dial calibrated against the 64px procedural
         * tiles (_TEX_SIZE) -- an imported .sut pattern is its own source
         * resolution (this file's own is 300px), not 64, so applying the
         * same dial value as a raw ctx.scale stretched it by however much
         * bigger than 64 the real asset happens to be: a 300px tile at
         * dial=2 rendered at 600 canvas px, six times the size of a 100px
         * brush, one soft blob instead of fine grain. Scaling relative to
         * the tile's own pixel size cancels that out -- a 64px procedural
         * tile keeps exactly its old behavior (ratio 1), and a 300px import
         * renders at the same PHYSICAL size the dial intends instead of
         * whatever its source PNG happened to be exported at. */
        var scale = _max(0.05, (textureScale || 4) * (_TEX_SIZE / tile.width) * _TEX_GRAIN_SCALE);
        /* Mask-style paper tiles (CSP grain: specks in alpha) remove paint
         * instead of tinting it: destination-out scales the dab's own alpha
         * by (1 - speck * strength), so the paper shows through where the
         * grain sits. Smoothing stays off so specks stay sharp; opaque RGB
         * tiles and generated grain keep the grey-tint path below. */
        var mask = _patIsMask.get(tile) === true;
        if (blend != null && mask) {
            var ta = _tileA.get(tile);
            if (!ta) {
                var tdat = tile.getContext('2d').getImageData(0, 0, tile.width, tile.height).data;
                ta = new Uint8Array(tile.width * tile.height);
                var tsum = 0;
                for (var k = 0; k < ta.length; k++) tsum += ta[k] = tdat[k * 4 + 3];
                ta.mean = tsum / ta.length / 255;
                _tileA.set(tile, ta);
            }
            var tw = tile.width, th = tile.height, D = _min(1, textureLevel / 100), ct = getParams().textureContrast || 1, inv = getParams().textureInvert,
                br = getParams().textureBrightness || 0, rot = (getParams().textureRotate || 0) * _PI / 180, rc = _cos(rot), rs = _sin(rot);
            /* Clip Studio's emphasised density (TextureStressDensity) lays the
             * paper at full, its contrast stretched density/10 times about the
             * paper's mean: a single 200px dab over Oil paint's paper, multiply,
             * ran 0.1/1/2.5/5/9.9x steep at density 0/10/25/50/100, every line
             * through 0.347 (the paper's mean, 0.3476), cut at 0 and 1.
             * ponytail: measured on one paper and multiply only; the floor at
             * density 0 (0.1) is that one point. */
            var stress = getParams().textureStress ? _max(0.1, 10 * D) : 0, sm = ta.mean;
            if (stress) D = 1;
            var img = ctx.getImageData(at ? ox : 0, at ? oy : 0, w, h), dd = img.data;
            for (var j = 0; j < h; j++) {
                var ty = ((_floor(((oy || 0) + j) / scale) % th) + th) % th;
                for (var i = 0; i < w; i++) {
                    var q = (j * w + i) * 4 + 3, a = dd[q] / 255 * (flow == null ? 1 : flow);
                    if (!a) continue;
                    var tx = ((_floor(((ox || 0) + i) / scale) % tw) + tw) % tw;
                    if (rot) {
                        var gx = (ox || 0) + i, gy = (oy || 0) + j;
                        tx = ((_floor((gx * rc + gy * rs) / scale) % tw) + tw) % tw;
                        ty = ((_floor((gy * rc - gx * rs) / scale) % th) + th) % th;
                    }
                    var s = ta[ty * tw + tx] / 255;
                    /* Clip Studio's order (cdp-csp/pa, Round watercolor's
                     * paper on a whole stroke): contrast about mid grey, then
                     * brightness takes b/200 off, then reverse. */
                    if (ct !== 1) s = _clamp((s - 0.5) * ct + 0.5, 0, 1);
                    if (br) s = _clamp(s - br, 0, 1);
                    if (inv) s = 1 - s;
                    if (stress) s = _clamp(sm + stress * (s - sm), 0, 1);
                    dd[q] = _round(_clamp(_cspPaper(blend, a, s, D), 0, 1) * 255);
                }
            }
            ctx.putImageData(img, at ? ox : 0, at ? oy : 0);
            return true;    // flow is in the pixels now: draw at 1
        }
        if (at) return false;
        var alpha = mask ? (textureLevel / 100) : (textureLevel / 100) * 0.25;
        // The phase repeats over the tile's own size; a supplied pattern is
        // rarely the 64px the generated ones happen to be.
        var px = -(((ox || 0) / scale) % tile.width);
        var py = -(((oy || 0) / scale) % tile.height);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = mask ? 'destination-out' : 'source-atop';
        if (mask) ctx.imageSmoothingEnabled = false;
        ctx.scale(scale, scale);
        ctx.translate(px, py);
        ctx.fillStyle = mask ? _texPattern(ctx, _invertedTile(tile)) : _texPattern(ctx, tile);
        ctx.fillRect(-px, -py, _ceil(w / scale) + 1, _ceil(h / scale) + 1);
        ctx.restore();
    }

    /* Watercolour edge (coffee-ring): deepen the ink just inside its boundary,
     * where pooled pigment dries darkest. Runs on a COPY of the finished
     * paint, never the flow buffer — the ring reads its own output, so edging
     * in place would compound every flush, each pass re-darkening the last
     * pass's ring. Every flush re-edges the complete accumulated ink, and the
     * last flush's union-rect recomposite carries the full ring.
     * A pixel's edge factor is how much of its own alpha the neighbourhood
     * lacks: 0 deep inside the ink, rising toward 1 at the boundary. The cover
     * read is expanded by the radius so ink touching the flush rect's border
     * still sees its true neighbourhood — a rect-clipped blur pretends full
     * coverage there and kills the ring; outside-canvas samples as zero.
     * The ring boosts ALPHA only, never RGB: pigment pooling at a drying
     * edge is the same phenomenon as ink restacking under repeated passes
     * (see _applyWatercolorWash) -- less dilution, not a different color --
     * so this reuses that principle instead of blending toward a separate
     * "deepened" RGB tint, which is what an earlier version of this did.
     * That version mixed d[o]*(1-m1)+sr*m2 with m1 unclamped (could exceed
     * 1, driving the term negative before the add), and independently of
     * how much this stroke overlapped a previous one -- every redraw over
     * the same area re-mixed toward the same fixed color again, compounding
     * into a muddy, broadening, progressively hue-shifted band instead of a
     * thin sharp rim. Boosting alpha has neither problem: it saturates at
     * 1 like any alpha value, and mixing the SAME brush color over itself
     * more times can't shift its own hue. Box blur is separable with a
     * sliding window — O(rect) with flat buffers, nothing allocated per
     * pixel. Deterministic in its inputs. */
    /* Clip Studio's edge, measured (cdp-csp/we: a flat round stroke, texture
     * off, radius 1-20, power 5-100, opacity 20/40): ink is ADDED, power/10
     * of full alpha at the rim, falling in a straight line to nothing at
     * the radius -- (r + 1 - D) / (r + 1) at D px from the nearest empty
     * pixel -- whatever alpha the stroke has. The outermost pixel takes
     * 0.29 of the rim's add at every radius. Alpha only, added after the
     * stroke's opacity (an opacity 20 and 40 stroke gain the same), so the
     * opacity is baked in here and the copy composites at 1.
     * Its tone (value power V) takes the same amount off the colour's value
     * whatever the colour: V (0.737 x / (1 + x) + 0.056 t), x = power/10 * t,
     * t the straight line above -- a grey and a near-white stroke darken by
     * the same levels, and twice the tone takes twice as many (cdp-csp/kv,
     * kv2: 10 opaque greys, power 0-100, tone 0-100, within 3 levels). */
    function _applyWaterEdgeAdd(ctx, x, y, w, h, width, density, opacity, value) {
        var R = _max(1, _round(width)) + 1, k = density / 10;
        var bw = ctx.canvas.width, bh = ctx.canvas.height;
        var ex = _max(0, x - R), ey = _max(0, y - R);
        var ew = _min(bw, x + w + R) - ex, eh = _min(bh, y + h + R) - ey;
        if (ew <= 0 || eh <= 0 || k <= 0) return;
        var img;
        try { img = ctx.getImageData(ex, ey, ew, eh); } catch (e) { return; }
        var d = img.data, n = ew * eh, D = new Float32Array(n), i, xx, yy, v, S = Math.SQRT2;
        for (i = 0; i < n; i++) D[i] = d[i * 4 + 3] ? R : 0;
        // Two-pass chamfer distance to the nearest empty pixel, capped at R.
        for (yy = 0; yy < eh; yy++) for (xx = 0; xx < ew; xx++) {
            i = yy * ew + xx; if (!D[i]) continue; v = D[i];
            if (xx > 0) v = _min(v, D[i - 1] + 1);
            if (yy > 0) { v = _min(v, D[i - ew] + 1); if (xx > 0) v = _min(v, D[i - ew - 1] + S); if (xx < ew - 1) v = _min(v, D[i - ew + 1] + S); }
            D[i] = v;
        }
        for (yy = eh - 1; yy >= 0; yy--) for (xx = ew - 1; xx >= 0; xx--) {
            i = yy * ew + xx; if (!D[i]) continue; v = D[i];
            if (xx < ew - 1) v = _min(v, D[i + 1] + 1);
            if (yy < eh - 1) { v = _min(v, D[i + ew] + 1); if (xx < ew - 1) v = _min(v, D[i + ew + 1] + S); if (xx > 0) v = _min(v, D[i + ew - 1] + S); }
            D[i] = v;
        }
        var ox = x - ex, oy = y - ey;
        for (yy = 0; yy < h; yy++) for (xx = 0; xx < w; xx++) {
            i = (yy + oy) * ew + xx + ox; v = D[i];
            if (!v) continue;
            var t = v < R ? (v < 1.5 ? 0.29 : (R - v) / R) : 0, kt = k * t;
            d[i * 4 + 3] = _min(255, _round(d[i * 4 + 3] * opacity + 255 * kt));
            if (value && t) {
                var j = i * 4, m = _max(d[j], d[j + 1], d[j + 2]) / 255;
                var f = m > 0 ? _max(0, m - value / 100 * (0.737 * kt / (1 + kt) + 0.056 * t)) / m : 0;
                d[j] *= f; d[j + 1] *= f; d[j + 2] *= f;
            }
        }
        ctx.putImageData(img, ex, ey);
    }

    function _applyWaterEdge(ctx, x, y, w, h, width, density) {
        /* Floor of 2, down from 8 and then 4: a wider floor did register a
         * real deficit (measured directly, not assumed) but spread the
         * response over such a wide neighbourhood that the ring read as a
         * broad soft band instead of CSP's thin, crisp line -- reported
         * directly against a real render, 2026-09-17. An even earlier floor
         * of 3, tried before this file used a pure alpha boost (see the
         * ring's own comment above), sat entirely inside this brush's own
         * boundary ramp and looked unreadably thin next to that older,
         * weaker RGB-mix recipe -- but a radius this narrow works now that
         * _EDGE_LIFT (below _WATERCOLOR_WASH) can push a genuinely tight
         * band all the way to full alpha on its own, so it no longer needs
         * a wide detector to read as visible. A ring's radius sets both how
         * far it reaches AND how far it blurs, so the width fix belongs
         * here, not in a separate falloff curve on top of a wide detector. */
        var r = _max(2, _round(width));
        /* Square-rooted, not linear: CSP brushes calibrate this dial low
         * (this file's own value is 10) and still show a plainly visible
         * rim (CSP.png), where a linear k left ours at a ~5% darken --
         * imperceptible next to the pale wash. sqrt lifts low settings
         * (0.1 -> 0.32, a 3x gain) while leaving 100 -> 1 untouched, so a
         * brush that really does want a strong ring still gets one. */
        var k = Math.sqrt(_max(0, _min(100, density)) / 100);
        if (k <= 0) return;
        var bw = ctx.canvas.width, bh = ctx.canvas.height;
        var ex = _max(0, x - r), ey = _max(0, y - r);
        var ex2 = _min(bw, x + w + r), ey2 = _min(bh, y + h + r);
        var ew = ex2 - ex, eh = ey2 - ey;
        if (ew <= 0 || eh <= 0) return;
        var img, d;
        try {
            img = ctx.getImageData(ex, ey, ew, eh);
        } catch (e) { return; }
        d = img.data;
        var n = ew * eh, i, px, acc;
        var alpha = new Float32Array(n);
        for (i = 0; i < n; i++) alpha[i] = d[i * 4 + 3] / 255;
        var tmp = new Float32Array(n);
        var div = 2 * r + 1;
        for (var yy = 0; yy < eh; yy++) {
            acc = 0;
            var row = yy * ew;
            for (px = -r; px <= r; px++) acc += alpha[row + _min(ew - 1, _max(0, px))];
            for (px = 0; px < ew; px++) {
                tmp[row + px] = acc / div;
                acc += alpha[row + _min(ew - 1, px + r + 1)] - alpha[row + _max(0, px - r)];
            }
        }
        var cover = new Float32Array(n);
        for (px = 0; px < ew; px++) {
            acc = 0;
            for (var qy = -r; qy <= r; qy++) acc += tmp[_min(eh - 1, _max(0, qy)) * ew + px];
            for (yy = 0; yy < eh; yy++) {
                cover[yy * ew + px] = acc / div;
                acc += tmp[_min(eh - 1, yy + r + 1) * ew + px] - tmp[_max(0, yy - r) * ew + px];
            }
        }
        var ox = x - ex, oy = y - ey;
        for (yy = 0; yy < h; yy++) {
            for (px = 0; px < w; px++) {
                i = (yy + oy) * ew + (px + ox);
                var a = alpha[i];
                if (a <= 0.012) continue;
                var e = (a - cover[i]) / a;
                if (e <= 0) continue;
                if (e > 1) e = 1;
                e *= k;
                var o = i * 4;
                /* The rim is MORE OF THE SAME PAINT, not a different colour:
                 * pigment pools at a drying edge, so that band has simply had
                 * more pigment left in it. Since watercolour composites with
                 * multiply, "more of the same paint" is literally one more
                 * multiply of the colour by itself -- lerp(c, c*c/255, t) is
                 * that extra layer, faded in by how much of a rim this pixel
                 * is. That is the same operation restacking performs, so the
                 * hue it shifts to is the hue the user already gets by
                 * painting the stroke twice; it cannot invent a colour, and
                 * it is bounded below by c squared however strong the rim.
                 *
                 * This is NOT the RGB mix that was pulled out of here before
                 * (see the ring's comment above). That one blended toward a
                 * FIXED deepened colour with an unclamped weight and ran in
                 * place, so every redraw re-mixed toward the same colour again
                 * and the band broadened and went muddy. This is bounded, is
                 * the paint's own colour rather than a chosen one, and runs on
                 * a fresh copy each flush, so it neither compounds nor drifts.
                 * Alpha still carries most of the rim; this is what lets it
                 * keep getting darker once alpha has run out of headroom. */
                var t = e * _EDGE_DEEPEN;
                if (t > 1) t = 1;
                if (t > 0) {
                    d[o]     = _round(d[o]     * (1 - t + t * d[o]     / 255));
                    d[o + 1] = _round(d[o + 1] * (1 - t + t * d[o + 1] / 255));
                    d[o + 2] = _round(d[o + 2] * (1 - t + t * d[o + 2] / 255));
                }
                var na = a + e * _EDGE_LIFT;
                d[o + 3] = _round(_min(1, na) * 255);
            }
        }
        ctx.putImageData(img, ex, ey);
    }

    /* Watercolour wash: scale this stroke's own alpha down to wash strength.
     * A proportional multiply of the ALPHA channel alone, not a clamp to a
     * fixed ceiling and not a touch of RGB -- this is still ordinary alpha
     * compositing, just with a different alpha, C_out = C_brush*(f*a) +
     * C_existing*(1-f*a) for whatever the accumulated per-pixel alpha a
     * already is; it is not the RGB "brightness" adjustment it can look
     * like at a glance. It has to run here, at flush time on the whole
     * accumulated stroke, rather than as a per-dab alpha adjustment: a
     * wash brush restacks dozens of overlapping dabs along a stroke with
     * no wet-blend gate to stop it (see _paintDab), and N overlapping
     * passes at ANY fixed per-dab alpha converge toward fully opaque as N
     * grows -- 1-(1-a)^N -> 1 -- so no per-dab number, however small, stays
     * translucent under enough restacking. Diluting after the fact, once,
     * on however much ink actually piled up, is the only way "translucent
     * even under heavy overlap" survives arbitrary stroke length. Measured
     * directly (test/browser/brush-hash.mjs, "wash thins paint" /
     * "wet blend idempotence"): a per-dab version of this passed CSP colour
     * calibration but failed both regression tests above -- either it
     * saturated to indistinguishable from plain ink under restacking (no
     * per-dab dilution survives it), or, replaced with a nonlinear
     * repeated-compositing curve to fix that, it warped low- and
     * high-alpha pixels by different amounts and inverted which of two
     * differently-touched regions should have gained more ink. A LINEAR
     * scale has neither problem: it doesn't saturate away under any amount
     * of restacking (it's applied once, after), and it doesn't distort the
     * relationship between two different alpha levels (everything scales
     * by the same factor), so wet-vs-dry retrace deltas keep their sign.
     * A multiply preserves whatever shape the accumulated ink already has
     * -- grain dips, taper, edge falloff -- just scaled, which is also a
     * truer wash: real pigment dilutes proportionally, it doesn't get
     * plastered flat.
     * Must run on a COPY, never the live flow buffer in place: unlike a
     * clamp, a multiply is not idempotent, so re-scaling on every live
     * flush of one drag would compound (0.35, then 0.35 of that, ...). */
    /* Reserved headroom, not the hard 255 ceiling: _applyWaterEdge only ever
     * ADDS on top of whatever alpha is already here, so if wash is strong
     * enough to push ordinary interior ink to full opacity on its own (and
     * a wash this dark is), the ring has nowhere left to add to on most of
     * the stroke -- confirmed directly, not assumed: at the interior's own
     * saturation point the ring only kept showing in patches where dab
     * overlap happened to be thinner, everywhere else it had no room. This
     * caps ordinary wash below full opacity always, however strong `wash`
     * gets, so the few percent above it stays genuinely free for the ring
     * to rise into on every pixel, not just the sparse ones.
     *
     * The value is also the brush's CALIBRATION POINT, not an arbitrary
     * margin. Watercolour composites with multiply (see _flushFlowBuffer), and
     * over white paper multiply resolves to lerp(white, white*src, a) -- so
     * this plateau sets the per-stroke coverage that decides how fast
     * restacking darkens. Note "sets", not "is": the flush-time paper grain
     * runs after the wash and takes roughly a third of the alpha back out, so
     * the coverage that actually lands is about 0.64 of this number. Turn
     * this, not the multiplier below, to match a reference: the multiplier
     * governs how much of the stroke reaches the plateau, this governs what
     * the plateau is.
     *
     * 193 comes from real CSP measurements of the Flat watercolor brush
     * (2026-09-17), and supersedes an earlier 214 fitted at coverage 0.836.
     * That earlier fit was DEGENERATE and the number was simply wrong: every
     * swatch behind it had a channel pinned at 255, and at 255 a multiply is
     * the identity, so those colours could not constrain the coverage at all.
     * The measurements that can are grey #808080 stacked over white (189 /
     * 111 / 26 / 2 at 1 / 3 / 8 / 20 passes, fitting coverage 0.492) and a
     * blue-over-red overlap reading #854688, whose three channels
     * independently fit 0.484 / 0.476 / 0.474. Two unrelated tests, same
     * answer, so coverage is ~0.49 and this is 0.49/0.546 of the old value.
     * Re-measure with `node scripts/brush-probe.mjs` (probe 7 prints this
     * ladder next to the CSP targets); do not re-fit against a colour whose
     * brightest channel is 255. */
    var _WASH_CEILING = 193;
    function _applyWatercolorWash(ctx, x, y, w, h, wash) {
        var img;
        try { img = ctx.getImageData(x, y, w, h); } catch (e) { return; }
        var d = img.data, f = _clamp(wash, 0, 4);
        for (var i = 3; i < d.length; i += 4) {
            d[i] = _min(_WASH_CEILING, _round(d[i] * f));
        }
        ctx.putImageData(img, x, y);
    }

    // cap: the most a pixel holds -- dabs laid by darken stop at their flow (Soft bleed: flat 0.5 at flow 50, anti-aliasing off)
    function _applyAliased(ctx, x, y, w, h, cap) {
        var img;
        try { img = ctx.getImageData(x, y, w, h); } catch (e) { return; }
        var d = img.data, i = 3;
        for (var yy = y; yy < y + h; yy++) {
            for (var xx = x; xx < x + w; xx++, i += 4) {
                var t = Math.imul(xx, 374761393) + Math.imul(yy, 668265263) | 0;
                t = Math.imul(t ^ (t >>> 13), 1274126177);
                d[i] = d[i] * 2 > cap || d[i] * 255 > ((t ^ (t >>> 16)) & 255) * cap ? cap : 0;
            }
        }
        ctx.putImageData(img, x, y);
    }

    function _paintDab(destCtx, x, y, maskCanvas, colorHex, alpha, texture, textureScale, textureType, wetBlend) {
        var mw = maskCanvas.width;
        var mh = maskCanvas.height;
        if (_pxOff) { x = _floor(x + 0.5 + 1e-6); y = _floor(y + 0.5 + 1e-6); }
        var ox = maskCanvas._cx != null ? _round(x - maskCanvas._cx) : _pxOff ? _round(x - mw / 2) : x - mw / 2;
        var oy = maskCanvas._cy != null ? _round(y - maskCanvas._cy) : _pxOff ? _round(y - mh / 2) : y - mh / 2;

        var ad = destCtx === _flowCtx && _alphaDarken(getParams());
        var adFlow = alpha;
        var adHex = colorHex, pic = ad && getParams().tipMode === 'color';
        if (ad) {
            _ensureAdBuffer();
            if ((_adColOn === 1 && colorHex !== _adColor) || (pic && _adColOn !== 2)) {
                if (!_adCol || _adCol.width !== _adCanvas.width || _adCol.height !== _adCanvas.height) {
                    _adCol = new OffscreenCanvas(_adCanvas.width, _adCanvas.height);
                    _adColCtx = _adCol.getContext('2d', { willReadFrequently: true });
                }
                _adColCtx.fillStyle = _adColor;   // every dab so far was this colour
                _adColCtx.fillRect(0, 0, _adCol.width, _adCol.height);
                _adColOn = 2;
            } else if (!_adColOn) _adColOn = 1;
            _adColor = colorHex; colorHex = _greyHex(_adAvg); if (_adAvg > 0) alpha *= _adO / _adAvg;
        }

        if (pic) {
            /* A picture keeps its own shading in _adCol and gives the alpha
             * buffer only its shape: flattened to one colour, WC Generic
             * Flower's white hearts went the grey of its petals. */
            _colorizeMask(maskCanvas, adHex);
            if (!_adPic || _adPic.width < mw || _adPic.height < mh) {
                _adPic = new OffscreenCanvas(mw, mh);
                _adPicCtx = _adPic.getContext('2d');
            }
            _adPicCtx.clearRect(0, 0, mw, mh);
            _adPicCtx.drawImage(_scratchCanvas, 0, 0, mw, mh, 0, 0, mw, mh);
            _colorizeMask(maskCanvas, colorHex, 'alpha');
            _tintMask = null;
        } else if (_tintMask !== maskCanvas || _tintColor !== colorHex) {
            _colorizeMask(maskCanvas, colorHex);
            _tintMask = maskCanvas;
            _tintColor = colorHex;
        }

        /* Watercolour grains the finished stroke at flush time instead (see
         * _flushFlowBuffer), so graining per-dab here as well punches the same
         * paper twice. Both passes are anchored to the DOCUMENT, not to the
         * dab, so their specks land on the same pixels and compound into
         * (1 - k*s)^2 -- at this brush's texture 60 that removes up to 84% of
         * a speck's alpha, which is most of where its opacity was going. The
         * flush-time pass is the one worth keeping: at a dab every ~1% of the
         * brush size, per-dab grain is refilled solid by the next barely
         * shifted dab almost everywhere, so it is the pass that survives to be
         * seen. Guarded here rather than at the three call sites because all
         * of them route through this one line. Cost: a watercolour brush loses
         * pressure-driven texture modulation, since the flush pass reads the
         * static param -- no watercolour preset in hand uses that. */
        var _tp = getParams();
        /* Krita's grain is fixed to the canvas pixel for pixel, so the dab
         * is moved to its fraction of a pixel FIRST and grained on the
         * canvas's own grid after: grained and then drawn at the fraction,
         * the grain slid up to half a pixel from dab to dab and the stroke
         * averaged it away (test/krita/probes/gchar, Grease Charcoal: IoU
         * 0.75 -> 0.84; Krita's there is each dab minus the grain, piled up
         * source-over, to within 3 grey levels). Snapping the dab to whole
         * pixels instead cost the deevad textured brushes 0.03-0.05. */
        var fx = ox - _floor(ox), fy = oy - _floor(oy);
        if (_tp.textureMode && (fx || fy) && _kritaTexMask(_tp)) {
            if (!_shiftCanvas || _shiftCanvas.width < mw || _shiftCanvas.height < mh) {
                _shiftCanvas = new OffscreenCanvas(mw, mh);
                _shiftCtx = _shiftCanvas.getContext('2d');
            }
            _shiftCtx.clearRect(0, 0, mw, mh);
            _shiftCtx.drawImage(_scratchCanvas, 0, 0, mw, mh, 0, 0, mw, mh);
            _ensureScratch(mw + 1, mh + 1);
            _scratchCtx.clearRect(0, 0, mw + 1, mh + 1);
            _scratchCtx.drawImage(_shiftCanvas, 0, 0, mw, mh, fx, fy, mw, mh);
            mw++; mh++; ox -= fx; oy -= fy;
            _tintMask = null;
        }
        if (_tp.textureMode && _applyKritaTexture(_scratchCtx, mw, mh, ox, oy, texture / 100, _tp)) {
            _tintMask = null;
        } else if (texture > 0 && !_tp.watercolor && _tp.textureStroke == null) {
            /* Clip Studio's paper modes are not linear in the dab's alpha
             * (mode 4 at full strength shows no grain), so they see it with
             * the flow already in. */
            if (_applyTextureNoise(_scratchCtx, mw, mh, texture, textureScale, textureType, ox, oy, _tp.textureBlend, _clamp(alpha, 0, 1))) alpha = adFlow = 1;
            _tintMask = null;   // the scratch is no longer a plain tint
        }

        if (_applyTip2(_scratchCtx, mw, mh, ox, oy, _max(mw, mh), 0)) _tintMask = null;
        if (_tp.hatch && ad) {
            ox = _round(ox); oy = _round(oy);    // the lines sit on whole pixels
            _applyHatch(_scratchCtx, mw, mh, ox, oy, _tp, x, y);
            _tintMask = null;
        }

        /* Wet-blend coverage (W1): punch this dab's own mask by what the
         * stroke has already landed FIRST, then record the leftover as
         * newly covered. Punching first, accumulating after, means the
         * leftover added to coverage is exactly mask-minus-old-coverage, so
         * the running union stays correct without ever needing the
         * pre-punch mask again. Gating here (not at flush) keeps the flow
         * buffer itself free of self-restacking, so the ordinary flush,
         * which always repaints this whole region from scratch, needs no
         * special case for it. */
        if (wetBlend) {
            _ensureCovCanvas(destCtx.canvas.width, destCtx.canvas.height);
            _scratchCtx.save();
            _scratchCtx.globalCompositeOperation = 'destination-out';
            _scratchCtx.drawImage(_covCanvas, ox, oy, mw, mh, 0, 0, mw, mh);
            _scratchCtx.restore();
            _covCtx.save();
            _covCtx.globalCompositeOperation = 'lighter';
            /* globalAlpha stays at the default 1 here while the dab itself
             * paints at `alpha` (see the drawImage below), which reads like a
             * bug -- a pixel is marked fully covered when only part of the ink
             * landed -- and recording at `_clamp(alpha, 0, 1)` instead was
             * tried on 2026-09-17. It changes NOTHING observable: the golden
             * hashes (singleWet, retraceWet, crossWet) and every reading from
             * scripts/brush-probe.mjs came back byte-identical. The reason is
             * that `wetBlend` is only ever set by the .sut watercolour
             * importer, and on those brushes _applyWatercolorWash rescales the
             * accumulated alpha and clamps it at _WASH_CEILING at flush time,
             * which saturates -- so whatever this gate lets through is washed
             * out downstream anyway. Left as it is rather than "fixed" into a
             * diff nobody can measure. */
            _covCtx.drawImage(_scratchCanvas, 0, 0, mw, mh, ox, oy, mw, mh);
            _covCtx.restore();
            _growCovUsed(ox, oy, mw, mh);
            _tintMask = null;   // the scratch no longer matches a plain re-tint of maskCanvas
        }

        /* No save/restore per dab: the only state this touches is the alpha,
         * and the smoothing flags stick to the context anyway. A stroke is
         * thousands of dabs and a save/restore pair is not free.
         *
         * 'low' rather than 'high' because the dab is drawn at 1:1 -- the
         * only filtering is the subpixel shift -- where the expensive filter
         * buys nothing visible and cost a fifth of the stroke. */
        var dc = ad ? _adCtx : destCtx;
        if (ad && _adColOn === 2) {
            // this dab's colour over the stroke's, as far as the dab reaches
            if (!_shiftCanvas || _shiftCanvas.width < mw || _shiftCanvas.height < mh) {
                _shiftCanvas = new OffscreenCanvas(mw, mh);
                _shiftCtx = _shiftCanvas.getContext('2d');
            }
            _shiftCtx.clearRect(0, 0, mw, mh);
            _shiftCtx.fillStyle = adHex;
            _shiftCtx.fillRect(0, 0, mw, mh);
            _shiftCtx.globalCompositeOperation = 'destination-in';
            _shiftCtx.drawImage(_scratchCanvas, 0, 0, mw, mh, 0, 0, mw, mh);
            _shiftCtx.globalCompositeOperation = 'source-over';
            _adColCtx.globalAlpha = _clamp(adFlow, 0, 1);
            _adColCtx.drawImage(pic ? _adPic : _shiftCanvas, 0, 0, mw, mh, ox, oy, mw, mh);
            _adColCtx.globalAlpha = 1;
        }
        if (ad && ox === _floor(ox) && oy === _floor(oy)) _adDab(ox, oy, mw, mh, adFlow);
        else if (_tp.dabMax && !ad) _maxDab(dc, _round(ox), _round(oy), mw, mh, _clamp(alpha, 0, 1));
        else {
        if (ad) dc.globalCompositeOperation = 'lighten';
        dc.globalAlpha = _clamp(alpha, 0, 1);
        dc.imageSmoothingEnabled = true;
        dc.imageSmoothingQuality = 'low';
        dc.drawImage(_scratchCanvas, 0, 0, mw, mh, ox, oy, mw, mh);
        dc.globalAlpha = 1;
        if (ad) dc.globalCompositeOperation = 'source-over';
        }

        var AA_MARGIN = 1;
        if (!_dirtyRect) {
            _dirtyRect = { x1: ox - AA_MARGIN, y1: oy - AA_MARGIN, x2: ox + mw + AA_MARGIN, y2: oy + mh + AA_MARGIN };
        } else {
            if (ox - AA_MARGIN < _dirtyRect.x1) _dirtyRect.x1 = ox - AA_MARGIN;
            if (oy - AA_MARGIN < _dirtyRect.y1) _dirtyRect.y1 = oy - AA_MARGIN;
            if (ox + mw + AA_MARGIN > _dirtyRect.x2) _dirtyRect.x2 = ox + mw + AA_MARGIN;
            if (oy + mh + AA_MARGIN > _dirtyRect.y2) _dirtyRect.y2 = oy + mh + AA_MARGIN;
        }
        // Track accumulated painted area across all preview flushes
        // so endStroke can restore the exact region (not a guess based on
        // margin calculations that fail for rotated/high-aspect-ratio masks).
        var CB = 1;
        if (!_clearBounds) {
            _clearBounds = { x1: ox - CB, y1: oy - CB, x2: ox + mw + CB, y2: oy + mh + CB };
        } else {
            if (ox - CB < _clearBounds.x1) _clearBounds.x1 = ox - CB;
            if (oy - CB < _clearBounds.y1) _clearBounds.y1 = oy - CB;
            if (ox + mw + CB > _clearBounds.x2) _clearBounds.x2 = ox + mw + CB;
            if (oy + mh + CB > _clearBounds.y2) _clearBounds.y2 = oy + mh + CB;
        }
        if (!_flowUsed) {
            _flowUsed = { x1: ox - CB, y1: oy - CB, x2: ox + mw + CB, y2: oy + mh + CB };
        } else {
            if (ox - CB < _flowUsed.x1) _flowUsed.x1 = ox - CB;
            if (oy - CB < _flowUsed.y1) _flowUsed.y1 = oy - CB;
            if (ox + mw + CB > _flowUsed.x2) _flowUsed.x2 = ox + mw + CB;
            if (oy + mh + CB > _flowUsed.y2) _flowUsed.y2 = oy + mh + CB;
        }
    }

    /* Preview render target.
     *
     * The preview tiles used to be drawn by a second, simplified painter that
     * knew about size, spacing, hardness and angle and nothing else — so a
     * bristle brush, a textured brush and a plain round brush all previewed as
     * the same thin line. The only preview that can be trusted is one the real
     * engine drew, so the engine renders into a swatch instead of the document.
     *
     * While this is set, the stroke path targets the swatch and the things that
     * belong to the document — the active selection, alpha lock, the airbrush
     * timer — are off. Everything else runs exactly as it does for a real
     * stroke, which is the whole point. */
    var _previewTarget = null;

    function _outCtx() {
        return _previewTarget ? _previewTarget.ctx : app.ctx;
    }
    function _docW() {
        return _previewTarget ? _previewTarget.w : (app.config ? app.config.width : 0);
    }
    function _docH() {
        return _previewTarget ? _previewTarget.h : (app.config ? app.config.height : 0);
    }

    function _activeLayer() {
        var mgr = app.layerMgr;
        if (!mgr || !mgr.active || !mgr.layers || !mgr.layers.length) return null;
        return mgr.layers[mgr.activeIdx] || null;
    }

    /* Painting a layer mask means painting the mask, where alpha lock has no
     * meaning — same rule the pixel tools follow. */
    function _alphaLocked() {
        if (_previewTarget) return false;
        var l = _activeLayer();
        return !!(l && l.alphaLock && !(l.mask && l._maskEdit));
    }

    /* A full-canvas alpha stencil for the active selection: opaque where paint
     * is allowed. Wand and lasso selections carry their own mask; a plain
     * marquee is just its rectangle — deliberately NOT the pixels it lifted,
     * because a marquee dragged over empty space must still accept paint. */
    function _buildSelectionStencil() {
        if (_previewTarget) return null;
        var sel = app.state && app.state.selection;
        if (!sel) return null;
        var w = app.config.width, h = app.config.height;
        if (!(w > 0 && h > 0)) return null;
        var nr = app.getNormalizedRect ? app.getNormalizedRect(sel) : sel;
        var c = new OffscreenCanvas(w, h);
        var ctx = c.getContext('2d');
        if (sel.mask) {
            ctx.drawImage(sel.mask, nr.x, nr.y);
        } else {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(nr.x, nr.y, nr.w, nr.h);
        }
        return c;
    }

    /* Readbacks off the background snapshot the stroke already captured,
     * rather than one per dab off the live canvas -- but only of the parts
     * the stroke actually crosses.
     *
     * Reading the whole document cost 19ms at 4000x4000, paid on pen-down,
     * before a single dab was drawn: a smudge brush felt like it stuck to
     * the paper before it moved. A stroke touches a handful of tiles, so
     * fetching them as they are reached spreads that cost out and mostly
     * never pays it at all. */
    var SAMPLE_TILE = 256;

    function _primeSampleCache() {
        _sampleTiles = null;
        if (!_bgCtx || !_bgCanvas) return;
        var w = _docW();
        var h = _docH();
        if (!(w > 0 && h > 0)) return;
        _sampleTiles = {};
        _sampleW = w; _sampleH = h;
    }

    function _sampleTile(tx, ty) {
        var k = tx + '|' + ty;
        var t = _sampleTiles[k];
        if (t !== undefined) return t;
        try {
            var x = tx * SAMPLE_TILE, y = ty * SAMPLE_TILE;
            t = _bgCtx.getImageData(x, y, _min(SAMPLE_TILE, _sampleW - x),
                                    _min(SAMPLE_TILE, _sampleH - y));
        } catch (e) {
            t = null;
        }
        _sampleTiles[k] = t;
        return t;
    }

    /* One buffer, refilled. A sample is read on the spot -- the smudge
     * reservoir copies what it keeps -- and a smudge stroke takes five of
     * these per dab. */
    var _smp = [0, 0, 0, 0];

    function _sampleCanvasColor(ctx, x, y) {
        var px = _round(x);
        var py = _round(y);
        if (_sampleTiles) {
            if (px < 0 || py < 0 || px >= _sampleW || py >= _sampleH) return null;
            var tile = _sampleTile(_floor(px / SAMPLE_TILE), _floor(py / SAMPLE_TILE));
            if (!tile) return null;
            var d = tile.data;
            var i = ((py % SAMPLE_TILE) * tile.width + (px % SAMPLE_TILE)) * 4;
            // Alpha comes back too: an empty pixel carries no pigment, and
            // treating it as colour smears black out of nothing.
            _smp[0] = d[i]; _smp[1] = d[i + 1]; _smp[2] = d[i + 2]; _smp[3] = d[i + 3];
            return _smp;
        }
        if (!ctx) return null;
        var c = ctx.canvas;
        if (c && (px < 0 || py < 0 || px >= c.width || py >= c.height)) return null;
        try {
            var data = ctx.getImageData(px, py, 1, 1).data;
            _smp[0] = data[0]; _smp[1] = data[1]; _smp[2] = data[2]; _smp[3] = data[3];
            return _smp;
        } catch (e) {
            return null;
        }
    }

    function _mixColors(sampled, brushHex, colorRate) {
        if (!sampled || colorRate >= 100) return brushHex;
        if (colorRate <= 0) {
            return _rgbToHex(sampled[0], sampled[1], sampled[2]);
        }
        var t = colorRate / 100;
        var brush = _hexToRgb(brushHex);
        return _rgbToHex(
            _lerp(sampled[0], brush[0], t),
            _lerp(sampled[1], brush[1], t),
            _lerp(sampled[2], brush[2], t)
        );
    }

    var _cursorCache = { size: -1, url: null };
    function _updateBrushCursor() {
        // Building the cursor image also warms _cursorCache for when the
        // paintbrush becomes active, so only the stage assignment below is
        // gated — applying it while another tool is active would stomp that
        // tool's own cursor (e.g. the pencil's, right after boot).
        var isActiveTool = app.config && app.config.tool === 'paintbrush';
        var sz = _params.size;
        if (sz <= 2) {
            if (isActiveTool && app.ui && app.ui.stage) app.ui.stage.style.cursor = 'crosshair';
            return;
        }
        /* Browsers refuse a cursor image much over 128px and fall back to
         * the keyword silently, so building one for a big brush is pure
         * cost -- a canvas and a toDataURL per size change, for nothing. */
        if (_max(sz * 1.3, 20) > 128) {
            if (isActiveTool && app.ui && app.ui.stage) app.ui.stage.style.cursor = 'crosshair';
            return;
        }
        if (_cursorCache.size === sz && _cursorCache.url) {
            if (isActiveTool && app.ui && app.ui.stage) {
                var cx2 = Math.ceil(_max(sz * 1.3, 20)) / 2;
                app.ui.stage.style.cursor = 'url("' + _cursorCache.url + '") ' + Math.round(cx2) + ' ' + Math.round(cx2) + ', crosshair';
            }
            return;
        }
        var dpr = window.devicePixelRatio || 1;
        var d = Math.ceil(_max(sz * 1.3, 20));
        var cd = Math.ceil(d * dpr);
        var c = document.createElement('canvas');
        c.width = cd;
        c.height = cd;
        var ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        var cx = d / 2, cy = d / 2, r = sz / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, _PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, _PI * 2);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.setLineDash ? ctx.setLineDash([2, 2]) : null;
        ctx.stroke();
        var url = c.toDataURL();
        _cursorCache = { size: sz, url: url };
        if (isActiveTool && app.ui && app.ui.stage) {
            app.ui.stage.style.cursor = 'url("' + url + '") ' + Math.round(cx) + ' ' + Math.round(cy) + ', crosshair';
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Cursor outline — CSP-style: the tip's own silhouette, eroded down   */
    /*  to a single SCREEN pixel of rim, rather than a fixed circle         */
    /* ------------------------------------------------------------------ */

    /* _maskFor already builds exactly the alpha footprint a dab would
     * stamp -- custom tip bitmap, aspect, angle, hardness falloff, sharpness
     * -- centred in its own canvas at native document-pixel size. Reusing it
     * here means the cursor can never show a shape the brush cannot actually
     * paint, and never drifts from it when a preset changes any of those.
     *
     * The mask is native-resolution, so a naive 1-mask-pixel erosion would
     * come out `zoom` screen pixels wide once scaled up for display -- wrong
     * at anything but zoom 1. Scaling to actual screen size FIRST and then
     * eroding by one pixel of that scaled raster is what keeps the rim a
     * true single screen pixel at any zoom level.
     *
     * ponytail: a bristle fan's real hairs are still not previewed -- the
     * fan is built by a whole separate layout pass (_fanFor/_renderBristleDabs)
     * this just falls back to the base tip for. Everything else the real
     * per-dab path does -- direction-driven angle, size/hardness/aspect
     * dynamics at the input pressure, offsetAlong/Across, scatter, and which
     * cell of a multi-cell tip lands next -- IS replicated below, from the
     * same formulas _renderDab uses, so the outline is what would actually
     * get stamped, not a static rest-shape approximation. */

    /* Mirrors _pickTipCell's OWN pick, but reads instead of setting _tipCell
     * -- _pickTipCell's 'cycle' mode advances a shared counter every call,
     * so having the cursor call it on every mousemove would burn through
     * cycle slots a real dab was never stamped for, throwing off which cell
     * paints next once the user actually drags. 'random' has no such state
     * to disturb: it is the same position hash a real dab at this same spot
     * would get, so it can be read here directly. */
    function _previewTipCellFor(p, x, y) {
        var c = _tipCells();
        var n = c ? c.length : 1;
        if (n < 2) return 0;
        return _tipCellAt(p, _tipCycle, n, x, y);
    }

    /* Small LRU, not one slot: a jittering/scattering multi-cell tip can
     * hash to a different cell every pixel of movement, which would thrash
     * a single cached result every mousemove -- the exact cost profile that
     * made the previous (position-blind) version tank performance while
     * drawing. A handful of slots lets it cycle among a brush's actual few
     * cells/angle-buckets without re-eroding a mask it already built this
     * hover. */
    var _outlineLRU = [];
    var OUTLINE_LRU_MAX = 12;
    function _outlineFromLRU(key) {
        for (var i = 0; i < _outlineLRU.length; i++) {
            if (_outlineLRU[i].key === key) {
                var hit = _outlineLRU[i];
                if (i > 0) { _outlineLRU.splice(i, 1); _outlineLRU.unshift(hit); }
                return hit;
            }
        }
        return null;
    }
    function _outlineToLRU(entry) {
        _outlineLRU.unshift(entry);
        if (_outlineLRU.length > OUTLINE_LRU_MAX) _outlineLRU.length = OUTLINE_LRU_MAX;
    }

    var _cursorScratch = { x: 0, y: 0, pressure: 0.5, strokeAngle: 0 };
    /* x, y: document-space cursor position (needed for scatter/offset/tip-cell
     * hashes, all seeded by position). strokeAngle: degrees, atan2 of the
     * caller's own recent movement -- the same "direction" a real stroke
     * would be turning at if a drag started here right now. pressure:
     * defaults to 0.5 same as a mouse's first dab (see paint-engine.js). */
    function _buildCursorOutline(zoom, x, y, strokeAngle, pressure) {
        var p = getParams();
        var sc = _cursorScratch;
        sc.x = x || 0; sc.y = y || 0;
        sc.pressure = pressure != null ? pressure : 0.5;
        /* null, not 0 -- see _dynAngle: it only takes the direction branch
         * when strokeAngle is non-null, same as a real dab with no drag
         * behind it yet. Squashing that to 0 here would make the direction
         * dynamic think "pointing right" instead of "no direction", which is
         * exactly the axis-snap the caller (paint-engine.js) is working
         * around by passing null while merely hovering. */
        sc.strokeAngle = (strokeAngle == null) ? null : strokeAngle;

        var effAngle = _dynAngle(p, p.angle, sc);
        var sz = _dyn(p, 'size', p.size, sc, 1);
        if (!(sz > 2)) return null;

        var hard = _clamp(_dyn(p, 'hardness', p.hardness, sc, 6), 0, 100);
        var asp = p.aspectRatio;
        if ((p.aspectRatioSrc && p.aspectRatioSrc !== 'none') || p.aspectRatioSensors) {
            var af = _max(0.01, _dyn(p, 'aspectRatio', 1, sc, 7));
            asp = _clamp(p.aspectThinsWidth ? asp * af : asp / af, 0.1, 20);
        }
        var scatterAmt = _dyn(p, 'scatter', p.scatter, sc, 5);
        // Offset/scatter-axis math wants SOME direction even with none yet,
        // same as a real dab's own (strokeAngle||0) -- only the angle
        // dynamic itself cares about the null/real-zero distinction above.
        var dir = (sc.strokeAngle || 0) * _PI / 180;
        var dx = sc.x, dy = sc.y;

        if (p.offsetAlong || p.offsetAcross) {
            var om = _dyn(p, 'offset', 1, sc, 13);
            var oa = (p.offsetAlong / 100) * sz * om;
            if (p.ribbonLens) oa *= _ribbonLen(p, true);
            var oc = (p.offsetAcross / 100) * sz * om;
            dx += _cos(dir) * oa - _sin(dir) * oc;
            dy += _sin(dir) * oa + _cos(dir) * oc;
        }
        if (scatterAmt > 0) {
            var scatterDist = (scatterAmt / 100) * (p.sprayEach ? p.size : sz) * (p.scatterAxis === 'disk'
                ? _diskR(p.sprayBias, _dabRand(sc.x, sc.y, 2)) : _dabRand(sc.x, sc.y, 2) * 2 - 1);
            var ax = p.scatterAxis;
            var scatterAngle = (ax === 'along' || ax === 'across')
                ? dir + (ax === 'across' ? _PI / 2 : 0)
                : _dabRand(sc.x, sc.y, 3) * _PI * 2;
            dx += _cos(scatterAngle) * scatterDist;
            dy += _sin(scatterAngle) * scatterDist;
        }

        var previewCell = (p.shape === 'custom') ? _previewTipCellFor(p, dx, dy) : 0;
        var _savedTipCell = _tipCell;
        _tipCell = previewCell;
        var mask;
        try {
            // Angle pinned to 0 here on purpose: rotating the finished rim
            // via CSS transform (paint-engine.js) is exactly equivalent to
            // eroding a pre-rotated mask for every shape _maskFor makes
            // (built-in shapes and custom tips both just ctx.rotate() the
            // same unrotated drawing), and it's the difference between
            // recomputing the expensive getImageData/erosion pass on nearly
            // every frame of a direction-driven brush versus never.
            _sharpNow = p.sharpness;   // the tip at rest, not the last dab's pressure
            mask = _maskFor(p.shape, sz, hard, 0, asp);
        } finally {
            _tipCell = _savedTipCell;
        }
        if (!mask || !mask.width || !mask.height) return null;

        var z = zoom || 1;
        // offX/offY: how far the dab's own centre sits from the raw cursor,
        // in SCREEN px -- offset/scatter move the ink without moving the
        // pointer, so the ring must shift the same way to stay honest.
        var offX = (dx - sc.x) * z, offY = (dy - sc.y) * z;
        var key = p.shape + '|' + _round(sz) + '|' + _round(hard) + '|' +
            asp.toFixed(2) + '|' + z.toFixed(3) + '|' +
            (p.sharpness || 0) + '|' + (mask._tipId || '') + '|' + previewCell;

        var hit = _outlineFromLRU(key);
        if (hit) return { canvas: hit.canvas, w: hit.w, h: hit.h, key: key, offX: offX, offY: offY, angleDeg: effAngle };

        var sw = _max(1, _round(mask.width * z));
        var sh = _max(1, _round(mask.height * z));
        var scaled = document.createElement('canvas');
        scaled.width = sw;
        scaled.height = sh;
        var sctx = scaled.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.drawImage(mask, 0, 0, sw, sh);

        var img = sctx.getImageData(0, 0, sw, sh);
        var d = img.data;
        var n = sw * sh;
        var bin = new Uint8Array(n);
        for (var i = 0; i < n; i++) bin[i] = d[i * 4 + 3] > 96 ? 1 : 0;

        var out = new Uint8ClampedArray(n * 4);
        for (var yy = 0; yy < sh; yy++) {
            for (var xx = 0; xx < sw; xx++) {
                var idx = yy * sw + xx;
                if (!bin[idx]) continue;
                var l = xx > 0 ? bin[idx - 1] : 0;
                var r = xx < sw - 1 ? bin[idx + 1] : 0;
                var u = yy > 0 ? bin[idx - sw] : 0;
                var dn = yy < sh - 1 ? bin[idx + sw] : 0;
                var interior = l && r && u && dn;
                if (interior) continue;
                var o = idx * 4;
                out[o] = out[o + 1] = out[o + 2] = 255;
                out[o + 3] = 255;
            }
        }
        sctx.putImageData(new ImageData(out, sw, sh), 0, 0);

        var entry = { key: key, canvas: scaled, w: sw, h: sh };
        _outlineToLRU(entry);
        return { canvas: scaled, w: sw, h: sh, key: key, offX: offX, offY: offY, angleDeg: effAngle };
    }

    /* ------------------------------------------------------------------ */
    /*  Rope overlay — SVG catenary between cursor and brush               */
    /* ------------------------------------------------------------------ */

    var _ropeSvg = null;
    var _ropePath = null;

    function _ensureRopeSvg() {
        if (_ropeSvg) return;
        var ns = 'http://www.w3.org/2000/svg';
        _ropeSvg = document.createElementNS(ns, 'svg');
        _ropeSvg.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999;display:none';
        _ropeSvg.style.mixBlendMode = 'difference';
        _ropeSvg.setAttribute('viewBox', '0 0 ' + window.innerWidth + ' ' + window.innerHeight);
        _ropePath = document.createElementNS(ns, 'path');
        _ropePath.setAttribute('fill', 'none');
        _ropePath.setAttribute('stroke', '#fff');
        _ropePath.setAttribute('stroke-width', '2');
        _ropePath.setAttribute('stroke-linecap', 'round');
        _ropeSvg.appendChild(_ropePath);
        document.body.appendChild(_ropeSvg);
        window.addEventListener('resize', function () {
            _ropeSvg.setAttribute('viewBox', '0 0 ' + window.innerWidth + ' ' + window.innerHeight);
        });
    }

    function _updateRopeSvg(rawX, rawY, brushX, brushY, amount, speedScale) {
        _ensureRopeSvg();
        /* The DISPLAY canvas, never app.ctx. In layer mode app.ctx hands
         * back the active layer's OFF-SCREEN canvas, which is not in the
         * document — its bounding rect is all zeros, so the rope anchored
         * to the viewport corner instead of the cursor the moment a second
         * layer existed. Reading app.ctx here also cost a repaint per
         * mouse move, since that getter invalidates the compositor. */
        var canvas = app.ui && app.ui.cMain;
        if (!canvas) return;
        var rect = canvas.getBoundingClientRect();
        var zoom = (app.config && app.config.zoom) || 1;
        var sx = rawX * zoom + rect.left;
        var sy = rawY * zoom + rect.top;
        var bx = brushX * zoom + rect.left;
        var by = brushY * zoom + rect.top;
        var dx = bx - sx, dy = by - sy;
        var dist = Math.hypot(dx, dy);
        if (dist < 2) { _hideRopeSvg(); return; }
        var effective = amount * (1 + speedScale);
        var slack = Math.max(0, effective - dist / zoom);
        var sag = slack * 0.4 * zoom;
        var N = 30, path = 'M ' + sx.toFixed(1) + ',' + sy.toFixed(1);
        for (var i = 1; i <= N; i++) {
            var t = i / N;
            var px = sx + dx * t;
            var py = sy + dy * t + sag * 4 * t * (1 - t);
            path += ' L ' + px.toFixed(1) + ',' + py.toFixed(1);
        }
        _ropePath.setAttribute('d', path);
        _ropeSvg.style.display = 'block';
    }

    function _hideRopeSvg() {
        if (_ropeSvg) _ropeSvg.style.display = 'none';
    }

    /* ------------------------------------------------------------------ */
    /*  Dynamics — one input per parameter                                  */
    /* ------------------------------------------------------------------ */

    /* There used to be a single `dynamicsMode` dropdown: you picked ONE of
     * off/direction/angle/size/opacity/flow and that was the only thing
     * anything could respond to. Pressure driving size and flow was hardcoded
     * on top and could not be turned off or retuned. Every brush therefore
     * drew from the same one-dimensional well, which is why adding presets
     * alone would never have made them feel different.
     *
     * Now each parameter names its own input, its own floor and its own curve:
     *   <param>Src    which sensor drives it
     *   <param>Min    what it reads at sensor 0, as a percentage of the base
     *   <param>Curve  gamma on the sensor before it is applied
     *
     * The defaults reproduce the old hardcoded behaviour EXACTLY —
     * sizeSrc/sizeMin of pressure/50 is size * (0.5 + pressure * 0.5), and
     * flowSrc/flowMin of pressure/0 is flow * pressure — so every existing
     * preset is unchanged, and now editable. */

    // Tablet state, set by the paint engine from the pointer event.
    var _penTiltX = 0, _penTiltY = 0, _penTwist = 0, _penWheel = 0.5;

    var _isArray = Array.isArray;
    function _cloneCurve(c) {
        var out = [];
        // [x, y, corner?]; a list of inputs (sizeSensors) holds objects instead
        for (var i = 0; i < c.length; i++) out.push(_isArray(c[i]) ? c[i].slice(0, 3) : JSON.parse(JSON.stringify(c[i])));
        return out;
    }

    /* Points sorted by input, endpoints pinned, at most 8 — enough for an S
     * with room to spare, few enough that the widget stays draggable. */
    function _normalizeCurve(pts) {
        var out = [];
        for (var i = 0; i < pts.length; i++) {
            out.push([_clamp(pts[i][0], 0, 1), _clamp(pts[i][1], 0, 1)]);
        }
        out.sort(function (a, b) { return a[0] - b[0]; });
        if (out.length > 8) out.length = 8;
        return out;
    }

    function _setCurve(key, pts) {
        if (!pts || !pts.length) {
            _params[key + 'Curve'] = 1;       // back to linear
        } else {
            _params[key + 'Curve'] = _normalizeCurve(pts);
        }
        _persistParams();
        _invalidateSwatch(engine._currentPreset);
        engine.refreshPreview();
    }

    function _getCurve(key) {
        var c = _params[key + 'Curve'];
        return _isArray(c) ? _cloneCurve(c) : null;
    }

    /* What the widget draws, and what _dyn applies — the same function, so the
     * curve on screen is the curve the brush uses. */
    function _evalCurve(key, v) {
        return _curveAt(_params[key + 'Curve'], v, _params.curveSmooth);
    }

    function _setPenState(e) {
        if (!e) return;
        // tiltX/tiltY are degrees from vertical, -90..90.
        _penTiltX = e.tiltX || 0;
        _penTiltY = e.tiltY || 0;
        _penTwist = e.twist || 0;
        /* The airbrush wheel, which a pen reports as -1..1 with 0 in the
         * middle. Krita calls it tangential pressure and Photoshop calls it
         * the stylus wheel; both mean this one dial. */
        _penWheel = (e.tangentialPressure || 0) / 2 + 0.5;
    }

    function _tiltAmount() {
        // How far from upright, 0 (vertical) .. 1 (flat on the tablet).
        var t = _hypot(_penTiltX, _penTiltY) / 90;
        return _clamp(t, 0, 1);
    }

    /* Krita's tilt the other way up: 1 with the pen upright -- which is also
     * what a mouse reports -- falling to 0 at 60 degrees, where Krita's
     * scale stops. KisPaintInformation::tiltElevation, verbatim. Krita
     * brushes are drawn against this, so reading them through `tilt`
     * painted them inside out: the Marker Chisel came out 60px wide where
     * Krita paints it 7. */
    function _elevation() {
        var x = _clamp(_penTiltX / 60, -1, 1), y = _clamp(_penTiltY / 60, -1, 1);
        var e = Math.sqrt(1 + (Math.abs(x) > Math.abs(y) ? y * y : x * x));
        return Math.acos(Math.min(1, _hypot(x, y) / e)) / (_PI / 2);
    }

    /* Every sensor returns 0..1 so one formula drives every parameter.
     *
     * `fade` and `distance` are the two that do not come from the pen: they
     * come from how far into the stroke the dab is. Photoshop counts dabs
     * and fades from full to nothing across `fStp` of them, which is what
     * every one of its `bVTy = 1` dynamics means; Krita measures pixels
     * travelled instead and ramps up rather than down. Both are here because
     * both are common in real files, and neither can be faked with pressure. */
    function _sensor(src, sc, seed, p, e) {
        switch (src) {
            case 'pressure': return _clamp(sc.pressure, 0, 1);
            case 'tilt':     return _tiltAmount();
            case 'elevation': return _elevation();
            case 'twist':    return _clamp((_penTwist % 360) / 360, 0, 1);
            case 'wheel':    return _clamp(_penWheel, 0, 1);
            // Krita's scale is 30 px/ms (maxAllowedSpeedValue); ours predates it.
            case 'speed':    return _clamp(_smoothSpeed / _max(0.01, (p && p.speedMax) || 3), 0, 1);
            case 'random':   return _dabRand(sc.x, sc.y, seed);
            case 'fade':
                return _clamp(1 - _dabIndex / _max(1, (p && p.fadeSteps) || 25), 0, 1);
            // Krita's fade counts dabs UP from 0 (the first dab), holding at 1 or wrapping.
            case 'fadein':
                var fn = _max(1, (e && e.length) || (p && p.fadeSteps) || 25), fk = _max(0, _dabIndex - 1);
                return ((e && e.length ? e.periodic : p && p.fadePeriodic) ? fk % fn : _min(fk, fn)) / fn;
            case 'distance':
                /* engine.distanceFrom is for the Krita bank only: Node.paintLine's
                 * distance starts at the canvas origin, so every dab after the
                 * first has already travelled |start| (X3CD Doodle). */
                var dn = _max(1, (e && e.length) || (p && p.distanceLength) || 30),
                    dd = (_lastDabDist || 0) + (_dabIndex > 1 && engine.distanceFrom || 0);
                return (e && e.length ? e.periodic : p && p.distancePeriodic) ? (dd % dn) / dn : _clamp(dd / dn, 0, 1);
            default:         return 1;
        }
    }

    /* A response curve is either a gamma number (the shape phase 2 shipped,
     * and still what an untouched parameter carries) or a list of [in, out]
     * points the curve editor produced. Points are piecewise-linear rather
     * than splined: at the size these widgets are drawn nobody can see the
     * difference, and it is a fraction of the code.
     *
     * ponytail: linear interpolation between points; swap in a spline only if
     * someone can actually see the corners. */
    /* Krita draws a curve as a natural cubic spline through its points
     * (KisCubicSpline in kis_cubic_curve_spline.h: second derivative 0 at
     * both ends), and a point marked as a corner ([x, y, 1]) ends one spline
     * and starts the next. Joining the points with straight lines ran below
     * Krita's curve wherever it bows, so presets drawn in Krita take this
     * path (`curveSmooth`); everything else keeps straight lines. */
    var _splines = new WeakMap();
    function _buildSpline(c) {
        var runs = [], start = 0;
        for (var i = 1; i < c.length; i++) {
            if (i === c.length - 1 || c[i][2]) { runs.push(_naturalRun(c.slice(start, i + 1))); start = i; }
        }
        return runs;
    }
    function _naturalRun(p) {
        var n = p.length - 1, h = [], m = [0], i;
        for (i = 0; i < n; i++) h.push(_max(1e-9, p[i + 1][0] - p[i][0]));
        if (n > 1) {       // tridiagonal solve for the inner second derivatives
            var cp = [], dp = [];
            for (i = 1; i < n; i++) {
                var a = h[i - 1], b = 2 * (h[i - 1] + h[i]), cc = h[i];
                var f = 6 * ((p[i + 1][1] - p[i][1]) / h[i] - (p[i][1] - p[i - 1][1]) / h[i - 1]);
                var den = b - (i > 1 ? a * cp[i - 2] : 0);
                cp.push(cc / den);
                dp.push((f - (i > 1 ? a * dp[i - 2] : 0)) / den);
            }
            var inner = new Array(n - 1);
            for (i = n - 2; i >= 0; i--) inner[i] = dp[i] - (i < n - 2 ? cp[i] * inner[i + 1] : 0);
            m = m.concat(inner);
        }
        m.push(0);
        return { p: p, h: h, m: m };
    }
    function _splineAt(c, v) {
        var runs = _splines.get(c);
        if (!runs) { runs = _buildSpline(c); _splines.set(c, runs); }
        var x = _clamp(v, c[0][0], c[c.length - 1][0]);
        var r = runs[runs.length - 1];
        for (var k = 0; k < runs.length; k++) if (x <= runs[k].p[runs[k].p.length - 1][0]) { r = runs[k]; break; }
        var i = 0;
        while (i < r.h.length - 1 && x > r.p[i + 1][0]) i++;
        var t = x - r.p[i][0], hi = r.h[i], m0 = r.m[i], m1 = r.m[i + 1];
        var b = (r.p[i + 1][1] - r.p[i][1]) / hi - hi * (2 * m0 + m1) / 6;
        return _clamp(r.p[i][1] + b * t + m0 * t * t / 2 + (m1 - m0) * t * t * t / (6 * hi), 0, 1);
    }

    function _curveAt(curve, v, smooth) {
        if (curve == null) return v;
        if (typeof curve === 'number') {
            return curve === 1 ? v : _pow(v, curve);
        }
        if (!curve.length) return v;
        if (curve.length === 1) return _clamp(curve[0][1], 0, 1);
        if (smooth && curve.length > 2) return _splineAt(curve, v);
        for (var i = 0; i < curve.length - 1; i++) {
            var a = curve[i], b = curve[i + 1];
            if (v <= b[0]) {
                if (v <= a[0]) return _clamp(a[1], 0, 1);
                var span = b[0] - a[0];
                var t = span > 1e-6 ? (v - a[0]) / span : 0;
                return _clamp(a[1] + (b[1] - a[1]) * t, 0, 1);
            }
        }
        return _clamp(curve[curve.length - 1][1], 0, 1);
    }

    /* base scaled by its sensor, floored at <param>Min percent. */
    function _dyn(p, key, base, sc, seed) {
        // a Krita option's strength scales it, curve or none (KisCurveOption's constant)
        if (p[key + 'Strength'] != null) base *= p[key + 'Strength'];
        var list = p[key + 'Sensors'], v;
        if (list) v = _kritaInputs(list, p[key + 'Combine'], sc, seed, p);
        else {
            var src = p[key + 'Src'];
            if (!src || src === 'none') return base;
            v = _curveAt(p[key + 'Curve'], _sensor(src, sc, seed, p), p.curveSmooth);
        }
        var lo = (p[key + 'Min'] != null ? p[key + 'Min'] : 0) / 100;
        return base * (lo + (1 - lo) * v);
    }

    /* Several Krita inputs on one size-like option: the plain ones combine
     * by the option's mode (0 multiply, 1 add, 2 max, 3 min, 4 difference),
     * then a drawing angle multiplies in as an offset and rotations add in
     * on a -1..1 scale. The angle is 0.5 at a left-to-right stroke, and it
     * and its curve's output are both turned half a lap (wrapped into 0..1):
     * a curve reading 0.75 there scales the size by 0.25. */
    function _wrap1(x) { x %= 1; return x < 0 ? x + 1 : x; }
    function _kritaInputs(list, mode, sc, seed, p) {
        var n = 0, prod = 1, sum = 0, mx = 0, mn = 1, abs = 1, add = 0, hasAdd = false;
        for (var i = 0; i < list.length; i++) {
            var e = list[i], v;
            if (e.kind === 'const') v = e.v;
            else if (e.kind === 'abs') {
                v = 0.5 + ((e.locked ? _lockAngle : sc.strokeAngle) || 0) / 360 + (e.offset || 0) / 360;
                if (v > 1) v -= 1;
                abs = _wrap1(_curveAt(e.curve, _wrap1(v + 0.5), p.curveSmooth) + 0.5);
                continue;
            } else if (e.kind === 'add' || e.src === 'random') {
                /* Fuzzy is additive in Krita (KisDynamicSensorFuzzyBase), so it
                 * scales whatever the mode: max(fuzzy, pressure) at full pressure
                 * is pressure times fuzzy there -- RGBA Impasto-details' dabs came
                 * out all full size here and a random 0..1 of it in Krita. */
                var r = ((_penTwist % 360) + 540) % 360 - 180;       // -180..180, 0 upright
                add += 2 * _curveAt(e.curve, e.kind === 'add' ? 0.5 * (1 + r / 180) : _sensor(e.src, sc, seed, p, e), p.curveSmooth) - 1;
                hasAdd = true;
                continue;
            } else v = _curveAt(e.curve, _sensor(e.src, sc, seed, p, e), p.curveSmooth);
            n++; prod *= v; sum += v; mx = _max(mx, v); mn = _min(mn, v);
        }
        var scale = !n ? 1 : mode === 1 ? sum : mode === 2 ? mx : mode === 3 ? mn : mode === 4 ? mx - mn : prod;
        return _clamp(scale * abs * (hasAdd ? 0.5 * (1 + add) : 1), 0, 1);
    }

    /* Angle is degrees added to the tip, not a factor scaling it, so it reads
     * its sensor directly rather than through _dyn. */
    function _dynAngle(p, baseAngle, sc) {
        var src = p.angleSrc;
        /* Several inputs: Krita's rotationLikeValue whole. The drawing angle
         * is an offset, pen twist and random add, the rest combine by the
         * option's mode and turn the other way; wrap(2 off + strength *
         * (add - (2 scale - 1))) is a turn in halves, minus ours. A list
         * with Krita's tangential pressure in it multiplies by its 0, so
         * Bristle_frottis0017's tip lies a half turn from the stroke. */
        if (p.angleSensors) {
            var L = p.angleSensors, off = 0, add = 0, hasAdd = false, n = 0, prod = 1, sum = 0, mx = 0, mn = 1;
            for (var i = 0; i < L.length; i++) {
                var e = L[i], v;
                if (e.kind === 'abs') {
                    v = _wrap1(0.5 + ((e.locked ? _lockAngle : sc.strokeAngle) || 0) / 360 + (e.offset || 0) / 360);
                    off = _wrap1(_curveAt(e.curve, _wrap1(v + 0.5), p.curveSmooth) + 0.5);
                    continue;
                }
                if (e.kind === 'add' || e.src === 'random') {
                    var r = e.kind === 'add' ? 0.5 + (((_penTwist % 360) + 540) % 360 - 180) / 360 : _sensor(e.src, sc, 11, p, e);
                    add += 2 * _curveAt(e.curve, r, p.curveSmooth) - 1; hasAdd = true;
                    continue;
                }
                v = e.kind === 'const' ? e.v : _curveAt(e.curve, _sensor(e.src, sc, 11, p, e), p.curveSmooth);
                n++; prod *= v; sum += v; mx = _max(mx, v); mn = _min(mn, v);
            }
            var m = p.angleCombine, scl = m === 1 ? sum : m === 2 ? mx : m === 3 ? mn : m === 4 ? mx - mn : prod;
            var w = 2 * off + (p.angleStrength == null ? 1 : p.angleStrength) * ((n ? -(2 * scl - 1) : 0) + (hasAdd ? add : 0));
            w = ((w + 1) % 2 + 2) % 2 - 1;
            return baseAngle + 180 * (w - 1);
        }
        /* The lock is the rotation sensor's own: a size list reading the
         * drawing angle unlocked beside it still follows the stroke (Poska
         * Triangle G). */
        if (src === 'direction' && sc.strokeAngle != null) return (p.angleLocked ? _lockAngle : sc.strokeAngle) + baseAngle;
        if (src === 'twist' && p.angleStrength == null) return baseAngle + (_penTwist % 360);
        if (src === 'tilt') return baseAngle + _atan2(_penTiltY, _penTiltX) * 180 / _PI;
        /* How far the turn reaches. 180 is a full turn either way, which is
         * what this always did; anything less is a tip that wobbles rather
         * than spins, and Photoshop and Procreate both ask for small
         * wobbles far more often than for full spins. */
        var range = p.angleRange == null ? 180 : p.angleRange;
        /* A Krita rotation option (KisRotationOption::apply): the tip turns
         * by (1 - v) * pi, v = strength * the sensor as -1..1 (random reads
         * additive, the rest scaling, which Krita negates), and Krita's turn
         * shows as minus ours. So a tip with the option on sits upside down
         * and wobbles from there: Waterpaint's knife turns 160..207 degrees,
         * not a full spin. */
        if (p.angleStrength != null && src && src !== 'none') {
            /* Pen rotation is additive too, -180..180 read as -1..1
             * (KisDynamicSensorRotation), so an upright pen is the half turn
             * alone: Bear Paw's paw stands on its head in Krita. */
            var tw = src === 'twist' ? 0.5 + (((_penTwist % 360) + 540) % 360 - 180) / 360 : null;
            var c = _curveAt(p.angleCurve, tw != null ? tw : _sensor(src, sc, 11, p, p.angleReach), p.curveSmooth);
            var v = p.angleStrength * (2 * c - 1) * (src === 'random' || tw != null ? 1 : -1);
            v = ((v + 1) % 2 + 2) % 2 - 1;
            return baseAngle + 180 + 180 * v;
        }
        if (src === 'random') return baseAngle + (_dabRand(sc.x, sc.y, 11) * 2 - 1) * range;
        /* Anything else the sensors understand spins the tip through a full
         * turn across its range. Krita lets pressure drive rotation and
         * eleven of David Revoy's thirty-eight brushes use it; this used to
         * fall through to `return baseAngle`, so the importer had to refuse
         * those sources rather than set one the engine would ignore in
         * silence. Handling them here is the fix for both halves. */
        if (src && src !== 'none') {
            return baseAngle + _sensor(src, sc, 11, p, p.angleReach) * range * 2;
        }
        return baseAngle;
    }

    /* What the brush is currently carrying.
     *
     * Smudge used to re-sample the canvas at every dab and mix that with the
     * brush colour. That cannot carry pigment: each dab started again from
     * whatever was underneath, so colour never travelled along the stroke,
     * and because the sampler reads a snapshot taken BEFORE the stroke, a
     * smudge could not even see its own trail.
     *
     * A brush that smudges has to remember what it picked up and let go of
     * it gradually. smudgeLength is how much of the load survives each dab:
     * 0 re-loads every dab (the old behaviour), 100 never lets go. */
    /* One reservoir per bristle, slot 0 for a plain head. A rake dragged
     * across two colours picks up both, one per hair, which is the whole
     * character of Krita's rake smudges -- with a single shared load they
     * came out as one averaged smear. */
    var _wet = [];
    var _wetPos = [];
    var WET_HALF_MAX = 40;   // px the load takes to half fade, at carry 100

    /* What the brush picks up is what is UNDER it, not what is under its
     * exact centre. Krita's colorsmudge averages the dab's whole footprint;
     * sampling one pixel meant a smudge crossing a pencil line either caught
     * the line or missed it entirely, and which one was a coin toss decided
     * by spacing. Five taps: the centre plus four at half the radius, which
     * is enough to stop a single stray pixel deciding the load and cheap
     * enough to do per dab.
     *
     * Weighted by alpha, so the transparent half of a dab straddling an edge
     * contributes nothing rather than dragging the load toward black. */
    var _TAPX = [0, -1, 1, 0, 0], _TAPY = [0, 0, 0, -1, 1];

    function _sampleRegion(ctx, x, y, r) {
        if (!(r > 1.5)) return _sampleCanvasColor(ctx, x, y);
        var o = r * 0.5;
        var rs = 0, gs = 0, bs = 0, as = 0, wsum = 0, hits = 0;
        for (var i = 0; i < 5; i++) {
            var c = _sampleCanvasColor(ctx, x + _TAPX[i] * o, y + _TAPY[i] * o);
            if (!c) continue;
            hits++;
            as += c[3];
            var w = c[3] / 255;
            rs += c[0] * w; gs += c[1] * w; bs += c[2] * w;
            wsum += w;
        }
        if (!hits) return null;
        if (wsum < 1e-6) { _smp[0] = _smp[1] = _smp[2] = _smp[3] = 0; return _smp; }
        _smp[0] = rs / wsum; _smp[1] = gs / wsum; _smp[2] = bs / wsum; _smp[3] = as / hits;
        return _smp;
    }

    function _wetColor(p, x, y, colorHex, slot, radius, rate) {
        slot = slot || 0;
        /* A wash never picks colour up off the canvas. Our smudge and Clip
         * Studio's colour mixing look like the same control and are not:
         * measured against real Clip Studio, a white stroke laid across an
         * existing one leaves that stroke exactly as it was, so whatever
         * mixing does there it does not change the colour a dab deposits --
         * while ours deposits colorRate% brush plus the rest canvas. With
         * that mapped across, this brush's mixing of 25 darkened everything a
         * white stroke crossed and, on a fresh document, drank the white
         * background into every dab (a fresh CDPaint document is opaque white
         * PIXELS; in Clip Studio the white is a separate Paper layer the
         * mixing cannot read). Measured on ten stacked strokes of #87CEEB: it
         * cost about a fifth of the first stroke's coverage, and a white
         * stroke over the stack darkened it from (7,53,137) to (8,47,126).
         *
         * Here rather than only in the importer (which no longer maps mixing
         * at all) because presets are already saved to localStorage with the
         * old value, and those must stop smudging without being re-imported.
         * Nothing sets `watercolor` but the Clip Studio importer -- there is
         * no UI control for it -- so this cannot take a smudge away from a
         * brush anyone deliberately built. */
        if (p.watercolor) return colorHex;
        if (rate == null) rate = p.colorRate;
        /* How wide a patch the brush picks colour up from. A dab's own
         * radius is the default and was the only option; MyPaint alone spans
         * a quarter of that to four times it across its own collection, and
         * a wide sampler is what makes a blender blend rather than smear. */
        var reach = (radius || 0) * (p.smudgeRadius == null ? 100 : p.smudgeRadius) / 100;
        var s = _sampleRegion(_outCtx(), x, y, reach);
        var w = _wet[slot];
        // Nothing under the brush means nothing to pick up. Without this the
        // load is dragged toward a transparent pixel's black.
        if (s && s[3] > 8) {
            var pos = _wetPos[slot];
            if (w && pos && p.smudgeLength > 0) {
                /* Decay per pixel travelled, never per dab. Per dab, spacing
                 * silently decides how far colour carries — a tight brush
                 * turns its load over in a few pixels and a sparse one drags
                 * it across the canvas, from the same slider setting. */
                var half = _max(0.5, _pow(_clamp(p.smudgeLength, 0, 100) / 100, 2) * WET_HALF_MAX);
                var k = _pow(0.5, _hypot(x - pos[0], y - pos[1]) / half);
                w = [_lerp(s[0], w[0], k),
                     _lerp(s[1], w[1], k),
                     _lerp(s[2], w[2], k)];
            } else {
                w = [s[0], s[1], s[2]];
            }
            _wet[slot] = w;
            _wetPos[slot] = [x, y];
        }
        /* An unloaded pure smudge has nothing to put down. Painting the
         * brush colour instead would make a smudge brush draw over empty
         * canvas, and the old code was worse still — it read a transparent
         * pixel as opaque black and smeared that. */
        if (!w) return rate <= 0 ? null : colorHex;
        return _mixColors(w, colorHex, rate);
    }

    /* Krita's colour smudge (smudgeMode set), rebuilt from black-box renders
     * (test/krita/probes/smudge, smudge2) rather than from its source.
     *
     * A dab does not carry a colour, it carries PIXELS: it takes up what lies
     * under the previous dab (smearing, mode 0) or the one pixel under that
     * dab's centre (dulling, mode 1), mixes the paint colour in, and lays
     * that down at smudge rate s times the tip and the flow, replacing rather
     * than covering -- so on an empty layer what it picks up is transparency,
     * and the paint comes out diluted the way Krita's does, while at s = 0 it
     * lays down nothing at all. The very first dab only picks up. All mixing
     * is premultiplied.
     *
     * The paint's share is NOT the colour rate c: it is c * max(0.2, 1 - s),
     * fitted per setting on Krita's renders (0.75, 0.5, 0.25, 0.2, 0.2 of c
     * at s = 0.25 .. 1, the same at twice the size). With it the whole grid
     * matches Krita to within a level or so; with plain c a long stroke went
     * black in a few pixels where Krita's took a hundred and fifty.
     *
     * Straight onto the layer, like the deform brush: each dab has to read
     * what the one before it left. */
    var _smPrev = null, _smCar = null, _smPx = NaN, _smPy = NaN, _mixTex = null, _mixTexA = null;
    var _smMaskA = new WeakMap();

    /* Krita smudges on a precise copy of the layer kept for the whole stroke
     * (KisOverlayPaintDeviceWrapper, LazyPreciseMode), so a dab too faint
     * for 8 bits still adds up: Oil Camel's light end gains 0.03 of a level
     * a dab, which the layer rounded away every time, and its line stayed
     * empty for a third of its length. The copy is premultiplied floats in
     * 64px tiles, made where the stroke reads, alpha -1 until then.
     * ponytail: float tiles, 64KB each; a stroke over a whole 4k canvas
     * holds ~256MB, go 16-bit if that ever bites. */
    var _smT = null, _smF = null;
    /* A merged smudge (Krita's MergedPaint, KisColorSmudgeSourceImage)
     * picks up from the whole picture, not the layer: its own precise copy
     * of the projection, which each dab paints into as well as the layer.
     * Picked up off the layer alone, EO Smudge Wet laid see-through black
     * where Krita, over its white background, lays opaque grey.
     * ponytail: the picture is read whole once a stroke (4 bytes a pixel);
     * read it by the dab's rect if big documents stall. */
    var _smS = null, _smG = null, _smPic = null, _smB = new Float64Array(4);
    function _smRead(d, rx, ry, rw, rh, T, F, pic) {
        var n = rw * rh * 4;
        if (!F || F.length < n) F = new Float32Array(n);
        var f = F, W = pic ? _docW() : 0;
        for (var j = 0; j < rh; j++) for (var i = 0; i < rw; i++) {
            var gx = rx + i, gy = ry + j, q = (j * rw + i) * 4;
            var tl = T && T.get((gy >> 6) * 65536 + (gx >> 6)), o = ((gy & 63) * 64 + (gx & 63)) * 4;
            if (tl && tl[o + 3] >= 0) { f[q] = tl[o]; f[q + 1] = tl[o + 1]; f[q + 2] = tl[o + 2]; f[q + 3] = tl[o + 3]; }
            else {
                var sd = W ? pic : d, sq = W ? (gy * W + gx) * 4 : q, a = sd[sq + 3] / 255;
                f[q] = sd[sq] * a; f[q + 1] = sd[sq + 1] * a; f[q + 2] = sd[sq + 2] * a; f[q + 3] = sd[sq + 3];
            }
        }
        return f;
    }
    function _smWrite(f, rx, ry, rw, rh, T) {
        for (var j = 0; j < rh; j++) for (var i = 0; i < rw; i++) {
            var gx = rx + i, gy = ry + j, q = (j * rw + i) * 4, key = (gy >> 6) * 65536 + (gx >> 6);
            var tl = T.get(key);
            if (!tl) { tl = new Float32Array(16384).fill(-1); T.set(key, tl); }
            var o = ((gy & 63) * 64 + (gx & 63)) * 4;
            tl[o] = f[q]; tl[o + 1] = f[q + 1]; tl[o + 2] = f[q + 2]; tl[o + 3] = f[q + 3];
        }
    }

    /* Krita's averaged dulling sample (KisColorSmudgeSampleUtils::sampleColor
     * with AveragedSampleWrapper), into _smB as straight 8-bit RGBA: pixels
     * of the patch q = [x, y, w, h] in Halton order (bases 2 and 3, so some
     * twice and some never), at least min(n, 64) of them, then 16 at a time
     * until the mix moves by 2 or less (KoLcmsColorSpace::differenceA). */
    var _smL = new Float64Array(4);
    function _smAvg(g, rx, ry, rw, rh, q) {
        var w = q[2], h = q[3], n = w * h, first = _min(n, _max(64, _round(0.02 * n)));
        var hn = 0, hd = 1, vn = 0, vd = 1, sr = 0, sg = 0, sb = 0, sa = 0, k, y, i;
        for (i = 1; i <= n; i++) {
            k = hd - hn;                        // KisAlgebra2D::HaltonSequenceGenerator
            if (k === 1) { hn = 1; hd *= 2; } else { y = _floor(hd / 2); while (k <= y) y = _floor(y / 2); hn = 3 * y - k; }
            k = vd - vn;
            if (k === 1) { vn = 1; vd *= 3; } else { y = _floor(vd / 3); while (k <= y) y = _floor(y / 3); vn = 4 * y - k; }
            var gx = q[0] + _floor((hn * (w - 1) + (hd >> 1)) / hd) - rx, gy = q[1] + _floor((vn * (h - 1) + (vd >> 1)) / vd) - ry;
            if (gx >= 0 && gy >= 0 && gx < rw && gy < rh) {
                var t = (gy * rw + gx) * 4;
                sr += g[t]; sg += g[t + 1]; sb += g[t + 2]; sa += g[t + 3];
            }
            if (i < first || (i < n && (i - first) % 16)) continue;
            _smB[0] = sa > 0 ? _round(sr * 255 / sa) : 0; _smB[1] = sa > 0 ? _round(sg * 255 / sa) : 0;
            _smB[2] = sa > 0 ? _round(sb * 255 / sa) : 0; _smB[3] = _round(sa / i);
            if (i > first && _labDiff(_smB, _smL) <= 2) return;
            _smL.set(_smB);
        }
    }
    function _labOf(c, o) {
        var r = _lin(c[0]), gg = _lin(c[1]), b = _lin(c[2]);   // sRGB, D50 (lcms's Lab)
        var fx = _labF((0.4360747 * r + 0.3850649 * gg + 0.1430804 * b) / 0.9642);
        var fy = _labF(0.2225045 * r + 0.7168786 * gg + 0.0606169 * b);
        var fz = _labF((0.0139322 * r + 0.0971045 * gg + 0.7141733 * b) / 0.8249);
        o[0] = 116 * fy - 16; o[1] = 500 * (fx - fy); o[2] = 200 * (fy - fz);
    }
    function _lin(v) { v /= 255; return v <= 0.04045 ? v / 12.92 : _pow((v + 0.055) / 1.055, 2.4); }
    function _labF(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
    var _labA = [0, 0, 0], _labB = [0, 0, 0];
    function _labDiff(a, b) {
        if (!a[3] || !b[3]) return a[3] === b[3] ? 0 : 255;
        _labOf(a, _labA); _labOf(b, _labB);
        var dl = _labA[0] - _labB[0], da = _labA[1] - _labB[1], db = _labA[2] - _labB[2], dA = (a[3] - b[3]) * 100 / 255;
        return _min(255, _floor(Math.sqrt(dl * dl + da * da + db * db + dA * dA)));
    }

    function _smudgeDab(p, x, y, mask, colorHex, alpha, sc, sz, tex, asp) {
        var ctx = _outCtx();
        if (!ctx) return;
        var ma = _smMaskA.get(mask);
        if (!ma) {
            var mc = new OffscreenCanvas(mask.width, mask.height).getContext('2d', { willReadFrequently: true });
            mc.drawImage(mask, 0, 0);
            var md = mc.getImageData(0, 0, mask.width, mask.height).data;
            ma = new Uint8Array(mask.width * mask.height);
            for (var q = 0; q < ma.length; q++) ma[q] = md[q * 4 + 3];
            _smMaskA.set(mask, ma);
        }
        var mw = mask.width, mh = mask.height;
        var cx = mask._cx != null ? mask._cx : mw / 2, cy = mask._cy != null ? mask._cy : mh / 2;
        var ox = _round(x - cx), oy = _round(y - cy);
        /* Clip Studio's paper grain thins what a mixing dab lays down, as it
         * does a plain dab (_applyTextureNoise on a copy of the tip); the
         * pick-up still reads the whole tip. Without it Dry Gouache's dry
         * brush came out a solid bar, 1.28x Clip Studio's ink. */
        var mt = null, mtr = false;
        if (p.mixAlpha != null && tex > 0 && !p.textureMode) {
            if (!_mixTex || _mixTex.width < mw || _mixTex.height < mh) _mixTex = new OffscreenCanvas(mw, mh);
            var tc = _mixTex.getContext('2d', { willReadFrequently: true });
            tc.clearRect(0, 0, mw, mh);
            tc.drawImage(mask, 0, 0);
            var mtr = _applyTextureNoise(tc, mw, mh, tex, p.textureScale, p.textureType, ox, oy, p.textureBlend, _clamp(alpha, 0, 1));
            var td = tc.getImageData(0, 0, mw, mh).data;
            if (!_mixTexA || _mixTexA.length < mw * mh) _mixTexA = new Uint8Array(mw * mh);
            mt = _mixTexA;
            for (var q2 = 0; q2 < mw * mh; q2++) mt[q2] = td[q2 * 4 + 3];
        }
        /* Krita's own rect for this dab (KisDabCacheBase): its corner the
         * whole pixel under the cursor less half the tip, as wide as the tip
         * plus that phase, rounded up. Our tip canvases are padded, so the
         * dulling pick-up below is placed from this, not from them.
         * ponytail: an unturned tip's size; a turned one's bounds are wider. */
        var kw = (sz || mw) * _min(1, asp || 1), kh = (sz || mh) / _max(1, asp || 1);
        var kx = _floor(x - kw / 2), ky = _floor(y - kh / 2);
        var kW = _max(1, _ceil(x - kw / 2 - kx + kw - 1e-6)), kH = _max(1, _ceil(y - kh / 2 - ky + kh - 1e-6));
        var prev = _smPrev;
        _smPrev = [x, y, kx + kW / 2, ky + kH / 2];
        if (!prev) {                        // the first dab only loads the brush
            _smPic = null;
            if (p.smudgeMerged && app.layerMgr && app.layerMgr.getFlattenedCanvas) {
                try { _smPic = app.layerMgr.getFlattenedCanvas().getContext('2d').getImageData(0, 0, _docW(), _docH()).data; } catch (e0) { _smPic = null; }
            }
            if (p.mixAlpha == null) return;
            prev = _smPrev;                 // Clip Studio's first dab paints
        }
        /* How far the pick-up moves: both ends rounded against the SAME
         * half size, so a 1.64px step alternates 1 and 2 as Krita's does.
         * Rounded against this dab's own phase (round tips are built at it)
         * it came out 2 every time, and colour travelled a fifth too far. */
        var h = (sz || mw) / 2;
        var sx = ox - (_round(x - h) - _round(prev[0] - h)), sy = oy - (_round(y - h) - _round(prev[1] - h));
        // One read covering both footprints.
        var W = _docW(), H = _docH();
        var rx = _max(0, _min(ox, sx)), ry = _max(0, _min(oy, sy));
        var rw = _min(W, _max(ox, sx) + mw) - rx, rh = _min(H, _max(oy, sy) + mh) - ry;
        /* The old engine's dulling averages a patch of the last dab's rect
         * (KisColorSmudgeStrategyMaskLegacy): blown by half of (radius - 1)
         * a side, joined to its centre pixel as QRect's | joins, and read
         * as far as it reaches. */
        var sR = p.smudgeMode === 1 && !p.smudgeNew && p.smudgeSample > 0 ? _dyn(p, 'smudgeSample', p.smudgeSample, sc, 17) : 0, sq = null;
        if (sR > 0) {
            var sL = kx + _round(prev[2] - kx - kW / 2), sT = ky + _round(prev[3] - ky - kH / 2);
            var bw = Math.trunc(kW * 0.5 * (sR - 1)), bh = Math.trunc(kH * 0.5 * (sR - 1));
            var ccx = Math.trunc((2 * sL + kW - 1) / 2), ccy = Math.trunc((2 * sT + kH - 1) / 2);
            var x1 = sL - bw, x2 = sL + kW - 1 + bw, y1 = sT - bh, y2 = sT + kH - 1 + bh;
            if (x2 === x1 - 1 && y2 === y1 - 1) { x1 = x2 = ccx; y1 = y2 = ccy; }
            else { x1 = _min(x1, ccx); x2 = _max(x2, ccx); y1 = _min(y1, ccy); y2 = _max(y2, ccy); }
            sq = [x1, y1, x2 - x1 + 1, y2 - y1 + 1];
            var nx = _max(0, _min(rx, x1)), ny = _max(0, _min(ry, y1));
            rw = _min(W, _max(rx + rw, x2 + 1)) - nx; rh = _min(H, _max(ry + rh, y2 + 1)) - ny; rx = nx; ry = ny;
        }
        if (rw <= 0 || rh <= 0) return;
        var c = _clamp(_dyn(p, 'colorRate', p.colorRate, sc, 9), 0, 100) / 100;
        var s = p.smudgeFull ? 1 : _clamp(_dyn(p, 'smudgeRate', p.smudgeRate == null ? 100 : p.smudgeRate, sc, 15), 0, 100) / 100;
        /* The opacity curve scales the whole dab, smear and paint alike, and
         * on colour smudge it acts with its pressure switch off too: a flat
         * 0.5 smudge under a linear opacity curve at pressure 0.5 smeared as
         * a flat 0.25, switch on or off (test/krita/probes/smudge6). */
        /* The opacity slider does the same: a smudge writes the layer dab by
         * dab, so the stroke-wide opacity the other brushes get never reached
         * it. Slider 0.5 painted Krita's 209 where ours stayed at 253
         * (test/krita/probes/smudge7). */
        var op = _adO * (p.opacity == null ? 100 : p.opacity) / 100;
        var k0 = s * _clamp(alpha, 0, 1) * op;
        /* Krita's new smudge engine (SmudgeRateUseNewEngine,
         * KisColorSmudgeStrategyMask) mixes the dab before laying it: what
         * is under it takes the pick-up at smudge rate x opacity (dulling
         * 0.8 of that), copied or laid over as SmearAlpha says; the paint
         * goes in at colour rate squared x opacity by the preset's own blend;
         * and that is copied through the tip at full strength. EO Smudge
         * Color's 0.12 colour rate lays 1.4% a dab, not 12%.
         * ponytail: dodge and burn blend the paint, any other mode is normal. */
        var nw = p.smudgeNew, fp = op * _clamp(alpha, 0, 1), sO = 0, cO = 0, cm = 0;
        if (nw) {
            sO = (p.smudgeMode === 1 ? 0.8 : 1) * s * fp; cO = c * c * fp;
            cm = p.blendMode === 'color-dodge' ? 1 : p.blendMode === 'color-burn' ? 2 : 0;
        } else if (!(k0 > 0)) return;
        if (!(fp > 0)) return;
        /* The paint's share reads the smudge rate's slider, not its curve,
         * and the opacity curve thins it as well: Basic_mix's own curves at
         * pressure 0.6..1 fit this and not the curved rate (smudge4/5/6,
         * mean error 6.1 -> 2.6 levels on smudge4). */
        var sv = (p.smudgeRate == null ? 100 : p.smudgeRate) / 100, mix = p.mixAlpha != null;
        c *= _max(0.2, 1 - sv) * op;
        var rgb = _hexToRgb(colorHex);
        var pr = rgb[0] * c, pg = rgb[1] * c, pb = rgb[2] * c, pa = 255 * c;
        if (app.layerMgr && app.layerMgr.markDirty && ctx === app.ctx) app.layerMgr.markDirty(rx - 1, ry - 1, rw + 2, rh + 2);
        var img;
        try { img = ctx.getImageData(rx, ry, rw, rh); } catch (e) { return; }
        var d = img.data, f = _smF = _smRead(d, rx, ry, rw, rh, _smT, _smF), src = new Float32Array(mw * mh * 4);
        if (!_smT) _smT = new Map();
        var g = f;                          // where it picks up from: the layer, or the merged picture
        if (_smPic) { if (!_smS) _smS = new Map(); g = _smG = _smRead(d, rx, ry, rw, rh, _smS, _smG, _smPic); }
        var i, j, t, u, a, n;
        /* Clip Studio's density of paint (BrushMixAlpha), measured on its own
         * renders of Round mixing brush, one setting changed at a time: the
         * paint lands at density + (1 - density) x the alpha the brush
         * carries, replacing what is under it, and what it carries is the
         * mean alpha under the dab before it lands. On an empty layer part
         * of every dab is over nothing, so the line settles short of solid:
         * density 20/50/80 at 192/236/250 in Clip Studio, and this rule
         * predicts 193/236/250 from the 50 alone. Colour stretch
         * (BrushMixColorExtension) is how long the load lasts: its fade-in
         * halves over about 0.65 x the brush size at 100, linearly less
         * below (size 50 at 100/80/50, size 20 at 100), none at 0. Amount of
         * paint (BrushMixColor) did not move the alpha at all.
         * ponytail: the paint keeps the brush's own colour; Clip Studio's
         * colour pick-up (amount of paint) is unmeasured. */
        if (mix) {
            var ua = 0, uw = 0;
            for (j = 0; j < mh; j++) for (i = 0; i < mw; i++) {
                var mm = ma[j * mw + i], qx2 = ox + i - rx, qy2 = oy + j - ry;
                if (!mm || qx2 < 0 || qy2 < 0 || qx2 >= rw || qy2 >= rh) continue;
                ua += f[(qy2 * rw + qx2) * 4 + 3] * mm; uw += mm;
            }
            var ub = uw ? ua / uw / 255 : 0, hl = 0.65 * (sz || mw) * _clamp(p.mixStretch, 0, 100) / 100;
            /* A spray's load fades as the pen travels, not as its particles
             * jump about: Pointillism with colour change off (cdp-csp/qp qpc)
             * climbs from 133 to 229 at most along Clip Studio's stroke, where
             * fading particle to particle ours reached 252, ink 1.11 -> 1.01. */
            var mvx = x - prev[0], mvy = y - prev[1];
            if (p.sprayEach) { mvx = sc.x - _smPx; mvy = sc.y - _smPy; _smPx = sc.x; _smPy = sc.y; }
            _smCar = _smCar == null || !(hl > 0) ? ub : ub + (_smCar - ub) * _pow(0.5, (_hypot(mvx, mvy) || 0) / hl);
            var A = _clamp(p.mixAlpha, 0, 100) / 100;
            c = A + (1 - A) * (p.mixFlat ? 0 : _smCar);    // opacity is in the dab's k0 already; mixFlat: Clip Studio's BrushWaterColor 1
            pr = rgb[0] * c; pg = rgb[1] * c; pb = rgb[2] * c; pa = 255 * c;
        }
        // What the brush picked up, premultiplied; off the canvas is transparent.
        for (j = 0; !mix && j < mh; j++) {
            for (i = 0; i < mw; i++) {
                var gx = sx + i - rx, gy = sy + j - ry;
                if (gx < 0 || gy < 0 || gx >= rw || gy >= rh) continue;
                t = (gy * rw + gx) * 4; u = (j * mw + i) * 4;
                src[u] = g[t]; src[u + 1] = g[t + 1]; src[u + 2] = g[t + 2]; src[u + 3] = g[t + 3];
            }
        }
        if (p.smudgeMode === 1) {
            /* Dulling: one colour, the pixel at the centre of the previous
             * dab's rect -- QRect::center(), which rounds toward the top left,
             * so a 30px dab at y 60 reads row 59. On a bristle tip one row is
             * another bristle: under the dab's own centre Oil Camel laid 1.45x
             * Krita's ink. */
            var qx = kx + _round(prev[2] - kx - kW / 2) + ((kW - 1) >> 1) - rx;
            var qy = ky + _round(prev[3] - ky - kH / 2) + ((kH - 1) >> 1) - ry, ar = 0, ag = 0, ab = 0, aa = 0;
            if (sq) {
                _smAvg(g, rx, ry, rw, rh, sq);
                aa = _smB[3]; ar = _smB[0] * aa / 255; ag = _smB[1] * aa / 255; ab = _smB[2] * aa / 255;
            } else if (qx >= 0 && qy >= 0 && qx < rw && qy < rh) {
                t = (qy * rw + qx) * 4;
                ar = g[t]; ag = g[t + 1]; ab = g[t + 2]; aa = g[t + 3];
            }
            for (n = 0; n < ma.length; n++) { u = n * 4; src[u] = ar; src[u + 1] = ag; src[u + 2] = ab; src[u + 3] = aa; }
        }
        /* Texture thins the tip where the paper is low, as it does a plain
         * dab (_applyKritaTexture's rule, pinned to the document): smooth,
         * pastel_014 laid 2.1x Krita's ink. */
        var tx = p.textureMode && tex > 0 ? _kritaTexMask(p) : null;
        var ts = tx ? _clamp(tex / 100, 0, 1) : 0;
        var locked = _alphaLocked();
        var stencil = null;
        if (_selStencil && !_previewTarget) {
            try { stencil = _selStencil.getContext('2d').getImageData(rx, ry, rw, rh).data; } catch (e2) { stencil = null; }
        }
        for (j = 0; j < mh; j++) {
            for (i = 0; i < mw; i++) {
                var m = ma[j * mw + i];
                if (!m) continue;
                if (tx) {
                    m = _min(255, _kritaTexCut(m, tx.m[((((oy + j - (p.textureOffsetY || 0)) % tx.h) + tx.h) % tx.h) * tx.w + ((((ox + i - (p.textureOffsetX || 0)) % tx.w) + tx.w) % tx.w)] / 255, ts, p));
                    if (!(m > 0)) continue;
                }
                var px = ox + i - rx, py = oy + j - ry;
                if (px < 0 || py < 0 || px >= rw || py >= rh) continue;
                t = (py * rw + px) * 4; u = (j * mw + i) * 4;
                if (stencil && !stencil[t + 3]) continue;
                var k, ci = 1 - c, B = _smB;
                if (!nw) {          // legacy, premultiplied: lerp(dst, lerp(pickup, paint, c), s * tip)
                    k = mtr ? k0 / _clamp(alpha, 0, 1) * mt[j * mw + i] / 255 : k0 * m / 255;
                    B[0] = src[u] * ci + pr; B[1] = src[u + 1] * ci + pg; B[2] = src[u + 2] * ci + pb; B[3] = src[u + 3] * ci + pa;
                    if (mt && !mtr) { var gr = mt[j * mw + i] / m; B[0] *= gr; B[1] *= gr; B[2] *= gr; B[3] *= gr; }
                } else {
                    k = m / 255;
                    var sa = p.smudgeSmearAlpha === false ? src[u + 3] / 255 * sO : 0;
                    for (n = 0; n < 4; n++) B[n] = sa ? src[u + n] * sO + g[t + n] * (1 - sa) : g[t + n] + (src[u + n] - g[t + n]) * sO;
                    if (cO > 0 && !cm) { for (n = 0; n < 3; n++) B[n] += (rgb[n] - B[n]) * cO; B[3] += (255 - B[3]) * cO; }
                    else if (cO > 0) {          // KoCompositeOpGenericSC: colour dodge / burn
                        var dA = B[3] / 255;
                        for (n = 0; n < 3; n++) {
                            var S = rgb[n], D = dA > 0 ? B[n] / dA : 0;
                            var fz = cm === 1 ? (D <= 0 ? 0 : S >= 255 ? 255 : _min(255, D * 255 / (255 - S)))
                                : (S <= 0 ? (D >= 255 ? 255 : 0) : 255 - _min(255, (255 - D) * 255 / S));
                            B[n] = (1 - cO) * dA * D + (1 - dA) * cO * S + cO * dA * fz;
                        }
                        B[3] = (cO + dA - cO * dA) * 255;
                    }
                }
                if (g !== f) for (n = 0; n < 4; n++) g[t + n] += (B[n] - g[t + n]) * k;
                var oa = f[t + 3] + (B[3] - f[t + 3]) * k;
                var or = f[t] + (B[0] - f[t]) * k;
                var og = f[t + 1] + (B[1] - f[t + 1]) * k;
                var ob = f[t + 2] + (B[2] - f[t + 2]) * k;
                if (oa <= 0) { if (!locked) { d[t + 3] = 0; f[t] = f[t + 1] = f[t + 2] = f[t + 3] = 0; } continue; }
                var inv = 255 / oa;
                d[t] = _clamp(or * inv, 0, 255); d[t + 1] = _clamp(og * inv, 0, 255);
                d[t + 2] = _clamp(ob * inv, 0, 255);
                if (!locked) { d[t + 3] = oa; f[t] = or; f[t + 1] = og; f[t + 2] = ob; f[t + 3] = oa; }
                else { a = f[t + 3] / 255; f[t] = d[t] * a; f[t + 1] = d[t + 1] * a; f[t + 2] = d[t + 2] * a; }
            }
        }
        _smWrite(f, rx, ry, rw, rh, _smT);
        if (g !== f) _smWrite(g, rx, ry, rw, rh, _smS);
        ctx.putImageData(img, rx, ry);
    }

    /* Fading a dab's own alpha does not fade the LINE. Dabs overlap, and
     * stacking n of them at alpha a with source-over reaches 1-(1-a)^n — so
     * the ink saturated solid long before the ramp finished, and how far it
     * ran depended on spacing, which has nothing to do with taper: a 144px
     * taper measured 45px at spacing 4 and 95px at spacing 40. Solve for the
     * per-dab alpha whose stack lands on the alpha the taper asked for. */
    function _taperAlpha(alpha, tf, sz, p) {
        var step = _max(1, p.size * p.spacing / 100);
        var n = sz / step;
        if (n <= 1.001 || alpha <= 0) return alpha * tf;
        var want = (1 - _pow(1 - alpha, n)) * tf;
        return _clamp(1 - _pow(1 - want, 1 / n), 0, 1);
    }

    var _scDab  = { x: 0, y: 0, pressure: 0, strokeAngle: 0 };
    var _scFlow = { x: 0, y: 0, pressure: 0, strokeAngle: 0 };

    // that far toward the sub colour, white (Clip Studio's sub colour mix)
    function _subMixed(p, hex, sc) {
        var m = _dyn(p, 'subMix', p.subMix, sc, 20) / 100, c = _hexToRgb(hex);
        return _rgbToHex(c[0] + (255 - c[0]) * m, c[1] + (255 - c[1]) * m, c[2] + (255 - c[2]) * m);
    }
    function _renderDab(x, y, pressure, colorHex, strokeAngle, rawPressure, taper) {
        var p = getParams();
        _dabIndex++;

        var _sp = rawPressure != null ? rawPressure : pressure;
        /* A sensor reading is handed round as an object and read straight
         * away; nothing keeps one. Two scratch objects rather than two per
         * dab -- and a stroke is a few thousand dabs. */
        var sc = _scDab;
        sc.x = x; sc.y = y; sc.pressure = _sp; sc.strokeAngle = strokeAngle;
        /* Krita's first dab has no dab before it, so its drawing angle is
         * measured from the canvas origin (KisDistanceInformation starts at
         * 0,0), and a locked angle keeps it. Taken along the stroke, Lace's
         * first dab lay flat where Krita's stands turned. */
        if (_dabIndex === 1) _lockAngle = _atan2(y, x) * 180 / _PI;
        if (p.originAngle && _dabIndex === 1) sc.strokeAngle = _lockAngle;

        /* Which of the two a taper thins. Krita and CSP both default to the
         * WIDTH — a nib lifting off the paper narrows to a point, it does not
         * turn see-through — and CSP offers density as the alternative. This
         * engine used to fade opacity only and hold the brush at full width,
         * which is why an inked line ended in a translucent stub. */
        var tf = (taper == null) ? 1 : taper;
        var tgt = p.taperTarget || 'size';
        var tfSize = (tf < 1 && tgt !== 'opacity') ? tf : 1;
        var tfInk  = (tf < 1 && tgt !== 'size') ? tf : 1;

        var effAngle = _dynAngle(p, p.angle, sc);
        var sz = _dyn(p, 'size', p.size, sc, 1) * tfSize;
        // Krita paints a dab down to a hundredth of a pixel (checkSizeTooSmall).
        // Hard-edged ones too: EO Pixel Perfect is a 0.01px square Krita
        // draws as a clean 1px line.
        if (sz < (/^krita/.test(p.falloff) ? 0.01 : 0.5)) return;
        _adO = _dyn(p, 'dabOpacity', 1, sc, 14);
        _adAvg = _adAvg < _adO || !p.dabOpacityAvg ? _adO : 0.1 * _adO + 0.9 * _adAvg;
        if (p.maskOp && _flowCanvas) _maskStrokeDab(p, x, y, sc);

        // Bristle mode: render multiple fiber dabs
        if (p.bristleCount > 1) {
            _renderBristleDabs(x, y, pressure, _jitterColor(p, colorHex, x, y),
                               strokeAngle, tfSize, tfInk);
            return;
        }

        // a sub colour's change shades a picture's whites (white is the sub colour), never the ink
        var finalColor = !p.jitterSub ? _jitterColor(p, colorHex, x, y)
            : p.tipMode === 'color' ? _jitterColor(p, '#ffffff', x, y) : colorHex;
        var baseColor = finalColor;
        if (p.subMix) finalColor = _subMixed(p, baseColor, sc);
        if (p.grid) { _gridDab(p, x, y, finalColor); return; }

        // Smudge: sample canvas color and mix with brush color
        var rate = _clamp(_dyn(p, 'colorRate', p.colorRate, sc, 9), 0, 100);
        if (rate < 100 && p.smudgeMode == null) {
            finalColor = _wetColor(p, x, y, finalColor, 0, sz / 2, rate);
            if (finalColor === null) return;      // nothing loaded, nothing to lay down
        }

        var hard = _clamp(_dyn(p, 'hardness', p.hardness, sc, 6), 0, 100);
        /* Softness (see _softCurve): Krita's plain circle and square divide
         * their fade coefficients by it, which is their hardness times it.
         * ponytail: a square's separate end fade (hardnessY) is not scaled. */
        _softNow = p.softnessSrc !== 'none' || p.softnessStrength != null ? _clamp(_dyn(p, 'softness', 1, sc, 18), 0.1, 1) : 1;
        if (_softNow < 1 && /^krita(-aa)?$/.test(p.falloff || '')) hard *= _softNow;
        _sharpNow = p.sharpness > 0 && (p.sharpnessSensors || p.sharpnessSrc !== 'none') ? _dyn(p, 'sharpness', p.sharpness, sc, 19) : p.sharpness;
        /* All four other programs call this roundness, not aspect, and their
         * dynamics make a tip FLATTER as the sensor falls. Ours is the
         * reciprocal, so the sensor scales the roundness and the aspect is
         * divided by it -- driving the aspect directly would round a flat
         * tip off under light pressure, which is backwards. */
        var asp = p.aspectRatio;
        if ((p.aspectRatioSrc && p.aspectRatioSrc !== 'none') || p.aspectRatioSensors) {
            /* Floor of 0.1, not 1: both mask paths already squash the OTHER
             * axis below 1 (_generateMask, _getCustomTipMask), so a tip
             * flatter the other way round is a tip they can build -- clamping
             * here at 1 was the only thing making a sub-1 aspect snap back to
             * round the moment a sensor drove it. */
            var af = _max(0.01, _dyn(p, 'aspectRatio', 1, sc, 7));
            asp = _clamp(p.aspectThinsWidth ? asp * af : asp / af, 0.1, 20);
        }
        if (p.kspray) { _ksprayDab(p, x, y, finalColor, sc, hard, asp, strokeAngle); return; }
        var tex = _clamp(_dyn(p, 'texture', p.texture, sc, 8), 0, 100);
        var scatterAmt = _dyn(p, 'scatter', p.scatter, sc, 5);
        /* The stroke's own frame. strokeAngle arrives in DEGREES -- every
         * other reader of it treats it that way -- and the one-axis scatter
         * fed it to cos and sin raw, so "along the line" pointed somewhere
         * else entirely for every stroke that was not horizontal. */
        var dir = (strokeAngle || 0) * _PI / 180;

        /* Photoshop lays several dabs at every stop (`Cnt `), which is what
         * turns its scatter brushes into a spray instead of a dotted line.
         * Each one draws from its own slot of the position hash, so a group
         * is as repeatable as a single dab was. Photoshop stops at 16, Clip
         * Studio's spray at 20. */
        var count = _clamp(_round(_dyn(p, 'dabCount', p.dabCount, sc, 12)), 1, 20);
        for (var di = 0; di < count; di++) {
            var dx = x, dy = y;

            /* A dab need not land under the cursor. MyPaint's brushes lead
             * or trail the pointer, and the offset is measured in the
             * stroke's frame -- along the line and across it -- not the
             * canvas's, or it would point the wrong way the moment the
             * stroke turned. */
            if (p.offsetAlong || p.offsetAcross) {
                var om = _dyn(p, 'offset', 1, sc, 13);
                var oa = (p.offsetAlong / 100) * sz * om;
                if (p.ribbonLens) oa *= _ribbonLen(p, true);
                var oc = (p.offsetAcross / 100) * sz * om;
                dx += _cos(dir) * oa - _sin(dir) * oc;
                dy += _sin(dir) * oa + _cos(dir) * oc;
            }

            // Scatter: random offset from stroke path
            if (scatterAmt > 0) {
                var slot = di * 31;
                var scatterDist = (scatterAmt / 100) * sz * (_dabRand(x, y, 2 + slot) * 2 - 1);
                // 'disk': even over the whole patch, as Clip Studio sprays (its Spray's band is a semicircle across)
                /* ...over the brush's patch, not the particle's: a random-size
                 * particle lands anywhere in it whatever its size (Clip
                 * Studio's 0-20px specks over a 300 patch, cdp-csp psz). */
                if (p.scatterAxis === 'disk') scatterDist = (scatterAmt / 100) * (p.sprayEach ? p.size * tfSize : sz) * _diskR(p.sprayBias, _dabRand(x, y, 2 + slot));
                /* Krita can scatter along ONE axis, and its axes are the
                 * stroke's own: along the line or across it. Spreading a
                 * one-axis preset in both directions turned a rake's clean
                 * streaks into a cloud. Both axes is still a direction picked
                 * at random, which is the same thing as scattering in x and y
                 * and cheaper to say. */
                var ax = p.scatterAxis;
                var scatterAngle = (ax === 'along' || ax === 'across')
                    ? dir + (ax === 'across' ? _PI / 2 : 0)
                    : _dabRand(x, y, 3 + slot) * _PI * 2;
                dx += _cos(scatterAngle) * scatterDist;
                dy += _sin(scatterAngle) * scatterDist;
            }

            /* A smearing smudge lays its dab on whole pixels: Krita turns the
             * sub-pixel phase off (KisColorSmudgeOp, bug 327235), so the dab
             * sits at floor(pos - half) + half. Under a pressure-sized tip the
             * half changes along the stroke, and Basic Soft Wet's line steps a
             * pixel where Krita's does. A picture tip that turns sits half a
             * pixel further up and left first: Rake Smudge's tines lay a row
             * above an unturned one's on the same line, and the line moved
             * down 0.75px came back to it, 0.25px did not (probes/rksm). */
            if (p.smudgeMode === 0) {
                var hw = _max(1, sz * _min(1, asp || 1)) / 2, hh = _max(1, sz / _max(1, asp || 1)) / 2;
                var tq = p.shape === 'custom' && p.angleSrc !== 'none' ? 0.5 : 0;
                dx = _floor(dx - hw - tq) + hw; dy = _floor(dy - hh - tq) + hh;
            }
            /* Clip Studio sprays size each particle on its own (Droplet's
             * random spray size: 14 specks at 18, 12, 9, 6 and 4px), and
             * space their stops by the plain size (see _stepFor). */
            /* ...and turn each on its own: at random, or pointing away from
             * the patch's centre (Droplet's in-spray bit 512: drops on the
             * line lie along it, those above and below stand up). */
            var dsz = sz, dang = effAngle;
            if (p.sprayEach) {
                sc.x = dx; sc.y = dy; dsz = _dyn(p, 'size', p.size, sc, 1) * tfSize;
                if (p.angleSrc === 'radial') dang = (p.angle || 0) + _atan2(dy - y, dx - x) * 180 / _PI;
                else if (p.angleSrc === 'random') dang = _dynAngle(p, p.angle, sc);
                // each particle its own colour change and mix
                if (!p.jitterSub && p.colorJitterPer !== 'stroke' && (p.hueJitter || p.satJitter || p.valJitter))
                    finalColor = baseColor = _jitterColor(p, colorHex, dx, dy);
                if (p.subMix) finalColor = _subMixed(p, baseColor, sc);
                sc.x = x; sc.y = y;
                if (dsz < 0.5) continue;
            }
            if (p.shape === 'custom') _pickTipCell(p, dx, dy, sc.pressure);
            var mask = _maskFor(p.shape, dsz, hard, dang, asp, dx, dy);
            if (p.tipDensity < 1 || p.tipRandomness) mask = _noisyMask(mask, dx, dy, p);

            // Per-dab alpha. Both sensors now read the real pressure; the
            // taper is applied on top of whatever they produce, not smuggled
            // in as extra pressure, so a curved flow response cannot distort
            // it.
            var flowSc = _scFlow;
            flowSc.x = dx; flowSc.y = dy;
            flowSc.pressure = pressure; flowSc.strokeAngle = strokeAngle;
            var alpha = _clamp(_dyn(p, 'flow', p.flow / 100, flowSc, 4), 0, 1);
            if (tfInk < 1) alpha = _taperAlpha(alpha, tfInk, dsz, p);
            if (p.cutByLight) { var lc = _hexToRgb(finalColor); alpha *= _max(lc[0], lc[1], lc[2]) / 255; }

            if (p.hatch) {
                var hv = function (o) { return o.src ? _curveAt(o.curve, _sensor(o.src, sc, 16, p), p.curveSmooth) : o.v; };
                var H = p.hatch, iv = H.intervals;
                _hatchT = H.thickness * hv(H.thick);
                _hatchD = sz; _hatchAsp = asp || 1; _hatchX = H.xs ? hv(H.xs) : -1;
                _hatchSep = H.separation * Math.pow(2, Math.floor((iv - 1) / 2) - _clamp(Math.ceil(hv(H.sep) * iv) - 1, 0, iv - 1));
            }
            if (p.smudgeMode != null || p.mixAlpha != null) _smudgeDab(p, dx, dy, mask, finalColor, alpha, sc, dsz, tex, asp);
            else _paintDab(_flowCtx, dx, dy, mask, finalColor, alpha, tex, p.textureScale, p.textureType, p.wetBlend);
        }
    }

    /* Krita's Sharpness option: push the dab's edge towards a cut-out.
     *
     * The mask's alpha is stretched around its halfway mark, so the soft
     * ramp a generated tip or a photographed one carries becomes a cliff.
     * `softness` says how much ramp to leave, and `amount` how far to go --
     * at 0 the mask is untouched, which is what all but one of David Revoy's
     * brushes want. Without it "Hard Edge Textured Block" imported as a
     * blur, which is the one thing its name says it is not.
     *
     * Only alpha is touched: every mask in this engine reaches the canvas
     * through _colorizeMask's destination-in, so its colour never shows.
     *
     * Cached against the mask object itself. Masks are bucketed and reused,
     * so a whole stroke sharpens a handful of them, and a WeakMap lets the
     * dab cache evict one without leaving the sharpened copy behind. */
    var _sharpCache = new WeakMap();

    function _sharpenMask(mask, amount, softness) {
        var key = _round(amount) + '|' + _round(softness);
        var hit = _sharpCache.get(mask);
        if (hit && hit.key === key) return hit.canvas;

        var w = mask.width, h = mask.height;
        var c = new OffscreenCanvas(w, h);
        var cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(mask, 0, 0);
        var img = cx.getImageData(0, 0, w, h);
        var d = img.data;
        /* Krita's threshold (KisSharpnessOption::applyThreshold): above
         * 255 * (1 - sharpness) a pixel is solid, at or below `softness`
         * percent short of that it is gone, between it keeps its own value.
         * Full sharpness keeps every pixel the tip touches at all -- the
         * ramp round 50% this used to be cut PixelArt_Round to 71% of
         * Krita's ink. */
        var tol = _floor(255 - _clamp(amount / 100, 0, 1) * 255);
        var lo = (100 - _clamp(softness || 0, 0, 100)) * tol / 100;
        for (var i = 3; i < d.length; i += 4) {
            if (d[i] > tol) d[i] = 255;
            else if (d[i] <= lo) d[i] = 0;
        }
        cx.putImageData(img, 0, 0);
        c._cx = mask._cx; c._cy = mask._cy;
        _sharpCache.set(mask, { key: key, canvas: c });
        return c;
    }

    /* A second tip, stamped THROUGH the first.
     *
     * Photoshop calls it a dual brush, Krita a masking brush, Clip Studio a
     * dual brush too, and all three mean the same thing: the dab's coverage
     * is what both tips agree on, which is what turns a solid stamp into a
     * broken, grainy one. `tip2Depth` is how deeply it bites -- where the
     * second tip covers nothing, the first keeps 100 minus the depth.
     *
     * ponytail: the second tip is stamped ONCE, scaled to tip2Size. Photoshop
     * scatters several copies of a small one; tile or scatter it here if a
     * real file turns up that needs it.
     *
     * The old `dualTip` is a different thing entirely and stays where it is:
     * a canvas-anchored surface applied to the whole finished stroke. Saved
     * presets carry it, so it keeps its name. */
    /* The second tip.
     *
     * Krita's masking brush, Photoshop's dual brush and Clip Studio's dual
     * tip are one idea: a second brush stamped THROUGH the first, so what
     * the first lays down is cut back to where the two agree. It is how a
     * solid stamp becomes a grainy one.
     *
     * It is a tile, not a single stamp. The second tip is usually far
     * smaller than the dab -- Revoy's masking brushes run to three per cent
     * of it -- so stamping it once would shrink every dab to a dot instead
     * of shredding it. And the tile is anchored to the CANVAS, like the
     * texture grain: anchored to the dab, a stroke would repeat the same
     * mark at every step and read as a chain rather than a texture.
     *
     * That anchoring is why this happens per dab, in the scratch, rather
     * than being baked into the cached mask: every dab sits at a different
     * phase of the tile. */
    var _tip2Tile = { key: '', canvas: null, pitch: 1 };

    function _tip2CanvasFor() {
        return _previewTarget ? _previewTarget.tip2 : _tip2Canvas;
    }

    function _tip2TileFor(sz, angleDeg) {
        var src = _tip2CanvasFor();
        var side = _max(1, _round(sz * (_params.tip2Size || 100) / 100));
        var gap = _max(10, _params.tip2Spacing || 100) / 100;
        var pitch = _max(1, _round(side * gap));
        var ang = (angleDeg || 0) + (_params.tip2Angle || 0);
        var key = side + '|' + pitch + '|' + _round(ang) + '|' + _tipSerial;
        if (_tip2Tile.key === key) return _tip2Tile;
        var c = new OffscreenCanvas(pitch, pitch);
        var cx = c.getContext('2d');
        cx.imageSmoothingQuality = 'high';
        /* Drawn four times so a tip wider than its own pitch still meets
         * its neighbours -- a pattern repeat only repeats what is inside
         * the tile. */
        for (var i = 0; i < 4; i++) {
            cx.save();
            cx.translate(pitch / 2 + (i & 1 ? pitch : 0), pitch / 2 + (i & 2 ? pitch : 0));
            cx.rotate(ang * _PI / 180);
            cx.drawImage(src, -side / 2, -side / 2, side, side);
            cx.restore();
        }
        _tip2Tile = { key: key, canvas: c, pitch: pitch };
        return _tip2Tile;
    }

    /* Cut the dab in the scratch back to where the second tip covers it. */
    var _cutCanvas = null, _cutCtx = null;

    function _applyTip2(ctx, w, h, ox, oy, sz, angleDeg) {
        var src = _tip2CanvasFor();
        var depth = _params.tip2Depth;
        if (!src || !(depth > 0)) return false;
        var tile = _tip2TileFor(sz, angleDeg);
        if (!_cutCanvas || _cutCanvas.width < w || _cutCanvas.height < h) {
            _cutCanvas = new OffscreenCanvas(_max(w, 1), _max(h, 1));
            _cutCtx = _cutCanvas.getContext('2d');
        }
        var ux = _cutCtx;
        ux.clearRect(0, 0, w, h);
        var keep = 1 - _clamp(depth, 0, 100) / 100;
        if (keep > 0) {
            ux.fillStyle = 'rgba(0,0,0,' + keep + ')';
            ux.fillRect(0, 0, w, h);
        }
        var px = -(((ox || 0) % tile.pitch) + tile.pitch) % tile.pitch;
        var py = -(((oy || 0) % tile.pitch) + tile.pitch) % tile.pitch;
        ux.save();
        ux.translate(px, py);
        ux.fillStyle = ux.createPattern(tile.canvas, 'repeat');
        ux.fillRect(-px, -py, w + tile.pitch, h + tile.pitch);
        ux.restore();

        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(_cutCanvas, 0, 0, w, h, 0, 0, w, h);
        ctx.globalCompositeOperation = 'source-over';
        return true;
    }

    /* Which tip to stamp. Shared by the single-dab and bristle paths so a
     * bristle brush honours shape, hardness and custom tips like any other. */
    var _tcKeys = new WeakMap();
    /* Krita's softness option (KisSoftnessOption, 0.1..1) reshapes the tip
     * per dab. The soft generator scales its curve's inner points by it
     * (KisCurveCircleMaskGenerator::transformCurveForSoftness, a middle point
     * added to a bare two-point curve); at low pressure Watercolor Stroke
     * Dry's dab is faint enough that its subtract texture leaves only the
     * cracks. _tcNow is the curve the mask being built draws. */
    var _softNow = 1, _sharpNow = 0, _tcNow = null, _scCache = new Map();
    function _softCurve(c, s) {
        if (s >= 1) return c;
        s = _round(s * 256) / 256;
        var k = _tipCurveKey(c) + '@' + s, r = _scCache.get(k);
        if (r) return r;
        r = c.map(function (pt) { return pt.slice(); });
        if (r.length === 2) r.splice(1, 0, [(r[0][0] + r[1][0]) / 2, (r[0][1] + r[1][1]) / 2]);
        for (var i = 1; i < r.length - 1; i++) r[i][1] = _clamp(r[i][1] * s, 0, 1);
        _scCache.set(k, r);
        return r;
    }
    function _tipCurveKey(c) {
        var k = _tcKeys.get(c);
        if (!k) { k = 'curve:' + JSON.stringify(c); _tcKeys.set(c, k); }
        return k;
    }
    /* A dab is drawn from a mask image whose centre sits at w/2, so a dab
     * at a whole-pixel point landed on a half pixel and the browser blended
     * it across its neighbours. At Ink-1 Precision's 3px that took a single
     * dab from Krita's 197 to 137 and spread it over three rows instead of
     * two -- Krita works each pixel out at the dab's true position. Small
     * round masks are therefore built at the dab's own sub-pixel phase
     * (x, y given), and at their true size, unrounded: Krita's dab cache
     * reuses a dab only at the same phase (KisDabCacheBase, precision 5),
     * and a sixteenth left Line Marker's 1px line at IoU 0.72 where
     * exact is 0.98. Big ones cannot see the difference.
     * Krita-imported tips only (see below). */
    /* A Krita generated tip's randomness and density, fresh every dab
     * (kis_brush_mask_scalar_applicator.h): each pixel's alpha times
     * 1 - r + r * u, then a pixel it leaves visible kept with chance density.
     * Chalk, Pencil 4B and Dry Marker are density 0.5 and laid twice Krita's
     * ink without it. Returns one shared canvas, so it drops the caches
     * keyed on the mask object. */
    var _nzCanvas = null, _nzCtx = null;
    function _noisyMask(mask, x, y, p) {
        var w = mask.width, h = mask.height, r = p.tipRandomness, dn = p.tipDensity;
        if (!_nzCanvas) { _nzCanvas = new OffscreenCanvas(w, h); _nzCtx = _nzCanvas.getContext('2d', { willReadFrequently: true }); }
        if (_nzCanvas.width !== w || _nzCanvas.height !== h) { _nzCanvas.width = w; _nzCanvas.height = h; }
        else _nzCtx.clearRect(0, 0, w, h);
        _nzCtx.drawImage(mask, 0, 0);
        var img = _nzCtx.getImageData(0, 0, w, h), d = img.data;
        var s = (_dabRand(x, y, 7) * 4294967296) >>> 0 || 1;
        for (var i = 3; i < d.length; i += 4) {
            if (!d[i]) continue;
            if (r) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = ~~(d[i] * (1 - r + r * (s >>> 0) / 4294967296)); }
            if (dn < 1 && d[i]) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; if (dn < (s >>> 0) / 4294967296) d[i] = 0; }
        }
        /* Krita's mask generator lays the noise, the sharpness threshold
         * runs on the finished dab (postProcessDab): X1CI Sketch's speckled
         * 1px dabs come out solid where kept, not dimmed (_sharpenMask). */
        if (p.sharpness > 0) {
            var tol = _floor(255 - _clamp(_sharpNow / 100, 0, 1) * 255), lo = (100 - _clamp(p.sharpSoftness || 0, 0, 100)) * tol / 100;
            for (i = 3; i < d.length; i += 4) d[i] = d[i] > tol ? 255 : d[i] <= lo ? 0 : d[i];
        }
        _nzCtx.putImageData(img, 0, 0);
        _nzCanvas._cx = mask._cx; _nzCanvas._cy = mask._cy;
        _tintMask = null; _smMaskA.delete(_nzCanvas);
        return _nzCanvas;
    }
    function _maskFor(shape, sz, hardness, angleDeg, aspect, x, y) {
        var mask;
        if (shape === 'custom' && _tipCanvas()) {
            mask = _getCustomTipMask(sz, angleDeg, aspect, hardness, _params.sharpness > 0 ? null : x, y) ||
                   _dabCache.get('circle', sz, hardness, 0, aspect);
        } else {
            // A gauss falloff is its own mask, so its own cache key.
            if (shape === 'circle' && (_params.falloff === 'gauss' || _params.falloff === 'gimp')) shape = _params.falloff;
            if (shape === 'circle' && _isArray(_params.tipCurve) && /^krita-soft/.test(_params.falloff || ''))
                shape = 'ccurve' + (/-aa$/.test(_params.falloff) ? 'a' : '') + _tipCurveKey(_tcNow = _softCurve(_params.tipCurve, _softNow));
            if (shape === 'circle' && _isArray(_params.tipCurve)) shape = _tipCurveKey(_tcNow = _softCurve(_params.tipCurve, _softNow));
            if (shape === 'circle' && _params.falloff === 'marker') shape = 'kmarker';
            if (shape === 'square' && _isArray(_params.tipCurve))
                shape = 'rcurve' + (/-aa$/.test(_params.falloff || '') ? 'a' : '') + _tipCurveKey(_tcNow = _softCurve(_params.tipCurve, _softNow));
            var kf = /^krita(-gauss)?(-aa)?$/.exec(_params.falloff || '');
            /* a hard square keeps the plain box: it paints its pixel however
             * small (EO Pixel Perfect) -- unless anti-aliased, when Krita's
             * edge fades its last pixel: Grease Pencil Square's 3px-tall dab
             * is rows 104, 254, 188 in Krita, not a solid bar. */
            if (shape === 'square' && kf && (kf[1] || kf[2] || hardness < 100 || (_params.hardnessY != null && _params.hardnessY < 100) || _params.spikes > 2))
                shape = (kf[1] ? 'kgrect' : 'klrect') + (kf[2] ? 'a' : '') + (_params.hardnessY != null ? ':' + _params.hardnessY : '');
            if (shape === 'circle' && _params.edgeRamp) {
                shape = 'cspaa' + _params.edgeRamp;
                if ((aspect || 1) === 1) angleDeg = 0;   // a circle turned is the same circle: one cache entry
            }
            if (shape === 'circle' && kf) {
                shape = (kf[1] ? 'kgauss' : 'kcircle') + (kf[2] ? ':aa' : '');
                sz = sz < 16 ? _max(0.05, sz) : _round(sz);   // its real size, see _kritaCircleMask
            }
            /* A square too, to an eighth up to 32px: rounded to whole pixels,
             * Poska Square's line thickened in steps where Krita's tapers. */
            if (/^(k(grect|lrect)|[rc]curve|cspaa)/.test(shape)) sz = sz <= 32 ? _max(0.05, _round(sz * 8) / 8) : _round(sz);
            if (_params.spikes > 2 && /^(k(circle|gauss|grect|lrect)|[rc]curve)/.test(shape)) shape += '*' + _params.spikes;
            var ph = null;
            /* Sharpness snaps a dab to whole pixels only with "align outline"
             * ticked (KisSharpnessOption::apply), which no banked preset
             * does; a 1px sharp tip (its pixel line, _pxOff) still snaps.
             * Snapped, X1CI Sketch's 2px oval fell between pixel centres
             * and painted nothing. Krita's own tips only: the built-in
             * brushes keep the look they have. */
            if (x != null && sz <= 32 && !(_params.sharpness > 0 && sz <= 1) &&
                /^(k(circle|gauss|grect|lrect|marker)|[rc]?curve|cspaa)/.test(shape)) {
                // The plain square (klrect) too: lone Krita dabs sit at their phase.
                ph = [x % 1, y % 1];
            } else if (x != null && (/^k(circle|gauss)/.test(shape) || _params.sharpness > 0 && /^(k(grect|lrect)|rcurve)/.test(shape))) {
                /* Sharpness: Krita rounds the dab's corner (cursor minus half
                 * its size, at least a pixel) to a whole pixel
                 * (KisSharpnessOption::apply), so the centre's phase is that
                 * half size's. Centred on the cursor, a 1px Pixel Art dab
                 * straddled four pixels and the threshold kept none; a square
                 * too, whatever its shape (EO Pixel Perfect painted nothing). */
                var hs = (_max(1, sz) / 2) % 1;
                ph = [hs, hs];
            }
            mask = _dabCache.get(shape, sz, hardness, angleDeg, aspect, ph);
        }
        // the option is on whatever its sensor reads: at 0 the threshold keeps nothing.
        // A noisy tip is thresholded after its noise, in _noisyMask.
        if (_params.sharpness > 0 && !(_params.tipDensity < 1 || _params.tipRandomness)) mask = _sharpenMask(mask, _sharpNow, _params.sharpSoftness);
        return mask;
    }

    /* A whole bristle fan, baked into one reusable tip.
     *
     * One dab per bristle made every setting work but cost 4.5x the bare lines
     * it replaced: 60ms to render a 300-point stroke at 12 bristles, 146ms at
     * 30, all landing in one hitch at stroke end. The fan is the same shape
     * every time it is drawn at a given size and angle, so it belongs in a
     * cache and on the canvas as a single dab.
     *
     * Size and angle are bucketed on the way in, because both ride on pressure
     * and stroke direction and an exact key would rebuild the fan every dab.
     * Per-bristle alpha bakes into the mask; the stroke's own alpha is applied
     * when the fan is stamped. Per-bristle COLOUR cannot bake in, so colour
     * mixing (colorRate < 100) keeps the one-dab-per-bristle path. */
    /* Budgeted by bytes, not by count, for the same reason the dab cache is:
     * a fan is as big as the head that made it. Ninety-six entries is a
     * generous cache for a 200px oil brush and a starvation diet for the
     * 19px fans a swatch paints -- one brush tile wanted about two hundred
     * of them and spent its whole render evicting and rebuilding, which was
     * most of the 24ms those tiles cost. Four megabytes holds every fan a
     * swatch can ask for and still bounds a full-size stroke. */
    var _fanCache = {};
    var _fanKeys = [];
    var _fanBytes = 0;
    var FAN_MAX_BYTES = 4 * 1024 * 1024;

    function _fanFor(key, build) {
        var hit = _fanCache[key];
        if (hit) return hit.canvas;
        var c = build();
        var e = { canvas: c, bytes: c.width * c.height * 4 };
        _fanCache[key] = e;
        _fanKeys.push(key);
        _fanBytes += e.bytes;
        while (_fanBytes > FAN_MAX_BYTES && _fanKeys.length > 1) {
            var old = _fanKeys.shift();
            _fanBytes -= _fanCache[old].bytes;
            delete _fanCache[old];
        }
        return c;
    }

    /* Where a fan brush's hairs actually sit.
     *
     * They used to radiate: every bristle was pushed away from the centre
     * along its own angle, and all those angles lay inside one `spread`
     * wedge, so the whole cluster sat off to one side of the pointer and
     * grew further off it as the brush got bigger. That is what made the
     * fan look uncentred and wrong — it was painting a splayed burst
     * beside the cursor rather than a brush head on it.
     *
     * A ferrule spreads hairs SIDEWAYS across the brush and each hair runs
     * ALONG it. So: lay the bristles out on the perpendicular, run each one
     * down the stroke axis, and centre the lot on the cursor. `spread` now
     * does what its name says — how wide the head is splayed, from a single
     * packed streak at 0 to wider than the tip itself at 135 and up.
     *
     * One layout function, shared by the cached and the per-bristle paths,
     * so the fast path cannot drift from the accurate one. */
    /* A head stamped from one cached fan draws the same hairs in the same
     * places from one end of the stroke to the other, which is a rake, not
     * a brush -- hairs in a real ferrule wander as they drag. So the fan is
     * built in a handful of versions that differ only in where each hair
     * sits within its own gap, and each dab takes one according to where it
     * lands. The hairs weave over the stroke; the cost is a few more entries
     * in the fan cache and nothing at all per dab. */
    var BRISTLE_WEAVE = 6;

    /* Which version a dab takes comes from where it lands and nothing else.
     * _dabRand would have done, but it mixes in the per-stroke seed, and the
     * same stroke drawn twice has to weave the same way both times. */
    function _weaveAt(x, y) {
        var h = (_round(x * 4) * 520493 + _round(y * 4) * 372109) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) % BRISTLE_WEAVE;
    }

    function _bristleLayout(p, sz, axisRad, count, length, width, variant) {
        var fanW = sz * _clamp(p.bristleSpread / 90, 0, 1.5);
        var gap = fanW / _max(1, count - 1);
        /* A hair's thickness is only meaningful next to the gap to its
         * neighbour. Held at a couple of pixels, as it used to be, a wide
         * head at any size came out as wire: the hairs covered a third of
         * the ground between them and the streak read as a comb of lines
         * with the paper showing through. At the default width they now
         * just touch, and bristleWidth says how far past touching to go --
         * below 1 for a dry brush that skips, above for a loaded one. */
        var lw = _clamp(gap * _clamp(width / 3, 0.3, 2.2), 0.6, sz);
        var flen = _max(lw, sz * 0.3 + length * 0.35);
        var px = -_sin(axisRad), py = _cos(axisRad);
        var out = [];
        var reach = 0;
        for (var i = 0; i < count; i++) {
            var t = count > 1 ? i / (count - 1) : 0.5;
            var u = t - 0.5;
            /* Real hairs are uneven, and a perfectly regular comb is the
             * other half of why this looked synthetic. The jitter is a hash
             * of the bristle index alone, so the fan is still identical
             * every time it is built and still caches. */
            var j = ((Math.imul(i + 1, 2654435761) >>> 0) % 1000) / 1000;
            var j2 = ((Math.imul(i + 7, 40503) >>> 0) % 1000) / 1000;
            var jv = ((Math.imul(i + 1 + (variant | 0) * 131, 2246822519) >>> 0) % 1000) / 1000;
            /* Hairs run ALONG the stroke, near enough parallel.
             *
             * They used to splay by half the spread angle -- thirty degrees
             * at the outside for a fan brush -- and that is what made these
             * brushes look like crushed lines rather than hair. The head is
             * stamped afresh every two or three pixels, so a hair set across
             * the stroke does not draw a hair at all: it draws one rung of a
             * ladder, and the stroke fills with them. Splay is what the head
             * looks like at rest; what it PAINTS is each hair's own trail,
             * and those are parallel. The couple of degrees left is so the
             * trails are not machined. */
            var dir = axisRad + (j - 0.5) * 0.10;
            var len = flen * (0.75 + j * 0.5);
            /* Sideways, the hairs sit unevenly -- but only by a fraction of
             * the gap, or they cross and the head loses its edges. */
            var off = u * fanW + (j2 - 0.5) * gap * 0.5 + (jv - 0.5) * gap * 0.9;
            var cx = px * off;
            var cy = py * off;
            var hw = lw * (0.7 + j2 * 0.7);
            out.push({
                cx: cx, cy: cy, dir: dir, len: len, w: hw,
                /* Mostly even, because a real ferrule is: the old smooth
                 * falloff to the edges made every head read as one soft
                 * blob. What varies is hair to hair, not left to right. */
                alpha: (0.5 + 0.5 * j2) * (0.6 + 0.4 * jv) *
                       (0.75 + 0.25 * (1 - _abs(u) * 2))
            });
            reach = _max(reach, _hypot(cx, cy) + len / 2 + hw);
        }
        return { list: out, lw: lw, reach: reach };
    }

    /* Watercolour lays a wash, not ink. Even at high flow Clip Studio puts
     * down translucent pigment that granulates instead of filling, while our
     * full-strength dabs stack to opaque marker in a few overlaps.
     *
     * This scales the finished stroke's ALPHA CHANNEL alone at flush time
     * (_applyWatercolorWash), never RGB -- read that function's comment
     * first if the "why not per-dab, why not a real recompositing curve"
     * question comes up again: both were tried this session and both broke
     * a real regression test (test/browser/brush-hash.mjs), one from not
     * surviving heavy dab overlap, the other from warping low- and
     * high-alpha pixels unevenly. A flat proportional scale of alpha is the
     * one operation that (a) is still ordinary compositing math, not an RGB
     * "darken" hack, (b) survives any amount of restacking because it runs
     * once on whatever actually accumulated, and (c) can't invert a
     * wet-vs-dry comparison because it treats every alpha level the same.
     *
     * Above 1 despite the name: the per-dab wet-blend coverage gate (see
     * _paintDab) caps a single pass at roughly one dab's own alpha instead
     * of letting tightly-spaced overlapping dabs stack to opaque, and that
     * one dab's alpha is itself flow-driven with flowMin 0 -- a plain mouse
     * reports the W3C-neutral pressure 0.5, not 1, so a single pass already
     * starts around half strength before any scaling here. Calibrated
     * against CSP.png (2026-09-17), composited over white -- capped lower
     * than a first color-only calibration would pick (which wanted more like
     * 3): pushed that high, this stroke's own raw per-dab alpha (measured
     * ~0.45 mean, ~0.8 peak before any scaling) clamps to fully opaque
     * everywhere, and _applyWaterEdge has nothing left to lift -- an edge
     * ring can only read as "more saturated than the interior" if the
     * interior has headroom below full alpha to be less saturated than.
     * Measured directly (a real drag, alpha profile by distance from the
     * boundary, texture off to isolate it from grain noise): at 2.5+ the
     * ring and the interior it should stand out against both sit within a
     * few percent of fully opaque by ~8px in, and the ring disappears; at
     * 1.5 there's plenty of headroom but the interior reads lighter than
     * CSP.png. 2.0 keeps a visible gap between the two without giving up
     * the ring. The per-pixel clamp in _applyWatercolorWash still caps at
     * 255 regardless, so this cannot blow out the soft taper at a stroke's
     * own ends -- only pixels already near-opaque saturate early. The
     * importer marks such brushes (watercolor: 1).
     *
     * Since watercolour started compositing with multiply (_flushFlowBuffer),
     * this constant no longer decides how DARK a wash reads -- multiply does,
     * and _WASH_CEILING sets the coverage it multiplies at. What this still
     * decides is how much of a stroke reaches that ceiling: a stroke's raw
     * per-dab alpha is well under 1, so without the boost most of the stroke
     * would sit far below the plateau and the stroke would read thin and
     * uneven rather than as a flat wash with a pooled rim. Turn _WASH_CEILING
     * to match a reference's darkness; turn this to change how much of the
     * stroke gets there.
     *
     * 2.5 is already past the point where raising it does anything, measured
     * rather than assumed: doubling it to 5 moved the deposited alpha of a
     * real drag by nothing at all (p25/p50/p75 = 120/137/155 either way),
     * because at 2.5 the body of the stroke is already clamped at
     * _WASH_CEILING. So if a wash reads too thin, this is not the knob --
     * the gap between the 214 plateau and that measured 137 median is the
     * flush-time paper grain, which at this preset's texture 60 takes about
     * a third of the alpha back out. */
    var _WATERCOLOR_WASH = 2.5;
    /* Edge recipe (W2): a pure alpha boost, see _applyWaterEdge -- no RGB
     * tint, so it can't drift hue or muddy the color under repeated passes.
     * An earlier version mixed RGB toward a fixed "deepened" color instead,
     * with an unclamped mix weight; it read as an ugly broadening dark band
     * that got worse the more a stroke was redrawn over the same area, which
     * is what led to this alpha-only redesign (2026-09-17, reported directly
     * against a real render, not assumed). Retuned for the new curve: measured
     * pixel-by-pixel across a real drag boundary same as before. */
    var _EDGE_LIFT = 5;
    /* How STRONG the rim reads, as extra layers of the same paint at its peak
     * (see the loop at the bottom of _applyWaterEdge). Its own knob because
     * alpha alone cannot make the rim any darker once it has used up the
     * headroom _WASH_CEILING reserves: the interior plateaus at 214 and the
     * rim can only climb to 255, which measured as a 14-point coverage gap --
     * a real rim, but a fainter one than Clip Studio's.
     *
     * How WIDE it reads is NOT a knob here: that is the radius the .sut asks
     * for (2px on this brush), and it is deliberately independent of brush
     * size. Clip Studio's rim is a fixed width in canvas pixels, so it looks
     * oversized on a tiny brush and nearly vanishes on a huge one --
     * confirmed as the wanted behaviour, not a bug to scale away. */
    var _EDGE_DEEPEN = 3;
    /* Squaring the rim's profile off was tried and rejected: gaining the
     * detected deficit before clamping it made the band flat-topped rather
     * than a ramp (measured on #00B4FF over white, 193/197 into a 213 interior
     * became 173/169 into 213, same two pixels wide) and it looked worse on a
     * real stroke -- reported directly, 2026-09-17. The detector's own falloff
     * is what the rim should keep; it is the soft inner shoulder that makes it
     * read as pooled pigment rather than a drawn outline. */
    function _renderBristleDabs(x, y, pressure, colorHex, strokeAngle, tfSize, tfInk) {
        var p = getParams();
        if (tfSize == null) tfSize = 1;
        if (tfInk == null) tfInk = 1;
        var sc = { x: x, y: y, pressure: pressure, strokeAngle: strokeAngle };
        var count = _clamp(_round(p.bristleCount), 2, 50);
        var length = _max(3, p.bristleLength);
        var width = _max(1, p.bristleWidth);

        var effAngle = _dynAngle(p, p.angle, sc);
        var sz = _max(0.5, _dyn(p, 'size', p.size, sc, 1)) * tfSize;

        // flow scales the CLAMPED pressure factor, not the other way round —
        // multiplying first and clamping after would brighten low-flow bristles.
        var baseAlpha = (p.flow / 100) * _clamp(_dyn(p, 'flow', 1, sc, 4) * 1.2, 0, 1);
        if (tfInk < 1) baseAlpha = _taperAlpha(baseAlpha, tfInk, sz, p);

        if (sz < 2) return;

        if (p.colorRate >= 100) {
            // Buckets: 2px of size, 6 degrees of angle. Both are finer than
            // the eye can follow on a bristle streak and keep a whole stroke
            // sharing a handful of fans instead of building one per dab.
            var qSz = _max(2, _round(sz / 2) * 2);
            var qAng = _round(effAngle / 6) * 6;
            var weave = _weaveAt(x, y);
            var lay0 = _bristleLayout(p, qSz, qAng * _PI / 180, count, length, width, weave);
            var S = _max(2, _ceil((lay0.reach + 2) * 2));
            var fan = _fanFor(p.shape + '|' + qSz + '|' + _round(p.hardness) + '|'
                + qAng + '|' + count + '|' + _round(p.bristleSpread) + '|'
                + _round(length) + '|' + _round(width) + '|' + weave, function () {
                var fc = new OffscreenCanvas(S, S);
                var fctx = fc.getContext('2d');
                for (var k = 0; k < lay0.list.length; k++) {
                    var b = lay0.list[k];
                    // Long axis in, no -90: aspect squashes now, so the
                    // hair comes out lying along x, which is its own
                    // direction. Same change as the per-bristle path.
                    var fw = _max(0.6, _round(b.w * 2) / 2);
                    var fasp = _max(1, _round((b.len / fw) * 2) / 2);
                    var fm = _maskFor(p.shape, _max(1, fw * fasp), p.hardness,
                        b.dir * 180 / _PI, fasp);
                    fctx.save();
                    // Shape factor only; stroke alpha lands at stamp time.
                    fctx.globalAlpha = b.alpha;
                    fctx.drawImage(fm, S / 2 + b.cx - fm.width / 2,
                        S / 2 + b.cy - fm.height / 2);
                    fctx.restore();
                }
                return fc;
            });
            // _paintDab extends _dirtyRect and _clearBounds itself.
            _paintDab(_flowCtx, x, y, fan, colorHex,
                _clamp(baseAlpha, 0, 1), p.texture, p.textureScale, p.textureType, p.wetBlend);
            return;
        }

        /* Smudge keeps one dab per bristle: per-bristle colour is sampled from
         * the canvas under each hair and so cannot bake into a shared fan.
         *
         * Each bristle is one dab stretched along the fiber direction, rather
         * than a bare stroked line. A stroked line cannot carry hardness, a
         * shape, a texture or a custom tip, so every one of those settings used
         * to go dead the moment bristleCount rose above 1 — while staying
         * visible and adjustable in the sidebar. */
        var lay = _bristleLayout(p, sz, effAngle * _PI / 180, count, length, width,
            _weaveAt(x, y));
        for (var i = 0; i < lay.list.length; i++) {
            var br = lay.list[i];
            var bcx = x + br.cx;
            var bcy = y + br.cy;

            // Hair i keeps hair i's load, stroke after stroke of the fan.
            var finalColor = _wetColor(p, bcx, bcy, colorHex, i + 1, br.w);
            if (finalColor === null) continue;

            // A hair is one dab as long as the fiber and as wide as the
            // fiber is thick. Aspect squashes now, so the size passed in is
            // the LONG axis and the mask comes out lying along x -- which is
            // the fiber direction, with no -90 correction.
            // Quantise the elongation before it reaches the cache key: fiber
            // length rides on pressure, and an exact ratio made a fresh tip
            // for practically every dab (1224 mask builds for one stroke).
            var bw = _max(0.6, _round(br.w * 2) / 2);
            var bAspect = _max(1, _round((br.len / bw) * 2) / 2);
            var bMask = _maskFor(p.shape, _max(1, bw * bAspect), p.hardness,
                br.dir * 180 / _PI, bAspect);
            // _paintDab extends _dirtyRect and _clearBounds itself.
            _paintDab(_flowCtx, bcx, bcy, bMask, finalColor,
                _clamp(baseAlpha * br.alpha, 0, 1),
                p.texture, p.textureScale, p.textureType, p.wetBlend);
        }
    }

    /* How a brush lays its paint down.
     *
     * The whole stroke lives on the flow buffer and reaches the layer as ONE
     * drawImage, against a restored copy of the original pixels — so the
     * blend applies to the finished stroke, not to each overlapping dab.
     * That is what makes multiply usable: dabs inside a single stroke do not
     * darken each other, which is how a real ink behaves and how Krita and
     * CSP do it too.
     *
     * 'erase' is why this exists at all. Until now the engine could only add
     * paint, so there was no way to have an eraser that was a brush. */
    var _BLEND_OPS = {
        normal:      'source-over',
        erase:       'destination-out',
        multiply:    'multiply',
        screen:      'screen',
        overlay:     'overlay',
        darken:      'darken',
        lighten:     'lighten',
        'color-dodge': 'color-dodge',
        'color-burn':  'color-burn',
        'hard-light':  'hard-light',
        'soft-light':  'soft-light',
        difference:  'difference',
        hue:         'hue',
        saturation:  'saturation',
        color:       'color',
        luminosity:  'luminosity',
        // Add / linear dodge: the paint's light is summed onto what is there
        // (W3C Compositing 'plus-lighter', canvas 'lighter').
        add:         'lighter'
    };
    function _blendOp(mode) { return _BLEND_OPS[mode] || 'source-over'; }
    /* The layer compositor's _render() repaints the whole document on every
     * app.ctx access unless hinted otherwise (layer-system.js markDirty) --
     * on a large canvas that dwarfs the actual brush work every single live
     * frame. _dirtyRect/_clearBounds already know exactly what this flush is
     * about to touch, so hand that to the compositor right before the
     * _outCtx() call that triggers it. Mirrors _flushFlowBuffer's own bound
     * computation; called separately because the getter fires before this
     * function's body runs. */
    function _hintFlushRect(isFinal) {
        if (!_dirtyRect || !app.layerMgr || !app.layerMgr.markDirty) return;
        var x1 = _dirtyRect.x1, y1 = _dirtyRect.y1, x2 = _dirtyRect.x2, y2 = _dirtyRect.y2;
        /* Mirror _flushFlowBuffer's own widening exactly: only the final/
         * replay pass needs the whole stroke's accumulated bounds (a taper
         * can shrink the final result below what live passes already drew).
         * A live pass only just painted _dirtyRect, so widening it to
         * _clearBounds here would recomposite the ENTIRE stroke-so-far on
         * every frame of a long stroke -- measured to grow from ~500px to
         * over 6000px wide across one 15-frame stroke, each frame paying
         * for the whole span instead of just its own new ink. */
        if (isFinal && _clearBounds) {
            if (_clearBounds.x1 < x1) x1 = _clearBounds.x1;
            if (_clearBounds.y1 < y1) y1 = _clearBounds.y1;
            if (_clearBounds.x2 > x2) x2 = _clearBounds.x2;
            if (_clearBounds.y2 > y2) y2 = _clearBounds.y2;
        }
        app.layerMgr.markDirty(_floor(x1) - 1, _floor(y1) - 1, _ceil(x2 - x1) + 2, _ceil(y2 - y1) + 2);
    }
    function _flushFlowBuffer(mainCtx, clearFlow, isFinal) {
        if (!_dirtyRect || !_flowCanvas) return;
        var dr = _dirtyRect;
        var x = _floor(dr.x1);
        var y = _floor(dr.y1);
        var x2 = _ceil(dr.x2);
        var y2 = _ceil(dr.y2);
        /* The last pass repaints the stroke from scratch, and what it paints
         * can be SMALLER than what the live passes already put on the layer --
         * an end taper thins the tail, so the final stroke stops short of the
         * blunt one the user watched being drawn. Restoring only the final
         * pass's own rect leaves that blunt end behind, welded to the layer.
         * So the final composite covers everything this stroke ever touched.
         * Live passes have no such retroactive shrink to undo, and
         * _clearBounds is never narrowed mid-stroke -- widening every live
         * flush to it recomposited the whole stroke-so-far on every frame of
         * a long stroke, not just this frame's own ink. */
        if (!clearFlow && isFinal && _clearBounds) {
            if (_clearBounds.x1 < x) x = _floor(_clearBounds.x1);
            if (_clearBounds.y1 < y) y = _floor(_clearBounds.y1);
            if (_clearBounds.x2 > x2) x2 = _ceil(_clearBounds.x2);
            if (_clearBounds.y2 > y2) y2 = _ceil(_clearBounds.y2);
        }
        var w = x2 - x;
        var h = y2 - y;
        if (w <= 0 || h <= 0) { _dirtyRect = null; return; }
        /* Keep the rect inside the document. The destination-in clips below
         * clear every pixel the drawn image does not cover, so each rect
         * here must be doc-bounded and never empty. */
        var bw = _flowCanvas.width, bh = _flowCanvas.height;
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > bw) w = bw - x;
        if (y + h > bh) h = bh - y;
        if (w <= 0 || h <= 0) { _dirtyRect = null; return; }
        if (_adCtx && _alphaDarken(getParams())) _adToFlow(x, y, w, h);
        var opacity = getParams().opacity / 100;
        /* Alpha lock exists to protect a layer's shape. An eraser is the one
         * brush that attacks exactly that, so on a locked layer it does
         * nothing rather than punching holes — same as Krita. */
        if (_alphaLocked() && getParams().blendMode === 'erase') {
            if (_flowCtx) _flowCtx.clearRect(x, y, w, h);
            _dirtyRect = null;
            return;
        }
        /* A mixing or smudging first brush writes the layer itself
         * (_smudgeDab), so only its second brush is in the buffers: laid on
         * the layer once, at the end, by its own rule -- restoring the
         * untouched layer first wiped the first brush out (Wet wash, once
         * its second stopped mixing). */
        var gp0 = getParams(), sec0 = (gp0.smudgeMode != null || gp0.mixAlpha != null) && _secondOf();
        if (sec0) {
            if (isFinal) {
                if (app.layerMgr && app.layerMgr.markDirty && mainCtx === app.ctx) app.layerMgr.markDirty(x, y, w, h);
                if (_subOn) {
                    var li = mainCtx.getImageData(x, y, w, h), ld = li.data, lsd = _subCtx.getImageData(x, y, w, h).data;
                    for (var lj = 3; lj < ld.length; lj += 4) {
                        var la = ld[lj], ls = lsd[lj];
                        ld[lj] = _subOn === 'contrast' ? la + _round((255 - 2 * ls) * _min(la, 255 - la) / 255)
                            : _subOn === 'min' ? _min(la, ls) : _subOn === 'cut' ? la - _round(ls * _min(la, 255 - la) / 255) : la - ls;
                    }
                    mainCtx.putImageData(li, x, y);
                    _subOn = false;
                } else {
                    mainCtx.save();
                    mainCtx.globalCompositeOperation = sec0.op;
                    mainCtx.drawImage(_flowCanvas, x, y, w, h, x, y, w, h);
                    mainCtx.restore();
                }
                _flowCtx.clearRect(x, y, w, h);
            }
            _dirtyRect = null;
            return;
        }
        // Preview mode (clearFlow=true): composite new dabs on top of the
        // existing canvas without restoring the background — old dabs from
        // previous flushes stay on the canvas. This avoids re-compositing
        // the full stroke area on every tick.
        // Final mode (clearFlow=false): restore clean background first so
        // all dabs (which are in the flow buffer) blend against the original
        // canvas with correct opacity.
        if (!clearFlow && _bgCanvas) {
            mainCtx.clearRect(x, y, w, h);
            mainCtx.drawImage(_bgCanvas, x, y, w, h, x, y, w, h);
        }
        // Clip the wet paint to the selection before it is composited. The
        // stencil covers the whole canvas, but destination-in clears every
        // pixel the drawn image does not cover — so a bare sub-rect drawImage
        // would wipe the rest of the stroke. The clip confines that wipe to
        // the dirty rect, which is all this flush may touch.
        if (_selStencil && _flowCtx) {
            _flowCtx.save();
            _flowCtx.beginPath();
            _flowCtx.rect(x, y, w, h);
            _flowCtx.clip();
            _flowCtx.globalCompositeOperation = 'destination-in';
            _flowCtx.drawImage(_selStencil, x, y, w, h, x, y, w, h);
            _flowCtx.restore();
        }
        /* Grain the finished stroke, on a copy: the flow buffer survives to
         * the next flush and must stay ungrained, or every region already
         * flushed would be grained a second time. */
        var _p = getParams();
        var src = _flowCanvas;
        if (_hasDualTip(_p) && _flowCanvas) {
            _ensureGrainCanvas(_flowCanvas.width, _flowCanvas.height);
            var rec = _dualTile(_p.dualTip, _p.dualScale, _p.dualDepth);
            _grainCtx.clearRect(x, y, w, h);
            _grainCtx.drawImage(_flowCanvas, x, y, w, h, x, y, w, h);
            _grainCtx.save();
            _grainCtx.globalCompositeOperation = 'destination-in';
            _grainCtx.fillStyle = rec.pattern;
            // No translate: the buffer is already in document coordinates,
            // which is exactly what anchors the grain to the canvas.
            _grainCtx.fillRect(x, y, w, h);
            _grainCtx.restore();
            src = _grainCanvas;
        }

        /* Wash, on a copy (W3): must run before the edge/grain stamps below
         * so both read the washed alpha, not the raw stacked ink -- see
         * _applyWatercolorWash for why this has to be a flush-time scale of
         * the accumulated buffer rather than a per-dab adjustment. The
         * source (flow or grain buffer) must survive unwashed for the next
         * flush of this same stroke to keep compositing into. */
        if (_p.watercolor && _flowCanvas) {
            _ensureWashCanvas(_flowCanvas.width, _flowCanvas.height);
            _washCtx.clearRect(x, y, w, h);
            _washCtx.drawImage(src, x, y, w, h, x, y, w, h);
            _applyWatercolorWash(_washCtx, x, y, w, h, _WATERCOLOR_WASH * (_p.flow / 100));
            src = _washCanvas;
        }
        /* No anti-aliasing (Clip Studio's off): each pixel is ink or paper.
         * Over half is ink, which keeps Black soot's edge hard; under it a
         * pixel inks at a chance of its coverage, so a hatch line or dot
         * the thumbnail tip blurred to grey does not vanish (Light
         * crosshatch's haze reads as scattered dots there, as in Clip
         * Studio). The chance is fixed per canvas pixel, so a live stroke
         * keeps its dots from one flush to the next.
         * ponytail: over-inks thin hatching by up to a third; a real tip
         * at full resolution would need no guessing. */
        if (_subOn && _subOn !== 'contrast' && isFinal && _flowCanvas && _secondOf()) {
            _ensureWashCanvas(_flowCanvas.width, _flowCanvas.height);
            if (src !== _washCanvas) {
                _washCtx.clearRect(x, y, w, h);
                _washCtx.drawImage(src, x, y, w, h, x, y, w, h);
            }
            var wi = _washCtx.getImageData(x, y, w, h), wd = wi.data, sd = _subCtx.getImageData(x, y, w, h).data;
            for (var si = 3; si < wd.length; si += 4) wd[si] = _subOn === 'min' ? _min(wd[si], sd[si])
                : _subOn === 'cut' ? wd[si] - _round(sd[si] * _min(wd[si], 255 - wd[si]) / 255) : wd[si] - sd[si];
            _washCtx.putImageData(wi, x, y);
            _subOn = false;
            src = _washCanvas;
        }
        if (_p.aliased && _flowCanvas) {
            _ensureWashCanvas(_flowCanvas.width, _flowCanvas.height);
            if (src !== _washCanvas) {
                _washCtx.clearRect(x, y, w, h);
                _washCtx.drawImage(src, x, y, w, h, x, y, w, h);
            }
            _applyAliased(_washCtx, x, y, w, h, _p.dabMax ? _round(255 * _min(1, _p.flow / 100)) : 255);
            src = _washCanvas;
        }

        var blend = _blendOp(_p.blendMode);
        /* Watercolour restacks by multiplying, not by compositing over: laying
         * the same stroke down repeatedly in CSP walks the colour PAST the
         * picked swatch toward near-primary saturation, which bounded
         * alpha-over provably cannot do (it can only converge to the colour
         * being composited). Multiply reproduces real CSP measurements to
         * within about two levels out of 255 across repeated strokes, and it
         * gets the structure right for free rather than by fitting: a channel
         * already at full strength multiplies as identity so it never moves,
         * the weaker channels each decay at their own rate -- which is exactly
         * what makes one swatch drift in hue under restacking while another
         * with two evenly-matched weak channels does not -- and a first stroke
         * over white paper is unchanged (white x C = C), so this alters
         * restacking only, never the initial lay-down. An explicitly chosen
         * blend mode still wins; only the default is redirected.
         *
         * Not on a locked layer: any operator other than source-over routes
         * into the clip-then-blend branch below, whose alpha result is the
         * union a_s + a_b(1 - a_s) -- that GROWS alpha on a half-covered
         * locked edge pixel, which is exactly what alpha lock promises not to
         * do. Locked strokes keep the source-atop path and deposit without
         * restack darkening. */
        var locked = _alphaLocked();
        if (_p.watercolor && !locked && blend === 'source-over') blend = 'multiply';
        /* Watercolour edge on a copy (W2), on the WASHED but still
         * ungrained alpha, before the lock clip: the ring reads its own
         * output, so edging the buffer in place would compound every flush,
         * each pass re-darkening the last pass's ring. Deliberately before
         * paper grain (below), not after -- the ring is detected as a
         * deficit against a locally box-blurred alpha (see
         * _applyWaterEdge), and grain speckle is exactly the kind of
         * per-pixel noise that swamps that signal: measured against
         * CSP.png, running edge-detection on already-grained alpha buried
         * the true boundary gradient in speckle-sized false edges and the
         * real rim came out too weak to see next to the noise. Detecting
         * on the smooth wash first and stamping grain on top afterward
         * keeps the two effects visually independent, the way they are
         * physically (paper tooth vs. pigment pooling at a drying edge).
         * The copy keeps the flow buffer un-edged; every flush re-edges the
         * complete accumulated ink. The ring is paint, so the lock below clips
         * the copy like everything else. Frozen params in, explicit args out
         * (Item 5: no live reads below here). */
        if ((_p.edgeWidth || 0) > 0 && (_p.edgeDensity || 0) > 0 && _flowCanvas) {
            _ensureEdgeCanvas(_flowCanvas.width, _flowCanvas.height);
            /* _applyWaterEdge box-blurs a margin of _p.edgeWidth pixels PAST
             * x,y,w,h to detect where alpha falls off (see its own comment).
             * That margin must be copied from src here too, or the blur reads
             * whatever this scratch canvas last held out there -- stale ink
             * from a previous flush's rect, or nothing -- as if it were this
             * stroke's real alpha, registers a false cliff exactly on the
             * rect's own border, and stamps a rim there: a rectangular seam
             * around every flush instead of a rim around the actual stroke. */
            var _eR = _max(2, _round(_p.edgeWidth) + 1);
            var _eBw = _flowCanvas.width, _eBh = _flowCanvas.height;
            var _eX = _max(0, x - _eR), _eY = _max(0, y - _eR);
            var _eX2 = _min(_eBw, x + w + _eR), _eY2 = _min(_eBh, y + h + _eR);
            var _eW = _eX2 - _eX, _eH = _eY2 - _eY;
            if (_eW > 0 && _eH > 0) {
                _edgeCtx.clearRect(_eX, _eY, _eW, _eH);
                _edgeCtx.drawImage(src, _eX, _eY, _eW, _eH, _eX, _eY, _eW, _eH);
            }
            if (!_p.edgeAdd) _applyWaterEdge(_edgeCtx, x, y, w, h, _p.edgeWidth, _p.edgeDensity);
            src = _edgeCanvas;
        }
        /* Paper grain belongs on the finished stroke, not on each dab: a
         * flat watercolour brush is painted at tight spacing (a dab every
         * ~1% of its size), so per-dab grain -- punched into each dab's own
         * scratch mask before it composites -- gets refilled solid by the
         * next, barely-shifted dab almost everywhere, leaving no visible
         * texture (measured: 254-255/255, effectively zero variance).
         * Applied once here instead, over the whole accumulated (washed,
         * now edged) shape, the same speckle actually survives to be seen
         * -- same fix the dual-tip path above uses for its own grain, just
         * without requiring a dual tip. Stamped last, after the edge ring,
         * so grain still visibly textures the rim instead of only the
         * interior. */
        if ((_p.watercolor || _p.textureStroke != null) && (_p.texture || 0) > 0 && _flowCanvas) {
            if (src === _flowCanvas || src === _grainCanvas) {
                _ensureWashCanvas(_flowCanvas.width, _flowCanvas.height);
                _washCtx.clearRect(x, y, w, h);
                _washCtx.drawImage(src, x, y, w, h, x, y, w, h);
                src = _washCanvas;
            }
            var _gtx = src === _edgeCanvas ? _edgeCtx : _washCtx;
            /* Clip Studio's paper on the stroke is its own blend, the one
             * measured on each dab (_cspPaper), read straight off the
             * paper's alpha -- not the contrast-curved grain below. */
            if (_p.textureStroke == null || !_applyTextureNoise(_gtx, w, h, _p.texture, _p.textureScale, _p.textureType, x, y, _p.textureStroke, null, true)) {
                /* _applyTextureNoise paints at its ctx's own origin (it's
                 * normally handed a dab-local scratch canvas) -- translate the
                 * full-document buffer to the dirty rect's corner first, and
                 * clip to it, so the grain lands where the ink actually is
                 * instead of the canvas's top-left corner. */
                _gtx.save();
                _gtx.beginPath();
                _gtx.rect(x, y, w, h);
                _gtx.clip();
                _gtx.translate(x, y);
                _applyTextureNoise(_gtx, w, h, _p.texture, _p.textureScale, _p.textureType, x, y);
                _gtx.restore();
            }
        }
        /* 'contrast' reads the stroke WITH its paper: Wet blotting ink's
         * band is 215 with paper and no second brush, 254 with neither, and
         * the second brush moves the papered 215 (to 178 under it, 244 at
         * its fading edge) but not the solid 254 (cdp-csp/zx, qw). */
        if (_subOn === 'contrast' && isFinal && _flowCanvas && _secondOf()) {
            if (src !== _washCanvas && src !== _edgeCanvas) {
                _ensureWashCanvas(_flowCanvas.width, _flowCanvas.height);
                _washCtx.clearRect(x, y, w, h);
                _washCtx.drawImage(src, x, y, w, h, x, y, w, h);
                src = _washCanvas;
            }
            var cctx = src === _edgeCanvas ? _edgeCtx : _washCtx;
            var ci = cctx.getImageData(x, y, w, h), cd = ci.data, csd = _subCtx.getImageData(x, y, w, h).data;
            for (var cj = 3; cj < cd.length; cj += 4) cd[cj] += _round((255 - 2 * csd[cj]) * _min(cd[cj], 255 - cd[cj]) / 255);
            cctx.putImageData(ci, x, y);
            _subOn = false;
        }
        /* Clip Studio's edge goes on over its paper (Round watercolor's rim
         * stands 39 above the grained wash), so after the grain above. */
        if (_p.edgeAdd && src === _edgeCanvas) {
            _applyWaterEdgeAdd(_edgeCtx, x, y, w, h, _p.edgeWidth, _p.edgeDensity, opacity, _p.edgeValue);
            opacity = 1;
        }
        mainCtx.save();
        mainCtx.globalAlpha = opacity;
        if (locked && blend !== 'source-over') {
            /* Alpha lock and a blend mode both want the composite operator,
             * and only one can have it. So the lock is applied to the wet
             * paint instead: clip the flow buffer to where the layer already
             * had pixels, then let the blend run normally. _bgCanvas is the
             * untouched layer, which is exactly the alpha to clip against. */
            var lockCtx = (src === _grainCanvas) ? _grainCtx :
                ((src === _edgeCanvas) ? _edgeCtx :
                ((src === _washCanvas) ? _washCtx : _flowCtx));
            if (_bgCanvas && lockCtx) {
                // Same destination-in wipe rule as the stencil above: confine
                // the clip to the dirty rect so the rest of the buffer survives.
                lockCtx.save();
                lockCtx.beginPath();
                lockCtx.rect(x, y, w, h);
                lockCtx.clip();
                lockCtx.globalCompositeOperation = 'destination-in';
                lockCtx.drawImage(_bgCanvas, x, y, w, h, x, y, w, h);
                lockCtx.restore();
            }
            mainCtx.globalCompositeOperation = blend;
        } else if (locked) {
            // Alpha lock: keep the destination's own alpha, so paint lands only
            // where the layer already had pixels. The background restore above has
            // already put the layer's original alpha back under us.
            mainCtx.globalCompositeOperation = 'source-atop';
        } else {
            mainCtx.globalCompositeOperation = blend;
        }
        mainCtx.drawImage(src, x, y, w, h, x, y, w, h);
        mainCtx.restore();
        // Preview-mode: clear the flushed area from the flow buffer so the
        // dirty rect stays small and per-flush compositing stays O(new dabs)
        // instead of O(entire stroke).
        if (clearFlow && _flowCtx) {
            _flowCtx.clearRect(x, y, w, h);
        }
        _dirtyRect = null;
    }

    /* ------------------------------------------------------------------ */
    /*  Airbrush state                                                     */
    /* ------------------------------------------------------------------ */
    /* Built once per stroke from the active selection, and used as a stencil
     * when the flow buffer is composited. The brush reaches the layer by one
     * drawImage rather than through the pixel-drawing helpers, so it never
     * passed the selection clip every other tool goes through. */
    var _selStencil = null;
    /* The artwork under the stroke, read back ONCE per stroke. Colour mixing
     * used to call getImageData per dab — nearly a thousand GPU readbacks for
     * a single stroke. Sampling the stroke-start snapshot also makes the result
     * deterministic: the old code sampled whatever the last frame happened to
     * have flushed, so the same stroke could mix differently run to run. */
    var _sampleTiles = null, _sampleW = 0, _sampleH = 0;

    var _airbrushTimer = null;
    var _airbrushLastPos = null;
    var _airbrushLastColor = null;

    function _startAirbrush(x, y, color) {
        _stopAirbrush();
        _airbrushLastPos = { x: x, y: y };
        _airbrushLastColor = color;
        var rate = _max(1, _params.airbrushRate);
        var interval = _max(16, _round(1000 / rate));
        _airbrushTimer = setInterval(function () {
            if (!_state.isDrawing || !_airbrushLastPos) return;
            var pressure = 0.3 + Math.random() * 0.4;
            _renderDab(_airbrushLastPos.x, _airbrushLastPos.y, pressure, _airbrushLastColor);
            _hintFlushRect();
            var _airOc = _outCtx();
            if (_airOc) {
                _flushFlowBuffer(_airOc);
            }
        }, interval);
    }

    function _stopAirbrush() {
        if (_airbrushTimer) {
            clearInterval(_airbrushTimer);
            _airbrushTimer = null;
        }
        _airbrushLastPos = null;
        _airbrushLastColor = null;
    }

    /* ------------------------------------------------------------------ */
    /*  Stroke processing                                                  */
    /* ------------------------------------------------------------------ */
    // taperMode: 0 = none, 1 = taper-in only (live preview), 2 = both (final stroke)
    function _processSegment(points, startIdx, endIdx, colorHex, taperMode, resume) {
        if (endIdx <= startIdx) return;
        /* Resume checkpoint (Item 4): re-enter at the suspended segment with
         * its step. Everything else recomputes identically — params are
         * frozen for the stroke, and _lastDabDist / _smoothAngle / _dabIndex /
         * _wet were left consistent because suspension only lands BETWEEN
         * dabs. fr and remaining re-derive from those, so they need no slot. */
        var _resumeSeg = resume ? resume.segIdx : -1;

        var p = getParams();
        var spacing = p.spacing / 100;
        var sz = p.size;
        /* Spacing can follow a sensor too -- Photoshop, Krita and Clip
         * Studio all let it, and a brush that tightens up as you press is a
         * different brush from one that does not. The sensor is read from the
         * dab just placed, because where the NEXT dab lands is what spacing
         * decides and its pressure is not known yet. */
        /* Krita's effectiveSpacing (kis_paintop_utils.cpp), from the dab
         * just placed:
         *  - the gap scales with THAT dab's size, pressure and all. Off the
         *    preset's size, a light-pressure stretch of a pressure brush was
         *    spaced for a full-size dab and broke into beads;
         *  - auto spacing is coeff * sqrt(size) pixels, not a percentage;
         *  - the gap is an ellipse whose axes are the tip's width and height,
         *    so a flat tip dragged across its thin side packs its dabs by its
         *    thin side. Off its longest side, a 5:1 chisel at 10% laid dabs
         *    twice their own thickness apart. The aspect SENSOR is left out,
         *    as Krita leaves it out;
         *  - those axes are the box around the tip turned by its FIXED angle
         *    (KisBrush::characteristicSize), and only the rotation sensor
         *    turns the ellipse (KisBrushOp::updateSpacingImpl). Charcoal
         *    Pencil's 0.8 tip at 309 degrees is 10.4px across its box, not
         *    8.3, and packed a fifth too many dabs. */
        var _tipAsp = 1;
        if (p.shape === 'custom' && _tipCanvas()) {
            var _tc = _tipCanvas();
            /* One cell: _tipCanvas is already cut from the strip. Dividing by
             * tipCells again made GIMP's five-cell Splats 02 a fifth as wide
             * as it is, and it laid dabs 2.6px apart where GIMP lays 12. */
            _tipAsp = _tc.width / _max(1, _tc.height);
        }
        function _gap(d) {
            return p.autoSpacing > 0 ? p.autoSpacing * (d < 1 ? d : Math.sqrt(d)) : d * spacing;
        }
        /* rot: the dab's own drawing angle where it is not the stroke's
         * (Krita's first dab, see originAngle): the inputs read it, and the
         * spacing ellipse turns with the tip it gives. */
        function _stepFor(pr, px, py, ang, rot) {
            var sc = { x: px, y: py, pressure: pr, strokeAngle: rot != null ? rot : ang };
            var d = p.sprayEach ? sz : _max(0.5, _dyn(p, 'size', sz, sc, 1));
            var w = d, h = d;
            if (_tipAsp >= 1) h = d / _tipAsp; else w = d * _tipAsp;
            // a star is its diameter every way (KisMaskGenerator::height)
            var asp = p.spikes > 2 ? 1 : p.aspectRatio || 1;
            if (asp >= 1) h /= asp; else w *= asp;
            /* Krita builds a generated tip at the brush's size and keeps its
             * width and height as whole pixels (KisBrush::setWidth takes an
             * int), and spaces by those: 30 at ratio 0.28 is 30x8, not 30x8.4
             * -- special_shadow's upright line laid its dabs 12.4 apart
             * where Krita's are 11.8. The 0.02 absorbs the importer's
             * two-decimal aspect. A tip under a pixel is built a pixel wide
             * and scaled by the size option alone (EO Pixel Perfect's 0.01). */
            if (p.spacingWhole && sz > 0) {
                var ks = _dyn(p, 'size', 1, sc, 1);
                w = _max(1, _floor(sz * w / d + 0.02)) * ks; h = _max(1, _floor(sz * h / d + 0.02)) * ks;
            }
            var t0 = (p.angle || 0) * _PI / 180, c0 = _abs(_cos(t0)), s0 = _abs(_sin(t0));
            var bw = w * c0 + h * s0, bh = w * s0 + h * c0;
            var g;
            /* Clip Studio: the tip's width as its thickness squeezes it, however
             * it is turned -- not the picture's own shape: Charcoal's 105x147
             * picture on auto (12%) lays the ink of a fixed 12% of the size,
             * not of its narrow side (cdp-csp/ch zcsa, zcs12: 12526 / 12510;
             * by the narrow side 13404). */
            if (p.spacingByWidth) {
                g = _gap(asp < 1 ? d * asp : d);
            } else if (p.spacingBySize) {
                g = _gap(d);
            } else if (p.spacingIsotropic || bw === bh) {   // GIMP spaces a 164x166 tip by its 164
                g = _gap(_max(bw, bh));
            } else {
                // Krita floors each axis (MIN_DISTANCE_SPACING): floored after,
                // a thin bar's ellipse came in under it on a slant. GIMP does
                // not (Block 03's slant 0.99 of GIMP's ink unfloored, 0.95 floored).
                var f = p.pixelSteps ? 0 : 0.5, a = _max(f, _gap(bw)), b = _max(f, _gap(bh));
                var phi = ((ang || 0) - _dynAngle(p, p.angle, sc) + (p.angle || 0)) * _PI / 180;
                g = 1 / Math.sqrt(_pow(_cos(phi) / a, 2) + _pow(_sin(phi) / b, 2));
            }
            /* spacingStrength: a Krita spacing option's own multiplier, which
             * holds when its curve box is clear and can pass 1. */
            if (p.spacingStrength != null || p.spacingSensors || (p.spacingSrc && p.spacingSrc !== 'none')) {
                g *= _dyn(p, 'spacing', 1, sc, 10);
            }
            /* Krita's floor (MIN_DISTANCE_SPACING, kis_distance_information.cpp).
             * At 1px Ink-1 Precision's 3px dabs, due every 0.45px, stacked to
             * 159 where Krita's reach 225. */
            if (pxLine && !p.pxFloor) { var ar = (ang || 0) * _PI / 180; g = _max(g, 1 / _max(_abs(_cos(ar)), _abs(_sin(ar)))); }
            /* GIMP below a pixel's spacing (test/gimp/probe.mjs, "tiny"): the
             * first dab sits on the start point, every later one on the next
             * pixel centre along the line's main axis at least a pixel on.
             * Its 1px brushes paint the same at 0.01 and 0.5 spacing: a line
             * on a pixel boundary is 128 on both rows, one dab per column,
             * and a slant splits 205/50. Stacked every 0.1px they were 183. */
            if (p.pixelSteps && sz * spacing < 1 && !(p.autoSpacing > 0)) {
                var ag = (ang || 0) * _PI / 180, cg = _cos(ag), sg = _sin(ag);
                var onX = _abs(cg) >= _abs(sg), m = onX ? px : py, dm = onX ? cg : sg;
                var nx = dm >= 0 ? Math.ceil(m + 0.5 - 1e-6) + 0.5 : _floor(m - 1.5 + 1e-6) + 0.5;
                g = _abs(nx - m) / _max(1e-6, _abs(dm));
            }
            return _max(p.minStep || 0.5, g);
        }
        var pxLine = p.sharpness > 0 && sz <= 1;
        var step = resume ? resume.step
            : _stepFor(points[startIdx] ? points[startIdx].pressure || 0.5 : 0.5,
                       points[startIdx] ? points[startIdx].x : 0,
                       points[startIdx] ? points[startIdx].y : 0, 0);
        // Cumulative pixel distance from stroke start up to this segment.
        var strokeDist = (points[startIdx] && points[startIdx].dist) || 0;

        // Use module-level _lastDabDist for continuous dab tracking across batches.
        if (_lastDabDist == null) _lastDabDist = strokeDist;
        var prev = points[startIdx];
        var segIdx = startIdx;

        // Total stroke distance (used only by final pass).
        var lastPt = points[points.length - 1];
        var totalDist = (lastPt && lastPt.dist) || 0;

        /* How long each taper runs, resolved once for the stroke.
         *
         * 'stroke' measures the taper as a share of the line actually drawn,
         * which is the mode CSP inkers live in — a fixed length is wrong for
         * a long sweep and a short dash at the same time. It needs the total,
         * so it can only be honoured on the final pass; the live preview
         * falls back to brush-relative and the final pass redraws the stroke
         * from scratch anyway. 100 means "half the stroke", so start and end
         * at 100 meet in the middle and give a clean dart. */
        var tStart = 0, tEnd = 0;
        if (taperMode && (p.taperStart > 0 || p.taperEnd > 0)) {
            if (p.taperUnit === 'stroke' && taperMode >= 2 && totalDist > 0) {
                tStart = (p.taperStart / 100) * totalDist * 0.5;
                tEnd   = (p.taperEnd   / 100) * totalDist * 0.5;
            } else {
                tStart = (p.taperStart / 100) * sz * 30;
                tEnd   = (p.taperEnd   / 100) * sz * 30;
            }
            /* Too short to fit both? Shrink them to fit, the way CSP does.
             * The old code dropped the end taper whole whenever the stroke
             * was shorter than it, so a short flick ramped up across its
             * entire length and then stopped dead at part ink — no point on
             * either end, which is the opposite of what taper is for. */
            if (taperMode >= 2 && totalDist > 0 && tStart + tEnd > totalDist) {
                var _k = totalDist / (tStart + tEnd);
                tStart *= _k; tEnd *= _k;
            }
        }

        function _taperAtDist(dabDist) {
            if (tStart <= 0 && tEnd <= 0) return 1;
            var f = 1;
            if (tStart > 0 && dabDist < tStart) {
                var _t = dabDist / tStart;
                f = _t * _t * (3 - 2 * _t);
            }
            if (taperMode >= 2 && tEnd > 0) {
                var fromEnd = _max(0, totalDist - dabDist);
                if (fromEnd < tEnd) {
                    var _e = fromEnd / tEnd;
                    f = _min(f, _e * _e * (3 - 2 * _e));
                }
            }
            return _clamp(f, 0, 1);
        }

        var segAngle = 0;
        // Dabs painted by this call: suspension needs at least one, so a
        // frame slower than the whole budget delays but never stalls.
        var _dabsThisPass = 0;

        // On resume the first dab is already on the canvas (suspension only
        // lands after a dab), so repainting it would double-ink it.
        if (startIdx === 0 && !resume) {
            var _tp = prev.pressure || 0.5;
            var _tf0 = _taperAtDist(strokeDist);
            var _firstAngle;
            if (endIdx > startIdx) {
                var _dx = points[startIdx + 1].x - prev.x, _dy = points[startIdx + 1].y - prev.y;
                if (_hypot(_dx, _dy) >= 0.001) {
                    _firstAngle = Math.atan2(_dy, _dx) * 180 / _PI;
                    _smoothAngle = _firstAngle;
                    /* The first gap is along the stroke too: sized for a
                     * left-to-right stroke, GIMP's 532x400 goat went down a
                     * 70px line in 3 dabs where GIMP lays 4. */
                    /* Krita spaces the second dab by the first one's ellipse,
                     * and that dab is turned from the origin: taken along the
                     * stroke, every later Lace dab sat 0.3-1.6px back. */
                    step = _stepFor(_tp, prev.x, prev.y, _firstAngle,
                        p.originAngle ? _atan2(prev.y, prev.x) * 180 / _PI : null);
                }
            }
            _pxOff = pxLine ? (p.pxFloor ? [-0.5, -0.5] : [_ceil(prev.x - 0.5) - prev.x, _ceil(prev.y - 0.5) - prev.y]) : null;
            /* A Clip Studio spray lays nothing at the pen: its first stop is
             * a quarter of a particle on, or a step if that is nearer, then
             * one a step (Pointillism's particle of 263 first at 66px at
             * steps 263 and 394; of 100 at 25px at a step of 200, 10 and 20
             * at steps of 10 and 20; cdp-csp/po zpp*). */
            if (p.firstDabAt && endIdx > startIdx) _lastDabDist = strokeDist + _min(step, p.firstDabAt * sz) - step;
            else _renderDab(prev.x + (_pxOff ? _pxOff[0] : 0), prev.y + (_pxOff ? _pxOff[1] : 0), _tp, colorHex, _firstAngle,
                prev.pressure || 0.5, _tf0);
            if (p.ribbonLens) step *= _ribbonLen(p, false);
            _fan = { a: p.originAngle ? _atan2(prev.y, prev.x) * 180 / _PI : (_firstAngle || 0), x: prev.x, y: prev.y, p: _tp };
        }

        while (segIdx < endIdx) {
            var next = points[segIdx + 1];
            var segLen = _hypot(next.x - prev.x, next.y - prev.y);

            if (segLen < 0.001) {
                segIdx++;
                prev = next;
                continue;
            }

            var _dirPrev = _max(0, segIdx - 1);
            var _dirNext = segIdx + 1;
            var _dirDx = points[_dirNext].x - points[_dirPrev].x;
            var _dirDy = points[_dirNext].y - points[_dirPrev].y;
            if (_hypot(_dirDx, _dirDy) < 0.001) {
                _dirDx = next.x - prev.x;
                _dirDy = next.y - prev.y;
            }
            segAngle = Math.atan2(_dirDy, _dirDx) * 180 / _PI;
            var _normLen = _clamp(segLen / _max(1, sz), 0, 2);
            var _blendFactor = _clamp(0.2 + _normLen * 0.3, 0.2, 0.8);
            if (segIdx === _resumeSeg && !isNaN(_smoothAngle)) {
                // The EMA update for this segment ran before the suspend and
                // _smoothAngle already holds its result — reuse it exactly
                // instead of applying the update a second time.
                segAngle = _smoothAngle;
            } else if (!isNaN(_smoothAngle)) {
                var _diff = segAngle - _smoothAngle;
                if (_diff > 180) _diff -= 360;
                if (_diff < -180) _diff += 360;
                _smoothAngle += _diff * _blendFactor;
                segAngle = _smoothAngle;
            } else {
                _smoothAngle = segAngle;
            }

            // Place dabs at step intervals using cumulative stroke distance.
            // This ensures uniform spacing regardless of segment length
            // (fixes different spacing on slow vs fast strokes).
            var nextDist = (next.dist != null) ? next.dist : _lastDabDist + segLen;
            var remaining = nextDist - _lastDabDist;

            /* A pixel line reaches its end pixel; and steps summed in floats
             * must not lose the dab on the pen: 250 steps of 3.2px came to a
             * hair past 800, and Round watercolor ended 3px short of Clip
             * Studio's. */
            var _eps = 1e-6;
            /* Clip Studio's continuous spray: a pen report that no dab
             * reached gets one of its own, so a wide spacing still lays a
             * dab a report (size 40 at 150%: one every 60px off, one every
             * 11.4px on, over 70 reports in 800px; at 6px and 150% the
             * spacing reaches every report and nothing is added). */
            var _each = p.dabEachReport && remaining > 0 && remaining < step - _eps && !(_paintDeadline > 0 && _dabsThisPass > 0 &&
                performance.now() >= _paintDeadline);
            if (_each) { _lastDabDist = nextDist - step; remaining = step; }
            if (remaining >= step - _eps) {
                var segStartDist = (points[segIdx].dist != null) ? points[segIdx].dist : (nextDist - segLen);
                while (remaining >= step - _eps) {
                    /* Frame budget (Item 4): suspend between dabs — never
                     * inside _renderDab's di group, where _dabIndex and _wet
                     * would double-count on re-entry. _paintDeadline is zero
                     * outside live passes, which both run whole: the
                     * endStroke drain and the final replay. */
                    if (_paintDeadline > 0 && _dabsThisPass > 0 &&
                        performance.now() >= _paintDeadline) {
                        _state.suspend = { segIdx: segIdx, step: step };
                        _suspendCount++;
                        return;
                    }
                    var dabDist = _lastDabDist + step;
                    var fr = _clamp((dabDist - segStartDist) / (segLen || 1), 0, 1);
                    var ptx = _lerp(prev.x, next.x, fr);
                    var pty = _lerp(prev.y, next.y, fr);
                    /* Clip Studio's Dot pen: each column (row, on a steep
                     * line) takes the line where it crosses the pixel's
                     * middle, the pixel it is in (cdp-csp/qd diagonals, every
                     * pixel). Steps of a pixel along the line never skip one. */
                    if (p.pxFloor && _abs(next.x - prev.x) >= _abs(next.y - prev.y)) { ptx = _floor(ptx) + 0.5; pty = prev.y + (next.y - prev.y) * (ptx - prev.x) / (next.x - prev.x); }
                    else if (p.pxFloor) { pty = _floor(pty) + 0.5; ptx = prev.x + (next.x - prev.x) * (pty - prev.y) / (next.y - prev.y); }
                    if (_pxOff) { ptx += _pxOff[0]; pty += _pxOff[1]; }
                    var _rawPressure = _lerp(prev.pressure || 0.5, next.pressure || 0.5, fr);
                    /* Krita's fan corners (KisPaintOpUtils::paintFan): a turn
                     * sharper than the step is filled with dabs turned a step
                     * at a time, laid from the last dab toward this one. A
                     * stroke's first turn is from the canvas origin's angle,
                     * so Wood_Fiber's rake fans out where each line starts. */
                    if (p.fanStep > 0 && _fan) {
                        var fa = _fan.a, fd = ((segAngle - fa) % 360 + 540) % 360 - 180, fi = 0;
                        while (_abs(((segAngle - fa) % 360 + 540) % 360 - 180) > p.fanStep) {
                            fa += fd > 0 ? p.fanStep : -p.fanStep;
                            var ft = p.fanStep * fi++ / _abs(fd);
                            _renderDab(_lerp(_fan.x, ptx, ft), _lerp(_fan.y, pty, ft), _lerp(_fan.p, _rawPressure, ft), colorHex, fa,
                                _lerp(_fan.p, _rawPressure, ft), _taperAtDist(dabDist));
                        }
                    }
                    _renderDab(ptx, pty, _rawPressure, colorHex, segAngle,
                        _rawPressure, _taperAtDist(dabDist));
                    if (_fan) { _fan.a = segAngle; _fan.x = ptx; _fan.y = pty; _fan.p = _rawPressure; }
                    _lastDabDist = dabDist;
                    _dabsThisPass++;
                    step = _stepFor(_rawPressure, ptx, pty, segAngle);
                    if (p.ribbonLens) step *= _ribbonLen(p, false);
                    remaining = nextDist - _lastDabDist;
                }
            }

            segIdx++;
            prev = next;
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Custom PNG tip support                                              */
    /* ------------------------------------------------------------------ */

    /* Cut a tip strip into its separate shapes, left to right, and optionally
     * add a mirrored copy of each. Cells are always equal width -- a .gih
     * records one cell size for the whole file -- so this is a plain divide.
     * Mirroring costs nothing at paint time because the flip happens once,
     * here, and the picker just sees a longer list. */
    function _sliceCells(src, n, mirror, flip) {
        n = _max(1, n | 0);
        if (n > src.width) n = 1;
        var cw = _floor(src.width / n), out = [];
        /* Two different things, and they used to be one. A FLIP is
         * Photoshop's `flipX`/`flipY`: the tip is turned over once and stays
         * that way. A MIRROR is Krita's: every dab picks between the shape
         * and its reflection, so one axis doubles the list and both axes
         * make four. `true` is the old saved value and still means across. */
        var bx = (flip === 'h' || flip === 'both') ? -1 : 1;
        var by = (flip === 'v' || flip === 'both') ? -1 : 1;
        var vars = [[1, 1]];
        if (mirror === 'v') vars.push([1, -1]);
        else if (mirror === 'both') vars.push([-1, 1], [1, -1], [-1, -1]);
        else if (mirror) vars.push([-1, 1]);
        for (var i = 0; i < n; i++) {
            for (var m = 0; m < vars.length; m++) {
                var fx = bx * vars[m][0], fy = by * vars[m][1];
                var c = new OffscreenCanvas(cw, src.height);
                var cx = c.getContext('2d');
                cx.translate(fx < 0 ? cw : 0, fy < 0 ? src.height : 0);
                cx.scale(fx, fy);
                cx.drawImage(src, i * cw, 0, cw, src.height, 0, 0, cw, src.height);
                out.push(c);
            }
        }
        return out;
    }

    /* Re-bake custom tip from raw luminance mask.
       Applies hardness radial falloff and invert, stores in _customTipCells. */
    function _rebakeTip() {
        var raw = _customTipRaw;
        if (!raw) return;
        var W = raw.width, H = raw.height;
        var oc = new OffscreenCanvas(W, H);
        var ox = oc.getContext('2d');
        ox.drawImage(raw, 0, 0);
        var id = ox.getImageData(0, 0, W, H);
        var d  = id.data;
        var invert = !!_tipInvert;
        /* The colours stay. A tip is normally a cut-out and its pixels never
         * show -- but a lightness-mapped or a coloured tip paints with them,
         * and they are thrown away here or nowhere. */
        for (var i = 0; i < d.length; i += 4) {
            var a = d[i + 3] / 255;
            if (invert) a = 1 - a;
            d[i + 3] = Math.round(_clamp(a, 0, 1) * 255);
        }
        ox.putImageData(id, 0, 0);
        _customTipCells = _sliceCells(oc, _params.tipCells || 1, _params.tipMirror, _params.tipFlip);
        _invalidateSwatch(engine._currentPreset);
    }

    /* Scale the baked custom tip to the given dab size, caching results.
       Returns a white-on-transparent mask canvas compatible with _paintDab. */
    var _customTipSizeCache = {};
    /* Every distinct size, angle, squash and hardness of a tip is baked once
     * and kept. A tip is up to 1024px now, so one baked mask can be 4MB and a
     * stroke whose size rides the pen makes a fresh one per pressure step --
     * unbounded, this is a leak that grows with the brush.
     *
     * ponytail: over budget, throw the lot away rather than keep an LRU. The
     * cost of being wrong is re-baking a few masks; give it an LRU if that
     * ever shows up in a frame time. */
    var _tipCacheBytes = 0;
    var TIP_CACHE_MAX = 24 * 1024 * 1024;
    function _tipCacheKeep(key, c) {
        var n = c.width * c.height * 4;
        if (_tipCacheBytes + n > TIP_CACHE_MAX) { _customTipSizeCache = {}; _tipCacheBytes = 0; }
        _tipCacheBytes += n;
        _customTipSizeCache[key] = c;
        return c;
    }

    /* There is only ONE baked custom tip at a time, belonging to whichever
     * preset is loaded. A preview needs its own, or every custom-tip preset
     * would render with the active brush's tip. */
    var _tipSerial = 0;
    var _tipCell = 0;      // which shape of the strip the next dab stamps
    var _tipCycle = 0;     // running count, for tips that rotate in order
    function _tipCells() {
        var c = (_previewTarget && _previewTarget.tip) || _customTipCells;
        return (c && c.length) ? c : null;
    }
    function _tipCanvas() {
        var c = _tipCells();
        return c ? c[_tipCell % c.length] : null;
    }
    /* Pick the shape for one dab. Random reuses the same hash the scatter and
     * angle jitter use, so a dab at a given spot always draws the same shape
     * however many times the stroke is re-rendered -- otherwise the live
     * passes and the final one would disagree and the stroke would flicker. */
    function _pickTipCell(p, x, y, pr) {
        var c = _tipCells();
        var n = c ? c.length : 1;
        if (n < 2) { _tipCell = 0; return; }
        _tipCell = _tipCellAt(p, _tipCycle++, n, x, y, pr);
    }
    /* 'cycle' takes the cells in turn, 'pingpong' out and back (0,1,2,1,0,1..:
     * Clip Studio's order 1, measured on Grass patch), else one at random. */
    /* A mirror flips each dab at random whatever the order (_sliceCells puts
     * each picture's m flips after it): Pastel's one picture in Clip Studio
     * lands flipped at random, where cycling its flips laid them in turn. */
    /* Pictures laid end to end, each at its own length, as a share of the
     * longest: each starts where the last ended, so the step on from one is
     * its own length and its centre half that past the pen (offsetAlong).
     * Centred as the longest, Book's first short spine began 42px past the
     * pen, where Clip Studio's every first picture starts on it. */
    function _ribbonLen(p, next) {
        var c = _tipCells(), n = c ? c.length : 1, L = p.ribbonLens, k = n / L.length;
        if (n < 2 || k % 1) return 1;
        return L[((next ? _tipCellAt(p, _tipCycle, n, 0, 0) : _tipCell) / k) | 0] || 1;
    }
    function _tipCellAt(p, t, n, x, y, pr) {
        var m = p.tipMirror === 'both' ? 4 : p.tipMirror ? 2 : 1;
        /* A pipe picked by pressure (sel0:pressure): the picture at
         * pressure * (count - 1), rounded, in Krita (KisImagePipeBrush) and
         * GIMP alike. paint_smudge_blurry's 25 pictures run ragged to a
         * clean oval; picked at random its stroke came out in blotches. */
        if (p.tipPick === 'pressure' && pr != null && !(n % m)) {
            var q = n / m;
            return _min(q - 1, _floor(_clamp(pr, 0, 1) * (q - 1) + 0.5)) * m + _min(m - 1, _floor(_dabRand(x, y, 29) * m));
        }
        // a ribbon of pictures of their own lengths picks by count, so the next is known (_ribbonLen)
        if (p.ribbonLens && p.tipPick !== 'cycle' && p.tipPick !== 'pingpong') return _min(n - 1, _floor(_dabRand(t, 0, 23) * n));
        if ((p.tipPick !== 'cycle' && p.tipPick !== 'pingpong') || n % m) return _min(n - 1, _floor(_dabRand(x, y, 23) * n));
        var f = _min(m - 1, _floor(_dabRand(x, y, 29) * m));
        n /= m;
        if (p.tipPick === 'cycle' || n < 2) return (t % n) * m + f;
        var k = t % (2 * n - 2); return (k < n ? k : 2 * n - 2 - k) * m + f;
    }
    /* Krita's picture tips (KisQImagePyramid). The tip is kept at halving
     * sizes, each averaged down from the original to W/2^k, rounded; a dab
     * takes the smallest level still at or over its scale and is drawn from
     * it once, bilinear, at its true unrounded scale and turn, already at
     * its sub-pixel phase, its corner the whole pixel under cursor minus
     * half its size (KisDabCacheBase). Shrunk to a rounded size and shifted
     * again by the browser, each Light Shine star was resampled twice and
     * smeared over two rows. Size and phase to a sixteenth of a pixel (a
     * quarter left Light Shine at IoU 0.90, a sixteenth matches it whole),
     * and phases only up to 64px (x null above): a big dab cannot see them. */
    var _kLevels = new WeakMap(), _kReuse = null;
    function _kritaTipLevel(src, sc) {
        var W = src.width, H = src.height, L = 1, k = 0;
        while (0.5 * L > sc - 1e-6 && _round(W * L / 2) > 0 && _round(H * L / 2) > 0) { L /= 2; k++; }
        var lv = _kLevels.get(src), lk = _params.tipPaper && k ? 'p' + k : k;
        if (!lv) _kLevels.set(src, lv = {});
        if (lv[lk]) return lv[lk];
        var cv = src.getContext ? src : new OffscreenCanvas(W, H);
        if (cv !== src) cv.getContext('2d').drawImage(src, 0, 0);
        var d = cv.getContext('2d').getImageData(0, 0, W, H).data;
        // premultiplied floats, across then down, each pixel its exact footprint
        var w = _round(W * L), h = _round(H * L), sx = W / w, sy = H / h;
        var row = new Float32Array(w * H * 4), v = new Float32Array(w * h * 4), x, y, i, n;
        for (y = 0; y < H; y++) for (x = 0; x < w; x++) {
            var a0 = x * sx, a1 = a0 + sx, o = (y * w + x) * 4;
            for (i = _floor(a0); i < a1 && i < W; i++) {
                var f = (_min(i + 1, a1) - _max(i, a0)) / sx, q = (y * W + i) * 4, al = d[q + 3] * f / 255;
                row[o] += d[q] * al; row[o + 1] += d[q + 1] * al; row[o + 2] += d[q + 2] * al; row[o + 3] += d[q + 3] * f;
            }
        }
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
            var b0 = y * sy, b1 = b0 + sy, t = (y * w + x) * 4;
            for (i = _floor(b0); i < b1 && i < H; i++) {
                var g = (_min(i + 1, b1) - _max(i, b0)) / sy, p = (i * w + x) * 4;
                for (n = 0; n < 4; n++) v[t + n] += row[p + n] * g;
            }
        }
        /* Qt shrinks a paper tip's grey and drops the fraction (qSmoothScaleImage),
         * so ink rounds up: each star of FX_splat_starfield keeps a faint ring
         * that held 15% of Krita's ink. The drawn original is never rounded. */
        if (k && _params.tipPaper) for (i = 3; i < v.length; i += 4) v[i] = _ceil(v[i] - 1e-3);
        return (lv[lk] = { w: w, h: h, v: v });
    }
    function _kritaTipMask(src, sz, ang, asp, x, y) {
        var mode = _params.tipMode || 'alpha';
        sz = sz < 64 ? _max(0.25, _round(sz * 16) / 16) : _max(1, _round(sz));
        var sc = sz / _max(src.width, src.height), kx = sc * _min(1, asp), ky = sc / _max(1, asp);
        // the turned tip's bounds: its size, to Krita
        var c = _cos(ang), s = _sin(ang), TW = src.width * kx, TH = src.height * ky;
        var bx = _min(0, TW * c, -TH * s, TW * c - TH * s), by = _min(0, TW * s, TH * c, TW * s + TH * c);
        var bw = _max(0, TW * c, -TH * s, TW * c - TH * s) - bx, bh = _max(0, TW * s, TH * c, TW * s + TH * c) - by;
        var fx = x == null ? 0 : _round((((x - bw / 2) % 1) + 1) % 1 * 16) / 16 % 1;
        var fy = x == null ? 0 : _round((((y - bh / 2) % 1) + 1) % 1 * 16) / 16 % 1;
        var key = 'k|' + _tipKey() + '|' + sz + '|' + ang.toFixed(3) + '|' + asp.toFixed(2) + '|' + mode + (_params.tipPaper ? 'p' : '') + '|' + (x == null ? '' : fx + ',' + fy);
        /* Krita's precision 1-3 (KisDabCacheBase, precisionLevels) keeps the
         * last dab while the next one is within a degree and 5, 1 or 0
         * percent of its size, whatever its sub-pixel: the kept dab lands on
         * the new dab's whole pixel with the old one's fraction, so a thin
         * line steps a pixel at a time (Pencil-5 Tilted). */
        var pl = _params.kPrecision, dw0 = _ceil(fx + bw - 1e-6), dh0 = _ceil(fy + bh - 1e-6);
        if (x != null && pl >= 1 && pl <= 3) {
            var kr = _kReuse, sf = [0.05, 0.01, 0][pl - 1], id = _tipKey() + '|' + _tipCell + '|' + mode;
            if (kr && _dabIndex > 1 && kr.id === id && _abs(kr.ang - ang) <= _PI / 180 && _abs(kr.asp - asp) <= _max(sf, 1e-6) &&
                _abs(kr.dw - dw0) <= _floor(sf * dw0) && _abs(kr.dh - dh0) <= _floor(sf * dh0)) {
                kr.mask._cx = x - _floor(x - bw / 2); kr.mask._cy = y - _floor(y - bh / 2);
                return kr.mask;
            }
            _kReuse = { id: id, ang: ang, asp: asp, dw: dw0, dh: dh0, mask: null };
        }
        var hit = _customTipSizeCache[key];
        if (hit) { if (_kReuse && x != null && pl >= 1 && pl <= 3) { _kReuse.mask = hit; hit._cx = bw / 2 + fx; hit._cy = bh / 2 + fy; } return hit; }
        var lv = _kritaTipLevel(src, _max(kx, ky)), v = lv.v, LW = lv.w, LH = lv.h;
        var ax = kx * src.width / LW, ay = ky * src.height / LH;
        var dw = _max(1, _ceil(fx + bw - 1e-6)), dh = _max(1, _ceil(fy + bh - 1e-6));
        var out = new OffscreenCanvas(dw, dh), oc = out.getContext('2d'), img = oc.createImageData(dw, dh), r = img.data;
        for (var j = 0; j < dh; j++) for (var i = 0; i < dw; i++) {
            var qx = i + 0.5 - fx + bx, qy = j + 0.5 - fy + by;
            var lx = (qx * c + qy * s) / ax - 0.5, ly = (qy * c - qx * s) / ay - 0.5;
            var x0 = _floor(lx), y0 = _floor(ly), tx = lx - x0, ty = ly - y0, R = 0, G = 0, B = 0, A = 0;
            for (var k = 0; k < 4; k++) {                   // the four neighbours, clear outside
                var xi = x0 + (k & 1), yi = y0 + (k >> 1);
                if (xi < 0 || yi < 0 || xi >= LW || yi >= LH) continue;
                var wt = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty), q = (yi * LW + xi) * 4;
                R += v[q] * wt; G += v[q + 1] * wt; B += v[q + 2] * wt; A += v[q + 3] * wt;
            }
            var t = (j * dw + i) * 4;
            if (A > 0) {
                if (mode === 'alpha') r[t] = r[t + 1] = r[t + 2] = 255;
                else { r[t] = R * 255 / A; r[t + 1] = G * 255 / A; r[t + 2] = B * 255 / A; }
            }
            r[t + 3] = A;
        }
        oc.putImageData(img, 0, 0);
        if (x != null) { out._cx = bw / 2 + fx; out._cy = bh / 2 + fy; }
        if (_kReuse && x != null && pl >= 1 && pl <= 3) _kReuse.mask = out;
        return _tipCacheKeep(key, out);
    }
    /* Clip Studio's picture tip with anti-aliasing off or low: each pixel
     * point-samples the full picture where it lands -- once, or at 2x2 --
     * turned and shrunk in one go. Single dabs of Bumpy's 100x160 picture
     * turned 1 degree (cdp-csp/pbm) at size 32: within 0.8% and 2% of Clip
     * Studio's pixels, only whole levels and quarters. Shrinking first and
     * placing after smoothed it twice.
     * Medium and high are 4x4 (brush-pack's AntiAlias rule); tipShiftY, when
     * set, moves it across apart from along (a ribbon at 4x4, an eighth). */
    function _cspTipMask(src, sz, ang, asp, x, y, n) {
        var mode = _params.tipMode || 'alpha', sh = _params.tipShift || 0, shY = _params.tipShiftY != null ? _params.tipShiftY : sh;
        if (x != null) { x += sh; y += shY; }
        sz = _max(0.25, _round(sz * 16) / 16);
        var sc = sz / _max(src.width, src.height), kx = sc * _min(1, asp), ky = sc / _max(1, asp), st = _params.tipStretch;
        if (st) { kx *= st[0]; ky *= st[1]; }
        var c = _cos(ang), s = _sin(ang), TW = src.width * kx, TH = src.height * ky;
        var bx = _min(0, TW * c, -TH * s, TW * c - TH * s), by = _min(0, TW * s, TH * c, TW * s + TH * c);
        var bw = _max(0, TW * c, -TH * s, TW * c - TH * s) - bx, bh = _max(0, TW * s, TH * c, TW * s + TH * c) - by;
        var fx = x == null ? 0 : _round((((x - bw / 2) % 1) + 1) % 1 * 16) / 16 % 1;
        var fy = x == null ? 0 : _round((((y - bh / 2) % 1) + 1) % 1 * 16) / 16 % 1;
        var rq = _params.ribbonClip ? ((_round((_params.angle || 0) / 90) % 4) + 4) % 4 : -1;
        var key = 'c|' + _tipKey() + '|' + sz + '|' + ang.toFixed(3) + '|' + asp.toFixed(2) + '|' + mode + '|' + n + '|' + sh + ',' + shY + '|' + fx + ',' + fy + (st ? '|' + st : '') + '|' + rq;
        var hit = _customTipSizeCache[key];
        if (hit) return hit;
        var lv = _kritaTipLevel(src, 1), v = lv.v, LW = lv.w, LH = lv.h, nn = n * n;
        // a ribbon's carried pixel (below) can fall past the picture's own box: a clear pixel all round
        var m = rq >= 0 ? 1 : 0, cut = (_params.tipCells || 1) > 1 ? 1 : 0;
        var dw = _max(1, _ceil(fx + bw - 1e-6)) + 2 * m, dh = _max(1, _ceil(fy + bh - 1e-6)) + 2 * m;
        bx -= m; by -= m;
        var out = new OffscreenCanvas(dw, dh), oc = out.getContext('2d'), img = oc.createImageData(dw, dh), r = img.data;
        for (var j = 0; j < dh; j++) for (var i = 0; i < dw; i++) {
            var R = 0, G = 0, B = 0, A = 0;
            for (var k = 0; k < nn; k++) {
                var qx = i + ((k % n) + 0.5) / n - fx + bx, qy = j + (_floor(k / n) + 0.5) / n - fy + by;
                var ux = (qx * c + qy * s) / kx, uy = (qy * c - qx * s) / ky, xi = _floor(ux), yi = _floor(uy);
                /* A ribbon's end ahead is carried a pixel on, as in _getCustomTipMask,
                 * where inked -- and, a whole picture, its other end too (Dashed line's
                 * gaps). A piece of a cut picture runs on into the next piece. */
                if (rq >= 0) {
                    if (rq % 2 === 0 && yi >= 0 && yi < LH && (rq ? ux < 0 && ux >= -1 / kx : ux >= LW && ux < LW + 1 / kx)
                        && _min(v[(yi * LW + (rq ? 0 : LW - 1)) * 4 + 3], cut ? 255 : v[(yi * LW + (rq ? LW - 1 : 0)) * 4 + 3]) >= 64) xi = rq ? 0 : LW - 1;
                    else if (rq % 2 && xi >= 0 && xi < LW && (rq === 1 ? uy < 0 && uy >= -1 / ky : uy >= LH && uy < LH + 1 / ky)
                        && _min(v[((rq === 1 ? 0 : LH - 1) * LW + xi) * 4 + 3], cut ? 255 : v[((rq === 1 ? LH - 1 : 0) * LW + xi) * 4 + 3]) >= 64) yi = rq === 1 ? 0 : LH - 1;
                }
                if (xi < 0 || yi < 0 || xi >= LW || yi >= LH) continue;
                var q = (yi * LW + xi) * 4;
                R += v[q]; G += v[q + 1]; B += v[q + 2]; A += v[q + 3];
            }
            var t = (j * dw + i) * 4;
            if (A > 0) {
                if (mode === 'alpha') r[t] = r[t + 1] = r[t + 2] = 255;
                else { r[t] = R * 255 / A; r[t + 1] = G * 255 / A; r[t + 2] = B * 255 / A; }
            }
            r[t + 3] = A / nn;
        }
        oc.putImageData(img, 0, 0);
        if (x != null) { out._cx = bw / 2 + fx - sh + m; out._cy = bh / 2 + fy - shY + m; }
        return _tipCacheKeep(key, out);
    }
    function _tipKey() {
        var t = _tipCanvas();
        if (!t) return 'none';
        if (!t._tipId) t._tipId = ++_tipSerial;
        return t._tipId;
    }

    /* A shrunk tip. Krita ('area', beyond twofold) averages each pixel's
     * exact footprint. The browser's own shrink dropped faint ink: X2DA Soft
     * Mix's 602px speckle tip at 40px kept 0.036 of its area inked where the
     * tip holds 0.038 and Krita's dab 0.039 (test/krita/probes/dullgbr).
     * GIMP ('halve') halves the tip, 2x2 pixels to one and an odd edge
     * against a clear pixel, while it stays twice the size wanted, then
     * samples that bilinearly at the tip's true scale (kx, ky), not
     * stretched to whole pixels. Lone dabs at 30px, 34 GIMP brushes: 22
     * within 2 levels of GIMP's, where the browser's shrink was off by 46 on
     * SLOS_granules (256px) and by 50 on Vegetation 01 (169x170)
     * (test/gimp/probe.mjs). Still half a pixel astray, off by 25 to 100:
     * Smoke, waves, sphere (79), Manju's Flower (Large), SLOS_dirty-spot;
     * and the 17-20x shrinks of SLOS_smoke-2 and lineline miss. */
    function _shrinkTip(src, w, h, kx, ky) {
        var W = src.width, H = src.height, mode = _params.tipShrink;
        if (mode === 'halve' ? W <= w && H <= h : mode !== 'area' || (W < w * 2 && H < h * 2)) return src;
        var sc = src.getContext ? src : new OffscreenCanvas(W, H);
        if (sc !== src) sc.getContext('2d').drawImage(src, 0, 0);
        if (mode === 'halve') {
            // premultiplied floats: 8-bit rounding at every halving lost SLOS_pentagon 2.5% of its ink
            var hd = sc.getContext('2d').getImageData(0, 0, W, H).data, v = new Float32Array(W * H * 4), n, m = 1;
            for (n = 0; n < v.length; n += 4) {
                var al0 = hd[n + 3] / 255;
                v[n] = hd[n] * al0; v[n + 1] = hd[n + 1] * al0; v[n + 2] = hd[n + 2] * al0; v[n + 3] = hd[n + 3];
            }
            while (W >= w * 2 && H >= h * 2) {
                var W2 = (W + 1) >> 1, H2 = (H + 1) >> 1, v2 = new Float32Array(W2 * H2 * 4);
                for (var yy = 0; yy < H; yy++) for (var xx = 0; xx < W; xx++) {
                    var s0 = (yy * W + xx) * 4, o2 = ((yy >> 1) * W2 + (xx >> 1)) * 4;
                    for (n = 0; n < 4; n++) v2[o2 + n] += v[s0 + n] / 4;
                }
                v = v2; W = W2; H = H2; m *= 2;
            }
            var hc = new OffscreenCanvas(w, h), hx = hc.getContext('2d'), him = hx.createImageData(w, h), hr = him.data;
            var px = new Float64Array(4);
            for (var oy = 0; oy < h; oy++) for (var ox = 0; ox < w; ox++) {
                var fx = (ox + 0.5) / kx / m - 0.5, fy = (oy + 0.5) / ky / m - 0.5;
                var x0 = _floor(fx), y0 = _floor(fy), tx = fx - x0, ty = fy - y0;
                px.fill(0);
                for (var j = 0; j < 4; j++) {                    // the four neighbours, clear outside
                    var xi = x0 + (j & 1), yi = y0 + (j >> 1);
                    if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
                    var wt = ((j & 1) ? tx : 1 - tx) * ((j >> 1) ? ty : 1 - ty), q = (yi * W + xi) * 4;
                    for (n = 0; n < 4; n++) px[n] += v[q + n] * wt;
                }
                var t0 = (oy * w + ox) * 4, al1 = px[3] / 255;
                if (al1 > 0) { hr[t0] = px[0] / al1; hr[t0 + 1] = px[1] / al1; hr[t0 + 2] = px[2] / al1; }
                hr[t0 + 3] = px[3];
            }
            hx.putImageData(him, 0, 0);
            return hc;
        }
        var d = sc.getContext('2d').getImageData(0, 0, W, H).data;
        var sx = W / w, sy = H / h, row = new Float64Array(w * H * 4), x, y, k, i;
        for (y = 0; y < H; y++) for (x = 0; x < w; x++) {       // across: W -> w
            var a0 = x * sx, a1 = a0 + sx, o = (y * w + x) * 4;
            for (i = _floor(a0); i < a1 && i < W; i++) {
                var f = _min(i + 1, a1) - _max(i, a0), q = (y * W + i) * 4, al = d[q + 3] * f;
                row[o] += d[q] * al; row[o + 1] += d[q + 1] * al; row[o + 2] += d[q + 2] * al; row[o + 3] += al;
            }
        }
        var out = new OffscreenCanvas(w, h), oc = out.getContext('2d'), img = oc.createImageData(w, h), r = img.data;
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) {       // down: H -> h
            var b0 = y * sy, b1 = b0 + sy, acc = [0, 0, 0, 0];
            for (i = _floor(b0); i < b1 && i < H; i++) {
                var g = _min(i + 1, b1) - _max(i, b0), p = (i * w + x) * 4;
                for (k = 0; k < 4; k++) acc[k] += row[p + k] * g;
            }
            var t = (y * w + x) * 4;
            if (acc[3] > 0) { r[t] = acc[0] / acc[3]; r[t + 1] = acc[1] / acc[3]; r[t + 2] = acc[2] / acc[3]; }
            r[t + 3] = acc[3] / (sx * sy);
        }
        oc.putImageData(img, 0, 0);
        return out;
    }

    function _getCustomTipMask(sz, angleDeg, aspectRatio, hardness, x, y) {
        if (!_tipCanvas()) return null;
        var asp = aspectRatio || 1;
        if (_params.tipShrink === 'area' && (hardness == null || hardness >= 99))
            return _kritaTipMask(_tipCanvas(), sz, (angleDeg || 0) * _PI / 180, asp, sz <= 64 ? x : null, y);
        if (_params.tipSamples)
            return _cspTipMask(_tipCanvas(), sz, (angleDeg || 0) * _PI / 180, asp, x, y, _params.tipSamples);
        var hard = (hardness != null ? hardness : 100) / 100;
        var mode = _params.tipMode || 'alpha', st = _params.tipStretch;
        var key = _tipKey() + '|' + _round(sz) + '|' + _round(angleDeg || 0) + '|' + asp.toFixed(2) + '|' + _round(hardness || 100) + '|' + mode + '|' + (_params.tipShrink || '') + (st ? '|' + st : '');
        if (_customTipSizeCache[key]) return _customTipSizeCache[key];
        var src = _tipCanvas();
        var s = _max(1, _round(sz));
        var scale = s / _max(src.width, src.height);
        var w = _max(1, _round(src.width * scale));
        var h = _max(1, _round(src.height * scale));
        var kx = scale * _min(1, asp), ky = scale / _max(1, asp);   // the true scale, before rounding
        // Squash, never stretch -- same rule as the generated shapes.
        if (asp >= 1) {
            h = _max(1, _round(h / asp));
        } else {
            w = _max(1, _round(w * asp));
        }
        if (st) { w = _max(1, _round(w * st[0])); h = _max(1, _round(h * st[1])); kx *= st[0]; ky *= st[1]; }

        /* Step 1: create base (unrotated) mask with tip image clipped.
         * A clear pixel all round: the browser filters a half-pixel
         * drawImage only inside the source, and holds its outer edge on
         * whole pixels. Without the margin, a tip inked to its border (a 1px
         * or solid 5px GIMP square) lands on whole pixels. GIMP places the
         * corner at centre − width/2, so an odd tip straddles two pixels. */
        var base = new OffscreenCanvas(w + 2, h + 2);
        var bctx = base.getContext('2d');
        bctx.imageSmoothingQuality = 'high';
        if (_params.tipShrink === 'nearest') bctx.imageSmoothingEnabled = false;   // Clip Studio's anti-aliasing off (see brush-pack)
        bctx.translate(1, 1);
        if (mode === 'alpha') {
            // A cut-out: white everywhere the tip covers, and its own
            // pixels never reach the canvas.
            bctx.fillStyle = '#fff';
            bctx.fillRect(0, 0, w, h);
            bctx.globalCompositeOperation = 'destination-in';
            bctx.drawImage(_shrinkTip(src, w, h, kx, ky), 0, 0, w, h);
        } else {
            // The tip's greys (or its colours) are the point -- keep them.
            bctx.drawImage(_shrinkTip(src, w, h, kx, ky), 0, 0, w, h);
            bctx.globalCompositeOperation = 'destination-in';
        }

        // Step 1b: apply hardness falloff via radial gradient
        if (hard < 0.99) {
            var cx = w / 2, cy = h / 2;
            var mid = hard * 0.8 + 0.1;
            var grad = bctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(cx, cy));
            grad.addColorStop(0, '#fff');
            grad.addColorStop(mid, '#fff');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            bctx.fillStyle = grad;
            bctx.fillRect(0, 0, w, h);
        }
        /* A ribbon's pictures meet end to end, each at its own fraction of
         * a pixel and its length rounded to whole ones, so where two meet
         * each half covers the pixel and the paper shows through: a light
         * seam every link of Thin chain. The end the next picture lands on
         * is carried a pixel on, the pixel inside it repeated (the edge
         * itself is half clear from the shrink), and the next picture is laid
         * over it. Only that end: carried back under the last picture too,
         * Zipper's teeth, lined at both ends, doubled their lines. And only
         * as far as the other end is inked: Dashed line's gaps are its
         * pictures' blank ends, and a dash carried on is longer. */
        var q = ((_round((_params.angle || 0) / 90) % 4) + 4) % 4, vert = q % 2, L = vert ? h : w;
        if (_params.ribbonClip && L >= 3) {
            var W2 = w + 2, H2 = h + 2, rid = bctx.getImageData(0, 0, W2, H2), rd = rid.data, n = vert ? w : h;
            // the end ahead along the stroke: +x at 0, +y turned to +x at 270, the other way at 90 and 180
            var step = (vert ? W2 * 4 : 4) * (q === 0 || q === 3 ? 1 : -1);
            for (var k = 1; k <= n; k++) {
                var s = (vert ? W2 + k : k * W2 + 1) * 4, e = (vert ? L * W2 + k : k * W2 + L) * 4;
                if (step < 0) { var t0 = s; s = e; e = t0; }
                if (_min(rd[s + 3], rd[e + 3]) < 64) continue;   // a seam needs ink at both edges
                var a = _min(rd[s + step + 3], rd[e - step + 3]), p = e - step;   // a pixel in from each end
                if (a > rd[e + 3]) { rd[e] = rd[p]; rd[e + 1] = rd[p + 1]; rd[e + 2] = rd[p + 2]; rd[e + 3] = a; }   // an edge only ever gains
                rd[e + step] = rd[p]; rd[e + step + 1] = rd[p + 1]; rd[e + step + 2] = rd[p + 2]; rd[e + step + 3] = a;
            }
            bctx.putImageData(rid, 0, 0);
        }

        // Step 2: rotate if needed
        var ang = (angleDeg || 0) * _PI / 180;
        var needRot = _abs(ang) > 0.001;
        if (needRot && _abs(ang / (_PI / 2) - _round(ang / (_PI / 2))) < 1e-6) {
            var dst = new OffscreenCanvas(vert ? base.height : base.width, vert ? base.width : base.height), ctx = dst.getContext('2d');
            ctx.translate(dst.width / 2, dst.height / 2);
            ctx.rotate(q * _PI / 2);
            ctx.drawImage(base, -base.width / 2, -base.height / 2);
            return _tipCacheKeep(key, dst);
        }
        if (needRot) {
            var diag = _ceil(_hypot(w, h)) + 2;
            var dst = new OffscreenCanvas(diag, diag);
            var ctx = dst.getContext('2d');
            ctx.translate(diag / 2, diag / 2);
            ctx.rotate(ang);
            ctx.drawImage(base, -base.width / 2, -base.height / 2);
            return _tipCacheKeep(key, dst);
        }

        return _tipCacheKeep(key, base);
    }

    /* ------------------------------------------------------------------ */
    /*  Engine state                                                        */
    /* ------------------------------------------------------------------ */
    var _state = {
        isDrawing: false,
        strokePoints: [],
        lastColor: null,
        lastProcessedIdx: 0,
        paintRaf: null,
        // Suspend checkpoint (Item 4): null when the batch ran whole.
        suspend: null,
        started: false,
        bounds: null
    };

    var _params = {};
    var _paramMeta = [];

    var _customTipCells = null;
    var _customTipRaw = null;
    var _tip2Canvas = null;      // the second tip, already baked to alpha
    var _tipInvert = false;
    var _tipHardness = 100;
    var _pendingLoads = [];
    var _strokeSeed = 0, _pinnedSeed = null;
    // How many dabs into the stroke we are, for the `fade` sensor.
    var _dabIndex = 0;
    var _lockAngle = 0, _fan = null;

    /* The stroke in flight paints with frozen params: getParams() returns the
     * beginStroke snapshot while a stroke is open, so a mid-stroke slider drag
     * changes the NEXT stroke, never the one under the pen. Before, the live
     * passes and the endStroke replay read the same live object at different
     * times, and a drag between them diverged the two silently. Outside a
     * stroke the seam returns the live _params, so every UI read is
     * unaffected. The sites that must stay live (stroke PATH, not rendering)
     * read _params directly: airbrush rate, moveStroke smoothing, the
     * smoothing queries. Fails closed: any site nobody audited is frozen,
     * which is the safe side. */
    var _strokeParams = null;
    function getParams() { return _strokeParams || _params; }

    function _activeSmoothingKey() {
        // Live read: the stroke path follows the hand even mid-stroke; only
        // rendering freezes. No frozen-context caller exists for these helpers.
        var m = _params.smoothingMode || 'none';
        if (m === 'basic') return 'smoothingBasic';
        if (m === 'weighted') return 'smoothingWeighted';
        if (m === 'rope') return 'smoothingRope';
        if (m === 'stabilizer') return 'smoothingStabilizer';
        return null;
    }

    function _activeSmoothingValue() {
        var k = _activeSmoothingKey();
        return k ? (_params[k] || 0) : 0;
    }

    function _updateSmoothingRow() {
        var row = document.querySelector('.pb-row[data-setting="smoothing"]');
        if (!row) return;
        var active = _params.smoothingMode && _params.smoothingMode !== 'none';
        row.classList.toggle('disabled', !active);
        var slider = document.getElementById('pb-smoothing');
        if (slider) slider.disabled = !active;
        // Sync slider value to current mode
        if (active) {
            var v = _activeSmoothingValue();
            var max = parseFloat(slider.max) || 100;
            if (v > max) { var wrap = slider.parentNode; if (wrap) wrap.dataset.overflowVal = v; slider.value = max; }
            else { var wrap = slider.parentNode; if (wrap) delete wrap.dataset.overflowVal; slider.value = v; }
            var valEl = document.getElementById('pb-smoothing-val');
            if (valEl) { valEl.textContent = v; valEl.dataset.value = v; }
            var pct = Math.min(((v - parseFloat(slider.min)) / (max - parseFloat(slider.min))) * 100, 100);
            slider.style.setProperty('--pct', pct + '%');
            var wrap = slider.parentNode;
            if (wrap && wrap.classList && wrap.classList.contains('pb-slider-wrap')) {
                wrap.style.setProperty('--pct', pct + '%');
                wrap.dataset.value = v;
            }
        }
    }

    // Deterministic per-dab RNG: hash (x, y, slot) with the stroke seed
    // so that the same dab position always gets the same "random" value
    // within a single stroke, but different strokes use different seeds.
    function _dabRand(x, y, slot) {
        var ix = _round(x * 10);
        var iy = _round(y * 10);
        var h = (_strokeSeed + ix * 520493 + iy * 372109 + slot * 7919) | 0;
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h = h ^ (h >>> 16);
        return ((h >>> 0) % 100000) / 100000;
    }

    var STORAGE_PREFIX = 'pb-saved-';
    var _TRANSIENT_KEYS = { dynamicsMode: 1, angle: 1 };
    /* Dragging a slider fires on every pointer move, and this used to write
     * the whole brush to localStorage each time — a synchronous disk hop per
     * frame. The settings are snapshotted immediately (cheap) and the write
     * itself waits for the drag to settle.
     *
     * The snapshot is keyed by the brush it belongs to and kept in a map, so
     * a pending write can never land under a brush you have since switched
     * to; and every reader of the store flushes first, so nothing can read
     * back a value that is still sitting in the queue. */
    var _pending = {};
    var _persistTimer = 0;
    var PERSIST_IDLE = 400;

    function _flushParams() {
        if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = 0; }
        for (var k in _pending) {
            if (!_pending.hasOwnProperty(k)) continue;
            try { localStorage.setItem(STORAGE_PREFIX + k, _pending[k]); } catch (e_) {}
        }
        _pending = {};
    }

    /* Read through the queue, never around it: a value still waiting to be
     * written is the current one. Flushing on read instead would work, but
     * it writes entries back out, which resurrects any that were cleared in
     * the meantime. */
    function _readSaved(name) {
        if (_pending.hasOwnProperty(name)) return _pending[name];
        try { return localStorage.getItem(STORAGE_PREFIX + name); } catch (e_) { return null; }
    }

    /* Drop a brush's saved tweaks, queue included. Clearing the store by
     * hand is not enough — a queued write would put them straight back. */
    function _forgetSaved(name) {
        if (name == null) { _pending = {}; return; }
        delete _pending[name];
        try { localStorage.removeItem(STORAGE_PREFIX + name); } catch (e_) {}
    }

    function _persistParams() {
        var keep = {};
        for (var k in _params) {
            if (_params.hasOwnProperty(k) && !_TRANSIENT_KEYS[k]) keep[k] = _params[k];
        }
        _pending[engine._currentPreset] = JSON.stringify(keep);
        // Not reset per call: a long drag still gets written every 400ms.
        if (!_persistTimer) _persistTimer = setTimeout(_flushParams, PERSIST_IDLE);
    }

    // A close or a reload must not eat the last few seconds of tweaking.
    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', _flushParams);
        window.addEventListener('beforeunload', _flushParams);
    }
    function _loadSavedParams(name) {
        try {
            var raw = _readSaved(name);
            if (raw) {
                var saved = JSON.parse(raw);
                for (var k in saved) {
                    if (saved.hasOwnProperty(k) && !_TRANSIENT_KEYS[k]) _params[k] = saved[k];
                }
                if (saved.smoothing !== undefined) {
                    var m = _params.smoothingMode || 'none';
                    var skey = 'smoothing' + m.charAt(0).toUpperCase() + m.slice(1);
                    if (m !== 'none' && m !== 'pixel' && saved[skey] === undefined) _params[skey] = saved.smoothing;
                    delete _params.smoothing;
                }
            }
        } catch (e_) {}
    }
    function _updateRibbonSize() {
        if (app.config && app.config.tool !== 'paintbrush') return;
        var el = document.getElementById('pen-size-input');
        if (el && _params.size != null) el.value = _params.size;
    }

    /* ------------------------------------------------------------------ */
    /*  Public API                                                          */
    /* ------------------------------------------------------------------ */
    var engine = {};

    engine.DEFAULTS = {
        size: 12,
        opacity: 100,
        flow: 100,
        spacing: 20,
        /* Krita's auto spacing: when > 0 the gap is this times the square
         * root of the dab's size, in pixels, and `spacing` is ignored. */
        autoSpacing: 0,
        /* Krita's "isotropic spacing": gap from the tip's longest side in
         * every direction, rather than from its width along the stroke. */
        spacingIsotropic: false,
        spacingWhole: false,  // Krita's generated tip: spaced by its whole-pixel size, see _stepFor
        minStep: 0.5,         // closest two dabs may land, px (Clip Studio: 1)
        hardness: 80,
        hardnessY: null,   // Krita's squares only: the ends' fade when it differs from the sides'
        shape: 'circle',
        // Round-tip profile: 'gauss' is Krita's gauss generator, 'gimp' GIMP's
        // generated brush; anything else Krita's default circle.
        falloff: 'circle',
        angle: 0,
        aspectRatio: 1,
        /* A stamp tip may hold several shapes side by side in one strip --
         * that is what a GIMP .gih is, and it is the whole reason Revoy's
         * chalk does not read as one shape repeated. tipCells says how many
         * are in the strip; tipPick says whether the next dab takes one at
         * random or the next one along, which the .gih itself specifies. */
        tipCells: 1,
        tipPick: 'random',
        tipMirror: false,
        /* What the tip's pixels mean: 'alpha' a cut-out, 'lightness' its
         * greys over the colour, 'color' the picture itself. */
        tipMode: 'alpha',
        /* Which engine paints. 'brush' stamps dabs; 'shape' fills the
         * outline the stroke draws, which is Krita's experiment brush;
         * 'sketch' draws the path as a line sketchWidth wide. */
        engineKind: 'brush',
        shapeWinding: true,
        sketchWidth: 1, sketchWidthSrc: 'none', sketchWidthMin: 0, sketchWidthCurve: 1,
        sketchOffset: 0.3, sketchProb: 1, sketchMagnet: true, sketchDistDensity: false, sketchDistOpacity: false, sketchAA: false,
        /* 'curve' (Krita's curve brush) shares sketchWidth for its line. */
        curveHistory: 30, curveConnect: true, curveQuad: true,
        curvesOpacity: 1, curvesOpacitySrc: 'none', curvesOpacityMin: 0, curvesOpacityCurve: 1,
        sketchWidthSensors: null, sketchWidthCombine: 0, curvesOpacitySensors: null, curvesOpacityCombine: 0,
        /* What a deform does to the pixels it finds, and how hard. */
        deformAction: 'move',
        deformAmount: 30,
        tipFlip: '',
        scatter: 0,
        scatterAxis: 'both',
        sprayEach: false,        // Clip Studio sprays: each particle sized on its own, stops spaced by the plain size
        firstDabAt: 0,           // the first dab this many sizes along the stroke, none at the pen (Clip Studio sprays)
        ribbonClip: false,       // Clip Studio ribbons: the last picture is cut off where the pen stops
        ribbonLens: null,        // ...and its pictures' own lengths, when picked at random (_ribbonLen)
        /* Several dabs at every stop, and where each one lands relative to
         * the cursor -- both measured in the stroke's own frame. */
        dabCount: 1,
        offsetAlong: 0,
        offsetAcross: 0,
        colorRate: 100,
        smudgeLength: 50,
        /* Krita's colour smudge (_smudgeDab): null is our own smudge; 0
         * smears, 1 dulls. smudgeRate is how strongly a dab lays down. */
        smudgeMode: null,
        smudgeFull: false,
        smudgeMerged: false, // Krita's MergedPaint: picks up from the whole picture
        smudgeNew: false,
        smudgeSample: 0,     // Krita's smudge radius, 0..3: how much of the last dab dulling averages    // Krita's new smudge engine (_smudgeDab)
        smudgeSmearAlpha: true,   // Krita's smudge rate switched off: smears at full strength
        mixAlpha: null,      // Clip Studio's density of paint, 0..100; see _smudgeDab
        mixFlat: false,      // ...laid flat at that density, nothing picked up (BrushWaterColor 1)
        textureStroke: null,   // Clip Studio's paper blend (0..7) on the finished stroke, not on each dab
        textureBlend: null,  // Clip Studio's paper blend on each dab, 0..7; see _cspPaper
        textureStress: false, // Clip Studio's emphasised density; see _applyTextureNoise
        mixStretch: 0,       // Clip Studio's colour stretch, 0..100
        hatch: null,         // Krita's hatching brush: see _applyHatch
        pixelSteps: false,   // GIMP's sub-pixel spacing: one dab per pixel; see _stepFor
        grid: null,          // Krita's grid brush: see _gridDab
        kspray: null,        // Krita's spray brush: see _ksprayDab
        tipDensity: 1, tipRandomness: 0,   // a Krita generated tip's: see _noisyMask
        particle: null,      // Krita's particle brush: see _paintParticle
        hairy: null,         // Krita's hairy brush: see _paintHairy
        mypaint: null,       // a MyPaint brush's own settings: see _paintMyPaint
        smudgeRate: 100,
        smudgeRateSrc: 'none', smudgeRateMin: 0, smudgeRateCurve: 1,
        smudgeRadius: 100,
        airbrushRate: 40,
        airbrushMode: false,
        texture: 0,
        textureScale: 4,
        textureType: 'grain',
        sharpness: 0,
        pxFloor: false,   // a 1px sharp line lays each pixel where the pen is (Clip Studio's Dot pen), not the nearest
        sharpSoftness: 0,
        spikes: 2,           // Krita's star-shaped generated tip, see _fold
        sharpnessSrc: 'none', sharpnessMin: 0, sharpnessCurve: 1, sharpnessSensors: null, sharpnessCombine: 0,
        texturePattern: '',
        /* Watercolour edge: the dark ring pooled paint leaves at the ink
         * boundary. edgeWidth is the band in px (CSP Radius), edgeDensity
         * 0-100 its strength (CSP AlphaPower); the pass is off while either
         * is 0. Values come frozen from the stroke params like the texture
         * level does — never read live here (Item 5). */
        edgeWidth: 0,
        edgeDensity: 0,
        edgeAdd: false,   // Clip Studio's measured edge (_applyWaterEdgeAdd) instead of ours
        edgeValue: 0,     // ...and how much it darkens the colour, 0-100 (Clip Studio's edge tone)
        /* Wet blend: one bit of memory per pixel — has this stroke already
         * painted here? Without it every live flush re-lands old dabs, so
         * smudge re-samples its own wet paint and a held stroke visibly
         * drifts; with it only genuinely new coverage reaches the layer and
         * re-compositing is idempotent. Per-stroke: a new stroke paints over
         * a dried one at full strength. Mapped for watercolour imports;
         * default off, so every existing golden stays green. */
        wetBlend: 0,
        /* Lays a wash instead of ink: even at full flow, Clip Studio's
         * watercolour deposits translucent pigment rather than opaque
         * marker. Set by .sut imports alongside wetBlend; default off. */
        watercolor: 0,
        aliased: false,   // Clip Studio's anti-aliasing off; see _applyAliased
        edgeRamp: 0,      // Clip Studio's anti-aliasing: a round dab's rim fades over this many px
        blendMode: 'normal',
        /* A second tip stamped through the first. `dualTip` below is NOT
         * this -- it is a canvas-anchored surface over the whole stroke --
         * and keeps its name because saved presets carry it. */
        tip2Depth: 0,
        tip2Size: 100,
        tip2Angle: 0,
        dualTip: 'none',
        dualScale: 3,
        dualDepth: 70,
        bristleCount: 1,
        bristleLength: 20,
        bristleWidth: 3,
        bristleSpread: 60,
        taperStart: 0,
        taperEnd: 0,
        taperTarget: 'size',
        taperUnit: 'brush',
        dynamicsMode: 'off',

        /* Per-parameter dynamics. sizeSrc/sizeMin and flowSrc/flowMin below
         * are not arbitrary: they reproduce the behaviour that used to be
         * hardcoded — size * (0.5 + pressure * 0.5) and flow * pressure — so
         * every existing preset paints identically and is now editable. */
        hueJitter: 0,
        satJitter: 0,
        valJitter: 0,
        jitterSub: false,        // the jitter shades a colour tip's whites (Clip Studio's sub colour), not the ink
        subMix: 0,               // % each dab goes toward white (Clip Studio's sub colour mix)
        subMixSrc: 'none', subMixMin: 0, subMixCurve: 1, subMixSensors: null, subMixCombine: 0,
        cutByLight: false,       // a cutting second brush takes away as much as its colour is light (Clip Studio mode 2)
        dabMax: false,           // each dab keeps the stronger of it and what is there (Clip Studio's blend by darken)
        colorJitterPer: 'dab',
        colorJitterRange: null,  // Clip Studio: [lo, hi] per hue, sat, value, in units of the dial
        sprayBias: 0,            // Clip Studio: where in its patch a particle lands (_diskR)
        aspectThinsWidth: false, // Clip Studio picture tips: the aspect input narrows the width, not the height
        tipStretch: null,        // [x, y]: Clip Studio's thickness past 100 stretches a picture tip
        spacingByWidth: false,   // Clip Studio picture tips on auto spacing: spaced by the tip's unturned width
        spacingBySize: false,    // Clip Studio's fixed interval: a share of the size, whatever the tip's shape or turn
        sizeSrc: 'pressure',     sizeMin: 50,      sizeCurve: 1,
        flowSrc: 'pressure',     flowMin: 0,       flowCurve: 1,
        /* Krita's per-dab opacity: the level a stroke's ink stops building
         * at, not how much each dab adds. See _alphaDarken. */
        dabOpacitySrc: 'none',   dabOpacityMin: 0, dabOpacityCurve: 1,
        dabOpacityAvg: true,     // Krita's running average caps a falling dab; Clip Studio caps each at its own
        // Krita's several inputs on one option (_kritaInputs); null = just <key>Src.
        angleSensors: null, angleCombine: 0, angleReach: null, sizeSensors: null, sizeCombine: 0, colorRateSensors: null, colorRateCombine: 0, spacingSensors: null, spacingCombine: 0, aspectRatioSensors: null, aspectRatioCombine: 0, textureSensors: null, textureCombine: 0, scatterSensors: null, scatterCombine: 0, smudgeRateSensors: null, smudgeRateCombine: 0, flowSensors: null, flowCombine: 0, dabOpacitySensors: null, dabOpacityCombine: 0,
        /* Krita's texture maths (see _applyKritaTexture). '' keeps our own
         * grain; 'multiply' / 'subtract' are Krita's two alpha modes. */
        tipShrink: '', tipSamples: 0, tipShift: 0, tipShiftY: null, tipPaper: false, textureMode: '', textureNeutral: 0.5, textureBrightness: 0, textureContrast: 1,
        textureInvert: false, textureRotate: 0, textureSoft: false, textureCutoff: 0, textureCutoffLo: 0, textureCutoffHi: 255, textureOffsetX: 0, textureOffsetY: 0,
        /* Krita presets: curves are splines (_splineAt), and a round tip may
         * carry its own falloff curve (Krita's "soft" generator). */
        curveSmooth: false, tipCurve: null,
        /* Krita's masking brush in subtract mode: a second stroke whose
         * alpha comes off this one (see _maskStrokeDab). Sizes are % of the
         * brush, spacing % of the mask dab. */
        speedMax: 3,             // px/ms that reads as full speed
        maskOp: '', maskCells: 1, maskAlong: false, maskSize: 100, maskFlow: 100, maskOpacity: 100, maskSpacing: 10, maskTipCurve: null, maskHardness: 100, maskPicture: false,
        maskScatter: 0, maskSpin: 0, maskScatterSrc: 'none', maskScatterMin: 0, maskScatterCurve: 1,
        maskOpacitySrc: 'none', maskOpacityMin: 0, maskOpacityCurve: 1,
        maskSizeSrc: 'none', maskSizeMin: 0, maskSizeCurve: 1,
        maskFlowSrc: 'none', maskFlowMin: 0, maskFlowCurve: 1,
        hardnessSrc: 'none',     hardnessMin: 0,   hardnessCurve: 1,
        scatterSrc: 'none',      scatterMin: 0,    scatterCurve: 1,
        angleSrc: 'none',        angleRange: 180, angleStrength: null, angleCurve: 1,
        aspectRatioSrc: 'none',  aspectRatioMin: 0, aspectRatioCurve: 1,
        textureSrc: 'none',      textureMin: 0,    textureCurve: 1,
        colorRateSrc: 'none',    colorRateMin: 0,  colorRateCurve: 1,
        spacingSrc: 'none',      spacingMin: 0,    spacingCurve: 1,
        softnessSrc: 'none',     softnessMin: 0,   softnessCurve: 1, softnessStrength: null,
        spacingStrength: null, sizeStrength: null,
        dabEachReport: false,
        dabCountSrc: 'none',     dabCountMin: 0,   dabCountCurve: 1, dabCountSensors: null, dabCountCombine: 0,
        offsetSrc: 'none',       offsetMin: 0,     offsetCurve: 1,
        /* How far the two stroke-position sensors reach: dabs for fade, the
         * way Photoshop counts, and pixels for distance, the way Krita does. */
        fadeSteps: 25,
        distanceLength: 30,
        fadePeriodic: false, distancePeriodic: false,
        angleLocked: false, originAngle: false, fanStep: 0, kPrecision: 5,
        smoothingBasic: 50,
        smoothingWeighted: 100,
        smoothingRope: 100,
        smoothingStabilizer: 30,
        smoothingMode: 'none'
    };

    (function _initParams() {
        for (var k in engine.DEFAULTS) {
            if (engine.DEFAULTS.hasOwnProperty(k)) {
                _params[k] = engine.DEFAULTS[k];
                _paramMeta.push(k);
            }
        }
    })();

    /* The library.
     *
     * Everything under a Krita name is imported from David Revoy's CC-0
     * 2023-01 brush pack, translated by brush-pack.js from the .kpp files
     * themselves rather than eyeballed -- the sizes, spacings and pressure
     * curves here are the ones he set. The handful that are not come from
     * the engine's own bristle and shape code, which has no counterpart in
     * a Krita file to import.
     *
     * Presets that could not be reproduced closely enough were left out
     * rather than shipped as near misses; scripts/README notes which. */
    engine.PRESETS = {

        /* Nudged by hand: at Revoy's numbers this one is a soft 8px tip at
         * 40% flow, and our falloff spreads that so thin the stroke is
         * invisible. Krita also drives its opacity from pressure, which we
         * have no dial for -- the flow and hardness here stand in for it. */
        /* ---- Sketch ------------------------------------------------------------ */
        'Pencil H': { falloff: 'gauss', size: 8, opacity: 100, flow: 40, spacing: 20, hardness: 15, shape: "circle", aspectRatio: 1, angle: 0, scatter: 9, flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.572115,0.266332],[1,0.773869]], angleSrc: "direction", scatterSrc: "pressure", scatterMin: 0 },
        'Mechanical Pencil': { size: 20, opacity: 100, flow: 100, spacing: 2, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/chisel_streaks.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.482412],[1,1]], angleSrc: "direction" },
        'Thin Detail': { falloff: 'gauss', size: 10, opacity: 100, flow: 100, spacing: 20, hardness: 66, shape: "circle", aspectRatio: 1, angle: 0, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.346206],[0.35743,0.524017],[0.759036,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.759036,1]] },
        'Thin Regular': { size: 22, opacity: 100, flow: 100, spacing: 2, hardness: 100, shape: "custom", angle: 180, scatter: 0, _tipUrl: "brushes/chisel_streaks.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.25,0.126637],[0.754237,1]] },
        'Thin Pointy': { size: 16, opacity: 100, flow: 40, spacing: 4, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/bristle.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.122271],[0.414508,0.318777],[0.746114,0.864629],[1,1]] },
        'Thin Textured': { falloff: 'gauss', size: 13, opacity: 100, flow: 100, spacing: 20, hardness: 50, shape: "circle", aspectRatio: 2, angle: 0, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0],[1,1]], flowSrc: "random", flowMin: 0, flowCurve: [[0,0.422111],[0.347032,0.552764],[1,1]] },
        'Thin Hard Edge': { size: 35, opacity: 100, flow: 100, spacing: 7, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/abominable_snowman.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.603015],[0.567839,0.783919],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.509615,0.482412],[0.798077,0.633166]], tipMirror: true },

        /* ---- Paint ------------------------------------------------------------- */
        'Fill Round': { autoSpacing: 0.8, size: 32, opacity: 100, flow: 100, spacing: 20, hardness: 100, shape: "circle", aspectRatio: 1, angle: 0, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0],[0.0845771,0.0301508],[0.487562,0.457286],[0.915423,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.248756,0.130653],[0.562189,1]] },
        'Oval Basic': { size: 40, opacity: 100, flow: 100, spacing: 2, hardness: 89, shape: "circle", aspectRatio: 1.54, angle: 343, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.24498],[1,1]], flowSrc: "pressure", flowMin: 0 },
        'Round Pressure': { falloff: 'gauss', size: 38, opacity: 100, flow: 100, spacing: 6, hardness: 100, shape: "circle", aspectRatio: 1.47, angle: 15, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.0698697],[0.196891,0.144105],[0.689119,0.812227],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.325305,0.288175],[0.727782,0.924817],[1,1]] },
        'Block Glaze': { size: 80, opacity: 100, flow: 100, spacing: 30, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/rock_pitted-fixed.png", tipCells: 7, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.485593],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.136546],[0.192771,0.204819],[0.767068,1]] },
        'Glaze Textured': { autoSpacing: 0.4, size: 60, opacity: 100, flow: 100, spacing: 10, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/deevad-202210C_compact-fix.png", tipCells: 4, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.485593],[1,1]], flowSrc: "pressure", flowMin: 0 },
        'Shape Blocker': { size: 200, opacity: 100, flow: 100, spacing: 30, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/rock_pitted-fixed.png", tipCells: 7, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.485593],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.136546],[0.192771,0.204819],[0.767068,1]] },
        'Textured Block': { size: 110, opacity: 100, flow: 100, spacing: 6, hardness: 100, shape: "custom", angle: 90, scatter: 0, _tipUrl: "brushes/deevad-202210C_compact-fix.png", tipCells: 4, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.58952],[0.271948,0.624454],[0.614333,0.90393],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.677859,0.393891],[1,1]], angleSrc: "tilt", tipMirror: true },
        'Textured Crease': { size: 55, opacity: 100, flow: 100, spacing: 7, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/abominable_snowman.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.603015],[0.567839,0.783919],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.509615,0.482412],[0.798077,0.633166]], tipMirror: true },
        'Bristle Thick': { size: 84, opacity: 100, flow: 100, spacing: 21, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/scratches_rough.png", tipCells: 9, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.485593],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.136546],[0.192771,0.204819],[0.767068,1]] },
        'Bristle Modeling': { size: 55, opacity: 100, flow: 100, spacing: 3, hardness: 100, shape: "custom", angle: 90, scatter: 0, _tipUrl: "brushes/flat-tip-dirty.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.58952],[0.271948,0.624454],[0.614333,0.90393],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.677859,0.393891],[1,1]], angleSrc: "tilt", tipMirror: true },

        /* ---- Bristle ----------------------------------------------------------- */
        'Bristle Glaze': { opacity: 100, flow: 100, spacing: 2, shape: "custom", hardness: 100, size: 24, angle: 180, scatter: 0, blendMode: "multiply", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.25,0.126637],[0.754237,1]], angleSrc: "pressure", _tipUrl: "brushes/bristle_glaze_tip.png" },
        'Rough Rake': { opacity: 100, flow: 100, spacing: 2, shape: "custom", hardness: 100, size: 50, angle: 0, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.14285714285714285,0.040259938829714285],[0.2857142857142857,0.11880787559434423],[0.42857142857142855,0.306998333790883],[0.5714285714285714,0.5317801218292807],[0.7142857142857143,0.7931532397095373],[0.8571428571428571,0.9260588571428571],[1,1]], angleSrc: "pressure", texture: 100, textureScale: 1.58, texturePattern: "brushes/rough_rake_pattern.png", _tipUrl: "brushes/rough_rake_tip.png" },
        'Fan Brush': { size: 26, opacity: 90, flow: 80, spacing: 10, hardness: 50, shape: 'circle', bristleCount: 13, bristleSpread: 120, bristleWidth: 1.4, taperStart: 8, taperEnd: 8 , angleSrc: 'direction' },
        'Dry Brush': { size: 20, opacity: 80, flow: 80, spacing: 12, hardness: 60, shape: 'circle', bristleCount: 8, bristleSpread: 90, bristleWidth: 1.0, texture: 60, textureScale: 2, taperStart: 6, taperEnd: 6 , angleSrc: 'direction' },
        'Oil Round': { size: 20, opacity: 100, flow: 90, spacing: 8, hardness: 55, shape: 'circle', bristleCount: 9, bristleWidth: 4, bristleSpread: 55, texture: 25, textureScale: 3, textureType: 'canvas', sizeMin: 55 , angleSrc: 'direction' },
        'Oil Flat': { size: 26, opacity: 100, flow: 85, spacing: 7, hardness: 60, shape: 'circle', aspectRatio: 3, angleSrc: 'direction', bristleCount: 11, bristleWidth: 3.5, bristleSpread: 100, texture: 30, textureScale: 3, textureType: 'canvas' },
        'Impasto': { size: 30, opacity: 100, flow: 100, spacing: 9, hardness: 70, shape: 'circle', bristleCount: 14, bristleWidth: 5, bristleSpread: 95, texture: 45, textureScale: 4, textureType: 'canvas', sizeMin: 60, taperStart: 5 , angleSrc: 'direction' },
        'Bristle Blender': { size: 28, opacity: 40, flow: 25, spacing: 8, hardness: 25, shape: 'circle', bristleCount: 16, bristleWidth: 3, bristleSpread: 130, flowMin: 10 , angleSrc: 'direction' },

        /* ---- Airbrush ---------------------------------------------------------- */
        'Airbrush': { size: 200, opacity: 100, flow: 100, spacing: 10, hardness: 0, shape: "circle", aspectRatio: 1, angle: 0, scatter: 0, flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.675298,0.578529],[0.859438,1]] },

        /* ---- Texture ----------------------------------------------------------- */
        'Dry Canvas': { autoSpacing: 0.28, opacity: 100, flow: 100, spacing: 7, shape: "custom", hardness: 100, size: 140, angle: 0, scatter: 0, flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.206422,0.248996],[0.715596,0.7751],[1,1]], angleSrc: "pressure", texture: 100, textureScale: 1.39, texturePattern: "brushes/dry_canvas_pattern.png", _tipUrl: "brushes/dry_canvas_tip.png" },
        'Canvas Rub': { opacity: 100, flow: 100, spacing: 3, shape: "custom", hardness: 100, size: 180, angle: 0, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.58952],[0.271948,0.624454],[0.614333,0.90393],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.677859,0.393891],[1,1]], texture: 100, textureScale: 1.42, tipMirror: true, texturePattern: "brushes/dry_canvas_pattern.png", _tipUrl: "brushes/canvas_rub_tip.png" },
        'Feeding Canvas': { autoSpacing: 0.2, opacity: 100, flow: 100, spacing: 5, shape: "custom", hardness: 100, size: 95, angle: 0, scatter: 60, sizeSrc: "random", sizeMin: 0, sizeCurve: [[0,0.436308],[0.323671,0.497487],[1,1]], flowSrc: "random", flowMin: 0, flowCurve: [[0,0],[0.703518,0.432161],[1,1]], angleSrc: "pressure", scatterSrc: "pressure", scatterMin: 0, tipMirror: true, _tipUrl: "brushes/feeding_canvas_tip.png", tipCells: 4, tipPick: "cycle" },
        'Charcoal Rock': { size: 80, opacity: 100, flow: 100, spacing: 12, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/chalk_chisel_random_small.png", tipCells: 4, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.783133],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.552885,0.452261],[0.850962,1]], tipMirror: true },
        'Chaotic Irregular': { size: 115, opacity: 100, flow: 100, spacing: 40, hardness: 100, shape: "custom", angle: 0, scatter: 3, _tipUrl: "brushes/random-debris.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.485593],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.136546],[0.192771,0.204819],[0.767068,1]], angleSrc: "direction", scatterSrc: "random", scatterMin: 0 },
        'Dry Scratch': { size: 90, opacity: 100, flow: 100, spacing: 16, hardness: 100, shape: "custom", angle: 90, scatter: 7, _tipUrl: "brushes/flat-tip-dirty.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.58952],[0.271948,0.624454],[0.614333,0.90393],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.677859,0.393891],[1,1]], angleSrc: "tilt", scatterSrc: "random", scatterMin: 0, tipMirror: true },
        'Sponge': { size: 200, opacity: 100, flow: 100, spacing: 25, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/square_rough_lightgrey.png", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.783133],[1,1]], flowSrc: "pressure", flowMin: 0, angleSrc: "random" },
        'Noise Texture': { size: 200, opacity: 100, flow: 100, spacing: 25, hardness: 100, shape: "custom", angle: 0, scatter: 17, _tipUrl: "brushes/chalk_sparse.png", flowSrc: "random", flowMin: 0, flowCurve: [[0,0],[0.25,0.1],[0.75,0.9],[1,1]], angleSrc: "random", scatterSrc: "pressure", scatterMin: 0, tipMirror: true },
        'Chisel Streaks': { size: 22, opacity: 100, flow: 100, spacing: 2, hardness: 90, shape: 'custom', _tipUrl: 'brushes/chisel_streaks.png', angle: 180, taperStart: 10, taperEnd: 10 },
        'Scribbles': { size: 24, opacity: 100, flow: 100, spacing: 10, hardness: 80, shape: 'custom', _tipUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAYYAAAGGCAYAAAB/gCblAAAACXBIWXMAAAsSAAALEgHS3X78AAAgAElEQVR4AezdV6xtVfk28GXvWFEs/N1WRBQbWJBy6CqIHBDFgh4SoyTYoiYmJibflRd64ZXoBRIhBhAFAaUXD6iIIqIiiiiybdh7r9+3fuPvwzfPcvW9ytz7jJHMM9eeZYy3PO/zvmPMuda50//ttk5t1QLVAtUC1QLVAv+xwJ2rJaoFqgWqBaoFqgWaFqiJoWmN+rlaoFqgWqBaoFMTQwVBtUC1QLVAtcA2FqiJYRtz1D+qBaoFqgWqBWpiqBioFqgWqBaoFtjGAjUxbGOO+ke1QLVAtUC1QE0MFQPVAtUC1QLVAttYoCaGbcxR/6gWqBaoFqgWqImhYqBaoFqgWqBaYBsL1MSwjTnqH9UC1QLVAtUCNTFUDFQLVAtUC1QLbGOBmhi2MUf9o1qgnRaoP2nWTr9sVKnuulEVq3pVC2wUC/z+97/v3H777Z2//e1vnZ122qmzww47dO55z3t27nSnO20UFaseLbPAneqvq7bMI1WcaoEeC/zjH//o3HTTTZ2bb765c9ttt3X++te/dnbcccfOyspKZ/fdd+/svPPONUn02Kz+uTYL1MSwNvvVu6sFFmaBn/3sZyUxfOlLX+r86Ec/6vzhD3/oPPShD+3ssccenV122aXz8Ic/vHO/+91vYfLUgTauBWpi2Li+rZptUAv85S9/6dx4442dq666qiQIS0z3vve9O7vuumvnwAMPLDOIu93tbhtU+6rWIixQE8MirFzHqBaYgwX++Mc/dq6++urOdddd1/nNb37T8YD6AQ94QOc5z3lOZ8899yzLTXMYtna5HVigJobtwMlVxY1rgX/961+d7373u2UGceutt3b+/ve/d/75z392HvWoR3Ve+cpXdu5zn/tsXOWrZnOzQE0MczNt7bhaYHEW+POf/9y55ppryttL3mKSEDyUftzjHlfeZLrXve61OGHqSOveAjUxrHsXVgWqBf7XApLD6upq55Zbbun86le/6vz73/8uJywr7bbbbp363KEiZVwL1MQwrqXqddUC68ACnjN49uANpl//+tcdM4W73vWu5e0lzx/ucpe7rAMtqojLtkD9gtuyPVDHrxaYoQV86e2+971vSQ7XX39957e//W3HTMJ3HmxeaX3IQx5SksUMh61dbTAL1BnDBnNoVadaIBbwXYcLL7ywfDHOsbvf/e7lW9Mvf/nLy7OHXFf31QK9FqiJodci9e9qgQ1kgR//+Med8847r3wxzvcfJIf73//+nb333ruz77771ucOG8jXs1SlJoZZWrP2VS3QQgt4EP3Vr361c8MNN9zxUNqD6IMPPrh838GX42qrFmhaoCaGpjXq52qBDWoBv69kaenaa68tswS/v3TnO9+58+xnP7vz2Mc+tnzeoKpXtaawQP3Z7SmMVm+pFlhvFvBrrBLAYx7zmPIFOEtMkoUf5/OQ2jena6sWiAXqW0mxRN1XC2xwC5gh+ME9S0eSgt9Y8lrrT3/603LMD/B5tbW2aoG6lFQxUC2wnVnAF9+uvPLKMlPwLWkPpL3C+tSnPrXzzGc+s7zuup2ZpKrbY4FaHvQYpP5ZLbDRLWDmsNdee3V+8IMfdH75y1+WL8L5UpzlJD/l7dwDH/jAjW6Gqt8QC9TEMMQ49VS1wEa1gOWkI488siQFP8QnMVhauvTSS0ty2Lx5c+ce97jHRlW/6jXCAnUpaYSB6ulqgY1sAbOEyy67rPOtb32rJAe6ShqHHHJI57nPfW79CY2N7PwhutW3koYYZ9xTfubYzw7UVi2w3ixgychPZZgd+G6D31byv8J973vfKz/Gt970qfLOxgJ1KWkGdvTq3/vf//4SXH6Lxk8dP/7xjy+/ia/6qj9cNgMj1y7mZgEPnH/+85+X/9PBD+/95Cc/Kc8ePJiG30c/+tFzG7t23E4LtCox+GVI65zeue5t+QlhD87a1rzR4X/N+shHPtK55JJLinh0UHk94hGP6Lz0pS8t03K/ke9HzmqrFmiTBbyiuv/++3f8ZMbtt99eHkIrZjyY9v9L+wkNv8xa2/Zjgbv8n25btrpIX1JQoSBXvyf/ne98p/yXhf5HKmTqvNbG35T3up/p+Pe///3ykwNktrSk+vrhD3/Y2bp1a3mo55qHPexhdQaxbMDV8f/LAjCsiPHtaE2ykBx838GswUy4FjX/ZbYNe2DpM4ZvfOMbpUphYf8doQrF1/WRq+ktsD7ykY8sVYsprf+uEIjb2KzTPulJTyqVlv8wRVBJevbWbE8++eRSjfmSkdlEDbQ2enH7lcnzBkugX/va18qX3iSHnXbaqWDWfx/6xCc+cfs1znam+dLfSrr88ss7H/3oRzt/+tOfyhdr/OCX2cGDH/zgjrV7MwTLSxqgnnbaaaXqbpufzjjjjM5FF11UyD7vg0sUkoJXASW6HXfcsego0b3xjW8sSaSNS2Nts22VZ3EWMNO94oorykzXjNesQTz6Px78XLcZb20b3wJLnzGYESB/CcGapuUk71WbLai2JQgPx/JOdVuJFOn7SQE/MfC73/2uzGoys/GfpZiOe3uJbr/4xS86p59+eufoo4/uPOEJT6jfNN34cbZuNIRTP8cNowozWIZbhZvZ/D777FOfN6wbb04v6NKfMSD+6667rqxtWkKSDJCn2YHPWVZShVuO8UNg3vppW3vQgx5UHt6psMgu2amydthhhxJYz3/+80viMIPwYFqy+MxnPlNmE6bv/R64t03HKs/2YQFYhF/xZ3nJyxWWkTxnEK9tLM7MdL7+9a+XmY6kJs48TKdDja3Jcbv0GQOQPe95zysPm80SJAVOtSFYlYrpq1+FNJsAVMkCcNvUvOLnHXAJjNxmC5aMyC6ZeavDMfoBrNmFt5RuvvnmUp05p1qrrVqgDRYwQ1eIIVlLud5M8gwQAUsQCp42NbFjtm6W42c9FGriceeddy4rDjU5TOatpc8YIq5vXpqyqrglgLyFBJSOczZQ3nrrreU35NtCouT0YM402xsdNvIjfyD1VpK/6eXB9G233XbHb9PQRwBec801nV122aUkvTZWY/FR3W8/FoBXGPZyiGVeuDbLtVny9fJE28jWczyykVdsKSAVapar25bI2o6kViQGs4CvfOUrBXymfpyqska6Ng7X7CUJ71y3xdESmqQgiMxyNGAkP1nNbOz9YJnXWTXvigOvasxmVvTlL3+5zBjMMvJsolxc/6kWWJIFxKWiB7Zh1EsU9vCref26TYWMpVuxhzO88ZefEbf3dlVt41ugFYmBExGlyhm5SgCyPXLVnEewHK5i8RsuprXLbuQzkwE8cntQp4oypZUMrM2Smez0Uc34bJYgAdLTfQLPOfq73mu5QF5btcAyLWDWYCnUcwUzdNiEdVj2PSPPxiSPtjSxJY7Ek9gksyVcRSQd6FPbeBZoRWIgqnV5P+aVX3m0hIQ8bZyMQCUI6/IcjTyR8DIrFslMRUU28u66666dpzzlKSUhkFtyUMGQG0jNBCQDn8lNLxvAutb+xhtvLMmDjkC9TP3Gg1C9aiNbQCKARUtHYs7zst13371U4NbvxSB8t6WJscxwxBTZFGx08JyktvEs0JrEQNy8pZMlI8cQo0pFc9xU1n9s7g0E/1/tMp1t9oL4JQaViiUwD9A11QuiB0wVls8SAvklDzMNeiVB+OweD8y+/e1vd77whS+UB+4e9NXkUEy6of7x3AlWFBTwYRbZJoJtGht2PS9DuEjWXtGi+IFbZNwWjCocb7jhhju++2SmYOZuq7PwpleHf176W0kRjwP93pAgMXuwtwEf0NkjzgAQIAF2mc2MYbX7DWeVCaIX3MifLqqrz3/+86Wi8l8nWuNE8qbfzlkO89YHEAu2LD/RS3VD1/PPP798/p//+Z+SMKL7MnWuY6/dAvDyxS9+8Y5nTXCMaH0XxksI/M3/bWni0QNcb95JZIqhYFEMPPnJTy64b4u84kyS9aKKYk3iEoO+n+FtpdpGW6BVMwbLSGYCKilVOJJsVlEcnCUXXwzzBbFlJgdkfuaZZ5blpMxmkLygOeigg0qgCygBb8otwOhkucgP6/luAz0cz3mzELon2Xgo75VWU3jT+qY9Rru3XtFGC8AHgrWMaOaAvBAs36pq4XzZy6S9dpOoPve5zxV5E4f0cBx+yd0WbLKpGbx4sYlBz0IkDLLXNtoCrZkxENUSi6obMWpINA3ozBqA0N61y66qVHYC2JtJfl9GEyDeLPJ63957711mEgDpWrMJG73c5zM9VIuWjwQeklDdIApJT3/68vMExxxzTFnfNV2ubX1bwMwAYZlBXn/99eU1Zm+oXXXVVZ3ddtutfIlTdWuD+WU3MsCjQsVM3pKoF0DMhOHY/xetyEnhluuXIbdCLD9oadlLTGnijN1rG22BVs0YgEpwWGLhTBVVGjKVEDLtfsYznlEe9i4zOSB302oyS2aChdxmPGY+glz1IqmZCZjamln4W0Vj3VNQqWYkDoSvH9dYmqK//sykfB9C4jAjkXhUQpnOx0Z1v34swHfwg/gRLDyYgfIznJhVShiWJRUWbWief1177bUF5woVr63CPpk991PkuMZsSFtWbLKtJV57sSZe8gB9mc8k2+DDcWVoVWIQKKoR7/Qj1CSDKMPJyNLe+U2bNhWCzPll7BE6khbAec9bgpPEkLrAsUf2ZkPAajbgdT+JxJtMmoSn+vJzH0BMT/fYR2f9+sKRe5/2tKe16lXBZdh+o4wJ9ypsfkWmNtUtErP0IXEsi2SbNoZzsiJ+GFWkwDScmtWa3cJlCFmc+rzoxlbiRHEl4SZ+xJhZWm2jLdCqxEBcFbM3cjgU4NKAzKYBm0rbOn7eo0aaKi6VuaShH8cEXPPe9DervQrJRt68861vU1hNopMcTG0Fkr89fDZbIJ9nB1n3zGzIMQEI2PpxjyQJ8KbJdKMjkCOQ2KUMWP9ZlxaAY9hVXNgUE4oLhAsHlkCWQbJNYxqfnGSCXUmBjGY0sJhCR9KAV3jWloFP8dh8XodLxI14keBqG26B1iWGkKifjgA+2T4NwICTYwFvpfvNSxW3684666zyPQhve/j5a8s4qgbfOEaiqcrSR/qcxV6SuvLKK8uUWn+SkUARIGTztwAih2l3/pcsS042a8quSZMATH/1QX4kIUEIvIDdElaePWSdN/fX/fqzAFwjWH5WKMApXGl8rphowzKIOIJPONZgWiO/Aka8Kmx8ltDg3/XOL7Kxo9jCE8a2TCuRsbG4rG24BVqXGEKmXuNUOTUTQ1RBso7L/pu6y0mmtoCIXAHVOXvEedNNN5VqPSQsuFT4qWbS51r2+iI3AAKk5AaEAluQk80XhFRbZCO/gLFZS/Z9DDOIZhNM7vGT4x5QklmCyLKUxGCjny8aSZbGW0Z11pS7fp7eAjDDv/CjujUDhhlkJhbsM7ucfpTBd8KmbVRswLpnDLDmWjjOg3KVut8Es6wE52nwvMhGD6/XsqOYNL4kQc7eWFukXOtlrNYlBkBD3t7yQe6c2kt2IVfO9susvi+Q1/8stfhmpgdhAGxWodrS9OWBXnPJZ1aOAjbBIgGp4CWJJAOB7tkBfeiXCsaMwMwAWJF7b0C6DuGTX4JwHXCzR/Ql/ze/+c3yXEYfxuy116x0rP3M3wLwq7pVCMC5JRBJYbX7MJVvYWsezazkgx/8YJn5evnDrNYMVSIySwjujK0Ag3XFm+acpAar5BaXkhhS1ofzsN2cFZcb5/iPZOVNPzLYJCpyiVM2rm24Bf7/+sXw6xZ6VoUNZPYaYGWPLAFVdWzN3nKRwEG6qhXJQKWlWtlzzz3Lg17nkCXQWnryN7DoZ1YN8L0pZQlMUCFuwYbMvbaKvI1pbMEuSfksgQkwa8iIvV8TUJLlXnvtVV4XBHo2yQwCgQhA/xPewQcfXPQ2bm3rzwJwpBCAYy82iAGE5rg9X/s86wY/yN7/jSKeYNSMXPWvqJGQ/HglYoVHRY3r4dySETxKBjbLqmY68KzfJIdFEnLe8BNz5BP/NonO/y2BR2y19bdA62YMxOQw7/IjWaASDM3mb05GjCppSzFIXxA57jwASAzA63sGqiCglzwc87cKTAKaVSODoFXdCRRLPQGkcwKejBJago+efm/JdXnDqZ88zqt6LCvpVx8An8CUZCydmWkJQAFsTPfVtr4sgHgzC4RVWIFnZOec6nzWTcyJGzEFXxIDfFmO8eq17y/ccsstnac//emlSIFFxRlZYAyOyaYYgn8y5z+nci0saovCozikg73kIKmKfbMIz+18aVQB6bwEWNu2FmhlYuBIv83i7SSVdRIBsk2WBzDXCRZOR/SqGA++VAR+XgPxO+b1UIAHVqDXt1cDkaplJ+CYVVPpIWgBYlzJzbh0cCzPAfKchE508azAF4QsLdFnUDNzkAy9Fqg/ekk2NoEgkQK/ZxeqPAlilvoNkqsen60F4NxsGDEjZLNQhMa3qnHbLBvsZAarbwWTWPIaNjyKI9ds6j7TQ6Tkc53vLyB9BYu/7c0U9CWJmJWLMziHecljUS0vZ0iueEQx5aG5mBRvCsVPfvKTnQsvvLAUVHnFlb70X1QSW5Q9JhlncV6aQCrkahZwyimnFFIDKlsagPkbyQKgChlBqnACgsMPP7xcDpiIVMXlegnEdFfSQKb+nuW3IY3hW6Cf/exnSxLyfEFQR37nbcjakpCKy2fnrfFqgs81g5oKTGI48cQTS/L0m0q+FKU/wSvxedaBSLZs2VKWoOhbE8Qgi7bvOIx6FqbKRcJwhGD51zKh2eUs/anIMpb+4UZRgxzh0nM8RYtYkgTETchT7ClCHDNrSDHiuxe+jwTLcClOyQvXipt5NQVYZtJii0yeKyoI6cSGCJ9edLBnW6sKzaKTrHRTOJr5KDQlRPdsD21hMwZkDnyMb+PAOKKfoTnSFNZ0D1g50PX60ewDRmBTGQsmFQ7SzANn13KoZGMDXMDkYH3Y/Lehs6wOyKKaFzASVmY89mxgBmEztmMJeNfakjjIO0guxxEE2enHFrGJQPRZleQ/EZL88tMb7FFb+y3AvzDMj/zJv2LAJvGnuJmVJojxiiuuKORp1qnA0uAYflTZiPXiiy8uMwGYI6O9GCUf8kfK9qp1z8722GOPQrDkpouGsIfFfrlown/EkARwxhlndM4777yCeysOVgaMheSztEruxAq5JDyFo2cp9NDEKTu4f+vWrZ2zzz67/PKA5CnpiVH9bNS2sMSA8HzJC1EBjAoXcYWk+xkYECUH5GnT4gzOtgkaU1gJgTNlf1Ngx9Lc47qrr766kDAQqLr9KqQAA9RZVgLkWum+DaVqX+2utwIb+YGQLDYViWUwAI18EqDZhWmu/7RHYjAtH1QZug+oEYgH3xKFhGM8Mmim7sa1AT5d3Vdb+y0Ap/AMR/wGH/AAs5Z2kPIgbEyqHcyISSSPDI2JbOHIXkElpsRsljyNAcNii3zkhWek6T5YFouKF7LjgPQJt7NqktEHPvCBMks325E4LbkZ33hiT6GJH8SUXza2zEV2KwvHH3985xWveEXnNa95Ted1r3td2R944IHlwbt7s2TLF5LP5ZdfXpb32N82S+6YlU3W2s9CE0MIUSYGQA5UqWi9a+GAxLnWMAHP1mz6QnoA6JlCfloCKH1hrBd4QKsvfap+VPOphEx5BRzQzKoZ3/INkqeLwIvM9gJIMJEXaatmHKOnpMVGAtUyl+Q5bG3WObKvdJOR4BMEqjaf9Qnc7E1fY+rPvrb2WwDxeMagUkXW9qr5PENC2LNoCBRWkaUEgERhyLo8PElAEpKkoGCDNRgXfzCrgINrWINpy2AKEecULvAJ5+IgBO36tTR9myEoNPWpkZXMdEDYYsBmXPK/9rWvLW9XiQvyizN2FRvuyZKrGYbCcVN3KUzR5XpJUV+KL7Hpt8s8A6KfZTe22ChtYYkBOXICcKjuESEQcRhHAhtCBEwN2QkATgdQ17lXA6iQK2cA4X777VfAK0mY6vU21wEC8HOsvlUaxjbtRZRezZulc+mpv9XurAFg6Ru56eJvYGQLZA18ztPVMQEmiZHbdfaDmvvoIHCBlG4Az+b57O0n9hQwZJtlIhwkVz2+NgvwKf9ZK0dMCBBW+BhZw/oskrz4hDVjqbQRIOxkRiA+U8x5Q8m4iim4g1XP1Mioqla1wzc5xddKN4mYzZJfn2IbBqettNnAjPqCCy4oBK3ANMuxIXTPX2xiRkwZB7lbTiWD8cWlxOK86+gp3iTa5ixMQemFELMMzyrDY+6zWQXBKT67d1iMrg0Ji717YYkBCQIbpzIeAuM8zuEIe07gII50PTCqlgAOWTZbkoS9KsqUFUBV2Bzcr5mV2PQPtEBtAxQOViEA8KyavoElr8nSH7Acj44qNaDS2AEA6cQOwMsGlt8kFg/CyOr+QY0NBS0Qs4dAZVv2tJdkVZvewPAsRnIY1t+gcerxxVkAJhE2nIgDiYCfEbhqFabX2hC4t3OCPZiAVeMqpLIkA49w7HVPn822ESvCV0XrRzzCGhLWxG++cAqHxtC3OJ0Ue94qOumkk8rP36jy2UBCMx474BbykY3sloQUi8YVO8ZmOzK7V4EYOV0vHvpxgHg1m5BgLC3RU7wmjr1erOG0jZAcFpYYkBzwcAKAMypDcxgHcxBjAwxSBH7nXM/o9pyqBUz2NsGCCFUw1jM5q19zrX7zX4iSQ4JApALM/f4m26wakKg4ELJpZxKcfQLdHiDpbdYEmKoz8iJ3YKOTvlSKo4DnWv15dVBQCxoJQqO/AHGc3SUb/c1S51nZrvbzvxbgM4UBf/ETYkOCqmPPGmaRGGDEbBLpmVkqlMRCSNy48OhveySKgBUZ8JP/fRGW9SGRuM7fkojlXfKKcbFMJ5xAl3GacZH9OeecU+QzvoSDN8hGBkWna+hy6KGHdt71rncVzhFrkQf2jYsn7MmHZ8hBLqsPlpz6Nc8oFXl8IZ4kQPr4WzyxhaVqs3FxrE82WI9toYkBYXEiUNiHBBGi6SBHy/6qAtciSIbPGiIHNsHJ4OkTsXutbpBT4xwAMuUEfOPZAxQwqXhU+LMItIxnrz8ABloJIrMGYLfRC7CAFIj9DWyAC4AIwbIQuf1IoP4A2PlhTVIRkBKwewUTXQWAfeztb7Ol9QriYTbYKOfgVmHBV/wGI7Cj6uVfJL6WJo7EWeISRsUp/BnTWBqMwh2cJhYVViFnx6wGrHSXjxQxYty1CjdJDCZT+CV2R8ktNv3sje8ciAuEC8vu9wyGnMawGe/tb397Z/PmzeW8+E6iim5k8PxDPGqOiymEbmPPZqNzEoHx+UHhxuYSDV+wkUSJvy699NLy/1aIdcVmkmCzz7Z/XlhiYAjkx3kcGqM6blpnWplszxEcrzE8UDAygABlQBpgukbgHHnkkQV05cYB/7gnMxV96df9AgF5A7Rtls04xkTuxmAHOtAzOvgMXGZVqaqQv+9z0JuMqh6kYAYlCQow9w9rQGnGQSfVjL71l83zFZv+BcU4fQ4br56bjwWQWQgI+fkbruBBMYOc19L05VvzqYATC2IThmwwArfZw55YNhNAwBLCavd5Gpzbm7UiRliFXX2lsqeLpg/EPKghdT/14k0gZKxotLxMXnhVPOISScjP8L/vfe8rs4H0p6qXPI0vxsmPg8gl9lOwOU4O5C7ZiIM0fXz6058u/UgMrhFPNvckwdGPXPpiR3J6i8nYVg3YcFS8Zsxl7xeaGBgM+XEIwwF3ppKczCGAwFmuATDOdI9EgTT10TRu/uYciUHQjGoAm75MKREwcHOesa0jNscY1d845wENcASfJEAvY9iig34cFzQ2gBRsEolgdH+SGnnZbJzpKrAijry5JcCA1bjGAXYzEQFm5mCs2tplAThBQma1GnLjrywzwgLiWUtzvwJN0SD+xBLswIfxxAcCFj8I2XXGV33DraVLOBOL8JWYlSS2dr8LIK7gV+wrAvUJg4OeCSJgb/6432f3iE9yGkP/jpn9nnDCCZ2XvOQl/4Vd/acghXVjuTfJ1L1kT9MnPqCfRkf/a51+8BPZxa8NhzhPHnHKR2Yekh+7iU3cZbZuDKsarnWu7W2hiQGwOUIDLgZskhDDcxyjAyZDcypgcoh7OdfxbO5naEB80YteVAh+HKO7j1M5Tv+AAhAcq28kPOsmeI1LB/qE8I1DZ83YPuc6FZK3pYBMVeZv560DW/OUICyfjQKbfunnISAdJWBBoK+MCcCOu47+jtfWHgsoLixjwDrMigeEaZkDfkNm00psjVyVi7w9sNUnzJpRIkFYQ8RIDm7EjuIO4cGMeIZFCcv9PksmkoeEYq9v14lziQfObU2siQ+yWDqyxOycWBEDxgl3hD/e8Y53lG8n94sBcUYnSYjdjOs6ulnacpxdHRMXKeBiSzHimSR7WyaySX5edrHhLC9xSNj4RALRh7HYLImADV2jXxsubHNbaGLgYIRv43zG4ahmCyGpajXXMLbpICdxpH4cy55zgMyvj5oijtOMi1jJAtzAbix/6xug+wFtnL4HXUNeYLQX1PoHJq2Z8IyvqiGjoCHXUUcdVcDpGBsBndcCJQrLTePMlIzjfhUeOQSbWQndjQnMnmd4WChIjAPYtbXDAnBj4zN+EQtI0oaMkd1amjfVfFvYkqNKHSlLDGJCEoAPRAuriV9JSXON7wmJG0QMW65F5ojQbALO4ArunUO2jvk7OINDswJJgZ6u810nse9eukoy7vEG31ve8pZSOA3SWxyJEfGmD/YTc8ibTMaii0SnX5trcIq4Ew++o0EOSVncafQTf+Q55JBDyttZdGEHfeEUn11nXHt/e7VV4yuJra1toYmBEQCMgTgnDug1DpLj0NXuFJIjAAQ4BAInAk+aPkJqyE5F7N5RzX0cDcSWrGRzDtS/qkigqZBm3QQK0NBHoAkOsggMYwN8gOq4z6pCzxW8QcR27EHnJEHX0BmRu39Uc62qx7c/AVY1o3eaxgkAACAASURBVA8+IZMk7BVZQaJCE0S1tcMCEjuS4i++QkLiAnaRjfPTNjhDXPoTd2IV1mDObBVGjWdcRIsIzTBVzrBobDEI43CFdMUYjIsxGFaUpPhznT5tCiD4k5Q8U4RRGBeL9oiaXMaWjLx1dPTRRxdiHqaveCCHvfth2Wf9kVv8e04Tm0oGroN9cUp2tjUuW5AVP+mD7uTQD3v42/36cj/iZyOzJPrxGVt67kBXtmhrclh4YkB2jGzTOKqXyIGKgR0HUIA1hXMPYGrAkpYkw4H+7wNOH6ephjjROMbUpz3gmbH0+wb1OP2OuobOAKaS8Zl+AGR8W0CkH/ayqZb22WefEmBkA3Y2EbwqPYnG8xIJzf2jGmADr2SjogN6tgZe5/QLwKvd5Ox3+CPHqH7Xep4vyWKpzLda/RetH/vYxzqXXHJJOcZfrgmZkHV7anwLI/CCVNgBhpAVAhp35tjPZvr0xTEY4H92hhEb0gvBIUF4YHvX+ixexaYloOZxmFJVkwtms+yEfPkSUerP/YqRU089tcSFhGJpU1+SDlzTEwccccQRZXPPqOZ+MrAZe5HFBvOKHv3RzTU2crGD88aEQ3EqmYlBNsAvbCJuzRbo5nrxyAbksmXG7VpJmyx0oI9izOxKn+PE6yg9Z31+4YkBCTOQfTbgbjbHGdOapMqWA/JdBmDl5GYDTMYFMMtJ7hunqQg4FWA4y5jAovJRKfgBMI6cdaO/pKRakYSAU5Cwg8/2wEcv8vnbPQLF2q3kB4CAnMAUYALLeuckMx028OAMiE2N6S0w0vxtNgXEriHHvBr/nXvuueUNEMmOzyU8e7rTz7dd/aBZfiiNfIKSD9sYYPOwlRhgjxQx8MovfIlopm3wtrX7kFj/8CXu4BBBwhey88vB4tM1xkSk7K76hVV/59Vn18CUvtwPx8gT3sSa5APDmnV831EwJtJEyAhbf7nO337LaN999y2xMa6elrgkGveTOcRun9mNvY1c7Cnu4YqdybLaLZC8OIJ7cJLnfjYzJNhjewVNZDbTYU9JiP4Sg74dE+Pu0Te7kWOecTWunZrXLTwxGBywGIahOKPXKIgJqDTXABXnmPI53i8x6IPBffPZ2w/jNk5DPmYbxiEXZ5ktcDaA9Mo3bt/DrmMDgaZCI7cgD9ELDpugQJbs4TNAuk/CUn05pqXCAWhBmum8/sdp7pFMTYklGmMKRnLpWwKzzmpGMs6D7nHG7L3GUoVv3mZMVZpg5g/Jmt58FT/zF5Kx7HDZZZeV5OE6SXEe/uqVd5l/I1jJGgnBAdxIkP7mQzE1TWM3hYr4gkfkhtiMl6LBMUuNzotFGINV9xhXEklBI0khVwWFpOE6S0WI3XXkFXNbu8koz/voQSd9wGXk8LxDTHouABP6G7fBDRshbgUY+fVHPnjx7W1yGNuYNnGAsMlIBk1MsIXrkLpkphB1nYarjMGOuUc//mYD3OR+dvN3ikOYN5Oic1vaUhIDEHE+JzEGRzcbMtJchxAYHnl7EMTJtqYRfXatPee84AUvaHY39LP+AZY8xuF0FQtS8i1Hr3jOY9ZAqDyAAkQBBoR0oB9AZZ+qyTqtwPVgUGAIEsnAMXIjdGTpnWvnVPnjNuNLKL6I5D79sAt5gBnQHfNcAgFMSz795DGOLwV56L3arczMEGBAIpSIJGiBhPhf+MIXlrVl5238TjY+Q5b8yTapovuNt96PhWjgUuzYs5HGXsh8mgYDIUe2F0uIkz3ZGoGF0JEbXDoGd/6GY5+Rv8QtiYhxSR/WzSRWuu/+KzDI7Fqk/KlPfap8hn/j8yl94I4fjaNYo5sEhdTFqqQzTkPo+tAf+REyLGWJKknW+OS2kYPM5IctsQincCg+EDn7POtZz7qDH/iCrmyRAsX1xnQ/LhHX7OwaujmOe6wEiCnx1oa2lMQA2EAUgvG3TQNA2ZszGQ9AJAQgUrU6zphajOhehMAJAIM8GH+c5l5ZXuIxK7GEYUwgBEbO12/GGqfPca/RJ3ACHKACloSUQHOenbQkD8EgUAWImYN7gdgxwE9w+ltyoN+4tjAe3cnED54xIF3Vlr+Ng8BXu+QtaMgSv42rc+91Alb/yAxZ6C9BAweCVEKU7L2WqEITRGaFZjmIidyCTIB555zcltTGJY5emdbD32ym8kU0iBR+EB6swuy0jW8RL7vzvTV1OEJ0iFPs6R++fBZ3xhcvZivOuc+bcvBITn3CjoRvJqjA8BMa/GzGF+LWP/+Lg5AnPd761reWZ2HGwRniY5LkwEZinKywAmc+sxc9xBB9NeOLIXsYh0/ykt+KBRkST44plJKI3SOJkM3erEI8wSGd4JaueIaNjMtGfAbjbOjvNrSlJAaKM4yN4TkrFahABxiNUTkCabvWkgYHcnSae21Aqg/9SQycP24zpQRagONcY8j8AOGXJD30BaR5NCBUgQAMAAGrAElyoBcbhABcJwBNq9kEMAGQrICLHOngs6UZ66AAPkkjk/uAVFI2Jp/wjTHZymuNKj/kzP7TNH36j19OO+20IrdxjOmBuKRnT3bV2cte9rJC/sahnwJAAnO9JMle5EZMAk4iY0t/J5CnkbGt94gNOGUzpAcffI+AEMy0TZ9mbuKIHROP7CvhGksVbTbgHHzyv/H5Q1WcL4iShX+cg+1UzvDNryeffHLxpfjLkhWfiTXxa3wFwetf//pyTJLSj3HMbn3m31H400+Wwuinb1hxv8RALoUFGRy3xyUIm5xe9mBv49CHXq4zU8//ax1761tioJMGe2ylD316RuM5mUTgmD7YkX3Zlu+Mtey2tMTAwIzIIQwW5wpoWzIzhzKg7MypASxAaq7T3M/RHIFUAGfchmhkcdWLcVTtQOgh2Up36ks+Fdm8mkAAXkSuwgI6etAttnGMzmRlA8cFnApM4qI/cLGRPT0QhaQBvAJgkmY8VbdA95kPkrDJoJo3u1L5TTujEhCf+MQnij4SsaW71f9UrMYjuwftvtFOX/rTmRx0tBe4dBZgZBJw5JUYEZlKl3zwtpEaf/M9G4oXsYRQkNYkS4i9NmFTS5UKABs8wifyhCc4Ctb4IP5wHVn8zXeKOMWLWTe8hEzhGnGa7UhqPlsJ4H9kqgiAOXEHtwcccEDRzTl92zK+BEVnug9rfE8v95FTrMEL7kHE5IMhf0tMed5mTLEGk3Slnz5gzjljez2+Ob6+FLLwZwxjmXEp4NhOUsNpZhTs6xqJQ1KAfzLk4f0wneZ9bmmJgYEZHag1BnUMWBjTZ4AEGkZTZSBKBufk3Ode1zrnGAdztqnsJI1DEIm+9ZGqSJIAXo4F7nk1lU+m2cAruOhMngQDYLETWZEkskSCAKaidg4pOC4YBLNz/gbOScmRXa0177nnnoUUzErIw9aCwt6Mgl3I3wyQcexkbVdCJjfSYXc6GoMNJAazBv2ffvrpnY9//OPlgd+VV17Zueiii8qsxdKWn/PgI/YSvHS26c9DTUVCHtyPI9d6uUYSRCqKAHjgDz5TxIidaZrYs+bPfmJA7Gn6R46Ik3+CMdg0Lh+6Bg7gE/GRjV8lAXs+gE/PIPQh1sWzhC5hGJtOcCE5+J/VEDBd9O8cGego4fOrscSAY4OasXw/Q/84wn0SEJ5ITOnbeXLCXnjIzJRsGnu4H/Yd83f+I62MTVZJDvbYSF/u0b+3o+BZwWVcG7zCNxviQ0lFQhS7y2xLSwyUZhTG5TiGZlSO9zdnMyhw+Rt4GC/Z27FmAxzgcB+H+C/7JmmcBBhkytgcBuzGtGyy0q1i5tWMacaDKAUbOWzGj64BP1uogoEngPIfpfiyTQjBfa4ht+BDHtY4c34SPdjT0pJ7JS+kwU+CR/WDnPnJj6W5dpxGPu+868eG1CUu99v0J9Go3pC+5StJyD2IJRWZgIs8/MdWAkyfgpOtfAciP8RGXrjib/6NTceRuW3X0A+R0T/FA32QL92maXDIx8EgP/AHnPG3z0g7NnYdonQffCBqMpAL/hC7PrL2bglSohDviWu+CC7xgSLmzW9+83/p4Bzfk89e0cafcCN2BjVjkd0mDtiNDOJLfGjkdx6P0AlGyGdZKbqIH0lF3KXIyqu3zbEVdfAJm/Qmm6QIy2wilqK7pSXJ1szDeXGgqHUdWZbVlpoYOIyBOcVne4QBaI4zjM05TvSZk+JAxm024HWva4899thyX/P8sM/GEEz5H84AnHNUX4BrDxjzJBLjmWoKvgCdjsa0FzyWuMjJBr5c4y0ioGMbzx4AzPv+bMkeAM6WpqwIQ790nbQhaVNcfVgmQMICSCMf0hYICZRRdspyA3+pyuhmik43VSp5LZHBg37JrMJT6blG/yEvfdCb7SQE52z0T4MJ/ZgVqojNPsw8zErYW6XLTqPkTn9t2NMV0bEDf2twCw9sNE3TDxuwd9b7+QVBOq4atoc/Y8CF+HDM2JaPkJ1zfMgH5EN47AynjhnHGCp/vveZryWSd77znQVn+mw2hIxwETu99aVvfhOf+hjU3GN8WDGmOIK7PFeQKMwq8Av8iUXn6OZ7M87BuMKNXcwU6El/4zcbLNHPWHR13syB7HwmZp2HP/aU6Fa7xSc7iGHJBJaNvay21MTAsQEIA3CsqoDTGVQl5DyDxanOM6bjrgnQ7G2copmuye6TNPdyPucBPoAAJ+dbRpEYgGmeDXGrxlRCACzYUk0HZIBJNuSK8JAbwmQnsq50ZzaIGxG6hu2Ak26CVcXCVpM2/SB+oAVkfQnmbBKGt4Jcg8R7A7s5HnL2jEIQeNhJDxWTIOFjeqgIBSRZEQb/IADye/bgoaTf3t+yZUv5Jqxf1zzssMNKRacvREJWgagy9FAUJozFpgJVIXD++ed3zjrrrCIPvwtI409jo6aO8/5MBz6GFz7gYzpnXX/a8WMX8Qh/8MaecIVg/e0a2BKrZgR8zUf8E9K0JIQcXcOvMAnDyJxtzXAlMTIby7Hjjjuu4BUxi/FmMwZsiA3cwFf6zwzQPYMaO7EXgjZOYsLY4kbfkgNZ4Y5+koAxHPfZuPBIb7NYf5OHvZtYpwt9yQZvdHQN3Eqy/mZXY8Bixo4/xRaucd2y2lITA6U5mDMYKOBgUA2wkA9C4wgbo3EUB7sHyIDNxsAcriFYxp2kcjK+SgIpkEGwqRoEHjAgan3OuwlwOiJ/wARUMggU4CEXMLvGBqAIzvqkdcxUHBKopRR2Y2cJT18r3QA3xiS2aeosCQE6QlBhCUx+YH8ym7EgiUEEZfZjaQjJCFhJl05woB/HETki4Qt/04F+fH7wwQeX/+O7X5JG6oJPwDvPp+wGF+wkebzhDW8ov90PI8aEJWNIsFdccUV5juHZhLGQoCBuY5JASnzAt/Rkf3jl37U0mPMtZMQFLzAGf2KMr80aXWM8OIQx58WqmCUPnHo+KI7cB4t87Jzr9aM65gMy85U3kPgbPvgrRV5TF8f40Xj017c9eSQlvurXyAOrMCUO7G1w6h7xQC7j8jWZjCVGjBU7wwmM0sMx2PVMoBlLZBKPOIPe9vSCSQ1GXe86CcSYbMMWZHHO34rbZeFu6YkBuJLBGYrzGBsRAIig5rA4A0g5NERkr7nXxumMihyBGpH3A1i5qc8/gA7QxuZM4yM4FTCQq5xcM89mHGBRUdNJEAFikqFjgKyxH5nscx0wIlZfvmEv5wRGgsLrcqoXAT4t8NjDr1sGxEiU3f1NVmvAAl/g9dqLX/wGEh1C3vbxpUD3E+rWWvOwTlDR/93vfvfI5MzfxkT0PrMPWdjDGCpa9vFGleU4b7G5BnbILlmwofVwAe648fU1rb3mgRc2JxtShBmyIUfbWpq+/PyDvmFG8jaGTVwiROfsHUOcfAmzEhR82kv+4keC0Y/PMKLZ2+BTIYFcESOswpC+EGivvR1H2q5Bou4hL7/yqZjt18iAW2DIuEkG8Oke4+IdvqcT+c1AXGfW6R6cIDHAFl3oqV+4UoykkVmB5py+2Il8PkucnqHQgS5+2iU2ZWd6KUZw3ko3wQ+bBWW8eeyXnhg4wMZIDM04pmuCWmXgGCdYz/M/NDGqLAuYHOU8Y3KWfjhY4wTXWVPmGNcxuL6GNf3oF4j0Sx5O0h8QI0Qzh3m3kJvZkgAhE53pIRCRgoDwOYHpGkAGJvIDPdAmuNhHv4KJjU1zRy35DNPTWFk2IA/bJ+B8FhwItzc5qMo9RCaj5Sd7MzUPNdnWUpRqiZx0ob9xLDOk6homl7Hhib8QPF0RPDsgAcHNtyF7hCIJWYay7KRJpBKUPswe/Ay0PRub4iPCYG2YLPM8Rxcb+8ZOSIxua2liAFkjLJiBL36FvcQGIvR3ZluKEtdp7pHQ4VXssJXPyNV1+nINW5P71a9+dSF1cSqBOKfRjR97G/30hVz1BcMKC5t7+jU6iWHykpMccABjNg15SwywnELMDHilS9CSredYnrOZMfub3fVppmPsZsNdZgqwrRDCO/BnXPhxv/j1iqqZFjvZR0a8IyYUcMtoS08MlBZgQMZ4nM1RSIVzVP4cKYg5DWjsGd31nOiYPvwNuMgFGN0jwFXeXmlUxXK+c8hmUGADnsDgKOSgT30BsYZQAW2ejS7GtHwCnDaBQ2ZBwV7kjB6A5R5ABC6btXuv2bKn4+zkPiAWgJpEuxYiEbjsws6pkviNz/hGcnaOTyKrn+zgV4GZ4FFdqdgkcgl8pRuMgp6+SEVioN+4zbWwtHXr1qIzvdmQTyULpIe80qeghQuJzOu5ZhGp3NjKJsD9tpUEwQd0ImMS77iyzeo6uIRnBMMHcLkWXzbl4rMs3cEWQmMrY7EhDLEhu8SG7Mcu/hYfYofN2N51MOEa513nGFJ/1ateVc7Btw123QtbfNDb3M8PeIBsSfjwLTHY9zbXwBI78Zk9PEpw9hodFaRwSwY6ikEkjj9SkJJdgjBjTlLoTWDwDdOu1a8xyCA26GQVQnOczjnHPmxMRsnBs7TevsuNc/6nFYkBcDgD0FRojMdxljoYCMgYmbE5CZkgEc5zH6MCC0cyKqchBZmZYwFSAOnfw1FfZNMHEAkkzmg2x0ylEQjyWu0+1wBAnwULp8rm827kQJAASR/60oMc9tFfgAGYIHOdwGAHdkG01tXZDzEKeBtb6UPfKmbXT9uMw1fkMg6g86G/+UxVxF8SlCrLeWOr3oCfvPxHH4TAH2ZKKn1vbvgmOzxM2mBHn/RlI/5HDgLN3+STcMif5jxb0EdyOPDAA8tSgmvILUnZW2byOz/wqko3VrOf9DfPPVnZLWQ7y7HoQ7805MZuiI49kRu/sYcExd/iWKwlDvmM/c1a3afZu8Zxcr/nPe8ps1jj2WAEhkPKYpSevU3cK3bIIlFJQOKV7yTs3kZOVTy/k9c4dMAPIV7y6I98+raHR7pLIPwO37gBH/C9Pl0Tos+4lowspcG4BCaWjSVO2SXPKvHZapdfnCOPczY2oJcihS0W3VqRGDieEziFAxmakx1HwKacpvoAxgHOITwOAxBgE5T2AMfY+uIMSQVhcohgNw5C4LSt3WrSEgPwcYogCwgBjHNDLI7rC3iMybEB1DydRjbkKiEZn45koxuZgJxMZEGygtNntgEutgBovzHkb/qQ33nBDJSWdSzVsdG0jQwSsr0xkIYxyGtDymZu7CyoBJopuaDJspnryU8W1S8s8JeqjM6TNpigP3nYSfBJSOQR+PRW9dE7fm+OAQ9sRi/f0TCtZ1vYQjCKCz+ZIknYEJLr2WARjcx07Cf7WseHOw1ZswNfIKgc518YRF7sq/EdWZJ0FRzsb2aG4DITk4z5wHcVLM9o9LAZS9/8rS+2dKy3iQWFAwwjX9eRz7UKwn424TfcQub4z/UwqRkX2Wvuh0uYcQ0ewhX8L6kYjwzwiY/giPxpZFrtxpa9MfXtWtiHc/GoRWef2UQ8iIuVbkHouRjOkigW3VqRGCjNWLK+qhZxcxygcaKNkREfowGrn7xldNcxOKPakgCsUSMfDrEJWAbevHlzqZCBmRP0bZpoJuEaAOBwzgeCgIYsxgUI003kpfqddwNQhGNc8tAXuQFrdBNcZKGvJEJ+AKSbvVkBUG/atKkAPSDVt3vYXbAKAmNM29wrKG38yGZJzgiFzAiGj5wThPzKxmyLvDPL40tyv+lNbypBMq1MCMZm5iFBwgz7wRHiYgO4MP6gJnjJL1AVKIoCx/QFR6pIekgSquwmjgb12fbj9EO6SA1G6K/AsiFMvvRMSEwqNPiTXd0nlsUk+/Ah+1iik+wRHTtu6b5i7FlSs+kLJtxvPLg3Dh/1Nj61NAxP7kP64lkBAscSUrPpg4ww6jNc6puvxHoa7uFT8jsv7ugEL8Z0XFwpLPQFu+KNjYyb5j6xB1fGS1J1D2xbIope7Gd50niw6Bp9igd6sRMZFtlakxgozUAcxTAMyUgAwrgcaT2cAxALMDAeJwKH8wyZQOUwjjTb0BeQ6QfxeBvFZpwsr9hbt5RwON7yACALAqAIkQA20JFFv4to9BWQgga4EXmAInAd08joC0YIMACUBNgJ4AHS2z4+A7GAYDM2Nz2ObgHsNLrxg375ElmSJVUSohFQHjgLMDKGVFzDd2ThK3Kzvd9JEjBrafrkX/2TxzIVEiELchHE/E2eYY3NYQqxmUGoEhGemYOErT9LC964Ujwk0eqXPuut0cm3xhE7zLAZXfhHEmAHxAUvfMSX9IQztnINkud33wMwS2cb8ZO4bvrWtTAjmajCxbh7xXI/+8Er3ymK9BMS52+x0MSxGOEbx2DPNfxjL77SyE5vMaPhDGOLP3YQb3jBvXSgM1nNKpuForiSpNiLbHRwH/4Kf0QnY1qdkEjpbxzn8B+bhPMi4yL2rUkMyF3wIgiAYhTEy6CqeMaxcRhD+60cDokDHeN013KAdfUAB9BU0gyP9IEcEZjicmicRwZARFwepAINQAMDwgMERKBiBMJUA4twFBnpKlgkBvoADQCSWYACF1CTE1mRPwQMtGzrnECgn35sgMm2wCj4ATegnUY3svIBn5CRTEhZEJHBBvxeC+YziYQ92ZjPkAoC9x+68M9amzH4jb/oFlIgJz1V+gqIZmCPGtO9sCYRW+LUJx/ACn3hxk+FXH755SWZsG+Ia1TfbTlPXjMtmKDbape0xI4YgkM+gi/n+Mw5BMzemnN8y+6pttlHbJuh+8Jhk5T5X/IQh2zob9h0f/O62Mc5z67EgNgwA+QPiYvs4QbXk8lSpuIK9owBj2SEichMJ9fhohC0/smCj+iNR5yjk2Mr3WWfFJNwocG4Z5lsQxfj0BtO2Ep8kFFzjxgmb/R0jXstd5qZkXGRrTWJAWA4IxUlB3EihyEYmyydBMDoqj2g5QSN0RmfIzjPuu+LX/zi0of+GZqDfLZXBZhBCGw/v5AlmRCYvslhIxsytfe3ZMN5QLiIxg4qaIFmTImBDpIo0kXAARPCAjZB6pgg8Fkg0YHemucWAC24VFNmDWwmaRojIJ9Gv5C8RCT5AH0Ckcw2AZcqnj7klKwRBhl9x6AZ3NPIkXvIY0zLhj4rOJC1sSw7Cki2nTQhup69yW1DYkiDP+gLK56HmYkiEfYw/qTjRI9F7vkfLuijiQd4giV+kwjoqUATt/wHk87bu1a8sgMShSkzVuQNz2wfctS/Y2JU3+JXP2IZ7vvFGWwogMS/6hyWxSeZ8QB/NhuS1T9yJ6v7yAYH5EtTYNFNX2Sxp6flYzHiM1n1QUcyusd5sqYZh81whb2xIqviEp9p+vDLypKifukF/1YlzMpcR8ZFttYkBsaVNeNoBoqjGd1nJJ6MKrCAAQARfUDE8f72NollCJk5TuBQQQmsnOYeJKgvABXg1tpdw5ES02q3SpKAAg7XIhh/22TzWZHXKMeTG7kIEnvjIiJBBFzkSkAKDPLR0XX0cQ/5BbwHuq6P3QQAm/OBV3VV6uy9lsaOKh2yCTRyJokbW5OsEmhkIRubCyYk4t5ZNcFvLVffkqEZCwzBiwqfvAJymjETzMjBK8JsR19kYJMct27dWn7SGsb4Yi2Jd1Y2GdWPuFBBw0d0YZ9gykyML53jR5/51Ka5HxY1mPO36+BAImXzZmMT/cMpkkWK9oNmc2ICQZNH038w3uvL1S6ujIsjyClW7HFASNr9fOWchm/I6DiSVsAEs5J+xnM9W+AQje8Rvfv5OkWrGIO/vAxSLu7+49Vy1zvnM37ChbCpgPOcoZl0ct+89q1JDIiLMWV7IAMOIAEqVRbDCKg0zlRxOm/vWkbXch8jqxo4jOOTwY2FUDnLtfo3XgCvb0sLljXIAgxAkJkCELpHlSTpBPiRbZ57MgKhV0Azg3FMgNgjP3aIPQDfejgAI15BQ26k6MEu4gZegBZ8bOVvurIBXWPXafQihz4Riz4FHTlCHj7b4kOzNuvDlpEE4iwbXQQpf7JLiFsChTvLGx4u91aak8iARCQFycG3eRUmdDceLMGeFwEsX8EgXDar1UnGWsS1sLDaJVS4gTHEyqeaYo6v6Ow4P8IKHDYbQmN3P2WS783AoCQKl82mD/6BB01s6d8W8m9eLylIXApH8e46WHY/2W1p4prN9WNPJ+OlKncd+VMsKGbo4lpyuh9nGMNx/tQ/u8CSc3ltlX5micidPvpS0ElWbGZM/TabxEAeOunPXsx4+8ozUXy0qNaaxIDsGFqG5DiGtzGUTVJoBiwHMrIplmADIMlDFeK1OA5zHwICQCDgXOABIgY3IzC9BKImCbmW0xBa/h8GDywFuGDgbODhbBsycc+imsCkl8qCHIKSXPRgQ4CyF4Tsxo4I12Yd1hQeYQEq+1nqoIf76MgWfJBqrTd4J9WTvMgS8M3+NETJP2n8CQMSB9+Q22xs1k3yU7GSA2GRwzHBrpJkMzZis7U0eGA/RCGoM4NgZ/hb7ZKt/xCHvgiHvdmJHdrUyMU28CXe+AxuxBu7JVkgQv6DIbaji704tGwHmxKlexEo3PncGzfu82YXDV/VsAAAIABJREFUG4kz98EkX/WrmCVVNg1/8C1SdS95jZGmAOBvPALjeEEs0KXpbzK4jmyO+6xPRRR/ul6/9ELW/iaHOEliEJOKNzNw/GRPNnZS0InFpmzud9x4bGqTTMngXoUSnCyqtSYxML6kwCmMLeunmkLS/TIswDIugwOPzXqn62VlTudM1T2n6c9nMwfEakwOAHogd74ZmD4bQ8LRJ+chj5Av51uCICsy0dciGvAAJaAjFnKGZMlAL8cEgMBiE/ckSbAxXd0v2Fa6D8+QNvslIJ2TMNyPoN2/lsaO/OsZBvkEclpkNwYbCx5kyucCo+mT3DPt3hiICSnTMVN2dhCsxkYozSJk2rHclwTL9goWJGLNHuaQjZmK9WV7JGpzz1rtvRaZe+/lO7Mc2NfEG/zRBZnBjVgQF3xpS3zlWvGD2PTlPLITN/1iRoWNTPkiZOq+fsQIGxlfv/Aq6YhnY5IxY/C3fmHcHh4VIYnt6A2b+oFT+MNHNv3yjX70ywZw4rhCC5GHQ/g2RSddyUAH8hrbG224KU2/fipGkvPZ/Umg5INJGFpUa01i4FxvA1nPR3bJ0MCgihsWqAzOmAiPswHEHiF6q8I3WDlN0w+HAAQwA4CxVXDAxNm9Td+AgbTMDjg34LFXuQsQ1wEMOWZJZr3y+NtY9PaKrQASiMgktgBoSVCCVBk5b9bjeMjWXstzEoHNHoAL4OwoCNiM/mvVKQHKN5GZDMbR7MlpHBjwoFjCbVZW5cI1/iPQ6Cpg+Y++SICuZhLGVlTw96xaEpKlRz5RWcMfnNsUGFu7zyDEQDAa/8xKhmn7gWeJAc7ZyKybr9hNgtN8FkdJCI4FkwgOLhVn9GZ3/aiu9d3bgkHXarDuXoXCoIRJNj6FreCMfZE2f2swZ1zjG0OzF/diJc0YZhyJAX/TU7+wedJJJ5XZgLV/S4KSF6y4LvGH4MkEV/RwL7/ShZxmAP5Ocy/uU6iwo+RlLPfqXzExz/97PnJk35rEwAjImhEYFdA4RyXr87BlBQHkfzADQN9OFXjIX5YFCm8dcVgah3MQUrC5RuIAZH0ESLne3jlAIAswAaokYmyg4Tjr9tY79Z3qotnHrD8DlgrTO/NkALgEZ2woCASI4xIl2Va7SRAR0UmAW45a6c4anHO9JACo7CRwrXEiSjZ0fNqmb3ZmN7Y0fmTgf8Gjf3vyIiCBbPbg+KyI0lgKDn3zt8qVTKo+uqve81tJ0+o66D42hk+YNEMhCxJAIPzHR5ZS6ApD7D8rvQfJNOo4GcUJbPOhOE2sigPnECP5+ZMuGmz5jKwRnL9zvTjq9/DZfeIvffE7G5ABHvmrt+nTTJQ/4R6HsDMMIX2bZkzJwczHOXYlr/PNfh1znZjSp3Hhw6xS4aeyZwcvMCB/BZfZtTclXSOBud8xsmQs2KcbmygwU6xGH8nJmGSnv77EXGLUl+J678m9s963JjGomhgzxMBRSA/g8m7yMOVVzshZUAOwewW5ZwSA1Vv9qUIB2rgcx1mAAxRAAGzNxlmOcRyHuRdgjKMhToTmuKkwPTi1Cbhmf7P4bAxr1wJPcgAg8gsiyYtO9HPecbJKEivdJIAEBYZzwE1uBGyJRdLw/EXlTG9gVkmr3uk+bVMRSfaCyp6cZLaxHXkERKo5gYJQPMTjL0HRTPDTyuG+YKKZINkHSbApLNLXdbNu9KabceATTmErJGIvGZsxsb8EMSu9p9WF/ZGvWOEviYFv+FJiI2OWhmAuODQefeHLPfBn7xrfNXKut9FZo7O45RO+F5eJt+Y94kD/+rRJDjDkM3njR/25Vl+wFrnSf/p0Df+7Hyfo215fkrrkHYzSJ2SPf1y7//77F9vkb33xr8244lLhgT+ajV3FneM2sQYb9mxtlrHdJQYGbhJRqn4E5iHwsABlbDOLOFMFLLg4RmVqemYKj3yazaxC9QDYCInDOMB1wKLfZgMYrzsCif6B1EzGe/CWu8iJaABfcrC5Brj16f5ZN/0K2qyZA6agBEL62DT2BWx79pFsgU+wqVz1Y2ovkSFtdmA3FRO7rnZnGTa6Nqfdk+jjp6sFFT+TQZNoBUTIkhwhCzLEP5YE+YOsIY5Jxu53Ld/kpQIkAC/GJg/fqfzMyiJPvz7Wcgwe2JLdVc9sm8TJh3DpvXn+jRyz0n1SuYNf+LFJCHDNNvSAO7rAHWJGZuzoHAzau1bFzdbOHX300QPFcJ6/jZt+YbO3wEsHruNL9jGWJIUzYN5SqqTAp4ogdiWvhMHHYr1pV3KKbz7AEcalD93ETPDvs7EkRVgiA7m9Kq+QsvymD821+nGePbwpmH6igz3b0DH3uYbs7lNEbHeJAQmpKC0fII8AiVE4x9/DmrU+yUEFDLgaY3KyPhmVc5stQEV4ApIMKgFkqCHNJmAAjYxmJa41lQQgsiEVD5QAUl/OmblY4vItbc8gBLcNgGbZgI6dgJ78CJVMgMwG9nR3jSZw2dh3FZyjr+tUqaodSW6lO6tASEAK9Pqjt4QiWY/yRz/9suTFdiojdhAAbChYIp9xHUcMjvvsHNtLyoKZTPy3lmZ8/ZDFOMhOYCITNmRPiV9Az7PRk39Uh3m1VzKmK1/BkVdpbUhIPKxV92n0QaBm5pK5KplfyMGGbIZo+Rhm2JZePvOdv+GUfjbv8UuGg5p+kbe9e/WhP/t+2HOdJEo2PhQHsM2v4jiJAtbwA/sqThSOrrPs3Gx8L4ZhTqGXMfnJWM7RzXF2sTQJl84rQtkDzvlPQnIdm7EVDjA7p0+zwZxvy9PBObKKhfjbGO5dRGvFUhLnMZ7qEBgYhJEQOsPK+JwxrHG0xKDylxz0ofkboXkjRFD1NkBjbNe41rg2GV9SMHPJ2PYyuIpDUJBXAwJyOuYBkcoPWJy3IRy6CGwO52wgSb+9Mk36t37IabYiKZGDLgIKeI2PdGyqU3Zwngx0QUAqOXIJFp89qwFidrMeDsheN0xfw2Zwg+Q//fTTS5AluAWsoCSnYBY85KIP+yUpSFpwIdgF7Go3kSNsQZiAHTTmqOPICqFI7HQzmwkJwdHKfxJks0AY1ee05+nNNxI2cqEzXCEKJANDiMxbcpIVu80KQ+PIzA+Wk8QqzCNYGCKLShbu+AjGycue/CkW3es4n/Pr4YcfXghv0Lj0orv7bXTl6/im9z54hAs+I4cxYB++3MOPfMuG5OBPtpYwLOn1Jn/36sOYdOIDeud6yYJOjkdO1xnfrFaxJfbJrYkpOrEZe1gW6m3uV0iKR3Ep+bAzbnOfvvh+Ea01iQGhMTTjIQUOQNgqVGAa1TjWQzsO1w8jI3HAYGjkBhz9GnJwzh5ogAwgOBZZcmqaALCswVE+G88YAgRwVEEqIq+Wee4gywtwQaJJXr5ZTCbkZpxZBDfQqPS9Oy0wEqT6twEaWdiGrXz2sFxLUAlABJkAPvnkk8tsh74euEmYkoX+9IOYx23k8XBOH2YrNnqznWpNIJKD3/QveJz3N1nJJFBdL3mZ3bA/W7t+2uZePjajM4bx+MtY/O4BYr/14GnHG+c+uJXEzXLhn0+QDxuxiwID8arQHVuL/uPI4xr2UM2yvVmBeIWXkCICQ7wKCeToODtqfA8vrrEXV77sphIe1OgEs+KMT3I/jNC5X3ONe8gq3vyt4DAjVM2712fjiz/n2ROOejlGXMM6GW34gb19zqwBFt1HVn3oX9/i2rIWe7CFY7jMva5H7gq03mZMPGJcstFBUqOPRMOelqAW0VqRGJAF8AOADMzIgoPBLVsw1KjGKQxpz8D6lGA4EZD0oZIf1IyHCMggQQjMfH+Bc5L5kRWnI1XBKRkAl0Ze8ksOPusHcan+Am732MxQTFPJDCwAsdZmPPqb7QATIJGb/OxhLElBUNODjGTxGVELGsFuD4hAaOkAuFVI+lVdqxqtn5pBDArSXl2M4flM5GIn4+tb8JPNMpY9grbxI79oSBIW6MhP5ERSbB2s9I457t9sIml5VZQ8bMIfIQxyqirJs6hmTJiVNOnNZzDDVnxhdqjIgEPXIB42nkdDUsidnSVRvhED8GULttiHX5znR/dp9s7Z00ul7udq2H1Y4w8Vvg1exBk895J4+tC3ZTcYs8EKDmAXREx+8pFZX4jd34pQejWbexI/ZIdzW/jlwx/+cCka+MSYriEXnfQnIbFBKn5j0R+++FXy6G3GZGfX4h92wh0KPjFMxn739fYzi79bkRgYT1bVGBOZMw5jAPw4pAkUAkUAAYB7OYgTBDgA5M2hQYbjdIABQuRALoHosz4jhz59eUVzbUArYFWy1k+BUgNkOiAwU0xgU624Fhm73t8A4VrjrCXAV7qVjb5Xu9NqzXjkZVNVnP7pBaDGEUAAyzaASA6BDvD5bwtVYa5xH7sKfDYBfuPpe1TTr3vYWN/8Ta7YlSzswxYqM4mUzwScRqe8lcG2Eq49f6eQINc0zdgCWuIzLp8b294mEfJf7zr0NGNNeg+d+MVyKjvzBbyxvaIEeXp7yTXIZFobDJOLrz70oQ+VCpjN+YfvxCj8wIvYcE78iGEysiX8wQ6/28TCCSecUH5uZdiYziFCfWj2MEtvcQ2HvQ1xwxjf2chlryUhWZbxmc/ZUz/8CkPNBq/sK2ZgjA50dR+9xa4Yc95eISWWYdus3Q9ABtvuM1tgM/aw7MuG/RrbuSYFF7nYTXHgM/vNw8e9srQiMXAAQ9sjAIZAQhojhhx6he/9mwM4ChjMQBAtR+qP46ybA++g5lrn3ecem88cBQwck2uAAVCdB0AyugaRcKLZBgCmOa/SRTCmtZzrfpvqb2v3y03WFIFVlTOuzuk/e/0CoKWfJCx7cgIqOyCQVED2KjIBl0BBuoIFWZJXMAl4fduzi2vNeFQzqulRYGU3AWY8etKbn8ij0Te2MVMRiIhhpZt46OM8P1iikzzMFuIXU3bEwb7T2k3g8i8bGZfvBKGxYTGVGz0W3cgCl6pFNmKbJGt2J58lL58TL03srUVeMWXpiI2NaWZlaZH/ETR7wIOKHP7hg5/hjU8QLLns+UuSYedNmzaNFAs++Jm++oBJYwanvR2Qxbiuh13j2Rtb40t6sBeeIK97+Bl2mo39xAWdXc8O9KGfPn1e7XKA4+Lf38EeHc1wxZl+yZyYojss6aNfk1zMQNiQrHSQdOnFHrjB53m3ViQGZMqwAQBDcACjCtgcH2UM4AFczgYef3MEAEg63hry97AGEMjBmD4Dhb8BwDEVBsekmjEG2RGez8ZWtViXBsTeJogQqR+os3ae5RtOBwZLNOyhTUt07kO+gCUp0AF42dRnyTcAc61E5qGmasc9gOkaFbRq1Hqw6+kpyOhAT/o6b1150PQ++rtPgnFPlmwcI1/sJjlZujrggAPKcQkgSQkpCDRBJqlYQuFTctsjLzZ0XoDqc5JGH7iDH/2wCz/zkSRPDlV7gn+Svmd1rbHFAxJWWcJZCiF+tbzj4TyMDyLPSWVRYPk/JcQAe4gBMogpdkKe/IhA4cWxJNPENNva3G/PpmKxX9XflA/O4FHfNn2LF7HGz/2aOFWwuBaeyAK79shYPynIyCIunIOv3iYe2FgsJI7YGTbEv75gJkkDX+gTbi1biwlysA9/uJbsZneDcMSHeejMnsaXHPmBb/NSSK+ss/576YmBUZEL4zMoMHAkw8myHDBukLvXGjhnI1egzb1AAYiDpnBNw3IwJwIGcOkjjuRgANef5SQZXb/GAy7yOgYYKpFBTX+IznUCReUMfPpRNSAoZKS6MF70GNRf8zj5VZapaJwDTk0/EoRN4Jqt2LMdsgFcMggePjGTA0zvnAOmwNAXolCdGktioTeyGNQEjCBxjf75iF4JTOPrEwZMw8nPRu5hB35AEvyL+JA1kpJMBY0qjd3OP//8Qhpsqv9JGp/zAfIxHt3tHSOnIB3nDblJxpzmWthjH7M1PmIffmFX9tjanX3CngJkFPkOG19selECVvQNB8Yxe7EhVDFqaYifUojwoRjQjO8z3MEZ//MXO8LPqKYvPjCue2ECTpArTPU2+JUsyW7jOzZiFzaBM33ZyMSv8ESP3gYHNgmA/vpja/3AF+zzBSzqQ8KUNPTrZZcUX/4ml7HZMkVH73j+ZmNLUYk/usAxeS2Ve643jFf69TnNsaUnBgZXoTI4YDEg53M6ogUsDmHcUY2jVNwc6R5GTV8MDWQcNg5hGA/YkY0MnuUPoHaOczlev5IFACIqQON8JGtW0A+80YO8ITmvg0paZDeu/hCTL66xiUCkyziy6x8IgUwFkkAhM5sicrZgW8FqLGOSG8GqSFU7zgt+unhugojc51pyup5cKjTXppKMfs29ZCLIkITrJUL32CQVYHc/EvBsA2mQwZtmZKKPsVxr/EMPPbRUne5LRcZOPisIvM3DtsPs35Qvn/UHQ/yqL6QSLJmdmAmy47IbkkT8SAku+JA/+JO8lpbMopxHXrA2aVP4+A4OUlW9wqPkyabG4kfPffy8g6UTLw94TsSGYgFWyOKzZgkVxmHYLBQORzXXwp/x+MPYdByENedXu0s8wad4ZCe4hw+xSj42gye4cq7fDMQ4Ysje+GTRn2sVdYo3s1XcBXPGsdQpTvCFa20wL5mJJeP6PIjPjOV6cSEZJC71A5Nm5+Sdd1t6YuD0TNcQGABLFo57nxuoBxmxn3EEDABxAmDmb4ABbCDW5zgNAXAIWQQHsCE0VTbS4iDE67zAtAGMKt+4zgPBqEY28qpCJBMAS5JhG8lJgCJsoAZQ9wxrzktcqabJRk62TbVkLzDsk3x8Bk42RNL0ZAcBgqwRpcBjF4Rtbywy0j2zvV7ZEMR73/veO151VASQhT2NJ0j1zw55PZRMdDVLMBZbCw62JYMgsyThVVOy6gd+2IivkJhrXTcuMRoz/ox8dGEnurKPpKPfZTc6SZTiZKX7LAZmbGS1ISyzPNU5W0wSR3Tlc/4IIcIyG4tT8QAbxx9/fLGv8dgdMUoQxx57bCFN/tIQKx/ZYIvfxSICHNaMTQ5+oS8Z4E3SJ1u/Rk/+53fxgwfsLWGS3QbH+oBXNoS/3gazxiY7gsYb9HSPGHXMxlbijE5JoBKDJKSYyAwUnsji/kH4CU7ZMpwgmYpBMWCZ1bl5t6UnBkYDHs7mHFUEgzCE6bLjAbzPoxon+hljTgiYOFHfnOcLaP1AMKhfZAdoqRjIZgOQlW4waipM1wCSwAmhcCCyH7fpg2wqK0HDLk1iF+TADXACin7DGiCTX1JAxEAn0FQkZKWHoBAg9BNICERQCXrXAz2dVEbA7n9Vo58+yAfoCXj/0bvKsV9Fw3cqWMQqePSlX3LoS5/GM11G9pYKNH0JJMHsuiQ4pCchIGnXq+L0zV6uUwR4PZZv4GjcYsCYbGY8vmAH9mE3pCTQTefhsy0NFlTQbMUfEpuYQT7sKsbglU1hbFRz7ymnnFKSCp/wHTuYDcA8ooITS0jD7ACfMGtMBJoYgTVJnt/E5rDmHku6SBcGycK/fAG7/Rr5YY3uyBTO6Q4D9HFcYuNjOCGPhNbb2A+myO4acSep2bNDcMYedIUXY4gHOBRPfBHeElfsAbP66NdcD9vwZmNnsuNFtiLnqGTar99Jjy09MZiCMSRjcASgIYKs2zEq8uBsTh3VXA9I7kEiwKR/zuUoDlTRj9v0l0TAUfr0tz4FHCBs7a7phjhVIo4Zw7VIxd+TNHpyvrdQBKRqB6iA2fTdG0fWfgP2QdWHMfXjC1FIXHABOtvQRdAhEvrkTSl9Ihm6SWpsBsRA71oEfMwxxxRSFpzupV9sxI9+BbLXV+yIDNIkKk3i4RtJAugRmKRIBk0/CA9O6O56NiaToBGcKmZVMfsILLrBi76QAN3IF51Lx0P+oTN5ja1/trc84JXe/fbbr/RNZ9e1pZFFIcJ/SAwhshO7IkDLtT5LevBCv0FN/MAMrPCZZ4DsoB/YgaMjjjiis/KfwmhQP+SBVbIYj1xiG4bIINGME4tJLGTgc3jhy37PBcgC864xps/0hktyuM+4xodfdiMTjPQ29ytiYM51MOcefSJq+FCoif3MTMSJ83BnDDMO98IjOdwDQ471a2xMVtfCMpvlXvFn1WBUQdiv30mPLTUxAJmMzYkMQGHGZACEmCkTBzGo/aiGDFSuSAKQkLO+AAqgOc1zhnH6ylj6BB57hADYEhiQqBZUJ4iOM41nAwjr48CLVKZpbAGwSA9JI3dgCVl5vx4AESf9BFBvA0D9sAeyz/2phASKKoicAMgnSJQOCJHd3SfBkYGvkIt++cn4qiPn2UV/q91lHtfop9kuu+yyEkDGI49r4we2Nb4xV7qE0/wiDxksM9kbV6DSQz/Iz8M61aeAF5jGd1zTvyrfLFICgSn9jGr8zK/kojfchHD51cxoEQE6Ss7mef5XRbNVZIMVtmIHJIYcVZ7O97MDDJ955plFV5/ZEX74kv5I0HbYYYcNrHojE9vBk0QDT5GDLM7p27Mrth3W3Icsc7/Yg3f7QQRrRmr2iWjhk00kzZAs3fl1pYs1e/7ubeQkO5zrw71khVucAvMa2/gsNsgIf+4RUyl0yZv4gtVBcgdj5POZDIlrNsAleGfebamJQYBzYKphRgBYhm4Si+OMaj+quUZlyTn6R9iqewTGoByNaDlsksZR+kBu1ryRRoIOKOggkIwFOHRAQkgVYfl7mmZcsqqmrb0DpEBF7PRT0UgQxnaOju5pNmRBPvILRsEakCJX8qrIXQew7md/VZDz9BPYSSYqSG8OuY697QWgPumPiL1tJVE0ZXEfe7hG38ghvnWdBGdPDro2m4CUhL2uZ7/SDWibhM0PcOOcSk5yEEQSqU1jKzrox2ykKVdznHwWjDYJDJmyH3/qW5XreIqF3NOWPawhJfLxWXyInJA6zCBDuOqNKfbiSziAF5t+2Iu/EN6JJ564TeIepjfsnH322WUc97MpXxmXj8wO4WRYcw+Zka6NbPyp70FLMo7jAPrDGp0Ua2ZAkoB4gQfH2AeW+jWFK8zCAKLWHxtJMvDAnjiGLPpE3Oxsoy/7sTMdXY974HdQM1NTxEhExmYj8U5m4+uf/ebdlpoYKM7hnEZpAAy5yPCCOAHMecDUC+R+BtIPAuQcANLcz7mAYalDYEzakAJSi8OQBdCQHZFyPJmNxXkIS+Kzxj1qLXWULOxgfEtsKg66IQBBIlhTyQEsQAJTmsBiNwBmD7ZxLMfJqtrRyKwv1+sDsCUSfxtLEtFUn543sDVZXCs49OVv3zOw9NJMiKvdQGU//enXdbb42BsX/EIH67C9jV7w4ZVUiVkyow+bNKf5+pBkjCOQjWUM/veQXKCSmz7DGl+afZLZBjvG528FhgRB/jY2tpJg6c5XcMqv/MMn7EL2JlbMqC+44ILiA1hzjh3hmr0QKdtZRmria5j+ChXPeSRSNhTr+uUvhYxj4mOYL+CU7MZ3vbETD/oY1OCdr2BE//SFX/eTAdna2Anm+jXjwQ17iYH4m12QPTzBouddZpKInB2jD1unQJKgjCVpD2p8ZdnPmOKF3yQvY4gpReYgWQf1Oc3xpSYGjgZcGZjhOdsxzguRCs40QRkSybF+e9d41Y4jAUAmtyST5QjTV46dpnFqZiEAl1kD2YCU4wWPsSQLZCmoMvY0YzbvATjBbQahKhdgdBVwAGlZBZDoK6DYkh3IpgoBOGBnEwnMxvYqbX4AZOCXPNgRufqMKOjrmH4lR8So+jnvvPOK3xwXaLEtGf0dn+lffwITsbKZe8jHjps2bSpVv3v4P/c19edPOglCculHAEnA/kMfQZPkYs9WxmE3Yxlf4CWRJ4CbY+Szc4hNlepe9mMDBYG9YLU8NS5Jpt9F7cnMjjBplivWYITvzOrOPffc4j8zKLqeeuqphcQROVuaeUsKEi+7spm3jZrJfpQu8a1K2OdgLhU7G3ohxDiDmvvYHm4VMGSFjSZP9N7rHJK2ae6DhfAJbLhG3Dju734t+CE37PnbZ/ZgN9hQMDiWWbkkJgbhEhfo27ViyDMC+0FNseMBNZ3JJi7I7G9JwgwLl8y7LTUxMCaFBS7yRKKMD3gxHuLTXOd61/YjjKahOBy5IRiOBAr3SzoM7W/VqWOTNmMHEPoSbGTSN3LSt8+ATHaBCdCcGVBOOma/6wU9HZEwYhLwQCVpmYX52YKt3YfigCkpuIZ9kSkbCxj6+0wuyQFpmn2k8neP8xq9JEU+sLGtd+XNXvhLoCOc/B+4jiEfbeU/03Sv+bpGvwIqfQkAjS50ci6fy4nGP2RWgenffeRSFbIHEhdUkhUfsb9++EICSdWHKFVvyF1f5BnU6G8pxP18TX5jwwFbetYQrA7qY5nHkSgd7dmGzUI4dFPpsjebWJOHZcUDcnMertzn+zSq1X4zuVH6se8555xT4gJO+Iz9yARzsKTIGRaPZHEtzMCrDVZgW7z3a/xFJ+MhbfjAB8Y1m6WLpRkJz7F+jZxwxMfGgivx4R44cNw1CjHX6V9SgEdxryUJ4gfj6WdQc684oSd88gfd6chPVjs2dGKgMNAhUY2BBbGMisw4XhXRdLp7gIPRhzWOsrkXMSMKoFbdGYNjONI10zQA0y8S1fxNfgCULBAQECBfWd5nepJh2jEHyQk0iDdflWcj4yIt9rWuD6AC36wA2MgkCAULe5IXEPWRJRb9AqmACegFomAyUxAgrnHsoIMOKkmC/kCLqH2ms+SQt5SQseqKDMga+ZA3/tQf0jIb8Eoom/Zr/KpiU23qS+C5Tz/sb2YCRwIXjujOHhKnJQ2bBIrwTN3pF7LvHc/9iM11fCc4ESff0xGx+rLWrP3aK8da/mYvOsa3bMQ3fM73lkPYgh3ZHLnBNF8ibTZw7rjjjit2mlQWffAPrPGXja+SqGFCgTFs1kAmspEF5uxhxz2DErsxzKDFQWbKsAH38Od+spAL5/RrbAQvmnFgyQYv7Mrv+mZTf9skjmDXeceMI+4sm8H9d6o4AAAgAElEQVTuoOZ6mz7gy5ju12BOXIj3ebelzRgCSAHLsIwBjEgMaQUAIY0YwjnXjmoqu4svvrgYFQHpF6CAHZhSOYzqZ9B58nEamQWN/lRmnOdciIb8yAQp5Ytbg/qc9jjyBlaJz7Qc0EP6AGkGYblJlWOzViko+ABBkDHkSm4JAflLZKogwQGkliNSoQGuawS9+42vX+C3CUA2EXC+IapS4gMzCjIJJH7XN/uo7tjS+PThJ8l3UHONAKGne+lsk5T4HvELIlgRpElYIQh+giW6mg2Y7pO1H7Yc950IZEIHusGQACeHe/m+zQ25sAGfiQN2ZxfJwt6ykcIBJhQy/Oo6e9jYsmVLWVKaRkd2Xun6io2yBMO3MKTA4JP8Hteg/vlFEoZD8ij26CMG+/lMP86JO/fAOczR294x+9Xuco/PzbfgemWI32EFvthIP2xjbJggk/4kEUkwRZNZNt3JomDzquqgJGRcy5ziDJbFKBsp2GCMnF76GJZAe2Wf9u+lJQZKU1RiUEkyuM8CHUHYkFLT6QDmPnvbsKYv1bJKDxkhRo5FktZQGTtZfVg/w85xEIAgB4RGXg5FlM6RFWEKCNeptv09r0YOdvPmgwrR+EAqKFRNHqSyharFdQJfYGjsibDJLmiB2HVAjOD15xqki8jNBPiNv5AK4neNqTufsYOxnUe8xpK4VPnOI9dUbeQWWAKNzEjdMT8TMqzRgQ8lIvghM6Jb6QZi+iK/oOQfzzy0BDJ9EabEomp2n+vZoNncTxfX0Mt9Njo4DlN+EVZB0OZGL3ZBMmKB7HSHDdj1Nz+wa+yGtPlw8+bN5fi0+vE//EgMcGIph38VMmaUnmPw+bAGx2SEJ9iTwHCI5NKvGS++52fYIgc7+GxWSW/F0qAHwvowDj7hc4QvAcCwIsl5fdlg0TjOGQPOYELfOEAywzvDcCK+6AZn7C4JwZm+jO+XEebJIbHj0hKDYGYARgYIRMrBlnoYkUMDpghrHycw/rDGQRyK1DiJY4EqRGW8adZLe8eU0emBzFQLKlHkSD/EZ1wyIFuEaj8MGL39T/M3ewK7it8aeKrk2IG8QIZM2dge4CUvxMB27K9y0YCUnwQRkNIjRExf/Xm46KcQ2EGV5hrjCh4ko2+Adk5jA/fyp74FANJyLXJ3L9kR+rCmf/3Sh95kRRbk9AyEj/UngOmIFF3jWroiRjYQePwGgwLctc0GLwjJPQgqBIpE6aRfybHtjR3gUZzBpiUkMcF+fAaz/MGufATTW7qzhWEV9Tg6G9dY4kIiYn9jwJRZjL9HNbKQj/zuhW++da/++zWYtzQJz65zvdjwtz3MOTYouegTLmDcykNmC/zvPjiBef8lJwzhHJjGYfq0uQ7m4EYyMvagZmYKZ+SGTfhiI76QNPw2lf7m3ZaWGEwLVfOcjQQQPbJhEMbgxH6kALQM77phTV9ea1RFArwg4CxG5VwErWpZawNIjpN09Es2AAEcwSbokJRgQFSqeVP2eTf2ZEc6IyzAUvGSjTwCFDHH9mwtybE7YiQjGwoI1wMlXZAoXV0vQF1rr18EbaqcZMNX7OB6QWWpScXkPDsZ255s9gKGzO5b7c5kLAWRf1STTCQz/Qp0/QlI5MH/K92ZgGOaMQSnKo5sAhsm6G4zm5RM6NfEmL+RqX7Yxp6+fC/oye+Lk+y3Hhq/0RtZ8wP/wWviUHKlC9/6pnvstxbd2FqBYDykJ6GKS3Lw3ahGJjiSHODX/WY+fG7r1/gFxxivyTd0NaYq3viD7k+fsKIPzb3sBWPsKO49y5AUfKfIbJp8ZBVjEpCZEsy5Z1jz0giuYCO64Rc+oYc4UnzB+7zb0hIDJws8RmBohkfgnIQMEui9BnCckRhsUJXgHgRg2YSBOQ44BDCSc87eD1Lpb61Nf/qR6elCPv0LrCQ6gQVEyNYbGLMYdxy5gQqQTN/ZFvGyh42sbB4CYHdEx2bWMv2CKZsJZkEhIFU97gFaumhAj2wBV/WHMAWJwDO+veTkekRDdyThbzhgP/4nh+vI4LhlBn2NasZQ0ZOTnfWlIXr9GEtAuk4zPiKQgLyWSdYsrbCVgOY315Atzd9ezY0ebINYFBj0Evjsu54aX9M1MwWfbXwMH29729uKXsNibVx9JdfMZBVI4sDy3jhJwRh8AWP8yc9wx8d8O6gPmJIQJCD+4nOYgGekjX/4M8uM/XRxrQIDbsSwAsFecRk8W05kI+MYQ3yZScSuiipt2KwSb/gJEffqg2wwyw+O4bBNmzaNFRP99Jjk2FISAwMwGueq6hgasTC2aszeOU7t19zPyQA8rMUZjCsA9Ik8bBxobXNW2RdpIKQQJwCHVB1HypYbJAzrqQC9yEZ34Lc8Y0O+CZLsBRd7ADwg+hsx00MAOMcnyE9wqZr4z+cEHZur9C09IAHBxF+IhgzeQBEc+gL8ELfr+MXY/O9v93vAOE5zPZ0kZ5/JTlZ7vtcvYgnBwQTcOea5h5kR2VWhNs9jkAFcIjQN3tzPh/zrPqQhkThmFhwcjyPzMq8ht+8x8CXbsD3d+AMe+Mqe7nyPhJfd+NWSJVvb+M4xMsLMoAZnfAWv9IYT99AXBhRNbDCo8S/ihxH3ww57iWGbv/MzPGYK4p3N2NY4+oYX+2GJQQxJDOyORyQu/ehfcsBZfopknGJpkC7jHl9KYuBU70XLpoIQcYTkVX6MCZgM0q8lMQDFsMaonOQ7CxwI3I4BFAd7E8J4s2oqboSKkIAx1Q0AIihyIxsVDjAuupGDXQELgbGFd6ZVIuTmD5VzyBFAXReiQBoAq8KSEDS2pJc9f9Fb8/qh8dhdIvLFHInJWCvdpR1JUh8CjB/ZjL1U4GxlDJjwAHzc5nryrXaXocghkASnpIz0JW86p5FX4uE3OsKE+2FGU2mSyYxAlaohErKyIz0kOP2yn6Tn1d1hJFU6acE/bMMXEjbSy5Ib/RJ/iAwpKuI8XGcvPl1mIwuf8Cc88hl/DYsn+JIY+Nb1dIBZGLNsmJcxBunletdKLHCisRvf4xR2EUeInFz4Da5d616xAetiInHTbyyJwRg4SZ/khV3Y87ftqKOOKomt3/2zPLaUxMCRqjiKczQDAqqsyCiCV+AlWfQqzEAcq/k8qOnbf0soABCe4LXGnSf7prKIY1aNLKqRVOPWGgHKRkc6CTyyWHIRgMtowIp8Bb7Zi6UUoI6swGlDCuwMnM6xXcgcWAWc4KSH6t5e36r2LK+wOZK2sYsgyRqscwJKQgrx6l/ASV5sZkxEPE5jfySNOASnQIMzZGAMnwUyP6TRYaVL8AhCRQgPcCewXcdXkhgbkN31+lLY+KxvyU/Sk0T1T89B2M24y9zzmbVs+rAX+7J3fCtenEOYdJc4+Qz5Or7MBhP/j717W7XlqtYAvB5lPIUXgjpDIKgx0ZgsNTHiIhBNLkRURJCICOKlCF4JIiEBNbpixGhOapwazIUX+grjUXZ9Rf61u7XrNOao6lVzzd2hVo1Rh97b4W9/a71XjblgkX35B47JRPbSr6WM+OTYFAswgXtssMHH+qKfuBxq/OxeezjN0pV7UlhKFHBhw2OutZETz8G6mHDvUMOBXrGnjziCZ9hULBmXHv4Tq7nxMDTOnOObJIYQEMVtCUYgRVQczAiMM9QY3L1jjeM9DEIIHp4iQNUwMrJHjHOXKsbGKc+R3bgAAnycTF9kBZAqM5Uoojn3TY9y3Kt8JhtCt96b5yMATH6bIDQ1RnwAzd6WSzRJwP2IUADwm8/6c5wd2NYU+7L5BTa9VaYSBAL2PZuk5LNEJMAEoe9eg0VOgn5uEzTk8XbHsSEDwWaLT/TF9q4pGzLnj8xW+M51khR/eTMlyZwd8uZZ3jtHpuzluZZADmGUY+zlM1n5QdK353t2EYdiUEGliRc+kfzYEMHlmrHYXFNPMsOHPV/zD7yRn+/6Gn/REQ/4zLf8jWyROIIfm3GIXy9uGJct3IufzAyNn+aVeDMGtoEv/YsTe3FhxjA2m5SwvQyQQkZf5A1feoaljxptk8SACBAQpyB4DmUwDvKZwxHLGPg41/mxa4DHWyYImXMYnMM4gAzGWsPQQCMRcKjK2zhIBsFmqcQxMxaO37Kxn6Bin8jNTuzLfmyFGC2TIGsJz3GBZnouwSIar7Yidc+IEKj++FaykBDYW0KWoFXhmS2yCRkEt2MCje9hw33ectLnKQ2W+Fx/gous/MDWiFuA9VWIgljlTG4k4n7H4NH9SRTsZa1YP2YKdOVrSZR+ZPf3uPbYJK/333+/tQUb8QsfwCMfwC29HKMT+/G5eIUDb5bR3fktsMsXCFqih1Eyww/c8NVQc33eyoNTjd80S52Ie6jBAxvEHsYTI1pZWMIW2WCFvdxHPjFkfM/e2G2opTiCXxiy0RdnkZmO3b86PNTXucf/u2w6t7cT7mcowGJkDsp3XZSfh7pkdMBIH33Xyew2Ac6pHMToACQQOFegMP6SjU6ea6iuVNgczLnGUpFZJ1RROu6aPTRvAAEtolPl+3EgkLMxAkHmKklAl0y9taRaBmbkgkg9GETq7ArEEoc1d31buuADiUQTOK7je33yAV9pgpSPHL8q+SDmQzMNRwYIja2Nb/OADxnwU7chfS8lSGLuIy/9LancvXu3DdD8gt2Mhvyen9BbEpRcfTZOiKc7xpbf+ZG/2JvvzBjILeaSTD//+c+3eOXP/LFCxQByOjazsF/96le3vv71r4+S3Fo6khs2yEsmmBVb+GCswSMeEIPuhWt84LuEPtbCMcY2HpzCJg5Jc4w8rmFPNhbbNjY2/lhS0I94cx/siA19wZPx+crMvlbbZMYgs6pEkAnjWtJhNMsV9gKKUaYaR2h9AZ57Od95lXqCFUA0TkByyHrpZky6GRMJ2lRjgkt1bbNui8DG5F9arqH+2Bt4Q4LW9smVJbAEovNmCGYFTz/9dEuK1tb50P2qe4EhWF0n0agw3c8XSBPZ+u4ze/C5QBOs7CQx8K2AsDezOrXRR7BeNstYPuufn/3WQH+IRND12d61hyapSCYCVGDDK1uomL2z7lfc/OdZQ2YKllvcQyf9G/+qie1Ufedcz/5+iEVGOh0bkqc/u/MHf1lv9wyO7GZPYsRxBOpaCVJ8il3XDtlwjjxXuYYM8MPGNt/ZmkyKvqHGp5ZpUujYw5a9+6dWDpJUQtjG5dvMtn1XcDhPLnv4ZkfJQYwoOMYa+WDMffaJAfJpZhzsX6NtMmOQGW0AJ2hN9RkhJB1DzDEAh4w1QQBIgG1MjjT9Q2JADzBrNZWNmYPKGWgBibyOS4J0N+30fQ9NkLOTmQE52Qk58I+NLSU6JPL666+39vSDG9fQDVm6ny8tuyB4thcYHrz5zYCgESxIKrY3TTe27wkqfoID69yC7CrJm30feeSRdtaGBBG3vkIOn/vc5waf8/BPKmckmATpXuvuqma6w7C+bWYY9OZrRPL888+3z1724FsywDv78iHc0Qn2+MxnCe6JJ5645xcJ+8EHH2yvt6xHP9fwtyUzvmWjWmQVO8IGP5DZBpcKFjENW31NoeI83GkKELiEOQUcP/L5UGMnY1mCRNzwCvM2jTyacfSZ42TDO56rjTUxA5/G0IfvMG9cffPdkG5j/V71XPUZA4UZS9DaJwlwlOUVYGT4GHZMMdcgMH0OJQiVERDr32dBng3YLQMI5rUakjC2gKKvILSZGpLb2CrsIfnXkquvXzKovKxBSwTIDlglAkEVnwgKx2Jb3xEOwgRegcCPmkob0M0oBIzvdLelCWqb/gWG/jQBwXcKBuNfpbG/Ct+yiOCnl/7pKsiRQ7kkUI7hOqQXvdlCgApWOsIPHMMwUqGnvtgQacJWkmbZ7xafESI7wF5IlayJNefhUCKgRxr7eLEASfEpe9KZTegoyViW02phGI40duYj/rCRz7G+Jta8MAB34tFG3szoFTVjGON3/ud3NoR/NmAXdtSf2aQ4EOf2jpPVtd56s5W2LeV0zUsvvXSPmzzTC7b0wz9Z7i3vW+vzJokBCQAYR3obQPDZvBXC0Aw+F2QM6tqx6xEcYBiXgTnL9ZzsD3mNPXg61/DGCTkBjE1T9UiEghF5DAHm3PFPvT8gR6ACAFHTgdzsZ6mIDZNcVUJA7HmDKlTgIXPf6SUhIE6BS1dviUko+nY9/zkvsNhJE6Cudw75qMwtW1y1kZns+pOgBbiKnow+WxZDkH0NMTpPPp8FK7lhVB/6zfMiuiNd5+itf0tyML11s3x72Syr8SOfmqUdmuUyCQ0W2ebJJ5+854NSXjq7hn8Qr03cWpJjWwmSb4dIuexric/BDlyKG8UI/8EuWfsa/WDVjJHfXO/e+GqOnxK77uVTeGAT39nUyoD+NHvXsAns2CsUktS6MuIixYv74Ih/fFbM+CymPNdbs4gtZfrf0qA8uuJnQSU4U7UAJgPL/Mib04eM1ycW43E6kPQ1fTG0cTmWA4wFQMCsyrXcs2bjTOvsHlaSgwwakCImBOr8Hho7SpZshvAFj0TAZz6rhLy14jqgRYzO+S4A6HdoCMdxFap1U7b2jOfxxx+/9alPfartly/0y3caPHgwKsh9lhjgQj++n9PY39js7qGyccxc6OIVQ8czw+kbB+H48yAC+1//+ldbeSIDfcCfJTLLbrCGfJJQ2cXLB8Y/BdN9MpxzjP34gi3h3cYn7MsP4o78Y8k3sye/loYLfsoMgu/5XB9DxHyO/N17kSwitsGQxGxcfrL1NTijn4fp9GUTvuNH8Qe7jmUFo9uH4/Bvn+VU9xhfU+yIZUnSefK4np3gQRIds417JBLyGINfJOPEn35qLtlVnzFwEPKwqQatZ9sLUopz+pBzus7qfgfQbhOQ3rARFIyLBMog5Vh/sXDNFrm8W8/hgMIOdAVkBGO25PseGvuo2tkKQQeokoWZgj2iUC0JMo2OwI0YEY+gU5kJRks29q5XaQoAFaxA5BfNZzbRn4ATREk0ziHlc5r+bMa2NOIhtAf/nkEgOOPGT33jsIl74dZMgJ4wy2cIll3IS58Qh6C2fKHwGFum6BtvyWMqWcuDITWySlb05WPn/f/dfa/wlnLEhp41IEAP38UuPOShvAJgLMmW/V31M2z5Pz7EDf4Qw8EMvfqamOOzcA9/SyzikQ2OzaqCggdG+xqf8jufK+hwCXvChBgxwyaP5KBffQYTZLOMpBCFlb6mYPFCCnn0Q152hBtxwa5r81Qp1yYzBoZiVNNQGRLgZMeSsEshpz4DeAiqe63gFLwcBcCqXMc4NNNfjuToNZsZAVCkygEuYEOeggtZWd/dS2MbNhJ4kpelETKzs+AAejbjP8eA2DosffgXefCLqlkyAHCV5lNPPdWSPKJHLIKAX9hGAEgC7OLeJAoB4xqV4TkNzoyputO/IFSMqBjpQecxDCIkrwyywy9+8YtWJlN8+GITsiMW5CAR0skxiVJgb9GMLymQnV/YMQRPbjZAiHw0p9HfPV4/jv8Qs37ZQBw/88wzgwQ4Z4w517Atooc5ZM9v9uIMt3QbGfnFOXLSPcViMJwipXuv75mJwDcucT8eEQNWPfRJBn5mX9g1HpzpV3F6aGZVsNbX2BT+6OB697nfeGyrkKnZqs8YohxDCDB7JAO4jM9xY8GZ+7t7hhxqqgHLB6pchjYWRyJpyzuWToYqjaE+Tz0OLJxeVjh0BQJEyPnWOYcqllPHO/d69gR6/lG9IBU6SKxAb5M4yCtIEWHIh07Ou8/9glIgIRKB49U9/VhTRVzGYguVl+scUx3lgTXb+Eu4zp/TyGccf46dLKpcS13efELwdJHgXDPU2ABWYEeVZ48oyExXeutHIqS34xLiJz7xidY+Q/2udRx5vvPOOy3GxBu7k48e7C5xexNp7q/w3ccvh4bkzBrynCzxK9Y8jB4iwKX0tO6epMDmSJpsSLoPJ+LdsiF78AceEI/8A6f2kuPQrIl+/K25D1elIIJ9P6RlX5vZAxnYgH3YyqwRbvrsoh8YxAN00L/7xR8u5DP4kcBrteqJwbSVohzDCCEXYM3swf7UFjLiwG6TeBAypyEZ13AS4wtmv67tc1i3n3O/Ix1rnIiHDABtjwzJCGyAmerk3PHOvZ992ImPyE4uAcaO7I34+AoJ8qdqDVEKMiCnm805TdDqDwm5B7Go3p238YXr9e38xcXFvR+7WaO9Ci66NhBsiJweKjJYJK8xPQ8QfAJ9rJFDcuM/BQe5bQKc3uyDdP0eQLKnixcc2LBmI58f+JEFwdAZCZKfznxFbxX+KZjjI8UAAhPPYspmtgAz+mZjtnTtGo2tU2QljhwTP+Toa/R3reRFRvjlN/HIPvjIf/4z1BQPcMq/waJik28lKnZ2DsmzTZKX+JF0yAcD3cLX8Tz7cB9cSiiwyp6OZclzSLalj1dPDDI2QNojwxgCMBkDSXYNN0dpTsnWvV4wqBaAQiAIXp85hCx+eDJUKXT7Ouc7EJmhCBqAVIVr5CCP40BGlrUC6lT5BUCSAYAjdwEisMjtXCpjJKmyd49KlK1dk+skX9NlwYF8+dr97MIn8Yv+BJXltRC1hJJgPFWH8noY8ZDUWAgEacOeilPQq4adn7I/mZE+fdyHXNjEfXzJv/TMDEiwI52x2Ugp5xKfyZPnPT6TSUKDL/a3jOdNFzPmUxs99KM6ltwRoiVR8SxZeNitUGBfhLt0E9OSerCHQNmaTH1FHr+k0JHEYMkxeOAniY7f/Kp9yPdsCdN0dD+9jGk8ycAxOCIXDiMjnDnO1maoMMAmZXONeNGXe8QEecQN+TQzaMdqteqJAYAYlNKMxxgcwTkC1HeGPLUxIMdqMWb6YHhvjnCoRCCQjYfkyHJopnoCZu1GT7qZkvpMFnvyApzEgEAAx/OXPTSy8Ylg4js2BFCy8qHvsbtERx+/dmZX5OE8sLtWYKnK/TjONZZx9M0OrtVvcKBPhQPyNraAE/RLNLIZhy/MVI3L/15LRZ4SoG2qkV0ikRzYJvrqDwmRX2LLnw73PENCqdHY2/8YiDgVG8iLrhKCStTGB/48C59dpdFF8hZH9NTgxdjG9avwqb8oepVx3YMr+JEPYMPeuPQjT7c5p/E5TLlGjOknlTmcWur0va8hf35G3MbTl81nz3Eym2BPtsZvEvKh4Rd4EjOerXUTA5x4GUM/+mc7MsIo3RRFfssDX7Va9YfPZgUCR2M0QELcgt65c5R3bwBQGpBTHOd4DYFxrlmL8b054v9mqNH8kMYbIJZRBJPqiv5ABRBA5RgwANQemkARRGRkOxU1wlchInBbgsRswts+iNZU33E6sT1b01ES/PGPf9wGsb+lJBmyB5+whaDSEI9kIjjcj2DPwUdpSwTiLROVHGxYd+YP/auABSbZp5rgt8yl+ZMIMOV+pEVPz1HIjojefvvt9j9amZN0psadOs/Wx2bJRPVq9kU/csIfXIk9dj7XnhKO35nwnSRplgAnkj07XDXpzNEPlthSrNgj+aHEC6+wy6/4h98Rrz6SIOBgzOd0cT2M6ouN3eM4O/uO/F3jM2zArmUkyZmcfUmHLO4z+zJz0L+NTjDkmQ081WxVZwwyoz/QZskBaTAcRyXzMzKgypxXbQDfBaP+PRyKQ4GWg4zD+MY1na5hfPoJHG/aAChZgchn59gE0ZJFsqwh0xxbs5PlAcRPPoAlczZVEPDzJ/383XiETydbkrJ7BbDKXLDCAnLRr2Ouc7/Nd6SmTz5DbEOBP0eH7jUwYPZmDCQmuAWpxExm+thPNdcIeiRgTV8/sIYgEOaxIWjy05EOrl27SUiqz1Tz7Ma2dJMQL5sfu/ltRh9RnSobDOv7jTfeaJOfHzGKN5hI1Ssux0j31DFdz64SMUJFrGzMF8bsNoWH2apZlDeEFBzwleUhRA+PsJbCpNuH2IT7JAP+ttHLcdgO5vVNHt8lHjIpfMVR2T+7mW3ASwof/bgXX9LNbEExVrNVTQyMZTrGifYCSGByTrkeOScYh4zUTQq5jgM4jyMFLOcgXc7mPG8NlA7LfWvsyeiPmQE1skCOiFCC8KYFoNmzgypsSKc1ZBvqkwyC2+zKTEEFikz5jj8TkMjUMgpb0g+4U8khKYmEnvxhGSJJxnf4ECDGcdwmWDO7W/rtMXJZppKkYYAfjA0TKjdLP4J5TqM//ehtiYze8AZrmv75GFn70wbnYHxKHjrkD1WKL1iDKcSDZLxT/4UvfKF3LX6q76HzbMb3EoJEa7Om7nv+t0avui5Z6LAnArXBiZiBRYVGt4DgZ+ckQr7APYpTG5zBpOQA55aT+hpfwidyR/QKN/7WF7/STR/G53992nAb+5PBWCXJSzJvvvlme07SkrzcLzbM7th1iTfy+vQZO1Y1MTCSKp2ROICTBKeAAhqk7bjtqk1QxCFlHx76erde38YR8Dbrw5zlvy5conoqxxz6DLRkEDxIFJg0e2QC5ACBqBCpioNOWzfLL6pdwSEIyERe4FZp08txJK8qPTRLFuRPEnGcv20w4JwkE9J0Xl9IU7/8oj+Jgb28JMAWSzZVrSqfDMaxwRASkNgENTnnNDJK5HBE/2Axe3ZDRAgaia7VEBD5xVViDYHxkYLMbxAs9y2Nd2TJt+zGf/TlS35EnvCCTLukfVU76J/f2J2P4JM/YZTeZaO36vvYzDKQdrBFJjLykWP2HhD3cZDEAst0Eavucz99xSvsJvnwgWThmsSKaxQ/lix91lyjwIJrY0pyfIeryGuTGPivZquaGBgF6SFDjkPKwJtgipPsr9oYt+/+gIhTTSvjQGB2vQdxQFWrAYxX1AABODSVCMAARgAlmE1vayw/TOnOTgLQLIc9BYLqhvw+I3b2BeKcs3Ri2cK5JD3jwIFAlhyRsUCjt8DkwwQTEnGfja+u8gbNmF7BId8bF0bpyP5wAqOnvJiApFzPr1kOo7tx+NZn+kpydFy6ITcVqARkLGMcmgStArVHzGbH8L5G0z+yNoWoEDcAACAASURBVLOMrnwHO2ZScIwEz1kujtz6RarBD//RX8GHY8oGr3zjuM9wykd4gK/hzL1kNlPsI2L3IWpYhV/NZ7Mydg6pB0uu4Xf3wbWxzES95JCZqESjT7q4nhyeSZhVkEGMeP5JxpqtamKgHEBwoKxtS4UmGBlPOzdgkBInGyctYDGNZnjO41Qglp39rXMkV6sBKPkAJ/bwGTkCJx3YwZ5dBJNqbOuW5zICknzIj18Fmqm84PBZxWTGY0MK7MzeztNJAEgoCgMBS+8EkCDx2V6yFKj2bIDglraDxJvAJI9NYNqrqs0a6DC3sYffaiAMwU5e98Okc2ZJHihKOiVG5/Y/dh3yYWty84OlHMnOxnfkIBusrdHoZykGAWrkgQWYZmPr6XxYLqdcVQ54Qqr6xyMaPRUQfFo2xYzr4JaMfMv+iFcswiDbwKRipq9IhFu2FY8+64cMxoRnuvrsPL/COluwNZJPnFsdMa5GHjFEfkWgmNKvTQz4YRvc125VEwOj2ThBkDCCgEcKCRpV1bnVBAdni0EloVdffbV1LKMLVu8GM7y/KS8pLB2kGbtvTz66ChT7VFLACkSCCHjICtRsJaD20ARSqnt2JBu/khmYbRI9PwsWbx5JGgLGNUgixC8YTN0FsqB0HhbYR/Nd0OjfswAJfI1AEbwempIX2SBvtjc+QpGc6DO3wbCH9QKf7vpwDCEpUhAMvy9BkJGJ3fyRO2v7+rcZk23ZU5K2pGrGgMjWasb0mqrK+NDMUsSWmQQbizF49ibTKfbsk1V/sGcPW/wFl+wrjsp2bJaQ+BKRw5nlH4mTv2HVLE/BSF77Pvvo3zj8ZpM89EkP32GUPPoTI+xt2RB26K9v8ZK/cICTvLot3qODpKY/m/N+fKuv2m0+0heQTBXBEQDMiLIug0oOqZ4Yf43G0TYycJiptr8/gmxVV8BgNlGzARaQZN0SSZriCx7BhUCBTIBpSCZBXlPO7lh8RE5B6LNgYEPruB5Gq4DIzbcCxxsyyMi6O1/Tgy9SQQka66hIS/LWjwDU2MC1ggep6i8k0JXrnO/6906/9Xc6kZEuEoS/qGq58xR8IGJvZiEfRARvSAn+kYBlKj5WECCOJYJfArJco5H92JAhvEhK/GPsr3zlK73V8Dm267sXAZppsZsH3mSgN0zwp2QPN+fEOxvrFx4kH7rCF192m3GN6VpyuA62jA/H/CNZ8FG51FP241qzgPSBs+hgPL7EZ2kKH+NIzuLBZ/jFMylAzSaRv0LE+LAiTnASXESf9FlzX3XGIEA4gUEYmGN9RyKMxbAMbDu36btsHOjtCOMJEslJQ8YCyFq3B9Dd+8o+lv6sKlDdIDsPI4GB7gIngCInkgIc67aARf6tG6BLsF79E1DATVZ+dY4u5ER6fKuC5Gf2pR9/AL7gohdi9FDOPeyCxAQXTCgiBBAbaGYY6WtJO5CBHgIZRvkFSdjowFdkn9vop08kRBd9IhUYZCtE4HkAHS1fhDDm9l9epw92ZKeQILshaGPFR/471iWSUDn20GdEamxvRdGVDfiV/ggdRuh8TsxJsOIjS0X05D+zytiTzc027SUDMrGTGCMLv7CZ2COzWRzZ+ppCIVh0r0Iib+bBjmKP3+HTePo0jg3/ud943jhScOiLj/gP7slGFy9EuM4v07doVRODP0uRdWgOAAhGQSQJOIbkpCUaI5eg87CXE80aJAMkpFpVtXMmEltq7LnyI0h/0A3I6A4c5FBtaWwDYAiUjHRCNLHX3HHWuI79BLwgF5CSrKDMrMyxFADW21VCruVzpEVnfbgOLvjG63r6oJ/Ado2g4UdELbD0ZeqPqBP8S+inLwnau/7G0owvQM1mVKUq4LlNf2T32x1Eo7KkN5/Th1/pj9APzTKDipL/r9LIePfu3bZvn/kCtlNJizf/F8bSD++nZKUPe1reQoSXl5etr9mGnGwBD1f1I5yICXY1luTDd2yZGOFDr4IaT9ybFYhz9teczx5Rmw2zXV/TdxKIPczCBBnEAuwqmByHUf3QTUKyTBROctwPIiXKJDYYURx5LiHB+K9nYXyLVjUxMBDnMQYisJneye6IzzlEaL9EE3xxhP4EKbBwrrGNhbjMFjykM2PgvJpNwEpY1rfJYSkg1VWWHgQOYAE90AEP4JRJr6bMGYv9BKAAA2Bysh+gk12wChSb76o7z03sYUCg8gUb+K4/lVbu1y+dESrfafZsoKJy39LJHGGQC1nDjvHJBKPkYnvf5zbkkTev9It4cj/7sBlfIk62lPzdU7b4nY3c47xYKv3vV9X+7AtcS5xsJI7Yl82M60+e9y2zlGMt/ZmMiFPFDtfksbd8Sk4zTg9jJchSn7lyhC8kVkkd4fKV4knS0RC/8cI9cMUmYso94h4ucYP+FDASal9jR7bXtw1O+MSMQL/8x58+00uSSVFgT09jkkXB4DqbfvlG32JFMvU2kuu3aNUSA+U5RwMAjqM0ZyR7C3QG6wbGuYYJ4Oz1b6oowJGKYORIgL24uLgXtOeOecr9SFWCRACC32cVH7CZnpIRqUhimoBiP8e3bkhOkAkOn+lio4vj9uwuiOglACUPegoGZMsndHO/QNIXLPAJvTV9acjaZzOP/FaAPwW0oFqiCWAzE4RCTjJYBjATQrz+amowNTUevfXhQTS56UrOFCzOWx5EaPzqbSUxUeris2SK7G3sxkauc79+HZeA8zxDDCEYxyQm5Pzoo4+2dp2SeenzZOFz9qQ/39nHxwojs/arFGXixEqE5RdYgiG8YosN2cFMQSIwdjiHbcS+75IJIrfGz//s2tfMbuFYP8Gn++mmP1hxHk68kqzgdV6s4hzboUliEiWZyGaJ1H30VyjwJ395aWMuzvpkPedYtcTAaLJryC5GJHyyPEcCEdAs1RiWoe0Fo3GRlT0nqA6QkTU/cgwBYil5+vpB8nRHbgBqbzqJYAHRmzgAFqADJHI4d126T5ZTj7GrYBTcfBsilezpwZcATxcVkQfL/kOiBDB/u45vBIlAd11s4Luigg/p7TNCsddM2c22BJz79Hdu0wd5kQ35ySK44YXd4YXP5jbkI6nQgY5IAM7gEIEgeX2T31LaoSEOzwHibzZ2DdKXQNlKHyFAREQuCQae2RaO3McPSOyb3/xme2yuzEtfh2xVymypGqcrG7ODglH8IUMyn9JgIWRtj2RV2xlHX0gbCbOda9gVfmALNo3JthKo69iaLH1Ngnaf6/lPX7CgH/6gk73zEoPPme3DL33h68UXX2x9GPnKpAArEtQpLzv0yXrOsWqJgTGAncM4iPGBmXFlU0ARhAzH2Uu2gE0AmW4LTvIIVEFmj9QkBvJt0QR6/ggb+wAWUEkQZDRFRR5sIyF4Fx3QfKfLlo3PBIeglBhUbmTmY7Y+NESnIlTZ0wdRIQfXlElRsDrGT/SXvAWVPpAdP9GVj1zrHBu53jMAgc2HsdM5NiGXGQlc0MdGT2OzOz3mFjDugXN66IPs/KkfetrThd/FhOSpEECmwa4ZgeUmpBT86tcM7He/+11bgUoyfCDOvHHnbyF5LdTbVnlmdY5NzrmXHnwVW0i0jsGF5x4SmATKpkmIc8ZjS4kF1tg4BQhO8VmDmTxrMb5xYIlNxQ/cwK1xXUs2hUZsX8qR4oetjSvRkEHTLx3Zn3+RO3/rx2Ys5/SRZST+V9zAt3Hdr7/HHnus7a8cu+bnaomBsozDYEAKEFmDky0ZzQYY9ks2ZGNsgffWW2+1DjX99FxB4wxO4cSAacnx5/QFMCpfBKRi8KM74EMClpM8yGIn1Y8NuCw9IELyb93IJrkhU7bW2BTpIbP413WInMwCU1Dyj03Quo6fBC4swE2IUJ+CXxGBNJGpa1xrHAFmCYgf2eUcHCEJspryGx9h2wtkFSmikejmNv7lL7Lqmw/pQB99a+znvHFc620o97mezsgvCRMhwYrEwI7ukVDM3CRUNoQf/Zg9bIXr0j5wgQD5JRihM9/zX5ZN4WBu4399uJ8t2c932DND0diMrfDOoSlSxJI9HBobPjPTTXK1pCdZdRvb8oNxxaj7xCLswSO/koXNk4xdmxk0vbMMBadkdU8Sgr7I9ZnPfKYtcLrj1/peLTGoZLwZwIDACsgMwlCcafOZEW1LtoBQgHkzIgGGlICJbJa5PBTzN2S2aIKFTSwlABjAkM2e/JY1BExATAek4ZzjquQtGzmAG2EJFnImiPgZeSFtwKcrEkDeAlEguN417k1AImZYYIdUU84hQ6Qp+NgM6RnLvXzKl46R5xw86QOp8EGC3jGETm7LH3NJjPySJvnImgRGRkRiLwaSFBUH3lazbKWYoocKlS0QCnJDfIjWRiZ9qHjZBz6M5dmGP/MuseyhiUG4JRssqLI1+KUjudn4lKQuZuCHbcz06B8/6dsLHR5yK7z8BVi+079ZhZmfJM+GsCVRKEbMyPtsxkcw5zp6WHKiA/zH5nzn+SXf9TXy0Ne45JVAYNksERb8psdsY8u2LAOPaCLIGYvRgAIxMCTj+1+TBJgNcEIMI91d6RRncAAnClTBzqkcDJQCFrgE1xbNswSJC0GSRSVJNjZCeqa3yIUNnUMQAA1Qzz33XAuyLeTOmAjMXw5VUSMqOghA5GoTsEhWIpYsBLPAFGwCzTX2qjt+oJt1c/0iEUHjvM+Os4eqHWYE6z/+8Y+WWF33k5/8pL3fD7oke/6+SrNODKvGYPMQGB1UjKcEsF/a6wu+4A7+fZZg9OctFDaTHCRL9vC2ERvxNRywreTLBuzmuN+IiBm2kCzISF59wY+421OjM/ks/9FRQcbXkp3kBhts4vOcxpbsAU/wBXO+01u/7MkWxnJc4WBs17K5H+DhAjYkl8QAc32NX+DT3j0wLf7yt6+MzT8SS1+DIYkJ18EpLsJJvidZkWnrVm3GgNhsnA3gjCljcypSFvAMzZGAvXQTRJrXHAMgQJGwbLK3IFOJrjH+HH0EDDnYg40Ah2yOAw0Qeb6ARBAhe7lWINGPPQFsy6YC4lPyCjByIXlBKJh8Z1/X0MM5ZAkbAtM5GKAz/W2CWl95rZBNNMcEmUC9fft2e7/++NV4bCTJIgaBDntseEqTUCK/e+GUbwSzcZD23ELGdf4ECr0tJ5AttiCb2bRzIR3kCA/8alx6mznSh+8lFsuhvuvPMwh2Yxf2hws/Bpwr3yl2OfdaOtE52OZHOKCf54D+lIQZ5ZzGbgiXHTS2YgPVPDxKPM7DHpuxI7+yGYwgcrbjZ3hzDb/02Y3PFbYKNElaovFA2ng2iQVOyI5Pyub8K6+80q4KGNPKCZndYyx925tp8N+WrVpiiNM5QyAzkgBAbJzEmD4DC6es1QQeWQCCLBrHAARQemiHtLZqgAyYiEzFg4DsVcgI8qJ5pZZ8AkrgJ7iAVbK1bdkAWpUqcOiBwMjKp2zuHN+zt0DkD8EgQOiXYHVec78NkcCIPvQr+OnOXo6ZjqvIVWrBksBkI5W9AJb0Q0RzbaSvFA10IIt+7RESkhl6g6U7hvtgnSzuh38thIQcJUXLTLBoycFzA7NIy0hek2UXMtGLzcQSwkM05NEnG7oPIUqmXYLqyrXFdzgxq2RTyz5mOt6ooiN7spMY6CPnrrzuZwP84Xo+thc3krjZAZunIHSeTULEkgb72sOj693bN2twDT8pMNlZAYJPYJIvzOaPzZtNEnKXx/jcn3xxrev41/1kM67nQ5aRjL11q5YYQvhIgWE4BbARBYDEob6vUfUKJptxBRBgIhcA4UBg4WjksmViAO5//vOf7cY+gEM2NpIk2MdrbEDkuOuRCfuS29R2ayLgP3J6poTA+Ju9BRV92Fsypo/viBe5u0aAwwiydK/jKSLMKhCmIHYsS276szygylRtHZoHi8ZnP/ZBHGRAlnx86syKPdkYXpAWErOMxd7O+U6fOY0fLXnpy2f92iMhxIEYEBi5JQE2kDDzENlLG5FH8oVpsQPX+iKHvlWxyKn2L53n2CDX0JEf/WKbX+iPXOGCXnBBtynbwgpswB0bIFY+cb9jkiabSOLwFcI2nmRkPDaWjMjDlmLM/d0Gw0jdyyvGtbmeT2BZ0tDHww8//H/k5k/XKWbI43pxSw4Jne5+7UzOrVu1xIAkGJSTBarqTSALMAQXgAtoxlurcZopIGcgDs7iKGM6RibkumUTDOQCdlWF2YCKAhH6g3TArEJmT0B0ni4qF1Ui8hB0WzY2VakjcUGXICCTz6n8+YOeCQZ62+BEooALwecYuwhWQQVDyMRx/Ql+/ag4Ea2pvIB3bypppMBGrncNrM1t7vUA89hUg5ITX5AhyRmpkHeqxS9kYBd9uReBSVj68MyNXZIkySkJeUOKXWCVHsgk5MUOdEaMxlCF3rlzp7fqnZKx5nk+hV+JXeKW0OjGvmZK/Ge2PJYcYEni1I9NHMMCu8GVOGFPG9vgHInDeTNsNmTTPKOBG/zElt0Ge+wuHpG6/hzjO33YYNCSb9n4kmzwAjf0JoelSPFMP/6TUObgqOx7jc/V2CPTLAEh2BMgnOC1VYbiOEBIRl9DYUYHPOObZpKHswDI2LL/1g3pIzrAVaEif4BDJIgWCQATUEkEdBIMyFi1Kcg8kNyysalf2vKlYLcJDkHF5iE9waeaVxk7xgf081njJ0GDGF0rkN1Pf9Wwe9lHs94uWbADf0ryghdJeMNHlacPSRRx5pepksRUMCJvy1SeEbA5skFGkf/LX/5yW6G3gkz8o5933nmn9anKlF/5TzXKd9/5zndaO9CLLRyHBXZAnmyTgoHc7qcDwqE7/fhfbO29wbXfW5BZwcauuAIe+BmZItmx5RV9wBXssFlwBDOHZvbIhsgbDtjK9XAlVnw3tuU710oSfF0m3dKG/M2ubE0+97O5sWxk8Kprtxmbz/gJZnGg8fjPZzL6pTPZ9tCqzRg4mEFkd0ZI9hbojAEIDMTwqqe1GkekWlVJAkSqPuPaht4oWEumbr/sgNjMXCwxkFmFA1SCBDGpNgSLqhwZAjdycS/Sk1CQ4pZN4iW7NVs2lvzZl68FEL877rPNtciPHoLbJqBhhX701IekoGJL5aZa4zN/5toxgWocfbEfW7Env0u4cKgiRc72EnGId8xeSMO9GrmNIfHZs/WhCXRjTjU6sAkS5CsypFDhY/r6f0Ls2cqeTdwndiQ55MnXdMpnMpFPEvZ3keh9HRobwjI7wozmM58FB2OzYDgy8wrxswM/IG9xwyZsxXbBnPOuE09JoHwgCeMFtlPBdxucSs78AQ/4Kn6RKODSW07d5xOvvfbavRmn1RO8QwbyGJf+cLiXVi0xMCaAC3TGYEyOEcQ+a5wnQGXstZqxgc60UWZHoDI9uRCPQPPa6NaNTVQjQIP4ADDTX1WR6XVAKTmwresBF4m6hm7suWVjWwQoEMilSuNnZCBQESpdEbrAEiz8Q+8kOteHIARuyF3Am+EhQv2zw+XlZTuTEmju0xAMfyMKPmYn/WhI1TG4cF2w2J7s/KM/8nmDhWywQj8zNw2W5yRjCRAZude4+tEvG/CbmQ0MSnaIxjmb68jIduRHovzOVmJGv5p+rFWvGUftQAv+A6f0oS9ShW82Ylt6W9qBi6EmufIrDOEVeGEn5O0tJ3ZyjRY/sb14YVvXI2bPZfCCsfvG07/lXJiDQ/6CK/LZFHOWksiQxlcvvvhiez0ZzByMKxbgVqKgr20vrVpiAFKOCng5ikMcA2zEbEN2a5MZ5yIlgc75pvPWdf35AHuAIdvWja0Ehb3KUUNcSM93tjLjElB0YVPEgbQsl7EjsG7ZyC6hCQhyCV72RepsTAdB6Lhr+SUJwXmYgA9NsPnsOrhxn/MqRU2wsZegFZypPp0zpgSr8hSoEoIxbYLTj5+Mhxz0P+R/8qrybcYyNiJGEpKUZNxHKGQoG9nogFQspfKpB+dISyK9uLhoSYbMbMUuEisdkVGKGHGVZGEmhdgszSRZlWPu/TP/+j9Tjh88x7GHa5U7n0mkQ8mOH9lGbLM//4kViUEsiA17dvQ5ftM/bJrBOcbGVjf04d5ug03Lie6RxBS8cMBHwTAOKZs/f+FFAWPDijH4XnMf/D355JPtikB535afqyQGjmAczmUIhMXoQM+BAMGJPqu41k4M1ulNPTXOUi3YJ4urWEJGWzqHDAgMYNkQqDTEhRCBy2cEibAOzVIGu3r//aIhFiSHELfWhZz86+EpeUK8klsCGiHSgS/oSmbX+o5E+USwOuc7AkSEAhtm2ANu3INYPX+QkMpmXCTKLuQR3GwqsPVjic7fq0Kq5NFXt8EocnKv5n7H3C85mJlYDvJ9qrkeYdApy0HG9mYc+YxDDp89+CY/mSQF/as4xZTzdHe9815RnZOcpuSrfZ5+Ch36sCl/IHqJ3uuhnr+YRfXxg2N0Zi8+hiUbbkHe7ITw2Q2mxLqkbDx7WHQtfhJvMMWX3UYeRYF7YFKyMo6EYQxydBMDTMG5MfiMn1IY8L0fSfp7Vntq1RIDpzAMJzHOsakGZFykwbiImWN9rgFqwBOMpnWIgYOAhoMFNpBs3cgjifmzBh50ergKtEBtS3JAosAGtIhKQAEvgnRMAhZ0WzaBELnggL0FKD/QyZ4OApLeyAE2+IGegtQ03X0/+MEPbj377LPtPfCkCWj3JKnTVwXuWLcJZBW6xOG8e2NTZA0TZPFLXHJ1G130Tw/ywq5+yMbuyJ3sU03fXl310NW69r///e+2euQ3vj40iZ4+5DUWcswDWn2T23EbW2YW5FnL1sXAlO5D59mW7HArDhGt9X52pi8S5ZuuXxCvmRQ7OJ/nc2zHP3xjRscv7hXz+hZfuEl8OS6xGFfC6HvGAMN//OMfW3/xmfEUKP4TJL9YJl9ZUPANfJPDcTqYVZIRZuDl+eefb2N0yCZbHK+SGAS6QEL4jMFIPsvsjMQJjiEBx9dODEDCYQAgiCUjDbhUtab2a8sw19nswn5kFvg25A/kEkYqKKAjv9830M097AvoQGjbspGPnxUDZBMg9gjA3nlBQnayJphgwjFkYRPk9h7w8ZvKXXDqD6lryEXQDr2L7hr+FfhmD8ZlTw0BIQgEYPaFSMjWJSJjKHD4BcGkgnQdTDk21chAf0sciMpMgB5ksdxAH9WnmGE710kYrmWfFDTsk2RlpvShD31oauhdn2dz+rENm7AzomdXSz781rUvXMQm4oMdfYd/OLHXr9m1uOBn+GA718KA4oDt+d7nvreLFA0SuOthmYxmCnxlVqeYCJ+QyW+S+JJ/bPzoWQJd4EuB4rcrMLanViUxMDbCYiBgBvQYirMElSBxnMPXrm5NST3wARxVhoqUg5DsUEWyldPYBYiBCJBVzr47Tm4AY0uNLQHXmiUSAVbEqcp0jepzy0ZuzfKJgMysRwDBiAQhKSTI6WeT8DRJwjnLgF41ZRPYQZb27pU0zPr0J3j97Sb99jU4I5OZA4I3FhIS6MhCv96lVxEik7IfgQw7tsyAJYWQmoKHLFMN5vPfmdKTTZAYIlTJWhZMfDjmwXQSoWuNSW4yiy2vqZopsdV1bewG3/6cOH/jBP6hE92dMwsu/eE8n0sKNnZlm+CMPxSCkorkgKDhh+8QuXFggf9sjlmu7LbjBysd5EhCNg4sSRTlD2T1/fLLL7djmAWa8cGojS7455FHHmnl6o6z9fcqiYGjvMkhE+e1MqBnmASPzwDOyAy3ZpPZJQZVpaC0HIFEVOMCD2hU6ntpbPPzn/+8JXnBIFBUuqpJcgJlwIlEUvGoZoCXXuydpLKlXiE8JKgaVCwgWRtiox99YAHBC1JN4EuMgtd9F80zFIEtwLx1kiUWPhX4qmYkoB/+HGtIH5l6UB+yQc4+C27jea2RjDmvP7Yml+PGsSEnidnyh/NTjS+9fopU3M8e9I8d6K8KdYwvkaIk4DPdQzL8zzZmuwqArYuAKb2nztMNV6TQsRcHCFzBw+b8nEb/bOzo/swa+FCVL8lrbMiu+nCN68UKX/CZBAJbh2Ypr2x8jSvEF/ySRYJyrXhUQEjMxtY8SMcncA2XkoPx3EsHcWnZTxLbW6uSGJC/DAvcHMCgjMUxDIksgNp3G8et2YzNMYKLw3y3cbilJD+M4vC9NIBnM6Sh2gY4clsXBTx65EGZmYHr83AUEAUBogF6tuaHrZqxEZ0ZjaQmCFXdgoWM9BSggstn5xG3JKGy910g0VfgwotzErzr6asQYR+vr1p6mPMw1njGQbRIWtAiolSXsMGOsGlMDa6zPo009EE3M0/XSS5TtqYzfyF7sQGXYsVY7IAcJS22+ulPf9omKT4kn+vYDbGRSSIUR0iKnfR7XRu7iUE+YFs+5lsFHJ+qvv1dMzbW6CohuwY+HFf18xu7woR77ZG7FQz2co6t2NfGh/oKxkr74QjLt3xltgZvEjDc2CsG+F8Tk4oVMvAxjOvbZz7zQN2S0kMPPVQOsZvPVRID4DI2I3GGyowBvTrIqAzM0MCdTL6mhQQV4gQI4CMXxwpE5HvRVKNzqr01ZSz7ZhfBYaaDcACYPQFNNct21kOBTqML4nVOMLhXHx60SRxlpVWOU+uzoGNzwaORH6HRS9DBC9Kz+Q4nmoStcqc7As9bSXxFN3rCksBjGxvillCQ5VTTLzyaYagyVXiIBTmr6s1M2BYx00EznmQNUwgHkSEx99NnDo6MB4eWBSU8OHSvZmyzH+P5A2x8yrfwKzHxOcIyJpJTLByb5Q5Lomx6nRuswgYf0BPpO5aEgUN8zqoDvSVW9nGtWGYTPmBPG9zZ9CeBSyYI3IoGrLGZPvnZdTCRxheXl5etPPzL5vqGGbMG8visSVySj0SU5Ma/rnEtubxA4fMeW5XEwEkClCEFkoDnGFmdYZCdINZUCvm8lsEEF8ciEMAgEznyIxMkksBcS4ZT+5UwAZcNyU0HBMqGIVaA1thQAnadhADcggdxsjs9Hd+yCSDyCBwBmPVhguTkUwAAIABJREFUssKLpO28oOIfOqqy+MlyCYJAoLAjSdBPEuQ3urGX4+5TrXko69qpph/yGMf47kf69mRG/nyAzI2BSJBAloLYXMLjH+3wwaxmbFw+cf27777bJoAUThKC/x/buPCK9NiHTYwhWUgKZGMj9nAMIUr+5dLY2Ph7PgfH/EGfYCO49kMzs4YkX/4SEyFimDKjZhfJAtbgyvX689whb6clibKzIkOyUGyVXMTPEi8/hM9iOxiDS77iGzMLn3EdXIpJcvONgsMPGP1uyvE9tiqJgUMYmsMSZJyGABgrgR8CSzW2lsGMzbEax8U5iFflABAB21oynNovsmNHiQx5IQNER3ZkRd6SCBAkgLI5cLvWVFdzTkW0ZUOGAlYACUQ4ICuCpBtswIXGX2R2TlB5PuR3McjbrEGjvyU29yKHkIAKHHm6DikYd6rBoWvZE1HAbMibXGYIgh5psb/PAt4518Kv68mKgJKwx8Z1ff5Eh4fe7AKjSEVC5EMzJyTpWrqTUfJDSojNxk4SlqW0U3Qek23Lc+xrhsYe9MvvV8wcVd+KHDjS2ApWYMG14gRmYIstYUJS51MzrkOTtFX1vosvfvTDSAnZjCvxFf3NFvhUtQ9TxjUGnEo8/kMoPvFjST7Ur3iFCbNWxQRdxOUTTzyxeQxGr759lcTAQIJJ8DCSALJxhKyd70kMgL1mk6SsU3KQTdAJXkGsEhWAgLW3BvBsiPjYSIWkIQnJwdS4lJt9ka2NjelqD8QAStctGwKVmP2SNNhIohZ8CJA+9nQmP7Kml0AWuB7AO8+HjqnqBCsSYB9EYeNvCT8kMkdv/Zv+kxPpkJEMjpshIACzSwTlGnIhBnvjsPuhIR9V6VRD8HzjHrqoSiW5xI7XHjW6ihPPHWziB54ddz8SJAvdyWB88l7nRl/4fvPNN9sZgAfJ/CtmEwOwLEFKAHwDP5rPYoXf2Di2kUDNIj1TlCTwE4zgJ31YNtK/6zS4dM4YlrbgQb/Z+NjvGMjKH3zhmmOzvBX7SyDkkdTG3pZrB9z4nyqJgTFVMJyVgLVXDdgYLI5k2LUJCxiQkeCT0c0UAAx4OA7Bbl1R9+EC8amcrHcDnWABOseRFpKQJBCj5rgK03Xsq8oBZPZ1jYqXvbdskZdccCAA2T4BqSJ0DuFJZoha5WUvWSDHBB5CZh9kCl8CnK7uR7h9f9xsSnf3IldywjEbZkkUXuCajM5LQJb2JHDyqW7JZJtjZ7J6+4YdkHr8xyawqupEYvxPPz63GVtiIBtC4mtJhf5wIiEGE1P67vW8hKta50d25mO4VpkjdM+f2AmhZ/bpOnZj1yRKuIIXGPOWW55fwFJmquEFBWJ4wMzDjM4Y/Im34FCi4VufkX3+/2ljwoJrxaVkrynKvvSlL93rd6/2rpIYGD2NgxjSZmkjgc1wHGY7papLv6fsORmwAAEwBBS5fBd4EkOWXU7pt8a1wOa1O4SQpRW6sPFlM9X1lpcgSlMlOe9aROEzUhFAbA20WzaExdb0QvwC3PKPmYGgVIUhviQEeiNB5IkoVF+CTxOkSJtuAhgxIElkwrcI5KJ5sQDhntJcr3pEBn4DIyGwp72iApkjBv3DkyoRjpA0eZERophqrlNtInN2oR//GYPONjKwi/58NtahSVyWjaK3ccisD3sFABtd5+QgQcMB0uZnuphN0o+t8Qi7WHYTzzYY4H8rAZI1G9hwDX/ymZhhb8kEBzjOXvqSGOBSc42CUvx4ziCGxBmcmjXmR2rO6x/mFJ1kNrY++fLpp59uZ5htpzv+p0piAGjG4hSGAmqOZnSE5jwncjiyYsA1G8JAksYnB3lsZBTwH/vYx1pHrinDVfsWDKpiwAN+gGUzAYIskayljbJCFRia6xxHQPbuBWx237KRHaFfNkEqyAWeQM0bHL7zF9+oEvkMRgQvPeinD00Q6geZSgZsFFwhbVW8yvvUhoRDJggE4SMH4yMDD0LZV9+uRWBkMAP1DAV5TxU84kA8SD7utZml2CM4NkgcGdc4jn/xi19s1TFOZKI7O8GLZIMEEZn7rmsTo2wDG5kVOJaEITla7nFOjNun8HOcf3CQe/hDHJhxsCF/8akYch+swYoZt+a86/CUgoAdfRaHeS751ltvtc8sJAQbX8Eov0tkZPHq9NbxNsf/VRIDg+QBI2MydoDqO+BzpCY4OG7NZiqeqhsIOA25qJ4RiwdQALTHBpDIR8ADHDADGh0QgerV2qnzac4hUrZ1DbCqyvlBf3TdmjCSrELmptzHphq29uv3CKnYBaLAlEiQIKIo32enp3Mwl2uSGNgEiVtauUrxIdDhlizIwPhsq3+JCXHYQkqOu5adU7XHJ0N7/kFWZNePxCJZIDW2MaviO/YyI7GU9elPf7r1qSQocbIRXMOGve/ezvHWTIhuaPw9H4dRxQJb2OgGC/Q0u+JfNnecH/jGebZiV/c4nkpeoszzGXqLD36U+N2HB/CBloTLxpK12BNHYsc1Zg18ZSz2zswFhs3kPI/yp9D57jq0KolBthXosrCK0HfGEmgcwZEMzzGaCmDNhmhsnK8KE4BAZyOjaakA3GsDRH98DQBNd61xS2qChj0BuludCgxLHYhRINHdNcgGWQioLRvbp1iQpBGqBGgJCamaNQhEcqqUzfZs9ChfWaQD/LCD866FM8WGZMDv7GOsqzRkE0IQ/IgZhtgUmTum0EHmsKRSRRj2iJlcYw150dk4HmimX2SlT7Gi6oQBRZUq2bMT/kVKGrJzPd+6hs3YiTyW3rb29Zj+U+fIzsZ0oS//wj+ssC072NPdOXZwD6zDFCL3md18ZlPXsQ+bw454kGTysoJrJAT98q2ErE/4wlmuhV88oiCReJyTePTnesdv377dHp/ScQ/nqyQGGdbG+IxkusZxwC3IGDeOZHzHGHqtBgiCmLMlKcFj41gVl4p767X3Kd0FhyoEYapeVUKIT5DQASDL5MDG7M3+krBlJGSVJC1oyuunxl/jPL+QQfJCgBKd4EKUApK/HFdcIHqBjeDpzV/BDHJQQUqEzgt0yYZtLLVJ+pJNrj9VF7bM++9mwnDD/mSDI6QlGRnD2AiHrbM0NjUe0vGnmpEJXRGTmKAnnY3PVmLKfwfJ13QJrh3nV8f4WnOv/tiRPZNEpmTZ23m6I132ZHP2Qf5szP7wk9kEnuEP2OZ7tuMXxzPzSH/sgeDdy254yDKr43jLzBRHudc97AlHzvO/43xtDMd8dj3Z2P2HP/zhrUOzfHVdWpXEwJGpaICesRAzA3JCpoCcysGCHsjXasCi+QNl1hEFCvAgIbL58UkS1loynNsvAFrXZkcBIVAQqmrRO/706gIR6IEY0JGNDYCBHLmk8jlXtnPuF3T0eP3119vE54GfJAgnqmf4gRF7gSfRWRr07jn90vTz3nvvtXZRsZuhpuoza5BI+PiqTf+qVAQjEaToYdPI6hpVpw3GDg0xsPFUox/S4yvJTRKnawgIuYsPSckP4PhQI4PrbBICXOS465GXIkLCsvSxZoy1A6/0D7zSXQGEwNkZHvAHX3h5hG/iE4mSPRVGthQLxIMFduEz/cKFpO8anKB/uGFz17neTB3W8BR/O24veXitmBxsLLHgPs8szRaNcV1alcTAWZwjETB21vMRscaBgj4BL3jWBK3pPycaM2RjScYSw0Xz1gpQAMSeG8BlWS5EAtgqIrZDDsDoWNmAGbglEroDvftVmPSWwLdsghwuTMcRm8qfvJZrzI4cR+iwJJkJQPiR5OmW5rzr+VohQF9JVFBLEgoA/j4XZ2SRhPXLlsZK4SHBWUJlV0SFPMiFxKYaAvvTn/7UJoOSgBASv8VX/jpnsMqPbCaBOCbm2JM8iNHYyIk9vf3Fftex0QlOFQ3sriLnT/rTna/ZWkHB1vjE9XyN4BVPZo7s4hVUOPGaqWTDh2IH2fOt+JFMFR/GFV/ZXPOHP/yh7Zdf9A+P8AtrsOfHmJaQ5hQEe/JFlcQguD38OjYPYmR54AVuhpZdJQtExwmAy4hrZlfA8PAZgMhmL3CATMLgXEGkkXGvDTkICOBnr4BTgNDxoklyCKZszqlA/eKT3oIKoN0LzPFDeU/tz+RB9PxBXrLRUcAKXNUw/DhHfyRgr1JM0wcfenhtVuFeuHOPTaBbm+/aJ/fP3bM7m1mzNl5ksvfduBIEooY12JozJvIhO1/Rma/YQL/G4zfy29LIwg6pkFNgITjJpZRPgvWK5ZpxFrnW2NMFl8AI3MIDorZXROAVM0UFjxcyYMYsO5tEjW+yVCehBFf8JFl41shXZp76snkxAJ74B2coeskiCfhxJb4gh6RDrq997WttUbCGDdbss0piEBQMJUg4EtgFiyCx9sfQjIgAZHZGXxOw+hdkxuRQYNJ8J1e5FrznxCDwETx7IgyVs9kY0NPFbxqy/lyCCFGoZAFbMNj0IXm7fg9vTsAMcqcfsoMdQUo+1Z7lE9N+mKE3ovQDoxI39My9iJG+yAAWkyTMGsp7Sjud8hkRsRufsK1xjUVmYyl+jEV+10zhSrJT2dONvGTnY3bR4NRbLofOunUSkj29ysREBktI7Ce5iANEmT5P0Xfra+nGluxIfjZmb41t6K9yp6drPA9wj6SB4BURroEvNmZfDcnjIHuzKn61nIcvxAjfsqmEYtkoS0y+u4dNxZ7veMWf1Xb8urUqiYGRVDwcJ1g5zJ7TNEbnPBujcswSwTrkDPKoqAWtSk/lLViNCTSqMAGjkWmvjWzkBlhEBIgCRMXIhn/+859bMsoadPQAXoBnBzojodgcCeXBXK7fak9uQai6Fbj0kwAEvqoObhCdtVzrwnAVciAz3eJHOtNTkCIJ+upP8lwqcI2BrCxh5A0w8qogFT/0MKbEzf5jjR+PzQybX+muD76mn3H051mYwqpsMOFeZEl3VS9bkcM9ITakKAYkV9etGW+lfEt+xh98xyb0FMfswU78Cz82OHFeMnA+b/KxLRvQXcEK+67VfIYNfOSvJLA/27Ih38ElO2s+O25MxyQaMfjd7363jaX2omv2z/R/MbWAQqo15MX4AkOWVaVyUiqr7AGW4Rl5rSZQTNONSQ5j+Xm8B4SIJglrz0khtkHilkXoggwkNgkPoCVjU+lDU1V2A19CZH8gBnp716hSVVF7WGaAhYtmOcwaL2KzpCLwzBKQPB/CCmwJRAThf9AqmySA/DQzVPizbOA4PPK/z0s1MvjBmb69NYbULTcYx9KHtWzykHMM4/SRAPQngesH+cAkIodX5MUeZT98yDau5X+Y8KxJkqG7Y2bJYhIJSmAvvPDCfy3DLWWLGv3Qg135FEGzBZvBjiaWQ+DsxTbOa2wlicA/m8JX7jVbdR5XePbAF3woTvhAv2aIEg47siuMijuzkieffLJdDm0Huob/VJkxAKUqimE5RlXFoQiM8TkhGdneOY5Yq3EgAgQEThSEAs/n/L+tSOQ6NPYDfH9ZlB0lXTZGnhIC3QC4WxW7z6wtsw22YPMEg6rW+a2boJPABD39yEvWYAYBevgLM46bPYQUyC6I4e+NN95ofS6Jso8iIH+K2xgIdKnG1qpTOJOYyWBMyRuxeGjqGQqMsXdfsy7Or2ZB1rvhE+nQXxzpS7UrXpATe2jGMi6/s4fxLCEhTLMFtmEzfTnnWv35bcSSNujTaY1jfCfR4Re2sRzKXmzjM7uwgwICRuiKd3xmX39FwN4slC0RfpILLIkBsSSpsB+72uDR3rKcJUKbt4+8Hee/nfW22HW0Z3xUJTEYjPE5iDE5wQawjA+ozjF+nMMZazXjqeKASsDaA469ysOfz12yilxLj/Sr6vH2g8pShQPA7MieggZxSsbdhsBiZ0QB7ALDMbYA+hBO996a38kkQOmnsuMjBCfw4Iq8lgxUbfDEHmVTBareYU8fKszsvZWigs+sorzvnM/wJLnm4TfMsSVZJAMJStU/tIxD3mOT0LwMYY/wEx8wqw92QID+RHSZxM0MkCMcmEH6zp9mMbYkKDaDC2RJf8txxrluzXM1OGBfuIdj3+nlmD27wzPc0DmFkoTrHgUVu2julTQ9Y2B7sWGG7V64SZLHYfplW/ylD8lJkl2zsK3hnyqJwVQMUDlMECNdlZDNd1tICjBlc8ZeqxkPOBCOZjxJSqBwvuzvc9mAYa9BA4SCXyVKxiRZ4GZzVaFKpq+CQUyAj3SQC735RTCpaBNApS22+Ixo+cw6skoQ0WopNgQzolTtWQ4sK3HHYNBrqmzALmzGVshAwvDr6aWDmT0RBwIxc2BnGyyRFWkhYzgssUUXSzwwKcnxIT+4xuY8IncfYvOsoZzhOi5+9G9sNoIP8vhMZ2SoH/2RyW9i/CraNaUsW/j61DH5DSYkW7hlE/53nJ78j3Ngm90lkuAa7p1js8wqXO+zxP3yyy+3sxEJwdtJiJ+92BEG8QXfKsDYkC8s7173ViUxAHcCUqWOqBiSUZ0TKIKVkziMY/pIbClje63M0oumqhOAwAIggkmFLXmUjYwl2ZTn9vCZvP6Il6CwAW4SoCWyQ7OsRNduoxOAe8MCQdrcxxZ0FjBr+qIrz9B3fpHEyKrit3cMaSKyVNOWFCTBvllD+YaT6+kpCQp2Sz8Sz9INwcA2YlZRkhexaMb12rRx4S/44j+FlPN0ReB5U8zew1O/eEZcZkh8JMGksYfYguskFH0jfZvEIGFFDp8RKszAvu/XrfGl/6eBrWAYz8CIRKDRO0WQOOAX5820zaLECDwpPCRZiReG/B8QruMP2IKbJAZ21id7SsAS0TPPPHMt7df1d5XEAHSCAoAB25qxQLTOi4AAUuAIGkEhMdjWasbgSFNthMjhnKuFFLvEIrAQ5V6rKQCV8FQvwEtHMgsU9rf3ELLProJENW0ZKg/RVEiWMQQLf+2h0QdpmRmRj178xmf0orcgt9aL8MsGe1p86F73IW2FilmjXygv3bLMoFrlG37JcgfZEZjlJvGAvNhbskBEvtM5m6rYzEc/zkvYljj4D1nBQJq+kaKYEl/kkCQkIGvsjksezrGpPhRr+jg0RYRz16nxH7uwLRvjE5/Zha6ZIRybpSHJj57OwTvbIP9c737JRbKFEbjKMx82cZ3mnOcJeVb67W9/u12uak9e83+qJAaBh2TsvbJnj4gEpyaDMy5ncSCQrlmlWpf1dgiykJiMKdsjT6SDQAVlt+01KURO5KPyEdSIAaEAr8Bnb6/h0rfbXCcI2MG1AkawIFEJ1NIMn+yh8RNsWGpBaoIYuWu+01cljdzKxib8Z82dnfhXRa1QUbHrx0wDMS/Z9IekkLTxNLZENuRhc+fFh+rfNa+99lr77AAZqYLpJz5UswgMCUqAii3Fjbe27K2J85vGh5KHGDPzgAcEyb/6MQ78871r4YKNxGeIs+3omvxDj+jls4QbO1MBx9DdOS8dsDts/+Uvf2kTIjzBAHwpMnARm/j1uYQsGYgHe/jjVz5hR/b73ve+d98kBfaqUhYwsEqFI1LBCgYgFpiCJBU6AC8dnBQtm0BBlBIEOQSE6bkZjKSAXK5jQ4h+9GT5AVGYAQAxQqCrKlvQ9zVk6dmKAGJ/fkJmiEUw7amR01tl/hyB4ORDOgpqZHnZ/H8MHsh2Z0eII8HtejiAS0sHyFdS9YBy6SYJKYbIBmtkRjCwbnwkZHxvxJmdSRjiQaJz3N76uXgxu/XfmYob5/TnuCSC1L3tpNHdeTryoev4kV8levc7nmRoDA3JHZuq+tBJrO3Jnf+DZ7JcyK70N3Oku3MSqnhIkQMvjmVmJdlGf/b3ENlr2/zDN86ztY3v7CUNf5ZE/NxPrcqMQeAeG7AJSlmbsxjbXuZWxQE14uIk18V5axgbASBOIDBlVIUJDInLmqPgWoMg1tCl7FPgA76EAPBI3maJxINFZEGvoZmPQBIAqte8TYPU2EayWNMnpR5Tn8kCI/lvPOHLpsCAJzhSfZfr7vpEBEjC/YLaPWwm4OEPWSsMhuwzJdfQeXZDJMaGOeOzqQoV9sghOZFPLMCne3znk6x3O4bM3U9XSyc+87m40k/eqyeL7xKSsUJ65BB3/JoHpnRXKOnT7Al23OuapW0xZKOljrOv5WH4ZUdLRfyKVyzXmTUrEDR2sTQnWeIB9g5GJBIzC3u+YXu2SUzBGVs/++yz7fOevRVP59qzSmIAZhWeiglpCQafGTNAFDSAqanYsyZ8roJ99wMPUBhT5YgkjAcUZLVuKBj7Ghn3HCx0EBCAzr6ZpYWMJAeB36cDO7jOtJp/3KsvRMtWkspeAoAOcETe+DN7JIhgH3jggda38SOdEaXkx/9Ilz6qS1U830sMbLh0IyeSUhCFVGAOqZup0gV5ITSyiwHXO47IyIicPFPgF7LS05JJdPGMSQGAyDQ2ch29XcM+CJ8sNiRnBgIr/O2zZCFWJV3Exy7XqbEp/B6bQlTiTfKlHzuIa7MljW3oy/4ae8E5n5gBWJrzne0UInCR2dYnP/nJW48++mi7lLSXmGiVWOifKktJgoEzgBgRJwEgIk5xzKbJ7o6v2VRNqZwECKebOqbyGpsW9hHqmrKe2jcga4IcESBC9kcCmsQg2LN01x4s/skUXDAgDIHmmP4k8aGlqKKLKh/pYUkFgQpwmBK49nwqWC2pWV6LTQiGWC27IF/6sI+1eA15WBqwhLB0Y3PELwYQvqqdT8xcVexsLQbow/ZkgkuYTMUrEUh2h2aZhz9U+fb0dg/Sf/XVV1tCYwN9OQYHcCsh6S8YRoSf/exnb/3yl79sr2FH1bOESda7d+/e+ta3vtXes7Q91uoPd6jy6comNrMpmyKHDdP4ge3ZUMEqaSh+gvlcx478xY760cym7udWJTEwqKADdAYGSAHMeQIFGF1j7xjHIG7gXqMJKEtGHC4YkYhKwIMkY8b5Y2OTPwE2dt0W56zB04/NyYkgVf30Ui0LAITZ19jfFNp0nE8EEr8hC33wXXeJpq+fGsckLGTmNwiIDAn6Hr8iSTIj0/hU1c0uyABJqr4VJwoXukoia2APYUnGsEdOlSy80SFVuedAHjY7JxnAIluTl1x09AzCPfwkscAt/zivbzFkS+KXCCWfVM50lIQkEzaRZDyP8fq2WLA8ZYaiOEKW+kSWrr8uze8I2AUONLKbednKotNxeMgMjL7sw/b+TpIlWFhQRLAf7Nvco9i6n1uVpSQGRDI2iQDAgROxAh1QIx5OE6zIjAPWmqIhSq8EIhFOVzkICt9VEEAl+MbanhODgBDQquEsB7GtQEAiztNxKNgRjuqKjshDICAKhINEs0Y7Zp8a5+ih+ocj8glohAlPsIaAPbSVKEO+5IJBx/kcaUoeEgUC9ocH81dpl9YBpvkB2bAl+eGdvOyKbMQBHTQ6sD39yMon/n9nFTGckt05crvXcxW+U3zpQ/yYWRnP8pKxVLpmSpaJcsz1+kec7oER17KnZRlEOzaLXtpO5/RH13fffbeVG/7pxeYwy69sxFaOiX2bWQVOkkwTE+LDtc6zr409+M39/HI/tyozBiBTkXGOalVSAELHNcHgmKxstgDMSJoD1mgqMRtHAw4wIQufyQEkUy0BtFbymhp/6rwfQCEHwPY6I53YV3vppZfaZZihZSG28bYKv6igJBcBg1TMJOz3MGtAijbrxOT0Bo6AhyHkl9mp5IGUHdPoZqlGsPOf++1hQJGgas7bPe0NC/1jhgDbSIesiB/e+IjNJSdFCz9JFohKjEggiEjykODoLAGkuCG/JCG26OxHWY899lirL7/FjxKLz5qkqQ8xqV/VsVe1YcY1GUNskI+/E68LmWOVbhA3+ekhwdno6hj96cKW+b+vJTzXKoLs4UCi4Cv3hhcc5yP3lkXGKkrsoNMqiQG4/Of1DM24mT47jrAATkALVAnBMYG8VmIwHfeA2dRdEAINucgnWH2f04Blrw1B5PcYiCjkLvkBO+IZm/VI5CErPolfJFNkhoSQx9YNqXlQqsELUkcAZPe8wGyBP8kvWbILMhDcdPGZbRABYkAiqQ7ZaOnG5ppqnYz57QFZkLilJIkALvkKJiU9DztVvFkiojf56KtJaPoTO/ry/EUihNGQnIR+bB7K0lFi0jfbsAF5zEbERF5thhPj+QOExrLEuPdGdzFsS3xmT3Y2oLeWWRd/mzUemmU1uIYN/ON4OEFC19jyOiTIVtgz/qmylMQx3nQAcMBU3XhNDMFYAwVKwDNFVu0JjDWnayoCQFAtGV+iMrZAEoz+3gmAXOeGtNmUPoLfnl3Z2jICglL9jIFcUFha4TNLU64VPJK4z+7fuiFz8tGRvIgBQdIfAUoI/J2q2u9VLI/BlySR6g8pu1YfZhOINSS8pI6KIbgXCxKYCtdnsjqXP9EQn4kdsrE/UpPoHLPxqff29WejJwKDZddbCmEfNkFybOIe+tPTOWP6LgaQIVyIQctHjkkaYsUx/Rl3zw3ZswlbSJL0Yz/6wqvfJdCbjdjcygW7ZJbGF0kScC6G6M5G4QjX3++tSmJgROBkZEHLUQAIZIKTo1QwNg5FOjZAXaMJ/L/+9a/31t+B4tAQngeylldU2GuQwhq6jPUJ2L///e/bytl17M8PgG39VfJzzVCTSBCUAOMb99irKLU9LC/Ak9c0EQI8IQCEFtKXAMx+6KK6hqlU2ypi1/K7d9ztJQ4Fg6UV9lq66dMP8ywZISHJKHGB1MlpBkM2pJbNdZKbJRC60VWioHcIn69cL0lYPvP8TuEjljTXpSDgd7aRGGFdX+LSctLbb7/dFnKSlEQiISBV94vV9Le0bZboDz4Re2ZF+ITc7EJnsc2WbOh4ZhfiIsRPV1hw3kwsXGW2wEY3oVVLDNZDEUuqGkYGSNmYIwBUYNgEuwBxfI0G7Ko1ADF7QRgqNwFpPR5okMf90JCFYFFBej6QpZZUm8hjLAkKFomBX5CCa5ErWx2aZLpW8j7F9kjUA0eECGMSPfJCBscNG7bhAAAgAElEQVRmNoH8LcPYkL7jfP/rX/+6/dMof//739v/pQvu2CN/HZPOSzdkIxGEuJAYwjej9sNC8oXwkRVZEVOa+CEfUkd04oe+9uR13P2+myWY+bjO2rqxxBV/kkNfrpNMEZ773SsWjM2WEhjMkFHCyAw78uxtnzeL2ETiZWu60gcmxLZkQFcxTn+zaDMjnzObMqt2LXs45zPb3ZRWLTEgYEBFKIAGqPaCVjAIFMGKsIBURQTQgnXpBiDGQHqcngRlLCQDFCGHpceu3R8d//a3v7XDIvFUUJKFitA7+5L0UGMrCYEvBIa9PhGQoBM49ls2RQVSRaBITYLQLBMEd85bv0eOcKd5dRdpIBCVt+P5y7vwaNlmrWbWym7si5g89/IZBiUDOsTGfMb2bO24JG+GE9y+8sorrV/dhxBdJ67ch/x8ZwfPXIyL8MWZjf7GRIjGy7KS5GGmIA7ECAwgUzKaVbtvj43f+B0O+BNey6RAH3ihuxhgF7yjgDo0hQ4/sK0k4V48YVuDh/Zov8hULTEAGmcAL0MDmA3obI4jZU4EOkEOpK5ZugkeMxjOlpRsKiGAt0/QLT3uFv0hH1WUyk/Q+My2ZmPIw3c6C/yhhhD8xzHu5zt92vjTcxl+2rIJYAWHyldlBz/IUALzmZzkVYx4tmWTFOANvmDTZ3oiYPooTLygsEZje28gGZfclivI5gUNvkFK/BFyJzs56eO4ZSK/3cjShsQiSYgdlb2mCEOQEh0868t4fEhXtpIQxZ1CyBh0Nw4fSyo2ttMvwrS8Yhz3iNk9JgcrAWYEZJMcyCsB0IFeiiN2kxzEBPsfm1klTLAZ2/jsmrGYWAMXe+qzWmIQbAydqhMAbV6ZS8UKqJzIsZwq4Dl26QYkKifVlz0gaOQRmMCjejqluW+PgUIHpCAAkB0ZEYagVyl5n98PnCTHoeY+hMJOiAep+S7BqsCt4fPVlg2xIVhN9Zfql15I8KGHHmqDns+dhzU68Fv+kBzCRoTO2T/88MOrqWRc45AbHtmYbdlUDLA1efgJgfEZ2eliuUulK5HBKv+a8fBB/svQPChWNecPwemT7hKPvm2KIzGYZRQxQBZ9safP5EuS0J8EYybi2j01vAHPdGQn+9iQ/WDfNTZ64BgJDg7EAp/4zJbsJ3nc1FYtMQCgpKCiU/kIWIC2lzQkAI5wDkgFTMC6tHMAw9IC0BsbgAQC8B+b6sG4p76nv9ekwHZ0RC6qUp/pqcpEKgIC0RyaaTSbDzV+QQTshChUjUgMWenL+S0bn5FJ8UEW1aFZg+MI4OMf/3j7aih52QEBuN5ecYBAVNYePiOFi4uL1i5r6UROZMXmISsJAaGxMTyRScwg6BQtPkso9p6r8B15LS+ZHdDHjIKPzea8sgzfPvO1AsE4xhaTbMCfrrGXUMWFceGDj9mTnOSyqarFqz731PjZzJZ8ChazYbqQHelLpD7DhtmB5zri3HfH6ewzH7CbpHFT2zATrGARBgd4zrIBIrCWzgI8QRAiWkGMFuz+PwbjkIMMAtW2N7AvoT+bWwa4bP4ctWoPsVhnRpqS8W9/+9uWFL2xMdQEjMpSQJkhICbfs6SQ5Dp0/9rHyUcn1R6/klMShKMQgmcG3sTygoHnK/lja2zij9eZCSGKb3zjG+1f4VxTZjKRhQ+SuPnJBo+OacjZujjyR/aSmNkMorP/zW9+0y4reVvJMxR6Z3nEvfqn3/e///12PP/9ZJkIJCUJgu/JpE/x6BibKigkEhW2ZGIcCUuCte2JPCUxjQ7Buc/khnlLpuI7M1zxwFau1eCZbrbYvz1xA/+pNmMA2GNTjQO9qgYhAx5i4ghgRDaqOc6S/ZENsgbSJZuxgV1wqSpUW5KWwCMfMHld8dSmP01w762pBFVIbMuu/KFaZGc6I5GsNQ/JLlgEn0DTjz6Qg2UNBKFC37KpYuMDSYI/MztQSSI1wY9kP/KRj7R/QO727du37ty5c+upp55qfe5hvKU1BcraDU6QtKVU/iE/rLMxko4MfGRZi70lPdextYSRWTi9+JFfxBMM8xesw7Z7YDrPF4yhLxhwnwQh/rQs7brfrN55M3vXSxCSr0RKLpX1Xhrd+J1O9KM7e5I/RRBZHRf3cAvLGty4Dze53jMc3HNTW7UZAwcxPOfJ0BKBwJXFrVcKDMeADyB9FjhAvXQTTH7FCQSWDqxLkk9wJHCuMuYeE0L0YFeER1eBwRfs77ik4M2lqf/InE8OzZKTPlTi9GVL/hJMWzfkxY/whSjt6cenIb3IyAYa3dMsidVsfJB1//fff78tlFS0SB85Iyvki7wsGal6EbNkjNjoa2nWjxD1peqXCJ1zL//mNxxmQ5KG5OAe90pK+jQGf7KZBCKpKNo0svAvW0pW7CuxmlkpBtzr+B4aDlHcsIHEILEqgsQ138KCpIlvyEw3dmIv2Kaz7xICe9zkVi0xMDZAMr6g5CxgtgGoJgkAqo3T3OM65LNkMz5Q699eEAoI4BAUwHE/Nu+0+zs6CEMFxc7sz8ap/FWhY43NkIolDbMu31WVgs7SjMDcqiEtOiUhkINfBTmClMjo67o9NLLBvsSFzJBYnhN4IK5o4ifPR9gY8YkRS0bsjfz4AG5/9rOf3XrhhRfaa/TlXskalumcMRC6ip8tJBy2QPz6EWewYZ8lVX1LShKL2HCd+8z+Nc9lyLp0jLadn/hPni+w2eGDZ2b0NFPmf4WgROb5g5kFHdgmOrqPPdjoprdqiQEZAw/Dc0QyuWQhQDTHNckDQDmSs3K+PbnQP/6vV0GGNIBDoKU6Eqy2yLPQkJt3o0oSxCpHZMC+ms/s7M9Ue6slSwl9ArOT5PGf//ynJQqBhjCQkao8FWrfvTWOIUPPEPgUAZBXtUh3Lxz4e0D8vIcGX+RCXuSGx2COb5Ks+cbSl2stdTkuIVsKoacYMlvwuqvXSmFbskfgZkR8YqYgcSNMsSWp6Ec8GlcCcY+EoG99kktTYXugLbmQy9714tmf61YomEVs2eiA6OmEWxQH5IJtTXKjn2dLznmtla1xDdvjJ/fZrvufw1nCD9WeMQASpyERwORIDkLAzqmGgBTQneMwm6RQTveXUFof/sN1RKES8rdVgF01BCQIZerPRSwlR+1+BD6CEBRIU/CbcvsusKwZC6Kxxid85l4EkyQv2DTktFWzVOBPdiAB+oVgzSRUiRLfnl5DFAsSNZL3GZnDID0QL9uq/lXmmmOKGVW/ayUL/pOgHYNb+BVr+rNMQnfY9sKFpI8wjaHxYQohJCrmxKiY07fGjr47z3auj3zsjFRV2a7bqpGJnvShG7vBpmJFUpNcFQSW4vALu4h5doILidB55xQ+Zmg3uVVLDBxmmswZnCMpcIKEgIgAUmIAPscAEDB9D0CXdJS/CeNhHjkyjUciAkjFqcKyzHTVFuK86v1r3ceWkoDgVxkiF0QjKNid3J678MdQ40vXCkD+kSgEVsgCSRhji4YkLbUgW0TpeQg9+dLMgV6S45h+NeUmGzklVXb1ne0SF4iLP8olPnaml1mbhOKzezwjEEMSM/8ibAmDrghc0aUo8JsORO/aNOeQK3y4Ngko511rdiB+2ViswA1bImSzCljYqsEtmWGRDSVAcuIYtlAQRFYJjF2cSzJzjl3FgyTs+01u1aIX6AEX0AEv2VpAqGysfwMwgHIypwlmjluDZNMv8AgG4yI646ogyHROo+9em1mBYBbYKinVlaBA7pKkZCm4xpr7+NCPsvjThswQsjdW/Dnprcj3wQcfvPcGFkIT7MiTz/3xxB/96Ef/RbRjeq59jo1CyGLDZyQPl5plIKTWbf4MtwLL7Ah2PfORYGCZ/ywZKq74RAGUWZ6H3XDuHj5E5hKIvpClJt7gwPJQiFO/PktG9t7kM6YY1bcZuDe7tkoO7MaWeV5IDzpJnLAtrtlHY1t4hXuf3SdeJUu60eemt2qJgaEBCfhlcA5RCZnWys6pMAGWw1yTIAHgpUlGsAEH4AgCwYFEkpQSEOcAZI2Edo48uRfw2RwRHJo1Z8lZ8GhsYpotwNhkrHn9E0GYZQlCfrIdmyUpQWYJZIumAKEbHRCrz0nUEuJenjGwDcwhcITKdghMDJBZDIgFx7oN4Xvu4O8fudc1MOu4ZRD+kNz1Ad+SAXvAvf+/QlEgYUia7uN/MZbZIxnck1kz+0k2xpP8nbN3n80M4sMf/vC9Ja+uvGt/l/AsC8Md2elqWc33PPfCMXm24pzPNo298Q1bLBH7a+u7dv9VE4PppiZzq8qt8XOW1yiB3FQQADkLoDlIAhE8SzekjfhURXnQZmwBZl1yqTH3mBzoLSH7a6vsLKg1Sy1IyjMXvvJ5rLmG7dyfKsxMS/+SiweiIeSxfpY+x3dmMn6cRS4BjxyQHn8n+U8lvqXlGuqPjZC3WCCb6hzBWxLig5Bz934/WvTataUzuEXUdA1R+9tfZm7ulyjgGmlaRn3uuefa8cwubGLP2PCAVG1sVzbyIH/jIVxkTOYUcGZjlryWLuJKGYY+wxsbKvTombe4cImlanakI7tq9nhHglMsuE6iVBjtBRdDutY4Xu0ZA2UkA8sPwJSKMuunvnMIkKpgOVcW5yyBs/T0DoCQB3mAyhiqaGSX6fvUcsqUg/Rp22MTJEhAQwiIQ3DYHz+o+BHBmPz85d4sJ/EVPwpCnwUkktqiqYRhiJ8RmQeyKTgQCBm3Wvbo2gPBWr+HfUUT2TWz67wC3JccxFFekkDG9FFMOc5vdOYDmBY/lhD5VP/+NzszFEkIzt0v3thIkiGLRAMnZRzwuT9AiUARqiZuJF2xZEYS8m1PVvoHwcOiGRbssQEdzCLoyd/Rw3k6mO3COluJeb+MV6Aqdm56cqg6Y1CRAhvnCVqfOQWYndMCbkB1TtViv3QDFEsK+rYUgiSRomAUqCoxYL9fG7vml86CP0sR7M8ekjiSmErIyMYMA0lICggD8bhX0JmZbNGQoR/tISkBz798iyzI5QEjDOyhsZ0YyPIRklMcOS4ObENNZW9Jz2uYyEw/krFlPASI/PRl07+K3kzjvffe+69na+wkBo1tVoFkzbxSPGR8BOo6y8IIVByLZxjSv3EOzfJkzUZeG3kkOomKDcjDBmyi+KOLhCHJShLOsbHj9maY7HPnzp3FVgxq2mHJsaomBksOlhpMPYGYE4EPKXEOcHFcKh7X+szBSzfgUT2ZcgKRQEgSQm5bVbpL6znWH9IW2BpiyPMfFRZfIfipxMB/lhf4EuFKKCGVy8vLtqJV1dZufCn4EWOINv87H3npRs41io5TdYV7ZAV3yArmxYfvjsPqWEPEfOkHXvyJ5HxPIaY//tGf2Z3zdJc89S/OFGkSELu4z/UIH+FK+MEBkpVo8+IBnDgGM2YnZECuUzKP6XPqOTIoTtgxyZHMEgU70EFBQCc8Qxc2cd69jsMKLNNfPze9VU0MKjREDIQIhFM4LdUrh6hY7TmPk1ItSQ4cuFTzdoU1UUGg6gJunxGk74B+vzeBQFdkgjwRhu+Cid0FEf+4bqyZefAl25kpCE7+QsoCcotGBrMCVaBGB8s0iBe+FCP+WB6Zt25s7hVftiMbWW1sn1nzmIx0ffzxx++9oeQ+9udXCcCzPESpuVZBZEzVPTJ3TsIQcyprccdOziVhleP7n/AkEzNL9pUk9KuwMHPxS+2aiSHFJgyb9eMTHEMm8nnWxQ4hf7qJd7a1sblC0Ge2+f/W/Ni4phE4QHIAQM4TCKoSDkNCaWYUgO0YgpYsOG3JJjBUDNabPYQFFBWUasdYgopc93tDCtaiJQUVpeAW8PzkDRSvRU69xYPEEIi/3CkAfTdL+OhHP9qSzFZVGF9KDkgClsiBLFSLeQFiD4nBD7DIpDDhA7EhRiTVuW92udfrov5u0rGZuSF9fYodW5Z7+BlZKsyS9D2EFQuKAUtFllLFhRggh7jwTCJNXHjzCxF7mI9o4UXhJuGK3/Sde9bcw6xx2c5e/Gb2Q292wCf8D5uKGMfYwrGsYLj3JsT8HF9UTQxIA4g4UIBaw7dH/mWFzkGcB5gcZy/rA/iSTaUB+MgjsxfvhXtg5RnD0o3+Sye4c2VkU0Hkx4d8wd6CiA+QfSpJ14w11aVgQ8IqSGvQggxZKAAs3wjKmk1C8/sYJMjHkgEZ+YGuW81mujZQpYsLGGT/xENmsd3rh75b4vEbEv3oQ9xIfF7w8CYSfyjOxB/i5tMc53PYFGfGZSMYsEkSYkKiTVNYSULO64/PxTPM8H1mIrl+zT3Zww3sRy82UAxIeGLcNeSUBODQcdjWJDj304VdJBPJ+Sa3qolBUHIA0CEQQBSglpdsaUDNMQDKkan2cn6JPfCYPgpIgUmmQ7NWC/CWUtaoHIyxt8TAlh5eWhsWPKbiCMXbPIjVX/386le/Olm5IhxvdPh7PXREJpogs2Snwqw9TScHokB+wVTWnj00d75mZdsapOcfMilS2B3ekZrGH2Jgroyu9VsDFb9qWH9mf3SHZwlaotZvCBL+ESRfu8dsA4EiSXL5LIHyZ5kYMtMyM9GXscxakHAKrgceeKBKMUBHNsIl4pps9rBMX8fZxmc4tTcLIjc97aOz2Qf5b3piqPq6KrCrLBgeSAWADVAlDNNRDZkAmoQgu3MqwE0tabQ3z/zH+KbUAISwjQNAjps1eFBZJquZ3U5etsfEoMqzJmwvINiAP9gfUbCDinuqSbRIGJEgZDZlXzrrY4u/WsmnXvkU8JKdyhcGVYlIDZlt+aIB7Em+yElckIvdbL5bkkNiCG1O40NxJBEgSIRp0z8bqJRDkHyjWONvBRFydC720I/PrtNcEznYlYxmY5q+HTMO37O5/9MgfbUXrfRPfscBr8ant3FxhqRIf0mPrdnX34yiK/s6zgY4RkFIf5/h4ia3qjMGhuYoxM/4gMRZsrZjaRwrGABS0kAswMvpnLhEU00Ab4BOBkEFEBKQamnpRg/67i05sKm1YqRpTdsMgj8kB4lboM+RGxkhMv0IOrNCCYfPzUj0jZhqNuSm0uVvmDM7RAqeq/wPe/f2K0lZtQF8/pSdeKcJF14pTGSQGU5yFhUNQeIhJhoC6jUxMVES7zQx0cQEETESOQjoIOcZwCAQ0Hjrzf5Tvv5VePiKorq7quutQ/feK6ld3dVV72GtZz1rvauqe8uCjWfM/+28ba5wh8CQl6BMz3AO9wTu6bErHvmMx1EFPfMWkLXJNn/961+rudODlYI22Zge2Ng5xoHwYZQ/uN571zinLr6zoB+BVr/GGn+SdAkWgsmYok/jSlXB+GGXDo2NLvBM+MZYfMb3YcAYBRHzdW2CoxvsJ1kmXzFk6YaMGMxelOagWREEmJwasNQr7Z1bilSBwpeKAEPtGXEAGCL0WulDcCotpcZfelwc5/nnn69WCFZMfkiQsyEPBMFWXttvEjZEOhxMduZ8c5ZZysiOVuW6KUXfghQ7wxkxD/Vw+GJvqyHzn0OQlFIbfdGVsSJXfkL/9Gnrs9oyF5kwndus+gQAQVofArVgQR+CkUSMfvSDHB3nawjWsZznmGuDYcHAMUFMADFmfizQ+Yx+3czO+WPo1xgFpqxw9eu1cdGD4EWfxugzOjUenOI8WNWGVS7dnz17tppz+GaMMe9Dm5MHBgZQ07RnLMYBIJl6HJfilJKAFcBDLowtaJQQgUEWC8ycEjgAyWtZJUeUOZ8UoWNOTed0gjDpRObn6STlDk+vIIZNIuvkVAIAIkLAiBgBIQwrkzGJom1sMsL6ihP5hThk47JK455LkBVcC6TwR1/IjM5S0mQbNuoqgnl+8E5bbEn/2vT63LlzVaAWFPggP2MbPuCY8TgmgCBevmp8fFQ7EccEtuNV8IEd58KIgKL2776S/scS91M8Fi2pQ+xsbfzGDWeInj6NB8c4zxjNw1xhFU6N0R72rTSSPIw17qW3W6Yu02OWgM8ZRWpAYhxg5ayMFxHdQ1CyKoZjWMdLSJwvy1B92Dgf0kCMJ02QOb2wBV1wbBkXIuF8bNdFOKa6LwJJBmnPdtruQ3Bd+tt2DhLQJ3KDMfgzRrgjMDCXIDNljZBUggTsey1osUvfhMic3fzNT7/4L2YCAD2wpzo7m/ApTzMhSPaiI74WW+lXUDUePiuAuibB3WvkT6cSKkQNN9owfiuG+qOupfVsdQ+X8VnzMzZz9DQW/Vo12ZuTudg8IqyEJnFJkqBCIPlhC8dPskweGIARWBgjJQfRvUk6QMq4BDj7OsY2o8qoZAgyHqCXHQG9fh0r3V9zPMlomsfnfI9MfFHKas6KzfcSBEgOjpxkht/+9re3DhHhKsVxPMRkrgIOx+RwnpyZWpC/n95maxkh+xtjPYh5PbUIwMerbBuh0TN9wyBy4xO+0Wt1a/WqXNNHnI+w+VtwjfSs2JVPYVzbNjZzXD/8gH86ZmM3YxHUbXQpyBDtua9Et/SX7Nv4XaskefXVV1fn9Rl713Pzi83ONy78AsfE/I3DcXimYwHRisHY6D5JkADjc/MhdOa/5Z1UmTwwACOiSPmIMzCGPQPKNAhgxsAM5roYrYSxtGcDestPfVsCA4ys0n5MAdglCv1zFvsvfvGLlV3oSNYVYqC3TeJzNz6dH1KhTwEHCcneQiyb2in5mcdTj1cEjCgFBURggylE4cb4HIGBL8Af4rWClpTI2mHea2OSlccX+ujENUqiMnj+JNGid+RpBWgVEZw75hzBPP+kythck+w5fui8uggMApokQNAliNUqBG4EoTEeVaYvtjQnuOLDxhA+8d0ZYzVHfMPnvPc5HdO5TRvm5h8YwQl8NudYn+9JeP1xC08wY6QhUjMMomAA2YyMskn8ltiMxLDABwDIZhsxdZmGrMiXn7L85YT613acsks7h3YO55GF+WkDzoQU6J+T0xnns98mbOrRVXZGMHQbGyIfy/Ypg6O5wBr7whEbyygFLseQZylsbdNN/XO6PVqtxqyeoyfZbfwDecOmz3Z5UkZQycobWfMnN9vhnh281x/7mr/3xuLehocFEKd7THQnWTBWGEiQMBfBRxKRLzUqJwm2/Nu5vttS0t7GKMDjEa8llQRWYdOYBSSYgzGlI2NxnqTPMUkB3bO9AKNiQOfOCSbmwEM1kQX8mTwwmDOQ2xhQpgH4HNOTAjIXAoiyJUZlZEBDNiJ6/V5EdfIOf4DcF7IAAmiOV9mk8diALuPYoem9voTTCNKyTb+x89RTT1WvZZF+E4ne3KRMFrlustpRQlBK4IRsaO/45cuXq5LU0YpkphL9Ig2kxcayWLaHJbh67bXXzhhPn6d/SowdESGorFboXsCCSeSdTF4JbBdBfDY3ohEeQteXexeIVbsI0WdIXBChI6/Z2Gom9xaMyaPI9CVI0RehWyUovqptAcgxAkfa4u85Vn0w4A8if+GFF6pAZLzGQ+jKexhVBjI+NtaveQqEcGgsAqbrYMLqieAgmIcBbSRRrD48YX9mCQwUD/SyFEEBcBmCwerieIyebMB5JQRQHn300Sp7RHipN8ssOY/tpIplP2cSANyY5Iicyn/+EkAfeOCBrYGB7gR65CNbFBRkYGwsy0NEU4u5+LlpyYj5yZRT0zfHm2++efLAQA+CEz9ArBIi2FPW5B8yccFC8NhV1P3hWrkFseuLD8YW+nQMiSurIFOvjYOOBC82dF5WH0o2Rx8GBuNCsB7/ZmO6tR2tPrfqcEyyZT4lBKmz1W9/+9uK6HMfS2BI0gJ7xLhwBz0LgHBofuxNB3RL/3hFYFAKc2Pae8FOAD2JMktgQDK2kAXACAACQV0AABhleJxG5sLAjD1U9OVRTGBxgw9wLbH9Voz6uEwJMEoFoqHjnfp6BOGGIgdnH3rhQHTvGJvIqDYJWyEfdna+VZ92kZSMnVOWsOWmMdQ/Q5CIQ9aIrGSKcGc+9lY3vq07pcC1Egxd0hXcEccFLbgUSBE1fdr6Ch27h4IMJUEpv+gPqaZklNJL2pcgsJtgwP50JoDYGxsf5qPESkFp1lysOCQQ/JWO+ZAAc9999w0KcBkXeyF7/iqhu3TpUtW+wGdM7GjO5sWu0alkUIAVdPGKcZmfwOd1vghJx4Ki4ydVJv8eA0UzEJACC/B4zVkRRoDmPNkmUDKybMASNUb1+VARGIwFYekfSADLvQ2/uOrmlf7GFg4K7EsSjnPx4sXKwTmcJTY7CaRIna3icJvGzXYyNGTkevpmV9mZkkmXNja13+czxIfA2FsGrH/Bwhht8OjRyilXi3RiJcYPrKLpF+nSGVwcrbJuY3ZfRHBoJk9d529O/nGROQo2SE9W7bW++FkSNW06TxC3ykpQgAljQKA2pFtPDvTh+y4CvmycbX0ukPA1j8+WTLS0jxe0CU9KXQIX+/qSpu8p+Yz+6JKPwyFdmzffpld+ry0YoF86xzXaduwkyiwrBspXdwQkG+O0LZV9xtAcxWtGAtZ68BhiNPcrEBwQAwHQE9kaZ5kqY1haUKADJHD99ddXqwaBwBKbDZAXcVNUBkhvm4RO6ZeD2pCEdjgqR5b5eT+VwJmsFkHon+7Vo2EBgcCa/VSCOI2JPpAzvAueEhRitYb06FFZY1fsm5MM2q+v6odN9SUw0oP22cZmLOzvpjPhr455eMC1SFdQMDaBI35jbNrkNwIcHQvAgoi91UMp3QpiEhaErn1jg8kkMLBG/va3v1X6tLqQkOAPPGL1a7zsb/54wNzp3XuYNFbJoc9OmswSGBgG8AgACRIMyQHqApDJnhiNwzjGUG2BpH5tl9dZJsscZAm5j6EPz3QD0UkWpQTPfSMBT6mESDg8J2eTrqJuyzHZWqbOMdnT+xBL17aGnMfG5hPikjnCgZ8dd+y2226b9LeTZNf5afDMC7YRVnSDqCQqiH3XwADTvj+S8iCiR4J8EdnLoumGTRwj9KG0Jntmu6w2nOszwUVgUZ4i/MWXygTerAqRN7+WbB2vykuCW3y/ulvagmcAACAASURBVGjHP9rTBxxKWuCJfmDUfJSDzNnegwVWESoB5mbsPjMO5I9PUjGge205Bpe7lO52nNKiLpullJTMk3GBn5EcQ9CAFYlh4yQMjow4dgky8TglYAk+gMNZZHAA45gs0mpmCtG3eS5J6J/DcG764PCciq2QO6JQZnDeJjE3T8UgBtkmMmZ7hOEzbU0lbGvVo7RB38YBS+yONOABgSbjHHtciFidH86svhC/7NomMN91111nrrjiiup+F+IeIkiQPfkQPbClfmX4yJ4t6INeHEeKSFc2jvSRpo29tUVfdGfcrkmWrb34jfOcYxNIZOCODRUBVb84Q78EP+jHfSRiTgKFJM9Kwo13Y3eM3p1LB/DN3o67RnkPNnGCwFdivNWA9ujPLCsGoBTtGZSBOCUg5X0MTY8clYGAzZIRiTBoCWF8YOEAMjIbArRETr13qlUDx1qaGJN/WMSZOBfn4Ug25E5/yjDbslhOTKdIie3omH61oSQgGVASmEo8avnuu+9W2EMsCIXAnXkiw6nIABnDGOzRKywibvrYpte++tK2R4g9maV99xgQvRWBlSFSdEyyxt+Mw0+buE6Qois3e+HAOfaSA1uCFh9VvoEdSQOyzTVWZfx+qBgb3LCR7F6AMEa8QtjzeJWEPPHEE1X/PoM3Y7H3nq3p2+pXgINP1xi39s3NStLrkyizrBgoWkBgKEb0GgjtAbNO/AyHSER1AFRHJCWcRtZos1QHNNmS8XgvYFjil+inGvCe/kEcVgrqzexDNxwdmXNKmS2SqQfztqkKLsoYHE0bEgF2Zl8lAI45lQhUSlvILQSR8SBqGTKCm0KQ0zvvvFP5AtJMkuQ1PB6tSpwlBZm+9NJLFUHCvHsOdM/vzB2Zswe7W5mzGyJFlBIBQYzeEsR8xv50SuhTMsdf+Tf/YnPXaE8yIDAPSYRwBRKXMFptwRMS1wc8CWCChXEZg3FbBbhOv46Zh3k63/xt2uP/zjMP+oD1KbFZ0tZD2potMACM7EymRCzZGBMwgS0imgMdQPs8W4CY83bZA7cMgjNyRP3KOoAHgM+tfoESMKYSQBziMGONk8P5QhFnF5gFCvqhM48Gstk2e/gcyQgGAgw92zgmUnZzcCoxDvgT/AkcID44sFd7R15ejy3sncQIFpOcGBPxmGlJTGgL6Umy2JUP2pR5bLkHgSRzrvHRDf9A7q6jo6zkETP/5KuuYVdtwQf7IlvEbUWifatQ5+8q9GT1yV+81r4gZ9OPhx3MUeIiOJirYEW3gpRE03yMwVx8edM1XrvOfOHUXNxr8NlJk1lKSZRsacpQwMNwNkA7WmVI9S+VABnjymAIp3asBInKBBC/9glQITCgASBAn1IAscS8So9ZzZbzIFI244zGmSxMxst5jH+dsBu7ytSULjghopHNydC8n4KIMz51e4/jsrNN+cg4kIV5Ip4h5JV+tu0FAGUtukBCdKAs4zhSHQMPniQyP/3ImgV5/fExtuUPSJzN6MRr9nHvhY8gTz4oIHjts7RnvlYfAhrbmg/ClsW7lp/L8mFgVxGUjFm/ApAVXnxV4hjRdx6aoGNkL4jYm6/7Ds6he8EiWNQW3eAC+jmJMltgSCYBWACJMBikmXn6PM7LQIzoWAmHsUrxsxiAK4MEjASGBKI5QFFibiXHLVD61VXZnuzSKkFWZZzk0uoLRv4LGofbJLJNNmZDTk3HHA/5cFhOOpV4kkagQiwCnMBgnsYBB77HIiBuCnYlxop8rZgkRVZi3ktYBCU+QTfwXlLo3b06hE/4l5Ig4vdwAAKX1SN7fUsGlF/8BLsxSeYcNza2tEf2kgPjFljOrVbb9IjAfUa32jC39LvLnJJIwppxC1DaNUaYqieV2qdPgUogYltzg13iOhULbWpHe4KdIOG4a/EU3Zw0mS0wIGX1ew4BWAzAuLIBGUCEY8pifOY1crEB4DYiShvr9gDhaRlgz3POwAD0lqGOTy3mGMKduu9N/bGVTJrdLly4UI0RoXF4NmS/bfagW0QsECMndkcUskkZnPYQzRRi3L7Zjkz0jywStLx2MxZJNBOV0mOjA/qDRWOK/ekIoY71k9VWys8++2zVH50LAohTv4IDOyNOwdq42MYvBAgYbEYEAFjlj/auj9AbshWAVAfMM3OFFa/hoa+wiZImu0lS6Iu/4gP7tuRCIBIckD0eEQDMDV5do8xkvuZlzMZmzubELidRZgsMQMGIR6vSEWPYGLmNjIGSIYEWgcjwnLuNiLYZFLh8UzPA1weyABBAA6I5BDDpY0nCgWTZyEo5gHNyJvaS9VtxsQdbbRJZJYdGhrJ05OIaTnjjjTcOKjFs6rftM9nlpdVqh/MjMoQBk17LdI1v7MAgGLmRrz/4Mxb7+IfsdSjO2+aubCWLPl7dxNW3hIx9kbgxJHAjYv7BV3wfwGfuv7AZX2RH2KA7Tx0laMCwX+h1nfGbh8xbvz4TRHaZl4zf2JC9AKNvvCCwGRNeaIqSkfkJYJJOc3CtBEBQ9H9HtCt4SIC0L1lgg9NSUlObI79nUOQiOwEuNT31QUBCEnUDIw/AY8hEdOAaKtqQRdjbEB6nNBbCSdxYnVroxlztlyTsgywFBDaJc3F6jqf0si0wuJaDEnvz5JScVdtDas99dSWb5fgwgACRDZ2HyKwmxy4nIR+6FJAEWYTpPZ8wLiQ1hrATfPvZCHO2Qkb0Vud8wUMGAgC9EP5H2AqZ0p3rjJ8NJVL2CFpwEEy0IwkQeHIvgG8lofDf0rbhpeq09odufOlOm/Cjf5yhL6RuXE3BM2xrfs7VRkSwssGez62ktGVu5mk7iTLbU0mUzaiyf+BDMsiF4UT1OmAADvlwGoaSZQGF/RDRv+WxQAQUxgIQ+uGYxuJnIaaWBMXsp+5/XX90w4F8gxRBeE0QKYJF7sjNeeskS/TsteN8xGiFxrF3ySTX9bfpOPvrl55liMgPwUk+jEmN3I3aoTjbNAbYRpr6zoqBDgXho9VqGtmNtXo0rxdffLHqF3EKRPrSNzI1Hsdt7CV4EHurHKspx+nRdeaAdHOeucnGs/rg49riWx5/9gXSvisyP9DHP41du7J8q1B6EjCatkLyqgIJCjBqjPaCC/vDoPOUlPCMjeAFxyUrS/PFaoAj/pm1XsHAjMI4gMWoojew1YUhGV6wYGDXMB4nHhLRE3wYnTMAgYwG4IxNX44B/tRiTM2V09RjaOuPI7oxi8TZQUaYIC3Af/Ob3/xoxdV2vWPaYGuZpQyTkwrC9puCyrr2hhyXIbqZDoOIyjjMh+2R49i21z4sS0pgDpnSI12wvxXrWKsG+r/qqquqEhA/Ml99Gwd/FKDpQgIgSGSFyGbGKWkyfisA+mNTe5+xo/YFAQHWXhsCSlacfUu18GZFYxxW98YpeAqkfFnfTWFP/CFxMS7nCVzmJZCZp4CgLecK0nzPaknQMmYBxFxOkswaGBgGYGQqXnMAGQWSZri6MDrSZjTGtLcNFY/VcQjGNwYOKeAYA7AA4FygKDG/ofppXq9GzLGQGQcVGJCr13QnEzy3eiJlE6EiIU5Iv9oyTw7Lrpuua46lxHvOby5ICvbcQ1FiMS7zQhrmPKakfJZ7aMgoeoDJZhZcciy33HJLtUpjRytBhM4e5uxY/pObcbAxHxUY+Aw7GisfJgKJpM58+BAf/sIXvlA9zXa8upfhqTZVAUHQ/Mz3oYce6rxCTHCBHbYyVu0JPGwYPdb1Y6wCm7GbgzEbJ50KUMpZ7p0Yi/Zh0uZc3JBgV2/zJLyeNTAgX4TAKRkCqER1Rq4LoDouewcGhiNAGgeqn9/ntWCjP4DRvpJC+gAWIJxLlrhioAvEyeE4G/0gU4GbLZ588snqcyu/deI8yYD7S4iF/p3PUTmibx03E4N1bQ09DkN+1sM3oQUJpGVsbA+PAoOb1PAxlpg7ItYnkjMmOpG9D8X3tjEr3T333HMVKSrhWilZndNFfnyOPpLdO999F9ikG5/RmU1mzp+J6/mtUpyb0uaofT4mgaBbyRiC71o6lKQ531i8zuqevqwa2trRnyBlfK6BLysPY/Akokd0zcE3wOncmLXHFn6m3Dnsbz4nSWYNDIzE4ZB+CJhRGKopojlAMConAkLgHCrIDSBCwoCNlDhkADy0j12vB9KMa9c2xrhOFkk/HE1ZSNbGZmyY7Gxbv0erEoCAksCgdqwdOs9Sf1sbpT4XiCQbcCDAwYT5IRUEgSzHDAyyb091wR5yEyCVXPTbRnal5p12lNCUB9nCI8mCk7FYMbEnEjcOerGKoBOvfX7rrbeeOV6tBthScgcDvo8huCButkTaSkACiT58WVJw8QSgOXYV7cIcOxmDMRmnAIrA20pJ+ERQyirAe9fhEdfgkXOrFa6xOccGgzgJ5wgKU9igqw6mOm/WwBCFh/yUEhhEJtEU52Qpae898A19agiYAQsJ2AMOQgYyWYbP55ToZs4xNPtmN2TBQQV3BIBcEAARWOlzU7brHG2YHyele07OUa1G3FCcSoxF38ZhLkjHOGDBnAQ9WedYol9BEWnCtmCLUAUjmzGNKcgP6QoIgqRxEO8FCl9s4wdIPDYy5uNVQDBe2TQ/RKh0xq7OI/Dh35MKHIJDfkjPnl4RPeLehBXtwJN2ta8dBC5RdNxYZP5tglPoUyBzfdpwjcBA2NgXXd1rEqSNS/uqB2+88UZ1vZLTmBhoG/ucx2YNDAhYWQKgAA+IGI6xZR71DICRgM1xwQNAyFDiBEpEgIwSJIBG38lO5jSQ+W0j2TnGR/9Ig3NyJo5tFSCLdPyGG26oAve6sSE8tueEVoDIiF3ZwHPnfrJizCy9Pi5jl6VnDOyvnAgDcIf8lEG2kVe9zT6v6VISQpcCpMQIzgVeRD12YDBHc1emQYhWCQIzuwgKAoKx0IsxJkD4mYlrr722CmLKgnBqLjBAf+znPZu+8sorVXu+K0Gv5iTBQNj8f5tutYHA+QMe4Juud5x9kmTW9W6cHru1F+TwjfP0rb96ecg8fXv/8uXL1TX0YM7a/81vflPh9I477tg6znr/+/x61sdVKQ4xyAAIINkYj6PK5CIMlJIFQxNEwrjAt6t4WsHKQ4DgIO576NtrjuLJizkzBQ62xMBAP56Bj8OxIxshNmUhBECvm4TdEJL50TU9x1mR0pR6NwZPpCA/hIAACTKR7Qp69URl07z6fqZd+kN69kjLeJAmXI798IM5ImcJEhGY9M2WhN8R/sZexue165wjmxbY+LEkwevj1WpCkmfs9tpz3OPhVgvI3LVZnW3DSvRhBYC0tWslYJNgyP71Uxc2dC6b6odd6deGQ5TrrAwJHDsO1/pynD0EIxzherZw3BgOXWafIUMwAEMhQYZoc0BBgnPaMzDjISLX1QNIX4Mli9CvpxqACJi0bYktSMwt9GJcTeDPOS4BnDN7Cok9kIkbk7I59WNfDmMvel0nbI8wbPSMcMwxxLPuujGOG4t/3IS8jAGpIAJYRAYIcaxAJUAiWv14EoYOHUNGbb4wxvwRq1IKf7BakJEnUTOekKy+6ULyxrb+X4MVBpvBqXHbI0/Bhp8K8jfddFMV/M1JPT+BQUaP2D0eukms6BOsldn0b1x81d7WFHOAS+N1LZ6gY3vXq1BEnCcxyHgFQzYxLwITv/71r888+OCDVTAyx0OW2VcMFAwsAR5CZmyOimjqwlhIBElaDorkwDkkgiM1y1xjAGTty1q1jRg4x9wgEDjJ3OOo28JrDsYWnIce6Y7tZF9WE24yKitsEk7rfE7sxiZiMk/vEQBHnkL0iRxsiEs5CyaVdMxPJiw7HYOozVkgRZYCEz3qk37pYOxSEv0iVk/mhERl/3Qf0uUHVnXIks0RKN3YGzdb05vxa4M+JW2uFxic6zxz4VdKhZ4G87hsav30sE74vv7hAoGzg7b5fvMLsWnDypU9jcmjuFYEXtsb09EqcdEG0W4enKB/Y/HeqgY+zYk+BDIJgnkszR8z7xL72QODSMyADMxIslBGQ8zKOnVB3MCGfBgPWBjQ+bsKwAKadhmdcwAwQBmXMaW8sWsfQ68DQMHBXDc5z9B++l4vKCOuo5WD5Xl3S3xBnT09dbLtJjIHR8Lm6BoExM7Hq1KEctQQ2/adjwxSv+aElNleogJnAt3Zs2dHG09+uVYwsrEzTNKLFdgUgvQRKDvwMXvzl117n/EYi3NtcClo+qdWxsovkajxu8Yx90kQ7B/+8IeqfX6Vx0Od4zM4YPs20S/9I3TnC0bOt1fmExjYqy7GhezNwZgkLsZkPl7z6aMVbmGV8Hnta9O84FYgEKD1hSd8Lvi99957Fbab/FTvf99fz15KAhzAsFRMtiIzY0BGYphIMnpAYSyGASaG1M4uAiwcXzuAIBvSt8BgTMjBeOYW8zPPuj7mHhPdcTr/14DuOBMSENTjqE0bNsfMMW3aMT+2lZHRuax16FNnzf42vZeUSBLgMKQouzUWdXRzGUv0LSghIORno18r2akEUQr2MmW+Jrs2f8FZAkeyqkO8MGnz2qr761//emV3djP+nG9eVv/aQMACiXMkYnCiL993uP3226s5VxfW/sA88kf0bnLDCf93nTbZqilwBFeCfHwmK0B6/dznPvexxJOfO9deIDQviQmdCAb6Nk84hw/3SeB87qSxOe9S72dfMZiIZ7iBUSQHKCRhQ/whGOf5XEbDWWxAZpnnvHq90LldhZGffvrpapmqLUECOGzqpQA4Vca2aczAnG3TeVN/xoHoD2HIAt1c5Ej0yFacDOmtE9fTM6dDvOzP2TkxZ0zNfd31JY8bi77pGSl6hNN4jEOiYGWj7FHHZKn+9S0RoQPBIXhGfoIjPY4tMG/+AjMipwfHjEfypnxijIhZ8mTvHHs6QrZHKyIVSJAsuyNOrx176623qgyfb/NlhO56Psj/PXLK35riJ9Dd/0gg0J4Aph328ah0c7VhnMgbT8Ai/cavjQXmstefPswB7pLkuOfI3tqQMFoxwAX7O2bMkoYpbNPUydjvPxlqx+6xpX3ZAEUzMpBxDvVEYKzfZ3CD0rkAxUjJ6oBs15vEHNCNL0YGJiACGn0DouBz8803t4x6+kOcaGmCRGROx6usELkjUOOkS1kbR1NPTtbWNn7lJ6UUzs7ptImgXN+WDba1UepYVgZWPogqc4BH345GiGOI5IYeYI/QATLjE8YwlfAv2Kd/Y+EfxoIsHZfpC/w+p4vcY2Lnxx9//MwPf/jDKpAgS+cg4/ipm8xWCa7Rlutl9T4XhJWF9NUUCQZ8OZ8/WpnaBAMlzATR+nWSFI9N45OMFy6N58orr6ySPa8j4Y983wIfEf8P46677qqSAsFJAhR+8AOBxn7fffdV5x7Sn0UEhoBBBKdoYAHEZhYAaIIGAwOecxDOJtLZZizgkFkAq/5lCAhK+7KDBCtOOreYOxky39JzYC83EP2CJWcSTOlOkPCZb9RyprbfsclYOLbMUsaGBGWoAgT7C9RjZOjpu7k3diQni2VzOocJWerdd9/dmtE229jlPbKR4Jh/yDR+kWCxS7t9r9HXpUuXKtvFtwQL2T9f8D8znnnmmSoB4DOIl574phUVYjUH+pPRu47utOVms1JdAo9zHIcZx8y/KXDkOwYk33x2nUAhWIfQm9dJUAQS7RoHmxqvOcjycYxSER07nhWJc/GAdmHBKsm5Vq6SF8eMGSbwT3DrnCZfNce0T+8XUUpiQEZnzKwEGIfi64YXEGT2eYoFKJEIQwHvrvLyyy9XbcpyZYXatTE6cgMKY5lbOOASAlSbHv7+979XDs7R6E52aLXH2WVd7LlO2NXGeUMU3sepZYeIZwrRLzwat72ghuiMRW1coDpalUtKj0e/CJLu0rf+4ZtOrSamEPjSPz8U6D3CizgdowPEKHFC+MjQuBO4lIGMmb0RuvOReHRoZf7mm29W5CzYC7pwwne142GFZgKhHYSLB+DA5zZ9w4sf6RN46oLcjclqgu60zY+Nz2tfytOWNhynd3r2GX7RrsCTJ9GSKNKDkhMM5L6Dc+mIfYxDG4cgi1gxWEaL3gwnODCWbJ3zqa/WI7FzfQZ0DApcMk2ZQADa1zBAl6xC34ydG2SyEqWkqRxz29g5im1JAUJW5V8+chZLfaRCf5wEAfjNf6WZTU7D9soUiAWZsAlbsz2HrC/7t+lo6OeIwOOj8CcoIEVztLKREXs6CUGWFliGbW17nUd9p1wxmTOi9uQN/UuOBGsBi10kZf7vwauvvlrpRfBH1HQGl/bGzReRvutsPuNjiJpPsbNEDCboVTv69DPg+os4j5+7Dga0HYL3L2bbEg7nw5L+8IR7hPAkEBgXfeojwd35PjMOutc+/7JXJiXeC1zKR1nZGr9A4jqvv/e971U4X5JvRo9994tYMRi0R9gQMmMwIrAxOoPFgM4LKByTxQMiY4vWPttFLBERALAAIhBqGykhOcvnZlaySz8lruFIHM1+E9GW6KtrG/QmEByvsix2QeRsR2cCNp0qI9Tt2GybcwnKnMr5HFpmxsG1FQdtXjfGezji6AgDueT+F0Lz2hiVN0rrX7t8AAELsNnTRcopY8y32SY7JVGS7Zsz+wiO/EKgRIjsLJApxfITQcNqgR0dU+PPU0Suoy9+pk0Y1o5jXrveal1g4H8RvOAeg3OTLGpf4IQ742oKHerPqsYY2VKpSLCHLcFFv/ybziU07kkgfLoWgGxwJzhG6MVKw/nOYx8rDbqiD2N1Pw1n7bssYsXAOIIBEAGAOiSnDLnUszNgYFQBgVGc4/pNpLPNSLJZ/TI0g2sbOQAsgy9NzF8GZr8UseJzP4FNjI3eOBfbJWhsIzek4TrXcH5PmxD2CBFMMV+JBsKBR3hDIPAg0BkHYoOV0gSAhGTr9gIq/RmLDaEZxxSif35A1NIRLXsgZk8QKt84nlUD3+M/dPPEE09U9rKqcj6ypSs6Mx9+LsDSZwIQ//UeiQuIksKIoCRoOC5JQMzwQPwyQZsgeUGKfyBt2FQOJvryGV3azItuYda4fGbM7G7F435EXdjntttuO/OLX/yiuh7eiXmZrwBkfG0Bq97O0l8vIjBESTEWoyQac8Z6GYexgRCB2BgEgQNviCTtdd3nev3LJuw5B9Bw0KUZOYGh6/ymOE9GT08COr0pCdIjZ+fY7iFtCwwyPI80IiVOJoNEJm5sf+UrX6mW6VPMRR+eTkKCcIi0kIZxGY/ME9Ftm0/fscK91SuyQbKSHtin0ykDA3wJejJ+40CUCJJ9/FIqYWuEKxunG3pia9cat7ko2fDPlHn5mXZdy4eJa5G1z1xjdZCfx9A3Ypco5Dzv6ceYEHdTXKNfOhNIEpxc71oBiz0FAucSv5lkXBJSdqVrc0kAavbhfN+78KU7Y4Fv/VnpPPLII5UOrrvuumo+zWv35f1iAoMAwDiyRhujARBQ1QXpqBlmNYF8kt3Uz+vzWj/6AwjlC8BhaOMB9ACoT5tjnpsx2duWIJxXUJVx0ZugzXYcUJBVm/WLq+y1TpBgAjMMsAfCcI12reymEmUTxCPAmQNcOJbMUiZbOjCYGwJWkkA2+j5elecibqZOJbJ2K0DYl3RZPaWkhJS//OUvVzV3q0Hv2Ypv8hu2C8Er6bgvw6dg1bz8fAZ72pwf/3OOJ5vYXLAQbOjdddp0Xu63JGA39WEc7ouwFY4QgPSjPZ/Zs6GxRgQkKxFbF4FHT6hZhbzzzjsfVTjMRaD4/e9/X61mmquNLm0v5Zz/187MI0IsiAEoZGXJNiyjRe96qYhhkA0AMLT3Pg+g+k4F8CxV7YGEcZEah5BxyDSWJsYJ4Ma8FOEontrgdOxBj14jFzVn2Vhblpfxu8YTIwgIOcryODb7a2tKgSlZH1IxBj8WaAwICdnJ7H3PAW5LiqwceWrXvPkCKd3PtjGzpbKJscA/X0igppPc/+Fz7IuEZdjOc5MWyQvkjvNVWEWc2pNZy87dcEb49EkkeN7TN992PrL23nWwLgjZCxLIvylWMGzjHDgyB0knXRqn8ZqH8eGOXcXY4VUANGYbnzQmuoETeNHPPspiAgPwIWMb4zEkAAKLDJSBI8gG0Bja3jWMHYDlvK57RrYslqEhI+DWhzEAJzD6fEli3sYncC5FLLE5Bn0ZF8dkS3bhIFYRmwKDeSBCtvQtWs6GoDk5p2Nv+6lEvwICAki2bi7wgahC2iXHg1xhHRYlJexMH3xhm+5KjgN5u5GKaJUJ3XB1LEHfmNgnD244Th/G79i9995b6c24ESS9SfasCLMS8hk9In5JIex4T78Cgz74vnaDIzZxjrb02RRfoDNmku9UJEjoW1s+14cylwCzq7hecvDSSy9VvKFdCaZg+Lvf/a4qf9LhkD52HdvQ6z6p2aEt7ng94uD0yIQhkR6lAmOT8JG1JSywEBnBEIJkSI4PwJyy7pBeA9HSRLZjoyfEtQRBCmqvyg4yPaTKRuxFt35Px2Otm8id7a0slBQEErZV1oCBo6Oj6v2UczUHgU4GCHPq3256Iks1+NK/5YS43NugM5KM24rBsTYyHEMfsIWw3Uzlm4IAH7Oi4ZcClrGxec7lJxI5mPzLX/5yxveD/LheiJrdXW8uWWUgV0FH+za6Rq6SNW1pG771TTfZ52Zyfe4CiWxdO7CT6xGz/vi2/gUVCUeJVZj5Gb+EElbh3fz199hjj525//77qxv19XHuw+vFBAZGAgaGBTBZwfGqvoooGBihRAAlTzABgUwASG31Jxpy/rY9p3/22WcrwMhaOII2GdqyGCEtUTgaB12ScGSkblwyQoGdTTgnZxRolRbWCee3OnPjkKOzjadMrCj9+0U2mUqMxdM3r7322kcBDlEqH/jMfH75y18WLRfAu7lKkOIDsmb+Yf5TPrarFCSYIz2EjQAFLeNxzD0jwZIPwqIgwTet4Pks+7kPY2+VgKy1I7jJ7AV7eJHZ0zNcmKfzEWtWCTCQlYN+cY3RbAAAIABJREFUtN9G6gKKz7LKYh/tGCtd6svn2nX9Jhx2xZh23JB3r0G75m28cArzTz311Jnvfve7H3uApmvbc563mO8xMBqHALwYHiHL5JE1R+Q0xF72xOgMbi+7cZ0MBCD6CGD7co02BCNEBEwyHYEKUHd94qnPOPqeSw/Z+l471vmIIVkbEkAIbGRDqOxZLwu2jQMW2DSrSCWUoxUWvOdwyGEqgTsrGCsemDAueIQzxxBf6WCF2BCMzBOm7flGyi1TzR2xGQu92/M5GTt/ESSsntjSU1rGyU/YGQaM2a+lsl3055jrZezOJdoVXMzX3jmSPgmZ+1V0LsFwHAnzbfZH6vqpi+vwh/EJEpKSBCuJ3jXXXFPpUALKZq4Pp9Tb6fta0BLkjNU4Jbbmh0+MScCgqylx23cOzfMXExgMDPBkFbJFYLD3HtEwMgNEKBuoAM3x1BytGgC5jwCIOqE2AQXItec1YkMAQLVEoQPjRqZLEA7CCd1vQApswaHpkrMgt21B1jX0zrbas3eMHdoIYcx5w4HsFjb1Ldu10TkCsBoqXfsPmekPOXtvT3eOTSVIWPbL9wQAZKqMJLtnFzY+f/58NTY2yiqBbgQyv7RrNXDu3LkqkNChFaPPBFhtCLLsCr/agGf+7guRmTeSR/YSNe25VkBukrpAwiYI2jXuU5iDcXlCiN0ELv3BIp2W8huY109K4WwEO+YkQXLPzPt9kcWUkhgZCIEBEBkRSJC0IEHh9UyTwgFNFLaPEXZRPHDoWzs2wEqpgCP2DTS7jGHXa5rOsWs7pa5jj+PVqotzy8z8S0cOyD4hgy59qe2zuazL9WrKbIFYBJqpBDYQPwwiJtmvYACLfhqC0yMhCUkpYVMlKwRLZ+7XpLRZqo8u7RiHoBgypoOsWgQH5OocX/jy8xRsLpEzbpk7okb+6vo2+mM/1yBsunTzlh4dR+quRdwybViStNnH/jJyum4SurEIHq4VeLRP+LVrjJsf69t7ei0p+Mq3to3DyjhPK+Weiv9Z4ldaBat9kMUEBspC9rJ/dVQKFhiQgeDQVCjAAF+AwHkEFEC07yOMytGtUPQlOGgXyL0mSEp2szQBdM5knOaxBKErNx7ZUJBFam7SyQLZlJ23ZU90nZt6CEeAEKyPViWlO+644xPEMOa8/bOa559/viKWPJ1mjgKCL+4ht5KBARHyA8QJk/SACOnM73bRwVQiCHq0lC0FQRk30uZ/iN6qgU7YxooiT281x+dnZZyPMLUhENCd4EHSFj+W3cM1309Apmt64ZeSjWb5Dv4FD/5vLMjfGO1dK1DQoeAg+fReeyUFZlUWBB2v7a0ijM0P7XkUu8ljJfsv2dYymOTDGQGDDQgZjYEFCQ4ha6wLckHiCAOBywycA2DO72sAYJFxAJZ2Obo+CBJwbKmCbIF+KcHBTUs1eKTGMZAAG/mmKHL5yU9+UmWJm/SJbJST4EDtmbABkvIegUwlnFwJBUEff7gaQoiIy28D+c5F6XKSL4FZGcG0TJrEN6aat348ZcYP+JnkqV6KQbhdM2/4tAk02pAomB97aiNVAW3Cs5XKPffcU/mh83I9H23zbQGADwsGxhu+sHoIr7CTgGBj0zG+oChgsZdv7Ru38cKqgGHllb6XksStw9KiAgPDEs9BIxJEgFQAkpJlBMk0EYZMlNEZQiZA6YCAjNrAs04Jjst0ZGlIB3m5nvGQrba7OsCmPsb6zDg5BudZgriHkJ8iToAQ5I3PWNl0m1iCs4nEgP0JwkAqbD6lsL9/7gIfAoDgYAywJngJgOdWdfSSzq4v5GbuSBnu6S/4n2r+5k4Qrl8cYDtlGe+t2I2ziyBr1/IvvmRO/NaqSB/wSyRk5u1RYN+8Jt7DkaRNf00dwIUtGDM2beIIHOIzgQeH+Mz1zTaqjgr80acnKK2qJKnw4bX7LfChmvHjH//4zNGEq75dprWowIDYZWEegxMcAM9KQPZAqQCSpbzJqnM6BkwiM2cFOmTeV7QTZxSggFCfAGz5CnRLFoBfSvBiR3qT/dGhsSFUhIIg2En5a1Mgc44ggEjY03USAZm611OLvunXmCQNiAy5mKtyGZz2LWFumgMSQzJWzySBn14FzamE/ZAs/zImc/Wa8LvjVZBM4N42Jtm0rFmAcB2fggm6M1dzgwk61o+Sktc+l4GTtpvOyPeDDz6oxud64+LL2swmQPBjnwtIXQPatjm1fS4x+ta3vlX97wkByUoT3s0Dp3mK6+g0MLSpbv0xS0vAY1DEz5CMiAyajsdZnC8j4LSU7fxkOet7+eQnyMdKgwCRwMARgFnfc5DRJ0e5/oj5Gzei4sxzCwI3HkTAOWSG7ESfbixbDSCFTcKOrufINuSMjDmXZ8f7rgo39bXtMySGAI0fMSMx8+HwyDsZ77Z2un4uMJqz1SuSRHbm6xiC2wXjXftunod4JWfmbHVk/h4sYIvYRmK1TdiPztwzSsnIPQc+e2614qJHfbj3oF2fwbOkQn98si0owhYdKfna4MoKgx8oa0pMrO6MUdJHd3x7LGG7/E6SYAAjbOYRXK9hiE/YL1UW9bgqJcURkAeDUyBFAxQA1ZeADM3IAAUQsguAA6qjVZBwXVcBHu24RjuIlrNrS21SzRcwlyp0YzN++7lFkEXqgjontAn2HFT256ebtxG7a53PFgnaiMMS/WhlX6vLKQVB+o4L55ZImI85IC0kJHnog7ltY4dHeIZH85dpI1XzFiimErbjHwKjMQn4EjLbu+++W918Txl405joxgrQDWf6ozPEmfb8npY+fKaEyPfZWjASJGTaiL5JqOxhjMYGH+xiL4GAE3bRlr71R6d4o5lobhp738/oCzbM1XgEBnbEKeYJ00rjPluizJ9atmiFstwcsnLgEAJESMbNvhgUAQKkYGH5RtmI3PV9yRHo/Kex3OwGWv0gJ8CdMkNrUUmnQxwD8DiJ8c8pnAKpcwaEihRkfjIpNhPot4nA7ycn2AFhmBPbcvB6grCtnVKfIxh1b3MxDvMzLoEBEbhRu20V1GcsSE0wMFcZsT6IvqcU/fFB2IIx83fzmF3Uz7usFjJeGb/zJYDIPja1d5OWv8MLn7OxP7/2Gmaig7QnUPq/ECn9Gpc+nCeowBzdwZw+nKedKZI8KyRjEQgIW+pXYHfMT6uMcQM8uhmyn5c9WkaOOAAHISN5AoDJ0JrAQIIyAOB1jqWnoABIfco/+nANoKc9y1HZieNuhjtnyWK+5r8EEUiPV3VkdknAtqpDLBxEFugJlW3CBrG9vZIOO2hzakEuyEtZBbkgS5mpeQoS3n/nO98ptmpAZEhStivTlSwhFnicUvic+cl69W++vmcR2/oJlK4BkQ7Z0LX8XOJgfnDrsV8JBVywtRWJR4Xpmk9bJXlfF/rHAbiC/r22OV97+vKZ9s3DXt+Ojy36UPKU1FrVwL05mTP505/+dOZHP/rRpKu/rnNeXCkpGQNHAEYEQ6mcAmgoW8YSUebxOyWImxMJKMng6ufl/HV7gAFAYOUAsiOOCaCChegu+1iymG99m3OsnM9SnlMKtLI3OmY/eiUy7G2CBBExexDkIBPTjvb62HhbX9s+RzawAXOc27yMC+EYBwx6IgUxlRJ+kOBAF/pEMO6/0fEUQs98zJxtVmzsIEALFPZ8o6sttIfE+bqg4Akk+PDkDlvzYZm2lVKybr7vkWH7CH91P0J7EgU8IRv3nt7ypTjErC+fGysfxyvBYdobYy+xIXRjXAJZ8CJIGI9VEWwtSRa3YqDA1AqBhTMwogyTHK2W1/VftAQi5wMa0Lo3weAyO//1q6sIQkAJNJwOsBiNMGhed21vrvPojwN0ddKxxkmPnJReZYk2tuIASoSW0oLuNudEBMiXQyFIT3hoR2AQWOJ4Y82j2a4biIKDsXhyTilD8ENMSBvJNWvgzTb6vFeqQmrsmWRFQBCEYHwKYTO1fXMzd2KuNrZQFjq3unnMT7uIOdkQpI1N+TA8aEuAQPgCoC/0+Q6AMTT1CltwJoDQj/4FC3oSnLO64A/wY7yusbL26G3X8XaZ06ZzfLETjvEZnjI+PmDeSpPut015z2jTWPPZ4gIDBSJiQGBADsfYAoT36oWUmqzMElYmoUxB0SFG5zBE1yWu9mQ/jCYICTKyFcBHcN7vg9BXCGQb6Y49H4SGTNiEk7OrMoH7OAKvbHGbfVyLRNgSDjh5iJnjTx0YBCRkBIeCBGzACMLxyCRyY4NS2bz2zRP5sSsdINGpbWsVHpshMb4YEqYLpOucLmLsVhh8nC5lzrAi2CXYCLaI230IfqgvyVn8Xj8+k8zBCP88WiWNztEujMEbCXf4jK2M3TaV4BVBzY16YzUXfuDfx9IFzHRJkqYar34WFxgojnAszkDsgYTyED5iqANE1gZQrmFwABFgOHFXQThKBAwliwEum/EgsKxYurY313khJORkTuYwl/jhMONQUqI/S3r281rmJBPcFhiMHflzfOVEBMzRpibG6BAejMf/oUYy5gOXHP+WW26pyA2Bwl8JCf7gG8Hphz/oc0qRYSMzBO5Bj2S/7GG+fUXAEwhk8nTFp/ktYVuBgbh/YQXvfNiGJ9fp1xM/dKJ/wclx58D81772ter6/AlvCK5TrRTSt73xG7synHEaN51aiQluVkbKZ0uRxQUGiuF4yNkqAIFQKGPKSDhjyC9KpHSkE4BQtOtldF/60pdy2sa9dt0oYjjLWH0DGICK8PuyYjBJ+kIcTT1tVMAIH3qQwP8y4ACyXqRiXAlYSQK2dc32HJ8zIQTXJ2tnH6+nFHhz3yljQm7mp7QDM76jUSowZF5KVzBojziV5vjJVCRnlYKI2ZJdBQn+woaIzlj6iOCep4esGDwVCBt8WKZPf1Ym7O1z8xUQ+adEw56fh/DpwQbzxsIehO86lk0Akjx2xV6fOW0613zcf3r00UcrbjIO3Aa/gpUVjn8lO+VKZtN4FxkYEBuFcQCGlZ1wPopkYF+e8k9LIhw1y2zkAUBWFK5hgC7Oox8rD+d65M3yFeEYC2Aaz74Ix0KecwcHKzbOnWyOEyMWZQQ/MdF1Rcep1J6RBpvCA9uwVZ0EprIPfPl9/X/9618VcRmTkhl8wiwCf+ihh4oFLCRs1Wr+gqv+vacHn00hbOen6QV6SZM5usfDF61i2ELJr6sgZvbnrwKE18qNApAkT3vmCscw4xdYCQK1yqRvY1Ceid96b9WhtBzhv0kmvRaQbCkz5bwp9nTFJ80TL2V++Ov111+vVg9LeXx1cU8lMZAswdKZ4hC+TSbG6UJ2wOIYYXiAQu6A5DxA5jyyG8DdJq7j6AKA64BTcNE24GpDJrgPEj0AHx0JpnMInb7xxhtVdsbRjcdYOLAbt1Z1nKWLcGQ2Jlk5sDG79CGkLn11Ocd4ZKywZp7mhdxkfEplHpXsm0Wv61eb5qwvhJoyqixaeW0Koft//OMf1YpFIHQ/T4DwsAe/8bqerHUZE735B1lWQVYAiNvG/+HWa/6IB7SNQB3HB8aTJwXhCtkalyTO2OgKLujNikYbjsGcpGLqVSZ98AG2E+DNHcexp3FnRajK4by5ZZErBhFdVsCQHNBeQACKvJdBpj4dENkjCo4ks5BpAlMXYQxfnpN9CAyApC9GAzx7dUBjW7oAG6fiPNHZHGPmhHTKMWV4HJ5OZbwCrjF2FXoX8LLPM/3amUOUKqyG6Ng8YcZYlDuREfyUEjYMjgUf5MIn4HsqEYSs9BA4YrNaMW9YQ3ISKfPuUwpBztpwHbvaI/PM0c1igQFO6mSp7/fff7/iBAHJrxJYUViZeg9fysHOQ7TG6zOJhNd01yVZHEO3Z8+ercYtKLinaX7GY89HcM0SZJGBAXkgEU4H/ByDE8oUgASAmgI4yBswZA8BnaWZm4JdsmYZEfDI9KwSLNMFGP3JAru00RzXXO85KH2Yj9d0OrVwej8hgSQ5fD3YG1sf8nQ9p5ZZKdmwMVuzCydPkjDVHOFLcJCd6h9G6TnZrv9HodxUSu+IE7khYn5hz7Zel+pjm+4EBr4gMEnM+KaggMD5JXv0eYSWP9GRdszNfRvzjC6RPd06r776Yn8E6hrj8DkdwESqC8YoUNMRrBmngAOTU+mrTZ94ys37N998s/qxUAHVnCW+ApmAAcvsO6csMjAwtAyFAD6Fiaheq/23ZUoABgAytuPVNzMBxIY4ACYZ1yZlyzSUOURyN7jSF0Npy2fAtQ9Ch8iLA/XJzEvPje6VjfJ/tJFpbl4iGY4g6G8TZAEDVg3IwtysGhAAYppDlDLUhgUsQY6uJRNZNcDe0YdP2gwdH0JJkqQfWSayo8OpiI7/IWKCyPgEOwiI7OhYX5GAwQf/RIb0KLjCjfk5bpNpB88+Q/j6RPR0YRM86Jv/2/BGvi8Dd/ACP/XVR9/xljgfZq0OrHrMmQ2tbPCPRIN/CBZzyiIDA4UwIHIDOlkIIACiJTuAhuydk/PtkTdAAUnKDdrqIghGRup82Ya+gV2gADQrDyuIfREA5Dhd5z/GvJAnQleis6dHNvJDepzAfZsugcHY6N71Ap2Shs3cPA9e/9LjGPNoa9N9LvqFR7qWmMiaERsC9TguoiohAiPSFIT4AXzTG4xOJQgaYbGlcSA0fslHBEHH+opECy74mHb4LrK0R+x06r6B74h4wpCuzdvn+qN3bRgHf/dlMcTvPPhIMkd3dOieFgKeU/CMQCdZorc8BZkVjXn5L4WC3VwyX89bZhzjAk2yApkY0FBgIi1gEA6CZNSzARcQAEp2JdOoL0XXde1xMuACKKCXoWlXX5xxbkCtG/e248aPTBNEt51f8nP1Xw7PQWWH9dULx+8Dfo4tcMOEzUrO6oFtEIXPpxSZukwU5uDFmByzCWIvvPBCRUQwVULM0w1v2IZLfcC1cukUAcLTeoQ/5tePzR0J07+tr7CZbNnTRdpVHkoiAyt8F0aUmRw3f3rg93SfFQt8qRoQiQKsw5eAIYnECb4Qd/78+eox2zkzcv5ozkpixDyN03HzpwsBburyaDWYD/8sNjAwHOPaAx5gIHkbogESxJ3AYD4A4DyAAFgZ3dEqYws4Up6qK6D+WgYreutTHZCzcXIOLxP0ep+E0wEd0jKXuq6mmocxWOXRnS8qJeAai9+y2WaT+jhliq6TkXMgdj1erSCs7mxKf1OLVSRCUxqwIUdZrk2J5NZbb62SjRLjUqZKKYcfwDlsChCC7tjCH20CE33zrQsXLlSlPD6pBLKLaIst2ZbeECQ98nvz8/ip90pHkj2BwXn0DtcwJvgm+XO9hMRY3TeEEXzhOrV940TMzptLcJfVi/mYm3sNAoHk1tyMdU5ZbGCgFCRikzEACYUh6ADAqoJTRBBPFA0UzkcivpjDcbqQECACoCWe8y37bIzGgPsmySTjbJxoSmE/tdSMA+DdxKRPji3Tiz23jctKMfVXJBJ7aHPqeWWsgpuAYGxHK6I0H0HQ2JTLSmamsmPzFCAFBjfkEcyUK1nByNz4F9+STMnGiXl38bHoLnvzysMFEjpt28wVbvifwGG16FylFpuAIhmkC//ZEZ4irkf+rjEu5+GLfO9DsqI0NpfwRyXyixcvVnOS1JivOaiMuDfi2FzBa7GBgWGVdGSGlCU4MCQweI/ABQuZQJQHsBwTqTM8IKg9J1PdBgLnMY6MSJvGQGRpvpqvz32TzINu6GpqQVrKPXQqqAu69KimnGDf5/4Am6YcZW4wwfHZbS6R+cGKAAUniAyhOS5oCGYIvITQJ3KmSzqlD+0rn4wtMOR/eQsI5qsUIptHtsbl+C7iQQ92hBN7uCD0aZNcmOvbb79d+b9AIEA4Pz7a9jQUvMvA4U0lQLt82f0Kq4i5f7zOHPwkhrHwB4mssiAeEvgc8/kcssgvuEURQJGgQFGCBOUBqJUCxcocEQNBFD4DBOcBk9cU71oElMw1fdT3vtVpqWlZzJFFbuWoXOceBEfcJ6ETDoJMzUuAdWwqYRs2Yq9k+Zb9MmwOz75uxHUVdhEEEiDMK0+n1FePXdsrcR59Xrp0qUpGEFXKIsbGuWWusFpC4Fviwze0T490iCQ3YbtE32zJlxCzMVidCwayfJu5+iVRGOsjiFoS6B6ADJ8+6dFmXlaU+tQ/zOibHoj+rVLoOEEifQsEeIN+tBsO0RY+MH7tlwra6bfr3nysKM0hqz92xVtuTBubwDClv2bs/SyYqybaUxwAUAzjAQ+ns3RF/D5n9HpUdUPKPxEJEclkOCVydK336wTorDRkY4DD0QQHRnM9g8kG902Azbw4LH1u0kHpuXFW+o8uZUNshtToU7DoI+aifMG5veY8bMTB2G9scmwbq75hRDYKO3AKn+aNuJXS/A5OiVUNXNMfvSI67dOjlfIUdkX8R6uSmRWKby2zo74lHcYhSLNHV3E9vSiPsaXr2TH2lQBYhSnZ0bEVhff60y9S5f900hRt23xmvL5bgkv4QHjE/5nQbgnbNPvv8l4FxBwksMYgaVL2vuqqqyp/9VlfH+nS77ZzFh0YGDHlBk7GGQCF0zFson49MHAU1wWkzqNo13HcTXf6XYtYGAMwARSI1CdlSr6Wb9m+b2LuwGVedDcFgdR1pI5Kn+zANmqnXtOl95y3me3Vr6+/Zh+EIDlgT/OSNEgSkJb7F1OLsVtNyvLMiX6DI2Uf+Mlv8g8dG/KgP35BpxIWr+F8CqF7GTtCEwCQuY34rG/ihOAFBXNgOwRpLtryGduao4Ah6PrhPo9A80vH6WBdINImzNusOtyQVhGwetC2IGMujz/++Jlrr712bTtj6pW+8I754hvzNF5zhXF8Vee3McdSb3vRpSQOR2GcwWtAABSZr+Wj14gBMBEDcS5gydpklJQMRABnrx7all24Nhm1DFAbDKZdbQo0ft6hrZbp2iUL8iUchR5t63Qwxjz8lo5lu82DAMjSa8BXRgB8RNNV2CNOz8FjX46ONOcQ2JRBJ1hxckFCGZL+3RyFpxKiHcFUn/ENgWgdQZboM20gUiUje/dP+BVbwJOkgy0lIl0FFlL/pyc40B6bes2eAi3/04d5szkMm3ueVGvrz3hsyBYXIGFtuDfiOFtZSevfPNwToscpxRz07Qk2gq/wEF4zVp8frVZo9lPKolcMAMYJZAWIOkpE1sAhmjqH0etCkW6S5ToOBHQALXuj9DaJs3EwQUd/+gJU11hy7qsE8AgL+EqRVBd9+L8MnByZCPTswiE5LJvcfvvtXZr56BzZH1JiD/YUyBHJ1M7z0YBWL5CXTNRjh/Qr8CE1GJW4yFQ92rkOe/W2tr2GTfrTD2wrP7Av8uwTYLf10/Y50mJDPsGO7i3YW70jWl/q67NqSMJm7JI5czMv/soffZ5khp/7/gQdhzRvuOGGtStg1+EHCYOKg81j6MarHMVGAoQ5KSkJ5MZfwkZtult3TLLJN8zXHAVL+jReuLHS2VTpWNfukOOLDgwmhpgZCpExNGNSoEARwvZ5HYyIw7mJvNrhOK4D6nVZJZBwOASDcLShpsvxzp07txaA2l+6mEuCHN0hU++nEEGc3jmokgr9sg0noHNk0EdgwaZNZEwQgEBjblM7dsbuRxafeeaZam7mjIDcUEXe6tseZHCPZaggTUERgSo58ANkKTi6CTum8CMBgCBz84yf8S/H+qxclN/Yja4QoRWAshw/h1HH+SKsePwXfoIdPs831wmMOCdJEbzzA4kI3Xkt8Agy8IOE6XVsHTbHi2Pgwr0z/GNjS+M2d0HL92GmlMUHBiQCcETmJboypkyFQ1AgRdbFNco+QCcLAVYAAwb/T9aS0TlNAXJt6g9h2bsG+QCqbGOX57Sb/cz1nmPYEJV5TRUY2Mpz2YCuX8SNPAQKDmE8fUQ7SFZ2zKFdz776kWnNFRjcN4EPGR98CVJKKxIVeEJApUS7AipsmjviLNn+unHm/pS5sSVfZAMk62a4QMW/uog2+FWeFtIGvbGfNtywZ1tz4+N81+OxcGvO7klswnASiOZY4MY9Bf+FT1kJ+TpXIFL2ZK8+wa3Zft/35uznPqyG6E8ApFN8REd47DQwNLTK8MgaOCiKAAWAcgQZBoM6pw6SrBo4q4CChIhsSzv1c6sPVn+c56km5MIg2pSdJGBwgn0WDifLpj964CD2YwtbcHAOKEgL5sbBbkhUFti3TJdgghw5lrnYT0GO6/QFk8hKgBK4zE3pTtkLhp577rkzDz74YDXOdW10PY44YF+WTcwdViUzCHYsUdLwT5YQuv5S1hEk4Co/89Clf35GL2zJt8yF31mR8EO4UWLhwzZBodTc3Pvh3+5zwYzATacSSU81CvCCxVQCO1YM7EfHkh+lLe9Jk9/GHtfiVwyJ+oAHiIynFCRTAiZAPF49MUSRbvBFkA7SkGlQKoMDFRA6n+M2BUkKQAIERwPaOJ7j+t5nMX+Al6GRZO9jz8mXjCzf3U+Q/QgOdEnfgL9LwOXMCBiRIF8rSceQ05yCwCQdMIY8BWO/4aNcgMiVTZKkDB0njNIhTNsLuAmYQ9ted70++R/SZlfzpHM2ZIf4y7rr68eNNTqBB9eyIT8XGLTpt5Fk0oIsvXl4hE6VkCQDQ8Rq1apB4BakjEe7//znPyuukLDgkSmEHvRtxUCfAi6Oow969TtVR6t7p1PJ4gMDsACEKBqyRnAhFYoS7ZvO5hwBwbcqAc05+YYmwHEi7dUFYQJJVin2+hdgLN2nAkl9TKVf0wlyAjgioNLVmKJPWaBVgSwoTgjwdCwQ9xV2YUNtcSYBQtDTF6xodw5RAnnllVcqPMKdlZH7DIIiHaSEVmJswa85k7xPuadEH802EoCQFxzxK9/WFfgQdp++kT2fkoBpL6t82ESCKfGkWiCRkVWzte8lDA0M5nLbbbdVtsEJ2jcmiYt+zO3OO+9sqmCU9+ErOuUXsMJXJMZ4yXs6mUoW/bhqlGA5aWVAOZQkExNNGVGUBygExxHrghwSv00ZAAAgAElEQVQ8QmjV4FzLRlmmJxJkdm03rrTnOuczErAgH30yzJS1x/pcSr1OkDQn2bpMje7GFDqUmbEZ/bMjEqd/2aetzRabxoQ8svJBHBzIHsFYPUxZBqiPEzkjHGIsMMfBlS784xnBLKuK+nW7vNYXvMaOCQx0k9e7tLvpGnO7fPly5RvOiw3sEbkgnUd0N7XjM//2lW8iQuOVNRs7TMqQ4cb8fO644AOrgk/zt5G29bXu8ySesKkvfRoLDuDzVi4Sl9h0XTsljsMLnjNXPiJY0Q9cS3DPrR6AGcuuzfHvRWBgMBunAowYkPIEDQakUGQja4kAEKC6TlYS47oeyXPYujjXslUb2gJEhKUdhOZpBU69zyIzydxkawJFM6CWnh/9Z5WCQICdDdhEiQ+J18uAXfuX2cnq2NVcEIu2rB7nXN0Zh2DnfoPVC2KR1SNO34L2/6D7ZNbr9GHe8M8Psgqja+QxVrDXZ76LoixoPmwZwta3+db9sG38rqETQQAmtAubghy/hFHlFEQtMGiTzsyPTvsmEm1jyDF+bjWrffiBHYHBao/NBLop8GT+fg+KXsxZQKBHgUKi6t7O0FVS5rxt//EUe9vZM33O0SgIaCgPWKwEQvgMmtJCfYjAhiQQvnIQIzMwEIvAshLAjGifoznfclX7AKME5Vl84zgEQabJkOjCI30liGqdbjiZPjhdgm6cHKHR8y6CPAQZ82Ev2AgBI4+5xByNBdaQigBojsjQOJtlzyHjhHHBFYmxpSBvVZufnR7S9rpr+U1WQvxHMLAKVzITpHwzGZFvEnZTrqETvivhcg3fQ37+J4GAgSBlzkq5bGu+7F5atG9M5pUVqKcQjYVu7dl1TKFLODFve75B+A080Y2EYwrZi8BAEZZZCQyUxEgyxizXHaPYZibhxh9FUzKDcxztqPkCZj1TBTznEmQjAHFkJCrjBVxBYt8FKZsfwNOHOY4ZGGQ8R6sVGicXnNmKLhEZfe5KlIINZ2E3m+CvXf3NLbJq5bOULBGLJMP4CEJEckMF3q1y4RZGkQg962us4Agv/I7d/EIpYtevjT2aPtg2xwSEerkEJiN8k7/ycThRFeC3+lSSKy1s4Wa6ACc5pE9+rz+Pj8rW/STOmCLgwQn7wbCEgk5gm54E3vwzojHHoe29CAwyEiQN+CIppdlTHPB4T6EkwaN6s/qDLGzOVS/UlgwWEBBUU4AeEBlCn147TzaRCN68Zt/emzsn5nTmxAkE2rGCAxJBkvpwP4itQiR012aHLjplR3Yyh5RTlAXYjUOz+1xiHDCDZARD4phAAYO+DOdeyFCRDAk2bMie9CrYI5SxAoMHNJSR6FyJ1Txk10pn/CV42jQ3pV+Ex/bGaTXuWv6nXRi1IUlzSmKoj7EydwHOj9cZmzmwm/FY+flvfGynf/YbS+jRk1gwzYZ0QtgUlqaSvbjHQBnJsBgFMBiRI9gYMYACsPpSE7jU545Xj9UBscwDGDmUoCK7QTBEGx5VA1iAtOlL4NHP0SrrnfpbkdXARvgTMhZgM0cOOIawgdKAwE7/sjIBnP6ROD1byu8ibJvg5npYQMicWHCYS5AJLCEX8zQmyQkdmD/8KbmUIhl90CNdw6/9WKtb/kD4JPIyL2TOx15//fXqHooEYJMgOdezP7/z2h4ROqYP84FPc9GHzdNIVopjiSBr7FYL4QFBiX59v0GFYcz++YVkB7+Zr+RGwobT+Kf7U6Uws0mHe7FiyAQAB2gIZamjcn7ORolAZGsKB5TlMC7RDtD58ayjFdmrA5MAFWlqByAQTVYYrjsUyZzicOZFpzKT0sLJObdNv+yAUOiZzpUfdhU/x6xNjqStOFTIa9d2h15Hj75d65u0SJOzR7dWTC+++GL1uQA2VNSd3WewZ08rE4TSXD0P7SfXs5v5KFdJrPgS3bODudUTs1xT3/NhZRE2Qr6IFiEbLwwKGuahH/dL6M17pR7+OrZ4/DYPtOAB45A82QR1YzXOMQR+2VJioW96FSzpls/wlRKY2Tb28iywrccdP5dhAZHsELCQNkCKnpQIjJyhrXwg0iIlilVXB0jBAKi1GQcCQO0hLkBMxpIVCbAcktCZOdOJOZvnGNkQgCcY07XXCbr6dyxZUl/9clBjR0jake1xZI40twhar776ajUWujZHmDM+NXQJTQknh216EIAQhz0S8yXOti9yDtULvEi02NAqnK7V/ZVZkCqbbhLX8+GUABGtMZuHspSxsyVfpCt7Ptx8inBTH0M/c09BUDdG47VnQwHde//rG++UFvMUDAQHOsFPsM2+/FPfJTCzbdx7U0oCNsbhXEADMJwMgTuWaEpxykl1YgA4G6eh3CzvKd9NaN+ABEYG8ausgOh1yAoA9KlNv+Z4KEKHShwE+MzTsdJC9+zDhoCuT33RM/ux2a7/HY9NZJ9sxb6CkDbJ3N85gSkrWk4tsZFo2CNUeqAT366ln6HCftqV9OhDgGdLx0uvngQ0fkLPfFKgNxf+9NZbb1X/VGfT0zPsrzRLXGec9o4lS1bKgQ+YsQn46u9TiSzdvY865xibMcKb+QlUJWxXn5PAwHYSV/3TDf1Kfujdb8BNUSLdHNrrI17AayQA9EiAspA8cDKOzRI6N2uaw5WJuM71HJXCZQAyF3XqODDilwX973//q0DquLYZBlAPUczfnBGZG/T0U1LoTgDm4IK5IAv0CIsdHWeXXcS17vtwGlmsNpGuYAMfY2R1XccJL7I7pGecyATu6NljkfRgrOsw27Uf52kD4doEoDwBpY/SYl4Ik1+YmznADOLko45tEmN0rWvcB7GPP+cmtOSNzqKjz372s5uaHOUzCWMClqBnTMYHqx6XFxj4S0mJr+A1enXv7cYbb6wqIfjLqmwK2ZsVA2UwCLAAoFqcjePLlICVIhGE85B+XTgO4mBcxrZZFQCoJdvRqnYpWjOIa4HCseyVqIDCM9yHJPTJyWVCSIs0dVdivkDNRvSvjIJAkDi7IEr3i9hiF/EUCaKFB7aXBJgDm5XOlvuOzzzVzBGfTJDjIztjhWNjhbsSok2+QMf8wHd16B157arbtnGZk7HbBF9+R+9EQLZS84N368SXuFwnQGiDjfgiHcECEuaH9OUzfme1oN+pJfdt8kSQuRqbecKxm8F8qJTwQXbTPkz7kt/x6qa++6EeS7aSsAocW8rNaOyRrtpHIkAiGAASomEcxJa6qnqlVQAHbJLCF1f/FtBjdhSNTGQqsiurA0tX1z722GOV4WW0AOApBK8ZxHtOHQKdYMqjd4FMZJd0S6f0EQct1Tm9+RkF5MF+yNDqzntEhsTolT13EeM3bisfAS6Eo60xaux9xog0YM1TWeZnZWZMyJoeEECCY5922861ukUaEhp9eQ3j/AHhlhJteqYfKQpCEi7+Q/fe85d1ws5WCQKDe3bGlmsRP13Z4AQeiUAz58rPk1DwK4jBMl4RtMzFPQePHpfkBEkSXdKRR1dhRF+2Jqet0/PQ43sVGICdcSgIaCjJkwoyQ2CiTEECMQAW8qkLwIq6sgA1S6QIjGrTAZ62OC+DKH/4l3sczIbEfvCDH1REWm9331/Tp7khV4Cnw5JEwm5WXkhDBiT7EWjZiF6HZvbGmscf2dFNXyUrhLsEMR5ZsgAoeMkEfQEOwcLsT3/60+qm7dCxIidbVg1WxfBtK2lP7SJE9hP4tO+LbnxKP5syaL7JV/mxTYDkh/7XApzAoPcwEVwKoHMKn1Bi/uMf/1gFMklodCupxDMqCaWCg0ApKOA4pSOBkZ/Q81SY3qvAABwiNuKyIgBC4AIkCrRs5mzrFMhwQBbDZpWBTAQMe+1zViANyC3DBQ+kBhCHJjJNpCUzMXd6VIopVeLg7BwIYQC5gM5O7KZsIGtEArs6lnYFAva0GrRnP4nA+fPni5ZRdrG9FQJ9mqc5Szyslowb3iQfnuYpIe5paJ9fwKo+lCbofVf9NsfFfuajH23Tt/s8IXl6X/fPehK4XZNEQSBDhsaIEOHOuI3Xin2s72M057XpvYcEBDRPKvEV44RZ9nvkkUeqaoNkp4TgHat2PMcXJT04iO78NI/Px5a9CwyUwyjApN6HyIBUoBBNGQvBcUDOhyDqArw+95nzgTzA1AZwMgan0j5ndo6NQUo5V31Mc7/mhLIi80+9GChLBQa6E7g5lABrJZYvtMk6fT60Bm4VqB2ZlflIDmwcDBbmFLhBnEoncGc8xui1AOlfN7rBWMLh87iubBOG9cWWyKVU5s1v/DQDe2rT6poIcHyHrdcFBjZiK2VbJUD+ycfYCcnm/pPAJlgoiy1B+P1NN91UBUHBEGfQMbzZWwHijqE2xF9WlfTCF/kg3/Cevoa231WXexcYOBSgA1OCAaXJPhzzWgYMgAzWFM7o30wKKNpiCOUoS0HABGjHLXkJJwAKWa9+GesQJcGVYwMiXZqz+Q8VOvPFICDXj6DARoI88qJXdmC7XcW1EgY2jMOydRsGdu1jyHUIjm7pFanYw5kyhMy75O/geFqGbwgG9IHASwYGbfuGM/vpS1LhdQK8/TqxMoev+C6iYzcBjJ8JGHACD2wniCxFBIE77rjjzK9+9asKv3Btruz40ksvVTyyLiB2nQOfszKhH4FRSU2/+imVqHUZy149lZQJAXuIC6iQl0yDQo9XpQSOJ1AwGMXWJdFXnVdwEP3dPHNT2k8YADii0iZjJLOxPJaBXnPNNdU59TYP4bW52pApANq8p8OhIvtjM+SNoGSY2s4xZaChjyPCg5UIElSm4FiI2DyaGBg6n12u59zGJzNGKMaWhCOvlQlKiL60zXbwbFXitdVECXsirw8++KAqrV66dOnMxYsXq3nBDqK3temcX/mZbqtG95nYKv7HL+kmQYM9lcWmJMMuuje3YAx/0AUdw7BSs0DWNvcubTuHT9CTPRzbq3A4ZiVmhT2FDPf6KUbZ6ANYEDfCYSgia6FIgEI+hNHals+yNzcDEVXa4kjeCygMT7QH7NrkbM6VyRyqIA06DdhlbDbOOkRcz8kttdWM8+1YRCBAC+hDxQqE47CZNpOVw0UbBob21/d62PF0i8RFskHXsmTHvUe0iAbOhoqgKxgIBBInxAXbdALPQwUmlDvMQWmW7/Ab3/ImEqif/exnn+hG/8YGX+YqICI9+DAu5IoIYVDZpIQuPjGIgQfM2Y3oYFZlwYYjzAfGUyLbpavohZ7Mn+0InQ4JOH3HspeBQVAALmCUfQET57fnEPYMKGi0ORuycEMwz0uLxsBtU2ZCLpzVtUCrLw4mI9Dnkpa3fQ2+6Xw6E1Q5KyKRnSgVBJybrt30GULgPNqnY+3Sb9rNflMb2z5jp9TuORTbcybHliKexYchm9IRMjE+eFZS86Upv69UQvgBHCNZhAXz7CCxYYMhQteCg8xfGUyQcM/Bk2d8Q19twlfZXTD0mk/xLas7ush72LNCX6ooh957773Vj+pZ8Qj29GxefkWYLiRAuwg9hNskTvDBXvQh0E8lexkYOL0NkAQBBA5wCB74OUKekwfANlHnVn5yHsKSsSAomQCgCwA2jqQPjsvREKd7EocoACgrydwBEwH4EcIhknox22ibfbRN3xzB45wlBB7YLoRrLkiHc3HauYVzX3/99RWhwpKb0bBljIhFTbmU1MmXvm2CBZyvI+6ufaekKrFSEoIR7XvkVHDjm35rqCnONW84sLkO2fFRyYL3jkvylhwYzMvqBocI6rgHP8AbfoA/89hldcY22tUOXuI72t410DRt0PX9XgYGk1M6CJDsOZhjom1KFEgCYD1j3RSGRYSyHg4KzJbFgOp+g6Wcz5GNNhiJA2vzkMUKQYBNZhl90s+uoi1ZPAKwyQjpFhkKFCUF8bBZyhMIkoNa3i9BZJsCAOJTXoNdur311lsr7NIP4h0q5i97R1xIhn9YCcLv0MDAfuZBr/zFXLJSZ1N9NsVxq0a24XPsxJ/gy/z5rr1rfXFu6UK/7Oems7kQJWj+o5QpWEg68Ugfia34h8df7SVQpR6F7TqWvQ0MFA5YNoCyl3kiAI7nPacDXoHCOXXx/mh1r8GyHqhFeBkQAAMrInOtoKAvx3zmBuIhC6cHavrLnDk0guUMu4jlthvOMnc24fzArk22KVU7ZXvkp7xhjwzZDxktRWDKQw7wRg+yQTiUqMAXrMmY2WGoIG3EAt8CTlbGbNuXsOpjoVd+o+0ENiTIjtp1rCmO+aFEJOpb4BIC+NIWHHgvaNEF39sHMW7ZvR8UhDHzUXFgSzxx4cKFXt+8p4v4graTjPK7tmA7po72NjAAD0VyLBslIh7ZSAjMF2NkNuuEA3JQ5IT8ZLaM6jqBg3E8sZTsaF07h3YcoZCslLxGLLuCExnY8jQHO9GzvdUJ25UQwUZwgA2OilwRUpytRB9D2zAmT7Z57t0YJTF06wuAiFbQeOCBBzbitusY+AF/8K8pkRa7ymgFJzqKn3RtL+e5TuA1fn6DDN0/4TeCUBtOlHvZWvCTeLCJa2HCe6skOCj1ZFbGOvZeyUyWjyeUpgU3uqFvK4f777+/c1kMNqyc2Ice4QEn0c/UUsYjpx71h/0p/SQbQgBAZ1nL2RgoKwdZiBtjTUEilmicUoAQYBhHNqSt/COgfHEF8dgOXQAzZJ3sLxnuLnPnNFZjAi0ySGasFkv3AlCC0S7t5xq2QzCISVYsuJtHG1Hlmjn2MCejpFNPKklMJB/2x6sbmciglPARNqRnBAbbSkn+haXgvIvQszEmwAgybGlO9I/QzKsuxsAW5sj+govEQIBQP4+9+No+iTn4DTbzMxcrH7gzH/wjOCB7OtkmEl2YoFtt0BF98pupZa8Dg2UrA8i4gBToKBTRMBKlqrMic4ZrZkg+92NgrmdgJYhkPDIchKYthgJ+56RUYel8yGKu5i5Yyn44Pn3Tb1+hV9kip+EsHIA9tKX9kkQID/rSR3ChL/NZSoCAOwQgm4czmSYCV7OGK+QNb84bKvxCuSP3M5C6bYgu4ML4jZ1trRj4jRvI9m3Jk8AkcCBK9mYPZCkg8ktBqtRDCEN11vd6wUxCSheCnwBsXmz52muvVRm/6sQmsaJOKZvNkijRUZO3NrVT6rO9DgzAJZoCKbBSIIdiGEtUgYLBANaTRG1kziFlN5wzN68tkbWlXYIYBQRtWolwiLa2ShllCe3QIwdGIIhkV3BGb0iOHunWMW0LDIIFMi8lslEPE7CdcbOp9jnaEDIsNb604xuy7rvQgyDmMWnv6ck/nn/44Yd71afTbtteQGc/+if0QCe76kM7CJ6uERc9s6P3XiO266677mND8Xg44jRXJCgoOpffsg0f3VehA7+l5F6DecG3hEdwgHE/FSLwbdK3lSJuoUe+J9jC7lz/Y36vAwMgWRYDJCKQrXCCo1XpSIbLOEAoSxVA2sicURkCQBmRAzlPmwwMvPoQhBxjuBKZ3D44ASDTo838ZeDmnjJTlzkIzs4PAbqGThFEssdkR13a23YOO+vLqkHf7MXG5rKkx4xh1KoWRhGAYAaHKbfQDTItIfSdDB2GraDoX3DgL31FW8aPvDxYoDyoDm7s9NxG8kjSzVgB0Vz5liSB8Ns56uh9573pfBwBX8crgqdjnAOHdPHss89WtnbzvU0knPjH+QQHea/awXZzyN4HBiAF9NSugY2jARsi8xmHo+wQW1PRloIMi0QYSWbDMDIf7YVYXJdA1GzjEN9z8hA6oqXTvoGBHumPcBj2EoBjN0GhJCmwvftJ+kCuxivDTba8FDsptyhjvvnmmx9lmYKa48o+fsXTjVg2KCEIJmSlPXoXHByPfbr2w6fYzGrc/3r2/QR+IhBLxNatANnE/YSpn8nvOq+h57GnR92VAukW34Q//LaUUlkzaNKV349yniQBVwnWcCz4ziV7HxgoEeFwKiCneMfUNBE9sFK6LMVKwM8mNAVg3WhmILVAX9SRCTGsjeMgGMElW7ONQ3xv3oBKgNbKASnIDOmjiyA63yNBSp6OcR2ys3Ge0ktl9lEehAM3eWHDuDna0gRReHRTkDRmq176spKgL2WJbbXprnNiSz6S+xrsyQabvqm8rm1kpp0EAuP23QMZs7Hr5ySKufs+Cpzjn+PV6sExyZXg6R5LMzBIQvmUBArX2NMrnsJLc8neBwaKo3gKFgiyLPXoHFKQwSR4APA6QRwifYKJNh3THrKRIVlByDy1e1KEkysZCK4ILITeNTDI2l3DHq6nSyTFCRDMGF9mMl4ryKwWrQgRLrvNtTRvwwvdHq2yQhiFTffGPE4Ka4KGX6RFJPRWQuBZkIwe6F+/9MQufYRNERg/gQ1jTTIlyfJ7QidRlMoEBHhPiRTBwyNdwX18R2IkcEgKJFu4hT2sxEqVEXe1wUEEBs7jjj6AU3zqtpSChBiEE2aZK1A0BdAZiVGRmT2H5KRWG0pI+XVDN59PigAxYqUDekUC5o/QuhBWyIITyIK1Jdi6Vt25VEZctwdbKn3pDwkKCuzvF1yVaZYkVjV//vOfq4BFJ0qZxOv//ve/VU2+i567zAnuJT42AcLj2vwFGdFPV7FaYFd6JvZ0bHUpWOz6GGzX/pd8nsTDwyxuONOT4IuDcBR70rnKBWyyA7+geytnWGUjCejcspc/u91UGmNQqgDAEJSNdGRBgOq9iOwc4EVMTXGuazgmQ1oKJsi4UcbIjmuLU5UugTTHs6T3Ai492iMA+gNghLAp05QBuUZQpcvoNtkxe8gu6bWkCGbGS2DCGO0F+eZSvmS/u7RlrP/+97+rFS/9eDouGDZmAa7kqorOJVGISRZrrz8Bu6u4zji1Y6XgfW48GzPyU6I6qWKF8PLLL1cJptIQHdOvJIjvSKzYGq/YnCPxglOJyyafmkqnBxEYKAswBQiOZsksy6JghAT4ojIys0cQbSJoIDEBQkYkCBCBAOAZkKOqF7ox2BZg2trd92P0lvlbMSB2ejV/el8n7tm4iYo4BFa6RRichE3chBxjxaBtfRLjY2+rQUt0gW1JQreClSALszBmzPSbEo2bmsZfQoJx5MVf9AXn+u66MhHIBAV+xqZ0KgFAeB65da9BeeSkCt6hU9+DgkP3HPyarr0nlPgPf5IQsQcbWEUcrVbhXi9BljGKApoAdNmL5ZmlGNBSNuAiCobgbAzFAByyTTjpo48+Wp2P+HJPAfjjRDIADnySBIDpUWCUdRI6EIjbMhxE4Vz6tFeekyXJjOjetVdfffUoKkzw53hszvbsuFSbXXHFFVU9mo7Onj1b6YuuYdm//SxdulTqGVLusVpIaVGAkEiZg6fB6Hpfv6hWEozKlm42u29JkmTCpJK2e0kSTt9doLul6exgAgPlIy838BC3TRBINsa5kDsSUyt3vE0EA4ZisLSVlYhr9SF7c+wkiWArMNIBQCN+Ga2A3FYT9Rn9Oc/5HEJG6nyfuWasFZcx6lfQEiT0y15t41yCDY2NfgROY0e0xu5RUD/TbQ6IZSnZJGITcAWv3DBVU0eCgpvVwhgrwSXYqusYJD9uRNMRXfEFN6SViiRWyoNLu99Vn9tBBYaj1UpAAJDNWJp7bcUApLIvzscojLVOnOMfs8t+ZEb+s5YyCGdQDxQwbr/99kUbdd3chh4XEAVbJKWGn5UDgDdXYPToJhy9+8wWJ0EmX/3qVzuXLnYZN7LVH1L1Wia7ye679FHyGrqlUwkN/XjKTulLkCDKSYhlCeKpL74gwbIKE+xJ7LzUADy17nCIcpLVQUqY/IHO8MlpYJjIIrIsRlDDA1zBgRG8J8hKoJB5ITWE0SaAni/iWNojQpkco6qvehQvztB2/aEe4/AIDDHQq9UTnXtNr5GUbwBfOY9N6NB5CSZjL52PV0+VpeRnbEqLuTdizEsTAUxiow5Nf7AmQFhFGO8rr7xy5p577qkwPefYBVj2NCY65kMCQuzLxlZrp3KmWqHiEf7ClgKp1ZSAnxV3AsbS9HVQKwbKVTvlWCIyY1C8LFc5Q60bQTjm0dM8Z9xmFEGE1MsdCOYk31SjDzePkYAvZrlB70Y88s/SGJE99dRTld6U6xAH58g9H++jW+2NJfqJM7K9WriSEhtyzCWKZ9f97LZyDB3Tr+BKd/mF2rYvaE45F/ZNCZEvCPT0aS9YGOu6Mu2U41xKXxIgQQDnCPaEfSWY4aKljLU+joMLDCYnOMhsGAA5WKKL1l4rC3mNnDYFhrqSTl9/XAMeRxRs6dfeCswTSJ5IkaULzLJJPyqGLDwUIKskVltTBNesTNjcGAQFTyfVA/3HZzX/O6tQ5Qd6RCaCg3KoEhi8Pv3002e+//3vz7paNQ4rcUmWujlfggebFaXPvD6VM5UN6UP1gr74CR3hJ4mU13hqikSprz0OMjCECOw5mKUvAHMyQcJx5MVgSiOn0k8DgOwfswC2gGAjsnQlESUbQcO9HfpVhkPUygxTLZ3d+LM6MMYs241ryfcZ6NA/kvdTzfBq3AKtVYNHfN07O14F3E9/+tNOnUUEWvc6EmTZU9DlS5KuIU87zTKhkTqFMzaEfZsVn2P0x5b0x4+UquF0aXKQgYGS810EYGUAkdkxy94Qhmh+KrtpwAoA+dKrlYHauDIDgpDp0rFzOAeH+MY3vjEpoRkHsVzPkj1PlO0242mugtHPfOYzVRAQZOlOQBMU7C9evFgF3LlWPn4eXNAnkix2Vl6kYyU7X1g8lTNVEurBFcmQhIl+YNKmzG0FYZM8nQaGCREjGMhsZKqyLnvEhawAGGERGeWp7KYBgLdysCGtlD0QhtcIQ7mOLaYWq0L9xhmVPYxliU7Y1I0vTwoAAizcJhM3dr/eKfuci4A9kkqnbOy1YCuARdfen8qZ6j6LYMB2grr7MoR+3HOz0vI9h7kC/DYbHeyKwcQtaxGUwODGD/KylHMDT537JD5ZtA0Qu34uwC4lyCoTSgKQqoxbOUsmbvm+D+LpJMTvV34F3zwijJAFiyeffINkC/IAAAg2SURBVLL6kbWp8UufxmBMdCzBEqxkxVYRbvA751TOVOUj3wCXjAgAHiSwUpCQChQChNXCUm/UH3RgANB8h0HkRha+hyDTUatVVuKAUzvYqeOMqwHZWZIARIaslLzc/NuHBw7UpO++++6qFu27NFYJAhwyNhe/7X/nnXdWPwo4riY/3rp7Hp6cEqg8gqkUIivOikFp9nTF8P86U53Ijfkrr7yywqTADovEqmGp5eyDDwwU7+vpSgt+XkBwQBqit5tmHO5UDksDvhxmlSgZIJxRqWOOktaumlWG8x+/7D3yaD7KDla877//fjUXQUL2PpXIdiVRfMoKzGohDxfQsceWT28+t1tDUjLVgxftI+h39OADA3UgBDf0lDo8d6+sJPvhZLKwUzksDVgVyGIt4XPfg51l4vskVrt5mkUmLtOUzPhmvh9l+9SnPjUp2dCf4GSlIMFCdoKDMdGve3r7FHz3CQtTj/VEBAZKBeJ8m3lqJZ/2N50GZNFquIhK7dujgRICtVyv90mUIqwI/vOf/1RkbJWLfD0NJjP30/BWE1Nlou+991612hYcrGQEipRCBIq83icdn461XQPTrUPb+z89eqqBohpwT0F5MCtChGXl4Kmkfcxm/ZCeIGde9n6s7tKlS9VPZDz88MPVTc2iClzTmCCrBCtQ0aWyrFKdYwKYG/v7cnN/zRRPD9c0cBoYaso4fbn/GvBkjMzaUyCemhEgrBj2bbUQSyjVnD9/vrrJKyNX589mFfTMM898dC8l14yxp8833nij+s6KIKVUR5RjPdDheyyncjgaODGlpMMx2elM1mnAs/V5XlyGq/btmOAgq91X8e1Yqx43et1rEBiIFYTfVrpw4UL1tNWY91A8HeUBDk8k+ReVbjYfrR6r9WQf3Xq6b6nP5O+r3ecc92lgmFP7p30X1YDVgieSrBiQJqJS6nATd5+flhEMbrvttupegzKOJ5Q8HaRk5ude3n777eo3lqwuxhBBQGASaN2rEwjc1xB8jcdnY/9a7hjzOm1zvQZOS0nrdXP6yZ5pwE1nqwNP73icUrkDqbphO+VjnWOozfPwAoHgZ36+R4CcfVnTnAXAPB9fun+rMPpTkhMkiO8v5OdlPAXmqb9TORwNnAaGw7HliZ8JknQvQTBQj3ePQfkDge27KBMp1yBp9Xw/XOjnzZ9//vnqKayf//zn1a+ylp6nYHP58uWPSnKCk4BEr3QsKFm1CMSncjgaOC0lHY4tT/xM1Lxtvhjm3oLAoOyRG6X7riAE7H6CgKBUpmTmRrC5eu9XWf3Ui8y+lAgEVgvKcXkKydNHApUbz+493HfffaffeC6l8IW0cxoYFmKI02GU1YAa/KH91In6/uc///nqJzF8cU8AkNG7t2CV9H/t3bFKJEEQxvE97inMjUxMNDIQY2MxFCMzMTbxfBIzMRTByGAPBDEQxMD8HuX21zDJCsepnWz1N7Dorjpu/XuZmqqvqloUoYHTjJ5eBz1DqkhXM83Ge6A1cLgckoc90nPUIvDz1+KoZVKsCYG6BDiDqV9Avp+24O6dg1CtpKx0a2uri1N07tvb2xaNGJKn25oDmgYS+v/6LDSO5qhFIBFDrfWMNQMQ2NzcbFqD/D4RWAmpdBmnwTF4Lor4TkOfDnLRANGbU/izGDopdeWQUqIviCZ2d3cHID6eiT8WH67s3D3eusfiFSfgbv7h4aHtHWx2EY2BFuCO3kXdFqDf2WJT05oyWNEB5yN1pRLKV2Wq5o0R+w8PD5sQveI48/aXCCRiWAKSpyGwCgREB4R2F3Aiu1JdlUIexoC4qOuY/kq1EMH5+vq6OQEVSCqhRB+qougJXuOEaA80hxz1CCRiqLemsWgQAoJ9aZ3fi9lJGvs8l0aiOUjznJ2dfTr/7xwiAx3VnA6HI42kDFi6iqAvWjg6Omr7Uw+Cejgz4+6HW/IYXIUAByDNo4z16emppXjc2evy3t7ebh3JRGni8P/oDZyCCaqmtooIRAOiA1u3qkQiNksl+dl30lRV+Fe2IxFD5dWNbUMQoDfc3Ny0DXzs30BzkOZxUTdo7+TkpOkB/yrfddF/f3+fPT8/t4hAf4RRF8ZraxCkXUhZcRbHx8eZi1T8kxXHUHyBY94YBJSq2rfh7u6ube7jQu9BL1Deenl52eYZudtfPvyOmUePj48tIlB95DFFJMRsv+O18/PzFqEsnyPPaxGIY6i1nrFmYALu6OkNOqPpAspNRQzu+qWcDg4O2p7NU+TAcXAoV1dXrYtZukjFkdellQjZvjroC3SFr4jZAy/Jypoex7CyS5c3HgIfCdAAXl9f28VeakiayYXeRV5qaX9/vz0MFhQhzOfz5kCUu/pbkcEkNKt8UpGkiU3TXAblfeRd9ZU4hqorG7uGJqDRzfC7+/v7tuubC7+7f+khQjQNYtq8yPNpgiqxmo7AoRiDoZHt4uKifT800MGMj2MYbMFj7jgEXNyVnL69vbUBeyqO9DiIIDgIh6hAammKKNbW1lpkYILr6enpbGNjo1UhjUMtliIQx5DPQQgUJyBamDbVsZ+DaMKwvZeXlxY9iAroC+vr67O9vb3Zzs5Ol1lLxbGWNi+OofTyxrgQCIEQ+DyBj7Vrnz9H/iIEQiAEQqAQgTiGQosZU0IgBEKgB4E4hh4Uc44QCIEQKEQgjqHQYsaUEAiBEOhBII6hB8WcIwRCIAQKEYhjKLSYMSUEQiAEehCIY+hBMecIgRAIgUIE4hgKLWZMCYEQCIEeBOIYelDMOUIgBEKgEIE4hkKLGVNCIARCoAeBOIYeFHOOEAiBEChE4C9ypnBTZ1cXmgAAAABJRU5ErkJggg==' },

        /* ---- Smudge ------------------------------------------------------------ */
        'Rake Smudge': { autoSpacing: 0.2, opacity: 100, flow: 100, spacing: 5, shape: "custom", hardness: 100, size: 70, angle: 90, scatter: 0, flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.15261],[0.060241,0.261044],[0.88755,1]], colorRate: 33, smudgeLength: 100, _tipUrl: "brushes/rake_smudge_tip.png" },
        'Blend Textured': { opacity: 100, flow: 100, spacing: 4, shape: "custom", hardness: 100, size: 70, angle: 0, scatter: 0, sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.122271],[0.136546,0.290033],[0.269076,0.803493],[0.333333,0.921397],[0.39759,0.956332],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.15261],[0.060241,0.261044],[0.88755,1]], texture: 100, textureScale: 1.61, colorRate: 50, smudgeLength: 100, texturePattern: "brushes/blend_textured_pattern.png", _tipUrl: "brushes/blend_textured_tip.png" },
        'Wet Area': { opacity: 14, flow: 100, spacing: 9, shape: "circle", size: 75, aspectRatio: 5.88, hardness: 100, angle: 0, scatter: 0, angleSrc: "random", colorRate: 33, smudgeLength: 100 },
        'Wet Modeling': { autoSpacing: 0.2, size: 30, opacity: 100, flow: 100, spacing: 5, hardness: 100, shape: "custom", angle: 90, scatter: 0, colorRate: 50, smudgeLength: 100, _tipUrl: "brushes/deevad-202210C_compact-fix.png", tipCells: 4, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.122271],[0.136546,0.290033],[0.269076,0.803493],[0.333333,0.921397],[0.39759,0.956332],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.15261],[0.060241,0.261044],[0.88755,1]], angleSrc: "tilt" },
        'Smudge': { size: 22, opacity: 100, flow: 100, spacing: 4, hardness: 30, shape: 'circle', colorRate: 0, smudgeLength: 82, sizeMin: 70 },

        /* ---- Erasers ----------------------------------------------------------- */
        'Eraser Tip': { size: 39, opacity: 100, flow: 100, spacing: 5, hardness: 100, shape: "custom", angle: 0, scatter: 0, blendMode: "erase", _tipUrl: "brushes/chalk_chisel_losange_202210A.png", tipCells: 4, tipPick: "random", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.497817],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.128414,0.100402],[0.473896,0.710843],[1,1]] },
        'Eraser Kneaded': { falloff: 'gauss', size: 200, opacity: 100, flow: 100, spacing: 10, hardness: 0, shape: "circle", aspectRatio: 1, angle: 0, scatter: 0, blendMode: "erase", sizeSrc: "pressure", sizeMin: 0, sizeCurve: [[0,0.487437],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.169082,0.306533],[0.270531,1]] },
        'Eraser Hard': { size: 20, opacity: 100, flow: 100, spacing: 6, hardness: 95, shape: 'circle', blendMode: 'erase', sizeSrc: 'none', flowSrc: 'none' },

        /* ---- Effects ----------------------------------------------------------- */
        'Round': { size: 12, opacity: 100, flow: 100, spacing: 15, hardness: 80, shape: 'circle' },
        'Splatter Large': { size: 200, opacity: 100, flow: 100, spacing: 11, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/splats_large.png", tipCells: 5, tipPick: "cycle", flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0],[0.2249,0.10917],[0.771084,1]], angleSrc: "random", tipMirror: true },
        'Splatter Light': { size: 200, opacity: 100, flow: 100, spacing: 33, hardness: 100, shape: "custom", angle: 0, scatter: 0, _tipUrl: "brushes/splat_dots.png", sizeSrc: "random", sizeMin: 0, sizeCurve: [[0,0.165939],[0.353414,0.424914],[1,1]], flowSrc: "pressure", flowMin: 0, flowCurve: [[0,0.152838],[0.261044,0.235808],[0.767068,1]], angleSrc: "random" },
        /* A knife is held at an angle and stays there: the mark is broad when
         * the blade is dragged sideways and near-invisible when it is dragged
         * along its own edge. Steering the blade to face the stroke (the old
         * angleSrc: 'direction') took that away and left a fat, even marker. */
        'Palette Knife': { size: 34, opacity: 100, flow: 100, spacing: 4, hardness: 100, shape: 'square', aspectRatio: 5, angle: 45, angleSrc: 'none', sizeSrc: 'none', flowMin: 70 },
    };


    engine.PRESET_CATEGORIES = [
        { name: 'Sketch',   presets: ['Pencil H', 'Mechanical Pencil', 'Thin Detail', 'Thin Regular', 'Thin Pointy', 'Thin Textured', 'Thin Hard Edge'] },
        { name: 'Paint',    presets: ['Fill Round', 'Oval Basic', 'Round Pressure', 'Block Glaze', 'Glaze Textured', 'Shape Blocker', 'Textured Block', 'Textured Crease', 'Bristle Thick', 'Bristle Modeling'] },
        { name: 'Bristle',  presets: ['Fan Brush', 'Dry Brush', 'Oil Round', 'Oil Flat', 'Impasto', 'Bristle Blender', 'Bristle Glaze', 'Rough Rake'] },
        { name: 'Airbrush', presets: ['Airbrush'] },
        { name: 'Texture',  presets: ['Charcoal Rock', 'Chaotic Irregular', 'Dry Scratch', 'Sponge', 'Noise Texture', 'Chisel Streaks', 'Scribbles', 'Dry Canvas', 'Canvas Rub', 'Feeding Canvas'] },
        { name: 'Smudge',   presets: ['Wet Modeling', 'Smudge', 'Rake Smudge', 'Blend Textured', 'Wet Area'] },
        { name: 'Erasers',  presets: ['Eraser Tip', 'Eraser Kneaded', 'Eraser Hard'] },
        { name: 'Effects',  presets: ['Round', 'Splatter Large', 'Splatter Light', 'Palette Knife'] },
    ];

    /* Grid order follows the families; anything not filed lands in "Other".
     *
     * Favourites and saved brushes come first and are the reason a preset can
     * appear twice: a favourite is a shortcut TO a brush, not a move, so it is
     * listed in both places and `seen` is only closed after the families. */
    function _groupedPresets() {
        var seen = {}, out = [], i, j, g, list, n;

        list = [];
        for (i = 0; i < engine.presetNames.length; i++) {
            n = engine.presetNames[i];
            if (engine.isFavourite(n)) list.push(n);
        }
        if (list.length) out.push({ name: 'Favourites', presets: list });

        list = engine.userPresetNames().filter(function (u) { return !!engine.PRESETS[u]; });
        if (list.length) {
            out.push({ name: 'My Brushes', presets: list });
            for (i = 0; i < list.length; i++) seen[list[i]] = 1;
        }

        for (i = 0; i < engine.PRESET_CATEGORIES.length; i++) {
            g = engine.PRESET_CATEGORIES[i];
            list = [];
            for (j = 0; j < g.presets.length; j++) {
                n = g.presets[j];
                if (engine.PRESETS[n] && !seen[n]) { seen[n] = 1; list.push(n); }
            }
            if (list.length) out.push({ name: g.name, presets: list });
        }
        list = [];
        for (n in engine.PRESETS) {
            if (engine.PRESETS.hasOwnProperty(n) && !seen[n]) list.push(n);
        }
        if (list.length) out.push({ name: 'Other', presets: list });
        return out;
    }

    engine.presetNames = [];
    function _rebuildNames() {
        engine.presetNames.length = 0;
        for (var n_ in engine.PRESETS) {
            if (engine.PRESETS.hasOwnProperty(n_)) engine.presetNames.push(n_);
        }
        /* Swatch scaling is measured against the biggest brush in the
         * library, so it is stale the moment the library gains or loses one.
         * Every route that changes the shape of PRESETS comes through here --
         * import, save, duplicate, delete -- so this is the one place it has
         * to be dropped. */
        _forgetSwatchScale();
    }
    _rebuildNames();

    engine._currentPreset = 'Round';

    // Per-preset map of "Relevant" data-setting keys (the rest go to Advanced).
    // size + opacity are always visible regardless of this map.
    var PB_RELEVANT = {
        'Round':       { size:1, opacity:1, hardness:1, spacing:1 },
        'Airbrush':    { size:1, opacity:1, airbrushMode:1, flow:1, hardness:1 },
        'Fan Brush':   { size:1, opacity:1, bristleCount:1, bristleWidth:1, bristleSpread:1, bristleLength:1 },
        'Dry Brush':   { size:1, opacity:1, bristleCount:1, bristleWidth:1, bristleSpread:1, bristleLength:1, flow:1 },
        'Scribbles':   { size:1, opacity:1, spacing:1, hardness:1, flow:1 },
        'Chisel Streaks': { size:1, opacity:1, angle:1, aspectRatio:1, spacing:1, taperStart:1, taperEnd:1 }
    };

    /* Fetch an image and bake it into the one shape every tip in this engine
     * is in: black, with the picture's darkness as its alpha. Both tips come
     * through here -- only what is done with the result differs. */
    function _loadTipImage(url, forPreset, done) {
        _tipResolve(url, function (real) {
            if (real) _loadTipImageAt(real, forPreset, done);
            else console.error('[KritaEngine] tip image is gone:', url);
        });
    }

    function _loadTipImageAt(url, forPreset, done) {
        var img = new Image();
        _pendingLoads.push(img);

        function _cleanup() {
            var idx = _pendingLoads.indexOf(img);
            if (idx >= 0) _pendingLoads.splice(idx, 1);
        }

        img.onerror = function () {
            console.error('[KritaEngine] Failed to load custom tip:', url, '— shape stays as', _params.shape);
            _cleanup();
        };
        img.onload = function () { _drawRaw(img, function (img) {
            try {
                console.log('[KritaEngine] Tip image loaded:', img.width + 'x' + img.height);
                var oc = new OffscreenCanvas(img.width, img.height);
                var ox = oc.getContext('2d');
                ox.drawImage(img, 0, 0);
                var id = ox.getImageData(0, 0, oc.width, oc.height);
                var d = id.data;
                /* Where the ink is, in one of two ways. A picture that
                 * carries transparency has already said so and its colours
                 * are not coverage; a flat opaque one is a stamp scanned on
                 * white, where dark is ink. Reading the greys of the first
                 * kind as coverage as well cut a coloured tip to nothing.
                 *
                 * The colours are kept either way: a lightness-mapped or a
                 * coloured tip paints with them. */
                var clear = false, i;
                for (i = 3; i < d.length; i += 4) { if (d[i] < 250) { clear = true; break; } }
                for (i = 0; i < d.length; i += 4) {
                    var lum  = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
                    var srcA = d[i + 3] / 255;
                    d[i + 3] = Math.round((clear ? srcA : 1 - lum) * 255);
                }
                /* The image arrives whenever the network says so, and by
                 * then the user may have moved to another brush. Stamping
                 * this tip onto that one turns a plain round brush into
                 * somebody else's chalk. */
                if (forPreset && engine._currentPreset !== forPreset) {
                    _cleanup();
                    return;
                }
                ox.putImageData(id, 0, 0);
                done(oc);
            } catch (e) {
                console.error('[KritaEngine] Error processing custom tip:', e);
            }
            _cleanup();
        }); };
        // Only use convertFileSrc for absolute file:// paths — relative URLs
        // work directly via the page's base URL and the dev server / Tauri
        // custom protocol handler.
        if (/^(file|asset):/.test(url)) {
            try {
                var _tauri = window.__TAURI__;
                var _cvt = _tauri && typeof _tauri.convertFileSrc === 'function'
                    ? _tauri.convertFileSrc : null;
                if (!_cvt && _tauri && _tauri.core && typeof _tauri.core.convertFileSrc === 'function')
                    _cvt = _tauri.core.convertFileSrc;
                if (_cvt) {
                    var converted = _cvt(url);
                    console.log('[KritaEngine] convertFileSrc:', url, '→', converted);
                    img.src = converted;
                    return;
                }
            } catch (e_) {
                console.warn('[KritaEngine] convertFileSrc failed:', e_);
            }
        }
        img.src = url;
    }

    // a tip or paper image still loading: the Krita bank waits on this, not a fixed 600ms
    engine.loading = function () { return _pendingLoads.length > 0; };

    engine.loadCustomTip = function (url, forPreset) {
        console.log('[KritaEngine] loadCustomTip called with:', url);
        _loadTipImage(url, forPreset, function (oc) {
            _customTipRaw = oc;
            _rebakeTip();
            _params.shape = 'custom';
            _customTipSizeCache = {}; _tipCacheBytes = 0;
            console.log('[KritaEngine] Custom tip baked, shape set to custom');
            engine.syncPanel();
        });
    };

    /* The second tip carves the first, so it never becomes the shape and
     * never touches the tip-cell machinery -- one image, used whole. */
    engine.loadDualTip = function (url, forPreset) {
        if (!url) { _tip2Canvas = null; _tip2Tile = { key: '', canvas: null, pitch: 1 }; return; }
        _loadTipImage(url, forPreset, function (oc) {
            _tip2Canvas = oc;
            _tip2Tile = { key: '', canvas: null, pitch: 1 };
            _invalidateSwatch(engine._currentPreset);
            engine.refreshPreview();
        });
    };

    engine.loadPreset = function (name) {
        var preset = engine.PRESETS[name];
        if (!preset) return false;
        for (var i = 0; i < _paramMeta.length; i++) {
            var k = _paramMeta[i];
            var v = (k in preset) ? preset[k] : engine.DEFAULTS[k];
            // Curves are arrays. Handing out the preset's own array would let
            // editing one brush's curve rewrite the preset and every other
            // brush that inherited it.
            _params[k] = _isArray(v) ? _cloneCurve(v) : v;
        }
        engine._currentPreset = name;
        _tipCycle = 0;   // an in-order pipe starts from its first cell, as GIMP's does
        _loadSavedParams(name);
        // The tile for a preset is rendered from live params while it is the
        // active one, so its cached copy is stale as soon as it stops being.
        _invalidateSwatch(name);

        // If preset has a custom tip URL, load it asynchronously.
        // _params.shape is already 'custom' from the preset — _renderDab
        // will fall back to a circle mask if _customTipCells is still null.
        engine.loadDualTip(preset._tip2Url || '', name);
        if (preset._tipUrl) {
            console.log('[KritaEngine] Preset', name, 'has _tipUrl:', preset._tipUrl);
            engine.loadCustomTip(preset._tipUrl, name);
        }

        /* Cleared first: a brush with no pattern of its own must not inherit
         * the last one's, which is the same late-arrival trap the tips had. */
        _patWanted = null;
        if (_params.texturePattern) _loadTexturePattern(_params.texturePattern, name);
        // Bare preset switches must not leave the previous brush's warnings up.
        _syncNotesDiv();

        return true;
    };

    /* The old single dropdown, kept as a shortcut. It never appeared in any
     * preset — it was always a transient UI control — so translating it breaks
     * nothing, and it now writes the same per-parameter keys the new controls
     * do rather than being a separate mechanism the engine has to understand. */
    var _DYN_MODE_MAP = {
        off:       {},
        direction: { angleSrc: 'direction' },
        angle:     { angleSrc: 'random' },
        size:      { sizeSrc: 'random', sizeMin: 0 },
        opacity:   { flowSrc: 'random', flowMin: 0 },
        flow:      { flowSrc: 'random', flowMin: 0 }
    };

    function _applyDynamicsMode(mode) {
        // Put the parameters this shortcut owns back to their defaults first,
        // or switching between modes would leave the previous one's settings
        // silently in place.
        var owned = ['angleSrc', 'sizeSrc', 'sizeMin', 'flowSrc', 'flowMin'];
        for (var i = 0; i < owned.length; i++) {
            _params[owned[i]] = engine.DEFAULTS[owned[i]];
        }
        var m = _DYN_MODE_MAP[mode];
        if (!m) return;
        for (var k in m) {
            if (m.hasOwnProperty(k)) _params[k] = m[k];
        }
    }

    engine.setParam = function (key, value) {
        _params[key] = value;
        if (key === 'dynamicsMode') _applyDynamicsMode(value);
        _persistParams();
        /* Smoothing is a feel-of-the-hand setting and the swatch renders with
         * it forced off, so redrawing one after a smoothing change costs a
         * whole brush stroke to produce the identical picture. */
        if (key.indexOf('smoothing') !== 0) {
            _invalidateSwatch(engine._currentPreset);
            engine.refreshPreview();
        }
        if (key === 'size' || (key.indexOf('smoothing') === 0 && key !== 'smoothingMode')) {
            if (key === 'size') _updateRibbonSize();
            var szEl = document.getElementById(key === 'size' ? 'pb-size' : 'pb-smoothing');
            var szVal = document.getElementById((key === 'size' ? 'pb-size' : 'pb-smoothing') + '-val');
            if (szEl) {
                var max = parseFloat(szEl.max) || 100;
                if (value > max) {
                    var wrap = szEl.parentNode;
                    if (wrap) wrap.dataset.overflowVal = value;
                    szEl.value = max;
                } else {
                    var wrap = szEl.parentNode;
                    if (wrap) delete wrap.dataset.overflowVal;
                    szEl.value = value;
                }
            }
            if (szVal) szVal.textContent = value;
        }
    };

    engine.getParams = getParams;

    engine.beginStroke = function (x, y, pressure, color) {
        _strokeSeed = _pinnedSeed == null
            ? Math.floor(Math.random() * 2147483647) : _pinnedSeed;
        _dabIndex = 0; _mkLast = null; _gridSt = null; _pxOff = null; _adAvg = 0; _adColOn = 0;
        /* Freeze the params for this stroke (see the getParams seam): a copy,
         * not the pointer — setParam mutates _params in place. Iterates _params
         * itself rather than _paramMeta so saved-override keys outside DEFAULTS
         * survive too; curves are cloned, scalars are immutable. */
        _strokeParams = {};
        for (var _fk in _params) {
            if (_params.hasOwnProperty(_fk)) _strokeParams[_fk] = _isArray(_params[_fk]) ? _cloneCurve(_params[_fk]) : _params[_fk];
        }
        _wet = [];                // the brush is loaded fresh each stroke
        _smPrev = null; _smT = null; _smS = null; _smPic = null; _smCar = null; _smPx = _smPy = NaN;
        _wetPos = [];
        _smoothAngle = NaN;
        _lastDabDist = 0;
        _smoothPosX = x; _smoothPosY = y;
        _smoothBuffer = [];
        _spLast = null; _spDists = [0];
        _lazyX = x; _lazyY = y;
        _stabilizerX = x; _stabilizerY = y;
        _lastRawX = x; _lastRawY = y;
        if (_state.paintRaf) {
            cancelAnimationFrame(_state.paintRaf);
            _state.paintRaf = null;
        }
        _state.isDrawing = true;
        _state.strokePoints = [{ x: x, y: y, pressure: pressure || 0.5, color: color, dist: 0, t: performance.now() }];
        _mpS = null;
        _state.lastColor = color;
        _state.lastProcessedIdx = 0;
        _state.started = false;
        _state.suspend = null;
        _suspendCount = 0;
        _state.bounds = { x1: x, y1: y, x2: x, y2: y };
        var cw = _docW() || 1024;
        var ch = _docH() || 1024;
        _ensureFlowBuffer(cw, ch);
        _clearFlowUsed();
        _clearCovUsed();   // wet-blend coverage is per-stroke: a new stroke paints over a dried one at full strength
        _dirtyRect = null;
        _clearBounds = null;
        _ensureBgCanvas(cw, ch);
        try {
            /* 'copy' wipes whatever the buffer held and lays the layer down
             * in one pass. The separate full-canvas clearRect it replaces
             * was 8ms at 4000x4000, every stroke. */
            _bgCtx.save();
            _bgCtx.globalCompositeOperation = 'copy';
            _bgCtx.drawImage(_outCtx().canvas, 0, 0);
            _bgCtx.restore();
        } catch (e) {
            _bgCtx.restore();
            console.warn('[brush] bgCanvas capture failed:', e);
        }

        _selStencil = _buildSelectionStencil();
        /* Only a brush that mixes with what is underneath ever reads this,
         * and reading it back is 19ms at 4000x4000 — which every other
         * brush was paying at the start of every stroke. */
        _sampleTiles = null;
        if (getParams().colorRate < 100) _primeSampleCache();

        // The airbrush timer keeps dabbing where the cursor stopped; a preview
        // has no cursor and renders synchronously, so it stays off.
        if (getParams().airbrushMode && !_previewTarget) {
            _startAirbrush(x, y, color);
        }
        _hideRopeSvg();
    };

    engine.moveStroke = function (x, y, pressure, color) {
        if (!_state.isDrawing) return;
        _lastRawX = x; _lastRawY = y;
        // Live read: the stroke path follows the hand; only rendering freezes.
        var p2 = _params;
        var mode = p2.smoothingMode || 'none';
        var amount = _activeSmoothingValue();
        var speed = _strokeSpeed(x, y);
        var speedScale = Math.min(1, speed * 0.05);
        switch (mode) {
            case 'basic':
                if (amount > 0) {
                    var effective = amount * (1 + speedScale);
                    var factor = 1 / (1 + effective * 0.03);
                    _smoothPosX = _lerp(_smoothPosX, x, factor);
                    _smoothPosY = _lerp(_smoothPosY, y, factor);
                    x = _smoothPosX; y = _smoothPosY;
                } else {
                    _smoothPosX = x; _smoothPosY = y;
                }
                break;
            case 'weighted':
                _smoothBuffer.push({ x: x, y: y, pressure: pressure });
                if (_smoothBuffer.length > Math.max(50, amount)) _smoothBuffer.shift();
                if (_smoothBuffer.length >= 3) {
                    var avg = _computeWeightedAverage(_smoothBuffer, amount);
                    x = avg.x; y = avg.y;
                    pressure = avg.pressure;
                }
                _smoothPosX = x; _smoothPosY = y;
                break;
            case 'stabilizer':
                {
                    var dz = _stabilizerDeadZone(amount);
                    var dx = x - _stabilizerX, dy = y - _stabilizerY;
                    var dist = _hypot(dx, dy);
                    if (dist > dz) {
                        var move = dist - dz;
                        _stabilizerX += (dx / dist) * move;
                        _stabilizerY += (dy / dist) * move;
                    } else if (dist > 0.5) {
                        var creep = 0.1 / (1 + amount * 0.03);
                        _stabilizerX = _lerp(_stabilizerX, x, creep);
                        _stabilizerY = _lerp(_stabilizerY, y, creep);
                    }
                    x = _stabilizerX; y = _stabilizerY;
                    _smoothPosX = x; _smoothPosY = y;
                }
                break;
            case 'rope':
                if (amount > 0) {
                    var effective = amount * (1 + speedScale);
                    var dx = x - _lazyX, dy = y - _lazyY;
                    var dist = _hypot(dx, dy);
                    if (dist > effective) {
                        var move = dist - effective;
                        _lazyX += (dx / dist) * move;
                        _lazyY += (dy / dist) * move;
                    }
                    x = _lazyX; y = _lazyY;
                }
                _smoothPosX = x; _smoothPosY = y;
                break;
            case 'pixel':
                x = _round(x); y = _round(y);
                _smoothPosX = x; _smoothPosY = y;
                break;
            default:
                _smoothPosX = x; _smoothPosY = y;
                break;
        }
        if (mode === 'rope') {
            _updateRopeSvg(_lastRawX, _lastRawY, x, y, amount, speedScale);
        } else {
            _hideRopeSvg();
        }
        var pts = _state.strokePoints;
        var prevPt = pts.length > 0 ? pts[pts.length - 1] : null;
        var dist = prevPt ? (prevPt.dist || 0) + _hypot(x - prevPt.x, y - prevPt.y) : 0;
        pts.push({ x: x, y: y, pressure: pressure || 0.5, color: color, dist: dist, t: performance.now() });
        _state.lastColor = color;
        // Track bounding box incrementally so endStroke doesn't need to
        // scan all points for the background-restore region.
        var b = _state.bounds;
        if (b) { if (x < b.x1) b.x1 = x; if (y < b.y1) b.y1 = y; if (x > b.x2) b.x2 = x; if (y > b.y2) b.y2 = y; }
        if (p2.airbrushMode) {
            _airbrushLastPos = { x: x, y: y };
            _airbrushLastColor = color;
        }
        _schedulePaint();
    };

    engine.endStroke = function () {
        // endStroke() doubles as a cleanup call — the paint engine invokes it
        // whenever it needs to guarantee no stroke is in flight (closing a
        // modal, switching document, snapshotting a tab). Only a stroke that
        // was genuinely in progress may record an undo step; otherwise every
        // such cleanup call appends a phantom history entry AND truncates the
        // redo stack, because saveState() drops everything after the cursor.
        var wasDrawing = _state.isDrawing;
        _state.isDrawing = false;
        _hideRopeSvg();
        _stopAirbrush();
        if (_state.paintRaf) {
            cancelAnimationFrame(_state.paintRaf);
            _state.paintRaf = null;
        }
        var pts = _state.strokePoints;
        // Stabilizer catch-up: inject interpolated points from delayed position to raw cursor
        if (pts.length > 0) {
            var mode = _params.smoothingMode || 'none';
            if (mode === 'stabilizer') {
                var last = pts[pts.length - 1];
                var cdx = _lastRawX - last.x, cdy = _lastRawY - last.y;
                var catchDist = _hypot(cdx, cdy);
                if (catchDist > 1) {
                    var steps = _min(10, _max(3, _round(catchDist / 2)));
                    for (var ci = 1; ci <= steps; ci++) {
                        var t = ci / steps;
                        var cx = _lerp(last.x, _lastRawX, t);
                        var cy = _lerp(last.y, _lastRawY, t);
                        var pp = pts[pts.length - 1];
                        var cd = (pp.dist || 0) + _hypot(cx - pp.x, cy - pp.y);
                        pts.push({ x: cx, y: cy, pressure: 0.5, color: _state.lastColor, dist: cd });
                        var b2 = _state.bounds; if (b2) { if (cx < b2.x1) b2.x1 = cx; if (cy < b2.y1) b2.y1 = cy; if (cx > b2.x2) b2.x2 = cx; if (cy > b2.y2) b2.y2 = cy; }
                    }
                }
            }
        }
        _flushPending(true);
        _state.strokePoints = [];
        _state.lastProcessedIdx = 0;
        // Defensive: the drain above consumes any suspend, the final branch
        // clears it — nothing may leak into the next stroke either way.
        _state.suspend = null;
        // Per-stroke buffers: a full-canvas stencil and a full-canvas
        // pixel copy are not worth holding on to between strokes.
        _selStencil = null;
        _sampleTiles = null;
        // Unfreeze the params (see the getParams seam) — after the final
        // flush above, which must still decide and paint frozen.
        _strokeParams = null;
        if (wasDrawing && !_previewTarget
            && app.saveState && typeof app.saveState === 'function') {
            app.saveState();
        }
    };

    /* Which tapers actually need the finished stroke, and which do not.
     *
     * A START taper is a function of distance from the first dab, which every
     * live pass already knows -- only the END taper and 'stroke' units need a
     * total that does not exist until the pen lifts. So a start-only, brush-
     * relative taper can skip the replay along with the taperless brushes,
     * which matters because the two most expensive presets we ship are in
     * exactly that shape.
     *
     * The one case a start-only taper still needs it: a stroke shorter than
     * its own ramp gets both ends scaled down to fit, and that too is a
     * judgement about the whole stroke. The bound below is deliberately
     * generous -- it uses the base size where the real ramp uses the dab's
     * pressure-scaled one, so it replays a little more often than it must
     * rather than a little less.
     *
     * ponytail: an end taper still replays the WHOLE stroke to redraw its
     * last few percent -- 103ms on mouse-up for Fan Brush at 3000x2000,
     * against 5ms for every preset that skips it. Three presets pay this
     * (Fan Brush, Dry Brush, Chisel Streaks). Repainting only the tail needs
     * the dab PHASE at the restart index -- spacing is cumulative, so picking
     * up mid-stroke lands dabs off the live pass's grid and seams. Record
     * `_lastDabDist` per point if this ever needs fixing properly. */
    /* A Clip Studio ribbon is laid as far as the pen went and no further: its
     * last picture is cut straight across there (Chain stopped at 895 where
     * ours laid its last link whole, to 987). Ours stamps whole pictures, so
     * the part past the pen is wiped from the stroke before it is flushed.
     * ponytail: only within a picture's length of the end, so a stroke that
     * doubles back over its own end would lose ink there too. */
    function _clipRibbonEnd(pts, len) {
        var e = pts[pts.length - 1], i = pts.length - 2;
        while (i > 0 && _hypot(e.x - pts[i].x, e.y - pts[i].y) < 2) i--;
        var dx = e.x - pts[i].x, dy = e.y - pts[i].y, d = _hypot(dx, dy);
        if (d < 0.001) return;
        dx /= d; dy /= d;
        [_flowCtx, _adCtx].forEach(function (c) {
            if (!c) return;
            c.save();
            c.beginPath();
            c.arc(e.x, e.y, len * 1.5, _atan2(dy, dx) - _PI / 2, _atan2(dy, dx) + _PI / 2);
            c.closePath();
            c.clip();
            c.clearRect(e.x - len * 2, e.y - len * 2, len * 4, len * 4);
            c.restore();
        });
    }

    /* Clip Studio's second brush (BrushPack.sutSecond), a brush of its own
     * whose dabs Clip Studio lays in turn with the first's on one stroke:
     * under what is there (op 'destination-over': Rose's leaves sit behind
     * every flower). Clip Studio's cut (mode 12, 'cut') is taken off the
     * finished first instead, see _subCanvas. The flow buffer holds this
     * stroke alone, so a cut takes nothing from what was on the layer before.
     * _secondState swaps the running brush's state for the other's.
     * ponytail: painted in the pen-up replay only, so it is missing while
     * the stroke is drawn and from the swatches; and in turn a pen report
     * at a time, not a dab, so reports further apart than the first
     * brush's radius leave a cut Clip Studio would fill. */
    var _second2 = { src: null, key: '', cells: null, cache: {} };
    function _secondOf() {
        var pr = engine.PRESETS[engine._currentPreset];
        return !_previewTarget && pr && pr.second || null;
    }
    function _secondState(sec) {
        var p = {}, k, c = _second2;
        for (k in engine.DEFAULTS) p[k] = engine.DEFAULTS[k];
        for (k in sec.p) p[k] = sec.p[k];
        p.tip2Depth = 0;
        var key = engine._currentPreset + '|' + (p.tipCells || 1);
        if (c.src !== _tip2Canvas || c.key !== key) {
            c.src = _tip2Canvas; c.key = key; c.cache = {};
            c.cells = _tip2Canvas ? _sliceCells(_tip2Canvas, p.tipCells || 1, p.tipMirror, p.tipFlip) : null;
        }
        if (!c.cells && p.shape === 'custom') p.shape = 'round';
        return [p, p, c.cells, c.cache, 0, null, null, null, 0, [], NaN, 0, 0];
    }
    function _swapState(s) {
        var t = [_params, _strokeParams, _customTipCells, _customTipSizeCache, _dabIndex, _mkLast, _gridSt,
                 _pxOff, _adAvg, _wet, _smoothAngle, _lastDabDist, _tipCycle];
        _params = s[0]; _strokeParams = s[1]; _customTipCells = s[2]; _customTipSizeCache = s[3];
        _dabIndex = s[4]; _mkLast = s[5]; _gridSt = s[6]; _pxOff = s[7]; _adAvg = s[8]; _wet = s[9];
        _smoothAngle = s[10]; _lastDabDist = s[11]; _tipCycle = s[12];
        _kReuse = null; _tintMask = null;
        return t;
    }
    // Both brushes along pts, a segment of each in turn.
    function _paintBoth(pts, color, sec) {
        var st = _secondState(sec), n = pts.length, main = _flowCtx;
        _subOn = sec.op === 'subtract' || sec.op === 'min' || sec.op === 'cut' || sec.op === 'contrast' ? sec.op : false;
        if (_subOn) {
            if (!_subCanvas || _subCanvas.width !== _flowCanvas.width || _subCanvas.height !== _flowCanvas.height) {
                _subCanvas = new OffscreenCanvas(_flowCanvas.width, _flowCanvas.height);
                _subCtx = _subCanvas.getContext('2d', { willReadFrequently: true });
            } else _subCtx.clearRect(0, 0, _subCanvas.width, _subCanvas.height);
        }
        /* ...except mode 2's lightening second brush, laid over the finished
         * first: Glitter's last dab carries the sparkles of the whole patch
         * behind it (39% of it lit; in turn left 4%), where one click on
         * its own gets its 2 (cdp-csp/pgl, pgc). */
        var after = sec.p.cutByLight;
        for (var pass = 0; pass < (after ? 2 : 1); pass++)
        for (var i = 0; i < _max(1, n - 1); i++) {
            for (var w = after ? pass : 0; w < (after ? pass + 1 : 2); w++) {
                if (w) { st = _swapState(st); if (_subOn) _flowCtx = _subCtx; else _flowCtx.globalCompositeOperation = sec.op; }
                try {
                    if (n === 1) _renderDab(pts[0].x, pts[0].y, pts[0].pressure || 0.5, color);
                    else _processSegment(pts, i, i + 1, color, 2);
                } finally {
                    if (w) { _flowCtx = main; _flowCtx.globalCompositeOperation = 'source-over'; st = _swapState(st); _second2.cache = st[3]; }
                }
            }
        }
    }

    /* How far out a Clip Studio spray particle lands, as a share of the
     * patch's radius, from a uniform u. Bias 0 is even over the disk; below
     * 0, even over a ring whose inner edge is -bias% of the radius (cdp-csp/sb).
     * At 100 the distance itself thins evenly to the rim, density 2(1 - r):
     * Glitter's sparse 3px particles (cdp-csp/qg, twelve draws) and sb's at
     * 100 once their overlap is undone, where the r(1 - r)^2 we had put too
     * few on the line and Glitter's 10px sparkles overlapped too little (ink
     * 1.1). Between, the two draws blend (sb at 50 as well as any rule). */
    function _diskR(bias, u) {
        if (bias < 0) { var a = _min(0.99, -bias / 100); return Math.sqrt(a * a + u * (1 - a * a)); }
        var b = _min(1, bias / 100);
        return (1 - b) * Math.sqrt(u) + b * (1 - Math.sqrt(1 - u));
    }

    function _needsReplay(p, pts) {
        if (!(p.taperStart > 0 || p.taperEnd > 0)) return false;
        if (p.taperEnd > 0) return true;
        if (p.taperUnit === 'stroke') return true;
        var last = pts[pts.length - 1];
        var totalDist = (last && last.dist) || 0;
        return totalDist < (p.taperStart / 100) * p.size * 30;
    }

    /* Krita's experiment brush ("Shapes Alchemy"), which is not a brush at
     * all: nothing is stamped, the line you draw is a closed outline and the
     * inside of it is filled. So it has no dabs, no spacing and no tip, and
     * it is drawn from scratch every frame -- one fill, however long the
     * stroke, which is cheaper than the dabs it replaces.
     *
     * The fill rule is the brush's own: Krita's "winding fill" is nonzero,
     * and without it a stroke that crosses itself leaves the crossing hollow,
     * which is most of what the brush is for. */
    function _paintShapeStroke(pts, colorHex) {
        _ensureFlowBuffer(
            (app.config ? app.config.width : 1024),
            (app.config ? app.config.height : 1024)
        );
        _clearFlowUsed();
        _dirtyRect = null;
        if (!_flowCtx || pts.length < 3) return;
        var p = getParams();
        var x1 = pts[0].x, y1 = pts[0].y, x2 = x1, y2 = y1, i;
        _flowCtx.save();
        _flowCtx.beginPath();
        _flowCtx.moveTo(pts[0].x, pts[0].y);
        for (i = 1; i < pts.length; i++) {
            _flowCtx.lineTo(pts[i].x, pts[i].y);
            if (pts[i].x < x1) x1 = pts[i].x;
            if (pts[i].y < y1) y1 = pts[i].y;
            if (pts[i].x > x2) x2 = pts[i].x;
            if (pts[i].y > y2) y2 = pts[i].y;
        }
        _flowCtx.closePath();
        _flowCtx.fillStyle = colorHex;
        _flowCtx.globalAlpha = _clamp(p.flow / 100, 0, 1);
        _flowCtx.fill(p.shapeWinding === false ? 'evenodd' : 'nonzero');
        _flowCtx.restore();
        var M = 2;
        _dirtyRect = { x1: x1 - M, y1: y1 - M, x2: x2 + M, y2: y2 + M };
        if (!_clearBounds) _clearBounds = { x1: x1 - M, y1: y1 - M, x2: x2 + M, y2: y2 + M };
        else {
            if (x1 - M < _clearBounds.x1) _clearBounds.x1 = x1 - M;
            if (y1 - M < _clearBounds.y1) _clearBounds.y1 = y1 - M;
            if (x2 + M > _clearBounds.x2) _clearBounds.x2 = x2 + M;
            if (y2 + M > _clearBounds.y2) _clearBounds.y2 = y2 + M;
        }
        _flowUsed = { x1: x1 - M, y1: y1 - M, x2: x2 + M, y2: y2 + M };
    }

    /* Krita's sketch brush, as its own renders show it (test/krita/probes/
     * sketch, job.mjs and reach.mjs). No dabs: each new point of the stroke
     *  - joins the one before it with a line (the "connection line"), and
     *  - joins every earlier point closer than half the brush size with a
     *    line trimmed by `sketchOffset` of its length at both ends -- 20%
     *    left a 12px gap filled from 2.4 to 9.6 -- drawn with probability
     *    `sketchProb`.
     * Lines are the preset's line width, hard-edged, at the opacity its
     * curve reads at the pen's pressure, and they stack as ordinary paint:
     * 1..6 chrome lines measured 125, 189, 221, 238, 246, 250. The history
     * is the input points; a scripted Krita line is one segment, so it has
     * none, which is why a straight probe line came out as a bare hairline.
     *
     * ponytail: O(history) per point -- a grid of past points if very long
     * strokes get slow. Magnetify off, distance density/opacity: guessed
     * linear falloff, unmeasured. Wide lines are anti-aliased; Krita's hard. */
    function _paintSketch(pts, from, to) {
        var p = getParams(), c = _flowCtx;
        if (!c) return;
        c.save();
        c.fillStyle = c.strokeStyle = _state.lastColor;
        c.lineCap = 'round';
        var off = p.sketchOffset == null ? 0.3 : p.sketchOffset, prob = p.sketchProb == null ? 1 : p.sketchProb;
        for (var i = _max(1, from + 1); i <= to; i++) {
            var b = pts[i], sc = { pressure: b.pressure, x: b.x, y: b.y };
            var w = _max(0.9, _dyn(p, 'sketchWidth', p.sketchWidth || 1, sc, 0));   // Krita's floor
            var o = _clamp(_dyn(p, 'flow', p.flow / 100, sc, 0), 0, 1);
            var reach = _dyn(p, 'size', p.size, sc, 0) / 2;
            c.lineWidth = w;
            _sketchLine(c, pts[i - 1], b, w, o, i > 1);
            for (var j = 0; j < i - 1; j++) {
                var q = pts[j], dx = q.x - b.x, dy = q.y - b.y, D = _hypot(dx, dy);
                if (D >= reach || D < 1e-6) continue;
                var f = 1 - D / reach, a = o, pr = prob;
                if (p.sketchDistOpacity) a *= f;
                if (p.sketchDistDensity) pr *= f;
                if (pr < 1 && _dabRand(i, j, 29) >= pr) continue;
                var s0 = { x: b.x + dx * off, y: b.y + dy * off };
                var s1 = p.sketchMagnet === false   // fur: centred on the new point, pointing at the old one
                    ? { x: b.x - dx * off, y: b.y - dy * off } : { x: q.x - dx * off, y: q.y - dy * off };
                _sketchLine(c, s0, s1, w, a, false);
            }
            // the reach round the new point, and the whole connection line back
            var a0 = pts[i - 1], M = _max(reach, w) + 2, r = { x1: _min(a0.x, b.x) - M, y1: _min(a0.y, b.y) - M,
                x2: _max(a0.x, b.x) + M + 1, y2: _max(a0.y, b.y) + M + 1 };
            _dirtyRect = _unionRect(_dirtyRect, r);
            _clearBounds = _unionRect(_clearBounds, r);
            _flowUsed = _unionRect(_flowUsed, r);
        }
        c.restore();
    }
    /* Krita's particle brush: `count` particles start on the stroke's first
     * point, their velocity seeded with that point itself, and each new input
     * point pulls them `iterations` times -- particle j with the force
     * (j + iterations) / 2, damped by gravity, moved 0.00003 of the velocity
     * a step. Every step lays a bilinear 2x2 of weight * 255, added up to
     * full within the point's pass; passes then stack as ordinary paint.
     * No spacing: one pass per input point, so a scripted Krita line is one.
     *
     * ponytail: a canvas-sized alpha array while the stroke lasts. */
    var _ptSt = null, _ptA = null;
    function _paintParticle(pts, from, to) {
        var p = getParams(), pc = p.particle;
        if (!_flowCtx || !pc) return;
        var W = _flowCanvas.width, H = _flowCanvas.height, n = pc.count, it = pc.iterations;
        if (from === 0 || !_ptSt || _ptSt.x.length !== n) {
            _ptSt = { x: new Float64Array(n), y: new Float64Array(n), vx: new Float64Array(n), vy: new Float64Array(n) };
            for (var j = 0; j < n; j++) { _ptSt.x[j] = _ptSt.vx[j] = pts[0].x; _ptSt.y[j] = _ptSt.vy[j] = pts[0].y; }
        }
        if (!_ptA || _ptA.length !== W * H) _ptA = new Uint8ClampedArray(W * H);
        var X = _ptSt.x, Y = _ptSt.y, VX = _ptSt.vx, VY = _ptSt.vy, A = _ptA;
        var g = pc.gravity, sx = pc.scaleX, sy = pc.scaleY, wt = 255 * pc.weight;
        for (var i = _max(1, from + 1); i <= to; i++) {
            var tx = pts[i].x, ty = pts[i].y, x1 = W, y1 = H, x2 = -1, y2 = -1;
            for (var k = 0; k < it; k++) {
                for (j = 0; j < n; j++) {
                    var acc = (j + it) * 0.5;
                    VX[j] = (VX[j] + (tx - X[j]) * sx * acc) * g;
                    VY[j] = (VY[j] + (ty - Y[j]) * sy * acc) * g;
                    X[j] += VX[j] * 0.000030; Y[j] += VY[j] * 0.000030;
                    var ix = _floor(X[j]), iy = _floor(Y[j]);
                    if (!(ix >= 0 && iy >= 0 && ix < W - 1 && iy < H - 1)) continue;
                    var fx = X[j] - ix, fy = Y[j] - iy, o = iy * W + ix;
                    A[o] += _round((1 - fx) * (1 - fy) * wt); A[o + 1] += _round(fx * (1 - fy) * wt);
                    A[o + W] += _round((1 - fx) * fy * wt); A[o + W + 1] += _round(fx * fy * wt);
                    if (ix < x1) x1 = ix; if (iy < y1) y1 = iy;
                    if (ix + 1 > x2) x2 = ix + 1; if (iy + 1 > y2) y2 = iy + 1;
                }
            }
            if (x2 >= x1) _blitAlpha(A, W, x1, y1, x2, y2, 1);
        }
    }
    /* An alpha array's box, in the stroke colour, over the flow buffer at
     * `o`: how a Krita paintop that builds its own dab (particle, hairy)
     * hands it to the painter. Clears the box for the next pass. The
     * opacity goes into the bytes as Krita's u8 painter multiplies: the
     * opacity a byte (0.5 is 128), then (a * o + 128) folded by 257 -- a
     * canvas globalAlpha of 0.5 made 254 into 127.5, not 127, and 249 * 0.5
     * rounds half to even into 124 where Krita has 125 (鬃毛-4p). */
    var _ptCv = null;
    function _blitAlpha(A, W, x1, y1, x2, y2, o) {
        var c = _flowCtx, bw = x2 - x1 + 1, bh = y2 - y1 + 1, im = new ImageData(bw, bh), d = im.data, ob = _round(o * 255);
        for (var yy = 0; yy < bh; yy++) {
            for (var xx = 0, q = (y1 + yy) * W + x1; xx < bw; xx++, q++) {
                var t = A[q] * ob + 128;
                d[(yy * bw + xx) * 4 + 3] = ((t >> 8) + t) >> 8; A[q] = 0;
            }
        }
        if (!_ptCv || _ptCv.width < bw || _ptCv.height < bh) _ptCv = new OffscreenCanvas(_max(bw, _ptCv ? _ptCv.width : 0), _max(bh, _ptCv ? _ptCv.height : 0));
        var pctx = _ptCv.getContext('2d');
        pctx.clearRect(0, 0, bw, bh);
        pctx.putImageData(im, 0, 0);
        pctx.globalCompositeOperation = 'source-in';
        pctx.fillStyle = _state.lastColor; pctx.fillRect(0, 0, bw, bh);
        pctx.globalCompositeOperation = 'source-over';
        c.drawImage(_ptCv, 0, 0, bw, bh, x1, y1, bw, bh);
        var r = { x1: x1, y1: y1, x2: x2 + 1, y2: y2 + 1 };
        _dirtyRect = _unionRect(_dirtyRect, r);
        _clearBounds = _unionRect(_clearBounds, r);
        _flowUsed = _unionRect(_flowUsed, r);
    }

    /* Krita's seeded random numbers (boost's taus88, KisRandomSource(seed)),
     * as 0..1: the hairy brush thins its bristles with one seeded at 0, so
     * the same bristles go every stroke. */
    function _taus88(seed) {
        var z1 = seed >>> 0, z2 = z1, z3 = z1;
        if (z1 < 2) z1 += 2; if (z2 < 8) z2 += 8; if (z3 < 16) z3 += 16;
        return function () {
            z1 = (((z1 & 0xFFFFFFFE) << 12) ^ ((((z1 << 13) ^ z1) >>> 0) >>> 19)) >>> 0;
            z2 = (((z2 & 0xFFFFFFF8) << 4) ^ ((((z2 << 2) ^ z2) >>> 0) >>> 25)) >>> 0;
            z3 = (((z3 & 0xFFFFFFF0) << 17) ^ ((((z3 << 3) ^ z3) >>> 0) >>> 11)) >>> 0;
            return ((z1 ^ z2 ^ z3) >>> 0) / 4294967295;
        };
    }

    /* Krita's hairy brush (KisHairyPaintOp): the tip, at its own size, is
     * made once into bristles -- one per inked pixel, as long as its alpha,
     * `density` of them kept. Each input segment then draws every bristle
     * as a line from where it sat to where it now sits, the tip scaled by
     * the size option times `scale`, sheared by twice the pressure times
     * `shear`; with `threshold` a bristle shorter than 1 - pressure lifts
     * off. A line is 1px steps along its long axis, each a bilinear 2x2
     * (anti-aliased) laid over the pass's dab, which the opacity option then
     * paints down.
     *
     * ponytail: bristle colour is the stroke's -- soak ink and saturation
     * depletion (colours from the layer) are not modelled; the rotation
     * option neither. */
    var _hrSt = null, _hrA = null;
    function _hairyTip(p) {
        var hs = p.size, asp = p.aspectRatio || 1, W, H, a;
        if (_isArray(p.tipCurve) && (p.shape || 'circle') === 'circle') {
            /* KisCurveCircleMaskGenerator's vector path: the curve at the
             * squared radius, sampled at pixel centres round the tip's
             * middle, rounded. Its table is 4 entries a pixel plus 2 but is
             * read at 4 a pixel, so the curve runs 1/73rd (at 18px) short. */
            var w = hs, h = hs / asp, res = _round(_max(w, h) * 4), lut = new Float64Array(res + 2);
            for (var li = 0; li < res + 2; li++) lut[li] = _curveAt(p.tipCurve, li / (res + 1), true);
            W = _max(1, _ceil(w)); H = _max(1, _ceil(h)); a = new Uint8Array(W * H);
            for (var y = 0; y < H; y++) {
                for (var x = 0; x < W; x++) {
                    var X = (x + 0.5 - w / 2) * 2 / w, Y = (y + 0.5 - h / 2) * 2 / h, d2 = X * X + Y * Y;
                    if (d2 > 1) continue;
                    var v = d2 * res, i0 = _floor(v), f = v - i0;
                    a[y * W + x] = _round(_clamp((1 - f) * lut[i0] + f * lut[i0 + 1], 0, 1) * 255);
                }
            }
            return { W: W, H: H, a: a, cx: _floor(W * 0.5), cy: _floor(H * 0.5) };
        }
        /* Krita's dab at no sub-pixel offset: its size cut to whole pixels across, the middle
         * half a pixel before W / 2, and nothing past that box -- our mask's
         * extra faint ring came first in scan order and took the few
         * bristles a 1% density keeps (鬃毛-4p: probes/hairtip). */
        _sharpNow = p.sharpness;
        var KW = _max(1, Math.trunc(hs)), KH = _max(1, Math.trunc(hs / asp)), clip = !(p.angle % 180);
        var m = _maskFor(p.shape || 'circle', hs, p.hardness, p.angle || 0, asp, KW / 2, KH / 2);
        W = m.width; H = m.height;
        var dd = m.getContext('2d').getImageData(0, 0, W, H).data, cx = _floor(m._cx != null ? m._cx : W / 2), cy = _floor(m._cy != null ? m._cy : H / 2);
        a = new Uint8Array(W * H);
        for (var i = 0; i < W * H; i++) {
            var ox = i % W - cx + (KW >> 1), oy = _floor(i / W) - cy + (KH >> 1);
            if (!clip || (ox >= 0 && oy >= 0 && ox < KW && oy < KH)) a[i] = dd[i * 4 + 3];
        }
        return { W: W, H: H, a: a, cx: cx, cy: cy };
    }
    function _paintHairy(pts, from, to) {
        var p = getParams(), hr = p.hairy;
        if (!_flowCtx || !hr) return;
        var W = _flowCanvas.width, H = _flowCanvas.height;
        if (from === 0 || !_hrSt) {
            var t = _hairyTip(p), rnd = _taus88(0), bx = [], by = [], bl = [];
            /* The tip as Krita's mask hands it over, its randomness and
             * density already in (see _noisyMask): Bristle Tapered's tip at
             * density 0.3 keeps a third of its pixels, so a third the hairs. */
            if (p.tipDensity < 1 || p.tipRandomness) {
                var tr = p.tipRandomness, s = (_dabRand(pts[0].x, pts[0].y, 7) * 4294967296) >>> 0 || 1;
                for (var ti = 0; ti < t.a.length; ti++) {
                    if (!t.a[ti]) continue;
                    if (tr) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; t.a[ti] = ~~(t.a[ti] * (1 - tr + tr * (s >>> 0) / 4294967296)); }
                    if (p.tipDensity < 1 && t.a[ti]) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; if (p.tipDensity < (s >>> 0) / 4294967296) t.a[ti] = 0; }
                }
            }
            for (var y = 0; y < t.H; y++) {
                for (var x = 0; x < t.W; x++) {
                    var al = t.a[y * t.W + x];
                    if (!al || !(hr.density >= 1 || rnd() <= hr.density)) continue;
                    bx.push(x - t.cx); by.push(y - t.cy); bl.push(al / 255);
                }
            }
            var n = bx.length, dep = new Float64Array(hr.inkAmount);   // KisCubicCurve::floatTransfer
            for (var di = 0; di < dep.length; di++) dep[di] = _curveAt(hr.inkCurve, di / (dep.length - 1), true);
            _hrSt = { dep: dep, x: bx, y: by, len: bl, px: new Float64Array(n), py: new Float64Array(n),
                      ink: new Float64Array(n), cnt: new Int32Array(n), first: true, mp: 1 };
        }
        if (!_hrA || _hrA.length !== W * H) _hrA = new Uint8ClampedArray(W * H);
        var S = _hrSt, A = _hrA, nb = S.x.length, dep = S.dep;
        for (var i = _max(1, from + 1); i <= to; i++) {
            var a0 = pts[i - 1], b0 = pts[i], pr = b0.pressure == null ? 1 : b0.pressure;
            _dabIndex = i - 1;
            var sc = { pressure: pr, x: b0.x, y: b0.y };
            var scale = _dyn(p, 'size', 1, sc, 0) * hr.scale, mp = 1;
            /* "Pressure from mouse": a speed reading, each segment a fifth of
             * the way to 1 - its length / 20 (0.02 the floor), the bristles
             * scaled by what is left; it weighs shear and ink too. */
            if (hr.mouse) {
                S.mp = (4 * S.mp + 0.02 + _max(0, 1 - Math.hypot(b0.x - a0.x, b0.y - a0.y) / 20)) / 5;
                mp = 1 - S.mp; scale *= mp;
            }
            var press = mp * pr * 2, shear = press * hr.shear;
            var x1 = W, y1 = H, x2 = -1, y2 = -1;
            for (var j = 0; j < nb; j++) {
                var rx = hr.random ? (_dabRand(i, j, 31) * 2 - 1) * hr.random : 0;
                var ry = hr.random ? (_dabRand(i, j, 37) * 2 - 1) * hr.random : 0;
                // QTransform: shear, then the random nudge, then scale
                var ex = (S.x[j] + shear * S.y[j] + rx) * scale, ey = (S.y[j] + shear * S.x[j] + ry) * scale;
                var fx1 = S.first || !hr.connected ? ex : S.px[j], fy1 = S.first || !hr.connected ? ey : S.py[j];
                S.px[j] = ex; S.py[j] = ey;
                if (hr.threshold && S.len[j] < 1 - pr) continue;
                fx1 += a0.x; fy1 += a0.y;
                var fx2 = ex + b0.x, fy2 = ey + b0.y;
                // Krita's getLinearTrajectory: the start, 1px steps on the long axis, the end
                var xd = fx2 - fx1, yd = fy2 - fy1, m = yd / xd, steps, sx, sy;
                if (_abs(m) > 1) { steps = _abs(Math.trunc(fy2) - Math.trunc(fy1)); sy = yd > 0 ? 1 : -1; sx = sy / m; }
                else { steps = _abs(Math.trunc(fx2) - Math.trunc(fx1)); sx = xd > 0 ? 1 : -1; sy = sx * m; }
                var np = steps + 2 - (hr.aa ? 1 : 0);
                for (var k = 0; k < np; k++) {
                    var qx = k === steps + 1 ? fx2 : fx1 + sx * k, qy = k === steps + 1 ? fy2 : fy1 + sy * k;
                    var d = 0, op;
                    if (hr.inkOn) {
                        d = dep[_min(S.cnt[j], dep.length - 1)];
                        op = !hr.useOpacity ? S.len[j] : _clamp(hr.useWeights
                            ? press * hr.pw + S.len[j] * hr.blw + S.ink[j] * hr.biw + (1 - d) * hr.idw
                            : S.len[j] * S.ink[j], 0, 1);
                    } else op = S.len[j];
                    var o8 = _round(op * 255);
                    if (hr.aa) {
                        var ix = Math.trunc(qx), iy = Math.trunc(qy), gx = _abs(qx - ix), gy = _abs(qy - iy);
                        if (ix >= 0 && iy >= 0 && ix < W - 1 && iy < H - 1) {
                            var q = iy * W + ix;
                            _hairyInk(A, q, _round((1 - gx) * (1 - gy) * o8), hr.comp);
                            _hairyInk(A, q + 1, _round(gx * (1 - gy) * o8), hr.comp);
                            _hairyInk(A, q + W, _round((1 - gx) * gy * o8), hr.comp);
                            _hairyInk(A, q + W + 1, _round(gx * gy * o8), hr.comp);
                            if (ix < x1) x1 = ix; if (iy < y1) y1 = iy;
                            if (ix + 1 > x2) x2 = ix + 1; if (iy + 1 > y2) y2 = iy + 1;
                        }
                    } else {
                        var jx = _round(qx), jy = _round(qy);
                        if (jx >= 0 && jy >= 0 && jx < W && jy < H) {
                            var q2 = jy * W + jx;
                            if (hr.comp) _hairyInk(A, q2, o8, true); else if (A[q2] < o8) A[q2] = o8;
                            if (jx < x1) x1 = jx; if (jy < y1) y1 = jy;
                            if (jx > x2) x2 = jx; if (jy > y2) y2 = jy;
                        }
                    }
                    S.ink[j] = 1 - d;
                    S.cnt[j]++;
                }
            }
            S.first = false;
            if (x2 >= x1) _blitAlpha(A, W, x1, y1, x2, y2, _clamp(_dyn(p, 'flow', p.flow / 100, sc, 0), 0, 1));
        }
    }
    /* Over (useCompositing), rounded as Krita's u8 over rounds -- the gap
     * to full times the new ink, so 254 under 128 more reaches 255 -- or
     * added up to full. */
    function _hairyInk(A, q, v, over) {
        if (!v) return;
        A[q] = over ? A[q] + (255 - A[q]) * v / 255 : A[q] + v;
    }
    /* One sketch line. A hairline is hard pixel steps, as Krita's is --
     * smoothed, each pixel split over two and the probe's zigzag lost a
     * third of its match. `skipFirst` leaves the start pixel to the line
     * that already ended there, or every joint would take two coats. */
    function _sketchLine(c, a, b, w, o, skipFirst) {
        if (o <= 0) return;
        c.globalAlpha = o;
        if (w === 1) {
            // ends cut to whole pixels (a gap filled from 2.4 to 9.6 in Krita
            // stops on 9), the steps between them rounded
            a = { x: _floor(a.x), y: _floor(a.y) }; b = { x: _floor(b.x), y: _floor(b.y) };
            var n = _max(1, _max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))), lx = NaN, ly = NaN;
            if (skipFirst) { lx = _round(a.x); ly = _round(a.y); }
            for (var k = 0; k <= n; k++) {
                var x = _round(a.x + (b.x - a.x) * k / n), y = _round(a.y + (b.y - a.y) * k / n);
                if (x === lx && y === ly) continue;
                c.fillRect(x, y, 1, 1);
                lx = x; ly = y;
            }
            return;
        }
        /* Any other width is KisPainter::drawLine: whole-pixel ends, every
         * pixel within half the width (plus the start's sub-pixel along the
         * long axis) of the segment, round-ended, hard unless the preset
         * anti-aliases. A canvas stroke of 8 was a pixel thinner and soft,
         * inkTrash600 0.91x Krita's ink. */
        var X1 = _floor(a.x), Y1 = _floor(a.y), X2 = _floor(b.x), Y2 = _floor(b.y);
        if (X1 === X2 && Y1 === Y2) return;
        var dX = X2 - X1, dY = Y2 - Y1, uniC = dX * Y1 - dY * X1, pd = 1 / (dX * dX + dY * dY), den = 1 / Math.sqrt(dX * dX + dY * dY);
        var hw = w * 0.5 + (Math.abs(dX) > Math.abs(dY) ? a.x - X1 : a.y - Y1), W_ = _round(hw) + 1;
        var x1 = _min(X1, X2), x2 = _max(X1, X2), y1 = _min(Y1, Y2), y2 = _max(Y1, Y2), aa = _params.sketchAA;
        for (var yy = y1 - W_; yy < y2 + W_; yy++) {
            for (var xx = x1 - W_; xx < x2 + W_; xx++) {
                var pr = ((xx - X1) * dX + (yy - Y1) * dY) * pd, sx = X1 + pr * dX, sy = Y1 + pr * dY, d;
                if (sx < x1 || sx > x2 || sy < y1 || sy > y2)
                    d = _min(_hypot(xx - X1, yy - Y1), _hypot(xx - X2, yy - Y2));
                else d = Math.abs(dY * xx - dX * yy + uniC) * den;
                if (d > hw) continue;
                c.globalAlpha = aa && d > hw - 1 ? o * _floor((1 - (d - (hw - 1))) * 256) / 255 : o;
                c.fillRect(xx, yy, 1, 1);
            }
        }
    }
    /* Krita's curve brush (KisCurvePaintOp::paintLine). Each new input
     * point is a segment: a line from the point before, lineWidth wide
     * (Qt's pen: square ends, and width 0 a one-pixel hairline), and, once
     * `curveHistory` points are remembered -- the stroke's first point is
     * never one of them -- a curve from the oldest through the middle one
     * (a cubic through the thirds without smoothing) to the newest, at the
     * curves' own opacity. Krita's scripted line is one segment, so its
     * renders are the bare connection line.
     * ponytail: both drawn straight onto the buffer; Krita composes them
     * in a scratch dab first, so where they cross they stack here. */
    function _paintCurveOp(pts, from, to) {
        var p = getParams(), c = _flowCtx;
        if (!c) return;
        c.save();
        c.fillStyle = c.strokeStyle = _state.lastColor;
        c.lineCap = 'square';
        var N = p.curveHistory || 30;
        for (var i = _max(1, from + 1); i <= to; i++) {
            var b = pts[i], sc = { pressure: b.pressure, x: b.x, y: b.y };
            /* Krita's line width and curve opacity inputs are held to 0.1..1
             * of the option (KisLineWidthOptionData's strength range): an
             * input reading 0 still draws Ink Pen's 11px at 1.1px, where ours
             * fell to a 1px hairline and 0.9 of Krita's ink. Width 0 is Qt's
             * cosmetic hairline, and so is anything to 1px (Qt's fast_pen). */
            var w = p.sketchWidth * _clamp(_dyn(p, 'sketchWidth', 1, sc, 0), 0.1, 1);
            var o = _clamp(_dyn(p, 'flow', p.flow / 100, sc, 0), 0, 1);
            c.lineWidth = w > 1 ? w : 1;
            // Qt's anti-aliased pen on the points themselves: a hairline on a
            // whole-pixel line lands half in each row, as Krita's does.
            if (p.curveConnect !== false && o > 0) {
                c.globalAlpha = o;
                if (w > 1) _penLine(c, pts[i - 1].x, pts[i - 1].y, b.x, b.y, w);
                else { c.beginPath(); c.moveTo(pts[i - 1].x, pts[i - 1].y); c.lineTo(b.x, b.y); c.stroke(); }
            }
            var M = w + 2, r = { x1: _min(pts[i - 1].x, b.x) - M, y1: _min(pts[i - 1].y, b.y) - M,
                x2: _max(pts[i - 1].x, b.x) + M + 1, y2: _max(pts[i - 1].y, b.y) + M + 1 };
            if (i >= N) {
                var h0 = i - N + 1, co = o * _clamp(p.curvesOpacity * _clamp(_dyn(p, 'curvesOpacity', 1, sc, 0), 0.1, 1), 0, 1);
                if (co > 0) {
                    c.globalAlpha = co;
                    c.beginPath();
                    c.moveTo(pts[h0].x, pts[h0].y);
                    if (p.curveQuad !== false) {
                        var q = pts[h0 + (N >> 1)];
                        c.quadraticCurveTo(q.x, q.y, b.x, b.y);
                    } else {
                        var t = (N / 3) | 0, q1 = pts[h0 + t], q2 = pts[h0 + t + t];
                        c.bezierCurveTo(q1.x, q1.y, q2.x, q2.y, b.x, b.y);
                    }
                    c.stroke();
                }
                for (var k = h0; k < i; k++) r = _unionRect(r, { x1: pts[k].x - M, y1: pts[k].y - M, x2: pts[k].x + M + 1, y2: pts[k].y + M + 1 });
            }
            _dirtyRect = _unionRect(_dirtyRect, r);
            _clearBounds = _unionRect(_clearBounds, r);
            _flowUsed = _unionRect(_flowUsed, r);
        }
        c.restore();
    }
    /* Qt's pen, square caps, at the area it covers of each pixel. Chrome
     * strokes to a quarter pixel across the line: 1.1px drew as 1, and Ink
     * Pen's diagonal carried 0.84 of Krita's ink. Exact on straight lines.
     * Qt truncates coverage: a half-covered edge is 127, not 128. */
    var _penCv = null, _penImg = null;
    function _penLine(c, x0, y0, x1, y1, w) {
        var dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
        if (len < 1e-6) return;
        var ux = dx / len, uy = dy / len, h = w / 2;
        var bx = _floor(_min(x0, x1) - h - 1), by = _floor(_min(y0, y1) - h - 1);
        var bw = _ceil(_max(x0, x1) + h + 1) - bx, bh = _ceil(_max(y0, y1) + h + 1) - by;
        if (!_penImg || _penImg.width < bw || _penImg.height < bh) {
            _penCv = new OffscreenCanvas(_max(bw, _penImg ? _penImg.width : 0), _max(bh, _penImg ? _penImg.height : 0));
            _penImg = new ImageData(_penCv.width, _penCv.height);
        }
        var d = _penImg.data, W = _penImg.width, rgb = _hexToRgb(_state.lastColor || '#000000');
        for (var j = 0; j < bh; j++) for (var k = 0; k < bw; k++) {
            var rx = bx + k + 0.5 - x0, ry = by + j + 0.5 - y0, al = rx * ux + ry * uy, ac = ry * ux - rx * uy;
            var a = _max(0, _min(ac + 0.5, h) - _max(ac - 0.5, -h)) * _max(0, _min(al + 0.5, len + h) - _max(al - 0.5, -h));
            var q = (j * W + k) * 4;
            d[q] = rgb[0]; d[q + 1] = rgb[1]; d[q + 2] = rgb[2]; d[q + 3] = _floor(_min(1, a) * 255 + 1e-6);
        }
        _penCv.getContext('2d').putImageData(_penImg, 0, 0, 0, 0, bw, bh);
        c.drawImage(_penCv, 0, 0, bw, bh, bx, by, bw, bh);
    }
    function _unionRect(a, b) {
        return !a ? { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 }
            : { x1: _min(a.x1, b.x1), y1: _min(a.y1, b.y1), x2: _max(a.x2, b.x2), y2: _max(a.y2, b.y2) };
    }

    /* Krita's deform brush, which paints nothing at all: it takes the
     * pixels already on the layer and pushes them about. Grow, shrink, the
     * two swirls, move, and the two lenses are all the same loop with a
     * different displacement -- for each pixel in the dab, work out where it
     * should have come FROM and sample there.
     *
     * It writes to the layer directly rather than through the flow buffer.
     * The buffer exists to hold wet paint until a stroke is composited, and
     * there is no paint here: the second dab of a deform has to see what the
     * first one did, which is exactly what the buffer is designed to prevent.
     * Nothing sets _dirtyRect, so the flush stays out of the way. */
    function _deformAt(cx, cy, mvx, mvy, sz, amount, action) {
        var ctx = _outCtx();
        if (!ctx) return;
        var r = _max(2, sz / 2);
        var x0 = _max(0, _floor(cx - r)), y0 = _max(0, _floor(cy - r));
        var x1 = _min(_docW(), _ceil(cx + r) + 1), y1 = _min(_docH(), _ceil(cy + r) + 1);
        var w = x1 - x0, h = y1 - y0;
        if (w <= 0 || h <= 0) return;
        var src, out;
        try {
            src = ctx.getImageData(x0, y0, w, h);
            out = ctx.createImageData(w, h);
        } catch (e) { return; }
        var sd = src.data, od = out.data;
        var stencil = null;
        if (_selStencil) {
            try {
                stencil = _selStencil.getContext('2d').getImageData(x0, y0, w, h).data;
            } catch (e2) { stencil = null; }
        }
        var locked = _alphaLocked();
        var amt = _clamp(amount, 0, 1);
        for (var py = 0; py < h; py++) {
            for (var px = 0; px < w; px++) {
                var i = (py * w + px) * 4;
                od[i] = sd[i]; od[i + 1] = sd[i + 1]; od[i + 2] = sd[i + 2]; od[i + 3] = sd[i + 3];
                var ddx = (x0 + px + 0.5) - cx, ddy = (y0 + py + 0.5) - cy;
                var d = _hypot(ddx, ddy);
                if (d > r) continue;
                if (stencil && !stencil[i + 3]) continue;
                // Strongest under the middle of the dab, nothing at its edge.
                var fall = 1 - d / r;
                fall = fall * fall * amt;
                var sx = x0 + px + 0.5, sy = y0 + py + 0.5;
                if (action === 'move') {
                    sx -= mvx * fall; sy -= mvy * fall;
                } else if (action === 'grow' || action === 'lens-in') {
                    sx = cx + ddx * (1 - fall); sy = cy + ddy * (1 - fall);
                } else if (action === 'shrink' || action === 'lens-out') {
                    sx = cx + ddx * (1 + fall); sy = cy + ddy * (1 + fall);
                } else {                       // the two swirls
                    var a = fall * _PI * (action === 'swirl-ccw' ? -1 : 1);
                    var ca = _cos(a), sa = _sin(a);
                    sx = cx + ddx * ca - ddy * sa;
                    sy = cy + ddx * sa + ddy * ca;
                }
                _sampleBilinear(sd, w, h, sx - x0 - 0.5, sy - y0 - 0.5, od, i);
                if (locked) od[i + 3] = sd[i + 3];
            }
        }
        ctx.putImageData(out, x0, y0);
    }

    /* Four pixels blended, because a deform moves pixels by fractions of one
     * and taking the nearest turns a smooth smear into stair steps. */
    function _sampleBilinear(sd, w, h, fx, fy, od, at) {
        var ix = _floor(fx), iy = _floor(fy);
        var tx = fx - ix, ty = fy - iy;
        var c;
        for (c = 0; c < 4; c++) {
            var v = 0, wsum = 0;
            for (var oy = 0; oy < 2; oy++) {
                for (var ox = 0; ox < 2; ox++) {
                    var sx = ix + ox, sy = iy + oy;
                    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
                    var wt = (ox ? tx : 1 - tx) * (oy ? ty : 1 - ty);
                    v += sd[(sy * w + sx) * 4 + c] * wt;
                    wsum += wt;
                }
            }
            od[at + c] = wsum > 0 ? _round(v / wsum) : od[at + c];
        }
    }

    /* Walk the points this frame added and deform along them.
     *
     * Move is the one action that follows the hand: the distance travelled IS
     * the push, so a point that barely moved does almost nothing. Every other
     * action keeps working while the pen is held still -- a swirl under a
     * parked cursor keeps swirling, which is what the brush is for -- so
     * those apply once a FRAME instead, wherever the pen has got to. Once per
     * point would be as many as the tablet cares to send, and a grow at sixty
     * points a frame swallows its own circle in half a second. */
    function _deformStroke(pts, from, to) {
        var p = getParams();
        var sz = p.size;
        var step = _max(1, sz * (p.spacing / 100));
        var amount = _clamp((p.deformAmount == null ? 30 : p.deformAmount) / 100, 0, 1);
        var action = p.deformAction || 'move';
        for (var i = _max(1, from); i <= to; i++) {
            var a = pts[i - 1], b = pts[i];
            var mvx = b.x - a.x, mvy = b.y - a.y;
            var dist = _hypot(mvx, mvy);
            if (action !== 'move') {
                if (i === to) _deformAt(b.x, b.y, 0, 0, sz, amount, action);
                continue;
            }
            if (dist < 0.5) continue;
            var n = _max(1, _ceil(dist / step));
            for (var k = 1; k <= n; k++) {
                var t = k / n;
                _deformAt(_lerp(a.x, b.x, t), _lerp(a.y, b.y, t),
                          mvx / n, mvy / n, sz, amount, action);
            }
        }
    }

    /* ── MyPaint ─────────────────────────────────────────────────────────
     * libmypaint 1.6.1 (ISC licence, (C) 2007-2011 Martin Renold and
     * contributors), the version Krita ships, ported whole: a .myb is not a
     * tip and a few dials but a small simulation -- forty-odd settings, each
     * the sum of a base and curves over eighteen inputs, re-evaluated at every
     * dab -- so the only faithful way to paint one is to run it. This is the
     * legacy surface path (mypaint_brush_stroke_to), the one Krita drives:
     * no spectral paint mixing, no posterize. The surface is libmypaint's
     * too: 64px tiles of 15-bit premultiplied RGBA, loaded from the layer as
     * a stroke first touches them and written back as they change. The
     * selection and the layer's alpha lock are the app's, not MyPaint's:
     * they are put back into the tiles as each is written out (_mpClip). */
    var MP_SET = 'opaque opaque_multiply opaque_linearize radius_logarithmic hardness anti_aliasing dabs_per_basic_radius dabs_per_actual_radius dabs_per_second radius_by_random speed1_slowness speed2_slowness speed1_gamma speed2_gamma offset_by_random offset_by_speed offset_by_speed_slowness slow_tracking slow_tracking_per_dab tracking_noise color_h color_s color_v restore_color change_color_h change_color_l change_color_hsl_s change_color_v change_color_hsv_s smudge smudge_length smudge_radius_log eraser stroke_threshold stroke_duration_logarithmic stroke_holdtime custom_input custom_input_slowness elliptical_dab_ratio elliptical_dab_angle direction_filter lock_alpha colorize snap_to_pixel pressure_gain_log gridmap_scale gridmap_scale_x gridmap_scale_y smudge_length_log smudge_bucket smudge_transparency offset_y offset_x offset_angle offset_angle_asc offset_angle_view offset_angle_2 offset_angle_2_asc offset_angle_2_view offset_angle_adj offset_multiplier posterize posterize_num paint_mode'.split(' ');
    var MP_DEF = [1,0,0.9,2,0.8,1,0,2,0,0,0.04,0.8,4,4,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0.5,0,0,0,4,0,0,0,1,90,2,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.05,1];
    var MP_IN = 'pressure speed1 speed2 random stroke direction tilt_declination tilt_ascension custom direction_angle attack_angle tilt_declinationx tilt_declinationy gridmap_x gridmap_y viewzoom barrel_rotation brush_radius'.split(' ');
    var MPS = {}, MPI = {};
    MP_SET.forEach(function (n, i) { MPS[n] = i; });
    MP_IN.forEach(function (n, i) { MPI[n] = i; });
    var MP_T = 64, MP_ONE = 32768, MP_RMIN = 0.2, MP_RMAX = 1000, MP_GRID = 256;

    /* Knuth's ran_array at MyPaint's reduced quality (KK 10, LL 7), seeded
     * as every new brush is (1000): the same seed and the same dabs draw the
     * same random numbers as libmypaint. */
    function _mpRng(seed) {
        var KK = 10, LL = 7, TT = 7, Q = 19, ranU = new Float64Array(KK), buf = new Float64Array(Q), ptr = -1;
        var ms = function (x, y) { var s = x + y; return s - (s | 0); };
        function arr(aa, n) {
            var i, j;
            for (j = 0; j < KK; j++) aa[j] = ranU[j];
            for (; j < n; j++) aa[j] = ms(aa[j - KK], aa[j - LL]);
            for (i = 0; i < LL; i++, j++) ranU[i] = ms(aa[j - KK], aa[j - LL]);
            for (; i < KK; i++, j++) ranU[i] = ms(aa[j - KK], ranU[i - LL]);
        }
        var u = new Float64Array(KK + KK - 1), ulp = Math.pow(2, -52), ss = 2 * ulp * ((seed & 0x3fffffff) + 2), j, t, s;
        for (j = 0; j < KK; j++) { u[j] = ss; ss += ss; if (ss >= 1) ss -= 1 - 2 * ulp; }
        u[1] += ulp;
        for (s = seed & 0x3fffffff, t = TT - 1; t;) {
            for (j = KK - 1; j > 0; j--) { u[j + j] = u[j]; u[j + j - 1] = 0; }
            for (j = KK + KK - 2; j >= KK; j--) {
                u[j - (KK - LL)] = ms(u[j - (KK - LL)], u[j]);
                u[j - KK] = ms(u[j - KK], u[j]);
            }
            if (s & 1) {
                for (j = KK; j > 0; j--) u[j] = u[j - 1];
                u[0] = u[KK];
                u[LL] = ms(u[LL], u[KK]);
            }
            if (s) s >>= 1; else t--;
        }
        for (j = 0; j < LL; j++) ranU[j + KK - LL] = u[j];
        for (; j < KK; j++) ranU[j - LL] = u[j];
        for (j = 0; j < 10; j++) arr(u, KK + KK - 1);
        return function () {
            if (ptr >= 0 && buf[ptr] >= 0) return buf[ptr++];
            arr(buf, Q); buf[KK] = -1; ptr = 1;
            return buf[0];
        };
    }
    /* libmypaint keeps its state in floats: a position creeping up on 50 from
     * below lands on it there and stays a hair short here, a row up for a
     * snapped 1px brush (experimental/1pixel). */
    var _f32 = Math.fround;
    function _mpGauss(r) { return _f32((r() + r() + r() + r()) * 1.73205080757 - 3.46410161514); }
    function _mpMod(a, n) { return a - n * _floor(a / n); }
    function _mpAngDiff(a, b) {
        var d = _mpMod(b - a + 180, 360) - 180;
        return d + (d > 180 ? -360 : d < -180 ? 360 : 0);
    }
    function _mpDecay(T, t) { return T <= 0.001 ? 0 : Math.exp(-t / T); }
    function _mpFmod(a, n) { return a % n; }   // C fmodf: keeps the dividend's sign
    function _mpRgbHsv(c) {
        var r = _clamp(c[0], 0, 1), g = _clamp(c[1], 0, 1), b = _clamp(c[2], 0, 1), h = 0, s = 0;
        var mx = _max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        if (d > 0.0001) {
            s = d / mx;
            if (r === mx) { h = (g - b) / d; if (h < 0) h += 6; }
            else if (g === mx) h = 2 + (b - r) / d;
            else h = 4 + (r - g) / d;
            h /= 6;
        }
        c[0] = h; c[1] = s; c[2] = mx;
    }
    function _mpHsvRgb(c) {
        var h = c[0] - _floor(c[0]), s = _clamp(c[1], 0, 1), v = _clamp(c[2], 0, 1);
        if (s === 0) { c[0] = c[1] = c[2] = v; return; }
        var hue = h === 1 ? 0 : h * 6, i = hue | 0, f = hue - i,
            w = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
        var o = [[v, t, w], [q, v, w], [w, v, t], [w, q, v], [t, w, v], [v, w, q]][i] || [0, 0, 0];
        c[0] = o[0]; c[1] = o[1]; c[2] = o[2];
    }
    function _mpRgbHsl(c) {
        var r = _clamp(c[0], 0, 1), g = _clamp(c[1], 0, 1), b = _clamp(c[2], 0, 1), h = 0, s = 0;
        var mx = _max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
        if (mx !== mn) {
            s = l <= 0.5 ? (mx - mn) / (mx + mn) : (mx - mn) / (2 - mx - mn);
            var d = mx - mn || 1;
            h = r === mx ? (g - b) / d : g === mx ? 2 + (b - r) / d : 4 + (r - g) / d;
            h /= 6; if (h < 0) h += 1;
        }
        c[0] = h; c[1] = s; c[2] = l;
    }
    function _mpHslV(n1, n2, hue) {
        if (hue > 6) hue -= 6; else if (hue < 0) hue += 6;
        return hue < 1 ? n1 + (n2 - n1) * hue : hue < 3 ? n2 : hue < 4 ? n1 + (n2 - n1) * (4 - hue) : n1;
    }
    function _mpHslRgb(c) {
        var h = c[0] - _floor(c[0]), s = _clamp(c[1], 0, 1), l = _clamp(c[2], 0, 1);
        if (s === 0) { c[0] = c[1] = c[2] = l; return; }
        var m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s, m1 = 2 * l - m2;
        c[0] = _mpHslV(m1, m2, h * 6 + 2); c[1] = _mpHslV(m1, m2, h * 6); c[2] = _mpHslV(m1, m2, h * 6 - 2);
    }

    /* A brush from a .myb's settings ({ name: { base, inputs: { input:
     * [[x, y], ...] } } }), over libmypaint's defaults as Krita loads it
     * (mypaint_brush_from_defaults, then the file): a setting the file leaves
     * out keeps its default, and so does an input curve it does not list. */
    function _mpNewBrush(set) {
        var n = MP_SET.length, b = {
            base: new Float32Array(MP_DEF), maps: new Array(n), val: new Float32Array(n),   // floats, as in libmypaint
            inputs: new Float32Array(MP_IN.length), rng: _mpRng(1000), random: 0, reset: true,
            skip: 0, skipX: 0, skipY: 0, skipDt: 0, gam: [0, 0], m: [0, 0], q: [0, 0], st: null, bucket: new Float64Array(9)
        };
        b.maps[MPS.opaque_multiply] = [{ i: MPI.pressure, xs: [0, 1], ys: [0, 1] }];
        for (var k in set) {
            if (!set.hasOwnProperty(k) || MPS[k] == null) continue;
            var si = MPS[k], rec = set[k] || {};
            if (isFinite(rec.base)) b.base[si] = +rec.base;
            var ins = rec.inputs || {};
            for (var nm in ins) {
                if (!ins.hasOwnProperty(nm) || MPI[nm] == null) continue;
                var pts = ins[nm] || [], list = (b.maps[si] || []).filter(function (e) { return e.i !== MPI[nm]; });
                if (pts.length >= 2) list.push({ i: MPI[nm], xs: Float32Array.from(pts, function (p) { return +p[0]; }), ys: Float32Array.from(pts, function (p) { return +p[1]; }) });
                list.sort(function (a, c) { return a.i - c.i; });
                b.maps[si] = list.length ? list : null;
            }
        }
        _mpSpeedMap(b);
        _mpReset(b);
        return b;
    }
    function _mpSpeedMap(b) {
        for (var i = 0; i < 2; i++) {
            var g = Math.exp(b.base[i ? MPS.speed2_gamma : MPS.speed1_gamma]), m = 0.015 * (45 + g);
            b.gam[i] = g; b.m[i] = m; b.q[i] = 0.5 - m * Math.log(45 + g);
        }
    }
    function _mpReset(b) {
        b.skip = b.skipX = b.skipY = b.skipDt = 0;
        b.st = { x: 0, y: 0, pressure: 0, partial: 0, radius: 0, ax: 0, ay: 0, ndx: 0, ndy: 0, sp1: 0, sp2: 0,
            stroke: 0, started: 0, custom: 0, ratio: 0, angle: 0, ddx: 0, ddy: 0, decl: 0, asc: 0, zoom: 0, rot: 0,
            adx: 0, ady: 0, flip: -1, gx: 0, gy: 0, declx: 0, decly: 0, dpbr: 0, dpar: 0, dps: 0, barrel: 0 };
        b.bucket.fill(0);
    }
    function _mpConst(b, si) { return !b.maps[si]; }

    function _mpUpdate(b, ddab, dx, dy, dp, ddecl, dasc, dt, zoom, vrot, ddeclx, ddecly, dbarrel) {
        var st = b.st, V = b.val, B = b.base, I = b.inputs;
        if (dt <= 0) dt = 0.001;
        st.x = _f32(st.x + dx); st.y = _f32(st.y + dy); st.pressure += dp;
        st.dpbr = V[MPS.dabs_per_basic_radius]; st.dpar = V[MPS.dabs_per_actual_radius]; st.dps = V[MPS.dabs_per_second];
        st.decl += ddecl; st.asc += dasc; st.declx += ddeclx; st.decly += ddecly;
        st.zoom = zoom;
        var rot = _mpMod(vrot * 180 / Math.PI + 180, 360) - 180;
        st.rot = rot;
        var scale = Math.exp(V[MPS.gridmap_scale]), ssz = scale * MP_GRID;
        st.gx = _mpMod(Math.abs(st.ax * V[MPS.gridmap_scale_x]), ssz) / ssz * MP_GRID;
        st.gy = _mpMod(Math.abs(st.ay * V[MPS.gridmap_scale_y]), ssz) / ssz * MP_GRID;
        if (st.ax < 0) st.gx = MP_GRID - st.gx;
        if (st.ay < 0) st.gy = MP_GRID - st.gy;
        var baseR = Math.exp(B[MPS.radius_logarithmic]);
        st.barrel += dbarrel;
        if (st.pressure <= 0) st.pressure = 0;
        var pr = st.pressure, thr = B[MPS.stroke_threshold];
        if (!st.started && pr > thr + 0.0001) { st.started = 1; st.stroke = 0; }
        else if (st.started && pr <= thr * 0.9 + 0.0001) st.started = 0;
        var ndx = dx / dt * st.zoom, ndy = dy / dt * st.zoom, nsp = _hypot(ndx, ndy),
            ndist = _hypot(dx / dt / baseR, dy / dt / baseR) * dt;
        I[MPI.pressure] = pr * Math.exp(B[MPS.pressure_gain_log]);
        I[MPI.speed1] = Math.log(b.gam[0] + st.sp1) * b.m[0] + b.q[0];
        I[MPI.speed2] = Math.log(b.gam[1] + st.sp2) * b.m[1] + b.q[1];
        I[MPI.random] = b.random;
        I[MPI.stroke] = Math.min(st.stroke, 1);
        var da = Math.atan2(st.ddy, st.ddx) * 180 / Math.PI;
        I[MPI.direction] = _mpMod(da + rot + 180, 180);
        var da360 = Math.atan2(st.ady, st.adx) * 180 / Math.PI;
        I[MPI.direction_angle] = _mpFmod(da360 + rot + 360, 360);
        I[MPI.tilt_declination] = st.decl;
        I[MPI.tilt_ascension] = _mpMod(st.asc + rot + 180, 360) - 180;
        I[MPI.viewzoom] = B[MPS.radius_logarithmic] - Math.log(baseR / st.zoom);
        I[MPI.attack_angle] = _mpAngDiff(st.asc, _mpMod(da360 + 90, 360));
        I[MPI.brush_radius] = B[MPS.radius_logarithmic];
        I[MPI.gridmap_x] = _clamp(st.gx, 0, MP_GRID);
        I[MPI.gridmap_y] = _clamp(st.gy, 0, MP_GRID);
        I[MPI.tilt_declinationx] = st.declx;
        I[MPI.tilt_declinationy] = st.decly;
        I[MPI.custom] = st.custom;
        I[MPI.barrel_rotation] = _mpMod(st.barrel, 360);
        for (var i = 0; i < V.length; i++) {
            var r = B[i], mp = b.maps[i];
            if (mp) {
                for (var e = 0; e < mp.length; e++) {
                    var xs = mp[e].xs, ys = mp[e].ys, x = I[mp[e].i],
                        x0 = xs[0], y0 = ys[0], x1 = xs[1], y1 = ys[1];
                    for (var k = 2; k < xs.length && x > x1; k++) { x0 = x1; y0 = y1; x1 = xs[k]; y1 = ys[k]; }
                    r += (x0 === x1 || y0 === y1) ? y0 : (y1 * (x - x0) + y0 * (x1 - x)) / (x1 - x0);
                }
            }
            V[i] = r;
        }
        var f = 1 - _mpDecay(V[MPS.slow_tracking_per_dab], ddab);
        st.ax = _f32(st.ax + (st.x - st.ax) * f); st.ay = _f32(st.ay + (st.y - st.ay) * f);
        f = 1 - _mpDecay(V[MPS.speed1_slowness], dt); st.sp1 += (nsp - st.sp1) * f;
        f = 1 - _mpDecay(V[MPS.speed2_slowness], dt); st.sp2 += (nsp - st.sp2) * f;
        var tc = _max(0.002, Math.exp(V[MPS.offset_by_speed_slowness] * 0.01) - 1);
        f = 1 - _mpDecay(tc, dt); st.ndx += (ndx - st.ndx) * f; st.ndy += (ndy - st.ndy) * f;
        var ex = dx * st.zoom, ey = dy * st.zoom;
        f = 1 - _mpDecay(Math.exp(V[MPS.direction_filter] * 0.5) - 1, _hypot(ex, ey));
        var ox = st.ddx, oy = st.ddy;
        st.adx += (ex - st.adx) * f; st.ady += (ey - st.ady) * f;
        if ((ox - ex) * (ox - ex) + (oy - ey) * (oy - ey) > (ox + ex) * (ox + ex) + (oy + ey) * (oy + ey)) { ex = -ex; ey = -ey; }
        st.ddx += (ex - st.ddx) * f; st.ddy += (ey - st.ddy) * f;
        f = 1 - _mpDecay(V[MPS.custom_input_slowness], 0.1);
        st.custom += (V[MPS.custom_input] - st.custom) * f;
        var fr = Math.exp(-V[MPS.stroke_duration_logarithmic]), sk = _max(0, st.stroke + ndist * fr),
            wrap = 1 + _max(0, V[MPS.stroke_holdtime]);
        st.stroke = (sk >= wrap && wrap > 10.9) ? 1 : sk >= wrap ? _mpFmod(sk, wrap) : sk;
        st.radius = _clamp(Math.exp(V[MPS.radius_logarithmic]), MP_RMIN, MP_RMAX);
        st.ratio = V[MPS.elliptical_dab_ratio];
        st.angle = _mpMod(V[MPS.elliptical_dab_angle] - rot + 180, 180) - 180;
        for (var sk2 in st) st[sk2] = _f32(st[sk2]);
    }

    function _mpOffsets(b, baseR, flip) {
        var V = b.val, st = b.st, mult = Math.exp(V[MPS.offset_multiplier]);
        if (!isFinite(mult)) return [0, 0];
        var dx = V[MPS.offset_x], dy = V[MPS.offset_y], adj = V[MPS.offset_angle_adj], R = Math.PI / 180,
            deg = _mpFmod(Math.atan2(st.ady, st.adx) / R - 90, 360), rot = st.rot, a, v;
        if ((v = V[MPS.offset_angle])) { a = (deg + adj) * R; dx += Math.cos(a) * v; dy += Math.sin(a) * v; }
        if ((v = V[MPS.offset_angle_asc])) { a = (st.asc - rot + adj) * R; dx += Math.cos(a) * v; dy += Math.sin(a) * v; }
        if ((v = V[MPS.offset_angle_view])) { a = (rot + adj) * R; dx += Math.cos(-a) * v; dy += Math.sin(-a) * v; }
        if ((v = _max(0, V[MPS.offset_angle_2]))) { a = (deg + adj * flip) * R; dx += Math.cos(a) * v * flip; dy += Math.sin(a) * v * flip; }
        if ((v = _max(0, V[MPS.offset_angle_2_asc]))) { a = (st.asc - rot + adj * flip) * R; dx += Math.cos(a) * v * flip; dy += Math.sin(a) * v * flip; }
        if ((v = _max(0, V[MPS.offset_angle_2_view]))) { a = (rot + adj) * R; dx += Math.cos(-a) * v * flip; dy += Math.sin(-a) * v * flip; }
        var bm = baseR * mult;
        return [_clamp(dx * bm, -3240, 3240), _clamp(dy * bm, -3240, 3240)];
    }

    function _mpDab(b, sf) {
        var V = b.val, B = b.base, st = b.st;
        var opaque = _clamp(_max(0, V[MPS.opaque]) * V[MPS.opaque_multiply], 0, 1), lin = B[MPS.opaque_linearize];
        if (lin) {
            var dpp = (B[MPS.dabs_per_actual_radius] + B[MPS.dabs_per_basic_radius]) * 2;
            if (dpp < 1) dpp = 1;
            dpp = 1 + lin * (dpp - 1);
            opaque = 1 - Math.pow(1 - opaque, 1 / dpp);
        }
        var x = st.ax, y = st.ay, baseR = Math.exp(B[MPS.radius_logarithmic]);
        var off = _mpOffsets(b, baseR, st.flip);
        x += off[0]; y += off[1];
        var obs = V[MPS.offset_by_speed];
        if (obs) { x += st.ndx * obs * 0.1 / st.zoom; y += st.ndy * obs * 0.1 / st.zoom; }
        var obr = V[MPS.offset_by_random];
        if (obr) { var amp = _max(0, obr); x += _mpGauss(b.rng) * amp * baseR; y += _mpGauss(b.rng) * amp * baseR; }
        var radius = st.radius, rbr = V[MPS.radius_by_random];
        if (rbr) {
            radius = _clamp(Math.exp(V[MPS.radius_logarithmic] + _mpGauss(b.rng) * rbr), MP_RMIN, MP_RMAX);
            var ac = (st.radius / radius) * (st.radius / radius);
            if (ac <= 1) opaque *= ac;
        }
        var c = [B[MPS.color_h], B[MPS.color_s], B[MPS.color_v]];
        _mpHsvRgb(c);
        var bk = b.bucket, sl = V[MPS.smudge_length];
        if (sl < 1 && (V[MPS.smudge] !== 0 || !_mpConst(b, MPS.smudge))) {
            var uf = _max(0.01, sl), rec = bk[8] * uf, sr, sg, sb, sa;
            bk[8] = rec;
            if (rec < Math.min(1, Math.pow(0.5 * uf, V[MPS.smudge_length_log]) + 1e-16)) {
                if (rec === 0) uf = 0;
                bk[8] = 1;
                var got = _mpGetColor(sf, Math.round(x), Math.round(y),
                    _clamp(radius * Math.exp(V[MPS.smudge_radius_log]), MP_RMIN, MP_RMAX));
                sr = got[0]; sg = got[1]; sb = got[2]; sa = got[3];
                var lim = V[MPS.smudge_transparency];
                if ((lim > 0 && sa < lim) || (lim < 0 && sa > -lim)) return false;
                bk[4] = sr; bk[5] = sg; bk[6] = sb; bk[7] = sa;
            } else { sr = bk[4]; sg = bk[5]; sb = bk[6]; sa = bk[7]; }
            var fo = uf, fn = (1 - uf) * sa;
            bk[0] = fo * bk[0] + fn * sr; bk[1] = fo * bk[1] + fn * sg; bk[2] = fo * bk[2] + fn * sb;
            bk[3] = _clamp(fo * bk[3] + fn, 0, 1);
        }
        var eta = 1, sm = V[MPS.smudge];
        if (sm > 0) {
            var sf2 = Math.min(1, sm);
            eta = _clamp(1 - sf2 + sf2 * bk[3], 0, 1);
            if (eta > 0) for (var q = 0; q < 3; q++) c[q] = (sf2 * bk[q] + (1 - sf2) * c[q]) / eta;
            else { c[0] = 1; c[1] = 0; c[2] = 0; }
        }
        if (V[MPS.eraser]) eta *= 1 - V[MPS.eraser];
        var hsv = V[MPS.change_color_h] || V[MPS.change_color_hsv_s] || V[MPS.change_color_v],
            hsl = V[MPS.change_color_l] || V[MPS.change_color_hsl_s];
        if (hsv) {
            _mpRgbHsv(c);
            c[0] += V[MPS.change_color_h]; c[1] += c[1] * c[2] * V[MPS.change_color_hsv_s]; c[2] += V[MPS.change_color_v];
            _mpHsvRgb(c);
        }
        if (hsl) {
            _mpRgbHsl(c);
            c[2] += V[MPS.change_color_l];
            c[1] += c[1] * Math.min(Math.abs(1 - c[2]), Math.abs(c[2])) * 2 * V[MPS.change_color_hsl_s];
            _mpHslRgb(c);
        }
        var hard = _clamp(V[MPS.hardness], 0, 1), fade = radius * (1 - hard), minF = V[MPS.anti_aliasing];
        if (fade < minF) {
            var optR = radius - (1 - hard) * radius / 2;
            hard = (optR - minF / 2) / (optR + minF / 2);
            radius = minF / (1 - hard);
        }
        var snap = V[MPS.snap_to_pixel];
        if (snap > 0) {
            x += (_floor(x) + 0.5 - x) * snap; y += (_floor(y) + 0.5 - y) * snap;
            var srad = _max(0.5, Math.round(radius * 2) / 2);
            if (snap > 0.9999) srad -= 0.0001;
            radius += (srad - radius) * snap;
        }
        return _mpDrawDab(sf, x, y, radius, c[0], c[1], c[2], opaque, hard, eta,
            st.ratio, st.angle, V[MPS.lock_alpha], V[MPS.colorize]);
    }

    function _mpDabCount(b, x, y, dt) {
        var st = b.st, B = b.base, baseR = _clamp(Math.exp(B[MPS.radius_logarithmic]), MP_RMIN, MP_RMAX);
        if (st.radius === 0) st.radius = baseR;
        var dx = x - st.x, dy = y - st.y, dist;
        if (st.ratio > 1) {
            var a = st.angle * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a),
                yr = (dy * cs - dx * sn) * st.ratio, xr = dy * sn + dx * cs;
            dist = Math.sqrt(yr * yr + xr * xr);
        } else dist = _hypot(dx, dy);
        dist = _f32(dist);
        return _f32(dist / st.radius * B[MPS.dabs_per_actual_radius] + dist / baseR * B[MPS.dabs_per_basic_radius] + dt * B[MPS.dabs_per_second]);
    }

    // One pen event: libmypaint's stroke_to, dtime in seconds.
    function _mpStrokeTo(b, sf, x, y, pressure, dtime) {
        var st = b.st, B = b.base;
        var tAsc = 0, tDecl = 90, tDx = 90, tDy = 90;
        if (pressure <= 0) pressure = 0;
        if (dtime <= 0) dtime = 0.0001;
        if (dtime > 0.1 && pressure && st.pressure === 0) {
            /* libmypaint passes 90 as xtilt here, clamped to 1: a pen tilted
             * flat for that one event. Kept, since it is what it paints. */
            _mpStrokeToTilt(b, sf, x, y, 0, 1, 0, dtime - 0.0001);
            dtime = 0.0001;
        }
        return _mpStrokeToTilt(b, sf, x, y, pressure, 0, 0, dtime, tAsc, tDecl, tDx, tDy);
    }
    function _mpStrokeToTilt(b, sf, x, y, pressure, xt, yt, dtime, tAsc, tDecl, tDx, tDy) {
        var st = b.st, B = b.base;
        x = _f32(x); y = _f32(y); pressure = _f32(pressure);
        if (tAsc === undefined) {
            tAsc = 0; tDecl = 90; tDx = 90; tDy = 90;
            if (xt || yt) {
                xt = _clamp(xt, -1, 1); yt = _clamp(yt, -1, 1);
                tAsc = Math.atan2(-xt, yt) * 180 / Math.PI;
                tDecl = 90 - _hypot(xt, yt) * 60; tDx = xt * 60; tDy = yt * 60;
            }
        }
        if (b.skip > 0.001) {
            var d0 = _hypot(b.skipX - x, b.skipY - y);
            b.skipX = x; b.skipY = y; b.skipDt += dtime; b.skip = _f32(b.skip - _f32(d0)); dtime = b.skipDt;
            if (b.skip > 0.001 && !(dtime > 5 || b.reset)) return;
            b.skip = b.skipX = b.skipY = b.skipDt = 0;
        }
        if (B[MPS.tracking_noise]) {
            var noise = Math.exp(B[MPS.radius_logarithmic]) * B[MPS.tracking_noise];
            if (noise > 0.001) {
                b.skip = _f32(0.5 * noise); b.skipX = x; b.skipY = y;
                x = _f32(x + noise * _mpGauss(b.rng)); y = _f32(y + noise * _mpGauss(b.rng));
            }
        }
        var f = 1 - _mpDecay(B[MPS.slow_tracking], 100 * dtime);
        x = _f32(st.x + (x - st.x) * f); y = _f32(st.y + (y - st.y) * f);
        if (dtime > 5 || b.reset) {
            b.reset = false;
            _mpReset(b); st = b.st;
            b.random = b.rng();
            st.x = st.ax = x; st.y = st.ay = y; st.pressure = pressure; st.stroke = 1;
            return;
        }
        var left = dtime, moved = st.partial, todo = _mpDabCount(b, x, y, dtime);
        while (moved + todo >= 1) {
            var ddab;
            if (moved > 0) { ddab = 1 - moved; moved = 0; } else ddab = 1;
            var fr = _f32(ddab / todo), sdt = _f32(fr * left);   // floats, dtime_left a double: libmypaint's types
            _mpUpdate(b, ddab, _f32(fr * (x - st.x)), _f32(fr * (y - st.y)), _f32(fr * (pressure - st.pressure)),
                _f32(fr * (tDecl - st.decl)), _f32(fr * _mpAngDiff(st.asc, tAsc)), sdt, 1, 0,
                _f32(fr * (tDx - st.declx)), _f32(fr * (tDy - st.decly)), _f32(fr * _mpAngDiff(st.barrel, 0)));
            st.flip *= -1;
            _mpDab(b, sf);
            b.random = b.rng();
            left -= sdt;
            todo = _mpDabCount(b, x, y, left);
        }
        _mpUpdate(b, todo, x - st.x, y - st.y, pressure - st.pressure, tDecl - st.decl, _mpAngDiff(st.asc, tAsc),
            left, 1, 0, tDx - st.declx, tDy - st.decly, _mpAngDiff(st.barrel, 0));
        st.partial = _f32(moved + todo);
    }

    /* The surface. load(tx, ty, buf) fills a new tile from the layer. */
    function _mpSurface(load) { return { tiles: new Map(), dirty: new Set(), load: load, mask: new Uint16Array(MP_T * MP_T) }; }
    function _mpTile(sf, tx, ty) {
        var k = (ty + 32768) * 65536 + (tx + 32768), t = sf.tiles.get(k);
        if (!t) { t = new Uint16Array(MP_T * MP_T * 4); sf.load(tx, ty, t); sf.tiles.set(k, t); if (sf.orig) sf.orig.set(k, t.slice()); }
        return t;
    }
    // render_dab_mask for one tile: the 15-bit coverage of each pixel, box returned
    function _mpMask(m, x, y, radius, hard, ratio, angle) {
        hard = _clamp(hard, 0, 1); if (ratio < 1) ratio = 1;
        var o1 = 1, s1 = -(1 / hard - 1), o2 = hard / (1 - hard), s2 = -hard / (1 - hard);
        var a = angle / 360 * 2 * Math.PI, cs = Math.cos(a), sn = Math.sin(a), rf = radius + 1;
        var x0 = _max(0, _floor(x - rf)), y0 = _max(0, _floor(y - rf)),
            x1 = Math.min(MP_T - 1, _floor(x + rf)), y1 = Math.min(MP_T - 1, _floor(y + rf)),
            inv = 1 / (radius * radius), aa = radius < 3, raa = radius > 1 ? radius - 1 : 0, RA = Math.sqrt(1 / Math.PI);
        raa *= raa / ratio;
        for (var yp = y0; yp <= y1; yp++) {
            for (var xp = x0; xp <= x1; xp++) {
                var rr;
                if (!aa) {
                    var yy = yp + 0.5 - y, xx = xp + 0.5 - x, yr = (yy * cs - xx * sn) * ratio, xr = yy * sn + xx * cs;
                    rr = (yr * yr + xr * xr) * inv;
                } else {
                    // calculate_rr_antialiased
                    var pr = x - xp, pb = y - yp, pcx = pr - 0.5, pcy = pb - 0.5, pl = pr - 1, pt = pb - 1, nx, ny, rn, rrn;
                    if (pl < 0 && pr > 0 && pt < 0 && pb > 0) { nx = ny = 0; rrn = 0; }
                    else {
                        var tt = (pcx * cs + pcy * sn) / (cs * cs + sn * sn);
                        nx = _clamp(cs * tt, pl, pr); ny = _clamp(sn * tt, pt, pb);
                        var a1 = (ny * cs - nx * sn) * ratio, b1 = ny * sn + nx * cs;
                        rrn = (a1 * a1 + b1 * b1) * inv;
                    }
                    if (rrn > 1) rr = rrn;
                    else {
                        var sgn = (pcx - cs) * sn - cs * (pcy + sn), fx, fy;
                        if (sgn < 0) { fx = nx - sn * RA; fy = ny + cs * RA; } else { fx = nx + sn * RA; fy = ny - cs * RA; }
                        var a2 = (fy * cs - fx * sn) * ratio, b2 = fy * sn + fx * cs, rfar = a2 * a2 + b2 * b2, rrf = rfar * inv;
                        rr = rfar < raa ? (rrf + rrn) * 0.5 : 1 - (1 - rrn) / (1 + rrf - rrn);
                    }
                }
                var opa = rr > 1 ? 0 : (rr <= hard ? o1 + rr * s1 : o2 + rr * s2);
                m[yp * MP_T + xp] = opa > 0 ? (opa * MP_ONE) | 0 : 0;
            }
        }
        return [x0, y0, x1, y1];
    }
    function _mpDrawDab(sf, x, y, radius, r, g, bl, opaque, hard, ca, ratio, angle, lock, colorize) {
        opaque = _clamp(opaque, 0, 1); hard = _clamp(hard, 0, 1); lock = _clamp(lock, 0, 1); colorize = _clamp(colorize, 0, 1);
        if (radius < 0.1 || hard === 0 || opaque === 0) return false;
        var cr = (_clamp(r, 0, 1) * MP_ONE) | 0, cg = (_clamp(g, 0, 1) * MP_ONE) | 0, cb = (_clamp(bl, 0, 1) * MP_ONE) | 0;
        ca = _clamp(ca, 0, 1);
        var normal = (1 - lock) * (1 - colorize), rf = radius + 1;
        if (ratio < 1) ratio = 1;
        var tx1 = _floor(_floor(x - rf) / MP_T), tx2 = _floor(_floor(x + rf) / MP_T),
            ty1 = _floor(_floor(y - rf) / MP_T), ty2 = _floor(_floor(y + rf) / MP_T), m = sf.mask;
        var opN = (normal * opaque * MP_ONE) | 0, ca16 = (ca * MP_ONE) | 0,
            opL = (lock * opaque * (1 - colorize) * MP_ONE) | 0, opC = (colorize * opaque * MP_ONE) | 0;
        for (var ty = ty1; ty <= ty2; ty++) {
            for (var tx = tx1; tx <= tx2; tx++) {
                var t = _mpTile(sf, tx, ty), bx = _mpMask(m, x - tx * MP_T, y - ty * MP_T, radius, hard, ratio, angle);
                sf.dirty.add((ty + 32768) * 65536 + (tx + 32768));
                for (var yp = bx[1]; yp <= bx[3]; yp++) {
                    for (var xp = bx[0]; xp <= bx[2]; xp++) {
                        var mk = m[yp * MP_T + xp];
                        if (!mk) continue;
                        var i = (yp * MP_T + xp) * 4, oa, ob;
                        if (normal) {
                            oa = (mk * opN) >>> 15; ob = MP_ONE - oa;
                            if (ca === 1) {
                                t[i + 3] = oa + ((ob * t[i + 3]) >>> 15);
                            } else {
                                oa = (oa * ca16) >>> 15;
                                t[i + 3] = oa + ((ob * t[i + 3]) >>> 15);
                            }
                            t[i] = (oa * cr + ob * t[i]) >>> 15;
                            t[i + 1] = (oa * cg + ob * t[i + 1]) >>> 15;
                            t[i + 2] = (oa * cb + ob * t[i + 2]) >>> 15;
                        }
                        if (lock && ca !== 0) {
                            oa = (mk * opL) >>> 15; ob = MP_ONE - oa;
                            oa = (oa * t[i + 3]) >>> 15;
                            t[i] = (oa * cr + ob * t[i]) >>> 15;
                            t[i + 1] = (oa * cg + ob * t[i + 1]) >>> 15;
                            t[i + 2] = (oa * cb + ob * t[i + 2]) >>> 15;
                        }
                        if (colorize) _mpColorize(t, i, cr, cg, cb, (mk * opC) >>> 15);
                    }
                }
            }
        }
        return true;
    }
    // draw_dab_pixels_BlendMode_Color: the dab's hue and saturation, the layer's luminance
    function _mpLuma(R, G, B) { return R * 0.2126 * MP_ONE + G * 0.7152 * MP_ONE + B * 0.0722 * MP_ONE; }
    function _mpColorize(t, i, cr, cg, cb, oa) {
        var a = t[i + 3], r = 0, g = 0, b = 0;
        if (a) { r = ((MP_ONE * t[i]) / a) & 0xffff; g = ((MP_ONE * t[i + 1]) / a) & 0xffff; b = ((MP_ONE * t[i + 2]) / a) & 0xffff; }
        var diff = (((_mpLuma(r, g, b) / MP_ONE) & 0xffff) - ((_mpLuma(cr, cg, cb) / MP_ONE) & 0xffff)) << 16 >> 16;
        var R = cr + diff, G = cg + diff, B = cb + diff, lum = (_mpLuma(R, G, B) / MP_ONE) | 0,
            mn = Math.min(R, G, B), mx = _max(R, G, B);
        if (mn < 0) { R = lum + (((R - lum) * lum) / (lum - mn) | 0); G = lum + (((G - lum) * lum) / (lum - mn) | 0); B = lum + (((B - lum) * lum) / (lum - mn) | 0); }
        if (mx > MP_ONE) { R = lum + (((R - lum) * (MP_ONE - lum)) / (mx - lum) | 0); G = lum + (((G - lum) * (MP_ONE - lum)) / (mx - lum) | 0); B = lum + (((B - lum) * (MP_ONE - lum)) / (mx - lum) | 0); }
        R = ((R & 0xffff) * a) >>> 15; G = ((G & 0xffff) * a) >>> 15; B = ((B & 0xffff) * a) >>> 15;
        var ob = MP_ONE - oa;
        t[i] = (oa * R + ob * t[i]) >>> 15; t[i + 1] = (oa * G + ob * t[i + 1]) >>> 15; t[i + 2] = (oa * B + ob * t[i + 2]) >>> 15;
    }
    // get_color, legacy sampling: the dab-weighted average, straight
    function _mpGetColor(sf, x, y, radius) {
        if (radius < 1) radius = 1;
        var rf = radius + 1, m = sf.mask, W = 0, R = 0, G = 0, B = 0, A = 0;
        var tx1 = _floor(_floor(x - rf) / MP_T), tx2 = _floor(_floor(x + rf) / MP_T),
            ty1 = _floor(_floor(y - rf) / MP_T), ty2 = _floor(_floor(y + rf) / MP_T);
        for (var ty = ty1; ty <= ty2; ty++) {
            for (var tx = tx1; tx <= tx2; tx++) {
                var t = _mpTile(sf, tx, ty), bx = _mpMask(m, x - tx * MP_T, y - ty * MP_T, radius, 0.5, 1, 0);
                var w = 0, r = 0, g = 0, b = 0, a = 0;
                for (var yp = bx[1]; yp <= bx[3]; yp++) {
                    for (var xp = bx[0]; xp <= bx[2]; xp++) {
                        var o = m[yp * MP_T + xp];
                        if (!o) continue;
                        var i = (yp * MP_T + xp) * 4;
                        w += o; r += (o * t[i]) >>> 15; g += (o * t[i + 1]) >>> 15; b += (o * t[i + 2]) >>> 15; a += (o * t[i + 3]) >>> 15;
                    }
                }
                W += w; R += r; G += g; B += b; A += a;
            }
        }
        if (!W) return [0, 1, 0, 0];
        A /= W; R /= W; G /= W; B /= W;
        return A > 0 ? [_clamp(R / A, 0, 1), _clamp(G / A, 0, 1), _clamp(B / A, 0, 1), _clamp(A, 0, 1)] : [0, 1, 0, 0];
    }

    /* The stroke. The brush lives as long as its preset: libmypaint's
     * random numbers run on from stroke to stroke, a new brush starts them
     * at the seed again. */
    var _mpB = null, _mpS = null, MP_EVENT = 0.005;   // seconds between the pen's reports around a press or lift
    function _paintMyPaint(pts, from, to, final) {
        var p = getParams();
        if (!p.mypaint || !pts.length) return;
        if (!_mpS) {
            // a preview paints with a brush of its own: it must not use up the canvas brush's random numbers
            if (!_previewTarget && (!_mpB || _mpB.src !== p.mypaint)) _mpB = { src: p.mypaint, b: _mpNewBrush(p.mypaint.settings || {}) };
            var b = _previewTarget ? _mpNewBrush(p.mypaint.settings || {}) : _mpB.b, hx = String(_state.lastColor || '#000000'), c = [0, 0, 0];
            if (/^#[0-9a-f]{6}$/i.test(hx)) c = [parseInt(hx.slice(1, 3), 16) / 255, parseInt(hx.slice(3, 5), 16) / 255, parseInt(hx.slice(5, 7), 16) / 255];
            _mpRgbHsv(c);
            b.base[MPS.color_h] = c[0]; b.base[MPS.color_s] = c[1]; b.base[MPS.color_v] = c[2];
            b.base[MPS.radius_logarithmic] = Math.log(_max(MP_RMIN, p.size / 2));
            if (p.blendMode === 'erase') b.base[MPS.eraser] = 1;
            else b.base[MPS.eraser] = (p.mypaint.settings.eraser || {}).base || 0;
            var W = _docW(), H = _docH(), src = _bgCtx;
            _mpS = { b: b, t: pts[0].t, sf: _mpSurface(function (tx, ty, buf) {
                var x0 = tx * MP_T, y0 = ty * MP_T;
                if (!src || x0 >= W || y0 >= H || x0 + MP_T <= 0 || y0 + MP_T <= 0) return;
                var cx = _max(0, x0), cy = _max(0, y0), w = Math.min(W, x0 + MP_T) - cx, h = Math.min(H, y0 + MP_T) - cy,
                    d = src.getImageData(cx, cy, w, h).data;
                for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
                    var s = (yy * w + xx) * 4, o = ((cy - y0 + yy) * MP_T + (cx - x0 + xx)) * 4, a = Math.round(d[s + 3] * MP_ONE / 255);
                    buf[o + 3] = a;
                    for (var k = 0; k < 3; k++) buf[o + k] = Math.round(d[s + k] / 255 * a);
                }
            }) };
            // what the tiles held before the stroke, for the selection and alpha lock to put back
            if (!_previewTarget && (_selStencil || _alphaLocked())) _mpS.sf.orig = new Map();
            b.reset = true;
            _mpStrokeTo(b, _mpS.sf, pts[0].x, pts[0].y, 0, 0.5);                  // the pen coming in
            _mpStrokeTo(b, _mpS.sf, pts[0].x, pts[0].y, pts[0].pressure, MP_EVENT);
        }
        var bb = _mpS.b, sf = _mpS.sf;
        for (var i = from + 1; i <= to; i++) {
            _mpStrokeTo(bb, sf, pts[i].x, pts[i].y, pts[i].pressure, (pts[i].t - _mpS.t) / 1000);
            _mpS.t = pts[i].t;
        }
        if (final) { var l = pts[pts.length - 1]; _mpStrokeTo(bb, sf, l.x, l.y, 0, MP_EVENT); }
        _mpFlush(sf);
        if (final) _mpS = null;
    }
    function _mpFlush(sf) {
        if (!sf.dirty.size) return;
        var oc = _outCtx(), W = _docW(), H = _docH(), x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        sf.dirty.forEach(function (k) {
            var tx = (k % 65536) - 32768, ty = _floor(k / 65536) - 32768, x0 = tx * MP_T, y0 = ty * MP_T,
                cx = _max(0, x0), cy = _max(0, y0), w = Math.min(W, x0 + MP_T) - cx, h = Math.min(H, y0 + MP_T) - cy;
            if (w <= 0 || h <= 0) return;
            var t = sf.tiles.get(k), im = new ImageData(w, h), d = im.data;
            if (sf.orig) _mpClip(t, sf.orig.get(k), cx, cy, cx - x0, cy - y0, w, h);
            for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
                var o = ((cy - y0 + yy) * MP_T + (cx - x0 + xx)) * 4, s = (yy * w + xx) * 4, a = t[o + 3];
                if (!a) continue;
                d[s + 3] = Math.round(a * 255 / MP_ONE);
                for (var c = 0; c < 3; c++) d[s + c] = Math.round(t[o + c] * 255 / a);
            }
            oc.putImageData(im, cx, cy);
            if (cx < x1) x1 = cx; if (cy < y1) y1 = cy; if (cx + w > x2) x2 = cx + w; if (cy + h > y2) y2 = cy + h;
        });
        sf.dirty.clear();
        if (x2 > x1 && !_previewTarget && app.layerMgr && app.layerMgr.markDirty) app.layerMgr.markDirty(x1, y1, x2 - x1, y2 - y1);
    }

    /* Outside the selection a pixel keeps what it had; under the layer's
     * alpha lock it keeps its alpha and takes the new colour. Written into
     * the tile itself, so a smudge picks up the clipped picture. */
    function _mpClip(t, o, cx, cy, ox, oy, w, h) {
        var st = null, locked = _alphaLocked();
        if (_selStencil) { try { st = _selStencil.getContext('2d').getImageData(cx, cy, w, h).data; } catch (e) { st = null; } }
        for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) {
            var i = ((oy + yy) * MP_T + ox + xx) * 4, a = t[i + 3], oa = o[i + 3];
            if ((st && !st[(yy * w + xx) * 4 + 3]) || (locked && !a)) { t[i] = o[i]; t[i + 1] = o[i + 1]; t[i + 2] = o[i + 2]; t[i + 3] = oa; }
            else if (locked && a !== oa) { for (var c = 0; c < 3; c++) t[i + c] = Math.round(t[i + c] * oa / a); t[i + 3] = oa; }
        }
    }

    function _flushPending(final) {
        if (getParams().engineKind === 'deform') {
            var dpts = _state.strokePoints;
            if (dpts.length > 1) {
                _deformStroke(dpts, _state.lastProcessedIdx, dpts.length - 1);
                _state.lastProcessedIdx = dpts.length - 1;
                _state.started = true;
            }
            return;
        }
        var ekf = getParams().engineKind;
        if (ekf === 'mypaint') {
            var mpp = _state.strokePoints;
            if (!mpp.length || !_state.lastColor) return;
            _paintMyPaint(mpp, _state.started ? _state.lastProcessedIdx : 0, mpp.length - 1, final);
            _state.lastProcessedIdx = mpp.length - 1;
            _state.started = true;
            return;
        }
        if (ekf === 'sketch' || ekf === 'curve' || ekf === 'particle' || ekf === 'hairy') {
            var kp = _state.strokePoints;
            if (kp.length < 2 || !_state.lastColor) return;
            _dirtyRect = null;
            (ekf === 'curve' ? _paintCurveOp : ekf === 'particle' ? _paintParticle : ekf === 'hairy' ? _paintHairy : _paintSketch)(kp, _state.lastProcessedIdx, kp.length - 1);
            _state.lastProcessedIdx = kp.length - 1;
            _state.started = true;
            _hintFlushRect(final);
            var _skOc = _outCtx();
            if (_skOc && _dirtyRect) _flushFlowBuffer(_skOc, false, final);
            return;
        }
        if (getParams().engineKind === 'shape') {
            var sp = _state.strokePoints;
            if (sp.length < 1 || !_state.lastColor) return;
            _paintShapeStroke(sp, _state.lastColor);
            _hintFlushRect();
            var _shapeOc = _outCtx();
            if (_shapeOc) _flushFlowBuffer(_shapeOc);
            return;
        }

        var pts = _state.strokePoints;
        if (pts.length < 1 || !_state.lastColor) return;
        /* The final pass exists to paint a taper that could not be known
         * while the stroke was being drawn: an end taper needs the finished
         * length, and 'stroke' units need the total distance. Nothing else
         * about a dab is retroactive -- the flow buffer already holds the
         * whole stroke, and a replay of a taperless preset repaints exactly
         * what is already there.
         *
         * So a brush with no taper pays the whole stroke twice for nothing,
         * and only four of the presets we ship set one. Fall through to the
         * incremental branch instead, which still picks up the stabilizer
         * catch-up points endStroke appends just before calling us. */
        var tp = getParams(), sec = final && _secondOf();
        if (final && !sec && !_needsReplay(tp, pts) && !(tp.ribbonClip && pts.length > 1)) final = false;
        if (final) {
            _ensureFlowBuffer(
                (app.config ? app.config.width : 1024),
                (app.config ? app.config.height : 1024)
            );
            // The final pass repaints the stroke from scratch, so the
            // buffer has to be blank first — but only where it has ink.
            _clearFlowUsed();
            // Same for the wet-blend coverage: the replay repeats the same
            // dab evolution, so it must start from zero coverage to land
            // identical pixels.
            _clearCovUsed();
            _dirtyRect = null;
            _state.lastProcessedIdx = 0;
            _state.started = false;
            // The replay repaints from scratch: a pending suspend dies with it.
            _state.suspend = null;
            _smoothAngle = NaN;
            _lastDabDist = 0;
            // The replay repaints the whole stroke, so the fade sensor has
            // to start counting again with it.
            _dabIndex = 0; _mkLast = null; _gridSt = null; _pxOff = null; _adAvg = 0; _adColOn = 0;
            if (sec) {
                _paintBoth(pts, _state.lastColor, sec);
                if (tp.ribbonClip && pts.length > 1) _clipRibbonEnd(pts, tp.size);
            } else if (pts.length === 1) {
                _renderDab(pts[0].x, pts[0].y, pts[0].pressure || 0.5, _state.lastColor);
            } else {
                _processSegment(pts, 0, pts.length - 1, _state.lastColor, 2);
                if (tp.ribbonClip) _clipRibbonEnd(pts, tp.size);
            }
        } else {
            // The endStroke drain: no budget, runs whole — but it picks up a
            // pending suspend with its checkpoint instead of re-entering
            // blind, which would double-apply the segment EMA and the step.
            var resume = _state.suspend;
            _state.suspend = null;
            var startIdx = resume ? resume.segIdx :
                (_state.started ? _state.lastProcessedIdx : 0);
            if (startIdx >= pts.length - 1) {
                if (pts.length === 1 || startIdx === 0) {
                    _renderDab(pts[0].x, pts[0].y, pts[0].pressure || 0.5, _state.lastColor);
                }
            } else {
                _processSegment(pts, startIdx, pts.length - 1, _state.lastColor, 0, resume || null);
            }
        }
        if (_dirtyRect) {
            _hintFlushRect(final);
            var _pendOc = _outCtx();
            if (_pendOc) {
                _flushFlowBuffer(_pendOc, false, final);
            }
        }
    }

    function _schedulePaint() {
        if (_state.paintRaf) return;
        _state.paintRaf = requestAnimationFrame(function () {
            _state.paintRaf = null;
            var pts = _state.strokePoints;
            if (pts.length < 2 || !_state.lastColor) return;
            var ek = getParams().engineKind;
            if (ek === 'shape' || ek === 'deform' || ek === 'mypaint' || ek === 'sketch' || ek === 'curve' || ek === 'particle' || ek === 'hairy') { _flushPending(false); return; }
            var startIdx = _state.started ? _state.lastProcessedIdx : 0;
            var endIdx = pts.length - 1;
            if (startIdx < endIdx) {
                // A pending suspend resumes where it stopped; the budget
                // binds live passes only — see the in-dab-loop check.
                var resume = _state.suspend;
                _state.suspend = null;
                _paintDeadline = performance.now() + _paintBudgetMs;
                _processSegment(pts, resume ? resume.segIdx : startIdx, endIdx,
                    _state.lastColor, 1, resume || null);
                _paintDeadline = 0;
                /* Finished is its own flag, not the point index: a suspend
                 * leaves lastProcessedIdx mid-batch while new points arrive,
                 * so the index alone can no longer say the batch is done. */
                if (_state.suspend) {
                    _state.lastProcessedIdx = _state.suspend.segIdx;
                } else {
                    _state.lastProcessedIdx = endIdx;
                }
                _state.started = true;
                /* A pass can legitimately place zero dabs (remaining < step
                 * this frame) while points are still queued. _dirtyRect is
                 * only set once a dab actually lands, so this also skips
                 * touching app.ctx at all on such a frame — which otherwise
                 * forced a full-canvas recomposite for nothing. */
                if (_dirtyRect) {
                    _hintFlushRect();
                    var _liveOc = _outCtx();
                    if (_liveOc) {
                        // Union rect via _dirtyRect: everything painted so
                        // far, suspended or not — never a partial composite.
                        _flushFlowBuffer(_liveOc);
                    }
                }
                // More to paint: next frame. paintRaf is null here, so this
                // re-arms instead of hitting the coalescing guard above.
                if (_state.suspend) _schedulePaint();
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /*  UI — side panel wiring                                             */
    /* ------------------------------------------------------------------ */

    function _pbAllRows() {
        var sidebar = document.getElementById('paintbrush-sidebar');
        if (!sidebar) return [];
        var seen = {}, out = [], rows = sidebar.querySelectorAll('.pb-row[data-setting]');
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (seen[r.dataset.setting]) continue;
            seen[r.dataset.setting] = 1;
            out.push(r);
        }
        return out;
    }

    // Preview tip cache: pre-loaded custom tip canvases (luminance→alpha converted)
    var _previewTipCache = {};

    /* `which` is '' for the tip a brush stamps and '2' for the tip that
     * carves it. A swatch has to carve with its OWN second tip or every
     * dual-tip brush in the grid would be drawn through the active brush's. */
    function _ensurePreviewTip(name, callback, which) {
        var slot = name + '|' + (which || '');
        if (_previewTipCache[slot] !== undefined) { if (callback) callback(); return; }
        var preset = engine.PRESETS[name];
        var url = preset && (which === '2' ? preset._tip2Url : preset._tipUrl);
        if (!url) { _previewTipCache[slot] = null; if (callback) callback(); return; }
        var img = new Image();
        img.onload = function () { _drawRaw(img, function (img) {
            try {
                var oc = new OffscreenCanvas(img.width, img.height);
                var ox = oc.getContext('2d');
                ox.drawImage(img, 0, 0);
                var id = ox.getImageData(0, 0, oc.width, oc.height);
                var d = id.data;
                // Check if the image has actual transparency in its alpha channel.
                var hasAlpha = false;
                for (var ci = 3; ci < d.length && !hasAlpha; ci += 4) {
                    if (d[ci] < 255) hasAlpha = true;
                }
                if (hasAlpha) {
                    // Use existing alpha, zero out RGB.
                    for (var ci = 0; ci < d.length; ci += 4) {
                        d[ci] = 0; d[ci + 1] = 0; d[ci + 2] = 0;
                    }
                } else {
                    // Extract shape from luminance.
                    for (var ci = 0; ci < d.length; ci += 4) {
                        var a = (d[ci] + d[ci + 1] + d[ci + 2]) / 3 / 255;
                        d[ci] = 0; d[ci + 1] = 0; d[ci + 2] = 0;
                        d[ci + 3] = _round(_clamp(a, 0, 1) * 255);
                    }
                }
                // Invert alpha — matching the luminance→alpha convention the engine uses.
                for (var ci = 3; ci < d.length; ci += 4) {
                    d[ci] = 255 - d[ci];
                }
                ox.putImageData(id, 0, 0);
                _previewTipCache[slot] = (which === '2') ? oc
                    : _sliceCells(oc, preset.tipCells || 1, preset.tipMirror, preset.tipFlip);
            } catch (e) {
                _previewTipCache[slot] = null;
            }
            if (callback) callback();
        }); };
        img.onerror = function () {
            _previewTipCache[slot] = null;
            if (callback) callback();
        };
        _tipResolve(url, function (real) {
            if (real) { img.src = real; return; }
            _previewTipCache[slot] = null;
            if (callback) callback();
        });
    }

    function _drawCheckerboard(ctx, size) {
        var cs = 2;
        for (var y = 0; y < size; y += cs) {
            for (var x = 0; x < size; x += cs) {
                var idx = (x / cs) + (y / cs);
                ctx.fillStyle = (idx % 2 === 0) ? '#f7f7f7' : '#efefef';
                ctx.fillRect(x, y, cs, cs);
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Preset swatches — rendered by the engine, not imitated              */
    /* ------------------------------------------------------------------ */

    /* The old preview painter hand-drew a wavy line from size, spacing,
     * hardness and angle alone. Bristles, texture, flow, taper, scatter,
     * pressure and colour pickup were invisible to it, so six visibly
     * different presets all previewed as the same thin noodle. It also capped
     * the brush at 12% of the tile — flattening every size difference — and
     * tinted each tile from a hash of the preset's NAME, which is where the
     * arbitrary purples and olives came from.
     *
     * A swatch is now a real stroke: the engine paints into an offscreen
     * canvas through the same beginStroke/moveStroke/endStroke path a person
     * would drive, so whatever a preset does to a stroke is what the tile
     * shows. */

    var SWATCH_W = 134;
    var SWATCH_H = 54;
    var SWATCH_SS = 2;          // supersample, then let CSS scale it back down
    var SWATCH_INK = '#1d1f22';

    /* One scale for every preset, so tiles stay comparable: the largest brush
     * in the library fills a fixed share of the swatch and everything else
     * keeps its true proportion to it. */
    /* How much of the tile the biggest brush in the library may fill. */
    var _swatchMaxSize = 0;
    /* A swatch has to say two things at once: how big this brush is next to
     * the others, and what its mark looks like. Scaling everything linearly
     * against the biggest brush in the library only says the first, and says
     * it so hard that the second is lost -- the library runs from 2px to
     * 200px, so at the bottom of that range a tile got a third of a pixel of
     * ink and read as blank. Importing a pack makes it worse: one 250px
     * eraser arrives and every brush already installed shrinks with it.
     *
     * A floor under the drawn size fixes that and nothing else: every brush
     * big enough to see already is left exactly as it was, so the tile still
     * says which brush is bigger, and only the ones that were drawing less
     * than a visible mark are lifted to one. Compressing the whole range
     * instead (a square root over the ratio) also works and reads better
     * still, but it enlarges every mid-size brush several times over -- and
     * a swatch is a real stroke, so that is several times the cost on the
     * one panel the user already finds slow. */
    var SWATCH_MIN_INK = 4;
    function _swatchSizeScale(size) {
        if (!_swatchMaxSize) {
            var maxSz = 1;
            for (var n in engine.PRESETS) {
                if (!engine.PRESETS.hasOwnProperty(n)) continue;
                var sz = engine.PRESETS[n].size;
                if (sz == null) sz = engine.DEFAULTS.size;
                if (sz > maxSz) maxSz = sz;
            }
            _swatchMaxSize = maxSz;
        }
        var fit = SWATCH_H * SWATCH_SS * 0.28;
        var sz = _max(1, size || _swatchMaxSize);
        return _max(SWATCH_MIN_INK, sz * (fit / _swatchMaxSize)) / sz;
    }

    /* The library changed shape, so the biggest brush in it may have too. */
    function _forgetSwatchScale() { _swatchMaxSize = 0; }

    /* A swatch costs a full stroke to draw, so it is kept until something
     * actually changes it. Only the active preset can change — it is the one
     * the sliders edit — so that is the only entry ever invalidated. */
    var _swatchCache = {};

    /* Every caller gets its own node. A favourited brush has a tile under
     * Favourites and another under its family, and appending one canvas
     * twice moves it rather than copying it — the first tile went blank.
     * cloneNode is no use here: it copies the element, not the pixels. */
    function _copySwatch(src) {
        var c = document.createElement('canvas');
        c.width = src.width;
        c.height = src.height;
        c.className = src.className;
        c.style.cssText = src.style.cssText;
        c.getContext('2d').drawImage(src, 0, 0);
        return c;
    }

    function _invalidateSwatch(name) {
        if (name) delete _swatchCache[name];
        else _swatchCache = {};
    }

    function _pbRenderPreview(name) {
        var preset = engine.PRESETS[name];
        if (!preset) return null;
        // Never interrupt a stroke in progress to draw a thumbnail.
        if (_state.isDrawing) return null;
        if (_swatchCache[name]) return _copySwatch(_swatchCache[name]);

        var W = SWATCH_W * SWATCH_SS;
        var H = SWATCH_H * SWATCH_SS;
        var canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        /* No willReadFrequently here. It forces the software rasteriser for
         * every drawing op, and this function only ever DRAWS -- callers read
         * pixels off the copy `_copySwatch` hands them, which is a plain
         * context. The flag was pure cost on the most expensive tiles. */
        var ctx = canvas.getContext('2d');

        // Everything the stroke path touches is module state, so it is saved
        // whole and put back whole — a preview must leave no trace.
        var savedParams = _params;
        var savedState = _state;
        var savedTarget = _previewTarget;
        var savedFlow = _flowCanvas, savedFlowCtx = _flowCtx, savedAd = _adCanvas, savedAdCtx = _adCtx,
            savedMk = _mkCanvas, savedMkCtx = _mkCtx;
        // A tip that takes its shapes in turn would otherwise skip ahead by
        // however many dabs the tile drew.
        var savedCycle = _tipCycle;
        var savedMp = _mpS; _mpS = null;   // a MyPaint stroke under way
        // The pen's rate outlives a stroke; a tile drawn in one go has no
        // rate, and its gaps of nothing read the next real stroke as a blur
        // (Clip Studio's Milli pen, speed-thinned, drew 6px instead of 10).
        var savedSpeed = [_smoothSpeed, _spLast, _spTime, _spDists, _spDts];
        _spDists = [0]; _spDts = [];
        // _flowUsed says which part of the flow buffer to blank next
        // stroke. A preview drives the same painter over its own tiny
        // buffer, so leaving its bounds behind would blank a swatch-sized
        // corner of the real one and ghost the last stroke into the next.
        var savedFlowUsed = _flowUsed;
        var savedBg = _bgCanvas, savedBgCtx = _bgCtx;

        /* The active preset is whatever the sliders currently say, not what
         * the stored preset says — otherwise editing a brush leaves its own
         * tile showing the version you started from. */
        var live = (name === engine._currentPreset) ? _params : null;
        var pp = {};
        for (var i = 0; i < _paramMeta.length; i++) {
            var k = _paramMeta[i];
            if (live) pp[k] = live[k];
            else pp[k] = (k in preset) ? preset[k] : engine.DEFAULTS[k];
        }
        /* A preset the user has tuned carries saved overrides, so a tile built
         * from the stock definition alone would show a brush they no longer
         * have. Same source loadPreset reads. */
        if (!live) {
            try {
                var rawSaved = _readSaved(name);
                if (rawSaved) {
                    var sv = JSON.parse(rawSaved);
                    for (var sk in sv) {
                        if (sv.hasOwnProperty(sk) && !_TRANSIENT_KEYS[sk]
                            && pp.hasOwnProperty(sk)) pp[sk] = sv[sk];
                    }
                }
            } catch (e_) {}
        }
        var _ssc = _swatchSizeScale(pp.size);
        pp.size = _max(1, pp.size * _ssc);
        /* Shrink the surface with the brush. A tile is a fraction of a real
         * canvas, so a coarse grain left at full size covers it in one or two
         * lumps and the swatch reads as smooth — the one thing it must not
         * say about a brush whose whole point is the grain. */
        pp.dualScale = _max(1, _round(pp.dualScale * _ssc));
        // Smoothing is a feel-of-the-hand setting; on a scripted path it only
        // lags the stroke behind the points and clips the swatch short.
        pp.smoothingMode = 'none';

        try {
            _params = pp;
            _state = {
                isDrawing: false, strokePoints: [], lastColor: null,
                lastProcessedIdx: 0, started: false, bounds: null, paintRaf: null,
                suspend: null
            };
            _flowCanvas = null; _flowCtx = null; _adCanvas = null; _adCtx = null; _mkCanvas = null; _mkCtx = null;
            _bgCanvas = null; _bgCtx = null;
            _previewTarget = {
                ctx: ctx, w: W, h: H,
                tip: (pp.shape === 'custom') ? (_previewTipCache[name + '|'] || null) : null,
                tip2: _previewTipCache[name + '|2'] || null
            };

            var padX = W * 0.07;
            var x0 = padX, x1 = W - padX;
            var midY = H * 0.5;

            /* Some brushes only rearrange what is already there, so on an
             * empty tile they paint nothing — a true but useless swatch.
             * Give them something to work on: an eraser shows the bite it
             * takes out of a band of ink, and a smudge shows how far it
             * drags one tone into another. */
            if (pp.blendMode === 'erase') {
                ctx.save();
                ctx.fillStyle = SWATCH_INK;
                ctx.globalAlpha = 0.72;
                ctx.fillRect(0, H * 0.16, W, H * 0.68);
                ctx.restore();
            } else if (pp.colorRate < 100) {
                ctx.save();
                ctx.fillStyle = SWATCH_INK;
                ctx.globalAlpha = 0.8;
                ctx.fillRect(0, H * 0.12, W * 0.38, H * 0.76);
                ctx.globalAlpha = 0.14;
                ctx.fillRect(W * 0.38, H * 0.12, W * 0.62, H * 0.76);
                ctx.restore();
            }
            // A full S rather than a lopsided arc: it shows both directions of
            // travel, which is what makes an angled or bristle tip readable.
            var amp = H * 0.20;
            var STEPS = 64;

            for (var i2 = 0; i2 <= STEPS; i2++) {
                var t = i2 / STEPS;
                var x = x0 + (x1 - x0) * t;
                var y = midY - _sin(t * _PI * 2) * amp;
                // Press in, hold, release — so taper and pressure dynamics
                // show up the way they would in a real stroke.
                var pr = _clamp(_sin(t * _PI) * 1.25, 0.12, 1);
                if (i2 === 0) engine.beginStroke(x, y, pr, SWATCH_INK);
                else engine.moveStroke(x, y, pr, SWATCH_INK);
            }
            // The scheduled rAF paint never runs inside a synchronous render;
            // endStroke flushes everything still pending.
            engine.endStroke();
        } catch (e) {
            console.warn('[KritaEngine] swatch failed for', name, e);
        } finally {
            _previewTarget = savedTarget;
            _params = savedParams;
            // A preview must leave no trace: if the swatch stroke threw
            // before endStroke, its frozen params must not leak into UI reads.
            _strokeParams = null;
            _state = savedState;
            _flowCanvas = savedFlow; _flowCtx = savedFlowCtx; _adCanvas = savedAd; _adCtx = savedAdCtx;
            _mkCanvas = savedMk; _mkCtx = savedMkCtx;
            _flowUsed = savedFlowUsed;
            _tipCycle = savedCycle;
            _mpS = savedMp;
            _smoothSpeed = savedSpeed[0]; _spLast = savedSpeed[1]; _spTime = savedSpeed[2];
            _spDists = savedSpeed[3]; _spDts = savedSpeed[4];
            _bgCanvas = savedBg; _bgCtx = savedBgCtx;
        }

        _swatchCache[name] = canvas;
        return _copySwatch(canvas);
    }

    /* Redraw the active preset's tile after an edit. Sliders fire this on
     * every step of a drag, and a swatch costs a whole stroke to render, so it
     * coalesces onto the next frame. */
    var _swatchRaf = 0;
    var _swatchLast = 0;
    var SWATCH_MIN_GAP = 150;   // ms between redraws while a slider is moving

    /* A swatch costs a whole brush stroke, and a drag asked for one every
     * frame. Six a second reads as live and leaves the other 90% of the
     * frame for the panel itself; the trailing call guarantees the tile ends
     * up showing where the slider actually stopped. */
    engine.refreshPreview = function () {
        if (_swatchRaf) return;
        var wait = _max(0, SWATCH_MIN_GAP - (Date.now() - _swatchLast));
        var go = function () {
            _swatchRaf = 0;
            _swatchLast = Date.now();
            var name = engine._currentPreset;
            if (!name) return;
            _invalidateSwatch(name);
            var grid = document.getElementById('pb-brush-grid');
            if (!grid || !grid.offsetParent) return;   // panel not visible
            var tile = grid.querySelector('.pb-brush-tile[data-preset="'
                + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]');
            if (!tile) return;
            var c = _pbRenderPreview(name);
            if (!c) return;
            var old = tile.querySelector('canvas');
            if (old) tile.removeChild(old);
            tile.insertBefore(c, tile.firstChild);
            tile._swatched = true;
        };
        _swatchRaf = wait
            ? setTimeout(function () { requestAnimationFrame(go); }, wait)
            : requestAnimationFrame(go);
    };

    engine.syncPanel = function () {
        var els = {
            'pb-size': 'size',
            'pb-opacity': 'opacity',
            'pb-flow': 'flow',
            'pb-spacing': 'spacing',
            'pb-hardness': 'hardness',
            'pb-angle': 'angle',
            'pb-aspect': 'aspectRatio',
            'pb-colorRate': 'colorRate',
            'pb-smudgeLength': 'smudgeLength',
            'pb-smudgeRadius': 'smudgeRadius',
            'pb-tip2Depth': 'tip2Depth',
            'pb-tip2Size': 'tip2Size',
            'pb-tip2Spacing': 'tip2Spacing',
            'pb-tip2Angle': 'tip2Angle',
            'pb-dualScale': 'dualScale',
            'pb-dualDepth': 'dualDepth',
            'pb-airbrushRate': 'airbrushRate',
            'pb-bristleCount': 'bristleCount',
            'pb-bristleLength': 'bristleLength',
            'pb-bristleWidth': 'bristleWidth',
            'pb-bristleSpread': 'bristleSpread',
            'pb-scatter': 'scatter',
            'pb-hueJitter': 'hueJitter',
            'pb-satJitter': 'satJitter',
            'pb-valJitter': 'valJitter',
            'pb-dabCount': 'dabCount',
            'pb-offsetAlong': 'offsetAlong',
            'pb-offsetAcross': 'offsetAcross',
            'pb-fadeSteps': 'fadeSteps',
            'pb-distanceLength': 'distanceLength',
            'pb-taperStart': 'taperStart',
            'pb-taperEnd': 'taperEnd',
            'pb-texture': 'texture',
            'pb-textureScale': 'textureScale',
            'pb-edgeWidth': 'edgeWidth',
            'pb-edgeDensity': 'edgeDensity',
            'pb-smoothing': 'smoothingBasic',
            'pb-smoothingMode': 'smoothingMode'
        };
        for (var id in els) {
            if (!els.hasOwnProperty(id)) continue;
            var el = document.getElementById(id);
            var valEl = document.getElementById(id + '-val');
            if (el) {
                var pv = id === 'pb-smoothing' ? _activeSmoothingValue() : _params[els[id]];
                if (id === 'pb-size' || id === 'pb-smoothing') {
                    var max = parseFloat(el.max) || 100;
                    if (pv > max) {
                        var wrap = el.parentNode;
                        if (wrap) wrap.dataset.overflowVal = pv;
                        el.value = max;
                    } else {
                        var wrap = el.parentNode;
                        if (wrap) delete wrap.dataset.overflowVal;
                        el.value = pv;
                    }
                } else {
                    el.value = pv;
                }
            }
            if (valEl) { var vv = id === 'pb-smoothing' ? _activeSmoothingValue() : _params[els[id]]; valEl.textContent = vv; valEl.dataset.value = vv; }
            if (el && el.type === 'range') {
                var v = parseFloat(el.value);
                var pct = ((v - parseFloat(el.min)) / (parseFloat(el.max) - parseFloat(el.min))) * 100;
                if (id === 'pb-size' || id === 'pb-smoothing') pct = Math.min(pct, 100);
                el.style.setProperty('--pct', pct + '%');
                var wrap = el.parentNode;
                if (wrap && wrap.classList && wrap.classList.contains('pb-slider-wrap')) {
                    wrap.style.setProperty('--pct', pct + '%');
                    wrap.dataset.value = v;
                }
            }
        }
        var shapeEl = document.getElementById('pb-shape');
        if (shapeEl) shapeEl.value = _params.shape;
        var blendEl = document.getElementById('pb-blend');
        if (blendEl) blendEl.value = _params.blendMode || 'normal';
        var dualEl = document.getElementById('pb-dualTip');
        if (dualEl) dualEl.value = _params.dualTip || 'none';
        var ttEl = document.getElementById('pb-taperTarget');
        if (ttEl) ttEl.value = _params.taperTarget || 'size';
        var tuEl = document.getElementById('pb-taperUnit');
        if (tuEl) tuEl.value = _params.taperUnit || 'brush';
        var cjEl = document.getElementById('pb-colorJitterPer');
        if (cjEl) cjEl.value = _params.colorJitterPer || 'dab';
        /* The name field follows the active brush. It used to be set only by
         * a tile click, so any other route to a preset left it naming a
         * brush the user was no longer on — and Save would have written to
         * that stale name. */
        var nameEl2 = document.getElementById('pb-preset-name');
        if (nameEl2 && document.activeElement !== nameEl2) {
            nameEl2.value = engine._currentPreset || '';
        }
        /* What an import dropped. Names are user files, so textContent only. */
        _syncNotesDiv();
        _syncManageButtons();
        // Per-parameter dynamics: one source dropdown and one floor slider each.
        var dynSrcs = document.querySelectorAll('[data-dyn-src]');
        for (var ds = 0; ds < dynSrcs.length; ds++) {
            var dk = dynSrcs[ds].getAttribute('data-dyn-src');
            dynSrcs[ds].value = _params[dk + 'Src'] || 'none';
        }
        var dynMins = document.querySelectorAll('[data-dyn-min]');
        for (var dm2 = 0; dm2 < dynMins.length; dm2++) {
            var mk = dynMins[dm2].getAttribute('data-dyn-min');
            var mv = _params[mk + 'Min'];
            if (mv == null) mv = 0;
            dynMins[dm2].value = mv;
            var mvEl = document.getElementById('pb-' + mk + '-min-val');
            if (mvEl) mvEl.textContent = mv;
            var mWrap = dynMins[dm2].parentNode;
            if (mWrap) mWrap.style.setProperty('--pct', mv + '%');
        }
        _updateDynamicsRows();
        _redrawCurves();
        var smodeBtns = document.querySelectorAll('.pb-smode-btn');
        var activeMode = _params.smoothingMode || 'none';
        smodeBtns.forEach(function(btn) { btn.classList.toggle('active', btn.dataset.mode === activeMode); });
        _updateSmoothingRow();
        var airbrushEl = document.getElementById('pb-airbrushMode');
        if (airbrushEl) airbrushEl.checked = !!_params.airbrushMode;
        // Update the active brush name label (replaces legacy pb-preset dropdown).
        var nameEl = document.getElementById('pb-active-name');
        if (nameEl) nameEl.textContent = engine._currentPreset || ((engine.presetNames && engine.presetNames[0]) || 'Round');
        engine.updateVisibleSettings();
        engine._toggleAirbrushUI();
        _updateBrushCursor();
        _updateRibbonSize();
    };

    engine._toggleAirbrushUI = function () {
        var rateRow = document.getElementById('pb-airbrushRate-row');
        if (rateRow) {
            rateRow.style.display = _params.airbrushMode ? 'flex' : 'none';
        }
    };

    engine.initUI = function () {
        /* Build the brush grid the first time the sidebar is actually on
         * screen. Building it eagerly fetched and decoded ~570kB of custom
         * tip PNGs and ran a full-resolution luminance-to-alpha pass over
         * each one during boot, for a panel that sits at left:-296px until
         * the Paint Brush tool is picked. Intersection is an exact proxy for
         * "the user can see this", and catches every way the panel opens
         * without the grid having to know about any of them. */
        var grid = document.getElementById("pb-brush-grid");
        if (grid) {
            var gridObserver = new IntersectionObserver(function (entries) {
                if (!entries[0].isIntersecting) return;
                gridObserver.disconnect();
                try { engine.buildBrushGrid(); } catch (eBuild_) {}
            });
            gridObserver.observe(grid);
        }

        // Wire the Advanced-section toggle (state persists in localStorage).
        var moreWrap = document.getElementById('pb-more-settings');
        var moreBtn  = document.getElementById('pb-more-toggle');
        if (moreWrap && moreBtn) {
            var COLLAPSE_KEY = 'pb-more-collapsed';
            var applyCollapse = function (collapsed) {
                if (collapsed) moreWrap.classList.add('pb-more-collapsed');
                else moreWrap.classList.remove('pb-more-collapsed');
                moreBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

            };
            try { applyCollapse(localStorage.getItem(COLLAPSE_KEY) === '1'); } catch (eStore_) {}
            moreBtn.addEventListener('click', function () {
                var wasCollapsed = moreWrap.classList.contains('pb-more-collapsed');
                applyCollapse(!wasCollapsed);
                try { localStorage.setItem(COLLAPSE_KEY, !wasCollapsed ? '1' : '0'); } catch (eWrite_) {}
            });
        }

        var sliderMap = {
            'pb-size': 'size',
            'pb-opacity': 'opacity',
            'pb-flow': 'flow',
            'pb-spacing': 'spacing',
            'pb-hardness': 'hardness',
            'pb-angle': 'angle',
            'pb-aspect': 'aspectRatio',
            'pb-colorRate': 'colorRate',
            'pb-smudgeLength': 'smudgeLength',
            'pb-smudgeRadius': 'smudgeRadius',
            'pb-tip2Depth': 'tip2Depth',
            'pb-tip2Size': 'tip2Size',
            'pb-tip2Spacing': 'tip2Spacing',
            'pb-tip2Angle': 'tip2Angle',
            'pb-dualScale': 'dualScale',
            'pb-dualDepth': 'dualDepth',
            'pb-airbrushRate': 'airbrushRate',
            'pb-bristleCount': 'bristleCount',
            'pb-bristleLength': 'bristleLength',
            'pb-bristleWidth': 'bristleWidth',
            'pb-bristleSpread': 'bristleSpread',
            'pb-scatter': 'scatter',
            'pb-hueJitter': 'hueJitter',
            'pb-satJitter': 'satJitter',
            'pb-valJitter': 'valJitter',
            'pb-dabCount': 'dabCount',
            'pb-offsetAlong': 'offsetAlong',
            'pb-offsetAcross': 'offsetAcross',
            'pb-fadeSteps': 'fadeSteps',
            'pb-distanceLength': 'distanceLength',
            'pb-taperStart': 'taperStart',
            'pb-taperEnd': 'taperEnd',
            'pb-texture': 'texture',
            'pb-textureScale': 'textureScale',
            'pb-edgeWidth': 'edgeWidth',
            'pb-edgeDensity': 'edgeDensity',
            'pb-smoothing': 'smoothingBasic',
        };
 
        for (var id in sliderMap) {
            if (!sliderMap.hasOwnProperty(id)) continue;
            (function (sliderId, paramKey) {
                var el = document.getElementById(sliderId);
                var valEl = document.getElementById(sliderId + '-val');
                if (!el) return;
                el.addEventListener('input', function () {
                    var wrap = this.parentNode;
                    var v;
                    if ((sliderId === 'pb-size' || sliderId === 'pb-smoothing') && wrap && wrap.dataset && wrap.dataset.overflowVal !== undefined) {
                        v = parseFloat(wrap.dataset.overflowVal);
                    } else {
                        v = parseFloat(this.value);
                    }
                    var min = parseFloat(this.min);
                    var max = parseFloat(this.max);
                    var pk = sliderId === 'pb-smoothing' ? _activeSmoothingKey() : paramKey;
                    if (pk) engine.setParam(pk, v);
                    if (valEl) { valEl.textContent = v; valEl.dataset.value = v; }
                    var pct = ((v - min) / (max - min)) * 100;
                    if (sliderId === 'pb-size' || sliderId === 'pb-smoothing') pct = Math.min(pct, 100);
                    this.style.setProperty('--pct', pct + '%');
                    if (wrap && wrap.classList && wrap.classList.contains('pb-slider-wrap')) {
                        wrap.style.setProperty('--pct', pct + '%');
                        wrap.dataset.value = v;
                    }
                });
                var wrapEl = el.parentNode;
                if (wrapEl && wrapEl.classList && wrapEl.classList.contains('pb-slider-wrap')) {
                    var setFromMouse = function (clientX) {
                        var rect = wrapEl.getBoundingClientRect();
                        var x = clientX - rect.left;
                        var pct;
                        if (sliderId === 'pb-size' || sliderId === 'pb-smoothing') {
                            pct = Math.max(0, x / rect.width);
                        } else {
                            pct = Math.max(0, Math.min(1, x / rect.width));
                        }
                        var min = parseFloat(el.min);
                        var max = parseFloat(el.max);
                        var step = parseFloat(el.step) || 1;
                        var v = Math.round((min + pct * (max - min)) / step) * step;
                        if (sliderId === 'pb-size' || sliderId === 'pb-smoothing') {
                            wrapEl.dataset.overflowVal = v;
                            el.value = Math.min(v, max);
                        } else {
                            v = Math.min(max, Math.max(min, v));
                            el.value = v;
                        }
                        var ev = new Event('input', { bubbles: true });
                        el.dispatchEvent(ev);
                    };
                    var dragging = false;
                    wrapEl.addEventListener('mousedown', function (e) {
                        e.preventDefault();
                        dragging = true;
                        setFromMouse(e.clientX);
                        var onMove = function (me) {
                            if (!dragging) return;
                            me.preventDefault();
                            setFromMouse(me.clientX);
                        };
                        var onUp = function () {
                            dragging = false;
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                        };
                        document.addEventListener('mousemove', onMove);
                        document.addEventListener('mouseup', onUp);
                    });
                }
            })(id, sliderMap[id]);
        }

        var SETTING_DESCRIPTIONS = {
            size: 'Brush diameter in pixels',
            opacity: 'Maximum opacity of each dab',
            flow: 'Rate at which paint is applied along the stroke',
            spacing: 'Distance between consecutive dabs, as percentage of brush width',
            hardness: 'Edge softness of the brush tip',
            shape: 'Tip shape: circle, square, diamond, line, slash, or custom image',
            angle: 'Rotation angle of the brush tip in degrees',
            dynamicsMode: 'How brush responds to stroke direction or pen pressure',
            aspectRatio: 'Width-to-height ratio of the brush tip',
            colorRate: 'Rate at which the brush picks up color from the canvas (smudge)',
            smudgeLength: 'How far picked-up color travels before the brush lets go of it',
            smudgeRadius: 'How wide a patch the brush picks color up from',
            dualTip: 'A surface under the paint - paper tooth, canvas weave. It stays put on the canvas instead of travelling with the stroke',
            tip2Depth: 'How deeply a second tip bites into the first, breaking up a solid stamp',
            tip2Size: 'How big the second tip is against the dab it carves',
            tip2Spacing: 'How far apart the second tip repeats across the dab',
            tip2Angle: 'Turn the second tip against the first',
            dualScale: 'How coarse that surface is',
            dualDepth: 'How much paint the surface holds back',
            airbrushMode: 'Keep painting while holding the brush still',
            airbrushRate: 'Paint flow rate when airbrush mode is active',
            bristleCount: 'Number of individual bristle splits',
            bristleLength: 'Length of each bristle',
            bristleWidth: 'How thick each bristle is next to the gap between them: at 3 they just touch, below that the brush skips and shows paper, above that they merge into a loaded stroke',
            bristleSpread: 'Angular spread of bristles from center',
            scatter: 'Random offset of each dab from the stroke path',
            taperStart: 'How long the stroke takes to reach full strength',
            taperEnd: 'How long the stroke takes to lift off at the end',
            taperTarget: 'Whether the taper thins the line, fades it, or both',
            hueJitter: 'How far the colour may wander around the wheel',
            satJitter: 'How far the colour may wander in strength',
            valJitter: 'How far the colour may wander in brightness',
            colorJitterPer: 'Whether the colour wanders every dab or once a stroke',
            taperUnit: 'Measure the taper against the brush size, or as a share of the whole stroke',
            dabCount: 'How many dabs land at every stop along the stroke',
            offsetAlong: 'Move each dab forward or back along the line it is drawing',
            offsetAcross: 'Move each dab to one side of the line it is drawing',
            fadeSteps: 'How many dabs a Fade sensor takes to run from full to nothing',
            distanceLength: 'How far along the stroke a Distance sensor takes to reach full',
            texture: 'Opacity of paper texture grain overlaid on the stroke',
            textureScale: 'Scale of the paper texture pattern',
            edgeWidth: 'Width of the dark watercolor edge at the ink boundary (0 = off)',
            edgeDensity: 'Strength of the watercolor edge darkening',
            smoothing: 'Strength of the smoothing effect (interpretation varies by mode)',
            smoothingMode: 'Smoothing algorithm: Basic (EMA), Weighted (Gaussian), Rope (dead-zone), Stabiliser (delayed cursor)'
        };
        var rows = document.querySelectorAll('.pb-row[data-setting]');
        for (var ri = 0; ri < rows.length; ri++) {
            var key = rows[ri].dataset.setting;
            var desc = SETTING_DESCRIPTIONS[key];
            if (desc) rows[ri].title = desc;
        }

        var shapeEl = document.getElementById('pb-shape');
        if (shapeEl) {
            shapeEl.addEventListener('change', function () {
                engine.setParam('shape', this.value);
            });
        }

        var blendEl = document.getElementById('pb-blend');
        if (blendEl) {
            blendEl.addEventListener('change', function () {
                engine.setParam('blendMode', this.value);
            });
        }

        var dualEl = document.getElementById('pb-dualTip');
        if (dualEl) {
            dualEl.addEventListener('change', function () {
                engine.setParam('dualTip', this.value);
            });
        }

        ['taperTarget', 'taperUnit', 'colorJitterPer'].forEach(function (key) {
            var el = document.getElementById('pb-' + key);
            if (!el) return;
            el.addEventListener('change', function () {
                engine.setParam(key, this.value);
            });
        });

        var dynSrcEls = document.querySelectorAll('[data-dyn-src]');
        for (var dsi = 0; dsi < dynSrcEls.length; dsi++) {
            (function (el) {
                el.addEventListener('change', function () {
                    engine.setParam(el.getAttribute('data-dyn-src') + 'Src', this.value);
                    _updateDynamicsRows();
                });
            })(dynSrcEls[dsi]);
        }
        var dynMinEls = document.querySelectorAll('[data-dyn-min]');
        for (var dmi = 0; dmi < dynMinEls.length; dmi++) {
            (function (el) {
                el.addEventListener('input', function () {
                    var v = parseFloat(this.value);
                    engine.setParam(el.getAttribute('data-dyn-min') + 'Min', v);
                    var lbl = document.getElementById('pb-' + el.getAttribute('data-dyn-min') + '-min-val');
                    if (lbl) lbl.textContent = v;
                    if (this.parentNode) this.parentNode.style.setProperty('--pct', v + '%');
                });
            })(dynMinEls[dmi]);
        }

        var airbrushEl = document.getElementById('pb-airbrushMode');
        if (airbrushEl) {
            airbrushEl.addEventListener('change', function () {
                engine.setParam('airbrushMode', this.checked);
                engine._toggleAirbrushUI();
            });
        }

        var smodeContainer = document.querySelector('.pb-smode-btns');
        if (smodeContainer) {
            smodeContainer.addEventListener('click', function (e) {
                var btn = e.target.closest('.pb-smode-btn');
                if (!btn) return;
                var mode = btn.dataset.mode;
                var prevMode = getParams().smoothingMode || 'none';
                if (mode === prevMode) {
                    engine.setParam('smoothingMode', 'none');
                } else {
                    var prevKey = _activeSmoothingKey();
                    if (prevKey) {
                        var el = document.getElementById('pb-smoothing');
                        if (el) engine.setParam(prevKey, parseFloat(el.parentNode && el.parentNode.dataset.overflowVal !== undefined ? el.parentNode.dataset.overflowVal : el.value));
                    }
                    engine.setParam('smoothingMode', mode);
                }
                document.querySelectorAll('.pb-smode-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === getParams().smoothingMode); });
                _updateSmoothingRow();
            });
        }

        var collapseBtn = document.getElementById('paintbrush-collapse-btn');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', function () {
                var sb = document.getElementById('paintbrush-sidebar');
                if (sb) {
                    sb.classList.remove('open');
                }
                var reopen = document.getElementById('pb-reopen-btn');
                if (reopen) reopen.classList.add('show');
                if (typeof PaintApp._updateSidebarViewportShift === 'function') {
                    PaintApp._updateSidebarViewportShift(true);
                }
            });
        }

        var pbReopenBtn = document.getElementById('pb-reopen-btn');
        if (pbReopenBtn) {
            pbReopenBtn.addEventListener('click', function () {
                var sb = document.getElementById('paintbrush-sidebar');
                if (sb) {
                    sb.classList.add('open');
                }
                pbReopenBtn.classList.remove('show');
                if (typeof PaintApp._updateSidebarViewportShift === 'function') {
                    PaintApp._updateSidebarViewportShift(true);
                }
            });
        }

        var pbCloseBtn = document.getElementById('paintbrush-close-btn');
        if (pbCloseBtn) {
            pbCloseBtn.addEventListener('click', function () {
                if (typeof PaintApp.setTool === 'function') PaintApp.setTool('pencil');
            });
        }

        var resetBtn = document.getElementById('pb-reset-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', function () {
                engine.resetCurrentPreset();
            });
        }

        // Load last-saved params for the active preset so customizations persist.
        _initCurves();
        _loadUserPresets();
        _bindLibraryBar();
        var nameIn0 = document.getElementById('pb-preset-name');
        if (nameIn0) nameIn0.value = engine._currentPreset;
        engine.loadPreset(engine._currentPreset);
        engine.syncPanel();
        _updateBrushCursor();
    };


    /* ------------------------------------------------------------------ */
    /*  Dual tip                                                           */
    /* ------------------------------------------------------------------ */

    /* A second tip that does not paint — it decides where the first one is
     * allowed to. Paper tooth, canvas weave, the grain of a chalk: the
     * surface the paint is sitting on.
     *
     * It is stamped on the FINISHED stroke, at flush time, for the same
     * reason blend modes are: applied per dab it would multiply itself
     * wherever dabs overlap, so a slow stroke would come out darker-grained
     * than a fast one over the same ground. Once per flush it also costs one
     * fill instead of one per dab, and there are no per-dab allocations at
     * all — the tiles and their patterns are built once and cached.
     *
     * And because the flow buffer is already in document coordinates, the
     * grain is anchored to the CANVAS for free: no offset to compute, no
     * fractional phase to resample, and the same pixel gets the same grain
     * no matter which direction the stroke crossed it. Anchored to the dab
     * instead it swims along with the brush and reads as a screen door
     * dragged over the paper — which is what the existing per-dab texture
     * still does, and why this is a separate control rather than a flag on
     * that one. */
    var _dualTiles = {};
    var DUAL_SCALE_MAX = 12;

    function _dualKey(type, scale, depth) {
        // Depth in steps of 5: finer than the eye and it bounds the cache.
        return type + '|' + scale + '|' + (_round(depth / 5) * 5);
    }

    function _dualTile(type, scale, depth) {
        var key = _dualKey(type, scale, depth);
        var hit = _dualTiles[key];
        if (hit) return hit;

        var src = _texTile(type);
        var N = src.width;
        var sctx = src.getContext('2d');
        var sd = sctx.getImageData(0, 0, N, N).data;

        var mag = _clamp(_round(scale), 1, DUAL_SCALE_MAX);
        var T = N * mag;
        var out = new OffscreenCanvas(T, T);
        var octx = out.getContext('2d');
        var img = octx.createImageData(T, T);
        var d = img.data;
        var k = _clamp(depth, 0, 100) / 100;

        /* Grey becomes alpha: a dark spot in the grain lets less paint
         * through, and depth says how far the darkest spot can close.
         *
         * The range is stretched first. The tiles were drawn to be looked at,
         * so a weave sits between 180 and 255 while chalk uses the whole
         * scale — taken literally, the same Bite setting would be barely
         * visible on one surface and brutal on the next. Stretched, Bite
         * means the same thing whichever surface is picked. */
        var lo = 255, hi = 0;
        for (var q = 0; q < sd.length; q += 4) {
            if (sd[q] < lo) lo = sd[q];
            if (sd[q] > hi) hi = sd[q];
        }
        var span = _max(1, hi - lo);
        var lut = new Uint8Array(256);
        for (var g = 0; g < 256; g++) {
            var t = _clamp((g - lo) / span, 0, 1);
            lut[g] = 255 - k * 255 * (1 - t) | 0;
        }

        for (var y = 0; y < T; y++) {
            var sy = (y / mag) | 0;
            var srow = sy * N;
            var drow = y * T;
            for (var x = 0; x < T; x++) {
                var si = (srow + ((x / mag) | 0)) * 4;
                var di = (drow + x) * 4;
                d[di] = 0; d[di + 1] = 0; d[di + 2] = 0;
                d[di + 3] = lut[sd[si]];
            }
        }
        octx.putImageData(img, 0, 0);

        var rec = { canvas: out, pattern: octx.createPattern(out, 'repeat') };
        _dualTiles[key] = rec;
        return rec;
    }

    function _hasDualTip(p) {
        return !!(p.dualTip && p.dualTip !== 'none' && p.dualDepth > 0
                  && _TEX_TYPES.indexOf(p.dualTip) !== -1);
    }

    /* ------------------------------------------------------------------ */
    /*  Saved brushes                                                      */
    /* ------------------------------------------------------------------ */

    /* Built-ins live in code and are never written to. A saved brush is a
     * FULL snapshot of the live parameters, not a diff against the brush it
     * came from: a diff silently changes under the user whenever a built-in
     * is retuned, which is exactly what happened to all nine bristle presets
     * when bristleSpread changed meaning.
     *
     * Saved brushes are merged into engine.PRESETS on load, so loadPreset,
     * the swatch renderer and the grid need to know nothing about them. */
    var USER_KEY = 'pb-user-presets';
    var FAV_KEY  = 'pb-favs';
    var NAME_MAX = 40;
    /* localStorage is about 5MB for the whole app. A tip carried as a data:
     * URL can eat that on its own, so it is capped and refused loudly rather
     * than blowing the quota and taking the user's other brushes with it.
     * Sixteen megabytes, because a tip is now stored at its own resolution
     * -- up to 2326 across -- and a strip holds several shapes at that size.
     * It is a ceiling against a corrupt or absurd file, not a budget: tips
     * live in IndexedDB, and only the presets themselves are in the 5MB of
     * localStorage the whole application shares. */
    var TIP_CAP = 16 * 1024 * 1024;

    /* ---- where a tip image actually lives -------------------------------
     *
     * Tips used to be data: URLs inside the preset record, which is inside
     * localStorage, which is about 5MB for the whole application. That is
     * why every imported tip was squashed to 200 pixels -- and 200 pixels is
     * exactly where the grain of a chalk or a drip brush lives, so every
     * Photoshop brush we read came out smooth. Real ones are authored at
     * 1000 to 2300.
     *
     * The picture goes to IndexedDB, which is budgeted in hundreds of
     * megabytes, and the preset keeps `idb:<key>` instead. The key is a hash
     * of the picture, so a pack whose fifty brushes share one tip stores it
     * once. Everything else in a preset stays in localStorage, where it is
     * small, synchronous and easy to export.
     *
     * ponytail: nothing deletes a stashed tip when the last preset using it
     * goes. Sweep on load against the presets' keys if that ever matters. */
    /* The biggest dab the engine paints, and the ceiling an imported brush
     * is clamped to. It is the size slider's own maximum; Photoshop packs are
     * authored well above it. */
    var MAX_SIZE = 1000;
    var TIP_DB = 'cdpaint-tips', TIP_STORE = 'tips';
    var _tipMem = {};          // key -> data URL, for this session
    var _tipDbP = null;

    function _tipDb() {
        if (_tipDbP) return _tipDbP;
        _tipDbP = new Promise(function (ok) {
            var idb = window.indexedDB;
            if (!idb) { ok(null); return; }
            var rq;
            try { rq = idb.open(TIP_DB, 1); } catch (e_) { ok(null); return; }
            rq.onupgradeneeded = function () {
                if (!rq.result.objectStoreNames.contains(TIP_STORE)) {
                    rq.result.createObjectStore(TIP_STORE);
                }
            };
            rq.onsuccess = function () { ok(rq.result); };
            rq.onerror = function () { ok(null); };
        });
        return _tipDbP;
    }

    /* Two hashes and the length. One hash on its own collides often enough
     * to matter when a collision means painting with somebody else's tip. */
    function _tipHash(url) {
        var a = 5381, b = 0;
        for (var i = 0; i < url.length; i++) {
            var c = url.charCodeAt(i);
            a = ((a * 33) ^ c) >>> 0;
            b = (c + (b << 6) + (b << 16) - b) >>> 0;
        }
        return url.length.toString(36) + '-' + a.toString(36) + '-' + b.toString(36);
    }

    /* Returns the reference to store, at once. The write happens behind it:
     * the picture is in memory for this session either way, so a failed
     * write costs the tip on the NEXT run and never the current one. */
    function _tipStash(url) {
        if (!url || url.slice(0, 5) !== 'data:') return url || '';
        var key = _tipHash(url);
        _tipMem[key] = url;
        _tipDb().then(function (db) {
            if (!db) return;
            try {
                var tx = db.transaction(TIP_STORE, 'readwrite');
                tx.objectStore(TIP_STORE).put(url, key);
            } catch (e_) {}
        });
        return 'idb:' + key;
    }

    function _tipResolve(url, cb) {
        if (!url || url.slice(0, 4) !== 'idb:') { cb(url); return; }
        var key = url.slice(4);
        if (_tipMem[key]) { cb(_tipMem[key]); return; }
        _tipDb().then(function (db) {
            if (!db) { cb(null); return; }
            var rq;
            try {
                rq = db.transaction(TIP_STORE, 'readonly').objectStore(TIP_STORE).get(key);
            } catch (e_) { cb(null); return; }
            rq.onsuccess = function () {
                if (rq.result) _tipMem[key] = rq.result;
                cb(rq.result || null);
            };
            rq.onerror = function () { cb(null); };
        });
    }
    engine._tipCacheBytes = function () { return _tipCacheBytes; };
    engine._tipStash = _tipStash;
    engine._tipResolve = _tipResolve;
    /* A preset's `_tipUrl` is a reference, not a picture. Anything that wants
     * the picture -- a test, an exporter, anything drawing outside the engine
     * -- goes through here. */
    engine.tipUrl = function (url) {
        return new Promise(function (ok) { _tipResolve(url, ok); });
    };

    function _readStore(key, dflt) {
        try {
            var raw = localStorage.getItem(key);
            var v = raw ? JSON.parse(raw) : null;
            return (v && typeof v === 'object') ? v : dflt;
        } catch (e_) { return dflt; }
    }
    function _writeStore(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); return true; }
        catch (e_) { return false; }
    }

    var _userPresets = {};
    var _favs = {};
    /* What an import had to drop per brush ("dropped: watercolour edges").
     * A separate key, deliberately never inside the params record:
     * _installUserPreset copies every record key into the live preset, so a
     * warnings array would ride into _params and through the stroke freeze. */
    var NOTES_KEY = 'pb-preset-notes';
    var _presetNotes = {};
    function _storeImportNotes(notes) {
        var any = false;
        (notes || []).forEach(function (k) {
            if (k.warnings && k.warnings.length) { _presetNotes[k.name] = k.warnings.slice(); any = true; }
        });
        if (any) _writeStore(NOTES_KEY, _presetNotes);
    }
    function _dropPresetNotes(name) {
        if (_presetNotes[name]) { delete _presetNotes[name]; _writeStore(NOTES_KEY, _presetNotes); }
    }
    /* The panel line naming what an import dropped for the current brush.
     * Its own helper so a bare engine.loadPreset keeps it fresh without
     * dragging all of syncPanel along; names are user files, textContent only. */
    function _syncNotesDiv() {
        var notesEl = document.getElementById('pb-preset-notes');
        if (!notesEl) return;
        var pn = _presetNotes[engine._currentPreset];
        if (pn && pn.length) {
            notesEl.textContent = 'Changed to fit: ' + pn.join('; ');
            notesEl.hidden = false;
        } else {
            notesEl.textContent = '';
            notesEl.hidden = true;
        }
    }

    function _isUserPreset(name) {
        return !!(engine.PRESETS[name] && engine.PRESETS[name]._user);
    }

    /* Names arrive from a text field. They become storage keys and DOM text,
     * so they are cleaned here and rendered with textContent everywhere —
     * never innerHTML. */
    function _cleanName(raw) {
        var n = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
        if (!n) return null;
        return n.length > NAME_MAX ? n.slice(0, NAME_MAX) : n;
    }

    function _snapshotParams() {
        var snap = {};
        for (var i = 0; i < _paramMeta.length; i++) {
            var k = _paramMeta[i];
            snap[k] = _isArray(_params[k]) ? _cloneCurve(_params[k]) : _params[k];
        }
        return snap;
    }

    function _installUserPreset(name, rec) {
        var pr = {};
        for (var k in rec) {
            if (rec.hasOwnProperty(k)) pr[k] = _isArray(rec[k]) ? _cloneCurve(rec[k]) : rec[k];
        }
        pr._user = true;
        engine.PRESETS[name] = pr;
    }

    function _loadUserPresets() {
        _userPresets = _readStore(USER_KEY, {});
        _presetNotes = _readStore(NOTES_KEY, {});
        _favs = _readStore(FAV_KEY, {});
        /* Brushes saved before tips moved out carry the picture itself. Move
         * it on first sight: the record shrinks to a key, which is most of
         * what was filling localStorage, and nothing about the brush changes. */
        var moved = false;
        for (var mn in _userPresets) {
            if (!_userPresets.hasOwnProperty(mn)) continue;
            var mr = _userPresets[mn];
            if (!mr || typeof mr !== 'object') continue;
            if (typeof mr._tipUrl === 'string' && mr._tipUrl.slice(0, 5) === 'data:') {
                mr._tipUrl = _tipStash(mr._tipUrl); moved = true;
            }
            if (typeof mr._tip2Url === 'string' && mr._tip2Url.slice(0, 5) === 'data:') {
                mr._tip2Url = _tipStash(mr._tip2Url); moved = true;
            }
        }
        if (moved) _commitUsers();
        for (var n in _userPresets) {
            if (!_userPresets.hasOwnProperty(n)) continue;
            // A built-in of the same name always wins: a saved brush must
            // never be able to shadow one and make it unreachable.
            if (engine.PRESETS[n] && !engine.PRESETS[n]._user) { delete _userPresets[n]; continue; }
            _installUserPreset(n, _userPresets[n]);
        }
        _rebuildNames();
    }

    function _commitUsers() {
        if (_writeStore(USER_KEY, _userPresets)) return null;
        return 'Out of browser storage. Delete a saved brush and try again.';
    }

    engine.isUserPreset = _isUserPreset;
    engine.userPresetNames = function () { return Object.keys(_userPresets); };

    engine.saveUserPreset = function (rawName) {
        var name = _cleanName(rawName);
        if (!name) return { ok: false, error: 'Give the brush a name.' };
        if (engine.PRESETS[name] && !_isUserPreset(name)) {
            return { ok: false, error: '"' + name + '" is a built-in brush. Pick another name.' };
        }
        var snap = _snapshotParams();
        var src = engine.PRESETS[engine._currentPreset];
        var tip = src && src._tipUrl;
        if (tip) {
            if (tip.length > TIP_CAP) {
                return { ok: false, error: 'That brush tip is too big to save (' +
                    _round(tip.length / 1024) + 'KB, limit ' + _round(TIP_CAP / 1024) + 'KB).' };
            }
            snap._tipUrl = _tipStash(tip);
        }
        /* The second tip travels with the first. It is not size-checked the
         * way the first is: a brush whose main tip fits and whose carving tip
         * does not is better saved without the carve than refused outright. */
        if (src && src._tip2Url && src._tip2Url.length <= TIP_CAP) snap._tip2Url = _tipStash(src._tip2Url);
        var had = _userPresets[name];
        _userPresets[name] = snap;
        var err = _commitUsers();
        if (err) {
            if (had) _userPresets[name] = had; else delete _userPresets[name];
            return { ok: false, error: err };
        }
        _installUserPreset(name, snap);
        _rebuildNames();
        _invalidateSwatch(name);
        engine.loadPreset(name);
        /* Saved means owned: whatever an import dropped is baked into the
         * brush the user just approved, so the note has served its purpose. */
        _dropPresetNotes(name);
        _syncNotesDiv();
        return { ok: true, name: name, replaced: !!had };
    };

    engine.duplicatePreset = function (from, rawName) {
        var src = engine.PRESETS[from];
        if (!src) return { ok: false, error: 'No brush called "' + from + '".' };
        var name = _cleanName(rawName) || _uniqueName(from + ' copy');
        if (engine.PRESETS[name] && !_isUserPreset(name)) {
            return { ok: false, error: '"' + name + '" is a built-in brush. Pick another name.' };
        }
        // Snapshot the brush AS IT PAINTS — its own saved tweaks included,
        // which is what the user sees on the tile and expects to copy.
        var keep = engine._currentPreset;
        engine.loadPreset(from);
        var snap = _snapshotParams();
        if (src._tipUrl && src._tipUrl.length <= TIP_CAP) snap._tipUrl = _tipStash(src._tipUrl);
        if (src._tip2Url && src._tip2Url.length <= TIP_CAP) snap._tip2Url = _tipStash(src._tip2Url);
        if (keep !== from) engine.loadPreset(keep);
        _userPresets[name] = snap;
        var err = _commitUsers();
        if (err) { delete _userPresets[name]; return { ok: false, error: err }; }
        if (_presetNotes[from]) { _presetNotes[name] = _presetNotes[from].slice(); _writeStore(NOTES_KEY, _presetNotes); }
        _installUserPreset(name, snap);
        _rebuildNames();
        _invalidateSwatch(name);
        return { ok: true, name: name };
    };

    function _uniqueName(base) {
        var n = _cleanName(base) || 'Brush';
        if (!engine.PRESETS[n]) return n;
        for (var i = 2; i < 999; i++) {
            var c = _cleanName(n + ' ' + i);
            if (!engine.PRESETS[c]) return c;
        }
        return n + ' ' + Date.now();
    }

    engine.renameUserPreset = function (from, rawName) {
        if (!_isUserPreset(from)) {
            return { ok: false, error: 'Built-in brushes cannot be renamed. Duplicate it first.' };
        }
        var name = _cleanName(rawName);
        if (!name) return { ok: false, error: 'Give the brush a name.' };
        if (name === from) return { ok: true, name: name };
        if (engine.PRESETS[name]) return { ok: false, error: '"' + name + '" is already taken.' };
        _userPresets[name] = _userPresets[from];
        delete _userPresets[from];
        var err = _commitUsers();
        if (err) {
            _userPresets[from] = _userPresets[name];
            delete _userPresets[name];
            return { ok: false, error: err };
        }
        _installUserPreset(name, _userPresets[name]);
        delete engine.PRESETS[from];
        // Any tweaks the user made after saving live under the old key.
        try {
            var carried = _readSaved(from);
            if (carried) localStorage.setItem(STORAGE_PREFIX + name, carried);
            localStorage.removeItem(STORAGE_PREFIX + from);
        } catch (e_) {}
        if (_favs[from]) { delete _favs[from]; _favs[name] = 1; _writeStore(FAV_KEY, _favs); }
        if (_presetNotes[from]) { _presetNotes[name] = _presetNotes[from]; delete _presetNotes[from]; _writeStore(NOTES_KEY, _presetNotes); }
        _rebuildNames();
        _invalidateSwatch(from);
        _invalidateSwatch(name);
        if (engine._currentPreset === from) engine.loadPreset(name);
        return { ok: true, name: name };
    };

    engine.deleteUserPreset = function (name) {
        if (!_isUserPreset(name)) {
            return { ok: false, error: 'Built-in brushes cannot be deleted.' };
        }
        delete _userPresets[name];
        delete engine.PRESETS[name];
        _commitUsers();
        if (_favs[name]) { delete _favs[name]; _writeStore(FAV_KEY, _favs); }
        _dropPresetNotes(name);
        _forgetSaved(name);
        _rebuildNames();
        _invalidateSwatch(name);
        if (engine._currentPreset === name) engine.loadPreset(engine.presetNames[0] || 'Round');
        return { ok: true };
    };

    engine.isFavourite = function (name) { return !!_favs[name]; };
    engine.toggleFavourite = function (name) {
        if (!engine.PRESETS[name]) return false;
        if (_favs[name]) delete _favs[name]; else _favs[name] = 1;
        _writeStore(FAV_KEY, _favs);
        return !!_favs[name];
    };

    /* Export/import is what makes a saved library survive clearing the
     * browser's site data, which otherwise takes every brush with it. */
    /* An export leaves this machine, so it carries the pictures themselves
     * rather than the keys they happen to be filed under here. That makes it
     * a promise; the tips live in IndexedDB now. */
    engine.exportUserPresets = function () {
        var out = {}, jobs = [];
        Object.keys(_userPresets).forEach(function (n) {
            var src = _userPresets[n], rec = {};
            for (var k in src) { if (src.hasOwnProperty(k)) rec[k] = src[k]; }
            out[n] = rec;
            ['_tipUrl', '_tip2Url', 'texturePattern'].forEach(function (tk) {
                if (typeof rec[tk] !== 'string' || rec[tk].slice(0, 4) !== 'idb:') return;
                jobs.push(new Promise(function (ok) {
                    _tipResolve(rec[tk], function (u) {
                        if (u) rec[tk] = u; else delete rec[tk];
                        ok();
                    });
                }));
            });
        });
        return Promise.all(jobs).then(function () {
            return JSON.stringify({
                format: 'cdpaint-brushes', version: 1,
                presets: out, favourites: Object.keys(_favs)
            }, null, 1);
        });
    };

    engine.importUserPresets = function (json) {
        var data;
        try { data = typeof json === 'string' ? JSON.parse(json) : json; }
        catch (e_) { return { ok: false, error: 'That file is not readable brush data.' }; }
        if (!data || data.format !== 'cdpaint-brushes' || !data.presets ||
            typeof data.presets !== 'object') {
            return { ok: false, error: 'That file is not a CDPaint brush library.' };
        }
        var added = [], renamed = [];
        for (var raw in data.presets) {
            if (!data.presets.hasOwnProperty(raw)) continue;
            var rec = data.presets[raw];
            if (!rec || typeof rec !== 'object') continue;
            if (rec._tipUrl && String(rec._tipUrl).length > TIP_CAP) delete rec._tipUrl;
            else if (rec._tipUrl) rec._tipUrl = _tipStash(String(rec._tipUrl));
            if (rec._tip2Url && String(rec._tip2Url).length > TIP_CAP) delete rec._tip2Url;
            else if (rec._tip2Url) rec._tip2Url = _tipStash(String(rec._tip2Url));
            if (rec.texturePattern && String(rec.texturePattern).slice(0, 5) === 'data:') rec.texturePattern = _tipStash(String(rec.texturePattern));
            var want = _cleanName(raw);
            if (!want) continue;
            // Never overwrite what is already there — an import that quietly
            // replaced a brush the user had tuned would be unrecoverable.
            var name = engine.PRESETS[want] ? _uniqueName(want) : want;
            if (name !== want) renamed.push(want + ' \u2192 ' + name);
            _userPresets[name] = rec;
            _installUserPreset(name, rec);
            added.push(name);
        }
        var err = _commitUsers();
        if (err) return { ok: false, error: err };
        if (_isArray(data.favourites)) {
            for (var i = 0; i < data.favourites.length; i++) {
                var f = _cleanName(data.favourites[i]);
                if (f && engine.PRESETS[f]) _favs[f] = 1;
            }
            _writeStore(FAV_KEY, _favs);
        }
        _rebuildNames();
        _invalidateSwatch();
        return { ok: true, added: added, renamed: renamed };
    };

    /* Installing a brush pack made for another program.
     *
     * brush-pack.js does the reading and the arithmetic and never touches
     * the engine; this is the other side of that line. It takes what came
     * back, stores each brush the same way a brush the user saved is stored,
     * and reports what it could not keep rather than painting a near miss
     * and saying nothing.
     *
     * ponytail: a tip shared by several brushes in one pack is stored once
     * per brush. Worth a shared tip store if a pack ever fills the 5MB. */
    function _packName(raw) {
        /* Pack authors bracket the brush's real name: a sorting prefix in
         * front -- "c6) Thin Brush Pointy" -- and their own signature and
         * version behind it -- "- deevad 23.01". Both are shelf-tidying for
         * a list we group our own way, and on a 66px tile they crowd out the
         * part that says what the brush is. The name between them stays. */
        return _cleanName(String(raw || '')
            .replace(/^\s*\w{1,3}\)\s*/, '')
            .replace(/\s+-\s+[^-]*\d[^-]*$/, '')) || null;
    }

    /* A pack's pattern bytes as something an <img> will take. Patterns are
     * small next to the tips and there is one per brush at most, so they go
     * straight into the preset the way a tip does. */
    function _bytesToPngUrl(u8) {
        var s = '';
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return 'data:image/png;base64,' + btoa(s);
    }

    /* A pack may name a tip it does not carry.
     *
     * Krita ships a default resources bundle, and a pack built on top of it
     * refers to those tips by name alone -- seven of the eighteen brushes in
     * Krita's own Extras pack do. Those same files are where most of the
     * tips in src/brushes came from, so when the name matches one we already
     * have, use ours: the alternative is skipping a brush over a file that
     * is sitting right there.
     *
     * Exact name only. A near match would be a different picture wearing the
     * right name, which is worse than an honest skip, and the import says
     * what it did either way.
     *
     * The list is read off the shipped presets rather than kept by hand, so
     * it cannot drift from what is actually in the folder. */
    var _shippedTips = null;

    function _shippedTipIndex() {
        if (_shippedTips) return _shippedTips;
        _shippedTips = {};
        for (var n in engine.PRESETS) {
            if (!engine.PRESETS.hasOwnProperty(n)) continue;
            var u = engine.PRESETS[n]._tipUrl;
            if (typeof u !== 'string' || u.indexOf('brushes/') !== 0) continue;
            _shippedTips[u.slice(8).toLowerCase()] = u;
        }
        return _shippedTips;
    }

    function _shippedTip(file) {
        var url = _shippedTipIndex()[String(file).toLowerCase()];
        if (!url) return Promise.resolve(null);
        return new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
                resolve({ url: url, size: _max(img.width, img.height),
                          cells: 1, pick: 'random', shipped: true });
            };
            img.onerror = function () { resolve(null); };
            img.src = url;
        });
    }

    /* ...and failing that, Krita's own copy. A pack leans on Krita's default
     * bundles (both CC-0) for tips and papers it names but does not carry:
     * Deevad 2021's rakes on bristles_chisel_dense.png, the Muses pack on
     * eleven Krita 3 tips. Krita paints them because every Krita has them;
     * src/brushes/krita holds, as Krita ships them, the ones real packs ask
     * for. Fetched by name when asked, so the folder is the list; anything
     * but a plain file name resolves null. */
    var _kritaDefaults = {};
    function _kritaDefault(file) {
        var f = String(file || '');
        if (!/^[\w .()-]+\.(png|gbr|gih|svg)$/i.test(f)) return Promise.resolve(null);
        return _kritaDefaults[f] || (_kritaDefaults[f] = fetch('brushes/krita/' + encodeURIComponent(f))
            .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
            .then(function (b) { return b && new Uint8Array(b); }, function () { return null; }));
    }

    /* A Procreate brush or brush set.
     *
     * Its shape and its grain are real images, which is most of what makes
     * one recognisable, so those come across exactly. The settings beside
     * them are a smaller, differently-shaped set than Krita's -- Procreate
     * has no absolute brush diameter at all, because size there is a slider
     * the artist moves per stroke -- so the tip's own pixels set the size
     * and the notes say what did not come across. */
    /* What is inside a pack, without installing any of it.
     *
     * A pack can hold forty brushes and a user usually wants a few, so the
     * Import button asks first. Reading the pack twice -- once to list, once
     * to install what was ticked -- costs a few milliseconds and keeps this
     * function free of side effects, which is what makes it safe to call on
     * a file the user has not agreed to yet.
     *
     * The icon is the author's own picture of the brush, out of the preset
     * itself. It is a painted illustration rather than a render, so it says
     * what the brush is FOR, which is exactly what someone is deciding.
     */
    engine.packSummary = function (bytes, filename) {
        if (!window.BrushPack) {
            return Promise.resolve({ ok: false, error: 'The brush pack reader is not loaded.' });
        }
        var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        var n = String(filename || '');

        if (/\.(brush|brushset)$/i.test(n)) {
            return BrushPack.readProcreate(u8).then(function (pack) {
                return {
                    ok: true, kind: 'procreate',
                    brushes: pack.presets.map(function (pr) {
                        return { name: pr.name, icon: null };
                    })
                };
            }, function (e) {
                return { ok: false, error: (e && e.message) || 'That file could not be read.' };
            });
        }

        return BrushPack.read(u8).then(function (pack) {
            return {
                ok: true, kind: pack.kind,
                brushes: pack.presets.map(function (pr) {
                    var icon = pr.thumbnail || (pack.kind === 'kpp' ? u8 : null);
                    return {
                        name: pr.name,
                        icon: icon ? _bytesToPngUrl(icon) : null
                    };
                })
            };
        }, function (e) {
            return { ok: false, error: (e && e.message) || 'That file could not be read.' };
        });
    };

    /* A Clip Studio sub tool.
     *
     * One file is one brush, so there is nothing to pick from and no
     * chooser -- a sub tool holds exactly one, in every one of the 154 real
     * files this was checked against. The pictures come out of the file's
     * own material table: however many tip pictures the brush names become
     * a strip, the paper texture and the second tip one each. */
    engine.importSutPack = function (bytes, filename) {
        if (!window.BrushPack) {
            return Promise.resolve({ ok: false, error: 'The brush pack reader is not loaded.' });
        }
        var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        var pack;
        try {
            pack = BrushPack.readSut(u8);
        } catch (e) {
            return Promise.resolve({ ok: false,
                error: (e && e.message) || 'That file could not be read.' });
        }

        var pr = pack.presets[0], v = pr.variant;
        // a second ribbon of the same size in normal mode is laid over the first (tipStrip's stack)
        var stack = !!(pr.tip2 && pr.tips && pr.tips.length === 1 && +v.UseDualBrush && !+v.DualBrushCompositeMode &&
            +v.BrushRibbon && +v.DualRibbon && Math.abs(v.DualSize - v.BrushSize) < 0.5 && +v.DualRotation === +v.BrushRotation);
        var tipP = (pr.tips && pr.tips.length)
            ? BrushPack.tipStrip(stack ? pr.tips.concat([pr.tip2]) : pr.tips, 'tip.png', { csp: true, crop: v.BrushRibbon ? (Math.round((v.BrushRotation || 0) / 90) % 2 ? 'h' : 'w') : false,
                  join: +v.BrushPatternOrderType, stack: stack && (v.DualFlow == null ? 1 : Math.max(0, Math.min(100, +v.DualFlow)) / 100), keepColor: v.BrushChangePatternColor != null && !+v.BrushChangePatternColor }).catch(function () { return null; })
            : Promise.resolve(null);
        // the second brush, painted as a stroke of its own over (or out of) the first
        var sec = !stack && BrushPack.sutSecond(v);
        var tip2P = pr.tip2 && !stack
            ? BrushPack.tipStrip(sec ? pr.tips2 : pr.tip2, 'tip2.png', sec ? { csp: true, crop: v.DualRibbon ? (Math.round((v.DualRotation || 0) / 90) % 2 ? 'h' : 'w') : false,
                  join: +v.DualPatternOrderType } : undefined).catch(function () { return null; })
            : Promise.resolve(null);

        var texP = pr.texture && pr.texture.layer ? BrushPack.sutLayerUrl(pr.texture).catch(function () { return null; }) : Promise.resolve(null);

        return Promise.all([tipP, tip2P, texP]).then(function (both) {
            var tip = both[0], tip2 = both[1];
            var want = _packName(pr.name) || 'Clip Studio brush';
            var t = BrushPack.sutToPreset(pr.variant, want,
                { hasTip: !!tip, hasTexture: !!pr.texture, hasTip2: !!tip2, dualStacked: stack, tipW: tip && tip.w, tipH: tip && tip.h, tipWhole: !!(tip && tip.whole),
                  texReal: pr.texture && (pr.texture.layer ? pr.texture.layer.full[0] : pr.texture.real && pr.texture.real[0]) });
            var ps = t.params;
            var skipped = [], notes = [];
            var warnings = (pack.warnings || []).concat(t.warnings);

            if (tip) {
                if (tip.url.length > TIP_CAP) {
                    return { ok: false, error: 'Its tip image is too big to store (' +
                        _round(tip.url.length / 1024) + 'KB).' };
                }
                ps._tipUrl = _tipStash(tip.url);
                // a long ribbon cut into pieces is laid in turn, whatever its order (tipStrip)
                if (tip.cells > 1) { ps.tipCells = tip.cells; ps.tipPick = tip.pick === 'cycle' ? 'cycle' : ps.tipPick || tip.pick; }
                if (tip.lens && ps.ribbonClip) ps.ribbonLens = tip.lens;
                if (tip.params && tip.params.tipMode) ps.tipMode = tip.params.tipMode;
            }
            if (tip2 && tip2.url.length <= TIP_CAP) ps._tip2Url = _tipStash(tip2.url);
            if (sec) {
                // its picture is _tip2Url, never carved with (tip2Depth 0)
                var p2 = BrushPack.sutToPreset(sec.variant, want, { hasTip: !!ps._tip2Url, tipW: tip2 && tip2.w, tipH: tip2 && tip2.h }).params;
                if (tip2 && tip2.cells > 1) { p2.tipCells = tip2.cells; p2.tipPick = tip2.pick === 'cycle' ? 'cycle' : p2.tipPick || tip2.pick; }
                if (tip2 && tip2.params && tip2.params.tipMode) p2.tipMode = tip2.params.tipMode;
                if (sec.light) p2.cutByLight = true;
                ps.second = { op: sec.op, p: p2 };
            }
            if (ps.texture > 0 && pr.texture) {
                ps.texturePattern = both[2] ? _tipStash(both[2]) : _bytesToPngUrl(pr.texture);
            }

            var name = engine.PRESETS[want] ? _uniqueName(want) : want;
            _userPresets[name] = ps;
            var err = _commitUsers();
            if (err) {
                delete _userPresets[name];
                return { ok: false, error: 'The browser ran out of storage.' };
            }
            _installUserPreset(name, ps);
            _rebuildNames();
            _invalidateSwatch();
            if (warnings.length) notes.push({ name: name, warnings: warnings });
            return { ok: true, kind: 'sut', added: [name],
                     renamed: name !== want ? [want + ' → ' + name] : [],
                     skipped: skipped, notes: notes };
        });
    };

    engine.importProcreatePack = function (bytes, filename, opts) {
        if (!window.BrushPack) {
            return Promise.resolve({ ok: false, error: 'The brush pack reader is not loaded.' });
        }
        var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        var only = opts && opts.only ? opts.only : null;
        return BrushPack.readProcreate(u8).then(function (pack) {
            var added = [], renamed = [], skipped = [], notes = [];
            var chain = Promise.resolve();
            if (only) {
                pack.presets = pack.presets.filter(function (pr) {
                    return only.indexOf(pr.name) !== -1;
                });
            }

            pack.presets.forEach(function (pr) {
                chain = chain.then(function () {
                    var tipP = pr.shape
                        /* Procreate's shapes are cut out of white paper, so
                         * light is the ink -- unless the brush says it turned
                         * its own shape inside out. */
                        ? BrushPack.tipStrip(pr.shape, 'Shape.png',
                              { lightIsInk: !pr.arch.shapeInverted })
                            .catch(function () { return null; })
                        : Promise.resolve(null);
                    return tipP.then(function (tip) {
                        var want = _packName(pr.name) || 'Procreate brush';
                        var t = BrushPack.procreateToPreset(pr.arch, want, {
                            tipSize: tip ? tip.size : 0,
                            hasGrain: !!pr.grain
                        });
                        var ps = t.params;
                        if (tip) {
                            if (tip.url.length > TIP_CAP) {
                                skipped.push({ name: want, why: 'its shape image is too big to store (' +
                                    _round(tip.url.length / 1024) + 'KB)' });
                                return;
                            }
                            ps._tipUrl = _tipStash(tip.url);
                        }
                        if (ps.texture > 0 && pr.grain) {
                            ps.texturePattern = _bytesToPngUrl(pr.grain);
                        }
                        var name = engine.PRESETS[want] ? _uniqueName(want) : want;
                        if (name !== want) renamed.push(want + ' → ' + name);
                        _userPresets[name] = ps;
                        var err = _commitUsers();
                        if (err) {
                            delete _userPresets[name];
                            skipped.push({ name: want, why: 'the browser ran out of storage' });
                            throw new Error('full');
                        }
                        _installUserPreset(name, ps);
                        added.push(name);
                        if (t.warnings.length) notes.push({ name: name, warnings: t.warnings });
                    });
                });
            });

            return chain.catch(function (e) {
                if (e && e.message !== 'full') throw e;
            }).then(function () {
                _rebuildNames();
                _invalidateSwatch();
                for (var i = 0; i < pack.warnings.length; i++) {
                    skipped.push({ name: pack.warnings[i], why: '' });
                }
                if (!added.length && !skipped.length) {
                    return { ok: false, error: 'That file holds no brushes we could read.' };
                }
                return { ok: true, kind: 'procreate', added: added,
                         renamed: renamed, skipped: skipped, notes: notes };
            });
        }, function (e) {
            return { ok: false, error: (e && e.message) || 'That file could not be read.' };
        });
    };

    engine.importBrushPack = function (bytes, filename, opts) {
        if (!window.BrushPack) {
            return Promise.resolve({ ok: false, error: 'The brush pack reader is not loaded.' });
        }
        var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        var only = opts && opts.only ? opts.only : null;
        return BrushPack.read(u8).then(function (pack) {
            var added = [], renamed = [], skipped = [], notes = [];
            var tipCache = {};
            if (only) {
                pack.presets = pack.presets.filter(function (pr) {
                    // a file name too: one pack can hold several presets of one name
                    return only.indexOf(pr.name) !== -1 || only.indexOf((pr.file || '').split('/').pop()) !== -1;
                });
            }

            function tipFor(preset, file, own) {   // own: the tip keeps its own alpha (lightness or picture)
                if (!file) return Promise.resolve(null);
                var ck = own ? file + '|own' : file, to = { krita: true, ownAlpha: !!own };
                if (tipCache[ck]) return tipCache[ck];
                var src = (preset.resources && preset.resources[file] &&
                           preset.resources[file].bytes) || pack.tips[file];
                var p = src
                    ? BrushPack.tipStrip(src, file, to).catch(function () { return null; })
                    : _abrTip(file) || _shippedTip(file).then(function (t) {
                        return t || _kritaDefault(file).then(function (b) {
                            return b && BrushPack.tipStrip(b, file, to).then(function (k) {
                                k.shipped = true;
                                return k;
                            }, function () { return null; });
                        });
                    });
                tipCache[ck] = p;
                return p;
            }

            /* Krita names a tip taken out of a Photoshop set "<set>_<n>", and
             * the preset carries only that name: the picture is the n-th in
             * <set>.abr beside it in the pack. */
            var abrSets = {};
            function _abrTip(file) {
                var m = /^(.+)_(\d+)$/.exec(file), set = m && pack.tips[m[1] + '.abr'];
                if (!set) return null;
                if (!abrSets[m[1]]) {
                    try { abrSets[m[1]] = BrushPack.readAbr(set); } catch (e) { abrSets[m[1]] = []; }
                }
                // counted from 1: from 0, Bristle_frottis001111's overlap with Krita's render was 0, from 1 it is 0.6
                var tip = abrSets[m[1]][+m[2] - 1];
                return tip && tip.url ? Promise.resolve({ url: tip.url, size: tip.size, cells: 1, pick: 'random' }) : null;
            }

            var chain = Promise.resolve();
            pack.presets.forEach(function (pr) {
                chain = chain.then(function () {
                    var bd = BrushPack.brushDefinition(pr) || {};
                    return tipFor(pr, bd.filename, BrushPack.kritaTipApp(bd) % 2 === 1).then(function (tip) {
                        var want = _packName(pr.name) || _packName(pr.file) || 'Imported brush';
                        var t = BrushPack.toPreset(pr, { tipSize: tip ? tip.size : 0 });
                        var ps = t.params;
                        if (ps.needsTipSize) {
                            skipped.push({ name: want, why: 'its tip image is missing from the pack' });
                            return;
                        }
                        delete ps.needsTipSize;
                        /* A masking brush can name its tip the same way the
                         * brush names its own, so it is resolved the same
                         * way -- against the pack, while the pack is here. */
                        var m2f = ps._tip2File, pf0 = ps.texturePatternFile;
                        delete ps._tip2File;
                        return Promise.all([m2f ? tipFor(pr, m2f) : null,
                            pf0 && !ps.texturePatternData && !pack.tips[pf0] ? _kritaDefault(pf0) : null]).then(function (got) {
                        var m2 = got[0], kpat = got[1];
                        if (m2f) {
                            if (m2 && m2.cells > 1 && ps.maskOp) ps.maskCells = m2.cells;   // one at random a mask dab
                            if (m2 && m2.url) ps._tip2Url = m2.url;
                            else t.warnings.push('its masking tip "' + m2f +
                                '" is not in this pack; the brush stamps unmasked');
                        }
                        if (ps._tip2Url) ps._tip2Url = _tipStash(ps._tip2Url);
                        /* The pattern image lives beside the presets in the
                         * pack, so the preset can only name it. Resolve it
                         * here, where the pack is still in hand. */
                        if (ps.texturePatternFile) {
                            var pf = ps.texturePatternFile, pe = ps.texturePatternData;
                            delete ps.texturePatternFile;
                            delete ps.texturePatternData;
                            var pb = pack.tips[pf] || kpat;
                            if (kpat) t.warnings.push('its canvas texture "' + pf + '" is not in this pack; ' +
                                'Krita\'s own, which we ship, was used');
                            if (pe) {
                                ps.texturePattern = pe;   // the preset's own copy, see toPreset
                            } else if (pb) {
                                ps.texturePattern = _bytesToPngUrl(pb);
                            } else {
                                /* Painting it smooth is the bigger miss. A
                                 * brush that asks for a canvas texture is a
                                 * grainy brush, so keep the grain and stand
                                 * our own tile in for the picture we do not
                                 * have -- the strength and scale the preset
                                 * asked for are still its own. */
                                t.warnings.push('its canvas texture "' + pf +
                                    '" is not in this pack; a plain grain ' +
                                    'stood in for it');
                            }
                        }
                        if (ps._checkBlend) {
                            delete ps._checkBlend;
                            if (engine.BLEND_MODES.indexOf(ps.blendMode) < 0) {
                                t.warnings.push('it blended with "' + ps.blendMode + '", which we do not have');
                                delete ps.blendMode;
                            }
                        }
                        if (tip) {
                            if (tip.shipped) {
                                t.warnings.push('its tip "' + bd.filename +
                                    '" is not in this pack; the one of that name ' +
                                    'we already ship was used instead');
                            }
                            if (tip.url.length > TIP_CAP) {
                                skipped.push({ name: want, why: 'its tip image is too big to store (' +
                                    _round(tip.url.length / 1024) + 'KB)' });
                                return;
                            }
                            ps._tipUrl = _tipStash(tip.url);
                            if (tip.cells > 1) { ps.tipCells = tip.cells; ps.tipPick = tip.pick; }
                            if (tip.params && tip.params.tipPaper) ps.tipPaper = true;
                        }
                        // Never overwrite: an import that quietly replaced a
                        // brush the user had tuned would be unrecoverable.
                        var name = engine.PRESETS[want] ? _uniqueName(want) : want;
                        if (name !== want) renamed.push(want + ' → ' + name);
                        _userPresets[name] = ps;
                        var err = _commitUsers();
                        if (err) {
                            delete _userPresets[name];
                            skipped.push({ name: want, why: 'the browser ran out of storage' });
                            throw new Error('full');
                        }
                        _installUserPreset(name, ps);
                        added.push(name);
                        if (t.warnings.length) notes.push({ name: name, warnings: t.warnings });
                        });
                    });
                });
            });

            return chain.catch(function (e) {
                if (e && e.message !== 'full') throw e;
            }).then(function () {
                _rebuildNames();
                _invalidateSwatch();
                for (var i = 0; i < pack.warnings.length; i++) {
                    skipped.push({ name: pack.warnings[i], why: '' });
                }
                if (!added.length && !skipped.length) {
                    return { ok: false, error: 'That pack holds no brushes we could read.' };
                }
                return { ok: true, kind: pack.kind, added: added, renamed: renamed,
                         skipped: skipped, notes: notes };
            });
        }, function (e) {
            return { ok: false, error: (e && e.message) || 'That file could not be read.' };
        });
    };

    function _tipBaseName(filename) {
        return String(filename || 'Tip').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ');
    }

    /* A tip with no settings attached becomes a plain stamping brush at the
     * tip's own size, which the user tunes from there. */
    function _saveTipAsBrush(tip, base) {
        if (tip.url.length > TIP_CAP) {
            return { ok: false, error: 'That tip image is too big to store (' +
                _round(tip.url.length / 1024) + 'KB, limit ' + _round(TIP_CAP / 1024) + 'KB).' };
        }
        var name = _uniqueName(base);
        var ps = {
            size: _min(MAX_SIZE, _max(2, tip.size)), opacity: 100, flow: 100,
            spacing: tip.spacing || 10, hardness: 100, shape: 'custom', _tipUrl: _tipStash(tip.url)
        };
        /* A file that carried settings as well as a picture -- a Photoshop
         * set does -- brings them along. They land on top of the plain stamp
         * above, so a format that carries none still gets a working brush. */
        if (tip.params) {
            for (var k in tip.params) {
                if (tip.params.hasOwnProperty(k)) ps[k] = tip.params[k];
            }
            if (ps.size) ps.size = _min(MAX_SIZE, _max(2, _round(ps.size)));
            /* A second tip too big to store loses the brush its carve, not
             * the brush itself -- and says so rather than going quiet. */
            if (ps._tip2Url) ps._tip2Url = _tipStash(ps._tip2Url);
            if (ps._tip2Url && ps._tip2Url.length > TIP_CAP) {
                delete ps._tip2Url;
                ps.tip2Depth = 0;
                if (tip.warnings) tip.warnings.push('dropped: its second brush tip, which was too big to store');
            }
        }
        if (tip.cells > 1) { ps.tipCells = tip.cells; ps.tipPick = tip.pick; }
        _userPresets[name] = ps;
        var err = _commitUsers();
        if (err) { delete _userPresets[name]; return { ok: false, error: err }; }
        _installUserPreset(name, ps);
        return { ok: true, name: name, cells: tip.cells };
    }

    /* A MyPaint brush. It has settings but no tip image, and its engine
     * is the least like ours of the three, so this is the one import that
     * is openly a likeness -- the notes say what it left behind. */
    engine.importMyb = function (text, filename) {
        if (!window.BrushPack) {
            return { ok: false, error: 'The brush pack reader is not loaded.' };
        }
        var t;
        try { t = BrushPack.readMyb(text, _tipBaseName(filename)); }
        catch (e) { return { ok: false, error: (e && e.message) || 'That file could not be read.' }; }
        var name = _uniqueName(_cleanName(t.name) || _tipBaseName(filename));
        _userPresets[name] = t.params;
        var err = _commitUsers();
        if (err) { delete _userPresets[name]; return { ok: false, error: err }; }
        _installUserPreset(name, t.params);
        _rebuildNames();
        _invalidateSwatch(name);
        return { ok: true, kind: 'myb', added: [name], renamed: [], skipped: [],
                 notes: t.warnings.length ? [{ name: name, warnings: t.warnings }] : [] };
    };

    /* A Photoshop brush set. It carries tip images and no settings we can
     * read, so each one becomes a stamp of its own -- which is what most of
     * the .abr art out there is anyway. */
    engine.importAbrPack = function (bytes, filename) {
        if (!window.BrushPack) {
            return Promise.resolve({ ok: false, error: 'The brush pack reader is not loaded.' });
        }
        var tips, isTpl = /\.tpl$/i.test(filename || '');
        try {
            var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
            /* A .tpl is a saved tool rather than a saved brush, but a saved
             * paintbrush carries the whole brush with it, so the two come
             * out the same shape and everything past here is shared. */
            tips = isTpl ? BrushPack.readTpl(u8) : BrushPack.readAbr(u8);
        } catch (e) {
            return Promise.resolve({ ok: false, error: (e && e.message) || 'That file could not be read.' });
        }
        var base = _tipBaseName(filename), added = [], skipped = [], notes = [];
        for (var i = 0; i < tips.length; i++) {
            /* Photoshop's own name for the tip when the file carries one --
             * a pack of a hundred is unusable as "pack 1" ... "pack 100".
             * Duplicates are fine: _uniqueName numbers them. */
            var want = _cleanName(tips[i].name) ||
                       (tips.length > 1 ? base + ' ' + (i + 1) : base);
            var r = _saveTipAsBrush(tips[i], want);
            if (!r.ok) { skipped.push({ name: want, why: r.error }); break; }
            added.push(r.name);
            if (tips[i].warnings && tips[i].warnings.length) {
                notes.push({ name: r.name, warnings: tips[i].warnings });
            }
        }
        _rebuildNames();
        _invalidateSwatch();
        return Promise.resolve({ ok: true, kind: isTpl ? 'tpl' : 'abr', added: added,
                                 renamed: [], skipped: skipped, notes: notes });
    };

    /* A GIMP generated brush (.vbr): a shape described in eight or ten
     * numbers of plain text, with no picture in it at all. GIMP builds the
     * dab from the numbers every time, and so do we -- except for a plain
     * round one, which is the brush we already are and stays parametric. */
    engine.importVbr = function (text, filename) {
        if (!window.BrushPack) {
            return { ok: false, error: 'The brush pack reader is not loaded.' };
        }
        var got;
        try {
            got = BrushPack.readVbr(String(text), filename);
        } catch (e) {
            return { ok: false, error: (e && e.message) || 'That file could not be read.' };
        }
        var want = _cleanName(got.name) || _tipBaseName(filename);
        var ps = got.params;
        if (got.tip) {
            if (got.tip.url.length > TIP_CAP) {
                return { ok: false, error: 'Its shape is too big to store.' };
            }
            ps._tipUrl = _tipStash(got.tip.url);
        }
        var name = engine.PRESETS[want] ? _uniqueName(want) : want;
        ps.pixelSteps = true;   // a GIMP brush steps GIMP's way; see _stepFor
        _userPresets[name] = ps;
        var err = _commitUsers();
        if (err) { delete _userPresets[name]; return { ok: false, error: 'The browser ran out of storage.' }; }
        _installUserPreset(name, ps);
        _rebuildNames();
        _invalidateSwatch();
        return { ok: true, kind: 'vbr', added: [name],
                 renamed: name !== want ? [want + ' → ' + name] : [],
                 skipped: [], notes: [] };
    };

    /* A tip image on its own -- a PNG, a GIMP .gbr, a .gih strip of shapes,
     * or one of SAI's .bmp resources. There are no settings in one, so it
     * becomes a plain stamping brush at the tip's own size and the user
     * tunes it from there.
     *
     * SAI keeps no brush file at all: a brush there is a row in a text
     * index naming a .bmp in one of four folders -- elemap for the shape,
     * blotmap for the speckle, brushtex and papertex for grain. The .bmp is
     * the whole of what is portable, and it comes in on this path. */
    engine.importBrushTip = function (bytes, filename) {
        if (!window.BrushPack) {
            return Promise.resolve({ ok: false, error: 'The brush pack reader is not loaded.' });
        }
        var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        return BrushPack.tipStrip(u8, filename).then(function (tip) {
            // A GIMP brush steps and shrinks GIMP's way (see _stepFor, _shrinkTip).
            if (/\.(gbr|gih)$/i.test(filename || '')) { tip.params = tip.params || {}; tip.params.pixelSteps = true; tip.params.tipShrink = 'halve'; }
            var r = _saveTipAsBrush(tip, _tipBaseName(filename));
            _rebuildNames();
            if (r.ok) _invalidateSwatch(r.name);
            return r;
        }, function (e) {
            return { ok: false, error: (e && e.message) || 'That file is not a brush tip we can read.' };
        });
    };

    // Published down here: everything above `var engine` runs at module-eval
    // time, when engine is still undefined.
    engine.BLEND_MODES = Object.keys(_BLEND_OPS);
    engine.forgetSaved = _forgetSaved;

    engine.loadTexturePattern = _loadTexturePattern;
    /* Only the tests use this: a stroke picks its own seed, and pinning it
     * is what lets a speckled stroke be drawn twice and compared. */
    engine._setStrokeSeed = function (n) { _pinnedSeed = n == null ? null : (n | 0); };
    // Test-only: how many times the live pass suspended this stroke. The
    // hash suite asserts it is non-zero on the drain case, proving the
    // suspend path actually ran before asserting identical pixels.
    engine._suspendCount = function () { return _suspendCount; };
    engine.generatePreview = function (name) { return _pbRenderPreview(name); };

    /* Tilt and barrel rotation, straight off the pointer event. Nothing read
     * them before, so a tilt-driven brush had nothing to respond to. */
    engine.setPenState = _setPenState;

    /* Response curves. setCurve takes [in, out] points 0..1; passing nothing
     * puts the parameter back to linear. evalCurve is what the widget draws,
     * so the curve on screen is the one the brush applies. */
    engine.setCurve = _setCurve;
    engine.getCurve = _getCurve;
    engine.evalCurve = _evalCurve;

    engine.resetCurrentPreset = function () {
        _forgetSaved(engine._currentPreset);
        engine.loadPreset(engine._currentPreset);
        engine.syncPanel();
    };


    /* Search hides tiles rather than rebuilding the grid. Re-rendering means
     * re-painting a swatch per brush with the real engine (~4ms each), which
     * across 75+ brushes is a visible stall on every keystroke. */
    function _applyBrushSearch() {
        var grid = document.getElementById('pb-brush-grid');
        var box = document.getElementById('pb-search');
        if (!grid) return;
        var q = box ? box.value.trim().toLowerCase() : '';
        var kids = grid.children;
        var head = null, shown = 0;
        for (var i = 0; i < kids.length; i++) {
            var el = kids[i];
            if (el.classList.contains('pb-brush-group')) {
                if (head) head.hidden = shown === 0;
                head = el; shown = 0;
                continue;
            }
            var n = el.getAttribute('data-search') ||
                    (el.getAttribute('data-preset') || '').toLowerCase();
            var hit = !q || n.indexOf(q) !== -1;
            el.hidden = !hit;
            if (hit) shown++;
        }
        if (head) head.hidden = shown === 0;
    }

    function _syncManageButtons() {
        var mine = engine.isUserPreset(engine._currentPreset);
        ['pb-rename-btn', 'pb-delete-btn'].forEach(function (id) {
            var b = document.getElementById(id);
            if (b) {
                b.disabled = !mine;
                b.title = mine ? b.getAttribute('data-tip-own')
                               : 'Only brushes you saved can be renamed or deleted.';
            }
        });
        var del = document.getElementById('pb-delete-btn');
        if (del) { del.textContent = 'Delete'; del.classList.remove('armed'); }
    }

    function _say(msg, kind) {
        try { showToast(msg, kind || 'info'); }
        catch (e_) { console.log('[brushes] ' + msg); }
    }

    function _afterLibraryChange(msg) {
        engine.buildBrushGrid();
        _applyBrushSearch();
        engine.syncPanel();
        _syncManageButtons();
        if (msg) _say(msg, 'success');
    }

    /* Ask which brushes to take, when a pack holds enough that it matters.
     *
     * Under the threshold the question is noise -- a two-brush pack is
     * quicker to install and delete from than to read a dialog about. Over
     * it, installing all forty was the old behaviour and it filled the
     * library with brushes nobody asked for.
     *
     * Only ever offered for a single file: several at once is a batch, and a
     * dialog per file is worse than the problem it solves. */
    var PACK_ASK_OVER = 3;

    function _packChooser(file) {
        var el = document.getElementById('modal-brush-pack');
        var list = document.getElementById('bp-pack-list');
        if (!el || !list) return Promise.resolve(false);

        return _readFile(file).then(function (buf) {
            var u8 = new Uint8Array(buf);
            return engine.packSummary(u8, file.name).then(function (sum) {
                if (!sum.ok || !sum.brushes || sum.brushes.length <= PACK_ASK_OVER) {
                    return false;
                }
                _showPackChooser(el, list, sum, u8, file.name);
                return true;
            });
        }).catch(function () { return false; });
    }

    function _showPackChooser(el, list, sum, u8, filename) {
        var title = document.getElementById('bp-pack-title');
        var count = document.getElementById('bp-pack-count');
        if (title) title.textContent = filename;

        list.textContent = '';
        var boxes = [];
        sum.brushes.forEach(function (b) {
            var row = document.createElement('label');
            row.className = 'bp-pack-row';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.value = b.name;
            boxes.push(cb);
            row.appendChild(cb);
            if (b.icon) {
                var img = document.createElement('img');
                img.src = b.icon;
                img.alt = '';
                row.appendChild(img);
            } else {
                var blank = document.createElement('span');
                blank.className = 'bp-pack-noicon';
                row.appendChild(blank);
            }
            var nm = document.createElement('span');
            nm.textContent = _packName(b.name) || b.name;
            nm.title = b.name;
            row.appendChild(nm);
            list.appendChild(row);
        });

        function tally() {
            var n = boxes.filter(function (c) { return c.checked; }).length;
            if (count) {
                count.textContent = n + ' of ' + boxes.length + ' brush' +
                    (boxes.length === 1 ? '' : 'es');
            }
            if (add) add.disabled = n === 0;
        }

        var all = document.getElementById('bp-pack-all');
        var none = document.getElementById('bp-pack-none');
        var add = document.getElementById('bp-pack-add');
        list.onchange = tally;
        if (all) all.onclick = function () { boxes.forEach(function (c) { c.checked = true; }); tally(); };
        if (none) none.onclick = function () { boxes.forEach(function (c) { c.checked = false; }); tally(); };
        if (add) {
            add.onclick = function () {
                var only = boxes.filter(function (c) { return c.checked; })
                                .map(function (c) { return c.value; });
                if (app.closeModals) app.closeModals();
                var isPc = /\.(brush|brushset)$/i.test(filename);
                var run = isPc ? engine.importProcreatePack : engine.importBrushPack;
                run(u8, filename, { only: only }).then(function (r) {
                    _reportImport(r, filename);
                });
            };
        }
        tally();
        el.style.display = 'flex';
        if (app.centerModal) app.centerModal('modal-brush-pack');
    }

    /* The same toast and console lines importFiles writes, so a pack that
     * came through the chooser reports exactly like one that did not. */
    function _reportImport(r, what) {
        if (!r || !r.ok) {
            _say((r && r.error) || 'That pack could not be read', 'error');
            return;
        }
        (r.skipped || []).forEach(function (k) {
            console.warn('[brush pack] left out ' + k.name + (k.why ? ': ' + k.why : ''));
        });
        (r.notes || []).forEach(function (k) {
            console.warn('[brush pack] ' + k.name + ' — ' + k.warnings.join('; '));
        });
        _storeImportNotes(r.notes);
        _afterLibraryChange(null);
        var n = r.added.length;
        var fit1 = (n === 1 && r.added[0]) ? _noteText(r.notes, r.added[0]) : '';
        var changedN = (r.notes || []).length;
        _say(!n ? 'Nothing in ' + what + ' could be imported'
            : 'Added ' + n + ' brush' + (n === 1 ? '' : 'es') +
              ((r.skipped || []).length ? ', ' + r.skipped.length + ' left out' : '') +
              (fit1 ? ' — ' + fit1 : '') +
              (!fit1 && changedN ? ' — ' + changedN + ' changed to fit; select the brush to see what changed' : ''),
            n ? 'success' : 'error');
    }

    /* One file that turns out to be a big pack gets the chooser; everything
     * else goes straight in, which is what the Import button has always
     * done and what a tip image or a single preset should keep doing. */
    function _importOrAsk(files) {
        var list = [].slice.call(files || []);
        if (list.length !== 1) return engine.importFiles(list);
        return _packChooser(list[0]).then(function (asked) {
            if (!asked) return engine.importFiles(list);
            return null;
        });
    }

    function _bindLibraryBar() {
        var search = document.getElementById('pb-search');
        if (search) search.addEventListener('input', _applyBrushSearch);

        var nameIn = document.getElementById('pb-preset-name');
        var nameOf = function () {
            return (nameIn && nameIn.value) || engine._currentPreset;
        };

        var save = document.getElementById('pb-save-btn');
        if (save) save.addEventListener('click', function () {
            var r = engine.saveUserPreset(nameOf());
            if (!r.ok) return _say(r.error, 'error');
            _afterLibraryChange('Saved "' + r.name + '"' + (r.replaced ? ' (replaced)' : ''));
        });

        var dupe = document.getElementById('pb-dupe-btn');
        if (dupe) dupe.addEventListener('click', function () {
            var from = engine._currentPreset;
            var want = nameIn && nameIn.value.trim() && nameIn.value.trim() !== from
                ? nameIn.value : null;
            var r = engine.duplicatePreset(from, want);
            if (!r.ok) return _say(r.error, 'error');
            engine.loadPreset(r.name);
            if (nameIn) nameIn.value = r.name;
            _afterLibraryChange('Duplicated as "' + r.name + '"');
        });

        var ren = document.getElementById('pb-rename-btn');
        if (ren) ren.addEventListener('click', function () {
            var r = engine.renameUserPreset(engine._currentPreset, nameOf());
            if (!r.ok) return _say(r.error, 'error');
            _afterLibraryChange('Renamed to "' + r.name + '"');
        });

        /* Delete arms itself for a few seconds instead of opening a dialog:
         * this app has no modal of its own, and window.confirm is not
         * reliably available inside the desktop shell. */
        var del = document.getElementById('pb-delete-btn');
        var armed = null;
        if (del) del.addEventListener('click', function () {
            var name = engine._currentPreset;
            if (del.classList.contains('armed')) {
                clearTimeout(armed);
                var r = engine.deleteUserPreset(name);
                if (!r.ok) return _say(r.error, 'error');
                if (nameIn) nameIn.value = engine._currentPreset;
                return _afterLibraryChange('Deleted "' + name + '"');
            }
            if (!engine.isUserPreset(name)) return _say('Only brushes you saved can be deleted.', 'warning');
            del.classList.add('armed');
            del.textContent = 'Delete?';
            armed = setTimeout(function () {
                del.classList.remove('armed');
                del.textContent = 'Delete';
            }, 4000);
        });

        var exp = document.getElementById('pb-export-btn');
        if (exp) exp.addEventListener('click', function () {
            if (!engine.userPresetNames().length) return _say('You have no saved brushes yet.', 'warning');
            engine.exportUserPresets().then(function (json) {
                var blob = new Blob([json], { type: 'application/json' });
                var a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'cdpaint-brushes.json';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
            });
        });

        /* Dropping the file on the panel is the same thing as picking it,
         * and it is how a brush pack arrives from a download folder. The
         * page has no other drop handler, so nothing is being stolen. */
        var panel = document.getElementById('paintbrush-sidebar');
        if (panel) {
            var depth = 0;
            panel.addEventListener('dragenter', function (e) {
                if (!e.dataTransfer || e.dataTransfer.types.indexOf('Files') < 0) return;
                e.preventDefault();
                if (++depth === 1) panel.classList.add('pb-dropping');
            });
            panel.addEventListener('dragover', function (e) {
                if (e.dataTransfer && e.dataTransfer.types.indexOf('Files') >= 0) e.preventDefault();
            });
            panel.addEventListener('dragleave', function () {
                if (--depth <= 0) { depth = 0; panel.classList.remove('pb-dropping'); }
            });
            panel.addEventListener('drop', function (e) {
                if (!e.dataTransfer || !e.dataTransfer.files.length) return;
                e.preventDefault();
                depth = 0;
                panel.classList.remove('pb-dropping');
                _importOrAsk(e.dataTransfer.files);
            });
        }

        var imp = document.getElementById('pb-import-btn');
        var file = document.getElementById('pb-import-file');
        if (imp && file) {
            imp.addEventListener('click', function () { file.value = ''; file.click(); });
            file.addEventListener('change', function () {
                _importOrAsk(file.files);
            });
        }
    }

    /* One Import button for every shape a brush arrives in: our own export,
     * a Krita pack, a single preset, or a bare tip image. Which it is comes
     * off the file itself, so the user picks a file rather than first
     * picking what kind of file it is. */
    function _readFile(f, asText) {
        return new Promise(function (res, rej) {
            var rd = new FileReader();
            rd.onerror = function () { rej(new Error('Could not read ' + f.name)); };
            rd.onload = function () { res(rd.result); };
            if (asText) rd.readAsText(f); else rd.readAsArrayBuffer(f);
        });
    }

    engine.importFiles = function (files) {
        var list = [].slice.call(files || []);
        if (!list.length) return Promise.resolve(null);
        var lines = [], failed = 0, brushes = 0, left = 0, changed = 0, one = null, oneNotes = null;

        /* The toast is one line, so a single changed brush names what changed;
         * a batch keeps the count and leaves the detail to the brush panel. */
        function _noteText(notes, name) {
            var list = notes || [], hit = null;
            for (var i = 0; i < list.length; i++) {
                if (!name || list[i].name === name) { hit = list[i]; break; }
            }
            if (!hit && !name && list.length === 1) hit = list[0];
            return hit ? hit.warnings.join('; ') : '';
        }

        function note(r, what) {
            if (!r || !r.ok) {
                failed++;
                lines.push(what + ': ' + ((r && r.error) || 'could not be read'));
                return;
            }
            if (r.added) {
                brushes += r.added.length;
                left += (r.skipped || []).length;
                changed += (r.notes || []).length;
                if (r.added.length === 1) { one = r.added[0]; oneNotes = r.notes || []; }
                _storeImportNotes(r.notes);
                (r.skipped || []).forEach(function (k) {
                    lines.push('  left out ' + k.name + (k.why ? ': ' + k.why : ''));
                });
                (r.notes || []).forEach(function (k) {
                    lines.push('  ' + k.name + ' — ' + k.warnings.join('; '));
                });
                lines.push(what + ': ' + r.added.length + ' brush' + (r.added.length === 1 ? '' : 'es') +
                    ((r.skipped || []).length ? ', ' + r.skipped.length + ' left out' : ''));
            } else {
                brushes++;
                one = r.name;
                lines.push(what + ': "' + r.name + '"' +
                    (r.cells > 1 ? ' (' + r.cells + ' shapes)' : ''));
            }
        }

        var chain = Promise.resolve();
        list.forEach(function (f) {
            chain = chain.then(function () {
                var n = f.name || '';
                if (/\.json$/i.test(n)) {
                    return _readFile(f, true).then(function (txt) {
                        note(engine.importUserPresets(String(txt)), n);
                    });
                }
                if (/\.vbr$/i.test(n)) {
                    return _readFile(f, true).then(function (txt) {
                        note(engine.importVbr(String(txt), n), n);
                    });
                }
                if (/\.myb$/i.test(n)) {
                    return _readFile(f, true).then(function (txt) {
                        note(engine.importMyb(String(txt), n), n);
                    });
                }
                if (/\.sut$/i.test(n)) {
                    return _readFile(f).then(function (buf) {
                        return engine.importSutPack(new Uint8Array(buf), n).then(function (r) { note(r, n); });
                    });
                }
                if (/\.(brush|brushset)$/i.test(n)) {
                    return _readFile(f).then(function (buf) {
                        return engine.importProcreatePack(new Uint8Array(buf), n).then(function (r) { note(r, n); });
                    });
                }
                if (/\.(abr|tpl)$/i.test(n)) {
                    return _readFile(f).then(function (buf) {
                        return engine.importAbrPack(new Uint8Array(buf), n).then(function (r) { note(r, n); });
                    });
                }
                if (/\.(png|gbr|gih|bmp)$/i.test(n)) {
                    return _readFile(f).then(function (buf) {
                        return engine.importBrushTip(new Uint8Array(buf), n).then(function (r) { note(r, n); });
                    });
                }
                return _readFile(f).then(function (buf) {
                    return engine.importBrushPack(new Uint8Array(buf), n).then(function (r) { note(r, n); });
                });
            }).catch(function (e) {
                failed++;
                lines.push((f.name || 'file') + ': ' + ((e && e.message) || 'could not be read'));
            });
        });

        return chain.then(function () {
            _afterLibraryChange(null);
            /* One line: a toast is one line whatever it is handed, and a
             * newline in it only runs the sentences together. The per-file
             * detail goes to the console and to the caller. */
            var msg;
            if (!brushes) {
                msg = failed === 1 ? lines[0] : 'Nothing in those files could be imported';
            } else if (brushes === 1 && one) {
                var fit = _noteText(oneNotes, one);
                msg = 'Added "' + one + '"' + (fit ? ' — ' + fit : '');
            } else {
                msg = 'Added ' + brushes + ' brushes' +
                    (list.length === 1 ? ' from ' + list[0].name : ' from ' + list.length + ' files');
            }
            if (brushes && left) msg += ' — ' + left + ' left out';
            /* A brush that arrived missing something Krita or MyPaint can do
             * and we cannot is still a brush, but the user should know it is
             * not quite the one they downloaded. The detail lives on the
             * brush panel, so a batch points there. */
            if (brushes && changed) msg += ' — ' + changed + ' changed to fit' +
                ((brushes === 1 && one) ? '' : '; select the brush to see what changed');
            if (brushes && failed) msg += ' — ' + failed + ' file' + (failed === 1 ? '' : 's') + ' unreadable';
            if (lines.length > 1) console.log('[brushes] ' + lines.join('\n[brushes] '));
            _say(msg, brushes ? 'success' : 'error');
            return { brushes: brushes, failed: failed, lines: lines };
        });
    };

    /* Nine of a hundred tiles fit in the scroller, and every swatch is a
     * whole brush stroke rendered at double size. Drawing all hundred was
     * 726ms of the 791ms it took to open the panel, to show nine. So a tile
     * arrives empty and draws itself when it is about to be looked at.
     * Tiles carry their aspect-ratio in CSS, so an undrawn one still holds
     * its place and the scrollbar does not jump. */
    var _gridObs = null;

    /* ...and the ones it does draw go out a few per frame, not all at once.
     * Sixteen tiles fit inside the observer's margin, each one a real brush
     * stroke, and drawing the lot inside the observer callback blocked a
     * single frame for 305ms on a large document -- one long freeze exactly
     * when the panel appears. A frame's worth at a time keeps the panel
     * interactive while the tiles fill in. */
    var _swatchQueue = [];
    var _swatchPump = 0;
    var SWATCH_BUDGET = 4;   // ms of swatch drawing per slice

    /* Idle time, not the next frame. Swatches cost anything from 3ms to
     * 73ms each -- a bristle mixer is a real stroke with sixteen tips and
     * paint pickup -- so one of them can miss a frame all by itself and
     * there is no splitting it. Handing the browser the choice of when to
     * run them keeps scrolling smooth; the timeout is there so a tile
     * scrolled to still fills in on a page that never goes idle. */
    var _idle = window.requestIdleCallback
        ? function (fn) { return requestIdleCallback(fn, { timeout: 300 }); }
        : function (fn) { return requestAnimationFrame(fn); };
    var _unidle = window.cancelIdleCallback
        ? function (h) { cancelIdleCallback(h); }
        : function (h) { cancelAnimationFrame(h); };

    function _pumpSwatches() {
        _swatchPump = 0;
        var t0 = Date.now();
        while (_swatchQueue.length) {
            _drawSwatch(_swatchQueue.shift());
            if (Date.now() - t0 > SWATCH_BUDGET) break;
        }
        if (_swatchQueue.length) _swatchPump = _idle(_pumpSwatches);
    }

    function _swatchInto(tile) {
        if (tile._swatched) return;
        tile._swatched = true;
        _swatchQueue.push(tile);
        if (!_swatchPump) _swatchPump = _idle(_pumpSwatches);
    }

    function _drawSwatch(tile) {
        var name = tile.getAttribute('data-preset');
        var draw = function () {
            var old = tile.querySelector('canvas');
            if (old) tile.removeChild(old);
            var c = engine.generatePreview(name);
            if (c) tile.insertBefore(c, tile.firstChild);
        };
        draw();
        /* 27 presets stamp a PNG tip. Fetching and luminance-converting all
         * of them was ~570kB and a decode each, every one paid on open to
         * fill tiles nobody had scrolled to yet. A tile fetches its own. */
        var pr = engine.PRESETS[name];
        ['', '2'].forEach(function (which) {
            var url = pr && (which === '2' ? pr._tip2Url : pr._tipUrl);
            if (!url || _previewTipCache[name + '|' + which] !== undefined) return;
            _ensurePreviewTip(name, function () {
                _invalidateSwatch(name);
                draw();
            }, which);
        });
    }

    engine.buildBrushGrid = function () {
        var grid = document.getElementById('pb-brush-grid');
        var label = document.getElementById('pb-active-name');
        if (!grid) return;
        if (_gridObs) { _gridObs.disconnect(); _gridObs = null; }
        // The queued tiles are about to be thrown away.
        _swatchQueue.length = 0;
        if (_swatchPump) { _unidle(_swatchPump); _swatchPump = 0; }
        while (grid.firstChild) grid.removeChild(grid.firstChild);
        // One insertion instead of a hundred and twelve, each of which
        // invalidated the panel's layout on the way in.
        var frag = document.createDocumentFragment();

        var groups = _groupedPresets();
        var names = [];
        for (var gi = 0; gi < groups.length; gi++) {
            var head = document.createElement('div');
            head.className = 'pb-brush-group';
            head.textContent = groups[gi].name;
            frag.appendChild(head);
            for (var k = 0; k < groups[gi].presets.length; k++) names.push(groups[gi].presets[k]);
            addTiles(groups[gi].presets, groups[gi].name);
        }

        function addTiles(list, groupName) {
        for (var i = 0; i < list.length; i++) {
            (function (name) {
                var tile = document.createElement('div');
                tile.className = 'pb-brush-tile';
                tile.title = name;
                tile.setAttribute('data-preset', name);
                /* Searching "smudge" should find Wet Blender. The family is
                 * how people describe what they want, so it is part of what
                 * a tile matches on. */
                tile.setAttribute('data-search',
                    (name + ' ' + (groupName || '')).toLowerCase());
                // A saved brush is named by the user, so it reaches the DOM
                // as text and never as markup.
                if (engine.isUserPreset(name)) {
                    var cap = document.createElement('span');
                    cap.className = 'pb-tile-name';
                    cap.textContent = name;
                    tile.appendChild(cap);
                }

                var star = document.createElement('button');
                star.className = 'pb-fav';
                star.type = 'button';
                star.textContent = '\u2605';
                star.title = 'Favourite';
                star.setAttribute('aria-label', 'Favourite ' + name);
                if (engine.isFavourite(name)) star.classList.add('on');
                star.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    engine.toggleFavourite(name);
                    engine.buildBrushGrid();
                });
                tile.appendChild(star);

                tile.addEventListener('click', function () {
                    engine.loadPreset(name);
                    engine.syncPanel();
                    engine.updateVisibleSettings();
                    var tiles2 = document.querySelectorAll('.pb-brush-tile');
                    for (var t = 0; t < tiles2.length; t++) {
                        tiles2[t].classList.toggle('active', tiles2[t].getAttribute('data-preset') === name);
                    }
                    if (label) label.textContent = name;
                    var nameIn = document.getElementById('pb-preset-name');
                    if (nameIn) nameIn.value = name;
                    _syncManageButtons();
                    try { _updateBrushCursor && _updateBrushCursor(); } catch (e_) {}
                });
                frag.appendChild(tile);
            })(list[i]);
        }
        }

        grid.appendChild(frag);

        var all = grid.querySelectorAll('.pb-brush-tile');
        if (window.IntersectionObserver) {
            _gridObs = new IntersectionObserver(function (entries) {
                for (var e = 0; e < entries.length; e++) {
                    if (!entries[e].isIntersecting) continue;
                    var t = entries[e].target;
                    _gridObs.unobserve(t);
                    _swatchInto(t);
                }
            }, { root: grid, rootMargin: '250px 0px' });
            for (var ob = 0; ob < all.length; ob++) _gridObs.observe(all[ob]);
        } else {
            for (var ob2 = 0; ob2 < all.length; ob2++) _swatchInto(all[ob2]);
        }

        var active = engine._currentPreset || names[0];
        if (label) label.textContent = active;
        var tiles2 = grid.querySelectorAll('.pb-brush-tile');
        for (var t = 0; t < tiles2.length; t++) {
            tiles2[t].classList.toggle('active', tiles2[t].getAttribute('data-preset') === active);
        }
        engine.updateVisibleSettings();
        _applyBrushSearch();
        _syncManageButtons();
    };

    /* A floor slider only does something once its parameter has a sensor, so
     * it stays hidden until one is picked. Angle has no floor — it is degrees
     * added to the tip, not a factor scaling it. */
    /* ------------------------------------------------------------------ */
    /*  Curve widget                                                        */
    /* ------------------------------------------------------------------ */

    /* Draws the parameter's actual response — it plots engine.evalCurve, the
     * same function _dyn applies, so there is no second implementation that
     * can drift from what the brush does. Input runs left to right, output
     * bottom to top. */

    var CURVE_HIT = 9;      // px within which a drag grabs an existing point

    function _curvePoints(key) {
        var c = _getCurve(key);
        if (c && c.length >= 2) return c;
        // A gamma curve has no points to drag, so seed the ends.
        return [[0, 0], [1, 1]];
    }

    function _drawCurve(cv) {
        var key = cv.getAttribute('data-dyn-curve');
        var ctx = cv.getContext('2d');
        var W = cv.width, H = cv.height, PAD = 6;
        var iw = W - PAD * 2, ih = H - PAD * 2;
        var cs = getComputedStyle(cv);
        var ink = cs.getPropertyValue('color') || '#1a73e8';

        ctx.clearRect(0, 0, W, H);

        // grid at the quarters
        ctx.strokeStyle = 'rgba(128,132,140,0.28)';
        ctx.lineWidth = 1;
        for (var g = 1; g < 4; g++) {
            var gx = PAD + iw * g / 4, gy = PAD + ih * g / 4;
            ctx.beginPath();
            ctx.moveTo(_round(gx) + 0.5, PAD);
            ctx.lineTo(_round(gx) + 0.5, PAD + ih);
            ctx.moveTo(PAD, _round(gy) + 0.5);
            ctx.lineTo(PAD + iw, _round(gy) + 0.5);
            ctx.stroke();
        }

        // linear reference
        ctx.strokeStyle = 'rgba(128,132,140,0.45)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(PAD, PAD + ih);
        ctx.lineTo(PAD + iw, PAD);
        ctx.stroke();
        ctx.setLineDash([]);

        // the response itself
        ctx.strokeStyle = ink;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (var i = 0; i <= 48; i++) {
            var t = i / 48;
            var v = _evalCurve(key, t);
            var px = PAD + iw * t;
            var py = PAD + ih * (1 - v);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();

        // handles
        var pts = _curvePoints(key);
        ctx.fillStyle = ink;
        for (var j = 0; j < pts.length; j++) {
            ctx.beginPath();
            ctx.arc(PAD + iw * pts[j][0], PAD + ih * (1 - pts[j][1]), 3, 0, _PI * 2);
            ctx.fill();
        }
    }

    function _curveXY(cv, e) {
        var r = cv.getBoundingClientRect();
        var PAD = 6;
        var iw = cv.width - PAD * 2, ih = cv.height - PAD * 2;
        // The canvas is CSS-sized, so client px are not canvas px.
        var sx = cv.width / r.width, sy = cv.height / r.height;
        var x = ((e.clientX - r.left) * sx - PAD) / iw;
        var y = 1 - ((e.clientY - r.top) * sy - PAD) / ih;
        return [_clamp(x, 0, 1), _clamp(y, 0, 1)];
    }

    function _bindCurve(cv) {
        var key = cv.getAttribute('data-dyn-curve');
        var dragIdx = -1;

        function nearest(pt) {
            var pts = _curvePoints(key);
            var PAD = 6;
            var iw = cv.width - PAD * 2, ih = cv.height - PAD * 2;
            var best = -1, bestD = Infinity;
            for (var i = 0; i < pts.length; i++) {
                var dx = (pts[i][0] - pt[0]) * iw, dy = (pts[i][1] - pt[1]) * ih;
                var d = _hypot(dx, dy);
                if (d < bestD) { bestD = d; best = i; }
            }
            return bestD <= CURVE_HIT ? best : -1;
        }

        cv.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            var pt = _curveXY(cv, e);
            var pts = _curvePoints(key);
            var hit = nearest(pt);
            if (hit < 0) {
                // Clicking empty space adds a point there.
                pts.push(pt);
                pts.sort(function (a, b) { return a[0] - b[0]; });
                hit = pts.indexOf(pt);
                _setCurve(key, pts);
            }
            dragIdx = hit;
            cv.setPointerCapture(e.pointerId);
            _drawCurve(cv);
        });

        cv.addEventListener('pointermove', function (e) {
            if (dragIdx < 0) return;
            e.preventDefault();
            var pt = _curveXY(cv, e);
            var pts = _curvePoints(key);
            if (dragIdx >= pts.length) { dragIdx = -1; return; }
            // The first and last points stay pinned to the edges, or the curve
            // would stop covering the whole input range.
            if (dragIdx === 0) pts[0] = [0, pt[1]];
            else if (dragIdx === pts.length - 1) pts[dragIdx] = [1, pt[1]];
            else pts[dragIdx] = pt;
            _setCurve(key, pts);
            _drawCurve(cv);
        });

        function release(e) {
            if (dragIdx < 0) return;
            dragIdx = -1;
            try { cv.releasePointerCapture(e.pointerId); } catch (e_) {}
            _drawCurve(cv);
        }
        cv.addEventListener('pointerup', release);
        cv.addEventListener('pointercancel', release);

        cv.addEventListener('dblclick', function (e) {
            e.preventDefault();
            var pts = _curvePoints(key);
            var hit = nearest(_curveXY(cv, e));
            // Endpoints are what make it a function over the whole range.
            if (hit > 0 && hit < pts.length - 1) {
                pts.splice(hit, 1);
                _setCurve(key, pts);
                _drawCurve(cv);
            }
        });
    }

    function _initCurves() {
        var cvs = document.querySelectorAll('[data-dyn-curve]');
        for (var i = 0; i < cvs.length; i++) {
            _bindCurve(cvs[i]);
            _drawCurve(cvs[i]);
        }
    }

    function _redrawCurves() {
        var cvs = document.querySelectorAll('[data-dyn-curve]');
        for (var i = 0; i < cvs.length; i++) _drawCurve(cvs[i]);
    }

    function _updateDynamicsRows() {
        var mins = document.querySelectorAll('[data-dyn-min]');
        for (var i = 0; i < mins.length; i++) {
            var k = mins[i].getAttribute('data-dyn-min');
            var row = mins[i].closest ? mins[i].closest('.pb-row') : null;
            if (!row) continue;
            var on = _params[k + 'Src'] && _params[k + 'Src'] !== 'none';
            row.style.display = on ? '' : 'none';
            var cv = document.getElementById('pb-' + k + '-curve');
            var crow = cv && cv.closest ? cv.closest('.pb-row') : null;
            if (crow) crow.style.display = on ? '' : 'none';
            if (on && cv) _drawCurve(cv);
        }
    }

    engine.updateVisibleSettings = function () {
        var all = _pbAllRows();
        for (var i = 0; i < all.length; i++) {
            all[i].style.display = '';
        }
        _updateDynamicsRows();
    };

    engine.updateCursor = _updateBrushCursor;
    engine.getCursorOutline = _buildCursorOutline;
    engine.releaseOffscreenBuffers = _releaseOffscreenBuffers;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', engine.initUI);
    } else {
        engine.initUI();
    }

    app.brush = engine;

})(typeof PaintApp !== 'undefined' ? PaintApp : {});
