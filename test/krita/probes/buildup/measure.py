import os, sys
from PIL import Image
root = os.path.dirname(os.path.abspath(__file__))
P = [1, 0.75, 0.5, 0.25]
for name in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))):
    f = os.path.join(root, name, name + '.png')
    if not os.path.exists(f): continue
    px = Image.open(f).convert('RGBA').load()
    row = []
    for i, p in enumerate(P):
        y = 30 + i * 50
        line = max(px[x, y][3] for x in range(150, 250))
        dab = max(px[x, yy][3] for x in range(420, 445) for yy in range(y - 8, y + 9))
        row.append('p%.2f line %3d dab %3d' % (p, line, dab))
    print('%-12s' % name, ' | '.join(row))
