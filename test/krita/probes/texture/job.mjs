import fs from 'fs'; import path from 'path'; import zlib from 'zlib';
import { renderKrita } from '../../render.mjs';
// Black-box probe: Krita's texture transfer. The pattern is a grey ramp whose
// value is its column (0..255, 256x256), so the painted alpha along a flat
// stroke is the transfer curve itself. One fresh Krita per variant.
//   node job.mjs [a,b,...] [--dry]   then   node ../probe-cdp.mjs texture   then   python measure.py
const root = path.resolve('test/krita/out/texture');
function rampPng() {
    const crc = b => { let c, t = [], k, n; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
        c = 0xFFFFFFFF; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
        const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
    const row = Buffer.alloc(1 + 256 * 3); for (let x = 0; x < 256; x++) row.fill(x, 1 + x * 3, 4 + x * 3);
    const raw = Buffer.concat(Array(256).fill(row));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const png = rampPng();
const p = (k, v) => '<param type="string" name="' + k + '"><![CDATA[' + v + ']]></param>';
const tex = (mode, policy, left, right, inv = 'false') => ['</Preset>', [
    p('Texture/Pattern/Enabled', 'true'), p('Texture/Pattern/Pattern', png), p('Texture/Pattern/Name', 'cdp-ramp.png'),
    p('Texture/Pattern/PatternFileName', 'cdp-ramp.png'), p('Texture/Pattern/Scale', '1'), p('Texture/Pattern/Strength', '1'),
    p('Texture/Pattern/TexturingMode', mode), p('Texture/Pattern/CutoffPolicy', policy), p('Texture/Pattern/CutoffLeft', left),
    p('Texture/Pattern/CutoffRight', right), p('Texture/Pattern/Invert', inv), p('Texture/Pattern/OffsetX', '0'),
    p('Texture/Pattern/OffsetY', '0'), p('Texture/Pattern/isRandomOffsetX', 'false'), p('Texture/Pattern/isRandomOffsetY', 'false'),
    p('Texture/Pattern/MaximumOffsetX', '0'), p('Texture/Pattern/MaximumOffsetY', '0'),
    p('Texture/Strength/Value', '1'), p('PressureTexture/Strength/', 'false'),
].join('') + '</Preset>'];
const val = (k, v) => ['(name="' + k + '"[^>]*>(?:<!\\[CDATA\\[)?)[^\\]<]+', '\\g<1>' + v];
const base = [val('PressureSize', 'false'), val('PressureOpacity', 'false')];
const V = {
    m0p0: tex(0, 0, 0, 255), m0p1: tex(0, 1, 64, 192), m0p2: tex(0, 2, 64, 192),
    m1p0: tex(1, 0, 0, 255), m1p1: tex(1, 1, 64, 192), m1p2: tex(1, 2, 64, 192),
    m1p0r: tex(1, 0, 64, 192), m1p1r159: tex(1, 1, 0, 159),
    // is the cutoff range tested before or after Invert, and is its fill?
    i0p1: tex(0, 1, 64, 192, 'true'), i0p2: tex(0, 2, 64, 192, 'true'),
    m0p1full: tex(0, 1, 0, 255),   // is 255 itself cut when right is 255?
};
const dry = process.argv.includes('--dry');
const arg = process.argv.slice(2).find(a => a !== '--dry');
const only = arg ? arg.split(',') : Object.keys(V);
// one wide flat stroke across the whole ramp
const lines = [[0, 60, 1, 300, 60, 1]];
for (const name of only) {
    const out = path.join(root, name);
    fs.mkdirSync(out, { recursive: true });
    const job = { width: 320, height: 120, out: out.split(path.sep).join('/'),
        renders: [{ name, preset: 'd) Ink-1 Precision', size: 80, lines, xmlSub: [...base, V[name]], dumpXml: false }] };
    fs.writeFileSync(path.join(out, 'job.json'), JSON.stringify(job, null, 1));
    if (dry) continue;
    renderKrita(path.join(out, 'job.json'));
    console.log(name, fs.readFileSync(path.join(out, 'harness.log'), 'utf8').split('\n').filter(l => /xmlSub|ERR|rror/.test(l)).map(l => l.replace(/.*: /, '')).join(' '));
}
