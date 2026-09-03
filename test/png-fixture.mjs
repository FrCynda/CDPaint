/* Indexed PNGs, built by hand.
 *
 * The fixtures are built rather than downloaded so the browser suites run
 * offline and deterministically, but every shape and quirk they use is taken
 * from real pokeemerald files: 4bpp with tRNS on slot 0, 1bpp two-colour
 * footprints, 8bpp UI art, no-tRNS tilesets.
 *
 * `filter` picks the row filter, so a decoder's unfilter paths get exercised
 * and not just filter 0. `colorType` is 3 (palette) unless a test wants
 * greyscale (0), which gbagfx accepts and nothing may reject.
 */
import { deflateSync } from 'zlib';

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

export function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body));
    return Buffer.concat([len, body, crc]);
}

export function makePng({ w, h, depth, palette, trns, indices, filter = 0, colorType = 3 }) {
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
