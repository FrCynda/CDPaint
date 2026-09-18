# Brush tips

Most of these come from **David Revoy's Krita brush pack, 2023-01**, released
CC-0. They were pulled out of the `.bundle` (a ZIP) by `src/js/brush-pack.js`
and are the files Revoy shipped, not redraws of them. The presets that use
them in `krita-brush-engine.js` were translated from the same `.kpp` files by
`BrushPack.toPreset`, so the sizes, spacings and pressure curves are his.

`bristle.png`, `chisel_streaks.png`, `splat_dots.png` and `flat-tip-dirty.png`
belong to the handful of brushes that predate the import and were kept.

## What the files hold

Krita stores a tip as a grey picture on white paper and reads it as
`(1 - luminance) * alpha`. These are stored already converted: colour black
throughout, the shape in the alpha channel. The engine's own conversion is
then a no-op on them, and the paper around the shape costs nothing to store —
1.3MB became 490kB. Cells are capped at 200px, the largest dab any preset in
the library paints.

A tip may be a **strip**: several shapes side by side in one image, which is
what a GIMP `.gih` is. The preset says how many with `tipCells`, and whether
the next dab takes one at random or the next one along with `tipPick`.

| file | shapes |
| --- | --- |
| chalk_chisel_losange_202210A.png | 4 |
| chalk_chisel_random_small.png | 4 |
| deevad-202210C_compact-fix.png | 4 |
| rock_pitted-fixed.png | 7 |
| scratches_rough.png | 9 |
| splats_large.png | 5 |

## What was left out

Eight of the ten presets that were first dropped as near misses are now
shipped: the engine grew the features they lean on -- canvas texture
patterns, edge sharpening, one-axis scatter and a reservoir of colour per
bristle rather than one for the whole head. Their tips and patterns are here
as `*_tip.png` and `*_pattern.png`.

Two are still out, and are meant to stay out:

- **Shapes Alchemy** (experimentbrush) and **Distort Move Update**
  (deformbrush) -- Krita paint engines with no counterpart here. Reproducing
  them means writing two more engines for two brushes.

One shipped brush is a knowing near miss: **Oval Basic** turns its tip with
Krita's `tangentialpressure`, a barrel-wheel reading no browser reports, so
its tip does not turn.
