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
- bristles-grouped.gbr — a GIMP brush: one shape stored as coverage, so its
  bytes are the alpha as they stand.
- chalk-chisel-random-small.gih — a GIMP brush pipe: four shapes in one file,
  which Krita picks between per dab.

The three .abr files are not from anywhere: they are written by hand from the
Photoshop brush format's description (scripts are in the session scratchpad,
not the repo) to cover version 2, version 6 subversion 1, and version 6
subversion 2, compressed rows and raw. They check that the reader agrees with
the format as documented. They cannot check that Photoshop does — for that a
real .abr is needed, and there is none here.

The two .myb files are likewise written by hand, one in each of MyPaint's
formats — the newer JSON and the older line-per-setting — to cover a
stamping-free brush with pressure curves and an eraser.
