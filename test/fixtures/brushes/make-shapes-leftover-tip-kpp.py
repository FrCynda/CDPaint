"""shapes-leftover-tip.kpp: shapes-alchemy.kpp carrying a tip it never uses.

Krita's Shapes engine stamps nothing, but a preset made from another one
keeps that one's brush definition. pablocazorla's Sketch Alchemy, Concept
Shader Flat and Draw Mask Vector carry exactly the line added here, naming
A-sparkle3.gbr, which no Krita ships; Krita paints them all the same.
"""
import binascii, struct, zlib, os

HERE = os.path.dirname(os.path.abspath(__file__))
LINE = (b' <param name="brush_definition" type="string"><![CDATA[<Brush scale="1" '
        b'type="gbr_brush" BrushVersion="2" filename="A-sparkle3.gbr" spacing="0.04" '
        b'angle="0"/>]]></param>')
data = open(os.path.join(HERE, 'shapes-alchemy.kpp'), 'rb').read()
out, i, hits = bytearray(data[:8]), 8, 0
while i + 8 <= len(data):
    ln, typ = struct.unpack('>I4s', data[i:i + 8])
    body = data[i + 8:i + 8 + ln]
    if typ == b'zTXt' and body.startswith(b'preset\0'):
        text = zlib.decompress(body[8:])
        j = text.index(b'>') + 1           # straight after <Preset ...>
        text = text[:j] + LINE + text[j:]
        hits += 1
        body = b'preset\0\0' + zlib.compress(text, 9)
    out += struct.pack('>I', len(body)) + typ + body
    out += struct.pack('>I', binascii.crc32(typ + body) & 0xffffffff)
    i += 12 + ln
assert hits == 1, hits
open(os.path.join(HERE, 'shapes-leftover-tip.kpp'), 'wb').write(out)
