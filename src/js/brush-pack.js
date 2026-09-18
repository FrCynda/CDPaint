/* Reading brush packs made for other programs.
 *
 * A Krita pack (.bundle) is an ordinary ZIP holding paintoppresets/*.kpp,
 * brushes/* and a manifest. A .kpp is not a settings file at all: it is a
 * PNG thumbnail -- rendered by Krita itself, which makes it a free reference
 * image to check our own rendering against -- carrying the whole brush
 * definition in a compressed text chunk as XML. Newer presets embed their tip
 * image in that XML as base64, so a single .kpp is often self-contained.
 *
 * This file reads, and translates what it read into the numbers our own
 * brush takes -- but it never touches the engine: everything in and out is
 * plain data, so both halves can be tested against real packs without
 * dragging the brush engine into it.
 */
(function () {
    'use strict';

    var BrushPack = {};

    /* ── inflate ──────────────────────────────────────────────────────── */

    function _inflate(bytes, format) {
        if (typeof DecompressionStream === 'undefined') {
            return Promise.reject(new Error('this browser cannot decompress'));
        }
        var ds = new DecompressionStream(format);
        var w = ds.writable.getWriter();
        w.write(bytes);
        w.close();
        return new Response(ds.readable).arrayBuffer().then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    /* ── ZIP ──────────────────────────────────────────────────────────── */

    /* Central-directory walk. There is a second ZIP reader in layer-system.js
     * for ORA files; it predates DecompressionStream, hands deflated entries
     * back to its caller half-parsed, and lives inside a closure. Forty lines
     * that return a plain map of promises is less to carry than making that
     * one serve two callers. */
    BrushPack.readZip = function (bytes) {
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var dec = new TextDecoder();
        var eocd = -1;
        for (var i = bytes.length - 22; i >= 0; i--) {
            if (view.getUint32(i, false) === 0x504B0506) { eocd = i; break; }
        }
        if (eocd < 0) return Promise.reject(new Error('That file is not a ZIP archive.'));

        var pos = view.getUint32(eocd + 16, true);
        var count = view.getUint16(eocd + 8, true);
        var jobs = [];
        var out = {};

        for (var n = 0; n < count; n++) {
            if (view.getUint32(pos, false) !== 0x504B0102) break;
            var method = view.getUint16(pos + 10, true);
            var compSize = view.getUint32(pos + 20, true);
            var nameLen = view.getUint16(pos + 28, true);
            var extraLen = view.getUint16(pos + 30, true);
            var commentLen = view.getUint16(pos + 32, true);
            var lho = view.getUint32(pos + 42, true);
            var name = dec.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
            // The central directory's extra field and the local header's are
            // different lengths often enough that trusting the wrong one puts
            // you a few bytes into the data.
            var dataAt = lho + 30 + view.getUint16(lho + 26, true)
                             + view.getUint16(lho + 28, true);
            var data = bytes.subarray(dataAt, dataAt + compSize);
            pos += 46 + nameLen + extraLen + commentLen;

            if (method === 0) {
                out[name] = data.slice();
            } else if (method === 8) {
                jobs.push((function (nm, d) {
                    return _inflate(d, 'deflate-raw').then(function (u) { out[nm] = u; });
                })(name, data));
            }
            // Anything else (bzip2, lzma) is not something Krita writes.
        }
        return Promise.all(jobs).then(function () { return out; });
    };

    /* ── PNG text chunks ──────────────────────────────────────────────── */

    /* Returns { key: string } for the text chunks in a PNG. zTXt is
     * zlib-deflated, which is why this is async. */
    BrushPack.readPngText = function (bytes) {
        var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        var dec = new TextDecoder('utf-8', { fatal: false });
        var out = {};
        var jobs = [];
        var i = 8;
        while (i + 8 <= bytes.length) {
            var len = view.getUint32(i, false);
            var type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
            var body = bytes.subarray(i + 8, i + 8 + len);
            i += 12 + len;
            if (type === 'IEND') break;
            if (type !== 'tEXt' && type !== 'zTXt' && type !== 'iTXt') continue;
            var nul = body.indexOf(0);
            if (nul < 0) continue;
            var key = dec.decode(body.subarray(0, nul));
            if (type === 'tEXt') {
                out[key] = dec.decode(body.subarray(nul + 1));
            } else if (type === 'zTXt') {
                // key \0 method \0 deflated
                (function (k, payload) {
                    jobs.push(_inflate(payload, 'deflate').then(function (u) {
                        out[k] = dec.decode(u);
                    }, function () { /* a chunk we cannot read is not fatal */ }));
                })(key, body.subarray(nul + 2));
            } else {
                // iTXt: key \0 compressed \0 method \0 lang \0 translated \0 text
                var p = nul + 1;
                var compressed = body[p]; p += 2;
                p = body.indexOf(0, p) + 1;
                p = body.indexOf(0, p) + 1;
                if (p <= 0) continue;
                if (!compressed) out[key] = dec.decode(body.subarray(p));
                else (function (k, payload) {
                    jobs.push(_inflate(payload, 'deflate').then(function (u) {
                        out[k] = dec.decode(u);
                    }, function () {}));
                })(key, body.subarray(p));
            }
        }
        return Promise.all(jobs).then(function () { return out; });
    };

    /* ── preset XML ───────────────────────────────────────────────────── */

    function _b64(str) {
        var clean = String(str).replace(/\s+/g, '');
        var bin = atob(clean);
        var u = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return u;
    }

    /* Krita writes settings as <param name="x" value="y"/> for simple values
     * and as element text for anything that is itself XML -- the brush
     * definition, the sensor curves. Both come back as strings here. */
    /* Characters XML does not allow at all -- the C0 controls bar tab, line
     * feed and carriage return. They have no business in a text format and
     * they are in these files anyway: Krita writes a pattern's md5 as its
     * sixteen RAW BYTES inside a CDATA block, and eight of the forty-six
     * presets in David Revoy's 25.01 bundle carry one. An XML parser stops
     * dead at the first of them -- "CData section not finished" -- so those
     * eight arrived as "could not be read" and were quietly left out of
     * every import. Nothing we read is a checksum, so they come out. */
    function _xmlSafe(xml) {
        return String(xml).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    }

    BrushPack.parsePresetXml = function (xml) {
        var doc = new DOMParser().parseFromString(_xmlSafe(xml), 'text/xml');
        var root = doc.documentElement;
        if (!root || root.nodeName === 'parsererror' || root.getElementsByTagName('parsererror').length) {
            return null;
        }
        var params = {};
        var nodes = root.getElementsByTagName('param');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            var v = el.getAttribute('value');
            params[el.getAttribute('name')] = (v === null) ? (el.textContent || '') : v;
        }
        /* Tips ride along inside <resources>, base64 in a CDATA block, keyed
         * by the filename the brush definition points at. */
        var res = {};
        var rn = root.getElementsByTagName('resource');
        for (var r = 0; r < rn.length; r++) {
            var el2 = rn[r];
            var fn = el2.getAttribute('filename') || el2.getAttribute('name');
            if (!fn) continue;
            try {
                res[fn] = { type: el2.getAttribute('type') || '', bytes: _b64(el2.textContent) };
            } catch (e) { /* a resource we cannot decode is not fatal */ }
        }
        return {
            name: root.getAttribute('name') || '',
            paintop: root.getAttribute('paintopid') || '',
            params: params,
            resources: res
        };
    };

    /* The tip a preset stamps, as declared in its brush definition. Returns
     * null for the brushes Krita generates rather than stamps. */
    BrushPack.brushDefinition = function (preset, key) {
        var raw = preset && preset.params && preset.params[key || 'brush_definition'];
        if (!raw || !String(raw).trim()) return null;
        var doc = new DOMParser().parseFromString(_xmlSafe(String(raw).trim()), 'text/xml');
        var el = doc.documentElement;
        if (!el || el.getElementsByTagName('parsererror').length) return null;
        var out = { type: el.getAttribute('type') || '' };
        for (var i = 0; i < el.attributes.length; i++) {
            out[el.attributes[i].name] = el.attributes[i].value;
        }
        var mg = el.getElementsByTagName('MaskGenerator')[0];
        if (mg) {
            out.mask = {};
            for (var m = 0; m < mg.attributes.length; m++) {
                out.mask[mg.attributes[m].name] = mg.attributes[m].value;
            }
        }
        return out;
    };

    /* Krita's masking brush is a whole second preset, and half of them
     * generate their tip rather than stamp one. Our second tip is a picture,
     * so the generated one is drawn here -- once, at import -- and the engine
     * needs to know nothing about it. 128px is plenty: it is a soft blob that
     * gets scaled to the dab, not a photograph. */
    function _maskPng(mask) {
        var N = 128;
        var c = document.createElement('canvas');
        c.width = c.height = N;
        var g = c.getContext('2d');
        var ratio = _num(mask.ratio, 1);
        var fade = Math.max(_num(mask.hfade, 0), _num(mask.vfade, 0));
        var gen = String(mask.id || 'default');
        if (gen === 'gauss' || gen === 'soft') fade = Math.max(fade, 0.7);
        var stop = Math.max(0, Math.min(0.99, 1 - Math.min(1, fade)));
        var grad = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(stop, 'rgba(0,0,0,1)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.save();
        g.translate(N / 2, N / 2);
        if (ratio > 0 && ratio < 1) g.scale(1, ratio);
        g.translate(-N / 2, -N / 2);
        if (String(mask.type || '').indexOf('rect') === 0) {
            g.fillStyle = 'rgba(0,0,0,1)';
            g.fillRect(0, 0, N, N);
        } else {
            g.fillRect(0, 0, N, N);
        }
        g.restore();
        return c.toDataURL('image/png');
    }

    /* A sensor's response curve, as [in, out] pairs in 0..1 -- the same shape
     * our own curve editor stores, which is the one piece of this that needs
     * no translation at all. */
    BrushPack.parseCurve = function (sensorXml) {
        if (!sensorXml) return null;
        var m = /<curve>([^<]*)<\/curve>/.exec(String(sensorXml));
        if (!m) return null;
        var pts = [];
        var parts = m[1].split(';');
        for (var i = 0; i < parts.length; i++) {
            var s = parts[i].trim();
            if (!s) continue;
            var xy = s.split(',');
            if (xy.length !== 2) continue;
            var x = parseFloat(xy[0]), y = parseFloat(xy[1]);
            if (isNaN(x) || isNaN(y)) continue;
            pts.push([x, y]);
        }
        return pts.length >= 2 ? pts : null;
    };

    /* ── the two entry points ─────────────────────────────────────────── */

    BrushPack.readKpp = function (bytes) {
        return BrushPack.readPngText(bytes).then(function (text) {
            if (!text.preset) return null;
            var p = BrushPack.parsePresetXml(text.preset);
            if (p) p.kritaVersion = text.version || '';
            return p;
        });
    };

    /* Reads a .bundle (a ZIP) or a bare .kpp and returns everything found.
     * `tips` holds the pack's shared brush files for the presets that point
     * at one instead of carrying it. */
    BrushPack.read = function (bytes) {
        var isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4B;
        if (!isZip) {
            return BrushPack.readKpp(bytes).then(function (p) {
                if (!p) throw new Error('That file is not a Krita brush preset.');
                return { kind: 'kpp', presets: [p], tips: {}, warnings: [] };
            });
        }
        return BrushPack.readZip(bytes).then(function (files) {
            var names = Object.keys(files);
            var kpps = names.filter(function (n) { return /\.kpp$/i.test(n); });
            if (!kpps.length) throw new Error('That archive holds no brush presets.');
            var tips = {};
            for (var i = 0; i < names.length; i++) {
                var n = names[i];
                if (/^brushes\//i.test(n) || /^patterns\//i.test(n)) {
                    tips[n.split('/').pop()] = files[n];
                }
            }
            var warnings = [];
            return Promise.all(kpps.map(function (n) {
                return BrushPack.readKpp(files[n]).then(function (p) {
                    if (p) { p.file = n; p.thumbnail = files[n]; return p; }
                    warnings.push(n.split('/').pop() + ' could not be read');
                    return null;
                }, function () {
                    warnings.push(n.split('/').pop() + ' could not be read');
                    return null;
                });
            })).then(function (list) {
                return {
                    kind: 'bundle',
                    presets: list.filter(Boolean),
                    tips: tips,
                    warnings: warnings
                };
            });
        });
    };


    /* ── Krita settings → our brush ───────────────────────────────────── */

    /* Krita drives every option from a "sensor", and calls the same input by
     * different names depending on which axis it came off. These are the ones
     * that have an equivalent here; anything else is reported, not guessed. */
    var SENSORS = {
        pressure: 'pressure',
        fuzzy: 'random',
        fuzzydab: 'random',
        fuzzystroke: 'random',
        drawingangle: 'direction',
        ascension: 'tilt',
        declination: 'tilt',
        tilt: 'tilt',
        tiltdirection: 'tilt',
        rotation: 'twist',
        tangentialpressure: 'wheel',
        speed: 'speed',
        xtilt: 'tilt',
        ytilt: 'tilt',
        /* Neither of these comes off the pen: they come off how far into the
         * stroke the dab is. Krita gives each a `length` attribute on the
         * sensor tag -- pixels for distance, dabs for fade -- so the reach
         * travels with the source instead of being guessed. */
        distance: 'distance',
        fade: 'fade'
    };

    /* Features Krita has and we do not. Reported by name when a preset
     * actually switches one on, so an import says what it dropped instead of
     * quietly painting something else. */
    var DROPPED = [
        ['PaintThicknessEnabled', 'paint thickness (impasto)'],
        ['PressureLightnessStrength', 'lightness-mapped tips'],
        ['PressureRate', 'an airbrush rate curve']
    ];

    /* Krita has far more blend modes than we do, and it names the ones we
     * share differently in places. */
    var BLENDS = {
        erase: 'erase', normal: 'normal', over: 'normal',
        multiply: 'multiply', screen: 'screen', overlay: 'overlay',
        darken: 'darken', lighten: 'lighten',
        dodge: 'color-dodge', burn: 'color-burn',
        hard_light: 'hard-light', soft_light: 'soft-light',
        diff: 'difference', hue: 'hue', saturation: 'saturation',
        color: 'color', luminize: 'luminosity'
    };

    function _num(v, dflt) {
        var n = parseFloat(v);
        return isFinite(n) ? n : dflt;
    }
    function _bool(v) { return String(v) === 'true' || String(v) === '1'; }

    /* Which input drives one option, and how it responds. Krita spells the
     * on/off switch "Pressure<Option>" for most options but leaves it out for
     * the ones that are always live, where <Option>UseCurve is the switch. */
    function _sensorFor(params, opt) {
        var flag = params['Pressure' + opt];
        var on = (flag === undefined) ? _bool(params[opt + 'UseCurve']) : _bool(flag);
        if (!on) return null;
        var raw = params[opt + 'Sensor'] || '';
        var m = /<params\s+id="([^"]+)"/.exec(raw);
        var id = m ? m[1].toLowerCase() : 'pressure';
        /* "sensorslist" is several inputs multiplied together. We drive one
         * parameter from one input, so take the first we understand rather
         * than reporting a brush we can very nearly reproduce as unreadable. */
        if (id === 'sensorslist') {
            var ch = /<ChildSensor\s+id="([^"]+)"[\s\S]*?<\/ChildSensor>/g, c;
            while ((c = ch.exec(raw))) {
                if (SENSORS[c[1].toLowerCase()]) {
                    id = c[1].toLowerCase();
                    raw = c[0];
                    break;
                }
            }
        }
        var len = /length="([0-9.]+)"/.exec(raw);
        return { id: id, src: SENSORS[id] || null,
                 length: len ? parseFloat(len[1]) : null,
                 curve: BrushPack.parseCurve(raw) };
    }

    /* Turns one Krita preset into the parameters our engine takes.
     *
     * A stamped tip's real size is its image scaled by the preset's `scale`,
     * so the caller has to have decoded the tip first and pass its pixel size
     * in `tipSize`; without it the size comes back as the scale factor alone
     * and `needsTipSize` says so.
     *
     * Returns { params, tipFile, warnings }. Nothing here touches the engine:
     * the result is a plain preset object, which is what makes it testable
     * against real files on its own. */
    BrushPack.toPreset = function (preset, opts) {
        opts = opts || {};
        var P = preset.params || {};
        var bd = BrushPack.brushDefinition(preset) || {};
        var warn = [];
        var out = {};

        out.opacity = Math.round(_num(P.OpacityValue, 1) * 100);
        out.flow = Math.round(_num(P.FlowValue, 1) * 100);

        /* Spacing is a fraction of the tip in Krita and a percentage here,
         * which is the same number twice. Auto-spacing is Krita computing it
         * from the tip's own shape, which we cannot reproduce, so the stored
         * value stands and the import says so. */
        out.spacing = Math.max(1, Math.round(_num(bd.spacing, 0.1) * 100));
        /* Auto spacing means Krita worked the gap out from the tip's own
         * shape and never wrote it down; the stored number is whatever the
         * slider last held, and it is always far too wide -- a rake brush
         * imported at 10% comes out as a row of dots. The coefficient is the
         * only thing on file that scales with the author's intent. */
        if (_bool(bd.useAutoSpacing)) {
            out.spacing = Math.max(1, Math.round(_num(bd.autoSpacingCoeff, 1) * 25));
        }

        var mask = bd.mask;
        if (mask) {
            // A generated tip: numbers all the way down, which is our own case.
            out.shape = (String(mask.type || '').indexOf('rect') === 0) ? 'square' : 'circle';
            out.size = Math.max(1, Math.round(_num(mask.diameter, 20)));
            /* Krita's ratio is the short axis over the long one, so it is our
             * aspect upside down -- and ours squashes rather than stretches,
             * which is the same convention once inverted. */
            var ratio = _num(mask.ratio, 1);
            out.aspectRatio = (ratio > 0 && ratio < 1) ? Math.round((1 / ratio) * 100) / 100 : 1;
            // hfade/vfade are how much of the radius fades out: all fade is
            // our softest brush, none is our hardest.
            var fade = Math.max(_num(mask.hfade, 0), _num(mask.vfade, 0));
            out.hardness = Math.round((1 - Math.min(1, fade)) * 100);
            /* A "gauss" generator is soft by construction: its edge falls off
             * over the whole radius even with the fade sliders at zero, so
             * taking the fade at face value would import a soft airbrush as a
             * hard disc. Half is the closest single number; anyone importing
             * one can nudge the hardness slider from there. */
            /* "gauss" and "soft" fall off over the whole radius whatever the
             * fade sliders say, so taking those at face value imports an
             * airbrush as a hard disc. A third is the closest single number;
             * the hardness slider goes the rest of the way. */
            var gen = String(mask.id || 'default');
            if (gen === 'gauss' || gen === 'soft') out.hardness = Math.round(out.hardness * 0.3);
            if (_num(mask.spikes, 2) > 2) warn.push('a star-shaped tip became a plain one');
        } else if (bd.filename) {
            out.shape = 'custom';
            out.hardness = 100;      // the image is the shape; do not fade it
            var scale = _num(bd.scale, 1);
            if (opts.tipSize) out.size = Math.max(1, Math.round(opts.tipSize * scale));
            else { out.size = scale; out.needsTipSize = true; }
        } else if (preset.paintop !== 'experimentbrush' &&
                   preset.paintop !== 'deformbrush') {
            warn.push('no tip definition; falling back to a round brush');
            out.shape = 'circle';
            out.size = 20;
        }

        /* What the tip's pixels are FOR. Krita reads a tip as coverage by
         * default (0), but it can also read its greys as lightness, or as a
         * place along a gradient, or paint the picture itself. Ours is always
         * coverage, and until now the other three arrived silently as plain
         * stamps -- the one kind of wrong that is worth a warning, because
         * nothing about the imported brush says it happened. None of the 46
         * presets in Revoy's 25.01 bundle asks for one. */
        var app = _num(bd.brushApplication, 0);
        if (app === 1) out.tipMode = 'lightness';
        else if (app === 3) out.tipMode = 'color';
        else if (app === 2) {
            warn.push('dropped: the way its tip reads a gradient; we stamp the shape instead');
        }

        /* Krita's masking brush is a second brush stamped through the first
         * as an alpha mask -- which is exactly what our second tip does. The
         * whole preset is in the file under MaskingBrush/Preset, tip and all,
         * so the tip comes out of it the same way the main one does: a named
         * file the pack has to resolve, or a shape we draw here. */
        if (_bool(P['MaskingBrush/Enabled'])) {
            var mb = BrushPack.brushDefinition(preset, 'MaskingBrush/Preset/brush_definition');
            if (mb && mb.mask) {
                out._tip2Url = _maskPng(mb.mask);
            } else if (mb && mb.filename) {
                out._tip2File = mb.filename;
            }
            if (out._tip2Url || out._tip2File) {
                out.tip2Depth = 100;
                /* MasterSizeCoeff is the masking brush's size over the main
                 * brush's, which is exactly what our tip2Size is a percentage
                 * of. Confirmed against the file rather than assumed: in
                 * eraser-kneaded-soft the nested tip is 8.5415 across and the
                 * brush is 250, and the coefficient is 0.034166 to the digit.
                 * Real ones run from 3 per cent to sixteen times over, so the
                 * range is wide on purpose -- a mask far bigger than the dab
                 * is a subtle grain, not a mistake. */
                var coeff = _num(P['MaskingBrush/MasterSizeCoeff'], 1);
                out.tip2Size = Math.max(1, Math.min(2000, Math.round(coeff * 100)));
                out.tip2Angle = ((Math.round(_num(mb.angle, 0) * 180 / Math.PI) % 360) + 360) % 360;
            } else {
                warn.push('dropped: a second brush used as a mask');
            }
        }

        // Krita stores the tip's own turn in radians.
        out.angle = Math.round(_num(bd.angle, 0) * 180 / Math.PI) % 360;

        /* Scatter is a multiple of the tip diameter there and a percentage of
         * it here. Krita can scatter along one axis only; we always scatter in
         * both, so a one-axis preset is reported rather than silently widened. */
        /* ScatterValue is stored whether or not the option is switched on --
         * Krita keeps every widget's last value -- so the value alone would
         * put a wild jitter on brushes that never scatter. */
        var scat = _bool(P.PressureScatter) ? _num(P.ScatterValue, 0) : 0;
        out.scatter = Math.round(scat * 100);
        /* Krita's scatter axes are the stroke's own: X spreads dabs along
         * the line, Y across it. One axis on its own is what keeps a rake
         * reading as streaks rather than a cloud. */
        if (scat > 0 && (_bool(P['Scattering/AxisX']) !== _bool(P['Scattering/AxisY']))) {
            out.scatterAxis = _bool(P['Scattering/AxisX']) ? 'along' : 'across';
        }

        var op = String(P.CompositeOp || 'normal');
        /* A deform brush lays no paint down, so it has nothing to blend --
         * Krita writes "copy" on one because moving pixels is replacing
         * them, which is what a deform does here too. */
        if (preset.paintop === 'deformbrush') op = 'normal';
        if (_bool(P.EraserMode) || op === 'erase') out.blendMode = 'erase';
        else if (op !== 'normal') {
            if (BLENDS[op]) out.blendMode = BLENDS[op];
            else warn.push('blend mode "' + op + '" has no equivalent; painting normally');
        }

        // Size and flow ride their sensors the same way ours do.
        /* Two responses on one input multiply. Sampled rather than solved:
         * the product of two piecewise-linear curves is not itself piecewise
         * linear, and eight points is what the engine stores anyway. */
        function _curveVal(c, v) {
            if (!c || !c.length) return v;             // absent means linear
            if (c.length === 1) return c[0][1];
            for (var i = 0; i < c.length - 1; i++) {
                var a = c[i], b = c[i + 1];
                if (v <= b[0]) {
                    if (v <= a[0]) return a[1];
                    var sp = b[0] - a[0];
                    return sp > 1e-6 ? a[1] + (b[1] - a[1]) * ((v - a[0]) / sp) : a[1];
                }
            }
            return c[c.length - 1][1];
        }
        function _mulCurves(a, b) {
            if (!a || !a.length) a = null;
            if (!b || !b.length) b = null;
            if (!a && !b) return null;
            var out = [];
            for (var i = 0; i < 8; i++) {
                var v = i / 7;
                out.push([v, Math.max(0, Math.min(1, _curveVal(a, v) * _curveVal(b, v)))]);
            }
            return out;
        }

        [['Size', 'size'], ['Flow', 'flow'], ['Opacity', 'opacity']].forEach(function (pair) {
            var s = _sensorFor(P, pair[0]);
            var key = pair[1];
            if (!s) return;
            if (key === 'opacity') {
                /* Opacity is per stroke here and per dab there, where it does
                 * the same job as flow. With flow left alone we can carry the
                 * curve over on flow's back; with both driven we would be
                 * applying the response twice, so the second one is reported
                 * rather than folded in. */
                if (!out.flowSrc && s.src) {
                    out.flowSrc = s.src;
                    out.flowMin = 0;
                    if (s.curve) out.flowCurve = s.curve;
                } else if (s.src && s.src === out.flowSrc) {
                    /* Both riding the same input is the common case, and the
                     * two responses are not a conflict: Krita scales a dab's
                     * alpha by opacity AND by flow, so the pair multiply.
                     * Folding them into one curve says the same thing our
                     * single flow response can say. Dropping one of them --
                     * which is what happened before -- made nine of David
                     * Revoy's thirty-eight brushes hold far more ink at low
                     * pressure than he drew them with. */
                    out.flowCurve = _mulCurves(out.flowCurve, s.curve);
                } else {
                    warn.push('opacity also responded to ' + s.id +
                        '; only the flow response was kept');
                }
                return;
            }
            if (!s.src) { warn.push(pair[0] + ' followed ' + s.id + ', which we have no input for'); return; }
            out[key + 'Src'] = s.src;
            out[key + 'Min'] = 0;
            _kritaReach(out, s);
            if (s.curve) out[key + 'Curve'] = s.curve;
        });

        /* Rotation is an angle, not a factor, so it takes the source only --
         * its curve would reshape a full turn and we do not offer that. */
        var rot = _sensorFor(P, 'Rotation');
        if (rot) {
            /* Every sensor the engine can read now spins the tip -- the ones
             * that ARE an angle (direction, twist, tilt) point it, the rest
             * turn it through a full circle across their range, which is what
             * Krita's pressure-driven rotation does. Only an input we cannot
             * read at all is still refused. */
            if (rot.src) { out.angleSrc = rot.src; _kritaReach(out, rot); }
            else warn.push('the tip turned with ' + rot.id + ', which we cannot turn it with');
        }

        /* Krita's Texture option paints the dab through a pattern image.
         * The image itself lives in the pack, not in the preset, so only its
         * NAME is recorded here -- the caller resolves it and the engine
         * warns if the pack turned out not to carry it. */
        if (_bool(P['Texture/Pattern/Enabled'])) {
            /* Krita writes the pattern's name as whatever it was loaded
             * from, which for anything out of its own default resources is
             * a URI naming the mount the app was running from:
             * "bundle:///tmp/.mount_krita-nL8hfQ/usr/.../bundle:patterns/
             * 10_drawed_dotted.png". Only the last part is a file name, and
             * carrying the rest into a warning made it unreadable. */
            var patName = String(P['Texture/Pattern/Name'] ||
                P['Texture/Pattern/PatternFileName'] || '').split(/[\/]/).pop();
            if (patName) {
                out.texturePatternFile = patName;
                out.texture = Math.round(_num(P['Texture/Strength/Value'], 1) * 100);
                out.textureScale = Math.max(1, _num(P['Texture/Pattern/Scale'], 1));
            } else {
                warn.push('dropped: a canvas texture pattern');
            }
        }

        /* The engine keeps one reach for fade and one for distance, not one
         * per dial, so the first option that asks sets it. */
        function _kritaReach(out, s) {
            if (s.length == null) return;
            if (s.src === 'fade' && out.fadeSteps == null) {
                out.fadeSteps = Math.max(1, Math.min(200, Math.round(s.length)));
            } else if (s.src === 'distance' && out.distanceLength == null) {
                out.distanceLength = Math.max(1, Math.min(500, Math.round(s.length)));
            }
        }

        var sc = _sensorFor(P, 'Scatter');
        /* Scatter's response curve was parsed and then thrown away, so a
         * brush that only scatters at speed scattered constantly. */
        if (sc && sc.src) {
            out.scatterSrc = sc.src;
            out.scatterMin = 0;
            _kritaReach(out, sc);
            if (sc.curve) out.scatterCurve = sc.curve;
        }

        /* Krita's Sharpness hardens the dab's edge towards a cut-out.
         * PressureSharpness is the ENABLE box: `Sharpness/softness` and
         * SharpnessValue are stored on every preset in a pack whether the
         * option is switched on or not, so reading the value at face value
         * reported two of David Revoy's brushes as losing a feature neither
         * of them uses. Only one preset in that pack turns it on. */
        if (_bool(P.PressureSharpness)) {
            var soft = _num(P['Sharpness/softness'], 0);
            // Older presets wrote a 0-1 fraction, newer ones a percentage.
            if (soft > 1) soft = soft / 100;
            out.sharpness = Math.round(_num(P.SharpnessValue, 1) * 100);
            out.sharpSoftness = Math.round(Math.min(1, Math.max(0, soft)) * 100);
        }

        /* Krita's airbrush keeps dabbing while the pen is held still, which
         * is the pair of dials we already have under a different name. */
        if (_bool(P.AirbrushEnabled)) {
            out.airbrushMode = true;
            // Krita's rate is dabs per second; ours is the same idea.
            out.airbrushRate = Math.max(1, Math.round(_num(P.AirbrushRate, 40)));
        }

        // A per-dab flip is exactly what our strip tips already do.
        var mrx = _bool(P.HorizontalMirrorEnabled), mry = _bool(P.VerticalMirrorEnabled);
        if (mrx || mry) out.tipMirror = (mrx && mry) ? 'both' : (mrx ? 'h' : 'v');

        for (var i = 0; i < DROPPED.length; i++) {
            var k = DROPPED[i][0], v = P[k];
            if (v !== undefined && v !== '' && v !== 'false' && _num(v, 1) !== 0) {
                warn.push('dropped: ' + DROPPED[i][1]);
            }
        }
        /* A smudge brush lays down a little fresh colour and drags the rest
         * along, which is exactly the pair of dials we already have. */
        if (preset.paintop === 'colorsmudge') {
            /* Krita runs two dials side by side: how much fresh colour goes
             * down, and how much of what is already there gets dragged along.
             * Ours is one dial between the same two ends, so the split
             * between them is what carries over -- both at full there means
             * half and half, not a brush that never picks anything up. */
            var cr = _num(P.ColorRateValue, 0.5), sr = _num(P.SmudgeRateValue, 0.5);
            out.colorRate = Math.round((cr / Math.max(1e-6, cr + sr)) * 100);
            out.smudgeLength = Math.round(sr * 100);
            /* Krita drives the fresh-colour half from the pen, which is the
             * same dial ours drives -- it just had nowhere to be driven from
             * until colorRate grew a sensor. */
            var mix = _sensorFor(P, 'Mix');
            if (mix) {
                if (mix.src) {
                    out.colorRateSrc = mix.src;
                    out.colorRateMin = 0;
                    if (mix.curve) out.colorRateCurve = mix.curve;
                    _kritaReach(out, mix);
                } else {
                    warn.push('colour mixing followed ' + mix.id +
                        ', which we have no input for');
                }
            }
        } else if (preset.paintop === 'deformbrush') {
            /* The deform brush moves the pixels that are already there.
             * `deformAction` is which way: Krita numbers them from one, in
             * the order its own menu lists them. */
            var DEFORMS = ['grow', 'shrink', 'swirl-cw', 'swirl-ccw', 'move',
                           'lens-in', 'lens-out'];
            var act = DEFORMS[Math.round(_num(P['Deform/deformAction'], 5)) - 1];
            if (!act) {
                warn.push('this is a deform brush that distorts colour rather ' +
                          'than pixels, which we cannot do');
            } else {
                out.engineKind = 'deform';
                out.deformAction = act;
                out.deformAmount = Math.max(1, Math.min(100,
                    Math.round(_num(P['Deform/deformAmount'], 0.3) * 100)));
                out.shape = 'circle';
                out.size = Math.max(2, Math.min(1000,
                    Math.round(_num(P['Brush/diameter'], 50))));
                out.spacing = Math.max(1, Math.min(400,
                    Math.round(_num(P['Brush/spacing'], 0.15) * 100)));
                if (_bool(P['Brush/jitterMovementEnabled'])) {
                    warn.push('dropped: the wobble it adds to where it pushes');
                }
            }
        } else if (preset.paintop === 'experimentbrush') {
            /* Krita's experiment brush stamps nothing: the line you draw is
             * an outline and its inside is filled. That is a different engine
             * rather than a different brush, and ours has it. */
            out.engineKind = 'shape';
            out.shape = 'circle';
            out.size = 20;
            out.shapeWinding = _bool(P['Experiment/windingFill']);
            var xnot = [
                ['Experiment/speedEnabled', 'the way its shape shrinks as the hand speeds up'],
                ['Experiment/displacementEnabled', 'the way it pushes its own outline about'],
                ['Experiment/smoothing', 'the smoothing on its outline'],
                ['Experiment/hardEdge', 'its hard, unsmoothed edge']
            ];
            for (var xi = 0; xi < xnot.length; xi++) {
                if (_bool(P[xnot[xi][0]])) warn.push('dropped: ' + xnot[xi][1]);
            }
        } else if (preset.paintop && preset.paintop !== 'paintbrush') {
            warn.push('this is a ' + preset.paintop + ', which we paint as an ordinary brush');
        }

        return { name: preset.name || 'Imported', params: out,
                 tipFile: bd.filename || null, warnings: warn };
    };

    /* ── tip images ───────────────────────────────────────────────────── */

    /* No tip is stored larger than the largest dab anyone paints with it.
     * That used to be 200, because a tip was a data: URL inside localStorage
     * and the whole application has about 5MB of it -- and 200 pixels is
     * exactly where the grain of a chalk or a drip brush lives, so every
     * Photoshop brush arrived smooth. Tips live in IndexedDB now, so the
     * ceiling is the tip's own resolution instead: 2326 is the largest one
     * measured in a real pack (the Drip set), and a tip stored whole is a
     * tip that still has its grain when it is painted big. The dab is baked
     * at the size it is painted, so a big tip costs storage and a decode,
     * not memory per dab. */
    var TIP_CAP_PX = 2326;

    /* A GIMP brush (.gbr): five big-endian numbers, a name, then the pixels.
     * `headerSize` says where they start, which is the only part that differs
     * between the format's versions. One byte per pixel is coverage — that
     * byte IS the alpha, nothing to invert. Four is RGBA, which Krita reads
     * the way it reads a PNG tip: dark is ink, and the file's own alpha
     * still counts. */
    function _readGbr(b, off) {
        if (off + 20 > b.length) return null;
        var dv = new DataView(b.buffer, b.byteOffset + off, Math.min(20, b.length - off));
        var hs = dv.getUint32(0), ver = dv.getUint32(4);
        var w = dv.getUint32(8), h = dv.getUint32(12), bpp = dv.getUint32(16);
        if (ver < 1 || ver > 3 || !w || !h || w > 8192 || h > 8192) return null;
        if (bpp !== 1 && bpp !== 4) return null;
        var start = off + hs, n = w * h;
        if (start + n * bpp > b.length) return null;
        var a = new Uint8ClampedArray(n), i;
        if (bpp === 1) {
            for (i = 0; i < n; i++) a[i] = b[start + i];
        } else {
            for (i = 0; i < n; i++) {
                var p = start + i * 4;
                var lum = (b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114) / 255;
                a[i] = Math.round((1 - lum) * b[p + 3]);
            }
        }
        return { w: w, h: h, alpha: a, next: start + n * bpp };
    }

    /* A GIMP brush pipe (.gih): a name line, a line of parameters, then that
     * many .gbr images back to back. This is the file that makes a textured
     * brush read as drawn rather than stamped, and `sel0` is the file saying
     * whether the next dab takes a shape at random or the next one along. */
    function _readGih(b) {
        var head = '';
        for (var i = 0; i < Math.min(b.length, 2048); i++) head += String.fromCharCode(b[i]);
        var nl1 = head.indexOf('\n');
        var nl2 = nl1 < 0 ? -1 : head.indexOf('\n', nl1 + 1);
        if (nl2 < 0) return null;
        var params = head.slice(nl1 + 1, nl2);
        var m = /ncells:(\d+)/.exec(params);
        var n = m ? Math.min(64, parseInt(m[1], 10)) : 1;
        var sel = /sel0:(\w+)/.exec(params);
        var cells = [], off = nl2 + 1;
        for (var c = 0; c < n; c++) {
            var g = _readGbr(b, off);
            if (!g) break;
            cells.push(g);
            off = g.next;
        }
        if (!cells.length) return null;
        return { cells: cells,
                 pick: (sel && sel[1] === 'incremental') ? 'cycle' : 'random' };
    }

    function _canvasFromAlpha(cell) {
        var c = document.createElement('canvas');
        c.width = cell.w; c.height = cell.h;
        var g = c.getContext('2d');
        var id = g.createImageData(cell.w, cell.h);
        /* A tip that carries its own picture keeps it: Krita can read a tip's
         * greys as lightness or stamp its colours outright, and by the time
         * the engine knows which, the pixels are long gone. Tips with no
         * picture of their own stay black, which is what they were. */
        for (var i = 0, n = cell.w * cell.h; i < n; i++) {
            if (cell.rgb) {
                id.data[i * 4]     = cell.rgb[i * 3];
                id.data[i * 4 + 1] = cell.rgb[i * 3 + 1];
                id.data[i * 4 + 2] = cell.rgb[i * 3 + 2];
            }
            id.data[i * 4 + 3] = cell.alpha[i];
        }
        g.putImageData(id, 0, 0);
        return c;
    }

    /* A texture is drawn over the paint rather than cut out of it, so it is
     * opaque and its grey is the grain. */
    function _canvasFromGray(cell) {
        var c = document.createElement('canvas');
        c.width = cell.w; c.height = cell.h;
        var g = c.getContext('2d');
        var id = g.createImageData(cell.w, cell.h);
        for (var i = 0, n = cell.w * cell.h; i < n; i++) {
            id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = cell.px[i];
            id.data[i * 4 + 3] = 255;
        }
        g.putImageData(id, 0, 0);
        return c;
    }

    /* One image holding every shape side by side, black with the shape in the
     * alpha channel. That is the form the engine reads without converting
     * anything, and the blank paper round each shape costs nothing to store. */
    function _strip(cells) {
        var cw = 0, ch = 0, i;
        for (i = 0; i < cells.length; i++) { cw = Math.max(cw, cells[i].w); ch = Math.max(ch, cells[i].h); }
        var s = Math.min(1, TIP_CAP_PX / Math.max(cw, ch));
        var ow = Math.max(1, Math.round(cw * s)), oh = Math.max(1, Math.round(ch * s));
        var out = document.createElement('canvas');
        out.width = ow * cells.length; out.height = oh;
        var g = out.getContext('2d');
        for (i = 0; i < cells.length; i++) {
            var src = _canvasFromAlpha(cells[i]);
            var w = Math.max(1, Math.round(cells[i].w * s)), h = Math.max(1, Math.round(cells[i].h * s));
            g.drawImage(src, i * ow + ((ow - w) >> 1), (oh - h) >> 1, w, h);
        }
        return { url: out.toDataURL('image/png'), size: Math.max(cw, ch) };
    }

    /* Turns whatever a pack calls a tip into one our engine can stamp.
     * Resolves to { url, cells, pick, size } — `size` being the tip's real
     * pixel size BEFORE the cap, since a Krita preset's `scale` multiplies
     * that and not what we chose to store. */
    BrushPack.tipStrip = function (bytes, filename, opts) {
        var name = String(filename || '');
        try {
            if (/\.gih$/i.test(name)) {
                var pipe = _readGih(bytes);
                if (!pipe) throw new Error('unreadable brush pipe');
                var st = _strip(pipe.cells);
                return Promise.resolve({ url: st.url, size: st.size,
                    cells: pipe.cells.length, pick: pipe.pick });
            }
            if (/\.gbr$/i.test(name)) {
                var one = _readGbr(bytes, 0);
                if (!one) throw new Error('unreadable brush file');
                var st1 = _strip([one]);
                return Promise.resolve({ url: st1.url, size: st1.size, cells: 1, pick: 'random' });
            }
        } catch (e) { return Promise.reject(e); }

        /* Anything else is an ordinary image, which the browser decodes.
         * A list of them becomes one strip, the way a brush pipe does --
         * Clip Studio brushes hand us several tip pictures at once. */
        function _decode(one) {
        var blob = new Blob([one]);
        return createImageBitmap(blob).then(function (bmp) {
            var c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            var g = c.getContext('2d');
            g.drawImage(bmp, 0, 0);
            var id = g.getImageData(0, 0, c.width, c.height), d = id.data;
            var a = new Uint8ClampedArray(c.width * c.height);

            /* A tip image says where the ink is in one of two ways, and
             * nothing in the file says which. If it carries transparency,
             * that IS the answer and the colours are irrelevant. If it is
             * flat opaque, it is a light-on-dark or a dark-on-light picture,
             * and the same test the .abr reader uses settles it: the pixels
             * ringing the image are the paper it was cut out of.
             *
             * Krita's stamps are dark on white and Procreate's Shape.png is
             * white on black, so assuming either one makes half the brushes
             * in the world paint nothing at all. */
            var clear = false, edge = 0, en = 0, i, px;
            for (i = 3; i < d.length; i += 4) { if (d[i] < 250) { clear = true; break; } }
            if (clear) {
                for (i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
            } else {
                for (var x = 0; x < c.width; x++) {
                    edge += d[x * 4] + d[((c.height - 1) * c.width + x) * 4];
                    en += 2;
                }
                for (var y = 0; y < c.height; y++) {
                    edge += d[y * c.width * 4] + d[(y * c.width + c.width - 1) * 4];
                    en += 2;
                }
                /* Procreate states which way round its Shape.png is, so
                 * there the caller says and the ring is not consulted: a
                 * shape that fills its own frame would read as blank paper
                 * under any heuristic, and some of them do. */
                var dark = (opts && opts.lightIsInk) || edge / en <= 127;
                /* SAI draws its brush shapes on a template: a white square
                 * with a pale blue guide circle and crosshair on it, and the
                 * shape itself in plain grey. The guide is never part of the
                 * brush -- SAI ignores any pixel that is not a grey -- and
                 * read as ink it puts a faint ring round every stamp. Blue
                 * over equal red and green is exactly that guide and nothing
                 * an ordinary tip picture is made of. */
                var guide = false;
                for (i = 0; i < a.length; i++) {
                    px = i * 4;
                    if (d[px] === d[px + 1] && d[px + 2] > d[px]) { guide = true; break; }
                }
                for (i = 0; i < a.length; i++) {
                    px = i * 4;
                    if (guide && d[px] === d[px + 1] && d[px + 2] > d[px]) { a[i] = 0; continue; }
                    var lum = (d[px] * 0.299 + d[px + 1] * 0.587 + d[px + 2] * 0.114);
                    a[i] = Math.round(dark ? lum : 255 - lum);
                }
            }
            var rgb = new Uint8ClampedArray(c.width * c.height * 3);
            for (i = 0; i < a.length; i++) {
                rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
            }
            bmp.close && bmp.close();
            return { w: c.width, h: c.height, alpha: a, rgb: rgb };
        });
        }

        var many = Array.isArray(bytes) ? bytes : [bytes];
        return Promise.all(many.map(_decode)).then(function (cells) {
            var st2 = _strip(cells);
            return { url: st2.url, size: st2.size,
                     cells: cells.length, pick: 'random' };
        });
    };

    /* ── Photoshop brushes (.abr) ─────────────────────────────────────── */

    /* An .abr holds tip images and nothing we can use besides -- the
     * dynamics live in a separate descriptor language we do not speak -- so
     * every brush in one arrives as a plain stamp at the tip's own size.
     * That is still most of what the format is used for: it is by far the
     * largest body of free brush art around, and nearly all of it is shapes.
     *
     * Two families of file. Version 1 and 2 are a count and then that many
     * brushes. Version 6 and up wrap them in Photoshop's tagged sections,
     * where the one called "samp" holds the images. Layouts follow GIMP's
     * reader, which is the one implementation that has met every .abr in
     * the wild for twenty years. */

    function _rd(b) {
        var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        return {
            p: 0, len: b.byteLength,
            u8: function () { return b[this.p++]; },
            u16: function () { var v = dv.getUint16(this.p); this.p += 2; return v; },
            i32: function () { var v = dv.getInt32(this.p); this.p += 4; return v; },
            u32: function () { var v = dv.getUint32(this.p); this.p += 4; return v; },
            f64: function () { var v = dv.getFloat64(this.p); this.p += 8; return v; },
            skip: function (n) { this.p += n; }
        };
    }

    /* PackBits, one row at a time: a count of 0..127 means that many literal
     * bytes follow, -1..-127 means the next byte repeated that many times. */
    function _packBits(b, at, end, out, to, want) {
        var n = 0;
        while (n < want && at < end) {
            var c = b[at++];
            if (c === 128) continue;
            if (c < 128) {
                for (var i = 0; i <= c && n < want; i++) out[to + n++] = b[at++];
            } else {
                var v = b[at++];
                for (var j = 0; j < 257 - c && n < want; j++) out[to + n++] = v;
            }
        }
        return at;
    }

    /* The mask, right way up.
     *
     * Photoshop is not consistent about whether a stored byte is coverage or
     * lightness, and the file does not say which. The tip itself does: its
     * outermost pixels are always the paper it was cut out of, so whichever
     * value rings the image is the transparent one. */
    function _abrMask(px, w, h) {
        var edge = 0, n = 0, x, y;
        for (x = 0; x < w; x++) { edge += px[x] + px[(h - 1) * w + x]; n += 2; }
        for (y = 0; y < h; y++) { edge += px[y * w] + px[y * w + w - 1]; n += 2; }
        var a = new Uint8ClampedArray(w * h);
        if (edge / n > 127) { for (var i = 0; i < a.length; i++) a[i] = 255 - px[i]; }
        else { a.set(px); }
        return a;
    }

    function _abrPixels(b, r, depth, compress, w, h) {
        if (w <= 0 || h <= 0 || w > 8192 || h > 8192) return null;
        var step = Math.max(1, depth >> 3);
        var px = new Uint8Array(w * h);
        if (!compress) {
            if (r.p + w * h * step > r.len) return null;
            for (var i = 0; i < w * h; i++) px[i] = b[r.p + i * step];
            r.p += w * h * step;
        } else {
            // A table of row lengths first, then the rows themselves.
            var rows = [];
            for (var y = 0; y < h; y++) rows.push(r.u16());
            var at = r.p;
            for (var y2 = 0; y2 < h; y2++) {
                var end = Math.min(r.len, at + rows[y2]);
                _packBits(b, at, end, px, y2 * w, w);
                at = end;
            }
            r.p = at;
        }
        return { w: w, h: h, px: px };
    }

    /* A tip is a cut-out, so its bytes become coverage. A paper texture is
     * not: it is read as light and dark, so it keeps its bytes as they are. */
    function _abrImage(b, r, depth, compress, w, h) {
        var im = _abrPixels(b, r, depth, compress, w, h);
        if (!im) return null;
        return { w: w, h: h, alpha: _abrMask(im.px, w, h) };
    }

    function _abrV12(b, version) {
        var r = _rd(b);
        r.skip(2);                       // version, already read by the caller
        var count = r.u16(), out = [];
        for (var i = 0; i < count && r.p + 6 <= r.len; i++) {
            var type = r.u16(), size = r.i32();
            var next = r.p + size;
            if (type === 2 && size > 0 && next <= r.len) {
                r.skip(4);               // misc
                r.skip(2);               // spacing
                if (version === 2) {     // a name, as UTF-16
                    var nlen = r.i32();
                    r.skip(Math.max(0, nlen) * 2);
                }
                r.skip(1);               // antialiasing
                r.skip(8);               // the bounds again, as shorts
                var top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
                var depth = r.u16(), compress = r.u8();
                var im = _abrImage(b, r, depth, compress, right - left, bottom - top);
                if (im) out.push(im);
            }
            r.p = next;
            if (next <= 0) break;
        }
        return out;
    }

    /* Photoshop stores a brush's name apart from its image: the `samp`
     * block leads with a Pascal string, which older files use for the name
     * itself and newer ones for a UUID, and the `desc` section holds the
     * names paired with those UUIDs. Without this every tip in a pack of a
     * hundred arrives called "pack 1" ... "pack 100". */
    function _abrPascal(b, at, len) {
        var n = b[at];
        if (!n || n > 63 || at + 1 + n > len) return '';
        var out = '';
        for (var i = 0; i < n; i++) {
            var c = b[at + 1 + i];
            if (c < 32 || c > 126) return '';
            out += String.fromCharCode(c);
        }
        return out;
    }

    var _ABR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /* ── Photoshop descriptors ───────────────────────────────────────── */

    /* A brush's settings are not in the block in front of its image. That
     * block is 301 bytes of something else and skipping it costs nothing:
     * the settings live in the file's `desc` section, written as a
     * Photoshop descriptor -- the same typed tree Photoshop uses to write
     * down everything else.
     *
     * A key is a length and that many characters, or a length of zero and
     * then four characters. A value is a four-character type code followed
     * by whatever that type says. Ten types cover a brush. */

    function _psd4(r, b) {
        var s = String.fromCharCode(b[r.p], b[r.p + 1], b[r.p + 2], b[r.p + 3]);
        r.p += 4;
        return s;
    }

    function _psdKey(r, b) {
        var n = r.u32() || 4, out = '', i;
        if (n > 256 || r.p + n > r.len) { r.p = r.len; return ''; }
        for (i = 0; i < n; i++) out += String.fromCharCode(b[r.p + i]);
        r.p += n;
        return out;
    }

    /* A count of UTF-16 units including the terminator, then the units. */
    function _psdText(r, b) {
        var n = r.u32(), out = '', i, c;
        if (n > 0xffff || r.p + n * 2 > r.len) { r.p = r.len; return ''; }
        for (i = 0; i < n; i++) {
            c = (b[r.p + i * 2] << 8) | b[r.p + i * 2 + 1];
            if (c) out += String.fromCharCode(c);
        }
        r.p += n * 2;
        return out;
    }

    /* One value. Returns undefined for a type we do not know, which the
     * caller treats as "stop": a descriptor cannot be resynchronised, so
     * guessing past an unknown type would invent settings. */
    function _psdValue(r, b, type, depth) {
        var n, i, out;
        if (depth > 24) return undefined;
        switch (type) {
        case 'Objc': case 'GlbO':
            _psdText(r, b);                  // the class's display name
            _psdKey(r, b);                   // the class itself
            return _psdFields(r, b, r.u32(), depth + 1);
        case 'VlLs':
            n = r.u32();
            if (n > 0xffff) { r.p = r.len; return undefined; }
            out = [];
            for (i = 0; i < n; i++) {
                if (r.p + 4 > r.len) return undefined;
                var v = _psdValue(r, b, _psd4(r, b), depth + 1);
                if (v === undefined) return undefined;
                out.push(v);
            }
            return out;
        case 'doub': return r.f64();
        /* A unit float carries its unit -- pixels, percent, degrees -- but
         * the key already says which, so only the number is kept. */
        case 'UntF': r.skip(4); return r.f64();
        case 'TEXT': return _psdText(r, b);
        case 'enum': _psdKey(r, b); return _psdKey(r, b);
        case 'long': return r.i32();
        case 'comp': r.skip(4); return r.u32();
        case 'bool': return !!r.u8();
        case 'tdta': n = r.u32(); r.skip(n); return null;
        case 'type': case 'GlbC': _psdText(r, b); _psdKey(r, b); return null;
        case 'alis': n = r.u32(); r.skip(n); return null;
        }
        return undefined;
    }

    function _psdFields(r, b, count, depth) {
        var out = {}, i, key, v;
        if (count > 0xffff) { r.p = r.len; return out; }
        for (i = 0; i < count; i++) {
            if (r.p + 8 > r.len) break;
            key = _psdKey(r, b);
            v = _psdValue(r, b, _psd4(r, b), depth);
            if (v === undefined) { r.p = r.len; break; }
            out[key] = v;
        }
        return out;
    }

    /* The `desc` section: a version, a class, then the fields. `Brsh` is the
     * list of brushes, in the same order as the file's samples are named --
     * though not the same order as the samples themselves, which is why each
     * one carries the UUID of its own bitmap. */
    /* After the version the file is a run of named 8BIM sections: `samp`
     * holds the bitmaps, `patt` the paper textures, `desc` everything else. */
    function _abrSection(b, want) {
        var r = _rd(b);
        r.skip(4);
        while (r.p + 12 <= r.len) {
            var tag = String.fromCharCode(b[r.p], b[r.p + 1], b[r.p + 2], b[r.p + 3]);
            var key = String.fromCharCode(b[r.p + 4], b[r.p + 5], b[r.p + 6], b[r.p + 7]);
            r.skip(8);
            var size = r.i32();
            if (tag !== '8BIM' || size < 0) break;
            var end = Math.min(r.len, r.p + size);
            if (key === want) return b.subarray(r.p, end);
            r.p = end;
        }
        return null;
    }

    function _abrDescBrushes(b) {
        var sec = _abrSection(b, 'desc');
        if (!sec || sec.length < 8) return [];
        var d = _rd(sec);
        d.skip(4);                           // descriptor version, always 16
        _psdText(d, sec);
        _psdKey(d, sec);
        var root = _psdFields(d, sec, d.u32(), 0);
        return (root.Brsh && root.Brsh.length) ? root.Brsh : [];
    }

    /* The paper textures, in the layout a .pat file uses: a header naming the
     * pattern and its size, then one "virtual memory array" per channel. A
     * grain is only ever read as light and dark, so the first written channel
     * is the whole of it -- there is no colour in a texture we can use. */
    function _abrPatterns(b) {
        var sec = _abrSection(b, 'patt'), out = [];
        if (!sec || sec.length < 32) return out;
        var r = _rd(sec);
        while (r.p + 4 <= r.len) {
            var len = r.i32();
            if (len <= 0 || r.p + len > r.len) break;
            var end = r.p + len + (len % 4 ? 4 - len % 4 : 0);
            r.skip(4);                       // version, always 1
            var mode = r.u32();
            var h = r.u16(), w = r.u16();
            var name = _psdText(r, sec);
            var idn = r.u8();
            r.skip(idn);                     // the pattern's own id
            if (mode === 2) r.skip(768 + 4); // an indexed palette we do not use
            r.skip(8);                       // array version and length
            r.skip(16);                      // the bounds again
            var chans = r.u32(), grey = null, i;
            /* Photoshop writes a slot per channel plus two spares, and any
             * of them may be marked absent. */
            for (i = 0; i < chans + 2 && !grey && r.p + 4 <= r.len; i++) {
                if (!r.u32()) continue;      // this channel was not written
                var clen = r.u32(), at = r.p;
                r.skip(4);                   // pixel depth, as a long
                var top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
                var depth = r.u16(), compress = r.u8();
                grey = _abrPixels(sec, r, depth, compress, right - left, bottom - top);
                r.p = at + Math.max(0, clen);
            }
            if (grey && grey.w > 0) {
                out.push({ name: name, w: grey.w, h: grey.h,
                           url: _canvasFromGray(grey).toDataURL('image/png') });
            } else if (w > 0 && h > 0) {
                out.push({ name: name, w: w, h: h, url: '' });
            }
            r.p = end;
        }
        return out;
    }

    /* The sampled tips, one after another: a length, the tip's id as a
     * Pascal string, a block of settings we cannot use, then the picture.
     * `gap` is that block's length, which is the one thing that differs
     * between the places this layout turns up -- 47 or 301 bytes in an
     * .abr's `samp` section, 10 in a .tpl's `tpbd`. */
    function _abrEntries(sec, gap) {
        var out = [];
        if (!sec) return out;
        var r = _rd(sec), end = sec.length;
        while (r.p + 4 <= end) {
            var blen = r.i32();
            if (blen <= 0) break;
            var bend = r.p + blen + ((4 - blen % 4) % 4);
            var id = _abrPascal(sec, r.p, end);
            r.skip(gap);
            if (r.p + 18 > end) break;
            var top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
            var depth = r.u16(), compress = r.u8();
            var im = _abrImage(sec, r, depth, compress, right - left, bottom - top);
            if (im) { im.id = id; out.push(im); }
            r.p = bend;
        }
        return out;
    }

    function _abrV6(b, sub) {
        return _abrEntries(_abrSection(b, 'samp'), sub === 1 ? 47 : 301);
    }

    /* Photoshop drives a setting from one thing at a time, chosen by number.
     * Every one of them lines up with a sensor of ours, `fade` included --
     * it counts down over a number of dabs, which is what `fStp` carries. */
    var ABR_CONTROL = { 1: 'fade', 2: 'pressure', 3: 'tilt', 4: 'wheel', 5: 'twist' };

    /* Photoshop's blend modes, four characters each. Only the ones a canvas
     * can do are here; anything else is named rather than painted wrong. */
    var ABR_BLEND = {
        'Nrml': 'normal', 'Mltp': 'multiply', 'Scrn': 'screen',
        'Ovrl': 'overlay', 'Drkn': 'darken', 'Lghn': 'lighten',
        'CDdg': 'color-dodge', 'CBrn': 'color-burn', 'HrdL': 'hard-light',
        'SftL': 'soft-light', 'Dfrn': 'difference', 'H   ': 'hue',
        'Strt': 'saturation', 'Clr ': 'color', 'Lmns': 'luminosity',
        'Xclu': 'exclusion'
    };

    /* A dial and its dynamics: `bVTy` picks what drives it, `Mnm ` is how
     * far down that drive can take it, `jitter` is plain randomness. Both
     * can be on at once, and Photoshop adds them; we can only name one
     * source, so a real driver wins and jitter is folded into the floor. */
    /* A dynamics object that drives nothing: no source, no randomness. */
    function _abrIdle(dyn) {
        return !dyn || (!ABR_CONTROL[dyn.bVTy | 0] && !(_num(dyn.jitter, 0) > 0));
    }

    function _abrDyn(out, key, dyn, minPct, warn, what) {
        if (!dyn) return 0;
        var src = ABR_CONTROL[dyn.bVTy | 0];
        var jit = Math.max(0, Math.min(100, _num(dyn.jitter, 0)));
        var floor = _num(dyn['Mnm '], minPct);
        /* One fade length for the brush, not one per dial. Photoshop stores
         * `fStp` on each, but a brush that fades two dials over two different
         * counts is not something either real pack does, and the first one
         * asked for is the honest reading. */
        if (src === 'fade' && out.fadeSteps == null) {
            out.fadeSteps = Math.max(1, Math.min(200, Math.round(_num(dyn.fStp, 0) || 25)));
        }
        if (src) {
            out[key + 'Src'] = src;
            out[key + 'Min'] = Math.max(0, Math.min(100, Math.round(floor)));
        } else if (jit > 0) {
            out[key + 'Src'] = 'random';
            out[key + 'Min'] = Math.round(100 - jit);
        }
        return jit;
    }

    /* One entry of the `desc` section's brush list, as our parameters.
     * Same shape as toPreset, so the caller treats them the same way. */
    BrushPack.abrToPreset = function (entry, opts) {
        var out = {}, warn = [], o = opts || {};
        var tip = (entry && entry.Brsh) || {};

        var dia = _num(tip.Dmtr, 0);
        if (dia > 0) out.size = Math.max(1, Math.round(dia));
        out.shape = o.hasTip ? 'custom' : 'circle';
        /* Opacity, flow and the blend mode belong to the tool rather than
         * to the tip, so an .abr never carries them and a .tpl always does:
         * a tool preset is a saved brush AND the settings it was saved at. */
        out.opacity = Math.max(1, Math.min(100, Math.round(_num(entry.Opct, 100))));
        out.flow = Math.max(1, Math.min(100, Math.round(_num(entry.flow, 100))));
        var md = ABR_BLEND[String(entry['Md  '] || 'Nrml')];
        if (md) { if (md !== 'normal') out.blendMode = md; }
        else warn.push('dropped: the blend mode it paints with');

        /* Photoshop's spacing is a percentage of the brush, same as ours.
         * `Intr` off means it does not step at all -- it paints as fast as
         * the pointer moves, which is our smallest spacing. */
        var sp = _num(tip.Spcn, 25);
        out.spacing = tip.Intr === false ? 1 : Math.max(1, Math.min(400, Math.round(sp)));

        var ang = _num(tip.Angl, 0);
        if (ang) out.angle = ((Math.round(ang) % 360) + 360) % 360;

        /* Roundness is how round the dab stayed; ours is how many times
         * longer it is than it is wide. */
        var rnd = _num(tip.Rndn, 100);
        if (rnd > 0 && rnd < 100) out.aspectRatio = Math.min(20, Math.round(100 / rnd * 100) / 100);

        /* Photoshop turns the tip over and leaves it that way -- it is not
         * Krita's alternate-every-dab mirror, which is what this used to be
         * read as. */
        if (tip.flipX || tip.flipY) {
            out.tipFlip = (tip.flipX && tip.flipY) ? 'both' : (tip.flipX ? 'h' : 'v');
        }

        if (entry.useTipDynamics) {
            _abrDyn(out, 'size', entry.szVr, _num(entry.minimumDiameter, 0), warn, 'the size');
            /* Angle jitter is a share of a full turn, and most brushes ask
             * for a few degrees of wobble. Without the range that would come
             * out as every dab spun to a random heading. */
            var aj = _abrDyn(out, 'angle', entry.angleDynamics, 0, warn, 'the angle');
            if (out.angleSrc === 'random') { out.angleRange = Math.round(aj / 100 * 180); delete out.angleMin; }
            else if (out.angleSrc) delete out.angleMin;
            _abrDyn(out, 'aspectRatio', entry.roundnessDynamics,
                _num(entry.minimumRoundness, 0), warn, 'the roundness');
        }

        if (entry.useScatter) {
            /* Scatter is a spread either side of the line as a percentage of
             * the brush, which is what ours is too. */
            var sc = _num(entry.Spcn, 0);
            if (sc > 0) {
                out.scatter = Math.max(1, Math.min(400, Math.round(sc)));
                out.scatterAxis = entry.bothAxes ? 'both' : 'across';
                _abrDyn(out, 'scatter', entry.scatterDynamics, 0, warn, 'the scatter');
            }
            /* Several dabs at every stop is what makes a Photoshop scatter
             * brush a spray rather than a dotted line, so it is the half of
             * scatter that was doing the most work and the half we dropped. */
            var cnt = Math.round(_num(entry['Cnt '], 1));
            if (cnt > 1) {
                out.dabCount = Math.max(1, Math.min(16, cnt));
                _abrDyn(out, 'dabCount', entry.countDynamics, 0, warn, 'the dab count');
            }
        }

        /* The paper texture is a separate section of the file, so the entry
         * only names one. Neither pack we have measured uses texture at all,
         * so `Txtr` and `Scl ` come from the format rather than from a file
         * -- which is why a brush that asks for a texture we cannot find
         * still says so rather than quietly painting smooth. */
        if (entry.useTexture) {
            var pats = o.patterns || [];
            var want = entry.Txtr && (entry.Txtr.Idnt || entry.Txtr['Nm  ']);
            var pat = null;
            for (var q = 0; q < pats.length; q++) {
                if (!want || pats[q].name === want) { pat = pats[q]; break; }
            }
            if (pat && pat.url) {
                out.texturePattern = pat.url;
                out.texture = 100;
                var scl = _num(entry['Scl '], 0);
                if (scl > 0) out.textureScale = Math.max(1, Math.min(8, scl / 100));
            }
        }

        /* Colour dynamics. The flag is one key and the amounts are others,
         * written out in full the way the newer dials are -- so they are
         * looked up by what they contain rather than by an exact spelling,
         * and a brush whose amounts are somewhere we did not look still says
         * its colour variation was dropped instead of quietly flattening. */
        if (entry.useColorDynamics) {
            var jit = function (want) {
                for (var k in entry) {
                    if (!entry.hasOwnProperty(k)) continue;
                    var lk = k.toLowerCase();
                    if (lk.indexOf(want) >= 0 && lk.indexOf('jitter') >= 0) {
                        return Math.max(0, Math.min(100, _num(entry[k], 0)));
                    }
                }
                return 0;
            };
            /* Photoshop wrote them out in full once and in four bare
             * characters again: `H   `, `Strt` and `Brgh` are the same
             * three dials, and are what a pack saved by a recent Photoshop
             * actually carries. */
            var hj = jit('hue') || _num(entry['H   '], 0);
            var sj = jit('satur') || _num(entry['Strt'], 0);
            var bj = jit('bright') || _num(entry['Brgh'], 0);
            hj = Math.max(0, Math.min(100, hj));
            sj = Math.max(0, Math.min(100, sj));
            bj = Math.max(0, Math.min(100, bj));
            if (hj) out.hueJitter = Math.round(hj / 100 * 180);
            if (sj) out.satJitter = Math.round(sj);
            if (bj) out.valJitter = Math.round(bj);
            if (!(hj || sj || bj)) warn.push('dropped: its colour variation');
        }

        /* Photoshop's Transfer: the flow and the opacity each get the same
         * dynamics object every other dial gets. Ours is one flow, so the
         * flow's own wins and the opacity's stands in when there is no flow
         * one -- and when neither is there the warning still stands. */
        if (entry.usePaintDynamics) {
            /* Both are written whether or not either is on, and a brush
             * that varies its opacity leaves the flow's own switched off --
             * 23 of one real pack's 71 are that way round -- so the one
             * that actually drives something is the one to take. */
            _abrDyn(out, 'flow', _abrIdle(entry.prVr) ? entry.opVr : entry.prVr,
                    0, warn, 'the flow');
        }

        var noted = [
            ['useTexture', 'its paper texture'],
            ['usePaintDynamics', 'its flow and opacity dynamics'],
            ['Wtdg', 'wet edges'],
            ['Nose', 'added noise'],
            ['useBrushPose', 'a fixed pen angle'],
            ['Rpt ', 'protecting the texture across strokes']
        ];
        for (var i = 0; i < noted.length; i++) {
            /* Transfer switched on with both its dials set to nothing is
             * a brush that varies nothing, and 18 of one real pack's 71 are
             * exactly that. Reporting those would be a warning about a
             * feature the file does not use. */
            if (noted[i][0] === 'usePaintDynamics' &&
                (out.flowSrc || _abrIdle(entry.prVr) && _abrIdle(entry.opVr))) continue;
            if (entry[noted[i][0]] && !(noted[i][0] === 'useTexture' && out.texturePattern)) {
                warn.push('dropped: ' + noted[i][1]);
            }
        }
        /* A dual brush is a second tip stamped through the first, and it
         * names its tip exactly the way the brush names its own: by the UUID
         * of a sample in the same file. Neither pack we have measured uses
         * one, so the tip's own dials here come from the format rather than
         * from a file -- but the tip itself is a real image out of the file
         * whenever the UUID resolves, and it says so when it does not. */
        var db = entry.dualBrush;
        if (db && db.useDualBrush) {
            var dtip = db.Brsh || {};
            var got = dtip.sampledData && o.tips &&
                      o.tips[String(dtip.sampledData).toLowerCase()];
            if (got) {
                out._tip2Url = got.url;
                out.tip2Depth = 100;
                var dd = _num(dtip.Dmtr, 0);
                out.tip2Size = (dd > 0 && dia > 0)
                    ? Math.max(10, Math.min(300, Math.round(dd / dia * 100))) : 100;
                var da = _num(dtip.Angl, 0);
                out.tip2Angle = ((Math.round(da) % 360) + 360) % 360;
                var dsp = _num(dtip.Spcn, 0);
                if (dsp > 0) out.tip2Spacing = Math.max(10, Math.min(400, Math.round(dsp)));
                /* The second tip can be blended half a dozen ways. Carving
                 * the first tip with it is multiply -- and darken on an
                 * alpha mask is the same picture -- so say so for the rest
                 * rather than pretend. */
                var dbl = db.BlnM;
                if (dbl && dbl !== 'Mltp' && dbl !== 'Drkn') {
                    warn.push('its second tip blends a way we do not have; it carves the first instead');
                }
            } else {
                warn.push('dropped: its second brush tip');
            }
        }
        if (entry.brushGroup && entry.brushGroup.useBrushGroup) warn.push('dropped: its grouped brushes');

        return { name: entry['Nm  '] || tip['Nm  '] || '', params: out, warnings: warn };
    };

    /* Every tip in a Photoshop brush file, as separate brushes. Unlike a
     * .gih strip these are unrelated shapes that happen to share a file,
     * not variants of one brush -- so each gets its own settings from the
     * descriptor, matched to its bitmap by the UUID both of them carry. */
    BrushPack.readAbr = function (bytes) {
        if (bytes.length < 4) throw new Error('That file is too short to be a brush set.');
        var version = (bytes[0] << 8) | bytes[1];
        var sub = (bytes[2] << 8) | bytes[3];
        var tips;
        if (version === 1 || version === 2) tips = _abrV12(bytes, version);
        else if (version >= 6 && version <= 10) tips = _abrV6(bytes, sub);
        else throw new Error('Photoshop brush version ' + version + ' is one we cannot read.');
        if (!tips.length) throw new Error('No brush tips could be read out of that file.');

        return _abrAssemble(tips, _abrDescBrushes(bytes), _abrPatterns(bytes));
    };

    /* Pair each tip picture with the brush that uses it, and turn the pair
     * into a preset. Shared by .abr and .tpl, which carry the same two
     * halves in differently named blocks. */
    function _abrAssemble(tips, list, pats) {
        var byId = {}, hits = 0, i;
        for (i = 0; i < list.length; i++) {
            var sd = list[i].Brsh && list[i].Brsh.sampledData;
            if (sd) byId[String(sd).toLowerCase()] = list[i];
        }
        for (i = 0; i < tips.length; i++) {
            if (byId[String(tips[i].id || '').toLowerCase()]) hits++;
        }
        /* Older files put the brush's own name where newer ones put a UUID,
         * so nothing matches and the two lists have to be lined up by
         * position instead -- but only when none of them matched, or a
         * half-edited pack would give some brushes somebody else's dials. */
        var byOrder = (!hits && list.length === tips.length);

        /* Each tip's image is built once and shared: a dual brush points at
         * ANOTHER tip in the same file, so building them per brush would
         * decode the same picture twice. */
        var made = tips.map(function (t) { return _strip([t]); });
        var urlById = {};
        for (i = 0; i < tips.length; i++) {
            if (tips[i].id) urlById[String(tips[i].id).toLowerCase()] = made[i];
        }

        return tips.map(function (t, n) {
            var st = made[n];
            var id = String(t.id || '').toLowerCase();
            var entry = byId[id] || (byOrder ? list[n] : null);
            var tr = entry ? BrushPack.abrToPreset(entry, { hasTip: true, patterns: pats, tips: urlById })
                           : { name: '', params: {}, warnings: [] };
            if (!tr.name && t.id && !_ABR_UUID.test(id)) tr.name = t.id;
            return { url: st.url, size: st.size, cells: 1, pick: 'random',
                     name: tr.name, params: tr.params, warnings: tr.warnings };
        });
    }

    /* ── Photoshop tool presets (.tpl) ────────────────────────────────── */

    /* A .tpl is a saved tool, not a saved brush -- but a saved paintbrush
     * carries the whole brush with it, so the ones worth reading hold the
     * same two halves an .abr does under different names: `tpbd` for the
     * tip pictures and `tptp` for the dials. Everything else in the file is
     * some other tool (a healing brush, a shape, a stamp) and is skipped.
     *
     * Measured from three real files -- one Photoshop's own, two from a
     * GrutBrushes pack -- all version 3. */
    function _tplDescs(body) {
        /* A tool preset's descriptor starts the way every top-level
         * Photoshop descriptor does: version 16, an empty class name, then
         * a four-byte key saying which tool it is -- `PbTl` for the
         * paintbrush. The framing around them differs from tool to tool, so
         * the descriptors are found by that signature rather than by
         * counting through names we do not need. */
        var out = [], i, n = body.length - 22, k;
        for (i = 0; i <= n; i++) {
            if (body[i] || body[i + 1] || body[i + 2] || body[i + 3] !== 16) continue;
            if (body[i + 4] || body[i + 5] || body[i + 6] || body[i + 7] !== 1) continue;
            if (body[i + 8] || body[i + 9]) continue;                 // an empty class name
            if (body[i + 10] || body[i + 11] || body[i + 12] || body[i + 13]) continue;
            for (k = 14; k < 18; k++) {
                var c = body[i + k];
                if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
                      (c >= 97 && c <= 122))) break;
            }
            if (k < 18) continue;
            var sub = body.subarray(i), d = _rd(sub);
            try {
                d.skip(4);
                _psdText(d, sub);
                _psdKey(d, sub);
                var count = d.u32();
                if (count < 1 || count > 1000) continue;
                var fields = _psdFields(d, sub, count, 0);
                if (fields && Object.keys(fields).length) out.push(fields);
            } catch (e) { /* not a descriptor after all */ }
        }
        return out;
    }

    BrushPack.readTpl = function (bytes) {
        var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        if (b.length < 12 || b[0] !== 0x38 || b[1] !== 0x42 ||
            b[2] !== 0x54 || b[3] !== 0x50) {
            throw new Error('That is not a Photoshop tool preset file.');
        }
        var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
        var tips = [], list = [], p = 12;
        while (p + 12 <= b.length && b[p] === 0x38 && b[p + 1] === 0x42 &&
               b[p + 2] === 0x49 && b[p + 3] === 0x4d) {
            var key = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
            var size = dv.getInt32(p + 8);
            if (size < 0 || p + 12 + size > b.length) break;
            var body = b.subarray(p + 12, p + 12 + size);
            if (key === 'tpbd') tips = tips.concat(_abrEntries(body, 47));
            else if (key === 'tptp') list = list.concat(_tplDescs(body));
            p += 12 + size;
        }
        if (!tips.length) {
            throw new Error('That tool preset holds no brush -- only tools ' +
                'that paint with a tip of their own bring one.');
        }
        return _abrAssemble(tips, list, []);
    };

    /* ── GIMP generated brushes (.vbr) ─────────────────────── */

    /* A .vbr is a shape described rather than drawn: eight or ten numbers
     * of plain text, no picture at all. GIMP builds the dab from them every
     * time the brush is used, and so do we -- there is nothing else in the
     * file to use.
     *
     * Version 1.0 is name, spacing, radius, hardness, aspect, angle.
     * Version 1.5 adds a shape name after the name and a spike count after
     * the radius. Both were read off real files from a GIMP 2 install.
     *
     * Spikes are what make these stars: the shape is drawn `spikes` times,
     * each turned a further half-turn divided by their number, and the dab
     * is wherever any of them landed. Four thin ellipses at 45 degrees is
     * an eight-pointed star, which is exactly what GIMP's "Diagonal Star
     * (17)" is. */

    var VBR_SHAPES = { circle: 1, square: 1, diamond: 1 };

    function _vbrMask(shape, r, spikes, hard, aspect, angle) {
        var side = Math.max(1, Math.ceil(r * 2)), c = side / 2;
        var a = new Uint8ClampedArray(side * side);
        /* Two spikes is GIMP's default and means the plain shape -- every
         * ordinary round, square or rectangular brush in the stock set says
         * 2. Above that the shape is drawn once per spike, each turned a
         * further half-turn divided by their number, and the dab is
         * wherever any of them landed. */
        var steps = [], i, n = spikes > 2 ? spikes : 1;
        for (i = 0; i < n; i++) {
            var t = (angle + i * 180 / n) * Math.PI / 180;
            steps.push([Math.cos(t), Math.sin(t)]);
        }
        var soft = 1 - Math.min(0.999, hard);
        for (var y = 0; y < side; y++) {
            for (var x = 0; x < side; x++) {
                var dx = x + 0.5 - c, dy = y + 0.5 - c, best = 1e9;
                for (i = 0; i < steps.length; i++) {
                    var u = (dx * steps[i][0] + dy * steps[i][1]) / r;
                    var v = (dy * steps[i][0] - dx * steps[i][1]) * aspect / r;
                    var d = shape === 'square' ? Math.max(Math.abs(u), Math.abs(v))
                          : shape === 'diamond' ? Math.abs(u) + Math.abs(v)
                          : Math.sqrt(u * u + v * v);
                    if (d < best) best = d;
                }
                a[y * side + x] = best >= 1 ? 0
                    : Math.round(255 * Math.min(1, (1 - best) / soft));
            }
        }
        return { w: side, h: side, alpha: a };
    }

    BrushPack.readVbr = function (text, filename) {
        var lines = String(text).split(/\r?\n/);
        if ((lines[0] || '').trim() !== 'GIMP-VBR') {
            throw new Error('That is not a GIMP generated brush.');
        }
        var ver = parseFloat(lines[1]), at = 3;
        var name = String(lines[2] || '').trim();
        var shape = 'circle', spikes = 2;
        if (ver >= 1.5) {
            shape = String(lines[at++] || 'circle').trim().toLowerCase();
            if (!VBR_SHAPES[shape]) shape = 'circle';
        }
        var spacing = _num(lines[at++], 10);
        var radius = _num(lines[at++], 10);
        if (ver >= 1.5) spikes = Math.max(2, Math.min(20, Math.round(_num(lines[at++], 2))));
        var hard = Math.max(0, Math.min(1, _num(lines[at++], 1)));
        var aspect = Math.max(1, Math.min(100, _num(lines[at++], 1)));
        var angle = _num(lines[at++], 0);
        if (!(radius > 0)) throw new Error('That generated brush has no size.');

        var out = {
            size: Math.max(1, Math.min(1000, Math.round(radius * 2))),
            spacing: Math.max(1, Math.min(400, Math.round(spacing))),
            opacity: 100, flow: 100,
            hardness: Math.round(hard * 100),
            shape: 'circle'
        };
        /* A plain round one needs no picture: that is the brush we already
         * are, and keeping it parametric means it stays sharp at any size. */
        if (shape === 'circle' && spikes === 2 && aspect === 1) {
            if (angle) out.angle = ((Math.round(angle) % 360) + 360) % 360;
            return { name: name, params: out, tip: null };
        }
        var lim = Math.min(TIP_CAP_PX / 2, 400);
        var st = _strip([_vbrMask(shape, Math.min(lim, radius), spikes, hard, aspect, angle)]);
        out.shape = 'custom';
        /* The picture already carries the softness the file asked for, so
         * the dab must not be softened a second time on the way out. */
        out.hardness = 100;
        return { name: name, params: out,
                 tip: { url: st.url, size: st.size, cells: 1, pick: 'random' } };
    };

    /* ── MyPaint brushes (.myb) ───────────────────────────────────────── */

    /* MyPaint paints with no tip image at all: every mark is a soft round
     * dab and the character comes from forty settings, each of which can be
     * driven by pressure, speed, direction or randomness. Only some of those
     * forty have anything to correspond to here, so a .myb arrives as a
     * likeness rather than a copy -- and says which parts of itself it left
     * at the door.
     *
     * Two file shapes: newer ones are JSON, older ones a line per setting
     * reading `name value | input (x,y), (x,y)`. Both say the same things. */

    var MYB_INPUTS = { pressure: 'pressure', speed1: 'speed', speed2: 'speed',
        random: 'random', direction: 'direction', tilt_declination: 'tilt',
        tilt_ascension: 'tilt', barrel_rotation: 'twist' };

    /* Settings we read. Everything else in the file is reported by name so
     * the import says what it could not carry across. */
    var MYB_KNOWN = {
        radius_logarithmic: 1, hardness: 1, opaque: 1, opaque_multiply: 1,
        dabs_per_actual_radius: 1, dabs_per_basic_radius: 1, offset_by_random: 1,
        elliptical_dab_ratio: 1, elliptical_dab_angle: 1, eraser: 1,
        smudge: 1, smudge_length: 1, color_h: 1, color_s: 1, color_v: 1,
        opaque_linearize: 1, slow_tracking: 1, slow_tracking_per_dab: 1,
        anti_aliasing: 1, restore_color: 1, change_color_h: 1, change_color_l: 1,
        change_color_hsl_s: 1, change_color_v: 1, change_color_hsv_s: 1,
        lock_alpha: 1, colorize: 1, snap_to_pixel: 1, pressure_gain_log: 1,
        dabs_per_second: 1,
        // named so they are not reported: they describe MyPaint's own
        // smoothing and speed model, which we do not expose as brush settings
        speed1_slowness: 1, speed2_slowness: 1, speed1_gamma: 1, speed2_gamma: 1,
        stroke_duration_logarithmic: 1, stroke_holdtime: 1, stroke_threshold: 1,
        custom_input: 1, custom_input_slowness: 1, direction_filter: 1,
        tracking_noise: 1
    };

    /* The ones whose absence really changes the mark, so they are worth
     * naming rather than counting. */
    var MYB_NOTED = {
        radius_by_random: 'a randomly varying dab size',
        stroke_holdtime: '',
        gridmap_scale: 'a texture grid',

        /* MyPaint 2 places the dab away from the cursor through a whole
         * family of dials. They are one feature to a painter, so they get
         * one line -- the warnings are de-duplicated below. */
        offset_by_speed: 'dabs placed away from the cursor',
        offset_by_speed_slowness: 'dabs placed away from the cursor',
        /* The rest of the family is a second offset vector with its own
         * angle, each end of it drivable from its own sensor. Our offset is
         * one distance along the line and one across it, so these are a
         * different thing rather than more of the same -- and saying "dabs
         * placed away from the cursor" about them would be wrong on the
         * thirteen brushes whose offset we now DO place. */
        offset_multiplier: 'the finer controls on where a dab lands',
        offset_x: 'the finer controls on where a dab lands',
        offset_y: 'the finer controls on where a dab lands',
        offset_angle: 'the finer controls on where a dab lands',
        offset_angle_asc: 'the finer controls on where a dab lands',
        offset_angle_2: 'the finer controls on where a dab lands',
        offset_angle_2_asc: 'the finer controls on where a dab lands',
        offset_angle_adj: 'the finer controls on where a dab lands',

        posterize: 'posterising', posterize_num: 'posterising',

        smudge_bucket: 'the finer smudge controls',
        smudge_radius_log: 'the finer smudge controls',
        smudge_length_log: 'the finer smudge controls',
        smudge_transparency: 'the finer smudge controls'
    };

    /* Most MyPaint dials rest at 0, so "not zero" reads as "switched on".
     * These rest somewhere else, and reporting them as dropped features
     * tells the user a brush uses something it does not. */
    var MYB_NEUTRAL = {
        offset_by_speed_slowness: 1, gridmap_scale_x: 1, gridmap_scale_y: 1,
        paint_mode: 1, posterize_num: 0.05
    };

    /* And these only mean anything while a companion dial is on: a smudge
     * radius with no smudge changes nothing at all. */
    var MYB_GATED = {
        offset_by_speed_slowness: ['offset_by_speed'],
        offset_multiplier: ['offset_by_random', 'offset_by_speed'],
        posterize_num: ['posterize'],
        smudge_radius_log: ['smudge'],
        smudge_length_log: ['smudge'],
        smudge_bucket: ['smudge'],
        smudge_transparency: ['smudge'],
        gridmap_scale_x: ['gridmap_scale'], gridmap_scale_y: ['gridmap_scale']
    };

    function _mybLines(text) {
        var out = {}, lines = String(text).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (!ln || ln.charAt(0) === '#') continue;
            var bar = ln.indexOf('|');
            var head = (bar < 0 ? ln : ln.slice(0, bar)).trim().split(/\s+/);
            var key = head[0];
            if (!key) continue;
            var rec = { base: parseFloat(head[1]), inputs: {} };
            if (bar >= 0) {
                var parts = ln.slice(bar + 1).split('|');
                for (var j = 0; j < parts.length; j++) {
                    var m = /^\s*(\w+)\s*(.*)$/.exec(parts[j]);
                    if (!m) continue;
                    var pts = [], pm, re = /\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g;
                    while ((pm = re.exec(m[2]))) pts.push([parseFloat(pm[1]), parseFloat(pm[2])]);
                    if (pts.length >= 2) rec.inputs[m[1]] = pts;
                }
            }
            out[key] = rec;
        }
        return out;
    }

    function _mybJson(obj) {
        var out = {}, st = obj.settings || {};
        for (var k in st) {
            if (!st.hasOwnProperty(k)) continue;
            var v = st[k];
            out[k] = { base: (v && typeof v === 'object') ? _num(v.base_value, 0) : _num(v, 0),
                       inputs: (v && v.inputs) || {} };
        }
        return out;
    }

    /* MyPaint's input curves run over the input's own range -- pressure is
     * 0..1, but the y axis is an ADDITION to the setting in its own units,
     * not a multiplier. Ours is a multiplier over 0..1. So the curve is
     * rescaled against the largest step it takes, which keeps its shape --
     * the part that makes a brush feel the way it does -- and lets the
     * setting's own value carry the magnitude. */
    function _mybCurve(pts) {
        if (!pts || pts.length < 2) return null;
        var lo = Infinity, hi = -Infinity, i;
        for (i = 0; i < pts.length; i++) { lo = Math.min(lo, pts[i][1]); hi = Math.max(hi, pts[i][1]); }
        if (!(hi > lo)) return null;
        var out = [];
        for (i = 0; i < pts.length; i++) {
            out.push([Math.max(0, Math.min(1, pts[i][0])),
                      Math.max(0, Math.min(1, (pts[i][1] - lo) / (hi - lo)))]);
        }
        out.sort(function (a, b) { return a[0] - b[0]; });
        return out;
    }

    /* How far a setting's input curves reach, in the setting's own units,
     * keeping the sign of whichever end reaches furthest.
     *
     * _mybCurve throws this away on purpose: for size and flow the engine's
     * own base carries the magnitude and only the SHAPE is wanted. An offset
     * has no base of its own here -- most real brushes leave it at zero and
     * put the whole distance in the curve -- so for that one the reach is
     * the number that matters. */
    function _mybPeak(set, name) {
        var rec = set[name], peak = 0;
        if (!rec || !rec.inputs) return 0;
        for (var id in rec.inputs) {
            if (!rec.inputs.hasOwnProperty(id) || !MYB_INPUTS[id]) continue;
            var pts = rec.inputs[id];
            for (var i = 0; i < pts.length; i++) {
                if (Math.abs(pts[i][1]) > Math.abs(peak)) peak = pts[i][1];
            }
        }
        return peak;
    }

    function _mybDrive(out, key, set, name) {
        var rec = set[name];
        if (!rec || !rec.inputs) return;
        for (var id in rec.inputs) {
            if (!rec.inputs.hasOwnProperty(id)) continue;
            var src = MYB_INPUTS[id];
            if (!src) continue;
            var curve = _mybCurve(rec.inputs[id]);
            if (!curve) continue;
            out[key + 'Src'] = src;
            out[key + 'Min'] = 0;
            out[key + 'Curve'] = curve;
            return;
        }
    }

    /* One MyPaint brush as our parameters. Same shape as toPreset, so the
     * caller treats both the same way. */
    BrushPack.readMyb = function (text, name) {
        var set, obj = null;
        var trimmed = String(text).replace(/^﻿/, '').trim();
        if (trimmed.charAt(0) === '{') {
            try { obj = JSON.parse(trimmed); } catch (e) { obj = null; }
            if (!obj) throw new Error('That MyPaint brush is not readable.');
            set = _mybJson(obj);
        } else {
            set = _mybLines(trimmed);
            if (!set.radius_logarithmic && !set.opaque) {
                throw new Error('That file is not a MyPaint brush.');
            }
        }
        var base = function (k, d) { return set[k] ? _num(set[k].base, d) : d; };
        var warn = [], out = {};

        // MyPaint stores the log of the dab RADIUS in pixels.
        out.size = Math.max(1, Math.min(800, Math.round(2 * Math.exp(base('radius_logarithmic', 1.5)))));
        out.shape = 'circle';
        out.hardness = Math.round(Math.max(0, Math.min(1, base('hardness', 0.8))) * 100);
        out.opacity = 100;
        /* `opaque` is per dab, which is our flow; the stroke's own opacity
         * is a separate idea there and always full.
         *
         * `opaque_multiply` scales it, but almost every real brush leaves its
         * base at 0 and hangs a pressure curve off it -- that is MyPaint's
         * idiom for "flow follows pressure", not "paint nothing". So it only
         * multiplies when it is a plain number, and otherwise it is the thing
         * that drives flow. */
        var mult = set.opaque_multiply,
            multDrives = !!(mult && mult.inputs && Object.keys(mult.inputs).length);
        out.flow = Math.round(Math.max(0, Math.min(1,
            base('opaque', 1) * (multDrives ? 1 : base('opaque_multiply', 1)))) * 100) || 100;

        /* Dabs per radius, not spacing: MyPaint counts how many land within
         * one radius, so the gap between them is the other way up. */
        var per = base('dabs_per_actual_radius', 0) || base('dabs_per_basic_radius', 0);
        out.spacing = per > 0 ? Math.max(1, Math.min(400, Math.round(50 / per))) : 10;

        /* offset_by_random is a spread in RADIUS units; ours is a fraction
         * of the dab's width, so it is half the number. */
        var off = base('offset_by_random', 0);
        if (off > 0) out.scatter = Math.max(1, Math.min(400, Math.round(off * 50)));

        /* offset_by_speed pushes the dab along the line by how fast the hand
         * is moving, in radius units, and it can run negative -- the dab
         * trails instead of leading. Twenty-seven of the 196 real brushes
         * ask for it, which made it the largest thing we dropped. */
        var ofsB = base('offset_by_speed', 0), ofsP = _mybPeak(set, 'offset_by_speed');
        /* MyPaint adds the curve to the base; ours multiplies a distance by
         * the sensor, so the distance is both of them together and the floor
         * is the base's share of it. The two pulling opposite ways cannot be
         * said that way at all, so the bigger one wins and the floor is
         * nothing. */
        var ofs = (ofsB * ofsP < 0) ?
            (Math.abs(ofsB) > Math.abs(ofsP) ? ofsB : ofsP) : ofsB + ofsP;
        if (Math.abs(ofs) > 0.001) {
            out.offsetAlong = Math.max(-400, Math.min(400, Math.round(ofs * 50)));
            out.offsetSrc = 'speed';
            out.offsetMin = (ofsP && ofsB * ofsP > 0)
                ? Math.round(Math.abs(ofsB / ofs) * 100) : 0;
        }

        var ratio = base('elliptical_dab_ratio', 1);
        if (ratio > 1) {
            out.aspectRatio = Math.round(Math.min(20, ratio) * 100) / 100;
            /* The angle exists only to turn a flattened dab. A round one
             * still carries 90 in the file, where it means nothing. */
            var ang = base('elliptical_dab_angle', 0);
            if (ang) out.angle = Math.round(ang) % 360;
        }

        if (base('eraser', 0) > 0.5) out.blendMode = 'erase';

        var smudge = base('smudge', 0);
        if (smudge > 0.02) {
            out.colorRate = Math.round((1 - Math.min(1, smudge)) * 100);
            out.smudgeLength = Math.round(Math.max(0, Math.min(1, base('smudge_length', 0.5))) * 100);
            /* smudge_radius_log is a doubling: 0 is the dab's own radius, 1
             * is twice it, -1 half. Across MyPaint's own collection it spans
             * a quarter to four times, and a wide sampler is the difference
             * between a blender and a smear. */
            var sr = base('smudge_radius_log', 0);
            if (sr) out.smudgeRadius = Math.max(25, Math.min(400,
                Math.round(Math.pow(2, sr) * 100)));
        }

        /* Laying dabs down by the clock rather than by distance is what
         * our airbrush mode does, and the units already agree. */
        var dps = base('dabs_per_second', 0);
        if (dps > 0) {
            out.airbrushMode = true;
            out.airbrushRate = Math.max(1, Math.min(100, Math.round(dps)));
        }

        /* A dab whose size wanders. MyPaint's spread is in the same log
         * units as the radius, so a spread of r means a dab anywhere between
         * e^-r and e^r of the base -- and since our randomness only takes
         * size away, the floor is the whole of it. Left as a warning while
         * something else already drives the size: one driver at a time. */
        var wob = base('radius_by_random', 0);

        /* Only once an offset really landed. A file that leaves the base at
         * zero and hangs a curve off it is asking for an offset that is
         * ENTIRELY sensor-driven, and our offset is a distance the sensor
         * scales -- so there is nothing for the curve to scale, and the
         * honest answer is the warning it already had. */
        if (out.offsetAlong) _mybDrive(out, 'offset', set, 'offset_by_speed');
        _mybDrive(out, 'size', set, 'radius_logarithmic');
        _mybDrive(out, 'flow', set, multDrives ? 'opaque_multiply' : 'opaque');

        if (wob > 0 && !out.sizeSrc) {
            out.sizeSrc = 'random';
            out.sizeMin = Math.max(1, Math.min(99, Math.round(Math.exp(-wob) * 100)));
        }

        for (var k in set) {
            if (!set.hasOwnProperty(k)) continue;
            if (MYB_KNOWN[k]) continue;
            if (k === 'radius_by_random' && out.sizeSrc === 'random') continue;
            if (k === 'offset_by_speed' && out.offsetAlong) continue;
            if (k === 'smudge_radius_log' && out.smudgeRadius) continue;
            var rec = set[k];
            var live = _num(rec.base, 0) !== (MYB_NEUTRAL[k] || 0) ||
                       (rec.inputs && Object.keys(rec.inputs).length > 0);
            if (!live) continue;
            var gate = MYB_GATED[k], on = !gate, g;
            for (g = 0; gate && g < gate.length; g++) if (base(gate[g], 0)) on = true;
            if (!on) continue;
            var label = MYB_NOTED[k];
            if (label === '') continue;
            var line = 'dropped: ' + (label || k.replace(/_/g, ' '));
            if (warn.indexOf(line) < 0) warn.push(line);
        }
        if (out.aspectRatio && !out.angle) {
            warn.push('the flattened dab does not turn with the stroke here');
        }

        /* `comment` is the format's own banner line -- every file carries the
         * same "MyPaint brush file" -- so the brush's name is its description,
         * and failing that the file it came in. */
        var title = (obj && obj.description && String(obj.description).trim()) || name || 'MyPaint brush';
        return { name: String(title).slice(0, 40), params: out, tipFile: null, warnings: warn };
    };

    /* ── Procreate (.brush / .brushset) ───────────────────────────────── */

    /* A .brush is a ZIP holding Shape.png, Grain.png and Brush.archive; a
     * .brushset is a ZIP of those, one folder per brush. Brush.archive is a
     * binary property list written by NSKeyedArchiver, so reading a brush
     * means reading two formats before any brush setting appears.
     *
     * Apple's binary plist: a header, the objects, then a table of where
     * each object starts, then a 32-byte trailer saying how wide the offsets
     * and the references are. Every object begins with a marker byte whose
     * top nibble is the type; a length of 15 in the bottom nibble means the
     * real length is the integer that follows.
     *
     * Verified against Python's plistlib, which writes the same format from
     * an independent implementation -- see test/fixtures/brushes/README. */
    function _bplist(u8) {
        if (u8.length < 40) return null;
        var magic = '';
        for (var m = 0; m < 6; m++) magic += String.fromCharCode(u8[m]);
        if (magic !== 'bplist') return null;

        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        var t = u8.length - 32;
        var offSize = u8[t + 6], refSize = u8[t + 7];
        var numObjs = _readBE(dv, t + 8, 8);
        var top = _readBE(dv, t + 16, 8);
        var tableAt = _readBE(dv, t + 24, 8);
        if (!(numObjs > 0) || tableAt + numObjs * offSize > u8.length) return null;

        var offsets = [];
        for (var i = 0; i < numObjs; i++) {
            offsets.push(_readBE(dv, tableAt + i * offSize, offSize));
        }

        /* Objects can reference each other, and a malformed file can make
         * that a cycle. Each one is read at most once and remembered. */
        var cache = new Array(numObjs);
        var reading = new Array(numObjs);

        function obj(idx) {
            if (!(idx >= 0 && idx < numObjs)) return null;
            if (idx in cache) return cache[idx];
            if (reading[idx]) return null;
            reading[idx] = true;
            var v = _bpObj(dv, u8, offsets[idx], refSize, obj);
            cache[idx] = v;
            return v;
        }
        return obj(top);
    }

    function _readBE(dv, at, size) {
        var v = 0;
        for (var i = 0; i < size; i++) v = v * 256 + dv.getUint8(at + i);
        return v;
    }

    function _bpObj(dv, u8, at, refSize, ref) {
        var marker = u8[at];
        var type = marker >> 4, info = marker & 0x0f;
        var p = at + 1;

        function len() {
            if (info !== 0x0f) return info;
            var szMarker = u8[p++];
            var n = 1 << (szMarker & 0x0f);
            var v = _readBE(dv, p, n);
            p += n;
            return v;
        }

        switch (type) {
            case 0x0:
                return info === 0 ? null : (info === 8 ? false : (info === 9 ? true : null));
            case 0x1: {                                      // int
                var isz = 1 << info;
                /* One, two and four byte integers are unsigned; eight bytes
                 * and up are two's complement, which is the only way a
                 * negative number is ever written. Reading those unsigned
                 * turned -7 into 1.8e19. */
                if (isz >= 8) return Number(dv.getBigInt64(p + isz - 8));
                return _readBE(dv, p, isz);
            }
            case 0x2:                                        // real
                return (info === 2) ? dv.getFloat32(p) : dv.getFloat64(p);
            case 0x3: return new Date((dv.getFloat64(p) + 978307200) * 1000);
            case 0x4: {                                      // data
                var dn = len();
                return u8.subarray(p, p + dn);
            }
            case 0x5: {                                      // ASCII string
                var an = len(), sa = '';
                for (var i = 0; i < an; i++) sa += String.fromCharCode(u8[p + i]);
                return sa;
            }
            case 0x6: {                                      // UTF-16BE string
                var un = len(), su = '';
                for (var j = 0; j < un; j++) su += String.fromCharCode(_readBE(dv, p + j * 2, 2));
                return su;
            }
            case 0x8:                                        // UID -- a reference
                return { __uid: _readBE(dv, p, info + 1) };
            case 0xa:                                        // array
            case 0xc: {                                      // set
                var an2 = len(), arr = [];
                for (var k = 0; k < an2; k++) arr.push(ref(_readBE(dv, p + k * refSize, refSize)));
                return arr;
            }
            case 0xd: {                                      // dict
                var dn2 = len(), o = {};
                for (var q = 0; q < dn2; q++) {
                    var key = ref(_readBE(dv, p + q * refSize, refSize));
                    var val = ref(_readBE(dv, p + (dn2 + q) * refSize, refSize));
                    if (typeof key === 'string') o[key] = val;
                }
                return o;
            }
            default: return null;
        }
    }

    /* NSKeyedArchiver stores everything flat in $objects and refers to it by
     * index, so the real tree has to be put back together. Only the shape a
     * brush uses is handled: dictionaries, arrays and leaves. */
    function _unarchive(plist) {
        if (!plist || !plist.$objects) return plist;
        var objs = plist.$objects;
        var seen = [];

        function walk(v, depth) {
            if (depth > 24) return null;
            if (v && typeof v === 'object' && typeof v.__uid === 'number') {
                if (seen.indexOf(v.__uid) !== -1) return null;
                seen.push(v.__uid);
                var r = walk(objs[v.__uid], depth + 1);
                seen.pop();
                return r;
            }
            if (Array.isArray(v)) {
                return v.map(function (x) { return walk(x, depth + 1); });
            }
            if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof Uint8Array)) {
                var o = {};
                for (var k in v) {
                    if (!v.hasOwnProperty(k) || k === '$class') continue;
                    o[k] = walk(v[k], depth + 1);
                }
                return o;
            }
            return v;
        }
        var top = plist.$top && (plist.$top.root !== undefined ? plist.$top.root : plist.$top);
        return walk(top === undefined ? plist : top, 0);
    }

    BrushPack.readBplist = function (bytes) { return _bplist(bytes); };
    BrushPack.unarchive = _unarchive;

    /* Which archive keys we understand, and what each one means here.
     *
     * Matched by pattern rather than by exact name on purpose: Procreate has
     * renamed and re-prefixed these across versions, and the names stay
     * descriptive even when they move. A run of `shapeScatter` and a run of
     * `shape_scatter` mean the same thing, and a reader keyed to one spelling
     * silently imports a brush with no scatter rather than saying so. */
    /* Procreate's own key names, read off a real Brush.archive rather than
     * guessed from the format notes.
     *
     * The first cut matched keys by pattern, which looked tolerant and was
     * in fact the opposite: /shape.*angle$/ picked up
     * shapeRoundnessTiltAngle -- a tilt threshold -- and reported a
     * straight brush as turned six degrees. A real file has around two
     * hundred keys and a dozen of them end in "Angle". Name them. */
    var PROCREATE_KEYS = {
        paintOpacity:            'opacity',
        plotSpacing:             'spacing',
        plotJitter:              'jitter',
        shapeScatter:            'scatter',
        shapeAngle:              'angle',
        shapeRandomise:          'angleRandom',
        shapeRoundness:          'roundness',
        grainDepth:              'texture',
        textureScale:            'textureScale',
        textureZoom:             'textureZoom',
        taperStartLength:        'taperStart',
        taperEndLength:          'taperEnd',
        dynamicsPressureSize:    'pressureSize',
        dynamicsPressureOpacity: 'pressureFlow',
        dynamicsSpeedSize:       'speedSize',
        dynamicsSpeedOpacity:    'speedFlow',
        dynamicsTiltSize:        'tiltSize',
        dynamicsTiltOpacity:     'tiltFlow',
        dynamicsJitterHue:             'jitHue',
        dynamicsJitterSaturation:      'jitSat',
        dynamicsJitterLightness:       'jitLight',
        dynamicsJitterDarkness:        'jitDark',
        dynamicsJitterStrokeHue:        'strokeHue',
        dynamicsJitterStrokeSaturation: 'strokeSat',
        dynamicsJitterStrokeLightness:  'strokeLight',
        dynamicsJitterStrokeDarkness:   'strokeDark',
        taperSize:               'taperSize',
        taperOpacity:            'taperOpacity',
        plotSmoothing:           'smoothing',
        shapeCount:              'shapeCount',
        dynamicsMix:             'mix',
        dynamicsPressureMix:     'pressureMix',
        dynamicsRollSize:        'rollSize',
        shapeFlipXJitter:        'flipX',
        shapeFlipYJitter:        'flipY'
    };

    /* Procreate draws its response curves as a list of "{x, y}" strings, in
     * the 0..1 square our own curve points use. The straight line is what
     * every dial that has not been drawn on holds, and saying so is the same
     * as saying nothing, so it is left off. */
    function _pcCurve(v) {
        var list = v && v.points && v.points['NS.objects'];
        if (!Array.isArray(list) || list.length < 2) return null;
        var pts = [], i, m;
        for (i = 0; i < list.length; i++) {
            m = /^\{\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\}$/.exec(String(list[i]));
            if (!m) return null;
            pts.push([Math.max(0, Math.min(1, parseFloat(m[1]))),
                      Math.max(0, Math.min(1, parseFloat(m[2])))]);
        }
        var straight = pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 &&
                       pts[1][0] === 1 && pts[1][1] === 1;
        return straight ? null : pts;
    }

    /* Settings Procreate has that we cannot reproduce, by exact key.
     *
     * Every one of these is only worth saying when the brush actually turns
     * it on. The pattern version reported five features on a brush that used
     * none of them, because /smudge/ matched smudgeOpacity (the remembered
     * slider, always 1) and /bleed/ matched dynamicsPressureBleedSpeed (a
     * response rate, always about 0.4). A default is not a feature. */
    var PROCREATE_NOTED = [
        [['dynamicsMix', 'dynamicsPressureMix', 'dynamicsMixSoftening'], 'colour mixing'],
        [['dynamicsBlur', 'dynamicsBlurJitter'], 'blur'],
        [['wetEdgesAmount'], 'wet edges'],
        [['burntEdgesAmount'], 'burnt edges'],
        [['dynamicsPressureBleed', 'dynamicsTiltBleed', 'dynamicsRollBleed'], 'colour bleed'],
        [['dynamicsSpeedSize', 'dynamicsSpeedOpacity'], 'speed-driven dynamics'],
        [['shapeFlipXJitter', 'shapeFlipYJitter'], 'per-dab shape flipping'],
        [['dynamicsJitterHue', 'dynamicsJitterSaturation', 'dynamicsJitterLightness',
          'dynamicsJitterDarkness'], 'per-dab colour jitter'],
        [['dynamicsJitterStrokeHue', 'dynamicsJitterStrokeSaturation',
          'dynamicsJitterStrokeLightness', 'dynamicsJitterStrokeDarkness'],
         'per-stroke colour jitter'],
        [['dynamicsPressureHue', 'dynamicsPressureSaturation',
          'dynamicsPressureBrightness'], 'pressure-driven colour'],
        /* The roundness dials sit at 1 when they do nothing, not at 0 like
         * every other dial here, so they belong in no "is it on" list. */
        [['dynamicsTiltSize', 'dynamicsTiltOpacity', 'dynamicsTiltBrightness'], 'pen tilt'],
        [['attackRoll', 'shapeRoll', 'dynamicsRollSize'], 'barrel roll'],
        [['metallicAmount'], 'its metallic layer'],
        /* The blend mode is a number whose meanings we have no reference
         * for, so a brush that paints in one of them says so rather than
         * being quietly painted normally. */
        [['blendMode'], 'the blend mode it paints with']
    ];

    /* A dial and the things that can drive it. Our engine names one source,
     * so the first one the brush actually uses wins; the others are left to
     * the warnings, which is what PROCREATE_PLACED keeps honest. */
    function _pcDrive(out, key, pressure, curve, tilt, speed, roll) {
        var src = null, floor = 0, amount = 0;
        if (pressure > 0.01) { src = 'pressure'; amount = pressure; }
        else if (tilt > 0.01) { src = 'tilt'; amount = tilt; }
        else if (speed > 0.01) { src = 'speed'; amount = speed; }
        else if (roll > 0.01) { src = 'twist'; amount = roll; }
        if (!src) { out[key + 'Src'] = 'none'; return; }
        /* Procreate's dials are how MUCH the driver does, which is the depth
         * of our response and not its shape: at 0 the brush ignores the pen,
         * at 1 it follows it all the way down to nothing. */
        floor = Math.round((1 - Math.min(1, amount)) * 100);
        out[key + 'Src'] = src;
        out[key + 'Min'] = floor;
        if (src === 'pressure') {
            var pts = _pcCurve(curve);
            if (pts) out[key + 'Curve'] = pts;
        }
    }

    /* Which warning each key belongs to only if the setting did not find a
     * home above. `tilt`/`speed` name the sensor that would have to be in
     * use for the key to count as placed. */
    var PROCREATE_PLACED = {
        dynamicsJitterHue: ['hueJitter', 1, 'dab'],
        dynamicsJitterSaturation: ['satJitter', 1, 'dab'],
        dynamicsJitterLightness: ['valJitter', 1, 'dab'],
        dynamicsJitterDarkness: ['valJitter', 1, 'dab'],
        dynamicsJitterStrokeHue: ['hueJitter', 1, 'stroke'],
        dynamicsJitterStrokeSaturation: ['satJitter', 1, 'stroke'],
        dynamicsJitterStrokeLightness: ['valJitter', 1, 'stroke'],
        dynamicsJitterStrokeDarkness: ['valJitter', 1, 'stroke'],
        dynamicsTiltSize: ['sizeSrc', 'tilt'],
        dynamicsTiltOpacity: ['flowSrc', 'tilt'],
        dynamicsSpeedSize: ['sizeSrc', 'speed'],
        dynamicsSpeedOpacity: ['flowSrc', 'speed'],
        dynamicsRollSize: ['sizeSrc', 'twist'],
        dynamicsMix: ['colorRate', 2],
        dynamicsPressureMix: ['colorRateSrc', 'pressure'],
        shapeFlipXJitter: ['tipMirror', 2],
        shapeFlipYJitter: ['tipMirror', 2]
    };

    function _pcPlaced(out, pair) {
        if (pair[2] && (out.colorJitterPer || 'dab') !== pair[2]) return false;
        // 1: any amount at all landed. 2: the setting simply exists here.
        if (pair[1] === 1) return out[pair[0]] > 0;
        if (pair[1] === 2) return out[pair[0]] != null;
        return out[pair[0]] === pair[1];
    }

    function _pcJitter(out, hue, sat, light, dark) {
        var h = Math.min(1, hue || 0), sa = Math.min(1, sat || 0);
        var v = Math.min(1, Math.max(light || 0, dark || 0));
        if (h < 0.005 && sa < 0.005 && v < 0.005) return false;
        if (h >= 0.005) out.hueJitter = Math.round(h * 180);
        if (sa >= 0.005) out.satJitter = Math.round(sa * 100);
        if (v >= 0.005) out.valJitter = Math.round(v * 100);
        return true;
    }

    function _pcNum(v) {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') { var n = parseFloat(v); return isFinite(n) ? n : null; }
        if (v === true) return 1;
        if (v === false) return 0;
        return null;
    }

    /* A Procreate brush into our settings.
     *
     * `tipSize` is the Shape.png's own pixel size, the way a Krita stamp is
     * sized -- Procreate itself has no absolute diameter in the file, because
     * size there is a slider the artist moves per stroke. */
    BrushPack.procreateToPreset = function (arch, name, opts) {
        opts = opts || {};
        var out = {}, warn = [], got = {};

        for (var k in PROCREATE_KEYS) {
            if (!PROCREATE_KEYS.hasOwnProperty(k)) continue;
            var v = _pcNum(arch[k]);
            if (v !== null) got[PROCREATE_KEYS[k]] = v;
        }

        out.shape = opts.tipSize ? 'custom' : 'circle';
        out.size = Math.max(2, Math.min(1000, Math.round(opts.tipSize || 30)));
        out.hardness = 100;
        out.opacity = got.opacity != null
            ? Math.max(1, Math.round(Math.min(1, got.opacity) * 100)) : 100;
        out.flow = 100;

        // Procreate's spacing is a fraction of the brush, which is ours x100.
        out.spacing = got.spacing != null
            ? Math.max(1, Math.min(400, Math.round(got.spacing * 100))) : 10;

        /* Scatter is two dials there: shapeScatter throws the stamp off the
         * line, plotJitter wobbles the line itself. Ours is one, so take
         * whichever is doing more work. */
        var scat = Math.max(got.scatter || 0, got.jitter || 0);
        if (scat > 0.005) out.scatter = Math.max(1, Math.min(400, Math.round(scat * 100)));

        /* Angles are radians there, degrees here -- the same trap Krita's
         * brush_definition sets, and the same fix. */
        if (got.angle) out.angle = Math.round(got.angle * 180 / Math.PI) % 360;
        if (got.angleRandom) out.angleSrc = 'random';

        /* Roundness is how round the stamp stays: 1 is a circle, 0.2 is a
         * blade. Ours counts the other way up, as how many times longer than
         * it is wide. */
        if (got.roundness != null && got.roundness < 0.99) {
            out.aspectRatio = Math.min(10, Math.max(1,
                Math.round(1 / Math.max(0.1, got.roundness))));
        }

        if (got.texture > 0.01) {
            if (opts.hasGrain) {
                out.texture = Math.round(Math.min(1, got.texture) * 100);
                var zoom = got.textureZoom || got.textureScale || 0;
                if (zoom > 0) out.textureScale = Math.max(1, Math.min(16, Math.round(zoom * 8)));
            } else if (/\S/.test(String(arch.bundledGrainPath || '')) &&
                       !/blank/i.test(String(arch.bundledGrainPath))) {
                /* Procreate ships its own grain library and a brush may just
                 * name one instead of carrying it. The picture is not in the
                 * file, so neither is the texture. "Brush-Preset-Blank" is
                 * the name of no grain at all, not of a missing one. */
                warn.push('dropped: its grain, which comes from Procreate’s own library');
            }
        }

        /* Taper is a length down the stroke there and a percentage of it
         * here, and the two ends are set apart. */
        if (got.taperStart > 0.005) out.taperStart = Math.min(100, Math.round(got.taperStart * 100));
        if (got.taperEnd > 0.005) out.taperEnd = Math.min(100, Math.round(got.taperEnd * 100));

        if (got.shapeCount > 0.5) {
            warn.push('dropped: the ' + Math.round(got.shapeCount + 1) +
                      ' stamps it lays down per dab');
        }

        /* Procreate's pressure dials are how MUCH pressure does, which is
         * the depth of our response, not its shape: at 0 the brush ignores
         * the pen, at 1 it follows it all the way down to nothing. */
        /* One driver at a time here, so they are tried in the order a
         * painter would notice them: the pen first, then the way it is held,
         * then how fast it is moving. */
        _pcDrive(out, 'size', got.pressureSize, arch.dynamicsPressureSizeCurve,
                 got.tiltSize, got.speedSize, got.rollSize);
        _pcDrive(out, 'flow', got.pressureFlow, arch.dynamicsPressureOpacityCurve,
                 got.tiltFlow, got.speedFlow);

        /* Taper is set apart there -- a length at each end and separate
         * amounts for width and for opacity -- and ours is one target. */
        var tSize = got.taperSize > 0.01, tOp = got.taperOpacity > 0.01;
        if (tSize || tOp) out.taperTarget = (tSize && tOp) ? 'both' : (tSize ? 'size' : 'opacity');

        /* Colour that wanders. Procreate has two sets, one per dab and one
         * per stroke; ours is one set with a switch, so the per-dab set wins
         * when a brush asks for both -- and the loser stays in the warnings.
         * Lightness and darkness are the two halves of one dial here. */
        var perDab = _pcJitter(out, got.jitHue, got.jitSat, got.jitLight, got.jitDark);
        if (!perDab && _pcJitter(out, got.strokeHue, got.strokeSat,
                                 got.strokeLight, got.strokeDark)) {
            out.colorJitterPer = 'stroke';
        }

        /* Wet mix: how much of what is already on the canvas comes into the
         * dab. Ours says the same thing the other way up -- how much of the
         * brush's own colour survives -- so the two are one minus the other,
         * and the pen can drive it the same way it drives everything else. */
        if (got.mix > 0.005) {
            out.colorRate = Math.round((1 - Math.min(1, got.mix)) * 100);
            if (got.pressureMix > 0.01) {
                out.colorRateSrc = 'pressure';
                out.colorRateMin = 0;
            }
        }

        /* A dab flipped at random every time it lands, which is exactly what
         * Krita's mirror does and what our tipMirror is. */
        var fx = got.flipX > 0.005, fy = got.flipY > 0.005;
        if (fx || fy) out.tipMirror = (fx && fy) ? 'both' : (fx ? 'h' : 'v');

        /* StreamLine, which is what Procreate calls holding the line back
         * while you draw. Ours is the stabilizer. */
        if (got.smoothing > 0.01) {
            out.smoothingMode = 'stabilizer';
            out.smoothingStabilizer = Math.max(1, Math.min(100, Math.round(got.smoothing * 100)));
        }

        for (var j = 0; j < PROCREATE_NOTED.length; j++) {
            var keys = PROCREATE_NOTED[j][0];
            for (var i = 0; i < keys.length; i++) {
                if (PROCREATE_PLACED[keys[i]] && _pcPlaced(out, PROCREATE_PLACED[keys[i]])) continue;
                if (_pcNum(arch[keys[i]])) {
                    warn.push('dropped: ' + PROCREATE_NOTED[j][1]);
                    break;
                }
            }
        }

        return { name: name || 'Procreate brush', params: out,
                 tipFile: null, warnings: warn };
    };

    /* A .brush is one brush's folder; a .brushset is many of them in one
     * ZIP. Both are read the same way -- group the entries by the folder
     * they sit in, and a .brush is simply the case where that is the root. */
    BrushPack.readProcreate = function (bytes) {
        return BrushPack.readZip(bytes).then(function (files) {
            var folders = {};
            for (var n in files) {
                if (!files.hasOwnProperty(n)) continue;
                var parts = n.split('/');
                var leaf = parts.pop();
                var dir = parts.join('/');
                if (!/^(Brush\.archive|Shape\.png|Grain\.png)$/i.test(leaf)) continue;
                (folders[dir] = folders[dir] || {})[leaf.toLowerCase()] = files[n];
            }

            var presets = [], warnings = [];
            for (var d in folders) {
                if (!folders.hasOwnProperty(d)) continue;
                var f = folders[d];
                if (!f['brush.archive']) continue;
                var arch;
                try {
                    arch = _unarchive(_bplist(f['brush.archive']));
                } catch (e) { arch = null; }
                if (!arch || typeof arch !== 'object') {
                    warnings.push((d || 'the brush') + ' has settings we could not read');
                    continue;
                }
                presets.push({
                    name: String(arch.name || d.split('/').pop() || 'Procreate brush'),
                    arch: arch,
                    shape: f['shape.png'] || null,
                    grain: f['grain.png'] || null
                });
            }
            if (!presets.length) throw new Error('That file holds no Procreate brushes.');
            return { kind: 'procreate', presets: presets, tips: {}, warnings: warnings };
        });
    };

    /* ------------------------------------------------------------------
     * Clip Studio Paint .sut
     *
     * A .sut is not a container with a database inside it: the file IS a
     * SQLite database, and the brush is three of its tables. Node names it,
     * Variant holds one column per setting (187 of them in the file this was
     * written against), and MaterialFile holds the pictures.
     *
     * So the reader below is a small read-only SQLite: enough to walk a
     * table b-tree, reassemble a payload that spilled onto overflow pages --
     * which every material does, at a megabyte each -- and decode the record
     * format. No index reading, no writing, no SQL. The file format is
     * published and fixed, which is what makes 200 lines of it reasonable
     * where guessing at Celsys's own layout would not be.
     * ------------------------------------------------------------------ */

    function _sqliteVarint(u8, off) {
        var v = 0;
        for (var i = 0; i < 8; i++) {
            var b = u8[off + i];
            v = v * 128 + (b & 0x7f);
            if (!(b & 0x80)) return [v, i + 1];
        }
        return [v * 256 + u8[off + 8], 9];
    }

    /* One record: a header of serial types, then the values back to back.
     * `rowid` stands in for an INTEGER PRIMARY KEY column, which SQLite
     * stores as NULL because the row already has it. */
    function _sqliteRecord(rec, rowid, cols, pkIdx) {
        var h = _sqliteVarint(rec, 0);
        var hdrLen = h[0], p = h[1], types = [];
        while (p < hdrLen) {
            var t = _sqliteVarint(rec, p);
            types.push(t[0]);
            p += t[1];
        }
        var dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        var at = hdrLen, out = {};
        for (var i = 0; i < types.length; i++) {
            var st = types[i], v = null, n = 0;
            if (st === 0) { v = null; }
            else if (st >= 1 && st <= 6) {
                n = st <= 4 ? st : (st === 5 ? 6 : 8);
                v = 0;
                for (var k = 0; k < n; k++) v = v * 256 + rec[at + k];
                var top = 1;
                for (var z = 0; z < n; z++) top *= 256;
                if (v >= top / 2) v -= top;              // two's complement
            } else if (st === 7) { n = 8; v = dv.getFloat64(at); }
            else if (st === 8) { v = 0; }
            else if (st === 9) { v = 1; }
            else if (st >= 12 && st % 2 === 0) {
                n = (st - 12) / 2;
                v = rec.subarray(at, at + n);
            } else if (st >= 13) {
                n = (st - 13) / 2;
                v = new TextDecoder('utf-8', { fatal: false }).decode(rec.subarray(at, at + n));
            }
            at += n;
            if (cols[i]) out[cols[i]] = (i === pkIdx && v === null) ? rowid : v;
        }
        return out;
    }

    /* The column names, and which one is the rowid alias, straight out of
     * the CREATE TABLE text. These are machine-written statements with no
     * nested parentheses in practice, but depth is counted anyway because
     * a single DEFAULT (0) would otherwise split a column in half. */
    function _sqliteCols(sql) {
        var a = String(sql || '').indexOf('(');
        if (a < 0) return { cols: [], pk: -1 };
        var depth = 0, cur = '', parts = [];
        for (var i = a + 1; i < sql.length; i++) {
            var c = sql.charAt(i);
            if (c === '(') depth++;
            else if (c === ')') { if (!depth) break; depth--; }
            if (c === ',' && !depth) { parts.push(cur); cur = ''; continue; }
            cur += c;
        }
        parts.push(cur);
        var cols = [], pk = -1;
        for (var j = 0; j < parts.length; j++) {
            var def = parts[j].trim();
            var nm = (def.split(/\s+/)[0] || '').replace(/^["`\[]|["`\]]$/g, '');
            if (/INTEGER\s+PRIMARY\s+KEY/i.test(def)) pk = cols.length;
            cols.push(nm);
        }
        return { cols: cols, pk: pk };
    }

    function _sqliteRead(u8, wanted) {
        var sig = 'SQLite format 3';
        for (var i = 0; i < sig.length; i++) {
            if (u8[i] !== sig.charCodeAt(i)) throw new Error('That is not a Clip Studio brush.');
        }
        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        var psz = dv.getUint16(16);
        if (psz === 1) psz = 65536;
        var usable = psz - u8[20];
        var X = usable - 35;
        var M = Math.floor((usable - 12) * 32 / 255) - 23;

        function at(pageNo) { return (pageNo - 1) * psz; }

        /* A payload longer than the page keeps its first K bytes in the cell
         * and chains the rest through pages whose first four bytes point at
         * the next one. K is not "as much as fits": SQLite picks it so the
         * last overflow page is never left nearly empty. */
        function payload(off) {
            var a = _sqliteVarint(u8, off);
            var len = a[0]; off += a[1];
            var b = _sqliteVarint(u8, off);
            var rowid = b[0]; off += b[1];
            var local = len;
            if (len > X) {
                var K = M + ((len - M) % (usable - 4));
                local = K <= X ? K : M;
            }
            var buf = new Uint8Array(len);
            buf.set(u8.subarray(off, off + local), 0);
            var got = local;
            if (local < len) {
                var next = dv.getUint32(off + local);
                while (next && got < len) {
                    var po = at(next);
                    var take = Math.min(usable - 4, len - got);
                    buf.set(u8.subarray(po + 4, po + 4 + take), got);
                    got += take;
                    next = dv.getUint32(po);
                }
            }
            return { rowid: rowid, rec: buf };
        }

        function walk(pageNo, seen, hit) {
            if (!pageNo || seen[pageNo]) return;       // a cycle is corruption
            seen[pageNo] = 1;
            var base = at(pageNo);
            var hdr = pageNo === 1 ? 100 : 0;
            var type = u8[base + hdr];
            var n = dv.getUint16(base + hdr + 3);
            var cells = base + hdr + (type === 5 || type === 2 ? 12 : 8);
            for (var i = 0; i < n; i++) {
                var off = base + dv.getUint16(cells + i * 2);
                if (type === 13) hit(payload(off));
                else if (type === 5) walk(dv.getUint32(off), seen, hit);
            }
            if (type === 5) walk(dv.getUint32(base + hdr + 8), seen, hit);
        }

        var master = [];
        walk(1, {}, function (c) { master.push(c); });

        var mcols = ['type', 'name', 'tbl_name', 'rootpage', 'sql'];
        var out = {};
        for (var m = 0; m < master.length; m++) {
            var row = _sqliteRecord(master[m].rec, master[m].rowid, mcols, -1);
            if (row.type !== 'table' || wanted.indexOf(row.name) === -1) continue;
            var spec = _sqliteCols(row.sql);
            var rows = [];
            walk(row.rootpage, {}, function (c) {
                rows.push(_sqliteRecord(c.rec, c.rowid, spec.cols, spec.pk));
            });
            out[row.name] = rows;
        }
        return out;
    }

    /* The material images.
     *
     * A MaterialFile row's FileData is a tar, and the bitmap inside it is in
     * Celsys's own .layer format, which nothing outside Clip Studio reads.
     * Beside it, though, sits thumbnail/thumbnail.png -- a 1024px PNG of the
     * same material, with its alpha intact. That is a brush tip.
     *
     * Rather than walk the tar, scan for the last PNG in the blob: the
     * thumbnail is the last member, and a signature-to-IEND scan cannot be
     * thrown off by a tar layout that changes between versions.
     *
     * ponytail: takes the LAST png in the blob. If Celsys ever appends
     * something after the thumbnail, walk the tar headers instead. */
    var _PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    function _lastPng(blob) {
        if (!blob || !blob.length) return null;
        var start = -1;
        for (var i = blob.length - 8; i >= 0; i--) {
            var ok = true;
            for (var k = 0; k < 8; k++) { if (blob[i + k] !== _PNG_SIG[k]) { ok = false; break; } }
            if (ok) { start = i; break; }
        }
        if (start < 0) return null;
        for (var j = blob.length - 4; j > start; j--) {
            if (blob[j] === 0x49 && blob[j + 1] === 0x45 &&
                blob[j + 2] === 0x4E && blob[j + 3] === 0x44) {
                return blob.subarray(start, j + 8);   // IEND + its CRC
            }
        }
        return null;
    }

    function _sutNum(v, dflt) {
        return (typeof v === 'number' && isFinite(v)) ? v : dflt;
    }

    /* A curve, as Clip Studio stores one.
     *
     * The blob is a 44-byte header and then up to two records, whose byte
     * lengths the header carries -- and that is the check that it parsed at
     * all, since the header plus those two lengths has to come to the blob
     * exactly. A record is [12][which input][16] and then its points, as
     * pairs of big-endian doubles already between 0 and 1, which is the
     * shape our own curves are in.
     *
     * Which number means which input is only half settled. Id 2 carries the
     * straight 0,0 - 1,1 line on every dial Clip Studio drives from the pen
     * by default, so 2 is pen pressure. The rest are named in the warnings
     * rather than guessed at: a curve hung on the wrong sensor is a brush
     * that behaves oddly, which is worse than a brush that says what it is
     * missing. */
    var SUT_INPUT = { 2: 'pressure' };

    function _sutEffector(blob) {
        if (!blob || blob.length < 44) return null;
        var b = (blob instanceof Uint8Array) ? blob : new Uint8Array(blob);
        var r = _rd(b);
        if (r.u32() !== 44) return null;
        r.skip(8);                       // which family of dial, and its flags
        var floor = r.i32();             // how far down a curve may pull it
        r.skip(16);
        var lens = [r.i32(), r.i32()];
        if (lens[0] < 0 || lens[1] < 0) return null;
        if (44 + lens[0] + lens[1] !== b.length) return null;

        var out = { min: floor, curves: [] }, at = 44, i, j;
        for (i = 0; i < 2; i++) {
            if (lens[i] < 28) { at += lens[i]; continue; }
            var c = _rd(b);
            c.p = at;
            if (c.u32() !== 12) return null;
            var input = c.u32();
            if (c.u32() !== 16) return null;
            var pts = [];
            for (j = 12; j + 16 <= lens[i]; j += 16) {
                pts.push([Math.max(0, Math.min(1, c.f64())),
                          Math.max(0, Math.min(1, c.f64()))]);
            }
            if (pts.length > 1) out.curves.push({ input: input, points: pts });
            at += lens[i];
        }
        return out;
    }

    /* One dial and the curves hung off it. Our engine drives a setting from
     * one thing at a time, so the one we understand wins and the rest are
     * counted into a warning. */
    function _sutDrive(out, key, blob, warn, what) {
        var e = _sutEffector(blob);
        if (!e || !e.curves.length) return false;
        var known = null, rest = 0, i;
        for (i = 0; i < e.curves.length; i++) {
            if (!known && SUT_INPUT[e.curves[i].input]) known = e.curves[i];
            else rest++;
        }
        if (known) {
            out[key + 'Src'] = SUT_INPUT[known.input];
            out[key + 'Curve'] = known.points;
            out[key + 'Min'] = Math.max(0, Math.min(100, Math.round(e.min)));
        }
        if (rest) {
            warn.push('dropped: ' + (rest === 1 ? 'a rule that changes ' :
                                     rest + ' rules that change ') + what + ' as you draw');
        }
        return !!known;
    }

    function _sutJitter(out, hue, sat, val) {
        var h = Math.min(180, Math.abs(_sutNum(hue, 0)));
        var sa = Math.min(100, Math.abs(_sutNum(sat, 0)));
        var vv = Math.min(100, Math.abs(_sutNum(val, 0)));
        if (!h && !sa && !vv) return false;
        if (h) out.hueJitter = Math.round(h);
        if (sa) out.satJitter = Math.round(sa);
        if (vv) out.valJitter = Math.round(vv);
        return true;
    }

    /* Clip Studio's settings into ours.
     *
     * Most of the geometry lines up one to one because both engines stamp a
     * tip along a path. What does not line up is everything Clip Studio
     * stores as an "effector" -- a binary blob per setting holding the curve
     * that drives it from pressure, speed or tilt. Only some of those have a
     * home here, so a brush arrives with its shape, its numbers and the
     * curves we can place, and names the rest.
     */
    BrushPack.sutToPreset = function (v, name, opts) {
        opts = opts || {};
        var out = {}, warn = [];

        var size = _sutNum(v.BrushSize, 20);
        out.size = Math.max(1, Math.min(1000, Math.round(size)));
        out.shape = opts.hasTip ? 'custom' : 'circle';
        out.opacity = Math.max(1, Math.min(100, Math.round(_sutNum(v.Opacity, 100))));
        out.flow = Math.max(1, Math.min(100, Math.round(_sutNum(v.BrushFlow, 100))));
        out.hardness = Math.max(0, Math.min(100, Math.round(_sutNum(v.BrushHardness, 80))));
        out.spacing = Math.max(1, Math.min(400, Math.round(_sutNum(v.BrushInterval, 10))));

        /* Thickness is how wide the tip stays, as a percentage; ours is how
         * many times longer than wide it is. 16% thick is a blade six times
         * longer than it is across. */
        var thick = _sutNum(v.BrushThickness, 100);
        if (thick > 0 && thick < 99) {
            if (opts.hasTip) {
                /* An image tip already IS its shape -- squeezing it by the
                 * thickness ratio crushes the tower flat (a 90x202 watercolor
                 * tip at thickness 45 painted 67x76 instead of 67x150).
                 * Thickness stays a generated-tip setting only. */
                warn.push('changed: kept the tip\u2019s own shape; thickness not applied');
            } else {
                out.aspectRatio = Math.min(10, Math.max(1, Math.round(100 / thick)));
            }
        }

        var rot = _sutNum(v.BrushRotation, 0);
        if (rot) out.angle = Math.round(rot) % 360;
        /* The rotation dropdown is a mask of what is allowed to turn the
         * tip. Bits 1 and 2 are on in every brush in every file we have, so
         * they are structure rather than a setting. Bit 128 is random: the
         * only brushes that move BrushRotationRandomScale off 100 are the
         * ones that set it. Bit 32 is "rotate to follow the stroke" -- an
         * elongated custom tip (like Flat watercolor brush's 44x99 blade)
         * left at a fixed angle instead paints a different apparent width
         * depending on drag direction, which reads as a wrong aspect ratio,
         * a blotchy/uneven edge, and inconsistent dab overlap. Bit 16 is
         * still unnamed and stays a warning. */
        var reff = _sutNum(v.BrushRotationEffector, 0);
        if (reff & 128) {
            out.angleSrc = 'random';
            out.angleRange = Math.max(1, Math.min(180, Math.round(
                _sutNum(v.BrushRotationRandomScale, 100) * 1.8)));
        } else if (reff & 32) {
            out.angleSrc = 'direction';
        }
        if (reff & ~163) {
            warn.push('dropped: the rule that turns its tip as you draw');
        }

        /* Spray is a radius in pixels; scatter here is a percentage of the
         * brush, so it only means anything next to the size. */
        if (_sutNum(v.BrushUseSpray, 0) && size > 0) {
            var spray = _sutNum(v.BrushSpraySize, 0);
            if (spray > 0) {
                out.scatter = Math.max(1, Math.min(400, Math.round(spray / size * 100)));
            }
        }

        // In and out are a length and a percentage; the percentage is ours.
        if (_sutNum(v.BrushUseIn, 0)) {
            out.taperStart = Math.max(1, Math.min(100, Math.round(_sutNum(v.BrushInRatio, 30))));
        }
        if (_sutNum(v.BrushUseOut, 0)) {
            out.taperEnd = Math.max(1, Math.min(100, Math.round(_sutNum(v.BrushOutRatio, 30))));
        }

        if (opts.hasTexture) {
            var dens = _sutNum(v.TextureDensity, 0);
            if (dens > 0) {
                out.texture = Math.max(1, Math.min(100, Math.round(dens)));
                var ts = _sutNum(v.TextureScale2, 0);
                if (ts > 0) out.textureScale = Math.max(1, Math.min(16, Math.round(ts / 12.5)));
                /* The density, scale and paper picture come over; how Clip
                 * Studio blends and distorts that paper has no equivalent
                 * here, so each active modifier is named. */
                if (_sutNum(v.TextureCompositeMode, 1) !== 1)
                    warn.push('changed: how its paper texture blends');
                if (_sutNum(v.TextureReverseDensity, 0))
                    warn.push('changed: paper texture reverse density');
                if (_sutNum(v.TextureStressDensity, 0))
                    warn.push('changed: paper texture stress density');
                if (_sutNum(v.TextureRotate, 0))
                    warn.push('changed: paper texture rotation');
                if (_sutNum(v.TextureBrightness, 0))
                    warn.push('changed: paper texture brightness');
                if (_sutNum(v.TextureContrast, 0))
                    warn.push('changed: paper texture contrast');
            }
        }

        /* Watercolour and oil there are our smudge: how much of what is
         * already on the paper gets dragged along against how much fresh
         * colour lands.
         *
         * Three columns switch it on. BrushUseWaterColor and its 2 twin
         * always agree, but the markers and the flat watercolour brushes
         * leave both at zero and set BrushWaterColor instead -- those
         * imported bone dry until we read it too. */
        if (_sutNum(v.BrushUseWaterColor, 0) || _sutNum(v.BrushUseWaterColor2, 0) ||
            _sutNum(v.BrushWaterColor, 0)) {
            var mix = Math.max(0, Math.min(100, _sutNum(v.BrushMixColor, 0)));
            if (mix > 0) {
                /* The mixing itself is NOT mapped onto our smudge, which is
                 * what it looks like it should be. Measured against real Clip
                 * Studio, not assumed: painting white over an existing stroke
                 * there leaves that stroke untouched, so whatever mixing does
                 * in Clip Studio it does not contaminate the colour a dab puts
                 * down. Our smudge does exactly that -- it deposits
                 * colorRate% brush plus the rest canvas -- so this brush's
                 * mixing of 25 was darkening everything a white stroke crossed
                 * and, on a fresh document, drinking the white background into
                 * every dab (a fresh CDPaint document is opaque white PIXELS,
                 * while in Clip Studio the white is a separate Paper layer the
                 * mixing cannot read). Stacked strokes of #87CEEB lost about
                 * a fifth of their coverage to it, and a white stroke over
                 * them measurably darkened them.
                 *
                 * So the mixing is named as dropped rather than mapped to
                 * something that demonstrably is not it. If it should come
                 * back it needs its own measurement of what Clip Studio's
                 * mixing actually does to a deposited colour, not this
                 * substitution. */
                warn.push('dropped: the way it mixes with colour already on the canvas');
                /* Marked so the engine lays a wash instead of ink: Clip
                 * Studio watercolour deposits translucent pigment even at
                 * high flow, and our full-strength dabs come out as marker.
                 * Silent -- it is a faithful part of the mapping, not a drop.
                 * Wet blend rides along: one stroke of watercolour must not
                 * darken itself where it overlaps, so only new coverage lands
                 * (W1). Silent for the same reason. */
                out.watercolor = 1;
                out.wetBlend = 1;
            }
        }

        /* Watercolour edge: Clip Studio darkens a band at the ink boundary.
         * Gated on the flag, not on the dials -- files carry leftover
         * radius/power values with the edge switched off, and mapping those
         * would paint an edge Clip Studio never shows. Radius arrives in px
         * (unit 0); any other unit is named rather than converted blind.
         * The remaining sub-dials have no equivalent here and are named. */
        if (_sutNum(v.BrushUseWaterEdge, 0)) {
            var er = _sutNum(v.BrushWaterEdgeRadius, 0);
            var ea = _sutNum(v.BrushWaterEdgeAlphaPower, 0);
            if (er > 0 && ea > 0) {
                out.edgeWidth = Math.max(1, Math.min(10, Math.round(er)));
                out.edgeDensity = Math.max(1, Math.min(100, Math.round(ea)));
            }
            if (_sutNum(v.BrushWaterEdgeRadiusUnit, 0))
                warn.push('changed: watercolour edge width unit');
            if (_sutNum(v.BrushWaterEdgeValuePower, 0))
                warn.push('changed: watercolour edge tone');
            if (_sutNum(v.BrushWaterEdgeAfterDrag, 0))
                warn.push('changed: watercolour edge timing');
            if (_sutNum(v.BrushWaterEdgeBlur, 0) || _sutNum(v.BrushWaterEdgeBlurUnit, 0))
                warn.push('changed: watercolour edge softness');
        }

        _sutDrive(out, 'size', v.BrushSizeEffector, warn, 'its size');
        if (!_sutDrive(out, 'flow', v.BrushFlowEffector, warn, 'its flow')) {
            _sutDrive(out, 'flow', v.BrushOpacityEffector, warn, 'its opacity');
        }
        if (out.scatter) {
            _sutDrive(out, 'scatter', v.BrushSpraySizeEffector, warn, 'its spray');
        }

        /* Colour that wanders. Clip Studio sets a range either side of the
         * colour -- hue in degrees, the other two as percentages -- and
         * offers the same three again for a whole stroke at a time. Ours is
         * one set with a switch, so per dab wins and the other is named. */
        var dabJit = _sutJitter(out, v.BrushHueChange, v.BrushSaturationChange,
                                v.BrushValueChange);
        if (!dabJit && _sutNum(v.BrushChangeStrokeColor, 0) &&
            _sutJitter(out, v.BrushStrokeHueChange, v.BrushStrokeSaturationChange,
                       v.BrushStrokeValueChange)) {
            out.colorJitterPer = 'stroke';
        }

        /* The second tip. Clip Studio's is a whole brush of its own -- its
         * own size, spacing, rotation and flow -- stamped into the first
         * one. Ours carves with it, which is what its two darkening blend
         * modes do; any other mode is named rather than faked.
         *
         * DualSize is in the same unit as BrushSize, so against the brush
         * it becomes the percentage our second tip is sized by. */
        if (opts.hasTip2) {
            var dsz = _sutNum(v.DualSize, 0);
            out.tip2Depth = Math.max(1, Math.min(100, Math.round(_sutNum(v.DualFlow, 100))));
            out.tip2Size = (dsz > 0 && size > 0)
                ? Math.max(1, Math.min(2000, Math.round(dsz / size * 100))) : 100;
            out.tip2Spacing = Math.max(10, Math.min(400, Math.round(_sutNum(v.DualInterval, 100))));
            out.tip2Angle = ((Math.round(_sutNum(v.DualRotation, 0)) % 360) + 360) % 360;
            if (_sutNum(v.DualBrushCompositeMode, 0) > 1) {
                warn.push('dropped: the way its second tip blends into the first');
            }
            if (_sutNum(v.DualUseSpray, 0)) {
                warn.push('dropped: scattering on the second tip');
            }
        }

        var noted = [
            ['UseDualBrush', 'its second brush tip'],
            ['BrushBlur', 'blur'],
            ['BrushChangeStrokeColor', 'per-stroke colour shifting'],
            ['BrushUseRevision', 'its stroke correction'],
            ['BrushRibbon', 'ribbon rendering']
        ];
        for (var i = 0; i < noted.length; i++) {
            if (noted[i][0] === 'BrushChangeStrokeColor' && out.colorJitterPer === 'stroke') continue;
            if (noted[i][0] === 'UseDualBrush' && opts.hasTip2) continue;
            if (_sutNum(v[noted[i][0]], 0)) {
                var msg = 'dropped: ' + noted[i][1];
                if (warn.indexOf(msg) === -1) warn.push(msg);
            }
        }

        return { name: name || 'Clip Studio brush', params: out, warnings: warn };
    };

    /* Which picture in a .sut is which.
     *
     * A Variant names its pictures in blobs: sixteen bytes of header whose
     * second word is a count, then one record per picture carrying that
     * material's catalogue path in UTF-16. The MaterialFile rows carry the
     * same path, so the two line up exactly -- and they have to, because
     * the pictures are not stored in the order you would guess. Read by
     * position, a marker whose paper texture is material 1 and whose four
     * tips are materials 2 to 5 arrives painting with the paper.
     *
     * A brush built on Clip Studio's own library stores no path (the
     * material lives in the program, not the file). Those fall back to the
     * order the four picture keys are written in, which is the order the
     * materials follow, and the brush says so.
     *
     * ponytail: the fallback is order, not identity. If a file ever names
     * its pictures some third way, the tip and the paper swap. */
    var SUT_IMAGE_KEYS = ['TextureImage', 'BrushPatternImageArray',
                          'DualPatternImageArray', 'DualTextureImage'];

    function _sutRefs(blob) {
        if (!blob || blob.length < 16) return { count: 0, paths: [] };
        /* Every one of these starts with a word of 8. Some other blob that
         * happens to sit in one of these columns is not a picture list, and
         * reading a count out of it would hand the tip the wrong material. */
        if (blob[0] || blob[1] || blob[2] || blob[3] !== 8) return { count: 0, paths: [] };
        var count = (blob[4] << 24 | blob[5] << 16 | blob[6] << 8 | blob[7]) >>> 0;
        if (count > 64) return { count: 0, paths: [] };
        var s = '', i;
        for (i = 16; i + 1 < blob.length; i += 2) {
            s += String.fromCharCode(blob[i] | (blob[i + 1] << 8));
        }
        var paths = [], m, re = /\.:[0-9A-Za-z:\-]{10,}/g;
        while ((m = re.exec(s))) {
            if (m[0].indexOf(':data:') === -1) paths.push(m[0]);
        }
        return { count: count, paths: paths };
    }

    /* A .sut holds one sub tool. Node says which Variant row is the live one
     * (the other is the defaults it resets to). */
    BrushPack.readSut = function (bytes) {
        var u8 = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
        var db = _sqliteRead(u8, ['Node', 'Variant', 'MaterialFile']);
        var nodes = db.Node || [], variants = db.Variant || [];
        if (!nodes.length || !variants.length) {
            throw new Error('That Clip Studio file holds no brush.');
        }
        var node = nodes[0];
        var want = node.NodeVariantID;
        var v = null;
        for (var i = 0; i < variants.length; i++) {
            if (variants[i].VariantID === want) { v = variants[i]; break; }
        }
        if (!v) v = variants[0];

        /* Not every .sut is a brush. A fill or a selection tool is stored
         * the same way and has no brush settings at all -- no BrushSize,
         * none of the 150-odd dials around it -- so importing one would
         * make a plain round brush out of a tool that never painted. */
        if (!('BrushSize' in v)) {
            throw new Error('"' + String(node.NodeName || 'That sub tool') +
                '" is a Clip Studio tool rather than a brush, so there is ' +
                'no brush in it to import.');
        }

        var rows = db.MaterialFile || [];
        var pngs = rows.map(function (m) { return _lastPng(m.FileData); });
        var byPath = {}, named = 0, k;
        for (i = 0; i < rows.length; i++) {
            var cat = rows[i].CatalogPath;
            if (cat && pngs[i]) { byPath[cat] = pngs[i]; named++; }
        }

        var got = {}, warnings = [], at = 0;
        for (k = 0; k < SUT_IMAGE_KEYS.length; k++) {
            var key = SUT_IMAGE_KEYS[k];
            var ref = _sutRefs(v[key]);
            var list = [];
            if (named) {
                for (i = 0; i < ref.paths.length; i++) {
                    if (byPath[ref.paths[i]]) list.push(byPath[ref.paths[i]]);
                }
            } else {
                for (i = 0; i < ref.count && at < pngs.length; i++, at++) {
                    if (pngs[at]) list.push(pngs[at]);
                }
            }
            got[key] = list;
        }
        if (!named && pngs.length) {
            warnings.push('Its pictures come from the Clip Studio library, so ' +
                'which is the tip and which is the paper is taken from their order.');
        }

        var tips = _sutNum(v.BrushUsePatternImage, 0) ? got.BrushPatternImageArray : [];
        var tip2 = (_sutNum(v.UseDualBrush, 0) && _sutNum(v.DualUsePatternImage, 0))
            ? got.DualPatternImageArray[0] : null;

        return {
            kind: 'sut',
            presets: [{
                name: String(node.NodeName || 'Clip Studio brush'),
                variant: v,
                tip: tips[0] || null,
                tips: tips,
                tip2: tip2 || null,
                texture: got.TextureImage[0] || null
            }],
            warnings: warnings
        };
    };

    window.BrushPack = BrushPack;
})();
