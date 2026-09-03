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
    var _lerp = function (a, b, t) { return a + (b - a) * t; };
    var _lerpPoint = function (a, b, t) {
        return { x: _lerp(a.x, b.x, t), y: _lerp(a.y, b.y, t) };
    };

    // Stroke-direction EMA smoother (reset per stroke).
    var _smoothAngle = NaN;
    // Module-level dab-distance tracker so preview batches are continuous.
    var _lastDabDist = 0;
    // Stroke smoothing (EMA) state — reset each stroke.
    var _smoothPosX = 0, _smoothPosY = 0;
    var _smoothBuffer = [];
    var _stabilizerX = 0, _stabilizerY = 0;
    var _lastRawX = 0, _lastRawY = 0;
    var _lastStrokeTime = 0, _lastStrokeX = 0, _lastStrokeY = 0, _smoothSpeed = 0;
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

    function _strokeSpeed(x, y) {
        if (_lastStrokeTime === 0) {
            _lastStrokeTime = performance.now();
            _lastStrokeX = x; _lastStrokeY = y;
            _smoothSpeed = 0;
            return 0;
        }
        var now = performance.now();
        var dt = now - _lastStrokeTime;
        if (dt < 4) dt = 4;
        var dx = x - _lastStrokeX, dy = y - _lastStrokeY;
        var raw = _hypot(dx, dy) / dt;
        _smoothSpeed += (raw - _smoothSpeed) * 0.3;
        _lastStrokeTime = now;
        _lastStrokeX = x; _lastStrokeY = y;
        return _smoothSpeed;
    }

    /* ------------------------------------------------------------------ */
    /*  Dab mask generation & cache                                        */
    /* ------------------------------------------------------------------ */
    var _dabCache = (function () {
        var _map = {};
        var _list = [];
        var _bytes = 0;
        var MAX_BYTES = 4 * 1024 * 1024;

        function _key(shape, size, hardness, angle, aspect) {
            return shape + '|' + _round(size) + '|' + _round(hardness) + '|'
                + _round(angle) + '|' + (aspect || 1).toFixed(2);
        }

        return {
            get: function (shape, size, hardness, angle, aspect) {
                var k = _key(shape, size, hardness, angle, aspect);
                var entry = _map[k];
                if (entry) {
                    var idx = _list.indexOf(entry);
                    if (idx > 0) {
                        _list.splice(idx, 1);
                        _list.unshift(entry);
                    }
                    return entry.canvas;
                }
                var canvas = _generateMask(shape, size, hardness, angle, aspect);
                var est = canvas.width * canvas.height * 4;
                entry = { key: k, canvas: canvas, bytes: est };
                _map[k] = entry;
                _list.unshift(entry);
                _bytes += est;
                while (_bytes > MAX_BYTES && _list.length > 1) {
                    var old = _list.pop();
                    delete _map[old.key];
                    _bytes -= old.bytes;
                }
                return canvas;
            },
            clear: function () {
                _map = {};
                _list = [];
                _bytes = 0;
            }
        };
    })();

    function _ceil(v) { return Math.ceil(v); }

    function _generateMask(shape, size, hardness, angleDeg, aspectRatio) {
        var aspect = aspectRatio || 1;
        var w = _max(1, _round(size));
        var h = _max(1, _round(size * aspect));
        if (aspect < 1) { w = _max(1, _round(size * aspect)); h = _max(1, _round(size)); }

        var ang = (angleDeg || 0) * _PI / 180;
        var needRotation = _abs(ang) > 0.001;
        var canvas, ctx, rx, ry;

        if (needRotation) {
            var diag = _ceil(_hypot(w, h));
            canvas = new OffscreenCanvas(diag, diag);
            ctx = canvas.getContext('2d');
            rx = w / 2;
            ry = h / 2;
            ctx.translate(diag / 2, diag / 2);
            ctx.rotate(ang);
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
            case 'circle':
            default: _drawCircle(ctx, rx, ry, hard); break;
        }

        return canvas;
    }

    function _drawCircle(ctx, rx, ry, hard) {
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
        var mid = hard * 0.8 + 0.1;
        grad.addColorStop(0, '#fff');
        grad.addColorStop(mid, '#fff');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(-r, -r, r * 2, r * 2);
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
    var _scratchCanvas = null;
    var _scratchCtx = null;
    var _bgCanvas = null;
    var _bgCtx = null;

    var SHRINK_THRESHOLD = 0.5;
    function _ensureFlowBuffer(w, h) {
        if (!_flowCanvas || _flowCanvas.width < w || _flowCanvas.height < h
            || (_flowCanvas.width > w * 2 && _flowCanvas.width * SHRINK_THRESHOLD > w)) {
            _flowCanvas = new OffscreenCanvas(_max(1, w), _max(1, h));
            _flowCtx = _flowCanvas.getContext('2d');
        }
    }

    function _ensureScratch(w, h) {
        if (!_scratchCanvas || _scratchCanvas.width < w || _scratchCanvas.height < h
            || (_scratchCanvas.width > w * 2 && _scratchCanvas.width * SHRINK_THRESHOLD > w)) {
            _scratchCanvas = new OffscreenCanvas(w, h);
            _scratchCtx = _scratchCanvas.getContext('2d');
        }
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
        _flowCanvas = null; _flowCtx = null;
        _scratchCanvas = null; _scratchCtx = null;
        _bgCanvas = null; _bgCtx = null;
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

    function _colorizeMask(maskCanvas, colorHex) {
        var mw = maskCanvas.width;
        var mh = maskCanvas.height;
        _ensureScratch(mw, mh);
        _scratchCtx.clearRect(0, 0, _scratchCanvas.width, _scratchCanvas.height);
        _scratchCtx.fillStyle = colorHex;
        _scratchCtx.fillRect(0, 0, mw, mh);
        _scratchCtx.globalCompositeOperation = 'destination-in';
        _scratchCtx.drawImage(maskCanvas, 0, 0);
        _scratchCtx.globalCompositeOperation = 'source-over';
    }

    var _noiseCanvas = null;
    function _ensureNoiseCanvas() {
        if (_noiseCanvas) return;
        _noiseCanvas = new OffscreenCanvas(64, 64);
        var ctx = _noiseCanvas.getContext('2d');
        var imgData = ctx.createImageData(64, 64);
        var data = imgData.data;
        for (var i = 0; i < data.length; i += 4) {
            var v = _floor(Math.random() * 200 + 28);
            data[i] = v;
            data[i+1] = v;
            data[i+2] = v;
            data[i+3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
    }

    function _applyTextureNoise(ctx, w, h, textureLevel, textureScale) {
        if (textureLevel <= 0) return;
        _ensureNoiseCanvas();
        var scale = _max(1, textureScale || 4);
        var alpha = (textureLevel / 100) * 0.25;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.globalCompositeOperation = 'source-atop';
        ctx.scale(scale, scale);
        ctx.fillStyle = ctx.createPattern(_noiseCanvas, 'repeat');
        ctx.fillRect(0, 0, _ceil(w / scale), _ceil(h / scale));
        ctx.restore();
    }

    function _paintDab(destCtx, x, y, maskCanvas, colorHex, alpha, texture, textureScale) {
        var mw = maskCanvas.width;
        var mh = maskCanvas.height;
        var ox = x - mw / 2;
        var oy = y - mh / 2;

        _colorizeMask(maskCanvas, colorHex);

        if (texture > 0) {
            _applyTextureNoise(_scratchCtx, mw, mh, texture, textureScale);
        }

        destCtx.save();
        destCtx.globalAlpha = _clamp(alpha, 0, 1);
        destCtx.imageSmoothingEnabled = true;
        destCtx.imageSmoothingQuality = 'high';
        destCtx.drawImage(_scratchCanvas, 0, 0, mw, mh, ox, oy, mw, mh);
        destCtx.restore();

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
    }

    function _sampleCanvasColor(ctx, x, y) {
        if (!ctx) return null;
        var px = _round(x);
        var py = _round(y);
        var c = ctx.canvas;
        if (c && (px < 0 || py < 0 || px >= c.width || py >= c.height)) return null;
        try {
            var data = ctx.getImageData(px, py, 1, 1).data;
            return [data[0], data[1], data[2]];
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
        var canvas = app.ctx && app.ctx.canvas;
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

    function _renderDab(x, y, pressure, colorHex, strokeAngle, rawPressure) {
        var p = getParams();
        var dm = p.dynamicsMode;

        // Angle (base + dynamics)
        var effAngle = p.angle;
        if (dm === 'direction' && strokeAngle != null) {
            effAngle = strokeAngle + p.angle;
        } else if (dm === 'angle') {
            effAngle += (_dabRand(x, y, 0) * 2 - 1) * 180;
        }

        // Size (pressure-modulated + dynamics)
        // rawPressure overrides the taper-baked pressure for size,
        // keeping the brush at full width during taper fade.
        var _sp = rawPressure != null ? rawPressure : pressure;
        var sz = p.size * (0.5 + _sp * 0.5);
        if (dm === 'size') {
            sz *= 1 + (_dabRand(x, y, 1) * 2 - 1);
            sz = _max(0.5, sz);
        }
        if (sz < 0.5) return;

        // Bristle mode: render multiple fiber dabs
        if (p.bristleCount > 1) {
            _renderBristleDabs(x, y, pressure, colorHex, strokeAngle);
            return;
        }

        var finalColor = colorHex;

        // Smudge: sample canvas color and mix with brush color
        if (p.colorRate < 100) {
            var sampled = _sampleCanvasColor(app.ctx, x, y);
            if (sampled) {
                finalColor = _mixColors(sampled, colorHex, p.colorRate);
            }
        }

        // Scatter: random offset from stroke path
        if (p.scatter > 0) {
            var scatterDist = (p.scatter / 100) * sz * _dabRand(x, y, 2);
            var scatterAngle = _dabRand(x, y, 3) * _PI * 2;
            x += _cos(scatterAngle) * scatterDist;
            y += _sin(scatterAngle) * scatterDist;
        }

        var mask;
        if (p.shape === 'custom' && _customTipCanvas) {
            mask = _getCustomTipMask(sz, effAngle, p.aspectRatio, p.hardness);
            if (!mask) mask = _dabCache.get('circle', sz, p.hardness, 0, p.aspectRatio);
        } else {
            mask = _dabCache.get(p.shape, sz, p.hardness, effAngle, p.aspectRatio);
        }

        // Per-dab alpha: flow * pressure + dynamics
        var alpha = (p.flow / 100) * pressure;
        if (dm === 'opacity' || dm === 'flow') {
            alpha *= 1 + (_dabRand(x, y, 4) * 2 - 1);
            alpha = _clamp(alpha, 0, 1);
        }

        _paintDab(_flowCtx, x, y, mask, finalColor, alpha, p.texture, p.textureScale);
    }

    function _renderBristleDabs(x, y, pressure, colorHex, strokeAngle) {
        var p = getParams();
        var dm = p.dynamicsMode;
        var count = _clamp(_round(p.bristleCount), 2, 50);
        var spread = p.bristleSpread * _PI / 180;
        var length = _max(3, p.bristleLength);
        var width = _max(1, p.bristleWidth);

        // Angle (base + dynamics)
        var effAngle = p.angle;
        if (dm === 'direction' && strokeAngle != null) {
            effAngle = strokeAngle + p.angle;
        } else if (dm === 'angle') {
            effAngle += (_dabRand(x, y, 0) * 2 - 1) * 180;
        }

        // Size (pressure-modulated + dynamics)
        var sz = p.size * (0.5 + pressure * 0.5);
        if (dm === 'size') {
            sz *= 1 + (_dabRand(x, y, 1) * 2 - 1);
            sz = _max(0.5, sz);
        }

        var ang = effAngle * _PI / 180;
        var startAngle = ang - spread / 2;

        // Per-dab alpha with flow/opacity dynamics
        var baseAlpha = (p.flow / 100) * _clamp(pressure * 1.2, 0, 1);
        if (dm === 'opacity' || dm === 'flow') {
            baseAlpha *= 1 + (_dabRand(x, y, 2) * 2 - 1);
        }

        if (sz < 2) return;

        // Each bristle is a thin fiber drawn directly onto the flow buffer
        for (var i = 0; i < count; i++) {
            var t = count > 1 ? i / (count - 1) : 0.5;
            var fiberAngle = startAngle + t * spread;

            // Bristle offset from center (spread fan)
            var fanDist = sz * 0.4;
            var fx = _cos(fiberAngle) * fanDist;
            var fy = _sin(fiberAngle) * fanDist;

            // Fiber end point (tip extends outward)
            var tipDist = sz * 0.3 + length * 0.35;
            var tx = fx + _cos(fiberAngle) * tipDist;
            var ty = fy + _sin(fiberAngle) * tipDist;

            var lw = _max(0.5, width * 0.4);

            // Per-bristle opacity: center bristles more opaque, edge ones lighter
            var bAlpha = baseAlpha * (0.5 + 0.5 * (1 - _abs(t - 0.5) * 2));

            var finalColor = colorHex;
            if (p.colorRate < 100) {
                var sampled = _sampleCanvasColor(app.ctx, x + fx, y + fy);
                if (sampled) {
                    finalColor = _mixColors(sampled, colorHex, p.colorRate);
                }
            }

            // Draw fiber line directly on flow buffer
            _flowCtx.save();
            _flowCtx.globalAlpha = _clamp(bAlpha, 0, 1);
            _flowCtx.strokeStyle = finalColor;
            _flowCtx.lineWidth = lw;
            _flowCtx.lineCap = 'round';
            _flowCtx.beginPath();
            _flowCtx.moveTo(x + fx, y + fy);
            _flowCtx.lineTo(x + tx, y + ty);
            _flowCtx.stroke();
            _flowCtx.restore();

            // Extend dirty rect
            var _expand = _max(lw * 2, 4);
            var minX = _min(x + fx, x + tx) - _expand;
            var minY = _min(y + fy, y + ty) - _expand;
            var maxX = _max(x + fx, x + tx) + _expand;
            var maxY = _max(y + fy, y + ty) + _expand;
            if (!_dirtyRect) {
                _dirtyRect = { x1: minX, y1: minY, x2: maxX, y2: maxY };
            } else {
                if (minX < _dirtyRect.x1) _dirtyRect.x1 = minX;
                if (minY < _dirtyRect.y1) _dirtyRect.y1 = minY;
                if (maxX > _dirtyRect.x2) _dirtyRect.x2 = maxX;
                if (maxY > _dirtyRect.y2) _dirtyRect.y2 = maxY;
            }
            // Track accumulated painted area for endStroke background restore
            if (!_clearBounds) {
                _clearBounds = { x1: minX, y1: minY, x2: maxX, y2: maxY };
            } else {
                if (minX < _clearBounds.x1) _clearBounds.x1 = minX;
                if (minY < _clearBounds.y1) _clearBounds.y1 = minY;
                if (maxX > _clearBounds.x2) _clearBounds.x2 = maxX;
                if (maxY > _clearBounds.y2) _clearBounds.y2 = maxY;
            }
        }
    }

    function _flushFlowBuffer(mainCtx, clearFlow) {
        if (!_dirtyRect || !_flowCanvas) return;
        var dr = _dirtyRect;
        var x = _floor(dr.x1);
        var y = _floor(dr.y1);
        var x2 = _ceil(dr.x2);
        var y2 = _ceil(dr.y2);
        var w = x2 - x;
        var h = y2 - y;
        if (w <= 0 || h <= 0) { _dirtyRect = null; return; }
        var opacity = getParams().opacity / 100;
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
        mainCtx.save();
        mainCtx.globalAlpha = opacity;
        mainCtx.drawImage(_flowCanvas, x, y, w, h, x, y, w, h);
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
    var _airbrushTimer = null;
    var _airbrushLastPos = null;
    var _airbrushLastColor = null;

    function _startAirbrush(x, y, color) {
        _stopAirbrush();
        _airbrushLastPos = { x: x, y: y };
        _airbrushLastColor = color;
        var rate = _max(1, getParams().airbrushRate);
        var interval = _max(16, _round(1000 / rate));
        _airbrushTimer = setInterval(function () {
            if (!_state.isDrawing || !_airbrushLastPos) return;
            var pressure = 0.3 + Math.random() * 0.4;
            _renderDab(_airbrushLastPos.x, _airbrushLastPos.y, pressure, _airbrushLastColor);
            if (app.ctx) {
                _flushFlowBuffer(app.ctx);
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
    function _processSegment(points, startIdx, endIdx, colorHex, taperMode) {
        if (endIdx <= startIdx) return;

        var p = getParams();
        var spacing = p.spacing / 100;
        var sz = p.size;
        var step = _max(1.0, sz * spacing);
        // Cumulative pixel distance from stroke start up to this segment.
        var strokeDist = (points[startIdx] && points[startIdx].dist) || 0;

        // Use module-level _lastDabDist for continuous dab tracking across batches.
        if (_lastDabDist == null) _lastDabDist = strokeDist;
        var prev = points[startIdx];
        var segIdx = startIdx;

        // Total stroke distance (used only by final pass).
        var lastPt = points[points.length - 1];
        var totalDist = (lastPt && lastPt.dist) || 0;

        function _taperAtDist(dabDist) {
            if (!taperMode || (p.taperStart <= 0 && p.taperEnd <= 0)) return 1;
            var startPx = (p.taperStart / 100) * sz * 30;
            var endPx   = (p.taperEnd   / 100) * sz * 30;
            var f = 1;
            if (startPx > 0 && dabDist < startPx) {
                var _t = dabDist / startPx;
                f = _t * _t * (3 - 2 * _t);
            }
            if (taperMode >= 2 && endPx > 0 && totalDist > endPx) {
                var fromEnd = totalDist - dabDist;
                if (fromEnd < endPx) {
                    var _t = fromEnd / endPx;
                    f = _min(f, _t * _t * (3 - 2 * _t));
                }
            }
            return _clamp(f, 0, 1);
        }

        var segAngle = 0;

        if (startIdx === 0) {
            var _tp = (prev.pressure || 0.5) * _taperAtDist(strokeDist);
            var _firstAngle;
            if (endIdx > startIdx) {
                var _dx = points[startIdx + 1].x - prev.x, _dy = points[startIdx + 1].y - prev.y;
                if (_hypot(_dx, _dy) >= 0.001) {
                    _firstAngle = Math.atan2(_dy, _dx) * 180 / _PI;
                    _smoothAngle = _firstAngle;
                }
            }
            _renderDab(prev.x, prev.y, _tp, colorHex, _firstAngle, prev.pressure || 0.5);
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
            if (!isNaN(_smoothAngle)) {
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

            if (remaining >= step) {
                var segStartDist = (points[segIdx].dist != null) ? points[segIdx].dist : (nextDist - segLen);
                while (remaining >= step) {
                    var dabDist = _lastDabDist + step;
                    var fr = _clamp((dabDist - segStartDist) / (segLen || 1), 0, 1);
                    var pt = _lerpPoint(prev, next, fr);
                    var _rawPressure = _lerp(prev.pressure || 0.5, next.pressure || 0.5, fr);
                    var pressure = _rawPressure * _taperAtDist(dabDist);
                    _renderDab(pt.x, pt.y, pressure, colorHex, segAngle, _rawPressure);
                    _lastDabDist = dabDist;
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

    /* Re-bake custom tip from raw luminance mask.
       Applies hardness radial falloff and invert, stores in _customTipCanvas. */
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
        for (var i = 0; i < d.length; i += 4) {
            var a = d[i + 3] / 255;
            if (invert) a = 1 - a;
            d[i]     = 0;
            d[i + 1] = 0;
            d[i + 2] = 0;
            d[i + 3] = Math.round(_clamp(a, 0, 1) * 255);
        }
        ox.putImageData(id, 0, 0);
        _customTipCanvas = oc;
    }

    /* Scale the baked custom tip to the given dab size, caching results.
       Returns a white-on-transparent mask canvas compatible with _paintDab. */
    var _customTipSizeCache = {};
    function _getCustomTipMask(sz, angleDeg, aspectRatio, hardness) {
        if (!_customTipCanvas) return null;
        var asp = aspectRatio || 1;
        var hard = (hardness != null ? hardness : 100) / 100;
        var key = _round(sz) + '|' + _round(angleDeg || 0) + '|' + asp.toFixed(2) + '|' + _round(hardness || 100);
        if (_customTipSizeCache[key]) return _customTipSizeCache[key];
        var src = _customTipCanvas;
        var s = _max(1, _round(sz));
        var scale = s / _max(src.width, src.height);
        var w = _max(1, _round(src.width * scale));
        var h = _max(1, _round(src.height * scale));
        if (asp >= 1) {
            h = _max(1, _round(h * asp));
        } else {
            w = _max(1, _round(w * asp));
        }

        // Step 1: create base (unrotated) mask with tip image clipped
        var base = new OffscreenCanvas(w, h);
        var bctx = base.getContext('2d');
        bctx.fillStyle = '#fff';
        bctx.fillRect(0, 0, w, h);
        bctx.globalCompositeOperation = 'destination-in';
        bctx.imageSmoothingQuality = 'high';
        bctx.drawImage(src, 0, 0, w, h);

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

        // Step 2: rotate if needed
        var ang = (angleDeg || 0) * _PI / 180;
        var needRot = _abs(ang) > 0.001;
        if (needRot) {
            var diag = _ceil(_hypot(w, h));
            var dst = new OffscreenCanvas(diag, diag);
            var ctx = dst.getContext('2d');
            ctx.translate(diag / 2, diag / 2);
            ctx.rotate(ang);
            ctx.drawImage(base, -w / 2, -h / 2);
            _customTipSizeCache[key] = dst;
            return dst;
        }

        _customTipSizeCache[key] = base;
        return base;
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
        started: false,
        bounds: null
    };

    var _params = {};
    var _paramMeta = [];

    var _customTipCanvas = null;
    var _customTipRaw = null;
    var _tipInvert = false;
    var _tipHardness = 100;
    var _pendingLoads = [];
    var _strokeSeed = 0;

    function getParams() { return _params; }

    function _activeSmoothingKey() {
        var m = getParams().smoothingMode || 'none';
        if (m === 'basic') return 'smoothingBasic';
        if (m === 'weighted') return 'smoothingWeighted';
        if (m === 'rope') return 'smoothingRope';
        if (m === 'stabilizer') return 'smoothingStabilizer';
        return null;
    }

    function _activeSmoothingValue() {
        var k = _activeSmoothingKey();
        return k ? (getParams()[k] || 0) : 0;
    }

    function _updateSmoothingRow() {
        var row = document.querySelector('.pb-row[data-setting="smoothing"]');
        if (!row) return;
        var active = getParams().smoothingMode && getParams().smoothingMode !== 'none';
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
    function _persistParams() {
        try {
            var keep = {};
            for (var k in _params) {
                if (_params.hasOwnProperty(k) && !_TRANSIENT_KEYS[k]) keep[k] = _params[k];
            }
            localStorage.setItem(STORAGE_PREFIX + engine._currentPreset, JSON.stringify(keep));
        } catch (e_) {}
    }
    function _loadSavedParams(name) {
        try {
            var raw = localStorage.getItem(STORAGE_PREFIX + name);
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
        hardness: 80,
        shape: 'circle',
        angle: 0,
        aspectRatio: 1,
        scatter: 0,
        colorRate: 100,
        airbrushRate: 40,
        airbrushMode: false,
        texture: 0,
        textureScale: 4,
        bristleCount: 1,
        bristleLength: 20,
        bristleWidth: 2,
        bristleSpread: 60,
        taperStart: 0,
        taperEnd: 0,
        dynamicsMode: 'off',
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

    engine.PRESETS = {
        'Round': { size: 12, opacity: 100, flow: 100, spacing: 15, hardness: 80, shape: 'circle' },
        'Calligraphy': { size: 14, opacity: 100, flow: 100, spacing: 10, hardness: 60, shape: 'circle', angle: 45, aspectRatio: 4, taperStart: 10, taperEnd: 10 },
        'Airbrush': { size: 22, opacity: 60, flow: 30, spacing: 10, hardness: 10, shape: 'circle', scatter: 8, airbrushMode: true, airbrushRate: 40 },
        'Ink': { size: 10, opacity: 100, flow: 100, spacing: 8, hardness: 70, shape: 'circle', taperStart: 20, taperEnd: 20, texture: 40, textureScale: 2 },
        'Marker': { size: 16, opacity: 80, flow: 100, spacing: 15, hardness: 100, shape: 'square' },
        'Watercolor': { size: 20, opacity: 80, flow: 40, spacing: 12, hardness: 30, shape: 'circle', scatter: 3, texture: 20, textureScale: 3 },
        'Charcoal': { size: 18, opacity: 90, flow: 100, spacing: 10, hardness: 40, shape: 'circle', texture: 75, textureScale: 3, scatter: 4, angle: 15, aspectRatio: 2 },
        'Splatter': { size: 24, opacity: 80, flow: 100, spacing: 25, hardness: 50, shape: 'circle', scatter: 14, texture: 30 },
        'Fan Brush': { size: 22, opacity: 90, flow: 80, spacing: 12, hardness: 50, shape: 'circle', bristleCount: 12, bristleSpread: 60, taperStart: 8, taperEnd: 8 },
        'Dry Brush': { size: 18, opacity: 80, flow: 80, spacing: 14, hardness: 60, shape: 'circle', bristleCount: 7, bristleSpread: 30, texture: 60, textureScale: 2, taperStart: 6, taperEnd: 6 },
        'Scribbles': { size: 24, opacity: 100, flow: 100, spacing: 10, hardness: 80, shape: 'custom', _tipUrl: 'data:image/png;base64,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' },
        'Abominable Snowman': { size: 28, opacity: 85, flow: 100, spacing: 15, hardness: 80, shape: 'custom', _tipUrl: 'brushes/abominable_snowman.png', scatter: 4 },
        'Bristle': { size: 20, opacity: 90, flow: 100, spacing: 12, hardness: 85, shape: 'custom', _tipUrl: 'brushes/bristle.png' },
        'Bristles Circle Medium': { size: 24, opacity: 95, flow: 100, spacing: 14, hardness: 90, shape: 'custom', _tipUrl: 'brushes/bristles_circle_medium.png' },
        'Bristles Compact Mini': { size: 14, opacity: 95, flow: 100, spacing: 10, hardness: 90, shape: 'custom', _tipUrl: 'brushes/bristles_compact_mini.png' },
        'Chalk': { size: 18, opacity: 85, flow: 100, spacing: 10, hardness: 75, shape: 'custom', _tipUrl: 'brushes/chalk.png', texture: 30, textureScale: 3 },
        'Chalk Round Hard': { size: 14, opacity: 90, flow: 100, spacing: 8, hardness: 90, shape: 'custom', _tipUrl: 'brushes/chalk_round_hard.png' },
        'Chalk Sparse': { size: 22, opacity: 70, flow: 100, spacing: 15, hardness: 60, shape: 'custom', _tipUrl: 'brushes/chalk_sparse.png', scatter: 6 },
        'Chisel Streaks': { size: 16, opacity: 100, flow: 100, spacing: 8, hardness: 90, shape: 'custom', _tipUrl: 'brushes/chisel_streaks.png', angle: 45, aspectRatio: 4, taperStart: 10, taperEnd: 10 },
        'Deevad Painterly': { size: 26, opacity: 90, flow: 100, spacing: 12, hardness: 85, shape: 'custom', _tipUrl: 'brushes/deevad-painterly-brush-tip_2023C.png' },
        'Flat Tip Dirty': { size: 20, opacity: 85, flow: 100, spacing: 10, hardness: 80, shape: 'custom', _tipUrl: 'brushes/flat-tip-dirty.png', texture: 20, textureScale: 3 },
        'Splat Dots': { size: 28, opacity: 80, flow: 100, spacing: 20, hardness: 80, shape: 'custom', _tipUrl: 'brushes/splat_dots.png', scatter: 12 },
        'Square Rough': { size: 18, opacity: 90, flow: 100, spacing: 12, hardness: 80, shape: 'custom', _tipUrl: 'brushes/square_rough_lightgrey.png' }
    };

    engine.presetNames = [];
    for (var name in engine.PRESETS) {
        if (engine.PRESETS.hasOwnProperty(name)) {
            engine.presetNames.push(name);
        }
    }

    engine._currentPreset = 'Round';

    // Per-preset map of "Relevant" data-setting keys (the rest go to Advanced).
    // size + opacity are always visible regardless of this map.
    var PB_RELEVANT = {
        'Round':       { size:1, opacity:1, hardness:1, spacing:1 },
        'Calligraphy': { size:1, opacity:1, shape:1, angle:1, aspectRatio:1, spacing:1 },
        'Airbrush':    { size:1, opacity:1, airbrushMode:1, flow:1, hardness:1 },
        'Ink':         { size:1, opacity:1, flow:1, taperStart:1, taperEnd:1, texture:1 },
        'Marker':      { size:1, opacity:1, flow:1, hardness:1, spacing:1 },
        'Watercolor':  { size:1, opacity:1, colorRate:1, flow:1, hardness:1 },
        'Charcoal':    { size:1, opacity:1, shape:1, angle:1, texture:1, textureScale:1 },
        'Splatter':    { size:1, opacity:1, scatter:1, spacing:1, flow:1 },
        'Fan Brush':   { size:1, opacity:1, bristleCount:1, bristleWidth:1, bristleSpread:1, bristleLength:1 },
        'Dry Brush':   { size:1, opacity:1, bristleCount:1, bristleWidth:1, bristleSpread:1, bristleLength:1, flow:1 },
        'Scribbles':   { size:1, opacity:1, spacing:1, hardness:1, flow:1 },
        'Abominable Snowman': { size:1, opacity:1, spacing:1, hardness:1, flow:1, scatter:1 },
        'Bristle': { size:1, opacity:1, spacing:1, hardness:1, flow:1 },
        'Bristles Circle Medium': { size:1, opacity:1, spacing:1, hardness:1, flow:1 },
        'Bristles Compact Mini': { size:1, opacity:1, spacing:1, hardness:1, flow:1 },
        'Chalk': { size:1, opacity:1, spacing:1, hardness:1, flow:1, texture:1, textureScale:1 },
        'Chalk Round Hard': { size:1, opacity:1, spacing:1, hardness:1, flow:1 },
        'Chalk Sparse': { size:1, opacity:1, spacing:1, hardness:1, flow:1, scatter:1 },
        'Chisel Streaks': { size:1, opacity:1, angle:1, aspectRatio:1, spacing:1, taperStart:1, taperEnd:1 },
        'Deevad Painterly': { size:1, opacity:1, spacing:1, hardness:1, flow:1 },
        'Flat Tip Dirty': { size:1, opacity:1, spacing:1, hardness:1, flow:1, texture:1, textureScale:1 },
        'Splat Dots': { size:1, opacity:1, spacing:1, hardness:1, flow:1, scatter:1 },
        'Square Rough': { size:1, opacity:1, spacing:1, hardness:1, flow:1 }
    };

    engine.loadCustomTip = function (url) {
        console.log('[KritaEngine] loadCustomTip called with:', url);
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
        img.onload = function () {
            try {
                console.log('[KritaEngine] Tip image loaded:', img.width + 'x' + img.height);
                var oc = new OffscreenCanvas(img.width, img.height);
                var ox = oc.getContext('2d');
                ox.drawImage(img, 0, 0);
                var id = ox.getImageData(0, 0, oc.width, oc.height);
                var d = id.data;
                for (var i = 0; i < d.length; i += 4) {
                    var lum  = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
                    var srcA = d[i + 3] / 255;
                    d[i]     = 0;
                    d[i + 1] = 0;
                    d[i + 2] = 0;
                    d[i + 3] = Math.round((1 - lum) * srcA * 255);
                }
                ox.putImageData(id, 0, 0);
                _customTipRaw = oc;
                _rebakeTip();
                _params.shape = 'custom';
                _customTipSizeCache = {};
                console.log('[KritaEngine] Custom tip baked, shape set to custom');
                engine.syncPanel();
            } catch (e) {
                console.error('[KritaEngine] Error processing custom tip:', e);
            }
            _cleanup();
        };
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
    };

    engine.loadPreset = function (name) {
        var preset = engine.PRESETS[name];
        if (!preset) return false;
        for (var i = 0; i < _paramMeta.length; i++) {
            var k = _paramMeta[i];
            _params[k] = (k in preset) ? preset[k] : engine.DEFAULTS[k];
        }
        engine._currentPreset = name;
        _loadSavedParams(name);

        // If preset has a custom tip URL, load it asynchronously.
        // _params.shape is already 'custom' from the preset — _renderDab
        // will fall back to a circle mask if _customTipCanvas is still null.
        if (preset._tipUrl) {
            console.log('[KritaEngine] Preset', name, 'has _tipUrl:', preset._tipUrl);
            engine.loadCustomTip(preset._tipUrl);
        }

        return true;
    };

    engine.setParam = function (key, value) {
        _params[key] = value;
        _persistParams();
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
        _strokeSeed = Math.floor(Math.random() * 2147483647);
        _smoothAngle = NaN;
        _lastDabDist = 0;
        _smoothPosX = x; _smoothPosY = y;
        _smoothBuffer = [];
        _lastStrokeTime = 0;
        _lazyX = x; _lazyY = y;
        _stabilizerX = x; _stabilizerY = y;
        _lastRawX = x; _lastRawY = y;
        if (_state.paintRaf) {
            cancelAnimationFrame(_state.paintRaf);
            _state.paintRaf = null;
        }
        _state.isDrawing = true;
        _state.strokePoints = [{ x: x, y: y, pressure: pressure || 0.5, color: color, dist: 0 }];
        _state.lastColor = color;
        _state.lastProcessedIdx = 0;
        _state.started = false;
        _state.bounds = { x1: x, y1: y, x2: x, y2: y };
        var cw = app.config ? app.config.width : 1024;
        var ch = app.config ? app.config.height : 1024;
        _ensureFlowBuffer(cw, ch);
        _flowCtx.clearRect(0, 0, _flowCanvas.width, _flowCanvas.height);
        _dirtyRect = null;
        _clearBounds = null;
        _ensureBgCanvas(cw, ch);
        _bgCtx.clearRect(0, 0, _bgCanvas.width, _bgCanvas.height);
        try {
            _bgCtx.drawImage(app.ctx.canvas, 0, 0);
        } catch (e) {
            console.warn('[brush] bgCanvas capture failed:', e);
        }

        if (getParams().airbrushMode) {
            _startAirbrush(x, y, color);
        }
        _hideRopeSvg();
    };

    engine.moveStroke = function (x, y, pressure, color) {
        if (!_state.isDrawing) return;
        _lastRawX = x; _lastRawY = y;
        var p2 = getParams();
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
        pts.push({ x: x, y: y, pressure: pressure || 0.5, color: color, dist: dist });
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
        _clearBounds = null;
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
        if (wasDrawing && app.saveState && typeof app.saveState === 'function') {
            app.saveState();
        }
    };

    function _flushPending(final) {
        var pts = _state.strokePoints;
        if (pts.length < 1 || !_state.lastColor) return;
        if (final) {
            _ensureFlowBuffer(
                (app.config ? app.config.width : 1024),
                (app.config ? app.config.height : 1024)
            );
            if (_flowCtx) _flowCtx.clearRect(0, 0, _flowCanvas.width, _flowCanvas.height);
            _dirtyRect = null;
            _state.lastProcessedIdx = 0;
            _state.started = false;
            _smoothAngle = NaN;
            _lastDabDist = 0;
            if (pts.length === 1) {
                _renderDab(pts[0].x, pts[0].y, pts[0].pressure || 0.5, _state.lastColor);
            } else {
                _processSegment(pts, 0, pts.length - 1, _state.lastColor, 2);
            }
        } else {
            var startIdx = _state.started ? _state.lastProcessedIdx : 0;
            if (startIdx >= pts.length - 1) {
                if (pts.length === 1 || startIdx === 0) {
                    _renderDab(pts[0].x, pts[0].y, pts[0].pressure || 0.5, _state.lastColor);
                }
            } else {
                _processSegment(pts, startIdx, pts.length - 1, _state.lastColor, 0);
            }
        }
        if (app.ctx) {
            _flushFlowBuffer(app.ctx);
        }
    }

    function _schedulePaint() {
        if (_state.paintRaf) return;
        _state.paintRaf = requestAnimationFrame(function () {
            _state.paintRaf = null;
            var pts = _state.strokePoints;
            if (pts.length < 2 || !_state.lastColor) return;
            var startIdx = _state.started ? _state.lastProcessedIdx : 0;
            var endIdx = pts.length - 1;
            if (startIdx < endIdx) {
                _processSegment(pts, startIdx, endIdx, _state.lastColor, 1);
                _state.lastProcessedIdx = endIdx;
                _state.started = true;
                if (app.ctx) {
                    _flushFlowBuffer(app.ctx);
                }
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

    function _ensurePreviewTip(name, callback) {
        if (_previewTipCache[name] !== undefined) { if (callback) callback(); return; }
        var preset = engine.PRESETS[name];
        if (!preset || !preset._tipUrl) { _previewTipCache[name] = null; if (callback) callback(); return; }
        var url = preset._tipUrl;
        var img = new Image();
        img.onload = function () {
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
                _previewTipCache[name] = oc;
            } catch (e) {
                _previewTipCache[name] = null;
            }
            if (callback) callback();
        };
        img.onerror = function () {
            _previewTipCache[name] = null;
            if (callback) callback();
        };
        img.src = url;
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

    function _drawPreviewStroke(ctx, size, p) {
        var yBase = _round(size * 0.78);
        var margin = _round(size * 0.12);
        var xStart = margin;
        var xEnd = size - margin;
        var brushSize = _min(p.size || 8, _round(size * 0.12));
        var spacing = ((p.spacing != null ? p.spacing : 20)) / 100;
        var step = _max(0.5, brushSize * spacing);
        var totalDist = xEnd - xStart;
        var numDabs = _max(2, _round(totalDist / step));
        var actualStep = totalDist / (numDabs - 1);
        var scatter = p.scatter || 0;
        var shape = p.shape || 'circle';
        var hardness = (p.hardness != null) ? p.hardness : 80;
        var angle = p.angle || 0;
        var aspect = p.aspectRatio || 1;
        var waveAmp = _round(size * 0.04);
        for (var i = 0; i < numDabs; i++) {
            var t = i / (numDabs - 1);
            var x = _round(xStart + i * actualStep);
            var wave = _sin(t * _PI * 2) * waveAmp;
            var jitter = (scatter / 100) * brushSize * 0.5 * (_sin(i * 137.5) - 0.5);
            var s = shape === 'custom' ? 'circle' : shape;
            var dab = _dabCache.get(s, brushSize, hardness, angle, aspect);
            if (dab) {
                ctx.drawImage(dab, _round(x - dab.width / 2), _round(yBase + wave + jitter - dab.height / 2));
            }
        }
    }

    function _pbRenderPreview(name, size) {
        var preset = engine.PRESETS[name];
        if (!preset) return null;
        size = size || 72;

        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        // Subtle checkerboard background
        _drawCheckerboard(ctx, size);

        var p = preset;
        var brushSize = _clamp(p.size || 8, 2, _round(size * 0.5));
        var hardness = (p.hardness != null) ? p.hardness : 80;
        var angle = p.angle || 0;
        var aspect = p.aspectRatio || 1;
        var shape = p.shape || 'circle';

        // Build white mask on temp canvas (so tint doesn't affect background)
        var maskCanvas = document.createElement('canvas');
        maskCanvas.width = size;
        maskCanvas.height = size;
        var maskCtx = maskCanvas.getContext('2d');
        maskCtx.imageSmoothingEnabled = true;

        // Centered tip dab
        var dabSize = _min(brushSize, _round(size * 0.42));
        var dabCx = size / 2;
        var dabCy = _round(size * 0.35);

        if (shape === 'custom' && _previewTipCache[name]) {
            var tip = _previewTipCache[name];
            var s = _max(1, dabSize);
            var sc = s / _max(tip.width, tip.height);
            var tw = _max(1, _round(tip.width * sc));
            var th = _max(1, _round(tip.height * sc));
            if (aspect >= 1) {
                th = _max(1, _round(th * aspect));
            } else {
                tw = _max(1, _round(tw * aspect));
            }
            maskCtx.save();
            maskCtx.translate(dabCx, dabCy);
            maskCtx.rotate(angle * _PI / 180);
            maskCtx.fillStyle = '#fff';
            maskCtx.fillRect(-tw / 2, -th / 2, tw, th);
            maskCtx.globalCompositeOperation = 'destination-in';
            maskCtx.drawImage(tip, -tw / 2, -th / 2, tw, th);
            maskCtx.restore();
        } else {
            var s = shape === 'custom' ? 'circle' : shape;
            var dab = _dabCache.get(s, dabSize, hardness, angle, aspect);
            if (dab) {
                maskCtx.drawImage(dab, _round(dabCx - dab.width / 2), _round(dabCy - dab.height / 2));
            }
        }

        // Stroke sample
        _drawPreviewStroke(maskCtx, size, p);

        // Tint mask with preset-specific hue
        var hue = 0;
        for (var ci = 0; ci < name.length; ci++) {
            hue += name.charCodeAt(ci);
        }
        hue = (hue * 137.5) % 360;
        maskCtx.globalCompositeOperation = 'source-in';
        maskCtx.fillStyle = 'hsl(' + hue + ', 35%, 18%)';
        maskCtx.fillRect(0, 0, size, size);

        // Composite mask onto checkerboard background
        ctx.drawImage(maskCanvas, 0, 0);
        return canvas;
    }

    engine.refreshPreview = function () {
        // No-op: the brush grid tiles replace the legacy pb-preview canvas.
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
            'pb-airbrushRate': 'airbrushRate',
            'pb-bristleCount': 'bristleCount',
            'pb-bristleLength': 'bristleLength',
            'pb-bristleWidth': 'bristleWidth',
            'pb-bristleSpread': 'bristleSpread',
            'pb-scatter': 'scatter',
            'pb-taperStart': 'taperStart',
            'pb-taperEnd': 'taperEnd',
            'pb-texture': 'texture',
            'pb-textureScale': 'textureScale',
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
        var dynEl = document.getElementById('pb-dynamics');
        if (dynEl) dynEl.value = _params.dynamicsMode;
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
            'pb-airbrushRate': 'airbrushRate',
            'pb-bristleCount': 'bristleCount',
            'pb-bristleLength': 'bristleLength',
            'pb-bristleWidth': 'bristleWidth',
            'pb-bristleSpread': 'bristleSpread',
            'pb-scatter': 'scatter',
            'pb-taperStart': 'taperStart',
            'pb-taperEnd': 'taperEnd',
            'pb-texture': 'texture',
            'pb-textureScale': 'textureScale',
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
            airbrushMode: 'Keep painting while holding the brush still',
            airbrushRate: 'Paint flow rate when airbrush mode is active',
            bristleCount: 'Number of individual bristle splits',
            bristleLength: 'Length of each bristle',
            bristleWidth: 'Width of each bristle',
            bristleSpread: 'Angular spread of bristles from center',
            scatter: 'Random offset of each dab from the stroke path',
            taperStart: 'Taper amount at the start of the stroke',
            taperEnd: 'Taper amount at the end of the stroke',
            texture: 'Opacity of paper texture grain overlaid on the stroke',
            textureScale: 'Scale of the paper texture pattern',
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

        var dynEl = document.getElementById('pb-dynamics');
        if (dynEl) {
            dynEl.addEventListener('change', function () {
                engine.setParam('dynamicsMode', this.value);
            });
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
        engine.loadPreset(engine._currentPreset);
        engine.syncPanel();
        _updateBrushCursor();
    };

    engine.generatePreview = function (name) { return _pbRenderPreview(name, 66); };

    engine.resetCurrentPreset = function () {
        try { localStorage.removeItem(STORAGE_PREFIX + engine._currentPreset); } catch (e_) {}
        engine.loadPreset(engine._currentPreset);
        engine.syncPanel();
    };

    engine.buildBrushGrid = function () {
        var grid = document.getElementById('pb-brush-grid');
        var label = document.getElementById('pb-active-name');
        if (!grid) return;
        while (grid.firstChild) grid.removeChild(grid.firstChild);

        var names = engine.presetNames || Object.keys(engine.PRESETS);
        var tiles = {};
        for (var i = 0; i < names.length; i++) {
            (function (name) {
                var tile = document.createElement('div');
                tile.className = 'pb-brush-tile';
                tile.title = name;
                tile.setAttribute('data-preset', name);
                var c = engine.generatePreview(name);
                if (c) tile.appendChild(c);
                tile.addEventListener('click', function () {
                    engine.loadPreset(name);
                    engine.syncPanel();
                    engine.updateVisibleSettings();
                    var tiles2 = document.querySelectorAll('.pb-brush-tile');
                    for (var t = 0; t < tiles2.length; t++) {
                        tiles2[t].classList.toggle('active', tiles2[t].getAttribute('data-preset') === name);
                    }
                    if (label) label.textContent = name;
                    try { _updateBrushCursor && _updateBrushCursor(); } catch (e_) {}
                });
                grid.appendChild(tile);
                tiles[name] = tile;
            })(names[i]);
        }

        // Async load custom tip images and regenerate previews
        for (var j = 0; j < names.length; j++) {
            (function (name) {
                if (engine.PRESETS[name] && engine.PRESETS[name]._tipUrl) {
                    _ensurePreviewTip(name, function () {
                        var tile = tiles[name];
                        if (tile) {
                            var oldCanvas = tile.querySelector('canvas');
                            if (oldCanvas) tile.removeChild(oldCanvas);
                            var c = engine.generatePreview(name);
                            if (c) tile.insertBefore(c, tile.firstChild);
                        }
                    });
                }
            })(names[j]);
        }

        var active = engine._currentPreset || names[0];
        if (label) label.textContent = active;
        var tiles2 = grid.querySelectorAll('.pb-brush-tile');
        for (var t = 0; t < tiles2.length; t++) {
            tiles2[t].classList.toggle('active', tiles2[t].getAttribute('data-preset') === active);
        }
        engine.updateVisibleSettings();
    };

    engine.updateVisibleSettings = function () {
        var all = _pbAllRows();
        for (var i = 0; i < all.length; i++) {
            all[i].style.display = '';
        }
    };

    engine.updateCursor = _updateBrushCursor;
    engine.releaseOffscreenBuffers = _releaseOffscreenBuffers;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', engine.initUI);
    } else {
        engine.initUI();
    }

    app.brush = engine;

})(typeof PaintApp !== 'undefined' ? PaintApp : {});
