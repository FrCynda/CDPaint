"""Write a Krita pack whose preset takes its tip out of a Photoshop set.

Krita names such a tip "<set>_<n>" in the preset's brush definition and keeps
no picture of it there: the picture is the n-th tip (counted from 1) in
<set>.abr, shipped beside the preset. Portnov's pastel pack has four presets
like this, and every one came in as a plain square (or not at all).

This is thin-brush-pointy with its tip swapped for three-tips-v10.abr's
second, zipped with that .abr as a bundle.
"""
import binascii, struct, zlib, os, re, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
TIP = b'<Brush type="abr_brush" filename="three-tips-v10_2" name="three-tips-v10_2" scale="1" spacing="0.1" angle="0" useAutoSpacing="0" autoSpacingCoeff="1" BrushVersion="2"/>'


def chunks(data):
    i = 8
    while i + 8 <= len(data):
        ln = struct.unpack('>I', data[i:i + 4])[0]
        yield data[i + 4:i + 8], data[i + 8:i + 8 + ln]
        i += 12 + ln


def kpp():
    data = open(os.path.join(HERE, 'thin-brush-pointy.kpp'), 'rb').read()
    out = bytearray(data[:8])
    done = 0
    for typ, body in chunks(data):
        if typ == b'zTXt':
            key, rest = body.split(b'\0', 1)
            if key == b'preset':
                text = zlib.decompress(rest[1:])
                text, done = re.subn(rb'(name="brush_definition"[^>]*><!\[CDATA\[).*?(\]\]>)',
                                     lambda m: m.group(1) + TIP + m.group(2), text, flags=re.S)
                text = re.sub(rb'(<Preset[^>]*name=")[^"]*', rb'\g<1>Abr Tip', text)
                body = key + b'\0\0' + zlib.compress(text, 9)
        out += struct.pack('>I', len(body)) + typ + body
        out += struct.pack('>I', binascii.crc32(typ + body) & 0xffffffff)
    if not done:
        raise SystemExit('no brush definition found')
    return bytes(out)


dst = os.path.join(HERE, 'abr-tip-pack.bundle')
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('mimetype', 'application/x-krita-resourcebundle', zipfile.ZIP_STORED)
    z.writestr('paintoppresets/abr-tip.kpp', kpp())
    z.write(os.path.join(HERE, 'three-tips-v10.abr'), 'brushes/three-tips-v10.abr')
print(dst, os.path.getsize(dst), 'bytes')
