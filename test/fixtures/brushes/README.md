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

Two things Revoy's 25.01 bundle (46 presets) settled that are not in any
fixture, because the answer was "nobody asks for this":

  * `brushApplication` is 0 -- plain coverage -- on all 36 presets that have
    a tip, and `PressureLightnessStrength` is false wherever it is written at
    all. So a lightness-mapped tip is not built; it is named in the warnings
    instead, along with the other two modes, because arriving as a plain
    stamp with nothing said is the one kind of wrong nothing in the imported
    brush reveals.
  * the two mirror axes are both on in the two presets that use either, so
    they were collapsed into one flag without it showing. They are separate
    now: one axis doubles the shapes a dab picks between, both axes make
    four. The same change split Photoshop's `flipX`/`flipY` off, which is a
    different thing again -- the tip is turned over once and stays that way,
    and reading it as Krita's mirror left half the dabs the right way round.

borrowed-tip.bundle is two presets lifted unchanged out of a different, real
pack: **Krita 4 Extras by David Revoy (Deevad), www.davidrevoy.com**, licensed
**CC-BY 4.0** — that attribution is required because the file is redistributed
here. It is in the repo because it does the thing no hand-written fixture
does: it is built on top of Krita's own default resources, so it names a tip
and a canvas pattern that are not inside the pack. That used to cost a brush
on import.

The three two-tips-*.abr files are not from anywhere: they are written by hand
from the Photoshop brush format's description (scripts are in the session
scratchpad, not the repo) to cover version 2, version 6 subversion 1, and
version 6 subversion 2, compressed rows and raw. They check that the reader
agrees with the format as documented.

three-tips-v10.abr is different: make-abr.py beside this file rebuilds the
layout of two REAL packs — 130 brushes between them, myphotoshopbrushes.com's
24 Free Pastel & Chalk Brushes and Resource Boy's 100+ Drip Brushes. Both are
free to use and both forbid redistributing the files, so the layout is rebuilt
rather than the packs shipped. Version 10 is what every brush pack downloaded
today actually is, and the real files settled two things no document states:

  * the image header sits exactly 301 bytes into each `samp` block — the same
    offset our version 6 subversion 2 path already used, confirmed on all 130;
  * a brush's name is not in `samp` at all, and neither is a single one of its
    settings. The block leads with a UUID, and both live in a `desc`
    descriptor at the end of the file, in a different order. We were ignoring
    it, so the Drip pack imported as "drip 1" ... "drip 106" and all 130
    brushes arrived as flat stamps at whatever size we guessed.

The descriptor is Photoshop's own nested format -- objects, lists, numbers
with units, strings -- and reading it gives every dial: diameter, angle,
roundness, spacing, flips, scatter, and what drives each of them as you draw.
The 24 pastel brushes all carry pressure on their size, and now import that
way.

Two things the real files settled that a guess would get backwards:

  * scatter is a spread either side of the line as a percentage of the brush
    width, which is exactly what ours is -- not half of it;
  * angle jitter is a share of a full turn, and brushes ask for 2 or 4 per
    cent of one. Read as a bare "random angle" that is every dab spun to a
    random heading, which is a different brush. The engine grew an
    `angleRange` for it.

A third thing the format settles that the packs do not use: `bVTy = 1` is
Photoshop's **fade**, which is not a pen input at all -- it counts dabs and
runs the dial down over `fStp` of them. Neither real pack fades anything, so
the fixture's blob does: its roundness fades to 30 per cent over forty dabs.
That is the only file we have that exercises fade, `minimumRoundness`, and
roundness dynamics, all three of which used to be reported as dropped.

The same two sensors exist in Krita, spelled `distance` (pixels travelled,
ramping up) and `fade` (dabs, running down), each with a `length` attribute
on the sensor tag. Both are mapped, and neither is measured: none of the 38
presets in Revoy's 2023-01 bundle uses either -- they use pressure, fuzzy,
drawingangle, ascension and declination and nothing else. If Krita spells
those ids differently the option falls back to the warning it already had,
which is why mapping them costs nothing to be wrong about.

The blob also asks for three dabs at every stop (`Cnt `). That is the half of
Photoshop's scatter that does the most work -- it is what makes a scatter
brush a spray rather than a dotted line -- and it used to be reported as
dropped. Neither real pack uses it, so the fixture is the only check.

The blob also asks for a second tip (`dualBrush`), and names it the way a
brush names its own tip: by the UUID of a sample in the same file. It names
the third one -- the sample the descriptor has no brush of its own for -- so
a tip nobody else claims still resolves to a real picture. That settles the
one thing a guess gets wrong: a dual brush's tip is not a picture of its own,
it is one of the pack's own samples, so reading it is resolving a reference
rather than decoding another image.

Clip Studio and Krita both have the same feature and both stay a warning.
Krita's `MaskingBrush/Enabled` is off in all 38 presets of Revoy's 2023-01
bundle (26 say false, 12 do not mention it), and no .sut we hold turns
`UseDualBrush` on. For the .sut there is a second reason: which of a sub
tool's material rows would be the second tip is a guess -- the tip is row 0
and the texture is row 1 only because a real file that uses both says so --
and carving every dab with the wrong picture is worse than saying the feature
was dropped.

The fixture is shaped to break a reader that gets this nearly right: the
descriptor holds strings that are neither names nor UUIDs, it writes each name
twice, the names are not in the samples' order, one sample is missing from the
descriptor entirely so it must fall back to a number instead of inheriting its
neighbour's name, and its keys come in both shapes -- four bare bytes, and a
length with the characters, which is byte for byte the shape of a string. One
brush carries the full dynamics tree and three features we cannot do, which
have to be named rather than swallowed; the other carries none of them and
must not inherit any.

It also carries a paper texture, in its own `patt` section, in the layout a
.pat file uses. That one is honestly a weaker check than the rest: neither
real pack uses texture at all -- both have an empty `patt` -- so the pattern's
bytes are written from the format's description, and which descriptor key
names the pattern a brush wants is taken from the format rather than measured.
The picture itself is real enough to catch the mistake that matters: a texture
is a picture, not a cut-out, and read as coverage it comes out a hole instead
of a grain.

Every tip used to be squashed to 200 pixels on the way in. That was never
about brushes: a tip was a data: URL inside a preset record inside
localStorage, and the whole application has about 5MB of that. Real Photoshop
brushes are drawn at 1000 to 2300 pixels, and 200 is exactly where the grain
of a chalk or a drip brush lives -- so the two real packs above imported as
smooth blobs and nothing in the numbers showed it. Tips are in IndexedDB now,
the preset keeps a key, and the ceiling is 1024.

Both real packs read correctly: 24 and 106 tips, every one a clean shape with
its own name and its own dials, and the descriptor consumed to the byte.

two-brushes.brushset is generated, not captured: make-brushset.py beside this
file builds the ZIP-of-folders layout Procreate uses and writes the settings
through **Python's plistlib**, which encodes Apple's binary property list from
an independent implementation. So the two-format half of the reader — the
binary plist and NSKeyedArchiver's flat `$objects` layout — is genuinely
checked against the format rather than against bytes we typed. Its settings
carry three traps on purpose: a dial that is off, a dial that is neutral at
one rather than at zero, and two keys whose names look like features and are
not.

seed-csp2pc.brush is a real Brush.archive, from Leon Schönbrunn's CSP2PC
(MIT). It is what supplies the key NAMES — around two hundred of them, nearly
all at their defaults. Before it was here the reader matched keys by pattern
and got them wrong in both directions: /shape.*angle$/ matched
shapeRoundnessTiltAngle and reported a straight brush as turned six degrees,
and /smudge/ matched smudgeOpacity, a remembered slider that is always 1, so
five features were reported lost on a brush that used none of them. The keys
are named exactly now, and this file is the check that the names are right.

charcoal-soft.myb and hard-eraser.myb are likewise written by hand, one in
each of MyPaint's formats — the newer JSON and the older line-per-setting —
to cover a stamping-free brush with pressure curves and an eraser. The eraser
also asks for a dab whose size wanders, on top of a size that already follows
pressure: one driver at a time, so the wander is the one that has to be named
rather than silently dropped.

hard-eraser.myb also carries `offset_angle_adj`, which is the half of
MyPaint's offset family we cannot do: a second offset vector with its own
angle, each end drivable from its own sensor. It has its own warning, separate
from "dabs placed away from the cursor", because the two are different things
and thirteen of the 196 real brushes now DO get their offset placed.

deevad-airbrush.myb and deevad-knife-smudging.myb are not. They are David
Revoy's own, copied unchanged out of mypaint/mypaint-brushes, where the
brush settings are CC-0 by project policy. They are here because "Revoy's
brushes should look like Revoy's brushes" is the whole point of this work,
and because running all 196 of that collection through the reader is what
found what the hand-written fixtures could not:

  * every real file says "MyPaint brush file" in `comment`. That is the
    format's banner line, not a name, so the name is the description;
  * `opaque_multiply` sits at 0 with a pressure curve hung off it on most
    real brushes. That is MyPaint's idiom for "flow follows pressure", and
    reading the 0 as a plain multiplier made his brushes paint nothing;
  * `offset_by_random` is a spread in radius units, so it is half our
    scatter, not all of it;
  * `offset_by_speed` is the same units again, and on most real brushes its
    base sits at 0 with the whole distance hung off a curve -- so the reach
    of the curve is the number, not the base. MyPaint adds the two; we
    multiply a distance by a sensor, so the distance is both together and the
    floor is the base's share of it;
  * `elliptical_dab_angle` is 90 on a round dab, where it means nothing;
  * `smudge_radius_log` is a doubling of the dab's own radius, and MyPaint's
    own collection spans a quarter of it to four times. A wide sampler is the
    difference between a blender and a smear, and ours had no such dial;
  * a dozen settings rest at 1 or only matter while a companion is on, and
    were being reported as dropped features on brushes that never used
    them — 174 false warnings across the collection, now 0.

rough-scrape.sut is built by make-sut.py beside this file, through Python's
own sqlite3 — because a .sut is not a file with a database in it, it IS a
SQLite database, and reading one meant writing a small read-only SQLite. The
fixture is shaped to break that reader if it is wrong: its material blobs are
several times a page long, so their records spill onto overflow pages and have
to be chained back together, each blob holds a decoy bitmap before the real
one, and the row of reset-to defaults is written BEFORE the live settings, so
taking the first row gives the wrong brush.

It also carries four `*Effector` blobs, which is where Clip Studio keeps the
way a dial answers the pen. Until now we read none of them and every .sut
arrived as a flat stroke. The blob is a 44-byte header and up to two records;
the header holds the two records' byte lengths, so header plus lengths has to
come to the blob exactly, and a reader that has drifted knows it rather than
inventing points. A record is `[12][which input][16]` and then pairs of
big-endian doubles already between 0 and 1 — the shape our own curves are in.

What the real file does NOT settle is which number means which input. Id 2
carries the straight 0,0-1,1 line on every dial Clip Studio drives from the
pen by default, so 2 is pen pressure and that much is used; the others are
counted into a warning instead of being guessed onto a sensor, because a
curve on the wrong sensor is a brush that behaves oddly, which is worse than
one that says what it is missing. The reference file has no custom curve at
all — both its variant rows hold byte-identical effectors — so it can prove
the layout and not the meanings.

Its table names, column names and values are copied from a real sub tool —
the sample.sut in tohsakarat/Brush-Converter, which is CC BY-NC-SA and so is
not redistributed here. That file is what the reader was actually developed
against: it comes out as an 80px blade six times longer than wide, turned
220 degrees, with its tip and its paper texture as PNGs and seven settings
honestly reported as dropped. Its own material thumbnails had been
overwritten by that repo's demo script before it was committed, so the
pictures in it prove the plumbing and not the pictures.

## What the second tip, the lightness map and the native tip size settled

`masked-generated.kpp` and `masked-file.kpp` are Revoy presets with
`MaskingBrush/Enabled` flipped on by make-masked-kpp.py, one whose masking
brush draws its own shape and one that names a file the pack does not carry.
They settled two things a document would not have:

  * `MaskingBrush/MasterSizeCoeff` is the masking brush's size divided by the
    main brush's -- 8.5415 over 250 is the 0.034166 in the file, to the digit
    -- so it is our `tip2Size` percentage exactly. Real coefficients run from
    3 per cent to sixteen times over, which is why the slider goes to 2000;
  * a mask at 3 per cent stamped once would shrink a dab to a dot. A masking
    brush is a mask REPEATED across the dab, anchored to the canvas the way
    the paper grain is -- so the second tip is a tile with its own gap and
    angle, applied per dab, and neighbouring dabs line up instead of each
    carrying its own copy of the pattern.

The same mechanism is what Photoshop's `dualBrush` asks for, and
three-tips-v10.abr exercises it: the second tip is the third sample in the
file, which no brush of its own claims, named by UUID the way a brush names
its own. Its `BlnM` is multiply, which is what carving IS -- any other blend
mode says so in the warnings rather than being painted as multiply in
silence. Clip Studio's `Dual*` family is still a warning: no file we hold
turns it on, and a fixture written from the format alone would prove only
that we can read what we wrote.

A tip's own pixels used to be thrown away twice -- once at import, once when
the dab was baked -- because a tip was only ever a cut-out. Krita's
`brushApplication` says otherwise: 1 reads the tip's greys as lightness over
the chosen colour, 3 stamps the picture as it stands. Both now work, and the
one we cannot do (2, reading the tip along a gradient, because there is no
gradient here) still says so. Keeping the pixels also fixed a reading that
had been wrong the whole time: the engine's loader took every tip's darkness
as coverage, including pictures that carried their own transparency, so a
coloured tip cut itself to nothing. Transparency, where a picture has it, is
the answer; only a flat opaque picture is a stamp scanned on white.

Tips are stored at their own resolution now -- the cap is 2326, the largest
in Resource Boy's 106-brush Drip pack, which is 41MB and stays off the repo.
That pack is the check: at the old 200px cap its spatter arrived as smooth
blobs, and the grain is the whole brush. 106 brushes import in 2.4s, a
300-point stroke at size 600 takes 11-16ms, and the dab is still baked at the
size it is painted, so a big tip costs storage and one decode rather than
memory per dab.

## The eight presets that were never being read, and the two that are not brushes

`itxt-binary-md5.kpp` is thin-brush-pointy rewritten by make-itxt-kpp.py the
way Krita writes its bigger presets: the settings in a compressed `iTXt`
chunk rather than a `zTXt` one, and a `Texture/Pattern/PatternMD5` holding the
sixteen RAW BYTES of a checksum inside CDATA. Several of those bytes are C0
control characters, which XML forbids outright — an XML parser stops at the
first one ("CData section not finished") and the whole preset goes with it.
Eight of the forty-six presets in David Revoy's 25.01 bundle are shaped like
that, and every one of them was arriving as "could not be read" and being
left out of the import in silence. Stripping the characters XML does not
allow costs nothing: not one of them is in anything we read.

`shapes-alchemy.kpp` and `distort-move.kpp` are that bundle's two presets
that are not brushes at all, copied out of it unchanged:

  * the experiment brush (`paintop=experimentbrush`) stamps nothing. The line
    you draw is an outline and its inside is filled — so it has no tip, no
    spacing and no dabs, and the engine draws it as one fill per frame,
    however long the stroke. `Experiment/windingFill` is the fill rule, and
    without it a stroke that crosses itself leaves the crossing hollow;
  * the deform brush (`paintop=deformbrush`) lays no paint down: it moves the
    pixels already on the layer. `Deform/deformAction` numbers the seven ways
    from one, in the order Krita's own menu lists them, and this preset's 5 is
    MOVE — which its name, "Distort Move Update", is what confirms the
    numbering. It writes straight to the layer rather than through the flow
    buffer, because the second dab of a deform has to see what the first one
    did, and the buffer exists to prevent exactly that. Its `CompositeOp` is
    "copy", which for a brush that replaces pixels is not a blend mode to
    warn about.

With those, the two alternate engines, the second tip, lightness-mapped tips
and the airbrush wheel (`tangentialpressure`, which is also Photoshop's
stylus wheel), all 46 presets of that bundle import with two warnings left
between them: Krita's "parallel" blend mode, which has no canvas equivalent
and cannot be faked with one. Nothing in the bundle turns impasto on — the
scaffolding is in every preset, `PaintThicknessEnabled` in none — so paint
thickness stays unbuilt rather than built against no file.

## Which picture in a .sut is which, and the second tip

Three more Clip Studio fixtures come out of `make-sut.py`, and all three were
measured against real sub tools first — seven of them, spanning five different
Variant schemas, out of 154 `.sut` files scanned.

The first finding is a plain bug. A Variant names its pictures in blobs, and
we were reading them by position: first material the tip, second the paper.
Real files do not store them in that order. `Cardboard Marker Redux.sut` has
five materials — its paper texture first, then four tip pictures — so it
imported painting *with the paper*, and `Leopard Pencil.sut` did the same.
The reference blob's layout, measured byte for byte:

    u32 8 · u32 how many · then per picture:
      u32 the record's own length, counted from here
      u32 bytes of path · UTF-16LE path to the material inside the file
      u32 2 · u32 bytes · UTF-16LE the material's name
      u32 1 · u32 bytes · UTF-16LE its catalogue path
      u32 0

That catalogue path is also a column on the material row, so the two pair up
exactly and position never has to be guessed at. `rough-scrape.sut` now stores
its four materials in the wrong order on purpose — paper last — so a reader
that counted rows fails the test rather than passing it by luck.

The second finding is the win: `BrushPatternImageArray` can name several
pictures, and a brush that names four is a strip of four, the same as a GIMP
pipe. Cardboard Marker has four, Leopard Pencil three. Every one of them
arrived as a single shape repeated.

`DualPatternImageArray` is the second tip, and it is a brush of its own —
`DualSize` in the same pixels as `BrushSize`, `DualFlow`, `DualInterval`,
`DualRotation`. It maps onto the second tip built for Krita's masked brush and
Photoshop's dual brush: one mechanism, three formats. `sample-csp.sut` is the
only file of the seven with `UseDualBrush` on; 30px against 80 is the 38% the
fixture asserts. We carve with the second tip, which is what Clip Studio's
darkening blend modes do — `DualBrushCompositeMode` asks for something else
here, and that is said rather than faked.

`pixel-select.sut` is not a brush. A fill or selection tool is stored in the
same tables with the same Node, and its Variant has none of the brush columns
in it — no `BrushSize`, none of the 150-odd dials around it. Before, one
imported as a plain round brush that had nothing to do with the tool. Now the
absence of `BrushSize` refuses it by name. (Real counterpart: `Pixel Select.sut`,
35 Variant columns against the ordinary 187.)

`library-tips.sut` is the case where the pictures live inside Clip Studio
rather than in the file: the material rows carry no catalogue path at all, so
the order they are written in is the only answer there is. That is the one
place the reader guesses, and the brush says so in its own import note.

### What a .sut still cannot tell us

Of the 154 files scanned, every single one holds exactly **one** Node — one
sub tool. Multi-subtool `.sut` does not exist in the wild, and Clip Studio's
own manual agrees, so there is nothing to build for it.

148 of the 154 share the identical 187-column schema, and not one of them is a
watercolour or oil engine. Those two are the remaining `.sut` gap, and only a
real export from Clip Studio can close it.

## Three formats that were not read at all

### one-tool.tpl — a Photoshop tool preset

A `.tpl` is a saved *tool*, not a saved brush. A saved paintbrush carries the
whole brush with it, so the ones worth reading hold the same two halves an
`.abr` does under different names: `tpbd` for the tip pictures, `tptp` for the
dials. Measured from three real files — one Photoshop's own, two from a
GrutBrushes pack — all version 3:

    8BTP · u32 version · u32 how many tools
    then 8BIM <key> <u32 length> <body>, one block per tool

Three things a reader has to survive, and the fixture has all three:

* the settings block in front of each tip is **47** bytes, not the 301 an
  `.abr` uses — the same layout otherwise, byte for byte;
* the descriptor is keyed `PbTl` (the paintbrush tool) and the framing in
  front of it differs from tool to tool, so it has to be found by its own
  shape — version 16, an empty class name, a four-character key — rather than
  counted to;
* another tool preset sits in front of it that is not a brush, and must be
  stepped over rather than read as one. `sample.tpl` (Photoshop's own, 4
  tools) has no `tpbd` at all: every one of its tools computes its tip, and
  that file is refused by name rather than half-read.

A tool preset also carries three things an `.abr` never does, because they
belong to the tool rather than to the tip: the **opacity**, the **flow** and
the **blend mode** it was saved at.

### round-soft.vbr, block-wide.vbr, star-ten.vbr — GIMP generated brushes

A `.vbr` is a shape described rather than drawn: eight or ten numbers of plain
text and no picture at all. GIMP builds the dab from them every time, so we
have to as well.

    GIMP-VBR · version · name · [shape] · spacing · radius · [spikes]
             · hardness · aspect ratio · angle

Version 1.0 has neither the shape nor the spike count; 1.5 has both. Read off
four real files out of a GIMP 2 install.

A plain round one needs no picture — that is the brush we already are, and
keeping it parametric means it stays sharp at any size. Everything else is
drawn: circle, square or diamond, squashed by the aspect ratio and turned by
the angle. **Spikes** are what make these stars — two is GIMP's default and
means the plain shape, and above two the shape is drawn once per spike, each
turned a further half-turn divided by their number. GIMP's own "Diagonal Star
(17)" is four thin ellipses at 45 degrees, which comes out as the eight-rayed
star its name promises; its "Star" is five diamonds at 36 degrees.

### sai-shape.bmp — a SAI brush shape

SAI keeps no brush file at all. A brush there is a row in a plain-text index
(`brushform.conf`, `brushtex.conf`, `papertex.conf`) naming a `.bmp` in one of
four folders — `elemap` for the shape, `blotmap` for the speckle, `brushtex`
and `papertex` for grain — so the `.bmp` is the whole of what is portable.

The one thing a reader has to know is that the shapes are drawn on a template:
a white square with a pale blue guide circle and crosshair already on it, the
shape itself in plain grey. SAI ignores any pixel that is not a grey; read as
ink, the guide puts a faint ring round every stamp. Blue over equal red and
green is exactly that guide and nothing an ordinary tip picture is made of.
Measured from a real resource folder: 24 `elemap` files, all 63×63, all
24-bit, whose colours come to white, pure greys, and blues of the form
(n, n, 255).

## What a real Photoshop pack still says it lost

`RamonN90_Brushes.abr` — 71 tips, sizes from 9 to 2500px — was the audit for
all of this. Two whole warnings turned out to be ours rather than the file's:

* **Transfer** (`usePaintDynamics`) was reported dropped on 42 of 71. The
  dials are right there as `prVr` and `opVr`, the same dynamics object every
  other dial gets, and they map onto our flow. Both are written whether or not
  either is on, and 23 brushes leave the flow's own switched off and drive the
  opacity instead, so the one that actually drives something is the one to
  take. Another 18 have Transfer on with both dials set to nothing, which is a
  brush that varies nothing and no longer says otherwise.
* **Colour dynamics** was reported dropped on 8 of 9 that use it: Photoshop
  wrote the three dials out in full once and as four bare characters again,
  and `H   ` / `Strt` / `Brgh` is what a recent Photoshop saves.

Three other real packs — 24 pastel chalks, Eldar Zakirov's fur set, a splatter
set — now import with **no warnings at all**.

What is left is honest: 20 brushes ask for a paper texture the file does not
carry (no `.abr` anywhere embeds a `patt` section — eight packs scanned, and
abrdump ships no test file with one either, so pattern-by-name resolution
stays untested and unbuilt), one dual brush names a tip that is not in the
file, and wet edges, added noise and a fixed pen pose have no counterpart here.

Two formats named in the plan were dropped on the evidence rather than built:
**`.abr` version 12** (everything in the wild is v6 or v10) and **brushes
embedded in a `.kra`** (a real 124MB production file embeds none — Krita does
not do it in practice).

## The watercolour, oil and gouache brushes

Seven real sub tools settled this — `Watercolor splash`, `Wet wash`,
`Flat watercolor brush`, `Gouache`, `Dry Gouache`, `Oil paint`, `Pointillism`
— alongside `Cardboard Marker Redux` and the pencil already here. They all
carry a Variant table of **189 columns** rather than the 187 we had read.

The two extra columns are `BrushBlurKind` and `BrushQuality`, and both are
**zero in every one of the nine**. They are a newer Clip Studio's blur and
render-quality fields, not a watercolour switch: an older file simply does not
have the columns. Nothing was hiding there. What makes these brushes wet lives
in the 187 columns we already had, in three we were not reading.

**Mixing is switched on by any of three columns, not one.**
`BrushUseWaterColor` and `BrushUseWaterColor2` always agree with each other,
and `BrushColorMixingMode` agrees with both — six brushes have all three on,
four have all three off. But `BrushWaterColor` is separate, and the two
brushes that set it (`Flat watercolor brush` at 2, `Cardboard Marker Redux` at
1) leave the other three at zero. Reading only the obvious ones imported a
marker and a watercolour brush **bone dry**, with a `BrushMixColor` of 66 and
25 sitting unused in the file. Both now mix. `BrushMixColor` on its own is not
enough to go on: `Watercolor splash` has 30 in it with every switch off, and
it is a stamp brush that must not smear.

**`BrushMixColorExtension` is how far out it gathers.** It is the one column
that separates the oil and marker brushes from the washes — 87 on `Oil paint`
and 67 on the marker against 10 to 15 on every watercolour — and it lands on
`smudgeRadius`, a reach on top of the dab's own radius, as `100 + value`. The
effect is gentle at that range by design: 187% carries noticeably more of the
paper's colour along a stroke than 100% does, without the smear of the 400%
the parameter allows.

`BrushMixAlpha` (50 to 100 across the nine) is a second dimension — how much
of the paper's *transparency* comes with the colour — and our smudge takes
colour and alpha together, so there is nothing to split it onto. It is not
warned about, because the thing it modifies already happens.

**The rotation dropdown is a bitmask, and it was warning about nothing.**
`BrushRotationEffector` is a small integer, not a curve blob. Across every
brush here it takes the values 1, 3, 19, 35, 131 and 147 — that is bits 1 and
2 on in all of them, plus some of 16, 32 and 128. Bits 1 and 2 are structure.
Bit **128 is random**: the only two brushes that move
`BrushRotationRandomScale` off its default of 100 are the two that set it
(`Cardboard Marker Redux` at 15, `Pointillism` at 25), and both are brushes
whose tip visibly tumbles. That becomes `angleSrc: 'random'` with
`angleRange` at 1.8× the scale, so a quarter-turn setting is a quarter turn.
Bits 16 and 32 are still unnamed and still warn. Before this, every one of the
seven said "dropped: the rule that turns its tip as you draw" on a value of 3
that means the tip does not turn.

`library-tips.sut` carries the two new cases: it switches its mixing on with
`BrushWaterColor` alone, and its rotation mask is 131 with a scale of 25.
`rough-scrape.sut` carries `BrushMixColorExtension`.

### What these brushes still say they lost

`BrushBlur` is set on every brush with a tip image — 5.0 with `BrushBlurUnit`
0 on nine of them, 0.3 with unit 2 on the two gouaches — and never on the
pixel tools, which have the column empty. There is no "use blur" flag beside
it, the two value/unit pairs look like two Clip Studio versions' resting
defaults rather than a decision, and nothing here can say which. It keeps its
warning rather than being mapped on a guess.

`BrushUseWaterEdge`, `BrushWaterEdgeRadius` and `BrushWaterEdgeAlphaPower` are
now built (`edgeWidth`/`edgeDensity`, gated on the switch): a dark band at the
ink boundary where pooled pigment dries darkest. The rest of the
`BrushWaterEdge*` family — unit, tone, drag timing, and the blur CSP applies
to the ring — has no equivalent here yet and stays named. `Stickness` is still
unbuilt and named. `BrushChangePatternColor` says whether the material keeps
its own colours instead of taking the drawing colour; our tips are alpha
masks and always take the colour, so it is not reported.

**The wash itself is a flush-time proportional scale, not a per-dab cut
(2026-09-17, revised same day).** `out.watercolor = 1` used to be diluted per
dab by a fixed `_WATERCOLOR_WASH` factor, and that factor only survived a
stack of overlapping dabs correctly for a symmetric round tip — the same
size/spacing estimate the taper fade uses. Against `Flat watercolor brush`'s
real custom tip (44×99px, off-square) it either washed a stroke to
near-invisible or barely diluted it at all, depending on stroke direction,
because the true overlap count for a lopsided tip has no closed form. The
wash first became a *ceiling* applied to the finished stroke's own alpha at
flush time — a plain clamp to a fixed cap — which fixed the opacity but was
never actually checked against a real Clip Studio screenshot before being
called done. It wasn't close: side-by-side against `CSP.png`, the brush also
had the wrong aspect ratio, no visible paper grain, and no edge ring, and a
second stroke drawn over the first read as blotchy rather than a clean
uniform darkening. All four turned out to share one root cause plus two
compounding gaps, all now fixed:

- **Aspect ratio / blotchy overlap — the tip never rotated to follow the
  stroke.** `BrushRotationEffector`'s bit 32 is Clip Studio's "turn the tip as
  you draw", and the importer only recognised bits 1/2 (structure) and 128
  (random) — bit 32 fell into the catch-all and was warned-and-dropped
  (`brush-pack.js`, the rotation-effector block). A lopsided tip stuck at a
  fixed angle paints a different apparent width depending on drag direction,
  which reads as a wrong aspect ratio on any stroke not aligned with that
  fixed angle, and as uneven, blotchy dab overlap generally. Bit 32 now maps
  to `angleSrc: 'direction'`, an existing, well-exercised engine feature (half
  the built-in bristle presets already use it) — no engine change needed,
  just wiring the importer up to it.
- **Texture invisible — paper grain was being applied per dab, then erased
  by the next dab.** `Flat watercolor brush` paints at 1% spacing (a dab
  roughly every 1px at this size), and grain was punched into each dab's own
  scratch mask via `destination-out` *before* it composited — so a hole one
  dab made was almost always painted back over solid by the next, barely
  shifted, dab. Measured: 254–255/255 alpha, essentially zero variance,
  regardless of the texture dial. Grain is now also applied once to the
  *finished* stroke shape at flush time (reusing `_applyTextureNoise`, the
  same function, just called once over the accumulated ink instead of once
  per dab) — the same fix the engine's dual-tip path already used for its own
  grain, extended to plain `texture` so it doesn't need a dual tip to survive
  dense spacing.
- **No edge ring — the constants were a first guess nobody had checked.**
  `_EDGE_DARK`/`_EDGE_TINT`/`_EDGE_LIFT` were commented as an untuned initial
  guess from the start; against this brush's own dial (`edgeWidth: 2`,
  `edgeDensity: 10`) they produced a well-under-1%-alpha ring, invisible next
  to ordinary antialiasing, even though Clip Studio's own render at those
  same values shows one plainly. The box-blur radius floor was raised from 1
  to 3px (a 1–2px blur barely outruns the tip mask's own antialiasing, so
  there's no "deficit" left to detect), the density curve was changed from
  linear to square-rooted (CSP calibrates this dial low and still gets a
  visible ring; linear left a low dial too weak to see), and the three
  constants were raised roughly 3x — all four numbers tuned by rendering this
  exact brush and comparing against `CSP.png` directly, not guessed.

Once all three were fixed together, the rendered stroke visually matches
`CSP.png`: same aspect ratio, a pale grainy wash, a soft edge, and a second
stroke over the first darkening as one uniform pass rather than by
individual dab. The wash mechanism is now a proportional **scale**
(`d[i] *= wash`), not a clamp: a clamp flattens every saturated pixel to the
exact same value, which is exactly what was erasing the newly-visible grain
(dabs stack past the cap almost everywhere this tip overlaps, so a clamp
made the whole interior read as one flat number). A scale preserves whatever
shape the accumulated ink already has — grain dips, taper, edge falloff —
just dimmed, which also reads as a truer wash (real pigment dilutes
proportionally, it doesn't get plastered flat). Because a scale isn't
idempotent the way a clamp is (rescaling something already scaled compounds),
it now runs on its own copy of the flow buffer (`_washCanvas`), the same
"copy, never the live buffer" pattern the edge ring already used, rather than
mutating the buffer that later dabs of the same stroke still composite into.
`watercolor` itself was also never registered in `engine.DEFAULTS`, so
`loadPreset` silently dropped the flag the importer set and every `.sut`
watercolour brush painted as plain opaque ink regardless — fixed alongside
the rest.
