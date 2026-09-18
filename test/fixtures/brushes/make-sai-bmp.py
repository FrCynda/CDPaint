"""Build a SAI brush-shape .bmp the way SAI's own elemap files are drawn.

SAI keeps no brush file. A brush there is a row in a plain-text index
(`brushform.conf`, `brushtex.conf`, `papertex.conf`) naming a .bmp in one of
four folders -- elemap for the shape, blotmap for the speckle, brushtex and
papertex for grain -- so the .bmp is the whole of what is portable between
SAI and anything else.

The one thing a reader has to know is that the shapes are drawn on a
template: a white square with a pale blue guide circle and crosshair already
on it, the shape itself in plain grey. SAI ignores any pixel that is not a
grey, and read as ink the guide puts a faint ring round every stamp.

Measured from a real SAI resource folder: 24 elemap files, all 63x63 and all
24-bit, whose colours come to white, pure greys, and blues of the form
(n, n, 255).
"""
import struct, sys

W = H = 63
C = (W - 1) / 2
GUIDE = (255, 179, 179)          # BGR: the pale blue of SAI's template


def pixel(x, y):
    dx, dy = x - C, y - C
    r2 = dx * dx + dy * dy
    # The shape: a solid grey bar across the middle, in a grey SAI will read.
    if abs(dy) <= 6 and r2 < (C - 2) ** 2:
        return (0, 0, 0)
    # The template's guide circle and crosshair, which must be ignored.
    if abs(r2 - (C - 2) ** 2) < 40 or x == int(C) or y == int(C):
        return GUIDE
    return (255, 255, 255)


row = (W * 3 + 3) // 4 * 4
rows = []
for y in range(H - 1, -1, -1):           # a .bmp is written bottom row first
    line = b''.join(bytes(pixel(x, y)) for x in range(W))
    rows.append(line + b'\0' * (row - len(line)))
body = b''.join(rows)

head = (b'BM' + struct.pack('<IHHI', 14 + 40 + len(body), 0, 0, 14 + 40)
        + struct.pack('<IiiHHIIiiII', 40, W, H, 1, 24, 0, len(body), 2835, 2835, 0, 0))

out = sys.argv[1]
open(out, 'wb').write(head + body)
print(out, len(head) + len(body), 'bytes')
