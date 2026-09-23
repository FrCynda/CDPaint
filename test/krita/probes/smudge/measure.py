import os, sys
from PIL import Image
# Straight RGBA along the stroke's centre row: Krita (K) and, if present, CDPaint (C).
root = os.path.join(os.getcwd(), 'test/krita/out/smudge')
xs = [(int(a) for a in sys.argv[1].split(','))] if len(sys.argv) > 1 else [42, 50, 70, 100, 200, 300, 430]
xs = list(xs[0]) if not isinstance(xs[0], int) else xs
print('%-20s %s' % ('variant', '  '.join('%13d' % x for x in xs)))
for name in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)) and d != 'kres'):
    for tag, f in (('K', name + '.png'), ('C', 'cdp.png')):
        f = os.path.join(root, name, f)
        if not os.path.exists(f): continue
        px = Image.open(f).convert('RGBA').load()
        print('%-18s %s ' % (name, tag) + '  '.join('%3d,%3d,%3d,%3d' % px[x, 60] for x in xs))
