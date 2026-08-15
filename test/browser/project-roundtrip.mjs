/* Opening a pokeemerald asset and saving it without an edit must change nothing.
 *
 * That is the whole contract. Gen 3 art is index data with a palette attached, so
 * a save that reconstructs indices from RGB loses information the file was carrying:
 * transparency collapses onto whatever colour is nearest to black, and two palette
 * slots that happen to share an RGB collapse onto each other — which silently
 * rewrites the *shiny* sprite, since those two slots differ there.
 *
 * The fixtures are hand-built rather than downloaded so the suite runs offline and
 * deterministically, but every shape and quirk below is taken from real files:
 * 4bpp with tRNS on slot 0 (front/back/icon), 1bpp two-colour (footprint), 8bpp,
 * no-tRNS tilesets, and Magikarp's duplicate slots 11 and 14.
 */
import { withPage } from '../browser.mjs';
import { deflateSync, inflateSync } from 'zlib';

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

/* ── PNG fixture builder ───────────────────────────────────────────────── */

const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return (buf) => {
        let c = -1;
        for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
        return (c ^ -1) >>> 0;
    };
})();

function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
    return Buffer.concat([len, body, crc]);
}

/* Build an indexed PNG. `filter` picks the row filter so the decoder's unfilter
   paths get exercised, not just filter 0. */
function makePng({ w, h, depth, palette, trns, indices, filter = 0 }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = depth; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const plte = Buffer.alloc(palette.length * 3);
    palette.forEach((c, i) => { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; });

    const rowBytes = Math.ceil((w * depth) / 8);
    const packed = Buffer.alloc(h * rowBytes);
    const perByte = 8 / depth;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = indices[y * w + x] & ((1 << depth) - 1);
            if (depth === 8) packed[y * rowBytes + x] = idx;
            else packed[y * rowBytes + ((x / perByte) | 0)] |= idx << (8 - depth - (x % perByte) * depth);
        }
    }
    // Apply the chosen filter (only 0/1/2 are generated; that plus 3/4 decode paths
    // are all covered because real PNG encoders emit the lot).
    const raw = Buffer.alloc(h * (rowBytes + 1));
    for (let y = 0; y < h; y++) {
        raw[y * (rowBytes + 1)] = filter;
        for (let x = 0; x < rowBytes; x++) {
            const cur = packed[y * rowBytes + x];
            const a = x >= 1 ? packed[y * rowBytes + x - 1] : 0;
            const b = y > 0 ? packed[(y - 1) * rowBytes + x] : 0;
            const v = filter === 1 ? cur - a : filter === 2 ? cur - b : cur;
            raw[y * (rowBytes + 1) + 1 + x] = v & 0xff;
        }
    }

    const parts = [
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('PLTE', plte)
    ];
    if (trns) parts.push(chunk('tRNS', Buffer.from(trns)));
    parts.push(chunk('IDAT', deflateSync(raw)));
    parts.push(chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}

/* Read an indexed PNG back: palette, tRNS and the true per-pixel indices. */
function readPng(bytes) {
    const b = Buffer.from(bytes);
    let pos = 8, w = 0, h = 0, depth = 0, palette = [], trns = null;
    const idat = [];
    while (pos + 8 <= b.length) {
        const len = b.readUInt32BE(pos);
        const type = b.toString('ascii', pos + 4, pos + 8);
        const s = pos + 8;
        if (type === 'IHDR') { w = b.readUInt32BE(s); h = b.readUInt32BE(s + 4); depth = b[s + 8]; }
        else if (type === 'PLTE') for (let i = 0; i < len; i += 3) palette.push([b[s + i], b[s + i + 1], b[s + i + 2]]);
        else if (type === 'tRNS') trns = Array.from(b.subarray(s, s + len));
        else if (type === 'IDAT') idat.push(b.subarray(s, s + len));
        else if (type === 'IEND') break;
        pos = s + len + 4;
    }
    const raw = inflateSync(Buffer.concat(idat));
    const rowBytes = Math.ceil((w * depth) / 8);
    const flat = Buffer.alloc(h * rowBytes);
    for (let y = 0; y < h; y++) {
        const ft = raw[y * (rowBytes + 1)];
        for (let x = 0; x < rowBytes; x++) {
            const a = x >= 1 ? flat[y * rowBytes + x - 1] : 0;
            const bb = y > 0 ? flat[(y - 1) * rowBytes + x] : 0;
            const c = (x >= 1 && y > 0) ? flat[(y - 1) * rowBytes + x - 1] : 0;
            let v = raw[y * (rowBytes + 1) + 1 + x];
            if (ft === 1) v += a;
            else if (ft === 2) v += bb;
            else if (ft === 3) v += (a + bb) >> 1;
            else if (ft === 4) {
                const p = a + bb - c, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
            }
            flat[y * rowBytes + x] = v & 0xff;
        }
    }
    const indices = new Uint8Array(w * h);
    const perByte = 8 / depth, mask = (1 << depth) - 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        indices[y * w + x] = depth === 8
            ? flat[y * rowBytes + x]
            : (flat[y * rowBytes + ((x / perByte) | 0)] >> (8 - depth - (x % perByte) * depth)) & mask;
    }
    return { w, h, depth, palette, trns, indices };
}

/* ── Fixtures ──────────────────────────────────────────────────────────── */

// Magikarp's real palettes. Slots 11 and 14 are the same red in normal and two
// different golds in shiny — the case nearest-colour matching cannot survive.
const MAGIKARP_NORMAL = [
    [213,213,189],[255,255,255],[222,222,230],[172,172,189],[115,115,139],[16,16,16],
    [238,255,131],[222,197,90],[131,106,16],[255,180,148],[255,123,90],[222,24,0],
    [255,172,115],[255,106,32],[222,24,0],[148,16,0]
];

const ramp16 = (n) => Array.from({ length: 16 }, (_, i) => [i * n % 256, (i * 13) % 256, (i * 29) % 256]);

function spriteIndices(w, h, slots) {
    // Transparent border, body drawn from the given slots — roughly how a sprite sits
    // in its frame, with plenty of index 0 around the edges.
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const inset = x >= w / 4 && x < w * 3 / 4 && y >= h / 4 && y < h * 3 / 4;
        out[y * w + x] = inset ? slots[(x + y) % slots.length] : 0;
    }
    return out;
}

const FIXTURES = [
    {
        name: 'front.png 64x64 4bpp +tRNS',
        png: makePng({
            w: 64, h: 64, depth: 4, palette: MAGIKARP_NORMAL, trns: [0],
            indices: spriteIndices(64, 64, [1, 5, 6, 7, 11, 14]), filter: 0
        })
    },
    {
        name: 'anim_front.png 64x128 4bpp +tRNS (filter Sub)',
        png: makePng({
            w: 64, h: 128, depth: 4, palette: MAGIKARP_NORMAL, trns: [0],
            indices: spriteIndices(64, 128, [2, 3, 9, 11, 14]), filter: 1
        })
    },
    {
        name: 'icon.png 32x64 4bpp +tRNS (filter Up)',
        png: makePng({
            w: 32, h: 64, depth: 4, palette: ramp16(17), trns: [0],
            indices: spriteIndices(32, 64, [4, 8, 12, 15]), filter: 2
        })
    },
    {
        name: 'footprint.png 16x16 1bpp',
        png: makePng({
            w: 16, h: 16, depth: 1, palette: [[255, 255, 255], [0, 0, 0]],
            trns: null, indices: spriteIndices(16, 16, [1]), filter: 0
        })
    },
    {
        name: 'tiles.png 128x64 4bpp no tRNS',
        png: makePng({
            w: 128, h: 64, depth: 4, palette: ramp16(11), trns: null,
            indices: Uint8Array.from({ length: 128 * 64 }, (_, i) => (i * 7) % 16), filter: 1
        })
    },
    {
        name: 'hpbar_anim.png 144x8 8bpp',
        png: makePng({
            w: 144, h: 8, depth: 8, palette: ramp16(9), trns: null,
            indices: Uint8Array.from({ length: 144 * 8 }, (_, i) => i % 16), filter: 0
        })
    }
];

/* ── Run ───────────────────────────────────────────────────────────────── */

await withPage(async (page) => {
    for (const fx of FIXTURES) {
        const truth = readPng(fx.png);
        const b64 = fx.png.toString('base64');

        const res = await page.eval(`(async () => {
            const bin = atob("${b64}");
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const ok = await PaintApp.applyProjectImageBytes(bytes, 'fixture.png', '', []);
            if (!ok) return { error: 'applyProjectImageBytes returned false' };
            const w = PaintApp.config.width, h = PaintApp.config.height;
            const d = PaintApp.ctx.getImageData(0, 0, w, h).data;
            const out = await PaintApp.generateIndexedPNG(
                w, h, PaintApp.buildProjectIndices(d, w, h), PaintApp.palette,
                PaintApp.state.projectBitDepth || PaintApp.bitDepth,
                PaintApp.state.projectTrns || new Uint8Array(0));
            let s = '';
            for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
            return {
                w, h,
                decoded: Array.from(PaintApp.state.projectIndices || []),
                transparentIndex: PaintApp.state.projectTransparentIndex,
                bitDepth: PaintApp.state.projectBitDepth,
                png: btoa(s)
            };
        })()`);

        console.log(`\n${fx.name}`);
        if (res.error) { check('opens', false, res.error); continue; }

        check('size preserved', res.w === truth.w && res.h === truth.h, `${res.w}x${res.h} vs ${truth.w}x${truth.h}`);
        check('bit depth preserved', res.bitDepth === truth.depth, `${res.bitDepth} vs ${truth.depth}`);

        const decodedWrong = res.decoded.reduce((n, v, i) => n + (v !== truth.indices[i] ? 1 : 0), 0);
        check('decoded indices match the file', decodedWrong === 0, `${decodedWrong} / ${truth.indices.length} differ`);

        const expectTrans = truth.trns ? truth.trns.indexOf(0) : -1;
        check('transparent slot identified', res.transparentIndex === expectTrans,
            `got ${res.transparentIndex}, expected ${expectTrans}`);

        const out = readPng(Buffer.from(res.png, 'base64'));
        const wrong = [];
        for (let i = 0; i < truth.indices.length; i++) {
            if (out.indices[i] !== truth.indices[i]) wrong.push(`${truth.indices[i]}->${out.indices[i]}`);
        }
        check('no-op save keeps every index', wrong.length === 0,
            `${wrong.length} / ${truth.indices.length} pixels changed (${[...new Set(wrong)].slice(0, 4).join(', ')})`);

        const trnsSame = JSON.stringify(out.trns) === JSON.stringify(truth.trns);
        check('transparency chunk round-trips', trnsSame, `${JSON.stringify(out.trns)} vs ${JSON.stringify(truth.trns)}`);
    }

    /* Switching to the shiny palette recolours the artwork; it must not renumber it.
       Magikarp is the case that catches a renumber: slots 11 and 14 are one colour in
       normal and two different golds in shiny. */
    console.log('\npalette swap keeps the index map');
    {
        const fx = FIXTURES[0];
        const truth = readPng(fx.png);
        const shiny = [
            [213,213,189],[255,255,255],[222,222,230],[172,172,189],[115,115,139],[16,16,16],
            [238,255,131],[222,197,90],[131,106,16],[255,255,172],[255,230,49],[246,189,82],
            [255,255,98],[255,222,32],[230,164,41],[156,82,41]
        ];
        const res = await page.eval(`(async () => {
            const bin = atob("${fx.png.toString('base64')}");
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await PaintApp.applyProjectImageBytes(bytes, 'front.png', '', []);
            PaintApp.state.palettes.push({
                id: 'shiny-test', name: 'Shiny', source: 'pal', handle: null, path: null,
                colors: ${JSON.stringify(shiny)}.map(c => ({ r: c[0], g: c[1], b: c[2], a: 255 }))
            });
            PaintApp.remapCanvasToPalette('shiny-test');
            const w = PaintApp.config.width, h = PaintApp.config.height;
            const d = PaintApp.ctx.getImageData(0, 0, w, h).data;
            const px = (i) => [d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]];
            const firstSlot14 = Array.from(PaintApp.spriteIndices).indexOf(14);
            const firstSlot11 = Array.from(PaintApp.spriteIndices).indexOf(11);
            return {
                indices: Array.from(PaintApp.buildProjectIndices(d, w, h)),
                slot14Pixel: firstSlot14 >= 0 ? px(firstSlot14) : null,
                slot11Pixel: firstSlot11 >= 0 ? px(firstSlot11) : null
            };
        })()`);
        const changed = res.indices.reduce((n, v, i) => n + (v !== truth.indices[i] ? 1 : 0), 0);
        check('indices survive the swap', changed === 0, `${changed} pixels renumbered`);
        check('slot 14 renders as its own shiny gold',
            JSON.stringify(res.slot14Pixel) === '[230,164,41,255]', JSON.stringify(res.slot14Pixel));
        check('slot 11 renders as its own shiny gold',
            JSON.stringify(res.slot11Pixel) === '[246,189,82,255]', JSON.stringify(res.slot11Pixel));
    }

    /* Painting with a picked slot must write THAT slot, even when another slot
       holds the same colour. Slots 11 and 14 of the Magikarp palette are the case. */
    console.log('\npainting resolves to the picked slot');
    {
        const fx = FIXTURES[0];
        const truth = readPng(fx.png);
        const res = await page.eval(`(async () => {
            const bin = atob("${fx.png.toString('base64')}");
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await PaintApp.applyProjectImageBytes(bytes, 'front.png', '', []);
            const w = PaintApp.config.width, h = PaintApp.config.height;
            // Pick slot 14 (222,24,0 — the same red as slot 11) and paint one pixel.
            PaintApp.pickPaletteSlot(14, 1);
            const before = PaintApp.paletteSlotFor(1);
            const img = PaintApp.ctx.getImageData(0, 0, w, h);
            const target = 40 * w + 40;
            img.data[target * 4] = 222; img.data[target * 4 + 1] = 24;
            img.data[target * 4 + 2] = 0; img.data[target * 4 + 3] = 255;
            PaintApp.ctx.putImageData(img, 0, 0);
            const out = PaintApp.buildProjectIndices(
                PaintApp.ctx.getImageData(0, 0, w, h).data, w, h);
            const conformance = PaintApp.projectConformance(3);
            // Setting the colour any other way drops the slot link, and the same
            // pixel falls back to the first slot holding that colour.
            PaintApp.setColor('#de1800', 1);
            const fallback = PaintApp.buildProjectIndices(
                PaintApp.ctx.getImageData(0, 0, w, h).data, w, h);
            return {
                pickedSlot: before, clearedSlot: PaintApp.paletteSlotFor(1),
                painted: out[target], fallbackPainted: fallback[target],
                indices: Array.from(out), target, conformance
            };
        })()`);
        check('picking a slot records it', res.pickedSlot === 14, `got ${res.pickedSlot}`);
        check('painted pixel takes the picked slot', res.painted === 14, `got ${res.painted}`);
        check('setting a colour any other way drops the slot link',
            res.clearedSlot === -1, `got ${res.clearedSlot}`);
        check('without a picked slot it falls back to the first match',
            res.fallbackPainted === 11, `got ${res.fallbackPainted}`);
        const collateral = res.indices.reduce(
            (n, v, i) => n + (i !== res.target && v !== truth.indices[i] ? 1 : 0), 0);
        check('no other pixel is touched', collateral === 0, `${collateral} changed`);
        check('conformance reports the asset as insertable',
            res.conformance && res.conformance.ok === true, JSON.stringify(res.conformance));
        check('conformance names the slot being painted with',
            !!(res.conformance && res.conformance.parts.some(p => p.text === 'slot 14')),
            JSON.stringify(res.conformance && res.conformance.parts));
    }

    /* The palette write path: decomp .pal files are 0-255 multiples of 8. */
    console.log('\npalette serialisation');
    const pal = await page.eval(`(() => {
        const text = 'JASC-PAL\\r\\n0100\\r\\n3\\r\\n205 205 172\\r\\n255 255 255\\r\\n131 238 197\\r\\n';
        const parsed = PaintApp.parseGbaPaletteText(text);
        const dark = PaintApp.parseGbaPaletteText('JASC-PAL\\r\\n0100\\r\\n2\\r\\n8 8 16\\r\\n24 24 31\\r\\n');
        return {
            parsed: parsed.colors.map(c => [c.r, c.g, c.b]),
            written: PaintApp.serializeJascPal(parsed.colors).split(/\\r?\\n/).slice(3, 6),
            dark: dark.colors.map(c => [c.r, c.g, c.b])
        };
    })()`);
    check('reads 0-255 values unchanged',
        JSON.stringify(pal.parsed[0]) === '[205,205,172]', JSON.stringify(pal.parsed[0]));
    // A palette read and written without an edit must come back identical.
    check('writes a real decomp palette back byte-identical',
        pal.written[0] === '205 205 172' && pal.written[1] === '255 255 255' && pal.written[2] === '131 238 197',
        `wrote "${pal.written.join(' | ')}"`);
    check('dark palette is not inflated',
        JSON.stringify(pal.dark) === '[[8,8,16],[24,24,31]]', JSON.stringify(pal.dark));

    /* Profiles must accept the assets they are guarding. */
    console.log('\ntarget profiles');
    const profiles = await page.eval(`(() => {
        const p = (path) => { const pr = PaintApp.inferProfile(path); return { label: pr.label, res: pr.allowedResolutions || null }; };
        const fits = (path, w, h) => {
            const pr = PaintApp.inferProfile(path);
            if (!pr.allowedResolutions) return true;
            return pr.allowedResolutions.some(r => r[0] === w && r[1] === h);
        };
        return {
            anim: p('graphics/pokemon/bulbasaur/anim_front.png'),
            animFits: fits('graphics/pokemon/bulbasaur/anim_front.png', 64, 128),
            iconFits: fits('graphics/pokemon/bulbasaur/icon.png', 32, 64),
            frontFits: fits('graphics/pokemon/bulbasaur/front.png', 64, 64),
            footFits: fits('graphics/pokemon/bulbasaur/footprint.png', 16, 16),
            gbaFits: fits('graphics/pokemon/bulbasaur/back_gba.png', 64, 64),
            tileset: p('data/tilesets/primary/general/tiles.png').label
        };
    })()`);
    check('anim_front.png 64x128 accepted', profiles.animFits, JSON.stringify(profiles.anim));
    check('icon.png 32x64 accepted', profiles.iconFits);
    check('front.png 64x64 accepted', profiles.frontFits);
    check('footprint.png 16x16 accepted', profiles.footFits);
    check('_gba variants resolve to the same profile', profiles.gbaFits);
    check('tilesets recognised', profiles.tileset === 'Tileset', profiles.tileset);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
