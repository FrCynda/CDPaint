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
    var _lerp = function (a, b, t) { return a + (b - a) * t; };
    var _lerpPoint = function (a, b, t) {
        return { x: _lerp(a.x, b.x, t), y: _lerp(a.y, b.y, t) };
    };

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
        var ox = _round(x - mw / 2);
        var oy = _round(y - mh / 2);

        _colorizeMask(maskCanvas, colorHex);

        if (texture > 0) {
            _applyTextureNoise(_scratchCtx, mw, mh, texture, textureScale);
        }

        destCtx.save();
        destCtx.globalAlpha = _clamp(alpha, 0, 1);
        destCtx.drawImage(_scratchCanvas, ox, oy);
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
        var sz = _params.size;
        if (sz <= 2) {
            if (app.ui && app.ui.stage) app.ui.stage.style.cursor = 'crosshair';
            return;
        }
        if (_cursorCache.size === sz && _cursorCache.url) {
            if (app.ui && app.ui.stage) {
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
        if (app.ui && app.ui.stage) {
            app.ui.stage.style.cursor = 'url("' + url + '") ' + Math.round(cx) + ' ' + Math.round(cy) + ', crosshair';
        }
    }

    function _renderDab(x, y, pressure, colorHex) {
        var p = getParams();
        var sz = p.size * (0.5 + pressure * 0.5);
        if (sz < 0.5) return;

        // Bristle mode: render multiple fiber dabs
        if (p.bristleCount > 1) {
            _renderBristleDabs(x, y, pressure, colorHex);
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
            var scatterDist = (p.scatter / 100) * sz * Math.random();
            var scatterAngle = Math.random() * _PI * 2;
            x += _cos(scatterAngle) * scatterDist;
            y += _sin(scatterAngle) * scatterDist;
        }

        var mask = _dabCache.get(p.shape, sz, p.hardness, p.angle, p.aspectRatio);
        var alpha = (p.flow / 100) * pressure;
        _paintDab(_flowCtx, x, y, mask, finalColor, alpha, p.texture, p.textureScale);
    }

    function _renderBristleDabs(x, y, pressure, colorHex) {
        var p = getParams();
        var count = _clamp(_round(p.bristleCount), 2, 50);
        var spread = p.bristleSpread * _PI / 180;
        var length = _max(3, p.bristleLength);
        var width = _max(1, p.bristleWidth);
        var sz = p.size * (0.5 + pressure * 0.5);
        var ang = p.angle * _PI / 180;
        var startAngle = ang - spread / 2;
        var baseAlpha = (p.flow / 100) * _clamp(pressure * 1.2, 0, 1);

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
        }
    }

    function _flushFlowBuffer(mainCtx) {
        if (!_dirtyRect || !_flowCanvas) return;
        var dr = _dirtyRect;
        var w = dr.x2 - dr.x1;
        var h = dr.y2 - dr.y1;
        if (w <= 0 || h <= 0) { _dirtyRect = null; return; }
        var opacity = getParams().opacity / 100;
        mainCtx.save();
        mainCtx.globalAlpha = opacity;
        mainCtx.drawImage(_flowCanvas, dr.x1, dr.y1, w, h, dr.x1, dr.y1, w, h);
        mainCtx.restore();
        _flowCtx.clearRect(dr.x1, dr.y1, w, h);
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
    function _processSegment(points, startIdx, endIdx, colorHex, useTaper) {
        if (endIdx <= startIdx) return;

        var p = getParams();
        var spacing = p.spacing / 100;
        var sz = p.size;
        var step = _max(0.5, sz * spacing);
        var totalPts = points.length;

        var soFar = 0;
        var prev = points[startIdx];
        var segIdx = startIdx;

        function _taperAt(idx) {
            if (!useTaper || (p.taperStart <= 0 && p.taperEnd <= 0)) return 1;
            var t = totalPts > 1 ? idx / (totalPts - 1) : 0.5;
            var f = 1;
            if (p.taperStart > 0 && t < p.taperStart / 100) {
                f = t / (p.taperStart / 100);
            }
            if (p.taperEnd > 0 && t > 1 - p.taperEnd / 100) {
                f = _min(f, (1 - t) / (p.taperEnd / 100));
            }
            return _clamp(f, 0, 1);
        }

        if (startIdx === 0) {
            var _tp = (prev.pressure || 0.5) * _taperAt(segIdx);
            _renderDab(prev.x, prev.y, _tp, colorHex);
        }

        while (segIdx < endIdx) {
            var next = points[segIdx + 1];
            var segLen = _hypot(next.x - prev.x, next.y - prev.y);

            if (segLen < 0.001) {
                segIdx++;
                prev = next;
                continue;
            }

            var remaining = segLen - soFar;
            if (remaining <= 0) {
                soFar = 0;
                segIdx++;
                prev = next;
                continue;
            }

            if (remaining < step) {
                soFar += remaining;
                segIdx++;
                prev = next;
                continue;
            }

            var pr = _clamp((soFar + step) / segLen, 0, 1);
            var pt = _lerpPoint(prev, next, pr);
            var pressure = (_lerp(prev.pressure || 0.5, next.pressure || 0.5, pr)) * _taperAt(segIdx + pr);
            _renderDab(pt.x, pt.y, pressure, colorHex);
            soFar += step;
        }
        // Force dab at segment endpoint to avoid cut-off tips
        if (soFar > 0) {
            var lastPt = points[segIdx];
            var lastPressure = lastPt.pressure || 0.5;
            _renderDab(lastPt.x, lastPt.y, lastPressure * _taperAt(segIdx), colorHex);
        }
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
        started: false
    };

    var _params = {};
    var _paramMeta = [];

    function getParams() { return _params; }

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
        taperEnd: 0
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
        'Dry Brush': { size: 18, opacity: 80, flow: 80, spacing: 14, hardness: 60, shape: 'circle', bristleCount: 7, bristleSpread: 30, texture: 60, textureScale: 2, taperStart: 6, taperEnd: 6 }
    };

    engine.presetNames = [];
    for (var name in engine.PRESETS) {
        if (engine.PRESETS.hasOwnProperty(name)) {
            engine.presetNames.push(name);
        }
    }

    engine._currentPreset = 'Round';

    engine.loadPreset = function (name) {
        var preset = engine.PRESETS[name];
        if (!preset) return false;
        for (var i = 0; i < _paramMeta.length; i++) {
            var k = _paramMeta[i];
            _params[k] = (k in preset) ? preset[k] : engine.DEFAULTS[k];
        }
        engine._currentPreset = name;
        return true;
    };

    engine.setParam = function (key, value) {
        _params[key] = value;
    };

    engine.getParams = getParams;

    engine.beginStroke = function (x, y, pressure, color) {
        if (_state.paintRaf) {
            cancelAnimationFrame(_state.paintRaf);
            _state.paintRaf = null;
        }
        _state.isDrawing = true;
        _state.strokePoints = [{ x: x, y: y, pressure: pressure || 0.5, color: color }];
        _state.lastColor = color;
        _state.lastProcessedIdx = 0;
        _state.started = false;
        var cw = app.config ? app.config.width : 1024;
        var ch = app.config ? app.config.height : 1024;
        _ensureFlowBuffer(cw, ch);
        _flowCtx.clearRect(0, 0, _flowCanvas.width, _flowCanvas.height);
        _dirtyRect = null;
        _ensureBgCanvas(cw, ch);
        _bgCtx.drawImage(app.ctx.canvas, 0, 0);

        if (getParams().airbrushMode) {
            _startAirbrush(x, y, color);
        }
    };

    engine.moveStroke = function (x, y, pressure, color) {
        if (!_state.isDrawing) return;
        _state.strokePoints.push({ x: x, y: y, pressure: pressure || 0.5, color: color });
        _state.lastColor = color;
        if (getParams().airbrushMode) {
            _airbrushLastPos = { x: x, y: y };
            _airbrushLastColor = color;
        }
        _schedulePaint();
    };

    engine.endStroke = function () {
        _state.isDrawing = false;
        _stopAirbrush();
        if (_state.paintRaf) {
            cancelAnimationFrame(_state.paintRaf);
            _state.paintRaf = null;
        }
        // Restore pre-stroke background in stroke area (removes RAF dabs)
        var pts = _state.strokePoints;
        if (pts.length > 0 && app.ctx && _bgCanvas) {
            var p = getParams();
            var margin = p.size + (p.scatter || 0) + 6;
            var bx1 = pts[0].x, by1 = pts[0].y, bx2 = pts[0].x, by2 = pts[0].y;
            for (var pi = 1; pi < pts.length; pi++) {
                if (pts[pi].x < bx1) bx1 = pts[pi].x;
                if (pts[pi].y < by1) by1 = pts[pi].y;
                if (pts[pi].x > bx2) bx2 = pts[pi].x;
                if (pts[pi].y > by2) by2 = pts[pi].y;
            }
            // Clamp restore to canvas bounds — negative source coords to
            // drawImage throw IndexSizeError, silently skipping the final
            // _flushPending pass and leaving the stroke nearly invisible.
            var cw2 = _bgCanvas.width, ch2 = _bgCanvas.height;
            var rx = _max(0, bx1 - margin);
            var ry = _max(0, by1 - margin);
            var rw = _min(cw2 - rx, bx2 + margin - rx);
            var rh = _min(ch2 - ry, by2 + margin - ry);
            rw = _ceil(_max(0, rw));
            rh = _ceil(_max(0, rh));
            if (rw > 0 && rh > 0) {
                _ensureScratch(rw, rh);
                _scratchCtx.drawImage(_bgCanvas, rx, ry, rw, rh, 0, 0, rw, rh);
                app.ctx.drawImage(_scratchCanvas, 0, 0, rw, rh, rx, ry, rw, rh);
            }
        }
        _flushPending(true);
        _state.strokePoints = [];
        _state.lastProcessedIdx = 0;
        if (app.saveState && typeof app.saveState === 'function') {
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
            if (pts.length === 1) {
                _renderDab(pts[0].x, pts[0].y, pts[0].pressure || 0.5, _state.lastColor);
            } else {
                for (var si = 0; si < pts.length - 1; si++) {
                    _processSegment(pts, si, si + 1, _state.lastColor, true);
                }
            }
        } else {
            var startIdx = _state.started ? _state.lastProcessedIdx : 0;
            if (startIdx >= pts.length - 1) {
                if (pts.length === 1 || startIdx === 0) {
                    _renderDab(pts[0].x, pts[0].y, pts[0].pressure || 0.5, _state.lastColor);
                }
            } else {
                _processSegment(pts, startIdx, pts.length - 1, _state.lastColor, false);
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
                _processSegment(pts, startIdx, endIdx, _state.lastColor, false);
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
    engine.refreshPreview = function () {
        var canvas = document.getElementById('pb-preview');
        if (!canvas) return;
        var ctx = canvas.getContext('2d');
        var w = canvas.width, h = canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        var sz = _params.size;
        var r = _max(2, sz * 0.5);
        var cx = 30, cy = h / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(_params.angle * _PI / 180);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, _PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,' + (_params.opacity / 100) + ')';
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = '#ccc';
        ctx.lineWidth = 1;
        ctx.stroke();
        var label = engine._currentPreset + ' (' + sz + 'px)';
        ctx.fillStyle = '#333';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 55, cy);
        var mode = _params.airbrushMode ? 'Airbrush' : (_params.colorRate < 100 ? 'Smudge' : 'Paint');
        ctx.fillText(mode + ' | Spacing: ' + _round(_params.spacing) + '%', 55, cy + 14);
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
            'pb-bristleSpread': 'bristleSpread'
        };
        for (var id in els) {
            if (!els.hasOwnProperty(id)) continue;
            var el = document.getElementById(id);
            var valEl = document.getElementById(id + '-val');
            if (el) el.value = _params[els[id]];
            if (valEl) valEl.textContent = _params[els[id]];
        }
        var shapeEl = document.getElementById('pb-shape');
        if (shapeEl) shapeEl.value = _params.shape;
        var airbrushEl = document.getElementById('pb-airbrushMode');
        if (airbrushEl) airbrushEl.checked = !!_params.airbrushMode;
        var presetEl = document.getElementById('pb-preset');
        if (presetEl) presetEl.value = engine._currentPreset;
        engine.refreshPreview();
        engine._toggleAirbrushUI();
        _updateBrushCursor();
    };

    engine._toggleAirbrushUI = function () {
        var rateRow = document.getElementById('pb-airbrushRate-row');
        if (rateRow) {
            rateRow.style.display = _params.airbrushMode ? 'flex' : 'none';
        }
    };

    engine.initUI = function () {
        var presetEl = document.getElementById('pb-preset');
        if (presetEl) {
            presetEl.addEventListener('change', function () {
                engine.loadPreset(this.value);
                engine.syncPanel();
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
            'pb-bristleSpread': 'bristleSpread'
        };

        for (var id in sliderMap) {
            if (!sliderMap.hasOwnProperty(id)) continue;
            (function (sliderId, paramKey) {
                var el = document.getElementById(sliderId);
                var valEl = document.getElementById(sliderId + '-val');
                if (!el) return;
                el.addEventListener('input', function () {
                    var v = parseFloat(this.value);
                    engine.setParam(paramKey, v);
                    if (valEl) valEl.textContent = v;
                    engine.refreshPreview();
                });
            })(id, sliderMap[id]);
        }

        var shapeEl = document.getElementById('pb-shape');
        if (shapeEl) {
            shapeEl.addEventListener('change', function () {
                engine.setParam('shape', this.value);
                engine.refreshPreview();
            });
        }

        var airbrushEl = document.getElementById('pb-airbrushMode');
        if (airbrushEl) {
            airbrushEl.addEventListener('change', function () {
                engine.setParam('airbrushMode', this.checked);
                engine._toggleAirbrushUI();
                engine.refreshPreview();
            });
        }

        var collapseBtn = document.getElementById('paintbrush-collapse-btn');
        if (collapseBtn) {
            collapseBtn.addEventListener('click', function () {
                var sb = document.getElementById('paintbrush-sidebar');
                if (sb) {
                    sb.classList.remove('open');
                    sb.classList.add('hidden');
                }
            });
        }

        engine.syncPanel();
        _updateBrushCursor();
    };

    engine.updateCursor = _updateBrushCursor;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', engine.initUI);
    } else {
        engine.initUI();
    }

    app.brush = engine;

})(typeof PaintApp !== 'undefined' ? PaintApp : {});
