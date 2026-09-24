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

## Brush bank

`compare.mjs` checks a hand-picked corpus. `bank.mjs` runs whole packs, so
edge cases in brushes nobody picked get caught too:

    node test/krita/bank.mjs [--render] [--packs krita4,eo-v3]
    node test/gimp/bank.mjs  [--render] [--only extras,slos]

- **Krita packs:**
  - Krita's own Krita 4, Krita 3 and RGBA bundles. Krita 3 ships switched off,
    so it is unpacked into a folder.
  - David Revoy's 2021 and 23-01 bundles (davidrevoy.com), downloaded into
    `out/bank/deevad21`, `deevad23`.
  - `github.com/EyeOdin/eo_bundle` (v2, v3) and `github.com/portnov/krita-brushes`.
- **GIMP brushes:**
  - GIMP's own brushes.
  - `GNOME/gimp-data-extras`, `SenlinOS/SLOS-GIMPainter`,
    `wesleycsj/GIMP-pixelart-brushes`, `LinuxBeaver/Gimp_Leaves-Brush-Pack` and
    `vascoalexander/gimp-brush-collection`, cloned as `out/bank/gimp-*`.

Each pack renders into a private resource folder (Krita) or profile (GIMP,
headless `gimp-console`), so the user's own libraries are never touched.
Every brush paints the same four strips on both sides. Brushes that ask for
chance are left out: fuzzy sensors, scatter, random tips and textures, and
random `.gih` pipes. So is any Krita brush whose two renders differ.

Each brush is graded:

- **close**: IoU ≥ 0.9 and ink within 0.9–1.1×;
- **near**: IoU ≥ 0.75 and ink within 0.8–1.25×;
- **off**: anything else.

Results go to `out/bank-run/results.json` and `out/gimp-run/`. A run with
`--packs` only replaces that pack's rows.

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
- Speed (`KisSpeedSmoother`). Krita sums the last few moves until there are
  more than three and they cover more than 5px, divides by that many ticks
  of the pen's own rate (a trimmed mean of the last 200 event gaps,
  `KisFilteredRollingMean`), and reads the result against 30 px/ms
  (`maxAllowedSpeedValue`). `Node.paintLine` hands Krita no timing, so its
  speed is 0 (confirmed: probes/speed). `compare.mjs` stops the clock while
  it draws so ours is 0 too.
  Ink-1 went from 0.97× to 1.00× (IoU 1.00).
- IoU is measured at half of Krita's own darkest pixel, not a fixed 127.
  Pencil-1 never passes 127 on either side, so its IoU read 0; it is 0.92.
- Turned Krita tips use the same per-pixel maths, sampling at
  `cos·x − sin·y, sin·x + cos·y` (`KisBrushMaskScalarApplicator`). Our
  angle turns the tip the same way `ctx.rotate` does, like every other
  shape here. Ink-4 Pen Rough went from 1.33× (IoU 0.73) to 0.99× (0.90).
- Linear dodge masking brush (`KisMaskingBrushCompositeOp`, `maskingAddition`).
  The mask is a second stroke, painted white with alpha darken into a grey
  buffer (`setupMaskingBrushPainter`), and added to the stroke's alpha
  wherever the stroke already has some. Its size is `MasterSizeCoeff` × the
  preset's size, its soft edge is the generator's fade, and its opacity
  follows its own sensor. Charcoal Pencil Medium went from 0.52× (IoU 0.36)
  to 1.15× (0.70). Waterpaint moved from 1.05× to about 1.0×, because its
  subtract mask now builds up the same capped way.
- A job can now edit a preset before painting it: `xmlSub` runs regex
  replacements on the preset's XML (`Preset.toXML`/`fromXML`, in memory only),
  and a corpus case's `params` makes the same edit on our side. The Charcoal
  cases use this to switch the mask and texture off, so each part is measured
  alone. A render only ever holds the edit in memory; nothing under
  `%APPDATA%/krita` changed during these runs. `dumpXml` writes the preset's
  XML next to the PNG.
- Krita paints nothing for a zero-length `paintLine`. A single dab is a
  one-pixel line (`charcoal-dab`).
- Tip angle direction. That lone dab leaned the wrong way. Krita samples the
  tip at `cos·x − sin·y`, `sin·x + cos·y`, which shows it turned by minus
  its angle, while `ctx.rotate` turns it by plus. So the importer now negates
  Krita's `angle` (and the masking tip's). `_kritaCircleMask` samples with
  `−sin` so that it turns the way `ctx.rotate` does, like every other shape.
- Spacing of turned tips. Krita's dab gap is an ellipse whose axes are the
  box around the tip turned by its *fixed* angle
  (`KisBrush::characteristicSize`, `KisQImagePyramid`). Only the rotation
  option turns the ellipse itself (`KisBrushOp::updateSpacingImpl`).
  Charcoal's 0.8 tip at 309° has a box 10.4px wide, not 8.3, and we laid a
  fifth too many dabs. Charcoal went 1.15× → 0.99×, and with mask and texture
  off it is 1.01× (IoU 0.95). One dab is 1.00×, peaking at 53 on both sides.
- Rotation option (`KisRotationOption::apply`, `KisCurveOption::rotationLikeValue`).
  The tip turns by (1 − v)·π, where v = strength × the sensor read as −1..1.
  Random (fuzzy) is additive; other sensors are scaling, which Krita negates.
  So a tip with the option on sits upside down and wobbles from there.
  Waterpaint's knife (strength 0.19) turns 160–207°; we imported it as a full
  random spin. Its IoU went 0.65 → 0.85, and Chalk's 0.87 → 0.94. The angle
  sensors (drawing angle, twist, tilt) keep their old handling.
- Mirror boxes are stored ticked whether or not the option is on; only
  `PressureMirror` switches them on. Waterpaint was flipping at random.
- Found by the brush bank:
  - Build-up mode (`PaintOpAction` 1) lands each dab at the opacity, and flow
    is ignored. Airbrush Digital went 0.23× → 0.98×.
  - Gauss square tips (`KisGaussRectangleMaskGenerator`) have their own erf
    falloff, with hfade on the width and vfade on the height. ZBlocks went
    1.54× → 1.05×.
  - Sharpness is a threshold (`KisSharpnessOption::applyThreshold`), not a
    blur cut. PixelArt_Round went 0.71× → 1.01×, and Dithering 1.45× → 1.02×.
  - Presets embed their texture as `Texture/Pattern/Pattern`, a PNG
    base64'd twice. Pastel_texture_large went 2.0× → 0.99×.
  - Every Krita falloff paints dabs down to 0.01px. EO Pixel Perfect went
    from painting nothing to 1.0×.
  - GIMP pipes step *before* painting, so the first dab is cell 1, and the
    count restarts per brush. This was proved with a numbered probe pipe.
    Splats 02's IoU went 0.12 → 0.84.
  - RGBA GIMP brushes paint their own colours. Pepper went 0.51× → 1.01×.
  - The first dab gap uses the stroke direction for non-square tips. The
    GEGL goat's IoU went 0.21 → 0.63.
  - Picture tips landed on whole pixels. Chrome filters a half-pixel
    `drawImage` only inside the source, and holds the source's outer edge on
    whole pixels. So a tip inked to its border never straddled, where GIMP
    puts an odd tip across two pixels (the corner goes at centre − w/2).
    Custom tip masks now carry a clear 1px margin:
    - square (5x5): IoU 0.84 → 0.98;
    - Pixel (1x1): 0.54 → 0.96;
    - the pixel-art squares are exact to within 2/255.
  - GIMP's 1px line (probe `tiny`, `node test/gimp/probe.mjs`, which paints
    GIMP's own brushes with any strokes, one PNG each): when a brush's
    spacing is under a pixel, the first dab sits on the start point and
    every later dab on the next pixel centre along the line's main axis,
    at least a pixel on. At 0.01 and 0.5 spacing the result is the same.
    Otherwise dabs stack as ours do: its soft Hardness 050 line is
    rebuilt exactly from its own lone dab stacked every 3px. A "keep the
    strongest dab" model was tried and failed on every soft brush. Pixel,
    dot, SLOS_1-Pixel ink 1.43 → 1.00; SLOS_some-lines and both smoke
    brushes 0.2–0.5 → 0.65–0.94 IoU.
  - GIMP's generated round brush (probe `circ`, lone dabs of Circle (01)
    to (11) and Circle Fuzzy (07), every pixel matched). It is an odd
    grid, 2·ceil(r − ½) + 1 across. Each pixel's distance is rounded to a
    quarter and the falloff is averaged at ±⅛ and ±⅜ px around it. The
    whole mask is then shifted bilinearly to the dab's sub-pixel spot.
    Circle (03) IoU 0.78 → 0.997; every Circle is at 0.99 or better.
    GIMP close 147 → 158.
- Found black-box, from Krita's own renders only. Each probe is a
  `test/krita/probes/<name>/job.mjs` (Krita's side, one fresh Krita per
  variant, written to `test/krita/out/<name>`) plus
  `test/krita/probes/probe-cdp.mjs <name>` (ours, through the real
  importer). Run `probes/dump-ink1.mjs` once first:
  - `buildup`: in build-up each dab paints opacity × the pressure curve,
    flow plays no part, and the dabs stack past the opacity. Glow's IoU went
    0.52 → 0.96 and Light Beam's 0.65 → 0.90.
  - `spacing`: the spacing option multiplies the gap by its strength × its
    curve. With the curve box clear it is the strength alone; with its flag
    off it does nothing. Light pressure has the same minimum gap as ours.
  - `optswitch`: opacity has no off switch. Its curve box alone decides
    (flag off with the box ticked still faded p0.25 to 137), whereas size
    and spacing follow their flags.
  - Smudge presets keep `PaintOpAction` and a spacing option as leftovers.
    Applying the two rules above to them turned mixbrush bis solid black, so
    those rules are for the pixel brush only.
  - `faint`: opacity and flow need tenths of a percent (0.4% painted nothing).
  - `ascension`: tilt direction with no pen tilt (a mouse, or a scripted
    stroke) turns the tip a quarter turn. In a list with pressure the two add.
    Grease Charcoal and Large Chalk lay their flat tips this way. How it turns
    with a real tilt can't be probed: scripted strokes carry no tilt.
  - `texture`: a grey-ramp pattern gives the transfer curve directly. Ours
    matched without a cutoff. Outside the cutoff range, policy 1 reads the
    pattern as black and 2 as white. With Invert the range still tests the
    raw grey, but that fill is not inverted (`i0p1`, `i0p2`; filling before
    invert blanked Texture Wood Fiber, 0.79 -> 0.09). The range is inclusive
    (`m0p1full`), and Krita's pattern sits one column right of ours.
    Brightness and contrast against the cutoff are unprobed.
  - Airbrush mode adds nothing to a scripted stroke.
  - `sketch` (`job.mjs`, `reach.mjs`; the harness's `paths` paints one
    stroke through many points): the sketch engine has no dabs. Each new
    point draws a line from the point before it, plus lines to every earlier
    point closer than half the brush size (at size 30, gaps of 12 fill and
    16 don't; at 15, 4 fills and 8 doesn't; at 60, 24 fills and 32
    doesn't). Those lines are trimmed by `Sketch/offset` at both ends: at
    20%, a 12px gap fills from 2.4 to 9.6, cut to whole pixels. Each line is
    hard-edged, `lineWidth` wide, at the opacity curve's value for the pen
    pressure, and lines stack as ordinary paint. Chrome's 1 to 6 coats
    measured 125, 189, 221, 238, 246 and 250. Only the points handed to the
    brush count as history. A scripted `paintLine` hands it two, so it has
    nothing to join back to, and the bank replays sketch presets that way
    (`measure.mjs`). Not modelled: Krita's fill fades a little towards the
    newer side of the stroke (ours is 3% dark on the U-turns), magnetify off
    (a guess), distance density and opacity (guessed linear), and random
    RGB and opacity.
  - `smudge`, `smudge2` (colour smudge, Basic_mix at size 30 with flat
    sensor curves, on an empty layer, a red one, or blue blocks via the
    harness's `fill` and `rects`). A dab carries pixels, not a colour. It
    copies what lies under the previous dab (smearing), or takes the one
    pixel under that dab's centre (dulling). It mixes paint into that at
    `c × max(0.2, 1 − s)` (c = colour rate, s = smudge rate; fitted 0.75,
    0.5, 0.25, 0.2, 0.2 of c at s = 0.25 … 1, and the same at size 60). The
    result replaces the canvas at `s × tip × flow`, premultiplied. So s = 0
    lays nothing down, and on an empty layer the paint is diluted by the
    transparency it picks up. The first dab only picks up, and a click paints
    nothing. The auto gap is `0.3 × √(size + 1)`: a 10px stroke lays 5 dabs,
    not 6. The pick-up moves by both ends rounded to whole pixels, alternating
    1 and 2 at a 1.64px gap. Rounded against the dab's own phase, it was 2
    every time and carried colour a fifth too far.
    Switches: colour rate off adds no paint. Smudge rate off is a plain brush
    painting at the colour rate. With this, the whole 79-render grid is within
    0.77 levels on average, where the old single-colour mix painted solid
    black on empty layers. Not modelled yet: smudge radius (8 presets), merged
    paint (12), and soft or picture tips (probed on a hard disc only). Dulling
    at half rate fades a little in Krita (225 after 320px) and holds in ours
    (254): 8-bit rounding.
    Harness trap found here: an `xmlSub` edit stays on the preset for the rest
    of the job. One "colour rate off" render blanked every render after it.
  - `smudge3` … `smudge6` (the same, with pressure): Basic_mix as shipped
    painted far lighter in Krita under a pressure ramp. Black on an empty
    layer can't separate colour rate from smudge rate (many pairs look alike),
    so `smudge5` reads each where only it matters: a pure smear out of a blue
    block for the smudge rate, a red fill for the colour rate. Found:
    the opacity curve scales the whole dab, smear and paint alike, on colour
    smudge with its pressure switch off too. `smudge6`: a flat 0.5 smudge
    under a linear opacity curve at pressure 0.5 smears exactly as a flat
    0.25, switch on or off. The paint's `max(0.2, 1 − s)` reads the smudge
    rate's slider, not its curve. Mean error: smudge4 10.0 → 2.6 levels,
    smudge5 8.5 → 2.0; smudge3 ends at 1.4 and smudge6 at 2.3. The
    flat-curve grid is unchanged.
  - `smudge7` (dulling on empty and red, opacity slider 1 and 0.5): dulling
    already matched. The opacity slider scales each dab exactly as the
    opacity curve does. Ours ignored it (a smudge writes the layer itself,
    past the stroke-wide opacity), so 0.5 held at 253 where Krita built to
    209. Mean 7.3 → 1.8 levels. From the bank, not a probe: a smudge dab
    takes its texture too (pastel_014 ink 6.4x → 0.98x once its tip also
    resolved), and a preset's `abr_brush` tip "<set>_<n>" is the n-th tip,
    counted from 1, of <set>.abr in the pack. Colour smudge went from
    0 / 6 / 50 (close / near / off) before this rebuild to 19 / 17 / 22.
  - `smudge8` (the smudge rules on soft gauss and linear tips, a .gbr and a
    .png picture tip; paint on empty, over red, a drag out of blue, and
    dulling): the rules fitted on the hard tip hold unchanged, with a mean
    of 2.5 levels. The only difference: a drag's last faint trace stalls at
    alpha 2–5 in ours, where Krita's fades to 0. Changing the rounding
    doesn't fix it. Always rounding down scored 6.7, rounding down only
    when fading 2.7, and random rounding lost 2.0 → 4.6 on smudge5.
    Left as is.
  - `smudge9`, `smudge10`, `speed`, `sensorlist` (the X2F "Smeary"
    brushes): smudge rate switched off still smears, at full strength, and
    its slider still sets the mix (ours had read it as plain paint). The
    size switch is honoured. Speed reads 0 in the harness, as assumed
    above. A sensor list sharing one curve with none stored runs every
    input through the LAST child's curve and multiplies them; curveMode
    changes nothing. That is why X2FA's paint falls as pressure rises: its
    colour rate is pressure then speed, and speed's curve falls 1 → 0.
    sensorlist mean 42.3 → 3.95 levels; colour smudge 17 → 19 close.
  - `hatch`, `hatchp`, `hatchsub` (the hatching brush, which we painted as
    a round brush): straight lines fixed to the canvas, one through the
    origin pixel, the next `separation` px on along the normal; direction
    (cos a, sin a) with y down. Across its minor axis a line is N =
    ceil(T) px solid, T = thickness × 0.5 with the thickness option off
    (× its curve on, × 1 on without a curve). At 0/45/90° that is all;
    elsewhere the run is N + 0.9 px (steep) or N + 1.17 (shallow) with
    soft ends, and an even N sits half a pixel toward +x (45° counts as
    steep). The separation option steps in powers of two:
    sep × 2^(floor((n − 1)/2) − clamp(ceil(v·n) − 1, 0, n − 1)) for n
    intervals. Subpixel precision off snaps 45° lines to whole pixels
    apart, rounded down (4 → 5 px across, not 5.66). Dabs build up to
    opacity × coverage, so a textured tip fills in solid while a line's
    soft edge stays soft. Krita's slanted lines jitter a few tenths of a
    pixel row to row, which we do not copy. Not done: the minus/plus and
    moiré styles (only random-stroke presets use them), aliased slanted
    lines, and subpixel-off at other angles. The ten scored hatching
    presets went from all off (ink 1.4–3.7×) to 7 close and 3 near.
  - The grid brush (no probe of its own; the bank's one preset): a cell
    every grid width along the stroke from its first point, the end
    point excluded, each snapped to the canvas cell it falls in and
    painted once per stroke as div × div ellipses at the flow. Ink
    1.29× → 1.01×, IoU 0.30 → 0.98.
  - Colour smudge spacing: the pen-driven spacing option holds on a
    colour smudge as on a paintbrush (it was only taken where measured).
    Wet_Smear 0.61× → 0.96× ink, both portnov mixbrushes close; colour
    smudge 19 → 22 close in the bank.
  - `pixel` (krita3 pixel1, a 1px sharp tip): 32 short lines at quarter-
    pixel offsets in every direction. The stroke's start snaps to the
    pixel grid, a half rounding down (40.5 → 40, 50.75 → 51), then the
    line steps one whole pixel along its major axis, a half across it
    rounding up, end pixel included: a Bresenham line between snapped
    ends. That model matches all 1312 pixels; ours had shallow
    diagonals a row off along half their length (IoU 0.76).
  - Ratio option: squashes the tip across its short axis by its curve,
    the way size scales it. It was dropped; EO Pixel Square, Cloud and
    Soft Cloud went from near to close with it.
  - `softtip` (EO Pixel Taper's soft tip, type "rct"): Krita reads
    "rct" as a soft RECTANGLE, far narrower than the soft circle we
    import it as (a lone dab with a linear curve: 292 units of ink in
    Krita, 838 in ours). hfade/vfade and anti-alias change nothing on a
    soft tip. Its level lines are squares (a step curve at 0.5 fills a
    square half the tip across), and with the curve inverted the tip is
    empty along both axes, so the axes are multiplied somehow, but no
    single per-axis model fits the linear, inverted and mid-dip curves
    at once. Not done: only Pixel Taper (still 1.7x ink) and the
    tilt-driven Block tilt fill are scored with this tip. Our soft
    CIRCLE matches Krita's lone dab to a level or two.
  - Probing trap: within one Krita session a variant that leaves the
    softness curve alone came back with the PREVIOUS render's curve.
    Tip-shape variants must run one session each:
    `node test/krita/probes/solo.mjs <probe> <variant>...`. Also, a
    stroke shorter than about a pixel paints nothing in Krita, so a
    lone dab needs a 1.5 px stroke.
  - Still open: very faint build-up (well under one 8-bit level a dab)
    accumulates less in ours than in Krita. X1BB Addition Soft (5% × a
    pressure curve, 64%-peak soft tip) sits at 0.68× ink. The tip, spacing
    and dab count all match, so it is how the canvas adds sub-level dabs.
  - `softness` (flow defaults): on the pixel engine a preset with no
    `FlowUseCurve` key paints as if it were ticked, so flow follows
    pressure. Whenever a UseCurve key IS stored, the Pressure* flags
    for opacity and flow are ignored. Round marker, colour smudge, grid
    and curve have no flow option, so the default does not apply there.
    Paintbrush close 133 → 145 (Fineliner IoU 0.80 → 0.99).
  - `gaussrect` (X1CC Flat's soft rectangle): lone soft-rect dabs match
    Krita. X1CC itself is still off, because its ratio-0.06 tip is about a
    pixel tall.
  - `texmode` (texture mode 12, Height; mode numbers follow the manual's
    list order): ink = clamp(a/u − u − m·0.5/neutral) with u = 1 −
    strength, a the dab's alpha, m the pattern level, and neutral the
    neutral point. Flow multiplies afterwards. The pattern is anchored to
    the canvas origin. deevad c5 IoU 0.77 → 0.94; Textured Crease 0.45 →
    0.94.
  - `dullgbr`, `tipdab` (picture tips drawn far below their file size):
    Krita keeps a shrunk tip's mean ink, which is an exact area average.
    The browser's own shrink lost the faint speckles (X2DA's 602 px tip
    laid 0.905 of Krita's ink at 40 px; it lays 0.969 now). The rule
    applies to Krita imports only, because GIMP lost ink with it
    (SLOS_lineline). Paintbrush close 145 → 153. Lone dabs of
    random_particles match Krita within 2%. With a subtract texture on,
    ours still leaves more faint specks (104 lit pixels against 78).
    X2DD's first colour-smudge dab is about 1.35× Krita's.
  - `addop` (X1BB Addition Soft, 0.68× ink): the add blend mode caps
    like a normal stroke, and ours already matched. The real gap was
    faint build-up. At pressure 0.5 each of its dabs is 2.8 levels deep;
    Krita stacks them to 17 and our 8-bit stroke buffer stopped at 9. A
    float16 stroke buffer lands on 17. Krita close 244 → 250 (X1BB IoU
    0.56 → 0.92, Rake_bristle_dry 0.70 → 0.90), and GIMP close 138 → 147
    (dither and square brushes 0.06 → 0.96). The alpha-darken grey buffer
    stays 8-bit: float16 there cost hard pixel presets IoU (EO Pixel
    Opacity 0.99 → 0.92), so Krita rounds there.
  - Probing trap: Krita re-serialises the preset's XML before `xmlSub`
    runs, and the attribute order changes from session to session.
    Match `<param [^>]*name="X"` and never rely on attribute order. A
    substitution that matched nothing shows as `xmlSub '...': 0` in
    harness.log.
- Still open:
  - Charcoal's IoU is 0.69 with the texture on. Krita gives the texture a
    random offset per stroke (`isRandomOffsetX/Y`), so the grain can't line
    up pixel for pixel.
  - Waterpaint and Chalk still vary a little from run to run, because their
    tips turn at random.
- Don't read Krita's or GIMP's source. Both are GPL and CDPaint is MIT.
  Behaviour is worked out from what the real programs paint (a probe per
  question, as above) and from public specs. The installed Krita is 5.3.2
  (`meta.json` records it). Some older findings above name Krita source
  files; they come from before this rule and are kept as history.
