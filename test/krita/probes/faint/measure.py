import os
from PIL import Image
# Alpha across the line (centre to edge) in the flat middle, Krita (K) vs CDPaint (C).
root = os.path.dirname(os.path.abspath(__file__))
for name in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))):
    for tag, f in (('K', name + '.png'), ('C', 'cdp.png')):
        f = os.path.join(root, name, f)
        if not os.path.exists(f): continue
        px = Image.open(f).convert('RGBA').load()
        col = [max(px[x, 40 + dy][3] for x in range(200, 210)) for dy in range(0, 13)]
        ink = sum(px[x, y][3] for x in range(100, 300) for y in range(20, 61)) / 200
        print('%-5s %s ink/col %6.1f  centre->edge %s' % (name, tag, ink, col))
