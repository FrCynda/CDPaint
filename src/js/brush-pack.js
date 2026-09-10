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
    BrushPack.parsePresetXml = function (xml) {
        var doc = new DOMParser().parseFromString(xml, 'text/xml');
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
    BrushPack.brushDefinition = function (preset) {
        var raw = preset && preset.params && preset.params.brush_definition;
        if (!raw || !String(raw).trim()) return null;
        var doc = new DOMParser().parseFromString(String(raw).trim(), 'text/xml');
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
        speed: 'speed',
        xtilt: 'tilt',
        ytilt: 'tilt'
    };

    /* Features Krita has and we do not. Reported by name when a preset
     * actually switches one on, so an import says what it dropped instead of
     * quietly painting something else. */
    var DROPPED = [
        ['MaskingBrush/Enabled', 'a second brush used as a mask'],
        ['Texture/Pattern/Enabled', 'a canvas texture pattern'],
        ['Sharpness/softness', 'edge sharpening'],
        ['PaintThicknessEnabled', 'paint thickness (impasto)'],
        ['PressureLightnessStrength', 'lightness-mapped tips'],
        ['PressureMix', 'colour mixing driven by pressure'],
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
        return { id: id, src: SENSORS[id] || null,
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
        } else {
            warn.push('no tip definition; falling back to a round brush');
            out.shape = 'circle';
            out.size = 20;
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
        if (scat > 0 && (_bool(P['Scattering/AxisX']) !== _bool(P['Scattering/AxisY']))) {
            warn.push('scatter was along one axis only; ours goes both ways');
        }

        var op = String(P.CompositeOp || 'normal');
        if (_bool(P.EraserMode) || op === 'erase') out.blendMode = 'erase';
        else if (op !== 'normal') {
            if (BLENDS[op]) out.blendMode = BLENDS[op];
            else warn.push('blend mode "' + op + '" has no equivalent; painting normally');
        }

        // Size and flow ride their sensors the same way ours do.
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
                } else {
                    warn.push('opacity also responded to ' + s.id +
                        '; only the flow response was kept');
                }
                return;
            }
            if (!s.src) { warn.push(pair[0] + ' followed ' + s.id + ', which we have no input for'); return; }
            out[key + 'Src'] = s.src;
            out[key + 'Min'] = 0;
            if (s.curve) out[key + 'Curve'] = s.curve;
        });

        /* Rotation is an angle, not a factor, so it takes the source only --
         * its curve would reshape a full turn and we do not offer that. */
        var rot = _sensorFor(P, 'Rotation');
        if (rot) {
            /* Only some inputs mean anything as an angle. Pressure driving a
             * rotation is a spin we do not have, and letting it through would
             * set an angle source the engine quietly ignores. */
            if (rot.src === 'direction' || rot.src === 'twist' ||
                rot.src === 'tilt' || rot.src === 'random') out.angleSrc = rot.src;
            else warn.push('the tip turned with ' + rot.id + ', which we cannot turn it with');
        }

        var sc = _sensorFor(P, 'Scatter');
        if (sc && sc.src) { out.scatterSrc = sc.src; out.scatterMin = 0; }

        // A per-dab flip is exactly what our strip tips already do.
        if (_bool(P.HorizontalMirrorEnabled) || _bool(P.VerticalMirrorEnabled)) out.tipMirror = true;

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
        } else if (preset.paintop && preset.paintop !== 'paintbrush') {
            warn.push('this is a ' + preset.paintop + ', which we paint as an ordinary brush');
        }

        return { name: preset.name || 'Imported', params: out,
                 tipFile: bd.filename || null, warnings: warn };
    };

    /* ── tip images ───────────────────────────────────────────────────── */

    /* No tip is stored larger than the largest dab anyone paints with it;
     * above that the extra pixels are resampled away on first use and only
     * cost storage, which for an imported brush is the browser's 5MB. */
    var TIP_CAP_PX = 200;

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
        for (var i = 0, n = cell.w * cell.h; i < n; i++) id.data[i * 4 + 3] = cell.alpha[i];
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
    BrushPack.tipStrip = function (bytes, filename) {
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

        // Anything else is an ordinary image, which the browser decodes.
        var blob = new Blob([bytes]);
        return createImageBitmap(blob).then(function (bmp) {
            var c = document.createElement('canvas');
            c.width = bmp.width; c.height = bmp.height;
            var g = c.getContext('2d');
            g.drawImage(bmp, 0, 0);
            var id = g.getImageData(0, 0, c.width, c.height), d = id.data;
            var a = new Uint8ClampedArray(c.width * c.height);
            for (var i = 0; i < a.length; i++) {
                var p = i * 4;
                var lum = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255;
                a[i] = Math.round((1 - lum) * d[p + 3]);
            }
            bmp.close && bmp.close();
            var st2 = _strip([{ w: c.width, h: c.height, alpha: a }]);
            return { url: st2.url, size: st2.size, cells: 1, pick: 'random' };
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

    function _abrImage(b, r, depth, compress, w, h) {
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
        return { w: w, h: h, alpha: _abrMask(px, w, h) };
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

    function _abrV6(b, sub) {
        var r = _rd(b);
        r.skip(4);                       // version, subversion
        var out = [];
        while (r.p + 12 <= r.len) {
            var tag = String.fromCharCode(b[r.p], b[r.p + 1], b[r.p + 2], b[r.p + 3]);
            var key = String.fromCharCode(b[r.p + 4], b[r.p + 5], b[r.p + 6], b[r.p + 7]);
            r.skip(8);
            var size = r.i32();
            if (tag !== '8BIM' || size < 0) break;
            var end = Math.min(r.len, r.p + size);
            if (key === 'samp') {
                while (r.p + 4 <= end) {
                    var blen = r.i32();
                    if (blen <= 0) break;
                    var bend = r.p + blen + ((4 - blen % 4) % 4);
                    /* A block of brush settings we cannot use sits in front
                     * of the image, and it is a different length in the two
                     * subversions. */
                    r.skip(sub === 1 ? 47 : 301);
                    if (r.p + 18 > end) break;
                    var top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
                    var depth = r.u16(), compress = r.u8();
                    var im = _abrImage(b, r, depth, compress, right - left, bottom - top);
                    if (im) out.push(im);
                    r.p = bend;
                }
            }
            r.p = end;
        }
        return out;
    }

    /* Every tip in a Photoshop brush file, as separate images. Each becomes
     * a brush of its own -- unlike a .gih strip, these are unrelated shapes
     * that happen to share a file, not variants of one brush. */
    BrushPack.readAbr = function (bytes) {
        if (bytes.length < 4) throw new Error('That file is too short to be a brush set.');
        var version = (bytes[0] << 8) | bytes[1];
        var sub = (bytes[2] << 8) | bytes[3];
        var tips;
        if (version === 1 || version === 2) tips = _abrV12(bytes, version);
        else if (version >= 6 && version <= 10) tips = _abrV6(bytes, sub);
        else throw new Error('Photoshop brush version ' + version + ' is one we cannot read.');
        if (!tips.length) throw new Error('No brush tips could be read out of that file.');
        return tips.map(function (t) {
            var st = _strip([t]);
            return { url: st.url, size: st.size, cells: 1, pick: 'random' };
        });
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
        offset_by_speed: 'offset that follows speed',
        offset_multiplier: 'a scattered offset multiplier',
        dabs_per_second: 'dabs laid down by time rather than distance',
        radius_by_random: 'a randomly varying dab size',
        stroke_holdtime: '',
        gridmap_scale: 'a texture grid',
        posterize: 'posterising'
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
         * is a separate idea there and always full. */
        out.flow = Math.round(Math.max(0, Math.min(1, base('opaque', 1) * base('opaque_multiply', 1))) * 100) || 100;

        /* Dabs per radius, not spacing: MyPaint counts how many land within
         * one radius, so the gap between them is the other way up. */
        var per = base('dabs_per_actual_radius', 0) || base('dabs_per_basic_radius', 0);
        out.spacing = per > 0 ? Math.max(1, Math.min(400, Math.round(50 / per))) : 10;

        var off = base('offset_by_random', 0);
        if (off > 0) out.scatter = Math.max(1, Math.min(400, Math.round(off * 100)));

        var ratio = base('elliptical_dab_ratio', 1);
        if (ratio > 1) out.aspectRatio = Math.round(Math.min(20, ratio) * 100) / 100;
        var ang = base('elliptical_dab_angle', 0);
        if (ang) out.angle = Math.round(ang) % 360;

        if (base('eraser', 0) > 0.5) out.blendMode = 'erase';

        var smudge = base('smudge', 0);
        if (smudge > 0.02) {
            out.colorRate = Math.round((1 - Math.min(1, smudge)) * 100);
            out.smudgeLength = Math.round(Math.max(0, Math.min(1, base('smudge_length', 0.5))) * 100);
        }

        _mybDrive(out, 'size', set, 'radius_logarithmic');
        _mybDrive(out, 'flow', set, 'opaque');

        for (var k in set) {
            if (!set.hasOwnProperty(k)) continue;
            if (MYB_KNOWN[k]) continue;
            var rec = set[k];
            var live = _num(rec.base, 0) !== 0 ||
                       (rec.inputs && Object.keys(rec.inputs).length > 0);
            if (!live) continue;
            var label = MYB_NOTED[k];
            if (label === '') continue;
            warn.push('dropped: ' + (label || k.replace(/_/g, ' ')));
        }
        if (out.aspectRatio && !out.angle) {
            warn.push('the flattened dab does not turn with the stroke here');
        }

        return { name: (obj && obj.comment) ? String(obj.comment).slice(0, 40) : (name || 'MyPaint brush'),
                 params: out, tipFile: null, warnings: warn };
    };

    window.BrushPack = BrushPack;
})();
