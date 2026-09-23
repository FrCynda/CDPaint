# Real Krita pixels, headless

`render.mjs` makes the installed Krita paint strokes we specify — preset,
canvas, line, pressure at each end — and hands back PNGs. `compare.mjs` paints
the same strokes in CDPaint and measures the difference.

```
node test/krita/compare.mjs --render    # Krita renders corpus.json into test/fixtures/brushes/krita-ref/
node test/krita/compare.mjs             # CDPaint against the stored references
node test/krita/compare.mjs --check     # exit 1 if a case with `expect` has drifted
node test/krita/compare.mjs --only pencil-2,basic-1
```

Only `--render` needs Krita running. The comparison reads the presets out of
Krita's installed `Krita_4_Default_Resources.bundle` and imports them through
`engine.importBrushPack`, which is the path a user takes. That makes each case
a test of the import and the engine together. The side-by-side images
(CDPaint | Krita | difference) are written to `test/krita/out/`. In the
difference, red means CDPaint has more ink and blue means Krita has more.

## How it works

Krita's Python API has `Node.paintLine(p0, p1, pressure0, pressure1)`
(libs/libkis/Node.cpp). It pushes a `FreehandStrokeStrategy` job, the same
strategy the freehand tool uses. No mouse or tablet event is involved. The
pressure is interpolated along the line per dab, as a pen sweep would do.

That call needs an open view: `PaintingResources::createHelper` reads the
brush from `currentMainwindow()->activeView()`. So full `krita.exe` runs,
with a plugin (`cdp_harness/`) that:

1. loads the job named by `CDP_KRITA_JOB`;
2. paints each render on its own transparent layer;
3. writes straight-RGBA PNGs and `meta.json` (the preset, and the size Krita
   actually painted at);
4. quits.

Without that variable the plugin does nothing.

Krita runs on a **private Windows desktop** (`hidden-desktop.ps1`,
`CreateDesktop` + `STARTUPINFO.lpDesktop`). Its window is never shown on the
user's screen and can never take their keyboard focus. No input is sent to
anything.

`krita.exe` has no switch for a separate settings folder, so `render.mjs`
borrows the user's settings for about eight seconds. It:

- refuses to start while Krita is open;
- backs up `kritarc`, `kritadisplayrc` and `resourcecache.sqlite`;
- installs the plugin and turns it on;
- sets `OpenGLRenderer=none`;
- puts every file back and removes the plugin in a `finally` block.

The same bytes come back every time (checked with md5 before and after), and
two renders of the same job are byte-identical.

## Limits

- Krita 5.3's binding takes whole-pixel `QPoint`s, not `QPointF`.
- Each `paintLine` is its own stroke, so dab spacing restarts at every
  segment. A curve would need `paintPath`, which has no pressure.
- There is no tilt, rotation or speed in the stroke: a mouse-like pen held
  upright.
- Only the preset's own settings are used, plus an optional size override.

## Dead ends (do not retry)

- **`kritarunner.com`** runs Python (`-s module -f function`, with
  `PYTHONPATH` honoured and its own `%APPDATA%\kritarunner` settings folder).
  But it skips `KisApplication::start`, and `Window.addView` segfaults. This
  was tried with OpenGL off too. Printed output is lost, so the script has
  to log to a file.
- **`QT_QPA_PLATFORM=offscreen` or `minimal`**: both `kritarunner` and
  `krita.exe` crash within half a second at startup, right after the style
  line in `krita.log`, even with `OpenGLRenderer=none`. The hidden desktop
  replaces this.
- **`Resource.data()`** is not in the 5.3 bindings. The preset bytes come
  from the bundle instead.
- **Debugging the crash**: this Windows build is MinGW with DWARF `.debug`
  files, which Visual Studio's debugger cannot read, and no gdb is installed.
- **GUI automation** (earlier sessions): unnecessary now. This path has real
  pressure and no input injection.

## What it has found so far

- Presets with no size or flow option switched on shrank and faded under
  pressure. The fix sets `sizeSrc` / `flowSrc` to `'none'`.
- Krita's declination and X/Y tilt read 1 upright and 0 at 60°, the reverse
  of our `tilt` sensor. The Marker Chisel was 60px wide where Krita paints
  it 7px. The fix adds a new `elevation` sensor.
- An option switched on without "use curve" is a constant in Krita (it gets
  no sensor); we drove it from pressure.
- Dab blending. Krita's default "creamy alpha darken" is
  `a' = a + (o - a)·mask·flow` while `a < o` (`KoCompositeOpAlphaDarken.h`),
  so overlapping dabs never pass the dab's opacity `o`. The importer used to
  fold a pressure-driven opacity into flow, and dabs stacked past it. Now it
  becomes `dabOpacitySrc`, and the engine keeps the stroke's alpha as grey in
  an opaque buffer where canvas `lighten` is exactly that formula
  (`_alphaDarken`). Basic-2 went from 1.6× to 1.04× Krita's ink, with IoU
  0.60 → 0.96. Airbrush went from 2.77× to 1.92×, and Marker Chisel from
  1.93× to 1.27×.
- With `o` = 1, alpha darken *is* source-over, so flow-driven brushes were
  already right on blending.
- Textures. Our grey-tint grain removed no ink from an opaque pattern, which
  is every Krita pattern. Krita imports now use Krita's own maths
  (`_applyKritaTexture`, from `KisTextureMaskInfo.cpp` and
  `KisMaskingBrushCompositeOp.h`). Brightness and contrast are applied to the
  pattern, then:
  - multiply: `a·m·s`;
  - subtract: `a − (m + 1 − s)`;
  - soft variants are handled too;
  - the strength `s` follows the preset's own sensor.

  Chalk Soft went from 1.6× to 1.03×.
- Sensor ids. `<params fanCornersStep=… id="drawingangle">` puts the id after
  other attributes, and the reader missed it and defaulted to pressure. So
  Pencil-4's tip turned with pressure instead of with the stroke. It went
  from 1.62× to 0.90×, and Basic-6 from 0.78× to 0.88×.
- Soft tips. Krita's "soft" generator (`KisCurveCircleMaskGenerator`) reads
  its `softness_curve` at the *squared* radius (`norme` is `a*a + b*b`), and
  every Krita curve is a natural cubic spline (`KisCubicCurve`), where an
  `is_corner` point starts a new one. Measured on a single real dab, the
  engine's falloff now matches within 2 levels of 255. Airbrush Soft went
  from 0.59× to 0.96× (IoU 0.43 → 0.975).
- Masking brush, subtract mode. Krita paints the masking preset as a whole
  second stroke, with its own size, flow and spacing, and then does
  `alpha = max(0, stroke − mask)` (`KisMaskingBrushRenderer`,
  `KisMaskingBrushCompositeOp.h`). We used to tile it through each dab.
  It is now `maskOp: 'subtract'` (`_maskStrokeDab`), which gives the hollow
  Waterpaint Soft Edges stroke. Only generated masking tips take this path;
  Waterpaint Hard Edges' mask is a picture (`square_rough.png`) and still
  tiles. Other modes (multiply, linear dodge) still tile too.
- Grey PNG tips. Krita's ink is `(255 − grey) × alpha` for any all-grey tip
  (`fetchPremultipliedRed`, `kis_brush.cpp`). `oil_knife.png` is dark on
  opaque white apart from eleven pixels at alpha 192. We trusted the alpha,
  so each dab stamped the whole white square. Together with the masking
  brush, this took Waterpaint Soft Edges from 4.2× to 1.06×
  (IoU 0.14 → 0.49).
- Dab placement. A mask was centred at `w/2` and drawn at the dab's
  fractional position, so the browser blurred it across a pixel. Krita works
  each pixel out at the dab's true position. Small Krita tips are now built
  at the dab's own quarter-pixel phase and drawn on whole pixels.
- Spacing floor. Ours was 1px; Krita's is 0.5px (`MIN_DISTANCE_SPACING`,
  `kis_distance_information.cpp`). Ink-1 Precision went from 0.73× to 1.00×.
- Krita's own round tips (`_kritaCircleMask`). Imports of the `default` and
  `gauss` generators get `falloff: 'krita…'` and are computed per pixel at
  their real (unrounded) size:
  - "Anti-alias edges" works the fade out one pixel further from the centre
    on each axis (`KisCircleMaskGenerator::valueAt`), so a hard edge fades
    *inside* the radius. On the gauss generator it is a linear fade over the
    last pixel (`KisAntialiasingFadeMaker1D`).
  - A tip under 10px with anti-aliasing is supersampled 3×3, or 6×6 under 1px
    (`KisBrushMaskScalarApplicator`), starting from the pixel's corner. That
    puts the dab about a third of a pixel up and left of the cursor, and it
    shows: G-Pen's 5px line reads 164,254,254,254,229 across its rows.
  - Krita paints dabs down to 0.01px (`checkSizeTooSmall`), so a light
    stroke starts where Krita's does.
  - With sharpness on, the dab's corner is rounded to a whole pixel
    (`KisSharpnessOption::apply`).

  Ink-3 G-Pen went from 1.08× (IoU 0.77) to 1.00× (IoU 0.99). Basic-5 now
  has IoU 0.99, and Marker Chisel is exact.
- Still open:
  - The speed sensor. Krita smooths pen timing its own way
    (`KisSpeedSmoother`). Ink-1's size follows speed, and it now reads a
    touch thin (0.97×). Whole-pixel rounding used to hide this.
  - A turned, non-round Krita tip still uses the old gradient path.
  - Pencil-1's IoU of 0 is the metric: neither image has a pixel over 127.
