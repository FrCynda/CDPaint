/* An indexed PNG, decoded in node.
 *
 * Test-only. The app never needs this — a browser hands it decoded pixels —
 * but checking the sprite-coordinate rules against a real decomp means reading
 * a few thousand real PNGs without one, and node's zlib is already here.
 *
 * Same unfilter as PaintEngine.decodePngIndices; returns null for anything it
 * cannot read exactly, so a test never measures a half-decoded image.
 */
import zlib from 'zlib';

export function readIndexedPng(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return null;

    let pos = 8, width = 0, height = 0, depth = 8, colorType = 0, interlace = 0;
    let trns = null, palette = null;
    const idat = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const start = pos + 8, end = start + len;
        if (end + 4 > buf.length && type !== 'IEND') break;
        if (type === 'IHDR') {
            width = buf.readUInt32BE(start);
            height = buf.readUInt32BE(start + 4);
            depth = buf[start + 8];
            colorType = buf[start + 9];
            interlace = buf[start + 12];
        } else if (type === 'IDAT') idat.push(buf.subarray(start, end));
        else if (type === 'PLTE') palette = buf.subarray(start, end);
        else if (type === 'tRNS') trns = buf.subarray(start, end);
        else if (type === 'IEND') break;
        pos = end + 4;
    }
    if (colorType !== 3 || interlace !== 0 || !idat.length) return null;
    if (![1, 2, 4, 8].includes(depth) || width <= 0 || height <= 0) return null;

    let raw;
    try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }

    const rowBytes = Math.ceil((width * depth) / 8);
    if (raw.length < height * (rowBytes + 1)) return null;

    const flat = new Uint8Array(height * rowBytes);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (rowBytes + 1)];
        const src = y * (rowBytes + 1) + 1;
        const cur = y * rowBytes, prev = cur - rowBytes;
        for (let x = 0; x < rowBytes; x++) {
            const a = x >= 1 ? flat[cur + x - 1] : 0;
            const b = y > 0 ? flat[prev + x] : 0;
            const c = (x >= 1 && y > 0) ? flat[prev + x - 1] : 0;
            let v = raw[src + x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            } else if (filter !== 0) return null;
            flat[cur + x] = v & 0xff;
        }
    }

    const indices = new Uint8Array(width * height);
    if (depth === 8) {
        for (let y = 0; y < height; y++) {
            indices.set(flat.subarray(y * rowBytes, y * rowBytes + width), y * width);
        }
    } else {
        const perByte = 8 / depth, mask = (1 << depth) - 1;
        for (let y = 0; y < height; y++) {
            const row = y * rowBytes, out = y * width;
            for (let x = 0; x < width; x++) {
                const shift = 8 - depth - (x % perByte) * depth;
                indices[out + x] = (flat[row + ((x / perByte) | 0)] >> shift) & mask;
            }
        }
    }

    /* Slot 0 unless tRNS names another. Index 0 is the decomp's convention and
       gbagfx's default; a tRNS with no fully transparent entry does not mean
       the sprite has no background, it means the file never said so. Treating
       that as "nothing is transparent" made 100 species measure as filling the
       whole frame, which is how this fallback got written down. */
    let transparentIndex = 0;
    if (trns) {
        for (let i = 0; i < trns.length; i++) {
            if (trns[i] === 0) { transparentIndex = i; break; }
        }
    }
    return { width, height, depth, indices, transparentIndex, palette, trns };
}
