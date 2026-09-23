import os, math
from PIL import Image
# Mean alpha over the middle of each constant-pressure line -> dabs per pixel -> gap.
root = os.path.dirname(os.path.abspath(__file__))
P = [1, 0.5, 0.2, 0.1, 0.05, 0.02]
for name in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))):
    for tag, f in (('K', name + '.png'), ('C', 'cdp.png')):
        f = os.path.join(root, name, f)
        if not os.path.exists(f): continue
        px = Image.open(f).convert('RGBA').load()
        row = []
        for i, p in enumerate(P):
            a = sum(px[x, 30 + i * 40][3] for x in range(150, 330)) / 180 / 255
            dabs = math.log(1 - min(a, 0.999)) / math.log(0.98)
            row.append('p%.2f a%.3f gap %.2f' % (p, a, 30 / dabs if dabs else 0))
        print('%-4s %s  ' % (name, tag) + ' | '.join(row))
