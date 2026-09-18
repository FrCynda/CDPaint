"""Build a .brushset the way Procreate lays one out.

The settings dictionary is written through Python's plistlib in the
NSKeyedArchiver shape Procreate uses, so the binary-plist half of the reader
is checked against an independent encoder rather than against bytes we typed.
"""
import plistlib, zipfile, struct, zlib, sys, os


def png(w, h, pixel):
    """A tiny RGBA PNG, written by hand -- no encoder needed."""
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            row += bytes(pixel(x, y))
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    return (bytes([137, 80, 78, 71, 13, 10, 26, 10])
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


def archive(settings):
    """NSKeyedArchiver's flat $objects layout: every value is a reference."""
    objects = ['$null']
    def add(v):
        objects.append(v)
        return plistlib.UID(len(objects) - 1)

    keys, vals = [], []
    for k, v in settings.items():
        keys.append(add(k))
        vals.append(add(v))
    root = add({'$class': plistlib.UID(0), 'keys': keys, 'values': vals})
    # Procreate keeps the settings as a plain dictionary at the root; the
    # reader walks whatever shape it finds, so mirror the simple case too.
    flat = {}
    for k, v in settings.items():
        flat[k] = add(v)
    root = add(flat)
    return plistlib.dumps({'$version': 100000, '$archiver': 'NSKeyedArchiver',
                           '$top': {'root': root}, '$objects': objects},
                          fmt=plistlib.FMT_BINARY)


SHAPE = png(48, 48, lambda x, y: (0, 0, 0, 255 if (x - 24) ** 2 + (y - 24) ** 2 < 500 else 0))
GRAIN = png(32, 32, lambda x, y: (0, 0, 0, 255 if (x + y) % 4 < 2 else 40))

BRUSHES = {
    'Rough Ink': {
        'name': 'Rough Ink',
        'paintOpacity': 1.0,
        'plotSpacing': 0.06,
        'plotJitter': 0.25,
        'shapeAngle': 0.7853981633974483,     # 45 degrees, in radians
        'shapeRandomise': False,
        'shapeScatter': 0.0,
        'shapeRoundness': 0.5,                # a blade twice as long as wide
        'grainDepth': 0.8,
        'textureZoom': 0.5,
        'taperStartLength': 0.4,
        'taperEndLength': 0.2,
        'dynamicsPressureSize': 1.0,
        'dynamicsPressureOpacity': 0.5,
        'dynamicsMix': 0.0,                   # off, so it must not be reported
        'dynamicsBlur': 0.3,                  # on, so it must be
        'dynamicsTiltShapeRoundness': 1.0,    # neutral at 1: not a feature
        'smudgeOpacity': 1.0,                 # a remembered slider, not a feature
        'dynamicsPressureBleedSpeed': 0.4,    # a response rate, not a feature
        'shapeRoundnessTiltAngle': 0.1,       # ends in "Angle" and is not one
        # The shape of the pressure response, not its depth. Procreate draws
        # it as a list of "{x, y}" strings.
        'dynamicsPressureSizeCurve': {'points': {'NS.objects':
            ['{0.000000, 0.000000}', '{0.500000, 0.800000}', '{1.000000, 1.000000}']}},
        # A straight line is what an untouched dial holds; saying so is the
        # same as saying nothing, so it must not be carried across.
        'dynamicsPressureOpacityCurve': {'points': {'NS.objects':
            ['{0.000000, 0.000000}', '{1.000000, 1.000000}']}},
        'taperSize': 1.0,                     # the taper thins the line
        'taperOpacity': 0.0,                  # and does not fade it
        'plotSmoothing': 0.35,                # StreamLine, which is our stabilizer
        'blendMode': 2,                       # a mode we have no reference for
        # Colour that wanders per dab. Lightness and darkness are two halves
        # of one dial here, so the larger of them is the one that counts.
        'dynamicsJitterHue': 0.25,
        'dynamicsJitterSaturation': 0.0,
        'dynamicsJitterLightness': 0.1,
        'dynamicsJitterDarkness': 0.4,
        # Asked for per stroke as well; a brush gets one or the other, so
        # this one has to end up in the warnings.
        'dynamicsJitterStrokeHue': 0.5,
    },
    'Soft Wash': {
        'name': 'Soft Wash',
        'plotSpacing': 0.2,
        'shapeRandomise': True,
        'grainDepth': 0.0,
        'dynamicsPressureSize': 0.0,
        'paintOpacity': 0.4,
        # Nothing from the pen, so the way the pen is HELD drives the size
        # instead -- and then there is nothing left to report as dropped.
        'dynamicsTiltSize': 0.75,
        # Speed is there too, but a dial can only be driven by one thing, so
        # this one has to stay in the warnings.
        'dynamicsSpeedSize': 0.5,
        'shapeInverted': True,                # the shape is cut the other way
        # Wet mix, with the pen driving it, and a dab flipped at random every
        # time it lands.
        'dynamicsMix': 0.75,
        'dynamicsPressureMix': 0.5,
        'shapeFlipXJitter': 1.0,
        # Nothing per dab, so the per-stroke set is the one that lands.
        'dynamicsJitterStrokeSaturation': 0.6,
    },
}

out = sys.argv[1]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, settings in BRUSHES.items():
        d = name.replace(' ', '_') + '.brush'
        z.writestr(d + '/Brush.archive', archive(settings))
        z.writestr(d + '/Shape.png', SHAPE)
        if settings.get('grainDepth'):
            z.writestr(d + '/Grain.png', GRAIN)
    z.writestr('brushset.plist', plistlib.dumps(
        {'name': 'Test Set', 'brushes': list(BRUSHES)}, fmt=plistlib.FMT_BINARY))
print(out, os.path.getsize(out), 'bytes')
