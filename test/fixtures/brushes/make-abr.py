"""Build a .abr the way Photoshop CC writes one (version 10, subversion 2).

The three .abr files beside this one were written from the format's published
description and cover versions 2 and 6. Version 10 is what every brush pack
downloaded today actually is, and it differs in two ways that no document
describes and only a real file shows:

  * each brush in the `samp` section leads with a Pascal string holding a
    UUID, and the image header sits exactly 301 bytes into the block;
  * the brushes' real names are not in `samp` at all, and neither is a single
    one of their settings. Both live in a `desc` section, in a Photoshop
    descriptor that pairs each brush with the UUID of its sample: diameter,
    angle, roundness, spacing, scatter, and what drives each of them as you
    draw. Read nothing and a downloaded pack arrives as flat stamps.

Both were measured from two real packs -- 130 brushes between them, every one
with its header at 301 and exactly one name/UUID pair -- and neither pack may
be redistributed, so this rebuilds the layout instead.

Five deliberate awkwardnesses, because each is where a reader goes wrong:

  * one brush is stored raw and two are PackBits-compressed, per row;
  * the descriptor carries strings that are neither names nor UUIDs, so a
    reader that pairs "the string before a UUID" has to ignore them;
  * the last brush's UUID is missing from the descriptor, so it has to fall
    back to being numbered rather than being named after its neighbour;
  * the three names are not in the same order as the three samples;
  * keys come in both shapes -- four bare bytes, and a length with the
    characters, which is byte for byte the shape of a string.
"""
import struct, sys, os


def packbits(row):
    """PackBits, the run-length encoding Photoshop uses per row."""
    out, i, n = bytearray(), 0, len(row)
    while i < n:
        run = 1
        while i + run < n and run < 128 and row[i + run] == row[i]:
            run += 1
        if run > 1:
            out.append(257 - run)
            out.append(row[i])
            i += run
            continue
        lit = 1
        while (i + lit < n and lit < 128 and
               (i + lit + 1 >= n or row[i + lit] != row[i + lit + 1])):
            lit += 1
        out.append(lit - 1)
        out += row[i:i + lit]
        i += lit
    return bytes(out)


def sample(uuid, w, h, pixel, compress, gap=301):
    """One brush in the `samp` section: UUID, a block of settings we do
    not read, the bounds, then the image. The block is 301 bytes in an
    .abr and 47 in a .tpl's `tpbd` -- measured, both of them, from real
    files rather than from any description of the format."""
    rows = [bytes(pixel(x, y) for x in range(w)) for y in range(h)]

    head = bytearray()
    head.append(len(uuid))
    head += uuid.encode('ascii')
    head += b'\0' * (gap - len(head))          # the settings block
    head += struct.pack('>iiii', 0, 0, h, w)   # top, left, bottom, right
    head += struct.pack('>HB', 8, 1 if compress else 0)

    if compress:
        packed = [packbits(r) for r in rows]
        body = struct.pack('>%dH' % h, *[len(p) for p in packed]) + b''.join(packed)
    else:
        body = b''.join(rows)

    block = bytes(head) + body
    return struct.pack('>i', len(block)) + block + b'\0' * ((4 - len(block) % 4) % 4)


def ustr(s):
    """A descriptor string: a count of UTF-16 units including the
    terminator, then the units, big-endian."""
    return struct.pack('>I', len(s) + 1) + s.encode('utf-16-be') + b'\0\0'


def key(k):
    """A descriptor key: a zero length then four bytes, or a length and the
    characters when the name is longer. Real files use both, and the
    difference matters -- a length and characters is the same shape as a
    string, so a reader that hunts for strings finds keys instead."""
    return b'\0\0\0\0' + k if len(k) == 4 else struct.pack('>I', len(k)) + k


def text(k, s):
    return key(k) + b'TEXT' + ustr(s)


def dbl(k, v):
    return key(k) + b'doub' + struct.pack('>d', v)


def pct(k, v):
    """A number with a unit. Photoshop writes percentages, pixels and
    angles this way, and the unit is four characters of its own."""
    return key(k) + b'UntF' + b'#Prc' + struct.pack('>d', v)


def px(k, v):
    return key(k) + b'UntF' + b'#Pxl' + struct.pack('>d', v)


def ang(k, v):
    return key(k) + b'UntF' + b'#Ang' + struct.pack('>d', v)


def lng(k, v):
    return key(k) + b'long' + struct.pack('>i', v)


def flag(k, v):
    return key(k) + b'bool' + (b'\1' if v else b'\0')


def obj(cls, clsid, fields):
    """An object: its class name, its class id, then its own fields."""
    return b'Objc' + ustr(cls) + key(clsid) + struct.pack('>I', len(fields)) + b''.join(fields)


def field(k, value):
    return key(k) + value


def dynamics(control, jitter=0.0, minimum=0.0, steps=25):
    """A dial's dynamics: what drives it, how far down it can be driven,
    and how much plain randomness sits on top. `bVTy` is the driver --
    0 off, 1 fade, 2 pen pressure, 3 pen tilt, 5 rotation."""
    return obj('brushDynamics', b'Brsh', [
        lng(b'bVTy', control), lng(b'fStp', steps),
        pct(b'jitter', jitter), pct(b'Mnm ', minimum),
    ])


def brush(name, uuid, diameter, spacing, angle=0.0, roundness=100.0,
          interval=True, flip=(False, False), tip_dynamics=None,
          scatter=None, dual=None, flags=()):
    """One entry of the `desc` brush list, shaped like a real one: the
    shape's own dials in a nested `Brsh` object, everything that varies as
    you draw beside it."""
    shape = [
        px(b'Dmtr', diameter), ang(b'Angl', angle), pct(b'Rndn', roundness),
        text(b'Nm  ', name), pct(b'Spcn', spacing), flag(b'Intr', interval),
        flag(b'flipX', flip[0]), flag(b'flipY', flip[1]),
        text(b'sampledData', uuid),
    ]
    fields = [text(b'Nm  ', name), field(b'Brsh', obj('brush', b'Brsh', shape))]

    fields.append(flag(b'useTipDynamics', bool(tip_dynamics)))
    if tip_dynamics:
        size, angle_dyn, round_dyn = tip_dynamics
        fields += [field(b'szVr', dynamics(*size)),
                   key(b'angleDynamics') + dynamics(*angle_dyn),
                   key(b'roundnessDynamics') + dynamics(*round_dyn),
                   pct(b'minimumDiameter', 0.5), pct(b'minimumRoundness', 0.0)]

    fields.append(flag(b'useScatter', bool(scatter)))
    if scatter:
        spread, both, count = scatter
        fields += [key(b'scatterDynamics') + dynamics(0),
                   pct(b'Spcn', spread), flag(b'bothAxes', both),
                   dbl(b'Cnt ', count), key(b'countDynamics') + dynamics(0)]

    for k in (b'useTexture', b'usePaintDynamics', b'useColorDynamics',
              b'Wtdg', b'Nose', b'Rpt ', b'useBrushPose'):
        fields.append(flag(k, k in flags))
    if b'useColorDynamics' in flags:
        # How far the colour may wander. Written out in full, the way the
        # dials Photoshop added later are, rather than as four bare bytes.
        fields += [pct(b'hueJitter', 10.0), pct(b'saturationJitter', 25.0),
                   pct(b'brightnessJitter', 40.0)]
    dual_fields = [flag(b'useDualBrush', bool(dual))]
    if dual:
        duuid, ddia, dang, dspc = dual
        dual_fields.append(field(b'Brsh', obj('brush', b'Brsh', [
            px(b'Dmtr', ddia), ang(b'Angl', dang), pct(b'Rndn', 100.0),
            pct(b'Spcn', dspc), text(b'sampledData', duuid),
        ])))
        # How the second tip meets the first. Multiply is what carving is.
        dual_fields.append(key(b'BlnM') + b'enum' + key(b'BlnM') + key(b'Mltp'))
    fields.append(field(b'dualBrush', obj('dualBrush', b'Brsh', dual_fields)))
    return obj('brushPreset', b'Brsh', fields)


def descriptor(brushes):
    """`desc`: one descriptor holding a list of brushes. A list's entries
    carry no keys of their own -- only their type and their body."""
    out = struct.pack('>I', 16) + ustr('brushPreset') + key(b'BrsP')
    out += struct.pack('>I', 2)
    out += text(b'Ttl ', 'a pack of three')          # not a name
    out += key(b'Brsh') + b'VlLs' + struct.pack('>I', len(brushes))
    out += b''.join(brushes)
    return out


def pattern(name, w, h, pixel):
    """One paper texture, in the layout a .pat file uses: a header naming it
    and its size, then a "virtual memory array" per channel. Grey is one
    channel, and a channel can be marked absent, so the first written one is
    what a reader has to find rather than the first slot."""
    rows = [bytes(pixel(x, y) for x in range(w)) for y in range(h)]
    packed = [packbits(r) for r in rows]
    data = (struct.pack('>%dH' % h, *[len(p) for p in packed]) + b''.join(packed))

    chan = (struct.pack('>I', 8)                       # pixel depth, as a long
            + struct.pack('>iiii', 0, 0, h, w)
            + struct.pack('>HB', 8, 1) + data)         # depth, PackBits, rows
    arrays = (struct.pack('>I', 0)                     # a channel not written
              + struct.pack('>II', 1, len(chan)) + chan)
    vmal = (struct.pack('>I', 3) + struct.pack('>I', len(arrays) + 20)
            + struct.pack('>iiii', 0, 0, h, w) + struct.pack('>I', 1) + arrays)

    body = (struct.pack('>I', 1) + struct.pack('>I', 1)   # version, grey mode
            + struct.pack('>HH', h, w) + ustr(name)
            + bytes([len('pat-1')]) + b'pat-1' + vmal)
    return struct.pack('>I', len(body)) + body + b'\0' * ((4 - len(body) % 4) % 4)


def section(k, body):
    return b'8BIM' + k + struct.pack('>I', len(body)) + body


DOT = lambda cx, cy, r: (lambda x, y: 255 if (x - cx) ** 2 + (y - cy) ** 2 < r * r else 0)
BAR = lambda x, y: 255 if 4 <= y < 12 else 0
DIAG = lambda x, y: 255 if abs(x - y) < 3 else 0
WEAVE = lambda x, y: 40 + 200 * ((x // 4 + y // 4) % 2)

SAMPLES = [
    # uuid,                                   w,  h, pixels,       compressed
    ('11111111-1111-4111-8111-111111111111', 32, 32, DOT(16, 16, 12), True),
    ('22222222-2222-4222-8222-222222222222', 24, 16, BAR,             False),
    ('33333333-3333-4333-8333-333333333333', 20, 20, DIAG,            True),
]

# Out of order on purpose, and the third sample's UUID is absent.
BRUSHES = [
    # The bar is a plain stamp: no dynamics, no scatter, and it does not
    # step at all -- `Intr` off is Photoshop's "as fast as the pointer moves".
    brush('a bar', '22222222-2222-4222-8222-222222222222',
          diameter=24, spacing=200, interval=False, flip=(True, False)),
    # The blob uses most of what a real brush uses: pressure on its size,
    # a small angle wobble, a roundness that fades away over forty dabs,
    # scatter on both axes, several dabs a step, and three features we
    # cannot do and must name rather than swallow.
    brush('a blob', '11111111-1111-4111-8111-111111111111',
          diameter=150, spacing=9, angle=30, roundness=50,
          tip_dynamics=((2, 0.0, 20.0), (0, 4.0, 0.0), (1, 0.0, 30.0, 40)),
          scatter=(60.0, True, 3.0),
          # The second tip is the third sample -- the one the descriptor has
          # no brush of its own for. A dual brush names its tip exactly the
          # way a brush names its own, so a reader that resolves one resolves
          # both, and a tip nobody else claims is still a real picture.
          dual=('33333333-3333-4333-8333-333333333333', 75.0, 15.0, 140.0),
          flags=(b'useTexture', b'useColorDynamics', b'Wtdg')),
]

out = sys.argv[1]

if out.lower().endswith('.tpl'):
    # A Photoshop tool preset file: a saved tool rather than a saved brush,
    # but a saved paintbrush carries the whole brush with it, so the same
    # two halves turn up under different names -- `tpbd` for the tip
    # pictures and `tptp` for the dials. Measured from three real files,
    # one Photoshop's own and two out of a GrutBrushes pack, all version 3.
    #
    # Three things here are what a reader has to survive:
    #
    #   * the settings block in front of each tip is 47 bytes, not 301;
    #   * the descriptor is keyed `PbTl` -- the paintbrush tool -- and the
    #     framing in front of it differs from tool to tool, so it has to be
    #     found by its own shape rather than counted to;
    #   * another tool preset sits in front of it that is not a brush at
    #     all, and must be stepped over rather than read as one.
    #
    # A tool preset also carries what an .abr never does: the opacity, the
    # flow and the blend mode the tool was saved at.
    def block(k, body):
        return b'8BIM' + k + struct.pack('>I', len(body)) + body

    def preset(name, fields):
        return (ustr(name) + struct.pack('>I', 16) + ustr('')
                + key(b'PbTl') + struct.pack('>I', len(fields)) + b''.join(fields))

    tips = b''.join(sample(u, w, h, p, c, gap=47) for u, w, h, p, c in SAMPLES[:2])

    brush_fields = [
        field(b'Brsh', obj('brush', b'Brsh', [
            px(b'Dmtr', 60.0), ang(b'Angl', 0.0), pct(b'Rndn', 100.0),
            text(b'Nm  ', 'a saved blob'), pct(b'Spcn', 12.0), flag(b'Intr', True),
            text(b'sampledData', SAMPLES[0][0]),
        ])),
        pct(b'flow', 19.0), pct(b'Opct', 80.0),
        key(b'Md  ') + b'enum' + key(b'BlnM') + key(b'Mltp'),
        flag(b'useTipDynamics', True),
        field(b'szVr', dynamics(2, 0.0, 20.0)),
        key(b'angleDynamics') + dynamics(0),
        key(b'roundnessDynamics') + dynamics(0),
        pct(b'minimumDiameter', 20.0), pct(b'minimumRoundness', 0.0),
        flag(b'useScatter', False),
    ]
    for k in (b'useTexture', b'usePaintDynamics', b'useColorDynamics',
              b'Wtdg', b'Nose', b'Rpt ', b'useBrushPose'):
        brush_fields.append(flag(k, False))
    brush_fields.append(field(b'dualBrush',
                              obj('dualBrush', b'Brsh', [flag(b'useDualBrush', False)])))

    other = (ustr('a gradient') + struct.pack('>I', 16) + ustr('')
             + key(b'GrdT') + struct.pack('>I', 1) + pct(b'Opct', 100.0))

    data = (b'8BTP' + struct.pack('>II', 3, 3)
            + block(b'tppa', ustr('a pack of one'))
            + block(b'tpbd', tips)
            + block(b'tptp', struct.pack('>I', 2) + other
                    + preset('a saved blob', brush_fields)))
else:
    body = b''.join(sample(u, w, h, p, c) for u, w, h, p, c in SAMPLES)
    data = (struct.pack('>HH', 10, 2)
            + section(b'samp', body)
            + section(b'patt', pattern('a weave', 16, 16, WEAVE))
            + section(b'desc', descriptor(BRUSHES)))

open(out, 'wb').write(data)
print(out, len(data), 'bytes')
