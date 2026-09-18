"""Build a .sut the way Clip Studio Paint lays one out.

A .sut IS a SQLite database, so this writes one with Python's own sqlite3 --
an encoder with nothing to do with the reader under test. Table and column
names, and the meaning of the values, are copied from a real sub tool; the
schema here is a subset, because the reader looks columns up by name.

Six things are deliberately awkward, because each is where a reader goes
wrong:

  * the material blob is far bigger than a page, so its record spills onto
    overflow pages and has to be chained back together;
  * that blob holds two PNGs, a decoy first and the material last, the way a
    real one holds the .layer bitmap before the thumbnail;
  * one dial is driven by two inputs at once, only one of which we can name,
    so the reader has to take that one and own up to the other;
  * one effector blob is not an effector at all, and must be ignored rather
    than thrown over;
  * the materials are NOT in the order the brush names them -- the paper
    texture is stored last and the two tips first -- so a reader that takes
    "the first material" paints with the paper. Which picture is which is
    settled by a catalogue path that both the material row and the brush's
    own reference carry;
  * the second tip is a material of its own, named from the Dual column
    family rather than from the brush's.

Two smaller files come out of the same script, because both are cases a
reader meets in practice:

    python make-sut.py rough-scrape.sut          # the brush above
    python make-sut.py pixel-select.sut tool     # not a brush at all
    python make-sut.py library-tips.sut library  # pictures with no path

The "tool" one is a selection tool: same tables, same Node, and a Variant
with none of the brush columns in it. The "library" one names pictures that
live inside Clip Studio rather than in the file, so its material rows carry
no catalogue path and the order is all a reader has.
"""
import sqlite3, struct, zlib, sys, os


def png(w, h, pixel):
    """A tiny RGBA PNG, written by hand -- no encoder needed."""
    raw = b''.join(bytes([0]) + b''.join(bytes(pixel(x, y)) for x in range(w))
                   for y in range(h))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff))

    return (bytes([137, 80, 78, 71, 13, 10, 26, 10])
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))


DECOY = png(8, 8, lambda x, y: (255, 0, 0, 255))
TIP = png(96, 96, lambda x, y: (0, 0, 0, 255 if (x - 48) ** 2 + (y - 48) ** 2 < 1900 else 0))
TIP2 = png(96, 96, lambda x, y: (0, 0, 0, 255 if abs(x - y) < 30 else 0))
DUAL = png(48, 48, lambda x, y: (0, 0, 0, 255 if (x // 6 + y // 6) % 2 else 0))
TEXTURE = png(64, 64, lambda x, y: (0, 0, 0, 255 if (x // 4 + y // 4) % 2 else 30))

# Catalogue paths, in the shape Clip Studio writes them.
CAT = {
    'scrape a': '.:11:22:aaaaaaaaaa-1111-2222-3333-444444444a',
    'scrape b': '.:11:22:bbbbbbbbbb-1111-2222-3333-444444444b',
    'dual dots': '.:33:44:cccccccccc-1111-2222-3333-444444444c',
    'rough paper': '.:55:66:dddddddddd-1111-2222-3333-444444444d',
}


def u32(v):
    return struct.pack('>I', v)


def w16(s):
    return s.encode('utf-16-le')


def ref(entries):
    """How a Variant names the pictures it uses.

    Measured from real sub tools, byte for byte: a word of 8, the number of
    pictures, then one record each. A record is its own length counted from
    where the length sits, the material's path inside the file, then tagged
    fields -- 2 is the material's name, 1 is its catalogue path, 0 ends it.
    Every string is UTF-16, little end first, with its length in bytes.

    The catalogue path is the one that matters: the MaterialFile row carries
    the same string, and that is what pairs a picture with its use.
    """
    recs = b''
    for name, cat in entries:
        dpath = cat + ':data:material_0.layer'
        body = (u32(len(dpath) * 2) + w16(dpath)
                + u32(2) + u32(len(name) * 2) + w16(name)
                + u32(1) + u32(len(cat) * 2) + w16(cat)
                + u32(0))
        recs += u32(len(body) + 4) + body
    return u32(8) + u32(len(entries)) + recs


def material(img):
    """A tar-shaped blob: filler, a decoy bitmap, then the thumbnail last."""
    return b'data/material.layer\0' + DECOY + (b'\0' * 9000) + \
           b'thumbnail/thumbnail.png\0' + img


def effector(floor, records, family=240, flags=0, top=500):
    """One "effector": the blob that says how a dial answers the pen.

    A 44-byte header, then up to two records whose byte lengths the header
    carries -- so the header, plus those two lengths, has to come to the blob
    exactly, and a reader that has drifted knows it. A record is
    [12][which input][16] and then its points, as pairs of big-endian doubles
    already between 0 and 1.
    """
    bodies = []
    for input_id, points in records:
        body = struct.pack('>III', 12, input_id, 16)
        for x, y in points:
            body += struct.pack('>dd', x, y)
        bodies.append(body)
    while len(bodies) < 2:
        bodies.append(b'')
    head = struct.pack('>11i', 44, family, flags, floor, 100, 0, 0, 0,
                       len(bodies[0]), len(bodies[1]), top)
    return head + bodies[0] + bodies[1]


NODE = {
    'NodeName': 'Rough Scrape',
    'NodeVariantID': 801,        # the live settings
    'NodeInitVariantID': 802,    # the defaults it resets to; must be ignored
}

LIVE = {
    'VariantID': 801,
    'Opacity': 100,
    'BrushSize': 80.0,
    'BrushFlow': 91,
    'BrushHardness': 100,
    'BrushInterval': 10.0,
    'BrushThickness': 16,             # a blade six times longer than wide
    'BrushRotation': 220.0,
    'BrushRotationEffector': 3,       # a rule we do not read
    # Flow follows the pen, along a curve that is not a straight line.
    'BrushFlowEffector': effector(0, [(2, [(0, 0), (0.25, 0.6), (1, 1)])]),
    # Size is driven by two things at once, and only one of them is pressure:
    # the one we know wins and the other has to be owned up to.
    'BrushSizeEffector': effector(10, [(7, [(0, 1), (0.8, 0)]),
                                       (2, [(0, 0.2), (1, 1)])]),
    # Spray has a curve for an input we cannot name at all.
    'BrushSpraySizeEffector': effector(0, [(9, [(0, 0), (1, 1)])]),
    # And one blob is simply not a curve, which must not throw.
    'BrushOpacityEffector': b'not an effector at all',
    'BrushUsePatternImage': 1,
    'BrushUseSpray': 1,
    'BrushSpraySize': 14.1,           # pixels, against a size of 80
    'BrushUseIn': 1,
    'BrushInRatio': 30.0,
    'BrushUseOut': 0,                 # off: no end taper
    'BrushOutRatio': 30.0,
    'BrushPatternImageArray': ref([('scrape a', CAT['scrape a']),
                                   ('scrape b', CAT['scrape b'])]),
    'TextureImage': ref([('rough paper', CAT['rough paper'])]),
    'TextureDensity': 50,
    'TextureScale2': 37.0,
    'BrushUseWaterColor': 1,
    'BrushUseWaterColor2': 1,
    'BrushMixColor': 50,
    # How far past the dab it reaches for the colour it mixes.
    'BrushMixColorExtension': 60,
    'BrushRotationRandomScale': 100,
    'BrushBlur': 5.0,
    # A second tip, which is a brush of its own: its own picture, size,
    # spacing, turn and flow, stamped into the first one.
    'UseDualBrush': 1,
    'DualUsePatternImage': 1,
    'DualPatternImageArray': ref([('dual dots', CAT['dual dots'])]),
    'DualSize': 30.0,                 # pixels, against a size of 80
    'DualFlow': 60,
    'DualInterval': 120.0,
    'DualRotation': 45.0,
    'DualBrushCompositeMode': 3,      # not a darkening one: must be reported
    'DualUseSpray': 0,
    # Colour that wanders: a range either side, hue in degrees and the rest
    # as percentages, and a negative range is still a range.
    'BrushHueChange': 30,
    'BrushSaturationChange': -20,
    'BrushValueChange': 0,
    # Asked for per stroke as well, and a brush gets one or the other.
    'BrushChangeStrokeColor': 1,
    'BrushStrokeHueChange': 90,
    'BrushRibbon': 0,
}

# What the brush resets to. Nothing here may reach the imported preset.
DEFAULTS = dict(LIVE, VariantID=802, BrushSize=7.0, BrushRotation=0.0,
                BrushThickness=100, BrushUseSpray=0, BrushUseIn=0)

KIND = sys.argv[2] if len(sys.argv) > 2 else 'brush'

if KIND == 'tool':
    # A selection tool. Same tables, same Node, and a Variant without one
    # brush column in it -- nothing here could ever paint a dab.
    NODE = {'NodeName': 'Pixel Select', 'NodeVariantID': 2830,
            'NodeInitVariantID': 2831}
    LIVE = {'VariantID': 2830, 'Opacity': 100, 'AntiAlias': 0,
            'SelectFillTargetType': 1, 'SelectAreaScalingSize': 0}
    DEFAULTS = dict(LIVE, VariantID=2831, AntiAlias=1)

if KIND == 'library':
    # Two more things a real brush does, on the file that already has to be
    # built by hand: the markers and the flat watercolour brushes leave both
    # UseWaterColor switches off and set BrushWaterColor instead, and the
    # rotation mask carries the random bit, scaled down to a quarter turn.
    OVER = dict(BrushUseWaterColor=0, BrushUseWaterColor2=0, BrushWaterColor=2,
                BrushRotationEffector=131, BrushRotationRandomScale=25)
    LIVE = dict(LIVE, **OVER)
    DEFAULTS = dict(DEFAULTS, **OVER)

out = sys.argv[1]
if os.path.exists(out):
    os.remove(out)
con = sqlite3.connect(out)

con.execute('CREATE TABLE Node(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, '
            'NodeName TEXT DEFAULT NULL, NodeVariantID INTEGER DEFAULT NULL, '
            'NodeInitVariantID INTEGER DEFAULT NULL)')
con.execute('INSERT INTO Node(NodeName, NodeVariantID, NodeInitVariantID) VALUES(?,?,?)',
            (NODE['NodeName'], NODE['NodeVariantID'], NODE['NodeInitVariantID']))

cols = list(LIVE)
con.execute('CREATE TABLE Variant(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, '
            + ', '.join(c + ' DEFAULT NULL' for c in cols) + ')')
# The defaults row is written FIRST, so taking "the first row" is wrong.
for row in (DEFAULTS, LIVE):
    con.execute('INSERT INTO Variant(' + ','.join(cols) + ') VALUES('
                + ','.join('?' * len(cols)) + ')', [row[c] for c in cols])

con.execute('CREATE TABLE MaterialFile(_PW_ID INTEGER PRIMARY KEY AUTOINCREMENT, '
            'InstallFolder INTEGER DEFAULT NULL, OriginalPath TEXT DEFAULT NULL, '
            'CatalogPath TEXT DEFAULT NULL, FileData BLOB DEFAULT NULL)')
# Deliberately NOT the order the brush names them: the paper texture the
# brush lists first is stored last. Only the catalogue path pairs them up.
MATERIALS = (
    () if KIND == 'tool' else
    # A library brush has no paths at all, and there the order IS the answer,
    # so that one is stored the way the brush names them.
    (('rough paper', TEXTURE), ('scrape a', TIP),
     ('scrape b', TIP2), ('dual dots', DUAL)) if KIND == 'library' else
    (('scrape a', TIP), ('scrape b', TIP2),
     ('dual dots', DUAL), ('rough paper', TEXTURE)))
for name, img in MATERIALS:
    cat = '' if KIND == 'library' else CAT[name]
    con.execute('INSERT INTO MaterialFile(InstallFolder, OriginalPath, '
                'CatalogPath, FileData) VALUES(0, "", ?, ?)',
                (cat, material(img)))

con.commit()
con.close()
print(out, os.path.getsize(out), 'bytes')
