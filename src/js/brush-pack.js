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
        if (String(mask.type || 'circle') !== 'circle') {
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
            // "x,y,is_corner" (KisCubicCurve::fromString): the curve bends sharply there.
            if (xy.length !== 2 && !(xy.length === 3 && xy[2].trim() === 'is_corner')) continue;
            var x = parseFloat(xy[0]), y = parseFloat(xy[1]);
            if (isNaN(x) || isNaN(y)) continue;
            pts.push(xy.length === 3 ? [x, y, 1] : [x, y]);
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
        /* Krita reads these as 1 with the pen upright, 0 at 60 degrees --
         * the reverse of our `tilt` -- so they get Krita's own sensor.
         * ponytail: x/y tilt are one axis each in Krita; both read the
         * whole lean here. Split them if a brush ever depends on one. */
        declination: 'elevation',
        tilt: 'tilt',
        tiltdirection: 'tilt',
        rotation: 'twist',
        tangentialpressure: 'wheel',
        speed: 'speed',
        xtilt: 'elevation',
        ytilt: 'elevation',
        /* Neither of these comes off the pen: they come off how far into the
         * stroke the dab is. Krita gives each a `length` attribute on the
         * sensor tag -- pixels for distance, dabs for fade -- so the reach
         * travels with the source instead of being guessed. */
        distance: 'distance',
        fade: 'fadein'
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
        color: 'color', luminize: 'luminosity',
        // Add and linear dodge are one sum; the SVG soft light is the W3C one.
        add: 'add', linear_dodge: 'add', soft_light_svg: 'soft-light'
    };

    function _num(v, dflt) {
        var n = parseFloat(v);
        return isFinite(n) ? n : dflt;
    }
    function _bool(v) { return String(v) === 'true' || String(v) === '1'; }

    /* An option's sensor as written, except that a lone input stored with no
     * curve (<params id="ascension"/>) is Krita's input AND pressure:
     * measured (test/krita/probes/frottis), Bristle_frottis0011's tip turns
     * with pressure, a quarter turn at 0.5 and 1 and upright near 0.75, and
     * stops turning once the same sensor carries a curve; size on such a
     * sensor grows with pressure the same way. Only with the older
     * Custom<Option> flag on: RGBA_06_Rock and Gouache Tilt #1 store the
     * same bare sensor without it and do not turn, and Rock turns once
     * CustomRotation is added. */
    function _sensorRaw(params, opt) {
        var raw = String(params[opt + 'Sensor'] || '');
        if (!_bool(params['Custom' + opt])) return raw;
        var m = /^\s*(?:<!DOCTYPE params>)?\s*<params\s+id="(\w+)"\s*\/>\s*$/.exec(raw);
        if (!m || m[1].toLowerCase() === 'pressure' || m[1].toLowerCase() === 'sensorslist') return raw;
        return '<!DOCTYPE params> <params id="sensorslist"> <ChildSensor id="' + m[1] +
            '"></ChildSensor> <ChildSensor id="pressure"></ChildSensor> </params>';
    }

    /* Which input drives one option, and how it responds. Krita spells the
     * on/off switch "Pressure<Option>" for most options but leaves it out for
     * the ones that are always live, where <Option>UseCurve is the switch. */
    function _sensorFor(params, opt, curveOn) {
        /* Krita reads a sensor only when the option is switched on AND its
         * "use curve" box is ticked (KisCurveOption::computeValueComponents
         * tests m_useCurve); with the box clear the option is a constant.
         * Dozens of Krita's own presets are on-but-no-curve. */
        var flag = params['Pressure' + opt], useCurve = params[opt + 'UseCurve'];
        /* Opacity has no off switch: measured on Krita's renders
         * (test/krita/probes/optswitch), its curve box alone decides -- flag off
         * with the box ticked still faded p0.25 to 137 -- and X1BB Addition
         * Soft's flag-off pressure curve paints in Krita. Flow is the same,
         * and a preset that stores no curve box at all gets it ticked: X1CG
         * Fineliner, written before Krita had a flow option, fades with
         * pressure there (test/krita/probes/softness: only FlowUseCurve false
         * stops it; PressureFlow false does not). Only the pixel engine has
         * that flow option: round marker, colour smudge, grid and curve presets
         * store no flow keys either and paint flat (bank run 19). */
        if (useCurve === undefined && curveOn) useCurve = 'true';
        if ((opt === 'Opacity' || opt === 'Flow') && useCurve !== undefined) flag = undefined;
        var on = (flag === undefined) ? _bool(useCurve)
            : _bool(flag) && (useCurve === undefined || _bool(useCurve));
        if (!on) return null;
        var raw = _sensorRaw(params, opt);
        /* id need not come first: drawing angle writes its fan settings
         * before it, and missing it here read the tip's turn as pressure. */
        var m = /<params\b[^>]*?\bid="([^"]+)"/.exec(raw);
        var id = m ? m[1].toLowerCase() : 'pressure';
        /* "sensorslist" is several inputs multiplied together. We drive one
         * parameter from one input, so take the first we understand rather
         * than reporting a brush we can very nearly reproduce as unreadable. */
        var shared = params[opt + 'UseSameCurve'] === undefined || _bool(params[opt + 'UseSameCurve']);
        var common = BrushPack.parseCurve('<curve>' + (params[opt + 'commonCurve'] || '') + '</curve>');
        /* A sensor stored with no curve takes the older Curve<Option> when
         * Custom<Option> is on, every input alike (KisKritaSensorPack::read):
         * speedpencil600's "0,0;0.5,1" is full ink from half pressure, and
         * read as a straight line its half-pressure strokes came out half. */
        if (!common && raw.indexOf('curve') < 0 && _bool(params['Custom' + opt])) {
            common = BrushPack.parseCurve('<curve>' + (params['Curve' + opt] || '') + '</curve>');
            if (common) shared = true;
        }
        var kids = [];
        if (id === 'sensorslist') {
            /* A child may close itself (<ChildSensor id="pressure"/>) and may
             * carry settings before its id (drawing angle's fan); matching
             * only the long form lost both Bristle_frottis lists whole. */
            var ch = /<ChildSensor\b[^>]*?\bid="([^"]+)"[^>]*?(?:\/>|>[\s\S]*?<\/ChildSensor>)/g, c;
            while ((c = ch.exec(raw))) kids.push({ id: c[1].toLowerCase(), raw: c[0] });
            var pick = kids.filter(function (k) { return SENSORS[k.id]; })[0];
            if (pick) { id = pick.id; raw = pick.raw; }
            /* Sharing one curve with none stored for it, every input goes
             * through the LAST child's curve (test/krita/probes/sensorlist:
             * pressure then a falling speed curve painted 1 - p, the other
             * order nothing at all). X2FA Smeary Bristle's colour rose with
             * pressure here and fell in Krita. */
            if (shared && !common && kids.length) common = BrushPack.parseCurve(kids[kids.length - 1].raw);
        }
        var len = /length="([0-9.]+)"/.exec(raw);
        /* "Share curve across all settings" -- on unless the file says off --
         * paints every sensor with <opt>commonCurve, not the sensor's own.
         * Revoy's Mechanical Pencil keeps a straight line in its sensor and a
         * curve topping out at 0.57 in commonCurve; reading the sensor's drew
         * it at twice the width. */
        var curve = (shared && common) || BrushPack.parseCurve(raw);
        /* The children are multiplied. We drive from one input, so a child
         * whose resting value we know (speed: 0 in a steady hand and in
         * Krita's scripted strokes, probes/speed) folds in as a constant.
         * ponytail: a fast stroke should lower it; two live inputs on one
         * option would need the engine to multiply sources. */
        kids.forEach(function (k) {
            if (k.id !== 'speed' || k.id === id || !curve) return;
            var kc = (shared && common) || BrushPack.parseCurve(k.raw);
            var rest = kc ? kc[0][1] : 1;
            curve = curve.map(function (pt) { return pt.length === 3 ? [pt[0], pt[1] * rest, 1] : [pt[0], pt[1] * rest]; });
        });
        /* Every input at once, for the engine to combine as Krita does:
         * plain ones by the option's curveMode (multiply unless the file
         * says add / max / min / difference), drawing angle as a wrapped
         * offset multiplied in whatever the mode, rotation added. Only
         * built where it matters -- two or more inputs, or one angle --
         * so the single-sensor path stays as it was. */
        var all = null;
        var list = kids.length ? kids : [{ id: id, raw: raw }];
        if (kids.length > 1 || list.some(function (k) { return k.id === 'drawingangle' || k.id === 'rotation' || /length="/.test(k.raw); })) {
            all = [];
            list.forEach(function (k) {
                var kc = (shared && common) || BrushPack.parseCurve(k.raw);
                /* Speed is 0 in a steady hand and Krita's scripted strokes
                 * (probes/speed); tangential pressure is 0 from a mouse, a
                 * script and any pen without a wheel. */
                if (k.id === 'speed' || k.id === 'tangentialpressure') { all.push({ kind: 'const', v: kc ? kc[0][1] : k.id === 'speed' ? 1 : 0 }); return; }
                if (!SENSORS[k.id]) return;
                var e = { src: SENSORS[k.id], curve: kc,
                          kind: k.id === 'drawingangle' ? 'abs' : k.id === 'rotation' ? 'add' : 'scale' };
                var off = /angleOffset="(-?[0-9.]+)"/.exec(k.raw);
                if (off) e.offset = parseFloat(off[1]);
                if (/lockedAngleMode="1"/.test(k.raw)) e.locked = true;
                var kl = /length="([0-9.]+)"/.exec(k.raw);
                if (kl) { e.length = parseFloat(kl[1]); e.periodic = /periodic="1"/.test(k.raw); }
                all.push(e);
            });
        }
        return { id: id, src: SENSORS[id] || null,
                 length: len ? parseFloat(len[1]) : null,
                 periodic: /periodic="1"/.test(raw),
                 curve: curve, all: all, mode: parseInt(params[opt + 'curveMode'], 10) || 0 };
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

        /* Tenths of a percent: whole ones painted 0.6% and 1% build-up alike
         * and 0.4% not at all, where Krita's layer shows them apart
         * (test/krita/probes/faint). */
        out.opacity = Math.round(_num(P.OpacityValue, 1) * 1000) / 10;
        out.flow = Math.round(_num(P.FlowValue, 1) * 1000) / 10;
        /* "Build up" painting (PaintOpAction 1; Wash, 2, is the default):
         * each dab lands straight on the layer at the opacity, so dabs
         * darken past it, and flow plays no part. Measured on Krita's own
         * renders (test/krita/probes/buildup): halving flow changed nothing,
         * halving opacity halved the dab. Ramon's Airbrush Digital
         * (25%/25%) peaked at 15% in Krita and 3.5% here. */
        var buildUp = _num(P.PaintOpAction, 2) === 1;
        /* What follows from the probes was measured on the pixel brush only;
         * a smudge preset keeps these keys as leftovers, and taking them
         * turned mixbrush bis solid black where Krita paints it grey. */
        var measured = preset.paintop !== 'colorsmudge';
        if (buildUp) {
            out.flow = out.opacity;
            out.opacity = 100;
        }

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
            /* ...which is only right at one size. Krita's gap is
             * coeff * sqrt(dab size) pixels (calcAutoSpacing), so the engine
             * takes the coefficient itself; `spacing` stays as the slider's
             * resting value for anyone who switches auto off. */
            out.autoSpacing = _num(bd.autoSpacingCoeff, 1);
        }
        if (_bool(P['Spacing/Isotropic'])) out.spacingIsotropic = true;

        var mask = bd.mask;
        if (mask) {
            // A generated tip: numbers all the way down, which is our own case.
            // Anything Krita does not read as "circle" is its rectangle (KisMaskGenerator::fromXML): EO Pixel Taper says "rct".
            out.shape = String(mask.type || 'circle') === 'circle' ? 'circle' : 'square';
            out.size = Math.max(1, Math.round(_num(mask.diameter, 20)));
            out.spacingWhole = true;   // see _stepFor
            /* Krita's ratio is the short axis over the long one, so it is our
             * aspect upside down -- and ours squashes rather than stretches,
             * which is the same convention once inverted. */
            var ratio = _num(mask.ratio, 1);
            out.aspectRatio = (ratio > 0 && ratio < 1) ? Math.round((1 / ratio) * 100) / 100 : 1;
            /* hfade/vfade are the share of the radius that stays SOLID --
             * 1 is a hard disc, 0 a cone. That is the opposite of what the
             * word suggests, and this read it the other way round until it
             * was checked against KisCircleMaskGenerator::valueAt: solid out
             * to `fade`, then (1 - r^2)/(1 - fade^2). Our hardness is that
             * same number and our circle is that same curve. The gauss
             * generator agrees on the direction (1 is hard) and has a
             * profile of its own, which `falloff` selects. */
            var fade = (_num(mask.hfade, 1) + _num(mask.vfade, 1)) / 2;
            out.hardness = Math.round(Math.max(0, Math.min(1, fade)) * 100);
            var gen = String(mask.id || 'default');
            // Krita's own circle, edge and all -- see _kritaCircleMask.
            var aa = String(mask.antialiasEdges) === '1' ? '-aa' : '';
            if (gen === 'gauss') out.falloff = 'krita-gauss' + aa;
            else if (gen === 'default') out.falloff = 'krita' + aa;
            // Krita's squares fade their sides and their ends apart.
            if ((gen === 'gauss' || gen === 'default') && out.shape === 'square' && _num(mask.hfade, 1) !== _num(mask.vfade, 1)) {
                out.hardness = Math.round(Math.max(0, Math.min(1, _num(mask.hfade, 1))) * 100);
                out.hardnessY = Math.round(Math.max(0, Math.min(1, _num(mask.vfade, 1))) * 100);
            }
            /* "soft" is a drawn curve: opacity at each radius is the curve
             * there (KisCurveCircleMaskGenerator::valueAt) and the fades play
             * no part. Airbrush Soft peaks at 40% in the middle; read as a
             * rough third of the fade it painted a solid-cored disc. The
             * square reads it on both axes (the engine's _kritaCurveRectMask). */
            var sc0 = gen === 'soft' && (out.shape === 'circle' || out.shape === 'square') &&
                BrushPack.parseCurve('<curve>' + (mask.softness_curve || '') + '</curve>');
            if (sc0) { out.tipCurve = sc0; out.hardness = 0; out.falloff = 'krita-soft' + aa; }
            else if (gen === 'soft') out.hardness = Math.round(out.hardness * 0.3);
            if (_num(mask.spikes, 2) > 2) warn.push('a star-shaped tip became a plain one');
        } else if (bd.filename) {
            out.shape = 'custom';
            out.hardness = 100;      // the image is the shape; do not fade it
            out.tipShrink = 'area';  // Krita keeps a shrunk tip's ink; see the engine's _shrinkTip
            var scale = _num(bd.scale, 1);
            if (opts.tipSize) out.size = Math.max(1, Math.round(opts.tipSize * scale));
            else { out.size = scale; out.needsTipSize = true; }
        } else if (preset.paintop === 'roundmarker') {
            out.shape = 'circle';   // see the engine's _kritaMarkerMask
            out.falloff = 'marker';
            out.size = _num(P.diameter, 30);
        } else if (preset.paintop !== 'experimentbrush' &&
                   preset.paintop !== 'deformbrush' && preset.paintop !== 'curvebrush' && preset.paintop !== 'particlebrush') {
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
        var mb = _bool(P['MaskingBrush/Enabled']) &&
            BrushPack.brushDefinition(preset, 'MaskingBrush/Preset/brush_definition');
        /* Subtract is not a tip stamped through each dab: Krita paints the
         * masking brush as a whole second stroke of its own and takes its
         * alpha off the finished stroke (KisMaskingBrushRenderer). The
         * Waterpaint presets hollow their strokes out that way. Linear dodge
         * is the same second stroke added on instead (Charcoal Pencil). */
        var mop = { subtract: 'subtract', linear_dodge: 'add' }[P['MaskingBrush/MaskingCompositeOp']];
        if (mb && mb.mask && mop) {
            var MP = {}, pre = 'MaskingBrush/Preset/';
            Object.keys(P).forEach(function (k) { if (k.indexOf(pre) === 0) MP[k.slice(pre.length)] = P[k]; });
            out.maskOp = mop;
            if (mb.mask.id === 'default' || !mb.mask.id)
                out.maskHardness = Math.round((_num(mb.mask.hfade, 1) + _num(mb.mask.vfade, 1)) / 2 * 100);
            out.maskSize = Math.round(_num(P['MaskingBrush/MasterSizeCoeff'], 1) * 100);
            out.maskFlow = Math.round(_num(MP.FlowValue, 1) * 100);
            out.maskSpacing = Math.max(1, Math.round(_num(mb.spacing, 0.1) * 100));
            out.maskTipCurve = (mb.mask.id === 'soft' &&
                BrushPack.parseCurve('<curve>' + (mb.mask.softness_curve || '') + '</curve>')) || null;
            ['Size', 'Flow', 'Opacity'].forEach(function (o) {
                var s = _sensorFor(MP, o);
                if (!s || !s.src) return;
                out['mask' + o + 'Src'] = s.src;
                out['mask' + o + 'Min'] = 0;
                if (s.curve) out['mask' + o + 'Curve'] = s.curve;
            });
        } else if (_bool(P['MaskingBrush/Enabled'])) {
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
                out.tip2Angle = ((Math.round(-_num(mb.angle, 0) * 180 / Math.PI) % 360) + 360) % 360;   // negated, as out.angle below
            } else {
                warn.push('dropped: a second brush used as a mask');
            }
        }

        /* Krita stores the tip's own turn in radians, and turns it the other
         * way from ctx.rotate: it samples the tip at (cos x - sin y,
         * sin x + cos y) (KisBrushMaskScalarApplicator), which shows the tip
         * turned by minus the angle. A lone Charcoal Pencil dab next to
         * Krita's leaned the wrong way until this was negated. */
        out.angle = ((Math.round(-_num(bd.angle, 0) * 180 / Math.PI) % 360) + 360) % 360;

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

        /* The size option's strength scales the dab whenever the option is
         * on (KisStandardOption): Nylnook Poska Square's 0.82 laid 1.24x
         * Krita's ink without it. */
        if (_bool(P.PressureSize) && _num(P.SizeValue, 1) !== 1) out.sizeStrength = _num(P.SizeValue, 1);

        // Size and flow ride their sensors the same way ours do.
        [['Size', 'size'], ['Flow', 'flow'], ['Opacity', 'opacity']].forEach(function (pair) {
            var s = _sensorFor(P, pair[0], pair[0] === 'Flow' && preset.paintop === 'paintbrush');
            var key = pair[1];
            if (!s) return;
            if (key === 'opacity') {
                /* Krita's per-dab opacity is not more flow: it is the level
                 * the stroke's ink stops building at (alpha darken, see the
                 * engine's _alphaDarken). Riding it on flow let overlapping
                 * dabs stack past it -- measured against Krita's own render,
                 * Basic-2 Opacity came out 1.6x too dark and Airbrush 2.8x. */
                if (!s.src) { warn.push('Opacity followed ' + s.id + ', which we have no input for'); return; }
                out.dabOpacitySrc = s.src;
                out.dabOpacityMin = 0;
                _kritaReach(out, s);
                if (s.curve) out.dabOpacityCurve = s.curve;
                if (s.all) { out.dabOpacitySensors = s.all; out.dabOpacityCombine = s.mode; s.all.forEach(function (e) { _kritaReach(out, e); }); }
                return;
            }
            if (!s.src) { warn.push(pair[0] + ' followed ' + s.id + ', which we have no input for'); return; }
            out[key + 'Src'] = s.src;
            out[key + 'Min'] = 0;
            _kritaReach(out, s);
            if (s.curve) out[key + 'Curve'] = s.curve;
            if (s.all) { out[key + 'Sensors'] = s.all; out[key + 'Combine'] = s.mode; s.all.forEach(function (e) { _kritaReach(out, e); }); }
        });

        /* The spacing option multiplies the gap by its strength times its
         * curve. Measured on Krita 5.3's own renders of Ink-1 Precision with
         * the option switched on: strength 0.08 spaced dabs 0.08x as far, 0.5
         * spaced them 0.5x, and a pressure curve scaled the gap in step. With
         * its curve box clear it is the strength alone. A colour smudge has
         * the same option: taken there too, Wet_Smear (gaps closing as the
         * pen presses) went from 0.61x to 0.96x ink and both mixbrushes
         * from off/near to close in the bank. */
        if (_bool(P.PressureSpacing)) {
            out.spacingStrength = _num(P.SpacingValue, 1);
            var sps = _sensorFor(P, 'Spacing');
            if (sps && !sps.src) warn.push('Spacing followed ' + sps.id + ', which we have no input for');
            else if (sps) {
                out.spacingSrc = sps.src;
                out.spacingMin = 0;
                _kritaReach(out, sps, 'spacing');
                if (sps.curve) out.spacingCurve = sps.curve;
            }
        }

        /* The ratio option squashes the tip across its short axis by its
         * curve (Krita's ratio is short over long, ours long over short, so
         * the engine divides). EO Pixel Taper's light strokes are a pixel or
         * two thick in Krita because of it: a 0.2 ratio at pressure 0.1,
         * turned along the stroke by its drawing-angle rotation. */
        var rts = _sensorFor(P, 'Ratio');
        if (rts && !rts.src) warn.push('Ratio followed ' + rts.id + ', which we have no input for');
        else if (rts) {
            out.aspectRatioSrc = rts.src;
            out.aspectRatioMin = 0;
            _kritaReach(out, rts, 'aspectRatio');
            if (rts.curve) out.aspectRatioCurve = rts.curve;
        }

        /* Softness eases the tip's fade: its strength times its curve,
         * 0.1..1 (the engine's _softCurve). Image tips ignore it in Krita. */
        if (_bool(P.PressureSoftness)) {
            if (_num(P.SoftnessValue, 1) !== 1) out.softnessStrength = _num(P.SoftnessValue, 1);
            var sfs = _sensorFor(P, 'Softness');
            if (sfs && !sfs.src) warn.push('Softness followed ' + sfs.id + ', which we have no input for');
            else if (sfs) {
                out.softnessSrc = sfs.src;
                out.softnessMin = 0;
                _kritaReach(out, sfs, 'softness');
                if (sfs.curve) out.softnessCurve = sfs.curve;
            }
        }

        /* ...and a pressure-driven opacity in build-up scales each dab, which
         * then stacks: the same probe's lone dab at pressure 0.5 was 124 and
         * its line 209, where a ceiling held ours at 128. So it rides flow. */
        if (measured && buildUp) {
            // Krita's own flow and its sensor play no part here.
            delete out.flowSrc; delete out.flowMin; delete out.flowCurve;
            if (out.dabOpacitySrc) {
                out.flowSrc = out.dabOpacitySrc;
                out.flowMin = out.dabOpacityMin;
                if (out.dabOpacityCurve) out.flowCurve = out.dabOpacityCurve;
                delete out.dabOpacitySrc; delete out.dabOpacityMin; delete out.dabOpacityCurve;
            }
        }

        /* Rotation is an angle, not a factor, so it takes the source only --
         * its curve would reshape a full turn and we do not offer that. */
        var rot = _sensorFor(P, 'Rotation');
        /* Tilt direction ("ascension") with no pen tilt -- a mouse, or
         * Krita's scripted strokes -- turns the tip a quarter turn: measured
         * (test/krita/probes/ascension), a thin rect at 0 painted as the one at
         * 90 and 90 as 0. In a list it adds that quarter on top of the other
         * inputs, which then turn the tip as they would alone; Grease
         * Charcoal and Large Chalk lay their flat tips that way. A list
         * multiplies its inputs, so where in it the tilt sits is no matter
         * (Bristle_frottis001111 puts pressure first). */
        var rsRaw = _sensorRaw(P, 'Rotation');
        var ascKid = /<ChildSensor\b[^>]*?\bid="ascension"[^>]*?(?:\/>|>[\s\S]*?<\/ChildSensor>)/, ascList = false;
        if (rot && (rot.id === 'ascension' || ascKid.test(rsRaw))) {
            var rest = rsRaw.replace(ascKid, '');
            out.angle = ((out.angle || 0) + 90) % 360;
            if (rest !== rsRaw && /<ChildSensor\b/.test(rest)) {
                ascList = true;
                var P2 = {}; for (var pk in P) P2[pk] = P[pk];
                P2.RotationSensor = rest;
                rot = _sensorFor(P2, 'Rotation');
            }
        }
        if (rot) {
            /* Every sensor the engine can read now spins the tip -- the ones
             * that ARE an angle (direction, twist, tilt) point it, the rest
             * turn it through a full circle across their range, which is what
             * Krita's pressure-driven rotation does. Only an input we cannot
             * read at all is still refused. */
            if (rot.src === 'direction' && /lockedAngleMode="1"/.test(rsRaw)) out.angleLocked = true;
            // fan corners: a sharp turn filled a step at a time (KisRotationOption)
            else {
                var fanTag = (/<params[^>]*id="drawingangle"[^>]*>/.exec(rsRaw) || [''])[0];
                if (_bool(P.PressureRotation) && /fanCornersEnabled="1"/.test(fanTag) && /^(paintbrush|colorsmudge)$/.test(preset.paintop))
                    out.fanStep = _num((/fanCornersStep="([0-9.]+)"/.exec(fanTag) || [])[1], 20);
            }
            /* The drawing angle sensor reads 0.5 + angle/2pi + angleOffset/360
             * (KisDynamicSensorDrawingAngle): the offset turns the tip on top
             * of the stroke's direction. Dropped, GDquest Paint Soft laid its
             * cloud tip along the line instead of 98 degrees across it. */
            var dOff = rot.src === 'direction' && /angleOffset="(-?[0-9.]+)"/.exec(rsRaw);
            if (dOff) out.angle = (((out.angle || 0) + parseFloat(dOff[1])) % 360 + 360) % 360;
            if (rot.src) {
                out.angleSrc = rot.src; _kritaReach(out, rot);
                // its own reach: X3CD Doodle turns every 130px and grows every 200
                if (rot.length != null) out.angleReach = { length: rot.length, periodic: rot.periodic };
            }
            else warn.push('the tip turned with ' + rot.id + ', which we cannot turn it with');
        }
        // several inputs: the engine takes Krita's whole formula (_dynAngle)
        if (_bool(P.PressureRotation) && rot && rot.src && rot.all && rot.all.length > 1) {
            out.angleSensors = rot.all; out.angleCombine = rot.mode;
            out.angleStrength = _num(P.RotationValue, 1);
        }
        /* Inputs that are not themselves an angle go through Krita's own
         * formula: strength and curve kept, and a half turn on top (see
         * _dynAngle). A switched-on option with no input is the half turn
         * alone. Direction and tilt keep pointing the tip as they
         * did; pen rotation is an added turn in Krita, so it takes the formula. */
        if (_bool(P.PressureRotation) && !(rot && /^(direction|tilt)$/.test(rot.src || ''))) {
            if (rot && rot.src) {
                out.angleStrength = _num(P.RotationValue, 1);
                if (rot.curve) out.angleCurve = rot.curve;
                /* Tilt direction's quarter is -0.5 added inside Krita's
                 * formula, 180 (w - 1): beside other inputs that is a
                 * quarter the other way, a half turn from the lone tilt's.
                 * Thin rects cannot tell; Large Chalk's one-sided sponge
                 * lay upside down. */
                if (ascList) out.angle = (out.angle + 180) % 360;
            } else if (!rot) {
                out.angle = (out.angle + 180) % 360;
            }
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
                /* Krita 4 on also keeps a copy of the picture in the preset
                 * (KisEmbeddedPatternManager): a PNG, base64'd twice. That
                 * copy is there whether or not the pack carries the file --
                 * Grease Charcoal names one from Krita's own set -- and it is
                 * a PNG where the pack's may be a .pat. */
                var emb = String(P['Texture/Pattern/Pattern'] || '');
                try { if (emb && emb.indexOf('iVBOR') !== 0) emb = atob(emb); } catch (e) { emb = ''; }
                if (emb.indexOf('iVBOR') === 0) out.texturePatternData = 'data:image/png;base64,' + emb;
                out.texture = Math.round(_num(P['Texture/Strength/Value'], 1) * 100);
                /* Krita's own maths, not our grain: measured against Krita,
                 * Chalk Soft's texture removed no ink at all through the
                 * grey-tint path. Height (12) is measured too; the other
                 * modes paint colour or use blend maths we do not carry, and
                 * fall back to multiply. */
                var tm = Math.round(_num(P['Texture/Pattern/TexturingMode'], 0));
                if (tm > 1 && tm !== 12) warn.push('texture mode ' + tm + ' painted as multiply');
                out.textureMode = tm === 1 ? 'subtract' : tm === 12 ? 'height' : 'multiply';
                out.textureScale = _num(P['Texture/Pattern/Scale'], 1);
                // its offset, in canvas pixels; a random one is per stroke
                if (_bool(P['Texture/Pattern/isRandomOffsetX']) || _bool(P['Texture/Pattern/isRandomOffsetY'])) warn.push('texture random offset not carried');
                else {
                    if (_num(P['Texture/Pattern/OffsetX'], 0)) out.textureOffsetX = Math.round(_num(P['Texture/Pattern/OffsetX'], 0));
                    if (_num(P['Texture/Pattern/OffsetY'], 0)) out.textureOffsetY = Math.round(_num(P['Texture/Pattern/OffsetY'], 0));
                }
                out.textureBrightness = _num(P['Texture/Pattern/Brightness'], 0);
                out.textureContrast = _num(P['Texture/Pattern/Contrast'], 1);
                out.textureInvert = _bool(P['Texture/Pattern/Invert']);
                out.textureSoft = _bool(P['Texture/Pattern/UseSoftTexturing']);
                /* Cutoff: outside its grey range the pattern reads as black
                 * (policy 1) or white (2) -- see _kritaTexMask. */
                var cp = Math.round(_num(P['Texture/Pattern/CutoffPolicy'], 0));
                if (cp === 1 || cp === 2) {
                    out.textureCutoff = cp;
                    out.textureCutoffLo = _num(P['Texture/Pattern/CutoffLeft'], 0);
                    out.textureCutoffHi = _num(P['Texture/Pattern/CutoffRight'], 255);
                }
                var np = _num(P['Texture/Pattern/NeutralPoint'], 0.5);
                if (tm === 12) out.textureNeutral = np;
                else if (np !== 0.5) warn.push('texture neutral point not carried');
                var ts = _sensorFor(P, 'Texture/Strength/');
                if (ts && ts.src) {
                    out.textureSrc = ts.src;
                    out.textureMin = 0;
                    _kritaReach(out, ts, 'texture');
                    if (ts.curve) out.textureCurve = ts.curve;
                }
            } else {
                warn.push('dropped: a canvas texture pattern');
            }
        }

        /* The engine keeps one reach for fade and one for distance, not one
         * per dial, so the first option that asks sets it. */
        function _kritaReach(out, s, key) {
            /* With a key, the option takes Krita's whole input list, each
             * input keeping its own reach: one brush-wide fade length gave
             * Watercolor Stroke Dry's scatter the 4000 dabs of its opacity. */
            if (key && s.all) { out[key + 'Sensors'] = s.all; out[key + 'Combine'] = s.mode; }
            if (s.length == null) return;
            if (s.src === 'fadein' && out.fadeSteps == null) {
                out.fadeSteps = Math.max(1, Math.round(s.length));
                out.fadePeriodic = s.periodic;
            } else if (s.src === 'distance' && out.distanceLength == null) {
                out.distanceLength = Math.max(1, Math.min(500, Math.round(s.length)));
                out.distancePeriodic = s.periodic;
            }
        }

        var sc = _sensorFor(P, 'Scatter');
        /* Scatter's response curve was parsed and then thrown away, so a
         * brush that only scatters at speed scattered constantly. */
        if (sc && sc.src) {
            out.scatterSrc = sc.src;
            out.scatterMin = 0;
            _kritaReach(out, sc, 'scatter');
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
            /* ...its threshold is strength times its sensors
             * (KisSharpnessOption::applyThreshold): Rock_flat's cut-out
             * keeps only the tip's core at light pressure. */
            var shs = _sensorFor(P, 'Sharpness');
            if (shs && !shs.src) warn.push('Sharpness followed ' + shs.id + ', which we have no input for');
            else if (shs) {
                out.sharpnessSrc = shs.src; out.sharpnessMin = 0;
                _kritaReach(out, shs);
                if (shs.curve) out.sharpnessCurve = shs.curve;
                if (shs.all) { out.sharpnessSensors = shs.all; out.sharpnessCombine = shs.mode; shs.all.forEach(function (e) { _kritaReach(out, e); }); }
            }
        }

        /* Krita's airbrush keeps dabbing while the pen is held still, which
         * is the pair of dials we already have under a different name. */
        if (_bool(P.AirbrushEnabled)) {
            out.airbrushMode = true;
            // Krita's rate is dabs per second; ours is the same idea.
            out.airbrushRate = Math.max(1, Math.round(_num(P.AirbrushRate, 40)));
        }

        // A per-dab flip is exactly what our strip tips already do.
        // Only when the option is on: Krita keeps both boxes' last state either way.
        var mon = _bool(P.PressureMirror);
        var mrx = mon && _bool(P.HorizontalMirrorEnabled), mry = mon && _bool(P.VerticalMirrorEnabled);
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
            /* Krita's own model now (the engine's _smudgeDab): colour rate is
             * how much paint goes into what the dab picked up, smudge rate
             * how strongly that is laid down. Measured
             * (test/krita/probes/smudge): colour rate switched off adds no
             * paint at all. Smudge rate switched off still smears, at full
             * strength: the stroke builds up out of what it picks up exactly
             * as at smudge rate 1 (test/krita/probes/smudge9). */
            var cr = _num(P.ColorRateValue, 0.5), sr = _num(P.SmudgeRateValue, 0.5);
            var crS = _sensorFor(P, 'ColorRate'), srS = _sensorFor(P, 'SmudgeRate');
            var crOn = _bool(P.PressureColorRate), srOn = _bool(P.PressureSmudgeRate);
            out.smudgeMode = Math.round(_num(P.SmudgeRateMode, 0)) === 1 ? 1 : 0;
            out.colorRate = crOn ? Math.round(cr * 100) : 0;
            out.smudgeRate = srOn ? Math.round(sr * 100) : out.colorRate;
            // off: smears at full strength, but its slider still sets the mix (probes/sensorlist, plain)
            if (!srOn) { out.smudgeRate = Math.round(sr * 100); out.smudgeFull = true; srS = null; }
            /* Smudge radius: how much of the last dab dulling averages (0 its
             * centre pixel, 1 all of it; the old engine reaches to 3). Its
             * first version stored percent (KisSmudgeRadiusOptionData). */
            var rdOn = _bool(P.PressureSmudgeRadius), rdS = rdOn ? _sensorFor(P, 'SmudgeRadius') : null;
            if (rdOn) out.smudgeSample = Math.min(_bool(P.SmudgeRateUseNewEngine) ? 1 : 3,
                _num(P.SmudgeRadiusValue, 0) / (_num(P.SmudgeRadiusVersion, 1) < 2 ? 100 : 1));
            [['colorRate', crOn ? crS : null], ['smudgeRate', srS], ['smudgeSample', rdS]].forEach(function (e) {
                var s = e[1];
                if (!s) return;
                if (!s.src) { warn.push('colour smudging followed ' + s.id + ', which we have no input for'); return; }
                out[e[0] + 'Src'] = s.src;
                out[e[0] + 'Min'] = 0;
                if (s.curve) out[e[0] + 'Curve'] = s.curve;
                if (s.all) { out[e[0] + 'Sensors'] = s.all; out[e[0] + 'Combine'] = s.mode; }
                _kritaReach(out, s);
            });
            if (_bool(P.MergedPaint)) out.smudgeMerged = true;
            if (_bool(P.SmudgeRateUseNewEngine)) out.smudgeNew = true;
            if (P.SmudgeRateSmearAlpha === 'false') out.smudgeSmearAlpha = false;
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
        } else if (preset.paintop === 'sketchbrush') {
            /* Measured on Krita's own renders (test/krita/probes/sketch):
             * hard lines of Sketch/lineWidth, as dark as the opacity curve
             * reads at the pen's pressure, out to earlier points within half
             * the tip, trimmed by the offset. The tip is only that reach. */
            out.engineKind = 'sketch';
            out.sketchWidth = Math.max(0.5, _num(P['Sketch/lineWidth'], 1));
            out.sketchOffset = _num(P['Sketch/offset'], 30) / 100;
            out.sketchProb = Math.max(0, Math.min(1, _num(P['Sketch/probability'], 0.5) * _num(P.DensityValue, 1)));
            out.sketchMagnet = _bool(P['Sketch/magnetify']);
            out.sketchDistDensity = _bool(P['Sketch/distanceDensity']);
            out.sketchDistOpacity = _bool(P['Sketch/distanceOpacity']);
            out.sketchAA = _bool(P['Sketch/antiAliasing']);
            if (out.dabOpacitySrc) {   // a line has no dabs to cap: the opacity is its ink
                out.flowSrc = out.dabOpacitySrc;
                out.flowMin = out.dabOpacityMin;
                if (out.dabOpacityCurve) out.flowCurve = out.dabOpacityCurve;
                delete out.dabOpacitySrc; delete out.dabOpacityMin; delete out.dabOpacityCurve;
            }
            var lw = _bool(P['PressureLine width']) && _sensorFor(P, 'Line width');
            if (lw && lw.src) {
                out.sketchWidthSrc = lw.src;
                out.sketchWidthMin = 0;
                _kritaReach(out, lw, 'sketchWidth');
                if (lw.curve) out.sketchWidthCurve = lw.curve;
            }
            if (_bool(P['Sketch/randomRGB'])) warn.push('dropped: the slight colour wobble on its lines');
            if (_bool(P['Sketch/randomOpacity'])) warn.push('dropped: the random opacity on its lines');
        } else if (preset.paintop === 'curvebrush') {
            /* Krita's curve brush: no dabs. Each new input point is joined to
             * the last by a line lineWidth wide, and once strokeHistorySize
             * points have gone by, a curve runs from the oldest of them
             * through the middle one to the newest (see _paintCurveOp). It
             * never counts dabs, so a fade sensor reads its start throughout. */
            out.engineKind = 'curve';
            out.sketchWidth = Math.max(0, _num(P['Curve/lineWidth'], 1));
            out.curveHistory = Math.max(1, Math.round(_num(P['Curve/strokeHistorySize'], 30)));
            out.curveConnect = _bool(P['Curve/makeConnection']);
            out.curveQuad = _bool(P['Curve/smoothing']);
            out.curvesOpacity = Math.max(0, Math.min(1, _num(P['Curve/curvesOpacity'], 1)));
            if (out.dabOpacitySrc) {   // a line has no dabs to cap: the opacity is its ink
                out.flowSrc = out.dabOpacitySrc;
                out.flowMin = out.dabOpacityMin;
                if (out.dabOpacityCurve) out.flowCurve = out.dabOpacityCurve;
                delete out.dabOpacitySrc; delete out.dabOpacityMin; delete out.dabOpacityCurve;
            }
            [['Line width', 'sketchWidth'], ['Curves opacity', 'curvesOpacity']].forEach(function (e) {
                var s = _bool(P['Pressure' + e[0]]) && _sensorFor(P, e[0]);
                if (!s || !s.src) return;
                out[e[1] + 'Src'] = s.src;
                out[e[1] + 'Min'] = 0;
                if (s.curve) out[e[1] + 'Curve'] = s.curve;
                if (s.all) { out[e[1] + 'Sensors'] = s.all; out[e[1] + 'Combine'] = s.mode; }
                _kritaReach(out, s);
                if (s.all) s.all.forEach(function (x) { _kritaReach(out, x); });
            });
        } else if (preset.paintop === 'gridbrush') {
            /* See _gridDab in the engine: cells fixed to the canvas, each
             * filled with divisionLevel^2 shapes. */
            out.grid = {
                w: Math.max(1, _num(P['Grid/gridWidth'], 25)), h: Math.max(1, _num(P['Grid/gridHeight'], 25)),
                scale: Math.max(0.01, _num(P['Grid/scale'], 1)),
                div: Math.max(1, Math.round(_num(P['Grid/divisionLevel'], 2))),
                shape: Math.round(_num(P['GridShape/shape'], 0))
            };
            if (out.grid.shape > 1) warn.push('dropped: its grid shape ' + out.grid.shape + ', painted as circles');
            if (_bool(P['Grid/pressureDivision']) || _bool(P['Grid/randomBorder']) ||
                _num(P['Grid/horizontalBorder'], 0) || _num(P['Grid/verticalBorder'], 0)) {
                warn.push('dropped: its grid borders and pressure division');
            }
            if (['colorPerParticle', 'fillBackground', 'mixBgColor', 'sampleInputColor', 'useRandomHSV', 'useRandomOpacity']
                    .some(function (k) { return _bool(P['ColorOption/' + k]); })) {
                warn.push('dropped: its grid colour options');
            }
        } else if (preset.paintop === 'hatchingbrush') {
            /* Measured on Krita's renders (test/krita/probes/hatch, hatchp):
             * the tip is filled with straight lines fixed to the canvas, not
             * the stroke -- one passes through the origin pixel, the rest
             * every `separation` px across. A thickness or separation option
             * switched off reads 0.5 (the line is thickness/2 wide), on
             * without its curve reads 1. Separation steps in powers of two
             * over `separationintervals` bands. */
            var hsens = function (opt) {
                if (!_bool(P['Pressure' + opt])) return { v: 0.5 };
                var hs = _sensorFor(P, opt);
                return hs && hs.src ? { src: hs.src, curve: hs.curve } : { v: 1 };
            };
            out.hatch = {
                angle: _num(P['Hatching/angle'], -60),
                separation: Math.max(1, _num(P['Hatching/separation'], 6)),
                thickness: Math.max(0, _num(P['Hatching/thickness'], 1)),
                ox: _num(P['Hatching/origin_x'], 50), oy: _num(P['Hatching/origin_y'], 50),
                intervals: Math.max(1, Math.round(_num(P['Hatching/separationintervals'], 2))),
                aa: _bool(P['Hatching/bool_antialias']),
                whole: P['Hatching/bool_subpixelprecision'] !== undefined && !_bool(P['Hatching/bool_subpixelprecision']),
                cross: _bool(P['Hatching/bool_perpendicular']),
                thick: hsens('Thickness'), sep: hsens('Separation')
            };
            ['minusthenplus', 'plusthenminus', 'moirepattern'].forEach(function (k) {
                if (_bool(P['Hatching/bool_' + k])) warn.push('dropped: its ' + k + ' cross-hatching, painted as single lines');
            });
        } else if (preset.paintop === 'hairybrush') {
            // see _paintHairy in the engine; Krita's own defaults
            out.engineKind = 'hairy';
            var hk = function (k, d) { return _num(P['HairyInk/' + k], d); };
            out.hairy = {
                density: _num(P['HairyBristle/density'], 100) / 100, random: _num(P['HairyBristle/random'], 2),
                scale: _num(P['HairyBristle/scale'], 2), shear: _num(P['HairyBristle/shear'], 0),
                threshold: _bool(P['HairyBristle/threshold']), aa: _bool(P['HairyBristle/antialias']),
                comp: _bool(P['HairyBristle/useCompositing']), connected: _bool(P['HairyBristle/isConnected']),
                inkOn: _bool(P['HairyInk/enabled']), inkAmount: Math.max(2, Math.round(hk('inkAmount', 1024))),
                inkCurve: BrushPack.parseCurve('<curve>' + (P['HairyInk/inkDepletionCurve'] || '0,0;1,1;') + '</curve>'),
                useOpacity: P['HairyInk/useOpacity'] === undefined || _bool(P['HairyInk/useOpacity']),
                useWeights: _bool(P['HairyInk/useWeights']),
                pw: hk('pressureWeights', 50) / 100, blw: hk('bristleLengthWeights', 50) / 100,
                biw: hk('bristleInkAmountWeight', 50) / 100, idw: hk('inkDepletionWeight', 50)   // not a percentage in Krita
            };
            if (out.dabOpacitySrc) {   // no dabs to cap: the opacity is the pass's
                out.flowSrc = out.dabOpacitySrc;
                out.flowMin = out.dabOpacityMin;
                if (out.dabOpacityCurve) out.flowCurve = out.dabOpacityCurve;
                delete out.dabOpacitySrc; delete out.dabOpacityMin; delete out.dabOpacityCurve;
            }
            if (_bool(P['HairyInk/useSaturation']) || _bool(P['HairyInk/soak'])) warn.push('dropped: its bristles taking colour from the canvas');
            if (_bool(P['HairyBristle/useMousePressure'])) warn.push('dropped: its pressure from mouse speed');
        } else if (preset.paintop === 'particlebrush') {
            // see _paintParticle in the engine; Krita's own defaults
            out.engineKind = 'particle';
            out.particle = {
                count: Math.max(1, Math.round(_num(P['Particle/count'], 50))),
                iterations: Math.max(1, Math.round(_num(P['Particle/iterations'], 10))),
                gravity: _num(P['Particle/gravity'], 0.989), weight: _num(P['Particle/weight'], 0.2),
                scaleX: _num(P['Particle/scaleX'], 0.3), scaleY: _num(P['Particle/scaleY'], 0.3)
            };
        } else if (preset.paintop === 'roundmarker') {
            // its own spacing, not a tip's (KisRoundMarkerOpOptionData)
            out.spacing = Math.max(1, Math.round(_num(P.spacing, 0.02) * 100));
            if (_bool(P.useAutoSpacing)) out.autoSpacing = _num(P.autoSpacingCoeff, 1);
        } else if (preset.paintop && preset.paintop !== 'paintbrush') {
            warn.push('this is a ' + preset.paintop + ', which we paint as an ordinary brush');
        }

        out.curveSmooth = true;   // Krita draws every curve as a spline
        out.originAngle = true;   // and turns its first dab by the angle from the canvas origin
        out.speedMax = 30;        // and reads speed against 30 px/ms (maxAllowedSpeedValue)
        /* A dab's precision (KisPrecisionOption): 1-3 reuse the last dab
         * while the next is close enough (see the engine's _kritaTipMask).
         * ponytail: auto precision is taken as 5, its level under 30px or
         * without scatter; 3 above that is unmodelled. */
        if (!_bool(P['KisPrecisionOption/AutoPrecisionEnabled'])) out.kPrecision = Math.round(_num(P['KisPrecisionOption/precisionLevel'], 5));

        /* A Krita option that is switched off holds that dial still. Left
         * unset, ours falls back to the engine's defaults -- size down to
         * half and flow to nothing under a light touch -- so Basic-2 Opacity,
         * which only fades, arrived shrinking as well. Measured against
         * Krita's own render (test/krita). */
        if (!out.sizeSrc) out.sizeSrc = 'none';
        if (!out.flowSrc) out.flowSrc = 'none';

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
     * still counts. GIMP reads the same file as a picture that paints its
     * own colours through its alpha, so `rgb`/`clear` keep that reading. */
    function _readGbr(b, off) {
        if (off + 20 > b.length) return null;
        var dv = new DataView(b.buffer, b.byteOffset + off, Math.min(20, b.length - off));
        var hs = dv.getUint32(0), ver = dv.getUint32(4);
        var w = dv.getUint32(8), h = dv.getUint32(12), bpp = dv.getUint32(16);
        if (ver < 1 || ver > 3 || !w || !h || w > 8192 || h > 8192) return null;
        if (bpp !== 1 && bpp !== 4) return null;
        /* Version 2/3 adds a "GIMP" magic number and the brush's own spacing
         * (already a percentage of its width, 1-1000, same units as ours)
         * between the fixed header above and the name. Version 1 has neither. */
        var spacing = null;
        if (ver >= 2 && off + 28 <= b.length) {
            spacing = new DataView(b.buffer, b.byteOffset + off + 20, 8).getUint32(4);
        }
        var start = off + hs, n = w * h;
        if (start + n * bpp > b.length) return null;
        var a = new Uint8ClampedArray(n), i, rgb = null, clear = null;
        if (bpp === 1) {
            for (i = 0; i < n; i++) a[i] = b[start + i];
        } else {
            rgb = new Uint8ClampedArray(n * 3); clear = new Uint8ClampedArray(n);
            for (i = 0; i < n; i++) {
                var p = start + i * 4;
                var lum = (b[p] * 0.299 + b[p + 1] * 0.587 + b[p + 2] * 0.114) / 255;
                a[i] = Math.round((1 - lum) * b[p + 3]);
                rgb[i * 3] = b[p]; rgb[i * 3 + 1] = b[p + 1]; rgb[i * 3 + 2] = b[p + 2];
                clear[i] = b[p + 3];
            }
        }
        return { w: w, h: h, alpha: a, rgb: rgb, clear: clear, next: start + n * bpp,
                 spacing: spacing ? Math.max(1, Math.min(400, spacing)) : null };
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
        return { cells: cells, spacing: cells[0].spacing,
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
        return { url: out.toDataURL('image/png'), size: Math.max(cw, ch), w: cw, h: ch };
    }

    // A cell resized by k, smoothly (the canvas does the filtering).
    function _scaleCell(c, k) {
        var w = Math.max(1, Math.round(c.w * k)), h = Math.max(1, Math.round(c.h * k));
        var out = document.createElement('canvas'); out.width = w; out.height = h;
        var g = out.getContext('2d');
        g.drawImage(_canvasFromAlpha(c), 0, 0, w, h);
        return _cellOf(out, c.opaque);
    }
    function _cellOf(cv, opaque) {
        var w = cv.width, h = cv.height;
        var d = cv.getContext('2d').getImageData(0, 0, w, h).data, a = new Uint8ClampedArray(w * h), rgb = new Uint8ClampedArray(w * h * 3);
        for (var i = 0; i < w * h; i++) {
            a[i] = d[i * 4 + 3];
            rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
        }
        return { w: w, h: h, alpha: a, rgb: rgb, opaque: opaque };
    }

    /* A Clip Studio preview cut back to its picture's own shape [w, h],
     * centred, where the two differ: Rough pen's picture is a 24x2512 strip
     * and its preview that strip in a 240 square. A ribbon lays the whole
     * picture end to end, blank margins and all (Dashed line's gaps are its
     * margins: 27x87, 45 inked, a 16px period at size 5 in Clip Studio). */
    function _cropCell(c, real) {
        if (!real || Math.abs(real[0] / real[1] - c.w / c.h) < 0.02 * c.w / c.h) return c;
        var w = Math.max(1, Math.min(c.w, Math.round(c.h * real[0] / real[1])));
        var h = Math.max(1, Math.min(c.h, Math.round(c.w * real[1] / real[0])));
        var x0 = (c.w - w) >> 1, y0 = (c.h - h) >> 1, x, y, a = new Uint8ClampedArray(w * h), rgb = new Uint8ClampedArray(w * h * 3);
        for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
            var i = (y0 + y) * c.w + x0 + x, o = y * w + x;
            a[o] = c.alpha[i];
            rgb[o * 3] = c.rgb[i * 3]; rgb[o * 3 + 1] = c.rgb[i * 3 + 1]; rgb[o * 3 + 2] = c.rgb[i * 3 + 2];
        }
        return { w: w, h: h, alpha: a, rgb: rgb, opaque: c.opaque };
    }

    /* Turns whatever a pack calls a tip into one our engine can stamp.
     * Resolves to { url, cells, pick, size } — `size` being the tip's real
     * pixel size BEFORE the cap, since a Krita preset's `scale` multiplies
     * that and not what we chose to store. */
    BrushPack.tipStrip = function (bytes, filename, opts) {
        var name = String(filename || '');
        /* A colour .gbr/.gih on its own is a GIMP brush, and GIMP stamps its
         * picture through its alpha (Pepper, GEGL goat). Inside a Krita
         * preset the same file is a dark-is-ink mask, as above. */
        /* Krita keeps a tip with no transparency as grey paper, ink its
         * darkness, and shrinks that grey (see the engine's _kritaTipLevel). */
        function _paper(cells) {
            return opts && opts.krita && cells.every(function (c) {
                return c.clear ? c.clear.every(function (v) { return v === 255; }) : c.opaque !== false;
            }) ? { tipPaper: true } : null;
        }
        function gimpCells(cells) {
            var color = !(opts && opts.krita) && cells.some(function (c) { return c.rgb; });
            return { color: color, params: color ? { tipMode: 'color' } : _paper(cells), cells: cells.map(function (c) {
                return color && c.rgb ? { w: c.w, h: c.h, alpha: c.clear, rgb: c.rgb }
                                      : { w: c.w, h: c.h, alpha: c.alpha };
            }) };
        }
        try {
            if (/\.gih$/i.test(name)) {
                var pipe = _readGih(bytes);
                if (!pipe) throw new Error('unreadable brush pipe');
                var gc = gimpCells(pipe.cells);
                /* GIMP steps an in-order pipe BEFORE it paints, so a
                 * brush's first dab is
                 * cell 1 and cell 0 comes last; ours stamps from the front.
                 * Measured with a numbered five-cell pipe: 1 2 3 4 | 0 1 2 |
                 * 3 4 0 1 2 over three strokes. */
                if (!(opts && opts.krita) && pipe.pick === 'cycle') gc.cells.push(gc.cells.shift());
                var st = _strip(gc.cells);
                return Promise.resolve({ url: st.url, size: st.size,
                    cells: pipe.cells.length, pick: pipe.pick, spacing: pipe.spacing, params: gc.params });
            }
            if (/\.gbr$/i.test(name)) {
                var one = _readGbr(bytes, 0);
                if (!one) throw new Error('unreadable brush file');
                var gc1 = gimpCells([one]), st1 = _strip(gc1.cells);
                return Promise.resolve({ url: st1.url, size: st1.size, cells: 1, pick: 'random',
                    spacing: one.spacing, params: gc1.params });
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
            /* Krita has one rule for a grey tip, transparent or not: ink is
             * darkness times alpha (fetchPremultipliedRed in kis_brush.cpp).
             * Its oil_knife.png is dark on opaque white bar eleven stray
             * pixels at alpha 192, and trusting the alpha stamped the whole
             * white square. */
            var gray = opts && opts.krita;
            for (i = 0; gray && i < d.length; i += 4) { if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) gray = false; }
            if (gray) {
                for (i = 0; i < a.length; i++) a[i] = Math.round((255 - d[i * 4]) * d[i * 4 + 3] / 255);
            } else if (clear) {
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
            return { w: c.width, h: c.height, alpha: a, rgb: rgb, opaque: !clear };
        });
        }

        var many = Array.isArray(bytes) ? bytes : [bytes];
        return Promise.all(many.map(_decode)).then(function (cells) {
            var pick = 'random';
            if (opts && opts.crop) {
                /* ...and each picture spans the ribbon whole: Zipper's lone
                 * tooth is as tall as its pair of halves, Bead chain's oval
                 * as its big bead. */
                cells = cells.map(function (c, i) { return _cropCell(c, many[i].real); });
                var ac = opts.crop === 'h' ? 'h' : 'w', top = 0;
                cells.forEach(function (c) { top = Math.max(top, c[ac]); });
                cells = cells.map(function (c) { return c[ac] === top ? c : _scaleCell(c, top / c[ac]); });
                /* A second ribbon in normal mode is drawn over the first, not
                 * through it: Zipper's upper row of teeth is its second
                 * picture (one row with the second brush off in Clip Studio),
                 * Braid's second strand too. Same size, so one picture. */
                if (opts.stack && cells.length === 2) {
                    var sc2 = document.createElement('canvas');
                    sc2.width = Math.max(cells[0].w, cells[1].w); sc2.height = Math.max(cells[0].h, cells[1].h);
                    var sg2 = sc2.getContext('2d');
                    cells.forEach(function (c) { sg2.drawImage(_canvasFromAlpha(c), 0, 0); });
                    cells = [_cellOf(sc2, cells[0].opaque)];
                }
                /* Laid in a fixed order, each picture takes its own length
                 * (Bead chain's oval is half its big bead's), so the round
                 * is joined into one picture: in turn, or out and back
                 * (order 1: big, diamond, oval, diamond). */
                if ((opts.join === 0 || opts.join === 1) && cells.length > 1) {
                    var seq = cells.slice();
                    if (opts.join === 1) seq = seq.concat(cells.slice(1, -1).reverse());
                    var along = ac === 'h' ? 'w' : 'h', len = 0;
                    seq.forEach(function (c) { len += c[along]; });
                    var jc = document.createElement('canvas');
                    jc.width = along === 'w' ? len : top; jc.height = along === 'w' ? top : len;
                    var jg = jc.getContext('2d'), at = 0;
                    seq.forEach(function (c) {
                        jg.drawImage(_canvasFromAlpha(c), along === 'w' ? at : 0, along === 'w' ? 0 : at);
                        at += c[along];
                    });
                    cells = [_cellOf(jc, cells[0].opaque)];
                }
                /* A long picture is cut into pieces laid in turn, so the
                 * stroke stops within a piece of the pen, as Clip Studio's
                 * does: Rough pen's one picture is 1000px long at size 10,
                 * and stamped whole it ran 100px past the end of a line. */
                var ln = ac === 'h' ? 'w' : 'h', one = cells[0], k = Math.round(one[ln] / (2 * one[ac]));
                /* The picture's own proportions, not the preview's: Chain's
                 * 4016x355 previews as 300x27, and its links came 1.8% short. */
                var rl = many.length === 1 && many[0].real, exact = null;
                if (rl && cells.length === 1) {
                    var ra = rl[ac === 'w' ? 0 : 1], rn = rl[ac === 'w' ? 1 : 0], ex = one[ac] * rn / ra / Math.max(1, k);
                    exact = ln === 'w' ? [ex, one.h] : [one.w, ex];
                }
                if (cells.length === 1 && k > 1) {
                    var pl = Math.ceil(one[ln] / k), src = _canvasFromAlpha(one);
                    cells = [];
                    for (var pi = 0; pi < k; pi++) {
                        var pc = document.createElement('canvas');
                        pc.width = ln === 'w' ? pl : one.w; pc.height = ln === 'w' ? one.h : pl;
                        // stretched a hair to k whole pieces, so the round has no gap
                        var sx = one[ln] / k, sgx = pc.getContext('2d');
                        if (ln === 'w') sgx.drawImage(src, pi * sx, 0, sx, one.h, 0, 0, pl, one.h);
                        else sgx.drawImage(src, 0, pi * sx, one.w, sx, 0, 0, one.w, pl);
                        cells.push(_cellOf(pc, one.opaque));
                    }
                    pick = 'cycle';
                }
            }
            /* Clip Studio's grey materials (Book, Building, Chain) are
             * pictures: stamped with black they show their own greys and
             * whites. A tip with no solid white is ink, its greys only how
             * dense it is (Crayon's soft grey blob, painted solid black).
             * A coloured picture paints its darkest channel as grey (Bead
             * chain's pink beads paint dark grey with black: ink 1.01 of
             * Clip Studio's, where brightness gave 0.82).
             * ponytail: Clip Studio tints the greys between the main and
             * sub colour; ours stamps them as they are, right for black. */
            var shaded = opts && opts.csp && cells.some(function (c) {
                var solid = 0, white = 0;
                for (var q = 0; q < c.alpha.length; q++) {
                    if (c.alpha[q] <= 127) continue;
                    solid++;
                    if (c.rgb[q * 3] + c.rgb[q * 3 + 1] + c.rgb[q * 3 + 2] > 600) white++;
                }
                return white > solid * 0.05;
            });
            if (shaded) cells.forEach(function (c) {
                for (var q = 0, g; q < c.alpha.length; q++) {
                    g = Math.min(c.rgb[q * 3], c.rgb[q * 3 + 1], c.rgb[q * 3 + 2]);
                    c.rgb[q * 3] = c.rgb[q * 3 + 1] = c.rgb[q * 3 + 2] = g;
                }
            });
            var st2 = _strip(cells);
            if (exact) { st2.w = exact[0]; st2.h = exact[1]; }
            return { url: st2.url, size: st2.size, w: st2.w, h: st2.h,
                     cells: cells.length, pick: pick, params: shaded ? { tipMode: 'color' } : _paper(cells) };
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

    /* GIMP's generated brushes, rebuilt from what GIMP 2.10 hands back for
     * them (test/gimp/mask-probe.mjs reads the masks it makes; nothing here
     * comes from GIMP's code). What the measurements say:
     *  - a pixel's value depends only on its distance from the centre in the
     *    brush's own frame: turned by the angle; for a star, its bearing
     *    folded into one spike's wedge centred on the axis; then y
     *    stretched by the aspect. Distance is the plain one for a circle, the larger of
     *    |x| and |y| for a square, |x| + |y| for a diamond;
     *  - that distance, over the radius, goes through one soft curve at
     *    Hardness 0, and Hardness h reads the curve at t^(1 / (1 - h));
     *  - four samples a quarter pixel apart along the distance are averaged,
     *    which is why a hard rim comes out at 64, 128 or 191. */
    // The Hardness 0 curve at sqrt(t) = 0, 1/16 .. 1, fitted to masks of
    // radius 20 and 60 at hardness 0 to 1: within a level of GIMP's.
    var GIMP_CURVE = [255, 250, 237, 220, 200, 176, 149, 119, 92, 69, 50, 34, 21, 12, 5, 1, 0];
    BrushPack.gimpCurve = function (t, hard) {
        if (!(t < 1)) return 0;
        if (hard >= 1) return 1;
        var u = Math.sqrt(Math.pow(t, 1 / (1 - hard))) * 16, i = Math.floor(u);
        return (GIMP_CURVE[i] + (GIMP_CURVE[i + 1] - GIMP_CURVE[i]) * (u - i)) / 255;
    };
    /* The mask's box: odd, each half the reach rounded half down. A round
     * one reaches as far as its turned ellipse, a square or diamond as its
     * turned corner, and a star as its spike tips in any direction. */
    function _vbrBox(shape, radius, spikes, aspect, angle) {
        var th = angle * Math.PI / 180, hx, hy;
        if (shape === 'circle' && spikes === 2) {
            hx = Math.hypot(radius * Math.cos(th), radius / aspect * Math.sin(th));
            hy = Math.hypot(radius * Math.sin(th), radius / aspect * Math.cos(th));
        } else {
            var d = Math.hypot(radius, radius / aspect), a = Math.atan(1 / aspect);
            hx = spikes > 2 ? d : d * Math.max(Math.abs(Math.cos(th + a)), Math.abs(Math.cos(th - a)));
            hy = spikes > 2 ? d : d * Math.max(Math.abs(Math.sin(th + a)), Math.abs(Math.sin(th - a)));
        }
        return { w: 2 * Math.ceil(hx - 0.5 - 1e-9) + 1, h: 2 * Math.ceil(hy - 0.5 - 1e-9) + 1 };
    }
    // The brush's own mask (as GIMP previews it) for `angle` in degrees.
    function _vbrMask(shape, radius, spikes, hard, aspect, angle) {
        var box = _vbrBox(shape, radius, spikes, aspect, angle), w = box.w, h = box.h;
        var alpha = new Uint8Array(w * h), cx = (w - 1) / 2, cy = (h - 1) / 2;
        var th = -angle * Math.PI / 180, c = Math.cos(th), s = Math.sin(th), wedge = 2 * Math.PI / spikes;
        for (var j = 0; j < h; j++) for (var i = 0; i < w; i++) {
            var x = i - cx, y = j - cy;
            var X = x * c + y * s, Y = y * c - x * s;
            if (spikes > 2) {
                var rho = Math.hypot(X, Y), b = Math.atan2(Y, X) + wedge / 2;
                b = b - Math.floor(b / wedge) * wedge - wedge / 2;
                X = rho * Math.cos(b); Y = rho * Math.sin(b);
            }
            Y *= aspect;
            var d = shape === 'square' ? Math.max(Math.abs(X), Math.abs(Y))
                : shape === 'diamond' ? Math.abs(X) + Math.abs(Y) : Math.hypot(X, Y);
            d = Math.round(d * 4) / 4;
            var v = 0;
            for (var k = 0; k < 4; k++) v += BrushPack.gimpCurve(Math.abs(d + (k - 1.5) / 4) / radius, hard);
            alpha[j * w + i] = Math.round(v / 4 * 255);
        }
        return { w: w, h: h, alpha: alpha };
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

        /* GIMP sizes the brush by its mask's box but spaces dabs by its
         * diameter at that scale. Measured headless (test/gimp/probe.mjs, 200%
         * spacing, dab centres): the step over the size was 50/51 for
         * Hardness 100, 11/11 for Circle (11), 50/55 for 2. Star, 28/29 and
         * 11/13 for the diagonal stars, at every size tried and along x and y
         * alike. Our spacing is a share of the size, so it takes that ratio. */
        var box = _vbrBox(shape, radius, spikes, aspect, -angle);
        var out = {
            size: Math.max(1, Math.min(1000, Math.round(radius * 2))),
            spacing: Math.max(1, Math.min(400, Math.round(spacing * 2 * radius / Math.max(box.w, box.h) * 10) / 10)),
            opacity: 100, flow: 100,
            hardness: Math.round(hard * 100),
            shape: 'circle'
        };
        /* A plain round one needs no picture: that is the brush we already
         * are, and keeping it parametric means it stays sharp at any size. */
        if (shape === 'circle' && spikes === 2 && aspect === 1) {
            out.falloff = 'gimp';
            if (angle) out.angle = ((Math.round(angle) % 360) + 360) % 360;
            return { name: name, params: out, tip: null };
        }
        var lim = Math.min(TIP_CAP_PX / 2, 400);
        /* Minus the angle: the dab GIMP paints is turned the other way from
         * the brush's own preview. Measured headless. */
        var m = _vbrMask(shape, Math.min(lim, radius), spikes, hard, aspect, -angle);
        var st = _strip([m]);
        out.shape = 'custom';
        // The tip is sized by its longest side, and GIMP's box is a little
        // over 2 x radius -- take the box, so a dab is GIMP's size exactly.
        if (radius <= lim) out.size = Math.max(m.w, m.h);
        /* The picture already carries the softness the file asked for, so
         * the dab must not be softened a second time on the way out. */
        out.hardness = 100;
        return { name: name, params: out,
                 tip: { url: st.url, size: st.size, cells: 1, pick: 'random' } };
    };

    /* ── MyPaint brushes (.myb) ───────────────────────────────────────── */

    /* MyPaint paints with no tip image at all: every mark is a soft round
     * dab and the character comes from some sixty settings, each of which can
     * be driven by pressure, speed, direction or randomness. The engine has a
     * port of libmypaint (krita-brush-engine.js, _paintMyPaint), so the whole
     * brush is handed over as it stands and painted as MyPaint and Krita do.
     *
     * Two file shapes: newer ones are JSON, older ones a line per setting
     * reading `name value | input (x,y), (x,y)`. Both say the same things. */

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
        /* The engine paints from the settings alone; the rest only gives the
         * panel and the cursor something true to show. */
        var out = { engineKind: 'mypaint', mypaint: { settings: set }, shape: 'circle', opacity: 100 };
        // MyPaint stores the log of the dab RADIUS in pixels.
        out.size = Math.max(1, Math.min(800, Math.round(200 * Math.exp(base('radius_logarithmic', 2))) / 100));
        out.hardness = Math.round(Math.max(0, Math.min(1, base('hardness', 0.8))) * 100);
        var ratio = base('elliptical_dab_ratio', 1);
        if (ratio > 1) {
            out.aspectRatio = Math.round(Math.min(20, ratio) * 100) / 100;
            var ang = base('elliptical_dab_angle', 0);   // a round dab still carries 90 in the file
            if (ang) out.angle = Math.round(ang) % 360;
        }
        if (base('eraser', 0) > 0.5) out.blendMode = 'erase';

        /* `comment` is the format's own banner line -- every file carries the
         * same "MyPaint brush file" -- so the brush's name is its description,
         * and failing that the file it came in. */
        var title = (obj && obj.description && String(obj.description).trim()) || name || 'MyPaint brush';
        return { name: String(title).slice(0, 40), params: out, tipFile: null, warnings: [] };
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

    /* How a dial answers the pen, as Clip Studio stores it ("effector").
     *
     * Read off the 1,790 effectors in Clip Studio 5's own 106 brushes, every
     * one of them this shape, and the input bits checked by importing edited
     * copies into Clip Studio and painting with them:
     *
     *   u32 48            header length
     *   u32 0xf0/0x1f0    which inputs the dial offers
     *   u32 mask          which are on: 0x10 pressure, 0x20 tilt, 0x40 speed,
     *                     0x80 random (0x100 is offered, never seen on)
     *   u32 x5            each input's floor, percent, in bit order
     *   u32 len 0x10, u32 len 0x20, u32 (a speed setting), u32 len 0x40
     *   then those curve records back to back: [12][point count][16] and the
     *   points as big-endian double pairs. Random has no curve.
     *
     * An input drives the dial from its floor up: floor + (1 - floor) *
     * curve(input), and the inputs multiply. Speed runs 0 at rest, as ours
     * does; Milli pen's curve falls from 1 there to its floor, and
     * a Milli pen stroke drawn slowly in Clip Studio came out 98% wide, at
     * 0.73 px/ms 93% and at 2.6 px/ms 81%, against its 60% floor.
     * Tilt is how upright the pen stands (our elevation), not how far it
     * leans: Charcoal's flow curve is 0 at 0, and Clip Studio draws it at
     * full ink with a mouse, which it holds upright. */
    var SUT_BITS = [[0x10, 'pressure'], [0x20, 'elevation'], [0x40, 'speed'], [0x80, 'random']];

    function _sutEffector(blob) {
        if (!blob || blob.length < 48) return null;
        var b = (blob instanceof Uint8Array) ? blob : new Uint8Array(blob);
        var r = _rd(b);
        if (r.u32() !== 48) return null;
        r.skip(4);
        var mask = r.u32(), floors = [r.i32(), r.i32(), r.i32(), r.i32(), r.i32()];
        var lens = [r.i32(), r.i32(), r.i32(), r.i32()];
        var clen = { 0x10: lens[0], 0x20: lens[1], 0x40: lens[3] };
        if (48 + lens[0] + lens[1] + lens[3] !== b.length) return null;
        var at = 48, curves = {}, i, j;
        for (i = 0; i < 3; i++) {
            var bit = [0x10, 0x20, 0x40][i], len = clen[bit];
            if (len >= 12) {
                var c = _rd(b);
                c.p = at;
                if (c.u32() !== 12) return null;
                var n = c.u32();
                if (c.u32() !== 16 || 12 + n * 16 !== len) return null;
                var pts = [];
                for (j = 0; j < n; j++) {
                    pts.push([Math.max(0, Math.min(1, c.f64())),
                              Math.max(0, Math.min(1, c.f64()))]);
                }
                curves[bit] = pts;
            }
            at += len;
        }
        var inputs = [];
        for (i = 0; i < SUT_BITS.length; i++) {
            var bt = SUT_BITS[i][0];
            if (!(mask & bt)) continue;
            var curve = curves[bt] || [[0, 0], [1, 1]];
            inputs.push({ src: SUT_BITS[i][1], floor: Math.max(0, Math.min(100, floors[i])), raw: floors[i], curve: curve });
        }
        return { inputs: inputs, unknown: !!(mask & ~0xf0) };
    }

    /* One dial. A single input keeps the editable Src/Min/Curve form (our
     * floor-then-curve is Clip Studio's exactly); several become a list that
     * multiplies, each curve with its own floor folded in. No input at all
     * is written down as none, so the pressure default underneath does not
     * reach a dial Clip Studio holds still. */
    function _sutDrive(out, key, blob, warn, what) {
        var e = _sutEffector(blob);
        if (!e) return false;
        if (e.unknown) warn.push('dropped: an unknown rule that changes ' + what + ' as you draw');
        var ins = e.inputs;
        if (!ins.length) { out[key + 'Src'] = 'none'; return true; }
        if (ins.length === 1) {
            out[key + 'Src'] = ins[0].src;
            out[key + 'Curve'] = ins[0].curve;
            out[key + 'Min'] = ins[0].floor;
        } else {
            out[key + 'Src'] = 'none';
            out[key + 'Min'] = 0;
            out[key + 'Combine'] = 0;
            out[key + 'Sensors'] = ins.map(function (s) {
                var f = s.floor / 100;
                return { src: s.src, curve: s.curve.map(function (q) { return [q[0], f + (1 - f) * q[1]]; }) };
            });
        }
        /* Clip Studio's speed is how far the pen moved since its last report,
         * over 97.5px -- not over time: a stroke posted in 70 moves reads
         * 0.117 whether it takes 0.3s or 3s, and 20, 35, 100, 200, 400 and
         * 800 moves read 40, 22.9, 8, 4, 2 and 1px / 97.5 within 0.002, at
         * brush sizes 40 and 80 alike. Ours is px/ms.
         * ponytail: taken at a pen reporting every 7.5ms (133Hz); a faster
         * one reads slower in Clip Studio than here. */
        if (ins.some(function (s) { return s.src === 'speed'; })) out.speedMax = 13;
        return true;
    }

    /* Clip Studio's colour change per dab, measured on a round tip painted
     * with green (v 0.63, s 0.78): each dab lands evenly between x + f*c and
     * x + c, both ends cut at 0 and 1, where c is the signed change and f
     * the random input's floor. Value +20 with floor -100 ran 0.43..0.83,
     * floor 0 0.63..0.83, floor -10 at +100 0.53..1 (no pile-up at 1),
     * -50 with floor 0 0.13..0.63; hue 15 at floor -100 +-15 degrees. With
     * no random input every dab takes the whole change (+30: 0.93 flat).
     * Ours keeps the dial at |c| and hands [lo, hi] in units of it.
     * ponytail: a pressure input is taken at full pressure, as measured. */
    function _sutJitter(out, hue, sat, val, effs) {
        var c = [Math.max(-180, Math.min(180, _sutNum(hue, 0))),
                 Math.max(-100, Math.min(100, _sutNum(sat, 0))),
                 Math.max(-100, Math.min(100, _sutNum(val, 0)))];
        if (!c[0] && !c[1] && !c[2]) return false;
        if (c[0]) out.hueJitter = Math.round(Math.abs(c[0]));
        if (c[1]) out.satJitter = Math.round(Math.abs(c[1]));
        if (c[2]) out.valJitter = Math.round(Math.abs(c[2]));
        if (effs) out.colorJitterRange = c.map(function (ch, i) {
            var e = _sutEffector(effs[i]), rnd = e && e.inputs.filter(function (q) { return q.src === 'random'; })[0];
            var f = !e ? -1 : rnd ? rnd.raw / 100 : 1;   // none at all: Clip Studio's stock random, floor -100
            return ch < 0 ? [-1, -f] : [f, 1];
        });
        return true;
    }

    /* Clip Studio's second brush is a whole brush of its own: every Dual
     * column is the same setting as its Brush (or bare) twin, so it is read
     * by sutToPreset like any brush. Measured in Clip Studio on round tips
     * (cdp-csp/dm*): modes 0, 1 and 4 lay it over the first, a 0.3 dab on a
     * 0.3 one making 0.51; mode 12 cuts it out of the first by its alpha,
     * 0.3 leaving 0.21. Modes 2 (adds its colour), 3 (inverts) and 11
     * (burns) change the colour only and move no ink; those return null. */
    var SUT_SECOND_OP = { 0: 'destination-over', 1: 'destination-over', 4: 'destination-over', 12: 'destination-out' };
    BrushPack.sutSecond = function (v) {
        var op = _sutNum(v.UseDualBrush, 0) && SUT_SECOND_OP[_sutNum(v.DualBrushCompositeMode, 0)];
        if (!op) return null;
        var v2 = {}, k;
        for (k in v) v2[k] = v[k];
        for (k in v) {
            if (k.indexOf('Dual') !== 0) continue;
            var x = k.slice(4);
            if (('Brush' + x) in v) v2['Brush' + x] = v[k];
            else if (x in v) v2[x] = v[k];
        }
        // It has no second brush, mixing or colour change of its own.
        v2.UseDualBrush = 0; v2.BrushUseWaterColor = 0; v2.BrushChangePatternColor = 0;
        return { op: op, variant: v2 };
    };

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

        /* Size may be in centimetres (unit 1) or millimetres (2). Milli pen
         * set to 1 of each painted 96px and 9.6px wide in Clip Studio.
         * ponytail: that is the reference canvas's resolution (about 244
         * dpi); ours has none, so every mm brush takes that one. */
        var size = _sutNum(v.BrushSize, 20) * ({ 1: 96, 2: 9.6 }[_sutNum(v.BrushSizeUnit, 0)] || 1);
        out.size = Math.max(1, Math.min(1000, Math.round(size * 10) / 10));
        out.shape = opts.hasTip ? 'custom' : 'circle';
        out.opacity = Math.max(1, Math.min(100, Math.round(_sutNum(v.Opacity, 100))));
        out.flow = Math.max(1, Math.min(100, Math.round(_sutNum(v.BrushFlow, 100))));
        /* Blend mode 27 (Watery brush) lays nothing on an empty layer and
         * thins a black line it crosses to a third, in place, never dragging
         * it: an eraser at the brush's opacity.
         * ponytail: its soft falloff is not ours yet -- ours clears a flat band. */
        if (_sutNum(v.CompositeMode, 0) === 27) out.blendMode = 'erase';
        out.hardness = Math.max(0, Math.min(100, Math.round(_sutNum(v.BrushHardness, 80))));
        /* Spacing mode 0 is Clip Studio's fixed interval; 1-3 (wide, normal,
         * narrow) ignore it. Faint round strokes at sizes 20-200 measured
         * 12, 8 and 4% of the size in those modes, whatever the interval. */
        /* Never closer than a pixel: 1% of 20 and 4% of 20 paint the same
         * stroke, and a spray of 6px specks at 8% laid 775 over 800px --
         * one a pixel, where 0.48px would lay 1667. */
        out.minStep = 1;
        var ivt = _sutNum(v.BrushAutoIntervalType, 0);
        /* ...and a fixed interval is a share of the size whatever the tip's
         * shape: Droplet's 200x300 picture at size 20 and 300% lays a speck
         * every 60px (spaced by its 13px width ours laid one every 40), and
         * Chalk's picture squeezed to half at 40 and 300% one every 120. So
         * does an auto one on a generated tip; on a picture it follows the
         * squeezed width (Chalk at thickness 50 lays half again the ink). */
        out.spacingIsotropic = !(opts.hasTip && ivt >= 1 && ivt <= 3);
        out.spacing = ivt >= 1 && ivt <= 3 ? [12, 8, 4][ivt - 1]
            : Math.max(1, Math.min(400, Math.round(_sutNum(v.BrushInterval, 10))));
        /* ...and those three open up as a round tip softens: 1 + 2 x its
         * softness times as far (soft lines at hardness 0, 50 and 80, sizes
         * 10-80, fit 3, 2 and 1.4 times). A fixed interval stays put. */
        if (ivt >= 1 && ivt <= 3 && !opts.hasTip)
            out.spacing = Math.round(out.spacing * (3 - 2 * Math.min(100, _sutNum(v.BrushHardness, 100)) / 100) * 10) / 10;
        /* "Adjust density by interval": each dab lays flow x spacing / 35.36
         * (25 root 2), never more than the flow -- round strokes at flow 50
         * and 10, spacing 5-40, all fit it within a percent of alpha. */
        if (_sutNum(v.BrushAdjustFlowByInterval, 0))
            out.flow = Math.max(1, Math.round(out.flow * Math.min(1, out.spacing / 35.36)));

        /* Thickness is how wide the tip stays, as a percentage; ours is how
         * many times longer than wide it is. 16% thick is a blade six times
         * longer than it is across. */
        var thick = _sutNum(v.BrushThickness, 100);
        /* BrushVerticalThicknes 1 squeezes top to bottom, 0 side to side:
         * Real G-Pen's 107x133 picture (1) at size 200 is one 160x200 dab,
         * 160x170 at thickness 85 and 160x100 at 50, measured in Clip
         * Studio. Ours squashes height above 1 and width below it. */
        var vert = _sutNum(v.BrushVerticalThicknes, 0);
        if (thick > 0 && thick < 99)
            out.aspectRatio = vert || !opts.hasTip ? Math.min(10, Math.max(1, Math.round(100 / thick * 100) / 100))
                : Math.max(0.1, Math.round(thick) / 100);

        /* A thin generated tip stands upright there at 0 and lies flat here:
         * Flat marker (thickness 30, turned 90) is 16px across a level stroke
         * in Clip Studio, and was 50 here until turned the extra quarter. */
        /* A spray's particles turn by their own columns: Pointillism
         * (rotation 45 at random, in spray 90 following the line) lays every
         * particle along a 23-degree stroke in Clip Studio, and the same with
         * rotation 0; without the in-spray bit 64 they lie level. */
        var spraying = _sutNum(v.BrushUseSpray, 0) && size > 0 && _sutNum(v.BrushSpraySize, 0) > 0;
        var rk = spraying && 'BrushRotationInSpray' in v ? 'InSpray' : '';   // older files have none
        var rot = _sutNum(v['BrushRotation' + rk], 0) + (out.aspectRatio > 1 && !vert && !opts.hasTip ? 90 : 0);
        if (rot % 360) out.angle = Math.round(rot) % 360;
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
        var reff = _sutNum(v['BrushRotationEffector' + rk], 0), rdir = rk ? 64 : 32;
        var rrand = Math.min(180, Math.round(_sutNum(v[rk ? 'BrushRotationRandomInSpray' : 'BrushRotationRandomScale'], 100) * 1.8));
        if (reff & 128 && rrand > 0) {
            out.angleSrc = 'random';
            out.angleRange = rrand;
        } else if (reff & rdir) {
            out.angleSrc = 'direction';
        }
        if (reff & ~(131 | rdir)) {
            warn.push('dropped: the rule that turns its tip as you draw');
        }

        /* A spraying brush's size is the patch it sprays over and its spray
         * size is each particle: Clip Studio's Spray (size 200, particles 5)
         * is a haze of specks, and Wet blotting ink (size 30, particles 115)
         * a band 139px tall -- 30 of patch plus a particle either side. Ours
         * is the particle, scattered up to half the patch from the line. */
        if (spraying) {
            var spray = _sutNum(v.BrushSpraySize, 0) * ({ 1: 96, 2: 9.6 }[_sutNum(v.BrushSpraySizeUnit, 0)] || 1);
            out.size = Math.max(1, Math.round(spray));
            out.scatter = Math.max(1, Math.round(size / 2 / out.size * 100));
            out.scatterAxis = 'disk';
            out.sprayEach = true;
            out.dabCount = Math.max(1, Math.min(16, Math.round(_sutNum(v.BrushSprayDensity, 1))));
            var bias = Math.max(-100, Math.min(100, Math.round(_sutNum(v.BrushSprayBias, 0))));
            if (bias) out.sprayBias = bias;
        }

        /* A ribbon lays its picture end to end along the stroke, turned so
         * the picture's width runs across it at the brush size (Zipper's
         * teeth stand up off a level stroke; Chain, turned 90, lies along
         * it), blank margins and all (tipStrip cuts the preview back to the
         * real picture's shape). Ours is the same stamp, following the
         * stroke and spaced by its own length (100: the engine spaces a long
         * tip by its extent along the stroke), the first one starting at
         * the stroke's start as Clip Studio's does.
         * ponytail: rigid stamps, so a ribbon round a bend shows seams, and
         * a turn other than 0 or 90 is taken as the nearer of them (unmeasured past 1). */
        if (_sutNum(v.BrushRibbon, 0) && opts.hasTip && opts.tipW && opts.tipH) {
            var rr = _sutNum(v.BrushRotation, 0), side = Math.round(rr / 90) % 2 !== 0;
            var across = side ? opts.tipH : opts.tipW;
            // to a hundredth: Waved line's 10 x 300/117 is 25.64, and 26 drifted a wave in 20
            out.size = Math.max(1, Math.min(5000, Math.round(100 * size * Math.max(opts.tipW, opts.tipH) / across) / 100));
            out.spacing = 100;
            out.spacingIsotropic = false;
            // The first picture starts at the stroke's start, not centred on it (Dashed line's first dash 3.5px in).
            out.offsetAlong = Math.round(50 * (side ? opts.tipW : opts.tipH) / Math.max(opts.tipW, opts.tipH));
            // straight along or across: Bumpy's turn of 1 lays level there (near at 270, off at 271)
            out.angle = ((Math.round(rr / 90) * 90 - 90) % 360 + 360) % 360;
            out.angleSrc = 'direction';
            delete out.angleRange;
            out.ribbonClip = true;
        }
        /* Several pictures: 0 takes them in turn (Zipper's teeth alternate),
         * 3 at random (Book). A ribbon's fixed order is joined into one
         * picture instead (tipStrip's join). */
        if (_sutNum(v.BrushPatternOrderType, 3) === 0) out.tipPick = 'cycle';

        /* Starting and ending is NOT a taper here. Real Clip Studio 5 draws
         * a mouse stroke of G-pen, Calligraphy or Mapping pen (all UseIn/
         * UseOut on) at full width to both ends, fast or slow; mapping it to
         * our taper shrank them to a lens over 30% of the line each side.
         * ponytail: what it does under a pen cannot be measured here (no pen
         * input reaches a hidden desktop), so it is named, not guessed. */
        if (_sutNum(v.BrushUseIn, 0) || _sutNum(v.BrushUseOut, 0)) {
            warn.push('dropped: its pen taper at the start and end of a stroke');
        }

        if (opts.hasTexture) {
            var dens = _sutNum(v.TextureDensity, 0);
            var tm = Math.round(_sutNum(v.TextureCompositeMode, 1)), perDab = _sutNum(v.TextureForPlot, 0) && tm >= 0 && tm <= 7;
            if (dens > 0 && perDab) {
                /* Paper on each dab (TextureForPlot): the blend is Clip
                 * Studio's own, measured dab by dab -- see _cspPaper. */
                out.texture = Math.min(100, Math.round(dens));
                out.textureBlend = tm;
            } else if (dens > 0) {
                /* Paper on the whole stroke. How much the paper shows depends on how it is blended,
                 * measured in Clip Studio on one plain dab with Pastel's
                 * paper at each mode: subtract (2) at half density matched
                 * multiply (1) pixel for pixel; 3 showed a sixth as much, 4
                 * and 5 a twentieth; 0 and 6 no grain at all (they darken
                 * flat). ponytail: one strength per mode, measured at 80%
                 * alpha; the compare-like modes surely read the dab's own
                 * alpha, so a faint dab would show more grain. */
                var tk = { 0: 0, 1: 1, 2: 2, 3: 0.17, 4: 0.05, 5: 0.05, 6: 0 }[_sutNum(v.TextureCompositeMode, 1)];
                out.texture = Math.max(0, Math.min(100, Math.round(dens * (tk === undefined ? 1 : tk))));
                if (!out.texture) delete out.texture;
            }
            if (dens > 0) {
                /* Its strength has its own rule, dab by dab: Chalk's takes a
                 * random 40-100% of it, which is why its grain barely shows
                 * in Clip Studio's stroke (full paper: 225 -> 200 at the
                 * core, Clip Studio 222). */
                _sutDrive(out, 'texture', v.TextureDensityEffector, warn, 'its paper texture');
                /* TextureScale2 is a PERCENTAGE of the paper's natural size,
                 * where 100 means "leave it alone" -- checked against Clip
                 * Studio's own stock tool database rather than guessed: of
                 * the ~140 stock tools that set it, the large majority sit at
                 * exactly 100.0, and the ones that move off it are the
                 * grainy brushes (Flat watercolor brush 28, Pastel 45, Crayon
                 * 80, Dry ink 112). /12.5 is that percentage rescaled onto
                 * our 1..16 dial, anchoring 100 at 8.
                 *
                 * Deliberately NOT rounded to an integer, and no floor of 1.
                 * Both were here and both silently mangled real brushes: this
                 * brush's 28 became 2 instead of 2.24, losing 11% of the
                 * grain size, and every tool at 10 or 15 (Soft, Pencil, Wet
                 * wash) was clamped up to 1 from 0.8 and 1.2. The dial takes
                 * a float -- see _TEX_GRAIN_SCALE in krita-brush-engine.js,
                 * which multiplies it -- and the slider's step is 0.5, so
                 * nothing downstream ever wanted an integer. */
                var ts = _sutNum(v.TextureScale2, 0);
                if (ts > 0) out.textureScale = Math.max(0.1, Math.min(16, ts / 12.5));
                /* The density, scale and paper picture come over; how Clip
                 * Studio blends and distorts that paper has no equivalent
                 * here, so each active modifier is named. */
                if (_sutNum(v.TextureCompositeMode, 1) !== 1 && !perDab)
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
            /* No paint of its own but a density under 100 is still mixing:
             * Gouache blender (0 and 0) lays only what it carries, so nothing
             * on an empty layer, and lightens a black line it crosses. */
            if (mix > 0 || (_sutNum(v.BrushUseWaterColor, 0) && _sutNum(v.BrushMixAlpha, 100) < 100)) {
                /* Measured in Clip Studio (Round mixing brush): a white
                 * stroke across a black one covers it and drags a little grey
                 * on after, so a dab replaces what is under it and picks some
                 * colour up. That pick-up (amount of paint) is not mapped:
                 * our smudge deposits colorRate% brush plus the canvas, and
                 * on a fresh CDPaint document -- opaque white PIXELS, where
                 * Clip Studio's white is a Paper layer mixing cannot read --
                 * it drank the white into every dab. Named as dropped. */
                warn.push('dropped: the way it mixes with colour already on the canvas');
                /* Density of paint (BrushMixAlpha) is the part that is
                 * measured (Round mixing brush in Clip Studio, one setting at
                 * a time): the engine's mixAlpha rule. At 100 Clip Studio's
                 * line is the same solid line as with mixing off, so that
                 * paints as a plain brush and keeps its paper grain. Only
                 * for colour mixing (BrushUseWaterColor): the watercolour
                 * kind (BrushWaterColor alone) is unmeasured and keeps the
                 * wash -- given this rule, Rough wash fell near -> off. */
                var ma = v.BrushMixAlpha == null || !(_sutNum(v.BrushUseWaterColor, 0) || _sutNum(v.BrushUseWaterColor2, 0))
                    ? null : Math.max(0, Math.min(100, _sutNum(v.BrushMixAlpha, 100)));
                if (ma != null) {
                    if (ma < 100) {
                        out.mixAlpha = ma;
                        out.mixStretch = Math.max(0, Math.min(100, _sutNum(v.BrushMixColorExtension, 0)));
                    }
                } else {
                    /* Older files carry no density; for those the wash stays:
                     * translucent pigment even at high flow, and wet blend so
                     * one stroke cannot darken itself where it overlaps (W1). */
                    out.watercolor = 1;
                    out.wetBlend = 1;
                }
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

        /* Nothing drives a dial unless its effector says so; our engine's
         * own default is pressure. Opacity rides on flow when flow is still. */
        out.sizeSrc = out.flowSrc = 'none';
        /* ponytail: sprayed, the patch rides on scatter and the particle on
         * size, and our scatter is a share of the size, so a pen driving
         * both counts twice on the patch. */
        _sutDrive(out, spraying ? 'scatter' : 'size', v.BrushSizeEffector, warn, 'its size');
        _sutDrive(out, 'flow', v.BrushFlowEffector, warn, 'its flow');
        if (out.flowSrc === 'none' && !out.flowSensors) {
            _sutDrive(out, 'flow', v.BrushOpacityEffector, warn, 'its opacity');
        }
        if (spraying) _sutDrive(out, 'size', v.BrushSpraySizeEffector, warn, 'its spray');
        /* The interval and the spray's density take effectors too: Trees'
         * random interval (floor 50) laid trees 196-284px apart at 300% of
         * 100, never further than the interval. */
        if (!spraying) _sutDrive(out, 'spacing', v.BrushIntervalEffector, warn, 'its spacing');
        /* A thickness effector only thins (factor floor..1): Droplet's random
         * one at floor 50 took a quarter off its ink. Ours divides the aspect
         * by it, which thins too -- but a tip already squeezed side to side
         * (aspect under 1) would round off instead, so that one is left. */
        if (spraying && (out.aspectRatio || 1) >= 1) _sutDrive(out, 'aspectRatio', v.BrushThicknessEffector, warn, 'its thickness');
        if (spraying) _sutDrive(out, 'dabCount', v.BrushSprayDensityEffector, warn, 'its spray density');

        /* Colour that wanders. Clip Studio sets a range either side of the
         * colour -- hue in degrees, the other two as percentages -- and
         * offers the same three again for a whole stroke at a time. Ours is
         * one set with a switch, so per dab wins and the other is named.
         * BrushChangePatternColor switches the per-dab change on (0: the
         * same settings paint flat), and BrushChangeColorTarget says what it
         * changes: 0 and 1 the main colour, 2 only the sub colour (Rubble's
         * rock fills), which ours does not paint. */
        var target = _sutNum(v.BrushChangeColorTarget, 1);
        var dabJit = _sutNum(v.BrushChangePatternColor, 1) && target !== 2 &&
            _sutJitter(out, v.BrushHueChange, v.BrushSaturationChange, v.BrushValueChange,
                       [v.BrushHueChangeEffector, v.BrushSaturationChangeEffector, v.BrushValueChangeEffector]);
        if (_sutNum(v.BrushChangePatternColor, 1) && target === 2 &&
            (_sutNum(v.BrushHueChange, 0) || _sutNum(v.BrushSaturationChange, 0) || _sutNum(v.BrushValueChange, 0))) {
            warn.push('dropped: colour changes to its sub colour');
        }
        if (!dabJit && _sutNum(v.BrushChangeStrokeColor, 0) &&
            _sutJitter(out, v.BrushStrokeHueChange, v.BrushStrokeSaturationChange,
                       v.BrushStrokeValueChange)) {
            out.colorJitterPer = 'stroke';
        }

        /* The second brush is painted by the engine as a stroke of its own
         * (sutSecond). One that only shifts colour is named; carving the
         * first with it, as we used to, is what none of its modes do. */
        if (_sutNum(v.UseDualBrush, 0) && !BrushPack.sutSecond(v)) {
            warn.push([2, 3, 11].indexOf(_sutNum(v.DualBrushCompositeMode, 0)) >= 0
                ? 'dropped: the colour its second brush blends in' : 'dropped: its second brush tip');
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
            if (noted[i][0] === 'UseDualBrush') continue;
            if (noted[i][0] === 'BrushRibbon' && opts.hasTip && opts.tipW && opts.tipH) continue;
            if (_sutNum(v[noted[i][0]], 0)) {
                var msg = 'dropped: ' + noted[i][1];
                if (warn.indexOf(msg) === -1) warn.push(msg);
            }
        }

        /* Anti-aliasing off: every pixel ink or paper (Clip Studio draws the
         * hatching tones, G-pen and Black soot so). Not where the greys are
         * colour -- paper grain, mixing or a colour change leave Gouache,
         * Pastel and the flowers grey there with it off too.
         * ponytail: Noise, whose soft tip keeps its greys there, is dithered
         * here; a thumbnail cannot tell its tip from a hatch's. */
        if (_sutNum(v.AntiAlias, 1) === 0 && !out.texture && !out.watercolor &&
            !_sutNum(v.BrushChangePatternColor, 0) &&
            // a soft round tip keeps its greys: hardness 50 with it off or on, the same dab
            (opts.hasTip || _sutNum(v.BrushHardness, 100) >= 100)) out.aliased = true;
        /* On, it fades a round dab's rim over AA + 0.5 px at every size (a
         * 20px G-pen line's edge 163/111/84 at levels 1/2/3): a 5px spray
         * speck at level 2 carries a third of a hard disc's ink. */
        var aa = _sutNum(v.AntiAlias, 1);
        if (aa >= 0 && aa <= 3) out.edgeRamp = aa ? aa + 0.5 : 0.01;

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
        var pngs = rows.map(function (m) {
            var png = _lastPng(m.FileData), f = m.FileData;
            // The first picture is the real one: its pixels are often blank, its size still true.
            for (var at = 0; png && at + 24 <= f.length; at++) {
                if (f[at] !== 0x89 || f[at + 1] !== 0x50 || f[at + 2] !== 0x4E || f[at + 3] !== 0x47) continue;
                var rd = function (o) { return (f[o] << 24 | f[o + 1] << 16 | f[o + 2] << 8 | f[o + 3]) >>> 0; };
                png.real = [rd(at + 16), rd(at + 20)];
                break;
            }
            return png;
        });
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
                tips2: tip2 ? got.DualPatternImageArray : [],
                texture: got.TextureImage[0] || null
            }],
            warnings: warnings
        };
    };

    window.BrushPack = BrushPack;
})();
