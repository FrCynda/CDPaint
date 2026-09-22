"""CDPaint's Krita render harness. Does nothing unless CDP_KRITA_JOB names a
job file; render.mjs installs it for one run and removes it again.

A job is JSON:
  { "width": 400, "height": 200, "out": "C:/.../dir",
    "renders": [ { "name": "basic5", "preset": "b) Basic-5 Size",
                   "color": [0, 0, 0], "size": 30,            (size optional)
                   "lines": [ [x0, y0, p0, x1, y1, p1], ... ] } ] }
Each line is ONE Krita stroke (Node.paintLine, whole-pixel ends in 5.3): pressure runs linearly from
p0 to p1 along it, the way a tablet sweep would. Each render goes on a fresh
transparent layer and is written to <out>/<name>.png as straight RGBA.
"""
import os, json, traceback
from krita import Krita, Extension, ManagedColor
from PyQt5.QtCore import QPoint, QTimer
from PyQt5.QtGui import QImage

JOB = os.environ.get("CDP_KRITA_JOB")


def _log(msg):
    with open(os.path.join(os.path.dirname(JOB), "harness.log"), "a", encoding="utf-8") as f:
        f.write(msg + "\n")


def _run():
    k = Krita.instance()
    job = json.load(open(JOB, encoding="utf-8"))
    W, H = job["width"], job["height"]
    presets = k.resources("preset")
    doc = k.createDocument(W, H, "cdp", "RGBA", "U8", "", 72.0)
    win = k.activeWindow() or k.openWindow()
    view = win.addView(doc)
    root = doc.rootNode()
    meta = {}
    for r in job["renders"]:
        try:
            p = presets.get(r["preset"])
            if p is None:
                _log("MISSING PRESET " + r["preset"]); continue
            view.setCurrentBrushPreset(p)
            if "size" in r: view.setBrushSize(float(r["size"]))
            c = ManagedColor("RGBA", "U8", "")
            rgb = r.get("color", [0, 0, 0])
            c.setComponents([rgb[2] / 255, rgb[1] / 255, rgb[0] / 255, 1.0])  # Krita's U8 order is BGRA
            view.setForeGroundColor(c)
            layer = doc.createNode(r["name"], "paintlayer")
            root.addChildNode(layer, None)
            doc.setActiveNode(layer)
            for x0, y0, p0, x1, y1, p1 in r["lines"]:
                layer.paintLine(QPoint(round(x0), round(y0)), QPoint(round(x1), round(y1)), p0, p1, "ForegroundColor")
                doc.waitForDone()
            doc.waitForDone()
            data = bytes(layer.pixelData(0, 0, W, H))
            img = QImage(data, W, H, W * 4, QImage.Format_ARGB32)  # BGRA bytes = ARGB32 little-endian
            img.save(os.path.join(job["out"], r["name"] + ".png"))
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
