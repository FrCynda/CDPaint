import os
from PIL import Image
# Total ink and the peak on each line, Krita (K) vs CDPaint (C).
root = os.path.dirname(os.path.abspath(__file__))
for name in sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d))):
    for tag, f in (('K', name + '.png'), ('C', 'cdp.png')):
        f = os.path.join(root, name, f)
        if not os.path.exists(f): continue
        im = Image.open(f).convert('RGBA'); px = im.load()
        ink = sum(px[x, y][3] for x in range(im.width) for y in range(im.height)) / 255
        rows = [max(px[x, y][3] for x in range(100, 380)) for y in (50, 250)]
        print('%-6s %s ink %8.0f  line peaks %s' % (name, tag, ink, rows))
