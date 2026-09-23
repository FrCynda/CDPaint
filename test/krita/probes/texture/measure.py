import os
from PIL import Image
# Alpha along the stroke's centre row, sampled every 16 ramp values, Krita vs CDPaint.
root = os.path.dirname(os.path.abspath(__file__))
xs = list(range(16, 256, 16))
print('%-10s %-3s ' % ('variant', '') + ' '.join('%4d' % x for x in xs))
for name in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))):
    for tag, f in (('K', name + '.png'), ('C', 'cdp.png')):
        f = os.path.join(root, name, f)
        if not os.path.exists(f): continue
        px = Image.open(f).convert('RGBA').load()
        print('%-10s %-3s ' % (name, tag) + ' '.join('%4d' % px[x, 60][3] for x in xs))
