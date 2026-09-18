"""Turn a real Krita preset's masking brush ON.

Krita's masking brush is a whole second preset stamped through the first as
an alpha mask, and every preset in David Revoy's bundles carries the entire
thing -- tip, spacing, sensors -- with `MaskingBrush/Enabled` sitting at
false. None of his 46 presets enables it, so there is no real file to read
that has it on.

Rather than write one from the format's description, this flips that single
flag in two of his own presets. Everything else, the nested preset included,
is exactly what Krita wrote:

  * masked-generated.kpp comes from eraser-kneaded-soft, whose masking brush
    GENERATES its tip (auto_brush + MaskGenerator) -- there is no image in
    the file, so the reader has to draw one;
  * masked-file.kpp comes from thin-brush-pointy, whose masking brush NAMES
    a tip (abominable_snowman.png) that is not inside the preset -- so the
    reader has to resolve it against the pack, exactly as it resolves the
    brush's own tip.
"""
import binascii, struct, sys, zlib, os

HERE = os.path.dirname(os.path.abspath(__file__))


def chunks(data):
    i = 8
    while i + 8 <= len(data):
        ln = struct.unpack('>I', data[i:i + 4])[0]
        typ = data[i + 4:i + 8]
        yield i, typ, data[i + 8:i + 8 + ln]
        i += 12 + ln


def rebuild(src, dst):
    data = open(src, 'rb').read()
    out = bytearray(data[:8])
    hits = 0
    for _, typ, body in chunks(data):
        if typ == b'zTXt':
            key, rest = body.split(b'\0', 1)
            text = zlib.decompress(rest[1:])
            if b'MaskingBrush/Enabled' in text:
                new = text.replace(
                    b'name="MaskingBrush/Enabled">false</param>',
                    b'name="MaskingBrush/Enabled">true</param>')
                if new == text:                      # the other spellings
                    new = text.replace(b'"MaskingBrush/Enabled" value="false"',
                                       b'"MaskingBrush/Enabled" value="true"')
                if new == text:
                    new = text.replace(
                        b'name="MaskingBrush/Enabled"><![CDATA[false]]>',
                        b'name="MaskingBrush/Enabled"><![CDATA[true]]>')
                if new != text:
                    hits += 1
                    text = new
                body = key + b'\0\0' + zlib.compress(text, 9)
        out += struct.pack('>I', len(body)) + typ + body
        out += struct.pack('>I', binascii.crc32(typ + body) & 0xffffffff)
    if not hits:
        raise SystemExit('no MaskingBrush/Enabled flag found in ' + src)
    open(dst, 'wb').write(bytes(out))
    print(dst, len(out), 'bytes')


rebuild(os.path.join(HERE, 'eraser-kneaded-soft.kpp'),
        os.path.join(HERE, 'masked-generated.kpp'))
rebuild(os.path.join(HERE, 'thin-brush-pointy.kpp'),
        os.path.join(HERE, 'masked-file.kpp'))
