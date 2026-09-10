Two brush presets and a small bundle built from them, taken from David Revoy's
Krita brushes 2023-01 bundle, which he released as CC-0 (public domain):
https://www.davidrevoy.com/article953/krita-brushes-2023-01-bundle

They are here as test material, not as brushes we ship:

- eraser-kneaded-soft.kpp — a generated tip (Krita's auto_brush), so it
  exercises the diameter/ratio/softness path with no image at all.
- thin-brush-pointy.kpp — stamps a tip image, embedded in the preset itself
  as base64, so it exercises the resource path.
- mini-pack.bundle — the two of them in the ZIP layout a real pack uses,
  plus one loose tip in brushes/.
