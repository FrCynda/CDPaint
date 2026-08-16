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
   paths get exercised, not just filter 0. `colorType` is 3 (palette) unless a
   test wants greyscale (0), which gbagfx accepts and we must not reject. */
function makePng({ w, h, depth, palette, trns, indices, filter = 0, colorType = 3 }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = depth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

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
        chunk('IHDR', ihdr)
    ];
    if (colorType === 3) parts.push(chunk('PLTE', plte));
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

    /* The index map is the document, not something reconstructed at save time.
       It has to stay correct while painting, travel with undo, and leave nothing
       off-palette behind — otherwise the canvas and the file disagree. */
    console.log('\nthe index map stays live while painting');
    {
        const fx = FIXTURES[0];
        const truth = readPng(fx.png);
        const res = await page.eval(`(async () => {
            const bin = atob("${fx.png.toString('base64')}");
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await PaintApp.applyProjectImageBytes(bytes, 'front.png', '', []);
            const w = PaintApp.config.width, h = PaintApp.config.height;
            const at = (x, y) => y * w + x;
            const cmain = PaintApp.ui.cMain.getContext('2d');
            const px = (q) => {
                const d = cmain.getImageData(0, 0, w, h).data;
                return [d[q * 4], d[q * 4 + 1], d[q * 4 + 2], d[q * 4 + 3]];
            };
            const map = () => Array.from(PaintApp.state.projectIndices);
            const painted = at(16, 16), off = at(40, 40);

            // Paint the way a tool does: draw, then commit the step. Nothing here
            // calls buildProjectIndices — the map has to be right on its own.
            PaintApp.pickPaletteSlot(14, 1);
            PaintApp.ctx.fillStyle = '#de1800';
            PaintApp.ctx.fillRect(16, 16, 4, 4);
            PaintApp.saveState();
            const liveSlot = PaintApp.state.projectIndices[painted];

            // A colour that is in no slot must not survive the step it was made in.
            PaintApp.setColor('#123456', 1);
            PaintApp.ctx.fillStyle = '#123456';
            PaintApp.ctx.fillRect(40, 40, 3, 3);
            PaintApp.saveState();
            const offSlot = PaintApp.state.projectIndices[off];
            const offPixel = px(off);
            const offColor = PaintApp.palette[offSlot];

            // Undo has to walk the map back with the pixels.
            PaintApp.undo();
            const undo1 = { off: PaintApp.state.projectIndices[off], painted: PaintApp.state.projectIndices[painted] };
            PaintApp.undo();
            const undo2 = map();
            PaintApp.redo(); PaintApp.redo();
            const redone = { off: PaintApp.state.projectIndices[off], painted: PaintApp.state.projectIndices[painted] };

            return {
                liveSlot, offSlot, offPixel,
                offColor: offColor ? [offColor.r, offColor.g, offColor.b] : null,
                undo1, undo2, redone,
                mapIsState: PaintApp.spriteIndices === PaintApp.state.projectIndices,
                hasBaseline: 'projectBaseline' in PaintApp.state,
                carriesWithTabs: PaintApp.DOCUMENT_STATE_KEYS.includes('projectIndices'),
                stepHoldsMap: PaintApp.state.history.every(e => !!e.projectIndices)
            };
        })()`);

        check('painting updates the map without a save', res.liveSlot === 14, `got ${res.liveSlot}`);
        check('an off-palette colour lands on a slot', res.offSlot >= 0 && res.offSlot < 16, `got ${res.offSlot}`);
        check('and the canvas is pulled onto that slot',
            JSON.stringify(res.offPixel) === JSON.stringify([...(res.offColor || []), 255]),
            `${JSON.stringify(res.offPixel)} vs slot ${res.offSlot} ${JSON.stringify(res.offColor)}`);
        check('undo restores the map one step at a time',
            res.undo1.off === truth.indices[40 * 64 + 40] && res.undo1.painted === 14,
            `off ${res.undo1.off}, painted ${res.undo1.painted}`);
        const backWrong = res.undo2.reduce((n, v, i) => n + (v !== truth.indices[i] ? 1 : 0), 0);
        check('undoing to the start gives the file back exactly', backWrong === 0, `${backWrong} slots differ`);
        check('redo puts the painted slots back',
            res.redone.painted === 14 && res.redone.off === res.offSlot,
            `painted ${res.redone.painted}, off ${res.redone.off}`);
        check('every history step carries a map', res.stepHoldsMap === true);
        check('the map lives on the document, so a tab switch keeps it',
            res.mapIsState === true && res.carriesWithTabs === true,
            `same object: ${res.mapIsState}, document key: ${res.carriesWithTabs}`);
        check('the RGB baseline is gone', res.hasBaseline === false);
    }

    /* Editing the palette of a project asset is a document edit: the canvas is the
       map rendered through that palette, so a slot edit repaints, a reorder
       renumbers, and both undo. Nothing re-quantises and no pixel is reinterpreted. */
    console.log('\npalette edits repaint live');
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
            const w = PaintApp.config.width, h = PaintApp.config.height;
            const cmain = PaintApp.ui.cMain.getContext('2d');
            const pixels = () => cmain.getImageData(0, 0, w, h).data;
            const hash = () => {
                const d = pixels();
                let a = 0x811c9dc5;
                for (let i = 0; i < d.length; i += 4) {
                    a = ((a ^ ((d[i] << 24) ^ (d[i+1] << 16) ^ (d[i+2] << 8) ^ d[i+3])) * 16777619) >>> 0;
                }
                return a.toString(16);
            };
            const map = () => Array.from(PaintApp.state.projectIndices);
            const active = PaintApp.state.activePaletteId;
            const slot6 = map().reduce((n, v) => n + (v === 6 ? 1 : 0), 0);

            // 1. Change slot 6. Every pixel holding it follows; no index moves.
            const mapBefore = map();
            PaintApp.updatePaletteColor(active, 6, { r: 0, g: 255, b: 0 });
            const d = pixels();
            let repainted = 0, strayed = 0;
            for (let q = 0; q < w * h; q++) {
                const isSix = mapBefore[q] === 6;
                const green = d[q*4] === 0 && d[q*4+1] === 255 && d[q*4+2] === 0;
                if (isSix && green) repainted++;
                if (!isSix && green) strayed++;
            }
            const mapHeld = map().every((v, i) => v === mapBefore[i]);

            // 2. Undo takes the colour and the pixels back together.
            PaintApp.undo();
            const undoneColor = PaintApp.palette[6];
            const undonePixels = (() => {
                const u = pixels();
                let wrong = 0;
                for (let q = 0; q < w * h; q++) {
                    if (mapBefore[q] !== 6) continue;
                    if (u[q*4] !== 238 || u[q*4+1] !== 255 || u[q*4+2] !== 131) wrong++;
                }
                return wrong;
            })();

            // 3. Reordering renames slots; the picture must not move a pixel.
            const beforeReorder = hash();
            PaintApp.reorderPaletteColor(active, 6, 2);
            const afterReorder = hash();
            const renumbered = map().reduce((n, v, i) => n + (v === 2 && mapBefore[i] === 6 ? 1 : 0), 0);
            PaintApp.undo();
            const reorderUndone = hash() === beforeReorder && PaintApp.state.projectIndices[
                mapBefore.indexOf(6)] === 6;

            // 4. Swapping to shiny is a history step, so undo must put the palette
            //    back too — otherwise the map would be read through the wrong colours.
            PaintApp.state.palettes.push({
                id: 'shiny-test', name: 'Shiny', source: 'pal', handle: null, path: null,
                colors: ${JSON.stringify(shiny)}.map(c => ({ r: c[0], g: c[1], b: c[2], a: 255 }))
            });
            PaintApp.setActivePalette('shiny-test');
            const swapped = { id: PaintApp.state.activePaletteId, slot14: PaintApp.palette[14].r };
            PaintApp.undo();
            const afterSwapUndo = {
                id: PaintApp.state.activePaletteId,
                slot14: [PaintApp.palette[14].r, PaintApp.palette[14].g, PaintApp.palette[14].b],
                mapIntact: map().every((v, i) => v === mapBefore[i])
            };

            // 5. A slot the artwork stands on cannot be dragged out of the palette.
            PaintApp.addPalette('scratch');
            const scratch = PaintApp.state.palettes[PaintApp.state.palettes.length - 1].id;
            const paletteLen = PaintApp.palette.length;
            PaintApp.moveColorBetweenPalettes(active, 6, scratch, 0);
            const refused = PaintApp.palette.length === paletteLen && PaintApp.palette[6].g === 255;
            // An unused one is just housekeeping, and the picture survives it.
            const beforeMove = hash();
            PaintApp.moveColorBetweenPalettes(active, 9, scratch, 0);
            const movedOut = {
                shrank: PaintApp.palette.length === paletteLen - 1,
                pictureHeld: hash() === beforeMove,
                shifted: PaintApp.state.projectIndices[mapBefore.indexOf(11)] === 10
            };

            return {
                slot6, repainted, strayed, mapHeld,
                undoneColor: [undoneColor.r, undoneColor.g, undoneColor.b],
                undonePixels,
                reorderMoved: beforeReorder === afterReorder, renumbered, reorderUndone,
                swapped, afterSwapUndo, refused, movedOut
            };
        })()`);

        check('the asset actually uses the slot under test', res.slot6 > 0, `${res.slot6} pixels`);
        check('changing a slot repaints every pixel holding it',
            res.repainted === res.slot6, `${res.repainted} of ${res.slot6}`);
        check('and repaints nothing else', res.strayed === 0, `${res.strayed} strays`);
        check('no index moves — nothing re-quantises', res.mapHeld === true);
        check('undo restores the slot colour',
            JSON.stringify(res.undoneColor) === '[238,255,131]', JSON.stringify(res.undoneColor));
        check('undo restores the pixels with it', res.undonePixels === 0, `${res.undonePixels} wrong`);
        check('reordering the palette does not move a pixel', res.reorderMoved === true);
        check('reordering renumbers the artwork instead', res.renumbered > 0, `${res.renumbered} renumbered`);
        check('and reordering undoes cleanly', res.reorderUndone === true);
        check('switching palette repaints the asset', res.swapped.id === 'shiny-test' && res.swapped.slot14 === 230,
            JSON.stringify(res.swapped));
        check('undoing the swap restores the palette, not just the pixels',
            res.afterSwapUndo.id !== 'shiny-test' &&
            JSON.stringify(res.afterSwapUndo.slot14) === '[222,24,0]',
            JSON.stringify(res.afterSwapUndo));
        check('and the map survives the round trip', res.afterSwapUndo.mapIntact === true);
        check('a slot the artwork uses cannot be dragged out', res.refused === true);
        check('an unused slot can, and the picture is unchanged',
            res.movedOut.shrank && res.movedOut.pictureHeld, JSON.stringify(res.movedOut));
        check('the slots above it shift down with the artwork',
            res.movedOut.shifted === true, JSON.stringify(res.movedOut));
    }

    /* A Gen 3 animation is one PNG with the frames side by side, so "frames" is a
       reading of the canvas rather than a second document. The reading has to match
       the real sheets, and it must never invent frames in a still sprite. */
    console.log('\nframes are a reading of the sheet');
    {
        const anim = FIXTURES[1].png.toString('base64');   // 64x128 anim_front
        const still = FIXTURES[0].png.toString('base64');  // 64x64  front
        const icon = FIXTURES[2].png.toString('base64');   // 32x64  icon
        const walk = makePng({
            w: 144, h: 32, depth: 4, palette: ramp16(11), trns: [0],
            indices: Uint8Array.from({ length: 144 * 32 }, (_, i) => ((i % 144) / 16 | 0) + 1),
            filter: 0
        }).toString('base64');

        const res = await page.eval(`(async () => {
            const load = async (b64, name) => {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return PaintApp.applyProjectImageBytes(bytes, name, 'graphics/' + name, []);
            };
            const shape = (l) => l ? [l.count, l.w, l.h, l.axis] : null;
            const out = {};

            await load("${anim}", 'pokemon/bulbasaur/anim_front.png');
            out.anim = shape(PaintApp.projectFrameLayout());
            out.animRects = [0, 1].map(i => {
                const r = PaintApp.projectFrameRect(i);
                return [r.x, r.y, r.w, r.h];
            });
            out.animHz = Math.round(1000 / PaintApp.projectFrameLayout().ms * 100) / 100;

            await load("${still}", 'pokemon/bulbasaur/front.png');
            out.still = shape(PaintApp.projectFrameLayout());

            await load("${icon}", 'pokemon/bulbasaur/icon.png');
            out.icon = shape(PaintApp.projectFrameLayout());

            await load("${walk}", 'object_events/pics/people/brendan/walking.png');
            out.walk = shape(PaintApp.projectFrameLayout());
            // The count is a guess for overworld sheets, so it has to be correctable.
            PaintApp.setFrameCountOverride(6);
            out.overridden = shape(PaintApp.projectFrameLayout());
            PaintApp.setFrameCountOverride(null);

            // Selecting a frame is navigation, not an edit.
            const stepsBefore = PaintApp.state.history.length;
            PaintApp.setActiveFrame(3);
            out.active = PaintApp.activeFrameIndex();
            PaintApp.stepFrame(1);
            out.stepped = PaintApp.activeFrameIndex();
            PaintApp.setActiveFrame(-1);
            out.wrapped = PaintApp.activeFrameIndex();
            out.noNewSteps = PaintApp.state.history.length === stepsBefore;

            // A frame renders 1:1 off the display surface, so it shows what is there.
            const c = document.createElement('canvas');
            PaintApp.renderProjectFrameInto(c, 2, 1);
            const fd = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            const md = PaintApp.ui.cMain.getContext('2d').getImageData(32, 0, 16, 32).data;
            out.thumb = [c.width, c.height];
            out.thumbMatches = fd.every((v, i) => v === md[i]);

            // Onion skin ghosts the neighbours onto its own canvas, not the artwork.
            PaintApp.setActiveFrame(4);
            const before = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, 144, 32).data;
            PaintApp.toggleOnionSkin(true);
            const onion = PaintApp.ui.frameOnion;
            const od = onion.getContext('2d').getImageData(0, 0, 144, 32).data;
            const after = PaintApp.ui.cMain.getContext('2d').getImageData(0, 0, 144, 32).data;
            const inFrame4 = (q) => { const x = q % 144; return x >= 64 && x < 80; };
            let ghosted = 0, leaked = 0;
            for (let q = 0; q < 144 * 32; q++) {
                if (od[q * 4 + 3] === 0) continue;
                if (inFrame4(q)) ghosted++; else leaked++;
            }
            out.onion = {
                shown: onion.style.display === 'block',
                ghosted, leaked,
                artworkUntouched: before.every((v, i) => v === after[i])
            };
            PaintApp.toggleOnionSkin(false);
            out.onionOff = PaintApp.ui.frameOnion.style.display === 'none';

            // Playback walks the preview and leaves the edited frame alone.
            const editing = PaintApp.activeFrameIndex();
            const seen = [];
            PaintApp.onFramePlayback = (i) => { if (i !== null) seen.push(i); };
            PaintApp.startFramePlayback();
            out.playing = PaintApp.isFramePlaying();
            await new Promise(r => setTimeout(r, PaintApp.projectFrameLayout().ms * 3.5));
            PaintApp.stopFramePlayback();
            out.playback = { seen: seen.slice(0, 3), stopped: !PaintApp.isFramePlaying(),
                             stillEditing: PaintApp.activeFrameIndex() === editing };
            return out;
        })()`);

        check('anim_front is two 64×64 frames',
            JSON.stringify(res.anim) === '[2,64,64,"y"]', JSON.stringify(res.anim));
        check('stacked top to bottom, not side by side',
            JSON.stringify(res.animRects) === '[[0,0,64,64],[0,64,64,64]]', JSON.stringify(res.animRects));
        check('held at the GBA’s real refresh, not 60Hz flat',
            Math.abs(res.animHz - 7.47) < 0.02, `${res.animHz} fps`);
        check('a still 64×64 front sprite has no frames', res.still === null, JSON.stringify(res.still));
        check('icon is two 32×32 frames',
            JSON.stringify(res.icon) === '[2,32,32,"y"]', JSON.stringify(res.icon));
        check('a 144×32 walking sheet is nine 16×32 frames',
            JSON.stringify(res.walk) === '[9,16,32,"x"]', JSON.stringify(res.walk));
        check('and the guess can be corrected by hand',
            JSON.stringify(res.overridden) === '[6,24,32,"x"]', JSON.stringify(res.overridden));
        check('picking a frame selects it', res.active === 3, String(res.active));
        check('stepping moves on', res.stepped === 4, String(res.stepped));
        check('and it wraps rather than falling off the end', res.wrapped === 8, String(res.wrapped));
        check('choosing a frame is navigation, not an undo step', res.noNewSteps === true);
        check('a frame renders at its own size',
            JSON.stringify(res.thumb) === '[16,32]', JSON.stringify(res.thumb));
        check('and renders exactly what is on the canvas', res.thumbMatches === true);
        check('onion skin draws something', res.onion.shown && res.onion.ghosted > 0,
            JSON.stringify(res.onion));
        check('only over the frame being worked on', res.onion.leaked === 0, `${res.onion.leaked} px outside`);
        check('and never onto the artwork', res.onion.artworkUntouched === true);
        check('turning it off clears it', res.onionOff === true);
        check('playback advances frame by frame',
            JSON.stringify(res.playback.seen) === '[5,6,7]', JSON.stringify(res.playback.seen));
        check('stopping stops it', res.playback.stopped === true);
        check('and the frame being edited never moved', res.playback.stillEditing === true);
    }

    /* The strip is the whole feature as far as anyone using it is concerned: it has
       to show up for a sheet, stay away for a still sprite, and drive the engine. */
    console.log('\nthe frame strip');
    {
        const anim = FIXTURES[1].png.toString('base64');
        const still = FIXTURES[0].png.toString('base64');
        const res = await page.eval(`(async () => {
            const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const load = async (b64, name) => {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                await PaintApp.applyProjectImageBytes(bytes, name, 'graphics/' + name, []);
                await frame();
            };
            const strip = document.getElementById('frame-strip');
            const shown = () => !!strip && !strip.classList.contains('fs-collapsed');

            await load("${still}", 'pokemon/bulbasaur/front.png');
            const hiddenForStill = !shown();

            await load("${anim}", 'pokemon/bulbasaur/anim_front.png');
            const thumbs = strip.querySelectorAll('.fs-thumb');
            const drawn = Array.from(thumbs).map(t => {
                const c = t.querySelector('canvas');
                return c.width + 'x' + c.height;
            });
            thumbs[1].click();
            await frame();
            const picked = PaintApp.activeFrameIndex();
            const marked = strip.querySelectorAll('.fs-thumb.fs-active').length === 1 &&
                thumbs[1].classList.contains('fs-active');

            const playBtn = strip.querySelector('.fs-controls .fs-btn');
            playBtn.click();
            await frame();
            const playing = PaintApp.isFramePlaying() && playBtn.classList.contains('fs-on');
            playBtn.click();
            await frame();
            const stopped = !PaintApp.isFramePlaying();

            const readout = strip.querySelector('.fs-readout').textContent;
            return { hiddenForStill, shown: shown(), count: thumbs.length, drawn,
                     picked, marked, playing, stopped, readout };
        })()`);

        check('the strip stays away from a still sprite', res.hiddenForStill === true);
        check('and appears for a sheet', res.shown === true);
        check('with one thumbnail per frame', res.count === 2, String(res.count));
        check('drawn at an integer zoom',
            JSON.stringify(res.drawn) === '["64x64","64x64"]', JSON.stringify(res.drawn));
        check('clicking a thumbnail selects that frame', res.picked === 1, String(res.picked));
        check('and marks it', res.marked === true);
        check('play starts and lights up', res.playing === true);
        check('and stops again', res.stopped === true);
        check('the readout names the size and the real speed',
            /64×64 · 7\.5 fps · 134ms/.test(res.readout), res.readout);
    }

    /* The 1:1 pane. Pixel art judged at 800% is not judged at all, so this has to
       be honest about size and current with the canvas. */
    console.log('\nthe 1:1 preview');
    {
        const anim = FIXTURES[1].png.toString('base64');
        const res = await page.eval(`(async () => {
            const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            const bin = atob("${anim}");
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await PaintApp.applyProjectImageBytes(bytes, 'anim_front.png',
                'graphics/pokemon/bulbasaur/anim_front.png', []);
            await frame();
            const panel = document.getElementById('sprite-preview');
            const shot = () => {
                const c = panel.querySelector('.sp-canvas');
                return { w: c.width, h: c.height, css: [c.style.width, c.style.height] };
            };

            const one = shot();
            // The pane shows the frame being worked on, not the whole 64x128 sheet.
            PaintApp.setActiveFrame(1);
            await frame();
            const onFrame2 = shot();

            // A stroke must show up here without anything else being asked to refresh.
            PaintApp.ctx.fillStyle = '#ffffff';
            PaintApp.ctx.fillRect(0, 64, 64, 64);
            PaintApp.saveState();
            await frame();
            const c = panel.querySelector('.sp-canvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let white = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] === 255 && d[i+1] === 255 && d[i+2] === 255) white++;
            }

            // Zoom stays an integer multiple of real pixels.
            panel.querySelector('.sp-zoom').value = '3';
            panel.querySelector('.sp-zoom').dispatchEvent(new Event('change'));
            await frame();
            const zoomed = shot();

            return { one, onFrame2, white, zoomed,
                     panes: panel.querySelectorAll('.sp-canvas').length };
        })()`);

        check('the pane is one frame, not the whole sheet',
            res.one.w === 64 && res.one.h === 64, `${res.one.w}x${res.one.h}`);
        check('at 1:1 on screen — game size means game size',
            JSON.stringify(res.one.css) === '["64px","64px"]', JSON.stringify(res.one.css));
        check('it follows the frame being worked on',
            res.onFrame2.w === 64 && res.onFrame2.h === 64, JSON.stringify(res.onFrame2));
        check('painting shows up in it straight away', res.white === 64 * 64, `${res.white} px`);
        check('zoom is a whole multiple of real pixels',
            res.zoomed.w === 192 && JSON.stringify(res.zoomed.css) === '["192px","192px"]',
            JSON.stringify(res.zoomed));
        check('one pane per palette', res.panes >= 1, String(res.panes));
    }

    /* Fit to target. These are the operations that can destroy somebody's work, so
       they are pure functions over a document value and each one is checked on its
       own — and the dialog's "after" is that same value, drawn. */
    console.log('\nfit to target');
    {
        /* A 60×70 4bpp sprite with an opaque background: wrong size, no
           transparency. The test then adds a 17th colour in the app, which is how
           the colour budget is really blown — a 4bpp file cannot ship one, so the
           overflow always arrives from editing rather than from disk. */
        const bad = makePng({
            w: 60, h: 70, depth: 4, palette: ramp16(12), trns: [0],
            // Slot 3 border all round, body from 5..15 — nothing on slot 0 at all.
            indices: Uint8Array.from({ length: 60 * 70 }, (_, i) => {
                const x = i % 60, y = (i / 60) | 0;
                const inside = x > 8 && x < 51 && y > 8 && y < 61;
                return inside ? 5 + ((x + y) % 11) : 3;
            }),
            filter: 0
        }).toString('base64');

        const res = await page.eval(`(async () => {
            const bin = atob("${bad}");
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            await PaintApp.applyProjectImageBytes(bytes, 'front.png',
                'graphics/pokemon/testmon/front.png', []);
            // One colour past what 4bpp can hold.
            PaintApp.addPaletteColorTo(PaintApp.state.activePaletteId, { r: 1, g: 2, b: 3 });
            const conf = PaintApp.projectConformance(17);
            const plan = PaintApp.planFitToTarget(17);
            const ids = plan.steps.map(s => s.id).sort();

            // Each fix, on its own, against the untouched document value.
            const only = (id) => {
                const step = plan.steps.find(s => s.id === id);
                return PaintApp.fitStepApply(plan.doc, step);
            };
            const cleared = only('slot0');
            let clearedCount = 0, insideKept = 0;
            for (let q = 0; q < cleared.map.length; q++) {
                if (cleared.map[q] === cleared.transparentIdx) clearedCount++;
                if (plan.doc.map[q] >= 5 && cleared.map[q] !== plan.doc.map[q]) insideKept++;
            }
            const reduced = only('colors');
            const resized = only('size');

            // The bottom row of artwork must still be the bottom row afterwards:
            // a Gen 3 sprite's y_offset is measured up from the bottom edge.
            const bottomBefore = [];
            for (let x = 0; x < 60; x++) bottomBefore.push(plan.doc.map[69 * 60 + x]);
            const dx = Math.round((64 - 60) / 2);
            const bottomAfter = [];
            for (let x = 0; x < 60; x++) bottomAfter.push(resized.map[63 * 64 + x + dx]);

            const banner = document.getElementById('conformance-banner');
            const bannerShown = banner.style.display === 'flex';
            const bannerText = banner.querySelector('#cb-text').textContent;

            // The whole thing, committed, as one undo step.
            const stepsBefore = PaintApp.state.history.length;
            PaintApp.applyFitToTarget(ids);
            const after = {
                size: [PaintApp.config.width, PaintApp.config.height],
                colors: PaintApp.palette.length,
                conf: PaintApp.projectConformance(PaintApp.palette.length).ok,
                oneStep: PaintApp.state.history.length === stepsBefore + 1,
                mapFits: PaintApp.state.projectIndices.length === 64 * 64,
                inRange: Array.from(PaintApp.state.projectIndices).every(v => v < PaintApp.palette.length)
            };
            PaintApp.undo();
            const undone = [PaintApp.config.width, PaintApp.config.height, PaintApp.palette.length];

            return {
                confOk: conf.ok,
                confParts: conf.parts.map(p => p.text + (p.ok ? '' : ' [bad]')),
                ids, clearedCount, insideKept,
                reduced: [reduced.colors.length, Math.max(...reduced.map)],
                resized: [resized.w, resized.h],
                bottomHeld: JSON.stringify(bottomBefore) === JSON.stringify(bottomAfter),
                bannerShown, bannerText, after, undone
            };
        })()`);

        check('conformance sees an opaque background',
            res.confOk === false && res.confParts.some(p => /slot 0 unused/.test(p)),
            JSON.stringify(res.confParts));
        check('the banner says so in words',
            res.bannerShown && /won’t build/.test(res.bannerText), res.bannerText);
        check('the plan names all three problems',
            JSON.stringify(res.ids) === '["colors","size","slot0"]', JSON.stringify(res.ids));
        check('clearing slot 0 takes the background', res.clearedCount > 0, `${res.clearedCount} px`);
        check('and leaves the sprite alone', res.insideKept === 0, `${res.insideKept} body px changed`);
        check('reducing colours lands inside the budget',
            res.reduced[0] === 16 && res.reduced[1] < 16, JSON.stringify(res.reduced));
        check('resizing hits the profile’s box exactly',
            JSON.stringify(res.resized) === '[64,64]', JSON.stringify(res.resized));
        check('bottom-anchored, so y_offset still means what it meant',
            res.bottomHeld === true);
        check('applying everything makes it insertable',
            res.after.conf === true && JSON.stringify(res.after.size) === '[64,64]' && res.after.colors === 16,
            JSON.stringify(res.after));
        check('the map is resized with it and stays in range',
            res.after.mapFits && res.after.inRange, JSON.stringify(res.after));
        check('the whole fit is one undo step', res.after.oneStep === true);
        check('and undo puts the asset back as it was',
            JSON.stringify(res.undone) === '[60,70,17]', JSON.stringify(res.undone));
    }

    /* Validation without a build. Two questions that get confused constantly:
       would gbagfx refuse it, and would it look wrong in the game. Only the first
       stops `make`, and only the second is invisible until someone plays it. */
    console.log('\nvalidate without building');
    {
        const good = FIXTURES[0].png.toString('base64');
        // 4bpp, right shape, but nothing standing on the transparent slot.
        const opaque = makePng({
            w: 64, h: 64, depth: 4, palette: ramp16(12), trns: [0],
            indices: Uint8Array.from({ length: 64 * 64 }, (_, i) => 1 + (i % 15)), filter: 0
        }).toString('base64');
        // 8bpp using index 200. gbagfx does NOT refuse this: ConvertBitDepth
        // reduces it with `% 16`, so it builds and then draws index 8.
        const deep = makePng({
            w: 64, h: 64, depth: 8, palette: Array.from({ length: 256 }, (_, i) => [i, 255 - i, i / 2 | 0]),
            trns: [0], indices: Uint8Array.from({ length: 64 * 64 }, (_, i) => i % 201), filter: 0
        }).toString('base64');
        /* 8bpp, 256-entry palette, but no index above 15 — which is what a great
           many stock expansion assets look like. Nothing wrong with it. */
        const wideTable = makePng({
            w: 64, h: 64, depth: 8, palette: Array.from({ length: 256 }, (_, i) => [i, 255 - i, i / 2 | 0]),
            trns: [0], indices: Uint8Array.from({ length: 64 * 64 }, (_, i) => i % 16), filter: 0
        }).toString('base64');
        // Greyscale, no palette at all. gbagfx takes PNG_COLOR_TYPE_GRAY happily.
        const grey = makePng({
            w: 64, h: 64, depth: 4, palette: [], trns: null, colorType: 0,
            indices: Uint8Array.from({ length: 64 * 64 }, (_, i) => i % 16), filter: 0
        }).toString('base64');
        /* A palette kept as a picture: one pixel per slot, 16×1. Not tile-aligned,
           and it never needed to be — it is not drawn. */
        const palImage = makePng({
            w: 16, h: 1, depth: 8, palette: ramp16(16), trns: [0],
            indices: Uint8Array.from({ length: 16 }, (_, i) => i), filter: 0
        }).toString('base64');
        // 60x70: not a whole number of tiles, and not the size the slot wants.
        const ragged = makePng({
            w: 60, h: 70, depth: 4, palette: ramp16(9), trns: null,
            indices: Uint8Array.from({ length: 60 * 70 }, (_, i) => i % 16), filter: 0
        }).toString('base64');

        const res = await page.eval(`(async () => {
            const un = (b64) => {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                return bytes;
            };
            const check = async (b64, path) => {
                const r = await PaintApp.validateProjectAsset(un(b64), path);
                return { ok: r.ok, buildOk: r.buildOk,
                         ids: r.problems.map(p => p.kind + ':' + p.id).sort(),
                         texts: r.problems.map(p => p.text).join(' | '),
                         info: r.info };
            };
            const out = {
                good: await check("${good}", 'graphics/pokemon/magikarp/front.png'),
                opaque: await check("${opaque}", 'graphics/pokemon/magikarp/front.png'),
                deep: await check("${deep}", 'graphics/pokemon/magikarp/front.png'),
                ragged: await check("${ragged}", 'graphics/pokemon/magikarp/front.png'),
                wideTable: await check("${wideTable}", 'graphics/pokemon/magikarp/front.png'),
                grey: await check("${grey}", 'graphics/interface/thing.png'),
                palImage: await check("${palImage}", 'graphics/pokemon/pawmi/normal.png'),
                // Tileset animation frames are not the 128px sheet.
                tsAnim: await check("${palImage}", 'data/tilesets/primary/building/anim/tv/0.png'),
                notPng: await PaintApp.validateProjectAsset(new Uint8Array([1,2,3]), 'graphics/x.png')
            };
            // And the whole-project sweep over the same four.
            const entries = [
                { name: 'front.png', path: 'graphics/pokemon/a/front.png', b: "${good}" },
                { name: 'front.png', path: 'graphics/pokemon/b/front.png', b: "${opaque}" },
                { name: 'front.png', path: 'graphics/pokemon/c/front.png', b: "${deep}" },
                { name: 'front.png', path: 'graphics/pokemon/d/front.png', b: "${ragged}" }
            ];
            const report = await PaintApp.auditProjectAssets(entries, (e) => un(e.b));
            out.report = {
                total: report.total, clean: report.clean,
                wontBuild: report.wontBuild.map(r => r.path.split('/')[2]).sort(),
                wrongInGame: report.wrongInGame.map(r => r.path.split('/')[2]).sort()
            };
            // A read that throws must be reported, not swallowed.
            const broken = await PaintApp.auditProjectAssets(
                [{ name: 'gone.png', path: 'graphics/gone.png' }],
                () => { throw new Error('file vanished'); });
            out.broken = broken.wontBuild.length === 1 &&
                /vanished/.test(broken.wontBuild[0].problems[0].text);
            return out;
        })()`);

        check('a real decomp asset passes both checks', res.good.ok === true,
            JSON.stringify(res.good.ids));
        check('and its shape is reported',
            res.good.info.w === 64 && res.good.info.depth === 4 && res.good.info.indexed,
            JSON.stringify(res.good.info));
        check('an opaque background builds fine but is wrong in game',
            res.opaque.buildOk === true && JSON.stringify(res.opaque.ids) === '["game:slot0"]',
            JSON.stringify(res.opaque.ids));
        /* This one used to be asserted the other way round. gbagfx reduces an
           over-deep index with `% 16` (convert_png.c, ConvertBitDepth) instead of
           refusing it, so the build succeeds and the picture is wrong — which is
           the harder problem to find, not the easier one. */
        check('an index a 4bpp slot cannot reach builds fine and draws wrong',
            res.deep.buildOk === true && res.deep.ids.includes('game:index'),
            JSON.stringify(res.deep.ids));
        check('and it names the index that will actually be drawn',
            /draws it as index 8/.test(res.deep.texts), res.deep.texts);
        check('a big palette table with small indices is not a problem at all',
            res.wideTable.ok === true, JSON.stringify(res.wideTable.ids));
        check('greyscale is accepted — gbagfx takes GRAY as well as PALETTE',
            res.grey.buildOk === true && !res.grey.ids.includes('build:notIndexed'),
            JSON.stringify(res.grey.ids));
        check('a palette stored as a 16×1 picture is not held to tile alignment',
            res.palImage.buildOk === true && !res.palImage.ids.includes('build:tiles'),
            JSON.stringify(res.palImage.ids));
        check('a tileset animation frame is not held to the 128px sheet width',
            !res.tsAnim.ids.includes('build:width'), JSON.stringify(res.tsAnim.ids));
        check('a ragged size fails as both a build and a game problem',
            res.ragged.ids.includes('build:tiles') && res.ragged.ids.includes('game:size'),
            JSON.stringify(res.ragged.ids));
        check('something that is not a PNG says so, rather than throwing',
            res.notPng.buildOk === false && res.notPng.problems[0].id === 'unreadable');
        check('the sweep separates the two kinds',
            JSON.stringify(res.report.wontBuild) === '["d"]' &&
            JSON.stringify(res.report.wrongInGame) === '["b","c"]',
            JSON.stringify(res.report));
        check('and counts the clean ones', res.report.clean === 1 && res.report.total === 4,
            JSON.stringify(res.report));
        check('a file that cannot be read is reported, not skipped', res.broken === true);
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
            tileset: p('data/tilesets/primary/general/tiles.png').label,
            /* Everything below was a false alarm on a stock expansion checkout
               before the profiles were rebuilt from what the repo actually holds. */
            tsAnim: p('data/tilesets/primary/building/anim/tv_turned_on/0.png').label,
            mapPreview: p('graphics/map_preview/dotted_hole/tiles.png').label,
            backSheet: fits('graphics/trainers/back_pics/brendan.png', 64, 256),
            frontPic: fits('graphics/trainers/front_pics/brendan.png', 64, 64),
            deoxysBack: fits('graphics/pokemon/deoxys/back_gba.png', 64, 128),
            formIcon: p('graphics/pokemon/deoxys/icon_speed_wide.png').label,
            palImage: p('graphics/pokemon/pawmi/normal.png').label,
            // Alternate forms nest one folder deeper and must still resolve.
            formFront: p('graphics/pokemon/lapras/gmax/front.png').label,
            owWide: fits('graphics/pokemon/araquanid/overworld.png', 384, 64)
        };
    })()`);
    check('anim_front.png 64x128 accepted', profiles.animFits, JSON.stringify(profiles.anim));
    check('icon.png 32x64 accepted', profiles.iconFits);
    check('front.png 64x64 accepted', profiles.frontFits);
    check('footprint.png 16x16 accepted', profiles.footFits);
    check('_gba variants resolve to the same profile', profiles.gbaFits);
    check('tilesets recognised', profiles.tileset === 'Tileset', profiles.tileset);
    check('tileset animation frames are their own thing',
        profiles.tsAnim === 'Tileset animation frame', profiles.tsAnim);
    check('a map preview named tiles.png is not a tileset',
        profiles.mapPreview !== 'Tileset', profiles.mapPreview);
    check('trainer back pics are sheets, front pics are not',
        profiles.backSheet && profiles.frontPic);
    check('deoxys 64x128 back sheet accepted', profiles.deoxysBack);
    check('a form icon is not held to the standard icon box',
        profiles.formIcon === 'Pokémon form icon', profiles.formIcon);
    check('normal.png is read as a palette, not as artwork',
        profiles.palImage === 'Palette image', profiles.palImage);
    check('assets inside a form folder still resolve',
        profiles.formFront === 'Pokémon front sprite', profiles.formFront);
    check('overworld sheets are not held to one width', profiles.owWide);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
