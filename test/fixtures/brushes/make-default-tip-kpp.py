"""default-tip.kpp: thin-brush-pointy.kpp naming one of Krita's own tips.

Packs built on Krita's default resources name tips from its default bundles
without carrying them (GDQuest, walseb, pablocazorla in the holdout bank).
This swaps the one tip name in a real preset, bristle.png, for
bristles_chisel_dense.png from Krita_4_Default_Resources.bundle, which we
ship in src/brushes/krita/ and nowhere else. Everything else is as Krita
wrote it.
"""
import binascii, re, struct, zlib, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = open(os.path.join(HERE, 'thin-brush-pointy.kpp'), 'rb').read()
out, i, hits = bytearray(data[:8]), 8, 0
while i + 8 <= len(data):
    ln, typ = struct.unpack('>I4s', data[i:i + 8])
    body = data[i + 8:i + 8 + ln]
    if typ == b'zTXt':
        key, rest = body.split(b'\0', 1)
        text = zlib.decompress(rest[1:])
        # the preset also carries its tip inside it; drop that copy too, so
        # the name is all that is left, as in the packs that lean on Krita's
        new = re.sub(rb'<resources>.*?</resources>', b'', text, flags=re.S)
        new = new.replace(b'embedded_resources="1"', b'embedded_resources="0"')
        new = new.replace(b'bristle.png', b'bristles_chisel_dense.png')
        hits += new != text
        body = key + b'\0\0' + zlib.compress(new, 9)
    out += struct.pack('>I', len(body)) + typ + body
    out += struct.pack('>I', binascii.crc32(typ + body) & 0xffffffff)
    i += 12 + ln
assert hits == 1, hits
open(os.path.join(HERE, 'default-tip.kpp'), 'wb').write(out)
