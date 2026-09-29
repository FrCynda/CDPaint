"""CDPaint's Krita render harness. Does nothing unless CDP_KRITA_JOB names a
job file; render.mjs installs it for one run and removes it again.

A job is JSON:
  { "width": 400, "height": 200, "out": "C:/.../dir",
    "renders": [ { "name": "basic5", "preset": "b) Basic-5 Size",   (or "file": "x.kpp")
                   "color": [0, 0, 0], "size": 30,            (size optional)
                   "lines": [ [x0, y0, p0, x1, y1, p1], ... ],
                   "paths": [ [x, y, x, y, ...], ... ],   (optional: one stroke each)
                   "fill": [r, g, b, a],        (optional: the layer's colour before painting)
                   "rects": [ [x, y, w, h, r, g, b, a], ... ],   (optional: blocks over the fill)
                   "xmlSub": [ [regex, replacement], ... ],            (optional)
                   "maxSize": 40,                  (optional: cap the preset's own size)
                   "dumpXml": true,             (optional: <out>/<name>.xml)
                   "keepLayer": true,           (optional: paint on the previous render's layer)
                   "alphaLock": true,           (optional: lock the layer's alpha first)
                   "selection": [x, y, w, h, soft] } ],   (optional: soft ramps 0 -> 255 left to right)
  "listFile": "C:/.../presets.json" }          (optional: every loaded preset)
xmlSub edits the preset's XML before painting (Preset.toXML/fromXML), to
render a preset with one option switched off. The edit is in memory only:
Krita keeps it as an unsaved tweak and nothing is written back -- which also
means it is STILL THERE for every later render of the same preset in the job.
A render must set every value an earlier one changed, or run in its own job.
Each line is ONE Krita stroke (Node.paintLine, whole-pixel ends in 5.3): pressure runs linearly from
p0 to p1 along it, the way a tablet sweep would. Each render goes on a fresh
transparent layer and is written to <out>/<name>.png as straight RGBA.
"""
import os, re, json, traceback
from krita import Krita, Extension, ManagedColor, Preset, Selection
from PyQt5.QtCore import QPoint, QPointF, QTimer, QByteArray
from PyQt5.QtGui import QImage, QPainterPath

JOB = os.environ.get("CDP_KRITA_JOB")


def _log(msg):
    with open(os.path.join(os.path.dirname(JOB), "harness.log"), "a", encoding="utf-8") as f:
        f.write(msg + "\n")


def _run():
    k = Krita.instance()
    job = json.load(open(JOB, encoding="utf-8"))
    W, H = job["width"], job["height"]
    presets = k.resources("preset")
    if job.get("listFile"):   # what Krita actually loaded: name -> file
        json.dump({n: p.filename() for n, p in presets.items()}, open(job["listFile"], "w", encoding="utf-8"))
    doc = k.createDocument(W, H, "cdp", "RGBA", "U8", "", 72.0)
    win = k.activeWindow() or k.openWindow()
    view = win.addView(doc)
    root = doc.rootNode()
    meta = {}
    for r in job["renders"]:
        try:
            p = presets.get(r.get("preset"))
            if p is None and r.get("file"):   # by file: Krita's name is not always the file's
                p = next((q for q in presets.values() if q.filename() == r["file"]), None)
            if p is None:
                _log("MISSING PRESET %s %s" % (r.get("preset"), r.get("file"))); continue
            view.setCurrentBrushPreset(p)
            if r.get("dumpXml"):
                open(os.path.join(job["out"], r["name"] + ".xml"), "w", encoding="utf-8").write(Preset(view.currentBrushPreset()).toXML())
            if r.get("xmlSub"):
                cur = Preset(view.currentBrushPreset())
                xml = cur.toXML()
                for pat, rep in r["xmlSub"]:
                    xml, n = re.subn(pat, rep, xml)
                    _log("xmlSub %r: %d" % (pat, n))
                cur.fromXML(xml)
                view.setCurrentBrushPreset(view.currentBrushPreset())
            if "size" in r: view.setBrushSize(float(r["size"]))
            if "maxSize" in r and view.brushSize() > r["maxSize"]: view.setBrushSize(float(r["maxSize"]))
            c = ManagedColor("RGBA", "U8", "")
            rgb = r.get("color", [0, 0, 0])
            c.setComponents([rgb[2] / 255, rgb[1] / 255, rgb[0] / 255, 1.0])  # Krita's U8 order is BGRA
            view.setForeGroundColor(c)
            if r.get("keepLayer"):
                layer.setVisible(True)
            else:
                layer = doc.createNode(r["name"], "paintlayer")
                root.addChildNode(layer, None)
            doc.setActiveNode(layer)
            layer.setAlphaLocked(bool(r.get("alphaLock")))
            if r.get("selection"):
                sx, sy, sw, sh, soft = r["selection"]
                sel = Selection()
                if soft:
                    for i in range(sw): sel.select(sx + i, sy, 1, sh, round(255 * i / (sw - 1)))
                else:
                    sel.select(sx, sy, sw, sh, 255)
                doc.setSelection(sel)
                doc.waitForDone()
            if r.get("fill") and not r.get("keepLayer"):   # [r, g, b, a]: the layer starts painted, for brushes that pick colour up
                f = r["fill"]
                layer.setPixelData(QByteArray(bytes([f[2], f[1], f[0], f[3]]) * (W * H)), 0, 0, W, H)
            for x, y, w, h, cr, cg, cb, ca in r.get("rects", []):   # then painted blocks on top
                layer.setPixelData(QByteArray(bytes([cb, cg, cr, ca]) * (w * h)), x, y, w, h)
            for x0, y0, p0, x1, y1, p1 in r.get("lines", []):
                layer.paintLine(QPoint(round(x0), round(y0)), QPoint(round(x1), round(y1)), p0, p1, "ForegroundColor")
                doc.waitForDone()
            for pts in r.get("paths", []):   # one stroke through [x, y, x, y, ...] (Node.paintPath)
                path = QPainterPath(QPointF(pts[0], pts[1]))
                for i in range(2, len(pts), 2): path.lineTo(QPointF(pts[i], pts[i + 1]))
                layer.paintPath(path, "ForegroundColor", "None")
                doc.waitForDone()
            doc.waitForDone()
            data = bytes(layer.pixelData(0, 0, W, H))
            img = QImage(data, W, H, W * 4, QImage.Format_ARGB32)  # BGRA bytes = ARGB32 little-endian
            img.save(os.path.join(job["out"], r["name"] + ".png"))
            if r.get("selection"):
                k.action("deselect").trigger()
                doc.waitForDone()
            layer.setVisible(False)
            meta[r["name"]] = {"preset": view.currentBrushPreset().name(), "size": view.brushSize(), "file": p.filename(),
                               "krita": k.version()}
            _log("OK %s preset=%s size=%.2f" % (r["name"], view.currentBrushPreset().name(), view.brushSize()))
        except Exception:
            _log("FAIL " + r.get("name", "?") + "\n" + traceback.format_exc())
    json.dump(meta, open(os.path.join(job["out"], "meta.json"), "w"), indent=1)
    doc.setModified(False)
    _log("DONE")
    doc.close()
    k.action("file_quit").trigger()


def _safe_run():
    try:
        _run()
    except Exception:
        _log("FATAL\n" + traceback.format_exc())
        os._exit(3)


class _Harness(Extension):
    def setup(self):
        # The window has to exist before a view can be added to it.
        Krita.instance().notifier().windowCreated.connect(lambda: QTimer.singleShot(300, _safe_run))

    def createActions(self, window):
        pass


if JOB:
    Krita.instance().addExtension(_Harness(Krita.instance()))
