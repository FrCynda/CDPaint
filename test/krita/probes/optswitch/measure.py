import os
from PIL import Image
# Per constant-pressure line: peak alpha and painted width, Krita (K) vs CDPaint (C).
root = os.path.dirname(os.path.abspath(__file__))
P = [1, 0.5, 0.25]
for name in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))):
    for tag, f in (('K', name + '.png'), ('C', 'cdp.png')):
        f = os.path.join(root, name, f)
        if not os.path.exists(f): continue
        px = Image.open(f).convert('RGBA').load()
        row = []
        for i, p in enumerate(P):
            y = 40 + i * 60
            peak = max(px[x, y][3] for x in range(150, 300))
            width = sum(1 for yy in range(y - 29, y + 30) if px[220, yy][3] > 20)
            row.append('p%.2f peak %3d w %2d' % (p, peak, width))
        print('%-24s %s  ' % (name, tag) + ' | '.join(row))
