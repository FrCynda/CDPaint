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
- The biggest remaining gap is dab blending. Krita's default "creamy alpha
  darken" is `a' = a + (o - a)·mask·flow` while `a < o`, so overlapping dabs
  never pass the dab's opacity. Ours accumulates source-over toward full
  black, which makes Basic-2, Airbrush, Pencil-4 and Chalk 1.6–2.8× too dark
  (`KoCompositeOpAlphaDarken.h`).
