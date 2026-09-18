"""Write a preset the way Krita writes its bigger ones: a compressed iTXt
chunk, with a pattern checksum stored as RAW BYTES inside CDATA.

Eight of the forty-six presets in David Revoy's 25.01 bundle are like this,
and every one of them was arriving as "could not be read" -- 17 per cent of
the pack, silently left out of the import. Two separate things have to be
right for them:

  * the settings live in `iTXt`, not `zTXt` -- a different header, and the
    text deflated after a language tag and a translated keyword;
  * `Texture/Pattern/PatternMD5` holds the sixteen bytes of an md5, not its
    hex. Several of those bytes are C0 control characters, which XML does
    not allow anywhere at all, so a parser stops dead at the first one --
    "CData section not finished" -- and takes the whole preset with it.

This rebuilds thin-brush-pointy that way: same settings, moved chunk, plus
the checksum param a textured preset carries.
"""
import binascii, struct, zlib, os

HERE = os.path.dirname(os.path.abspath(__file__))
MD5 = bytes(range(1, 17))          # control characters on purpose


def chunks(data):
    i = 8
    while i + 8 <= len(data):
        ln = struct.unpack('>I', data[i:i + 4])[0]
        yield data[i + 4:i + 8], data[i + 8:i + 8 + ln]
        i += 12 + ln


def itxt(key, text):
    # keyword \0 compressed \0 method \0 language \0 translated \0 deflated
    return (key + b'\0\1\0UTF-8\0' + key + b'\0' + zlib.compress(text, 9))


def rebuild(src, dst):
    data = open(src, 'rb').read()
    out = bytearray(data[:8])
    moved = 0
    for typ, body in chunks(data):
        if typ == b'zTXt':
            key, rest = body.split(b'\0', 1)
            text = zlib.decompress(rest[1:])
            if key == b'preset':
                text = text.replace(b'</Preset>',
                    b' <param name="Texture/Pattern/PatternMD5" type="string">'
                    b'<![CDATA[' + MD5 + b']]></param> </Preset>')
                typ, body, moved = b'iTXt', itxt(key, text), 1
        out += struct.pack('>I', len(body)) + typ + body
        out += struct.pack('>I', binascii.crc32(typ + body) & 0xffffffff)
    if not moved:
        raise SystemExit('no preset chunk found in ' + src)
    open(dst, 'wb').write(bytes(out))
    print(dst, len(out), 'bytes')


rebuild(os.path.join(HERE, 'thin-brush-pointy.kpp'),
        os.path.join(HERE, 'itxt-binary-md5.kpp'))
