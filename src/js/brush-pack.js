/* Reading brush packs made for other programs.
 *
 * A Krita pack (.bundle) is an ordinary ZIP holding paintoppresets/*.kpp,
 * brushes/* and a manifest. A .kpp is not a settings file at all: it is a
 * PNG thumbnail -- rendered by Krita itself, which makes it a free reference
 * image to check our own rendering against -- carrying the whole brush
 * definition in a compressed text chunk as XML. Newer presets embed their tip
 * image in that XML as base64, so a single .kpp is often self-contained.
 *
 * This file only READS. It hands back plain data: names, parameters, and tip
 * bytes. Deciding what any of it means to our engine is somebody else's job,
 * so that the decoding can be tested against real packs without dragging the
 * brush engine into it.
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

    window.BrushPack = BrushPack;
})();
