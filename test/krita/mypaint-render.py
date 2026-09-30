# Paint reference strokes with libmypaint itself -- the copy Krita ships.
#
#   python test/krita/mypaint-render.py job.json
#
# job: { width, height, out, msPerPx, renders: [{ name, file, maxSize, lines, warm, under }] }
# lines: [[x0, y0, p0, x1, y1, p1], ...], about a pen sample a pixel, the pen moving a pixel per msPerPx.
# Krita's own paintLine hands MyPaint no time between samples, so slow
# tracking never catches up and strokes stop short; a pen always has time.
# warm: paint the lines once on a scratch surface first, so the brush's
# random numbers are different ones (a == warm b means nothing is random).
# under: paint over stripes() instead of nothing -- a blender or an eraser
# changes nothing on an empty surface (measure.mjs's STRIPES are the same).
# Writes <name>.png (RGBA, black ink) and meta.json ({ name: { size, file, ink, under } }).
import ctypes as C, json, math, os, struct, sys, zlib

BIN = os.environ.get('KRITA_BIN', r'C:\Program Files\Krita (x64)\bin')
os.add_dll_directory(BIN)
L = C.CDLL(os.path.join(BIN, 'libmypaint.dll'))
P, F, I, D = C.c_void_p, C.c_float, C.c_int, C.c_double
for n, res, args in [
        ('mypaint_brush_new', P, []), ('mypaint_brush_unref', None, [P]),
        ('mypaint_brush_from_string', I, [P, C.c_char_p]), ('mypaint_brush_from_defaults', None, [P]), ('mypaint_brush_reset', None, [P]),
        ('mypaint_brush_new_stroke', None, [P]), ('mypaint_brush_setting_from_cname', I, [C.c_char_p]),
        ('mypaint_brush_get_base_value', F, [P, I]), ('mypaint_brush_set_base_value', None, [P, I, F]),
        # 1.6 takes viewzoom, viewrotation, barrel_rotation after dtime; an older one ignores them
        ('mypaint_brush_stroke_to', I, [P, P, F, F, F, F, F, D, F, F, F, I]),
        ('mypaint_fixed_tiled_surface_new', P, [I, I]), ('mypaint_fixed_tiled_surface_interface', P, [P]),
        ('mypaint_surface_begin_atomic', None, [P]), ('mypaint_surface_end_atomic', None, [P, P]),
        ('mypaint_surface_unref', None, [P]),
        ('mypaint_tiled_surface_tile_request_start', None, [P, P]),
        ('mypaint_tiled_surface_tile_request_end', None, [P, P])]:
    f = getattr(L, n); f.restype = res; f.argtypes = args

class Req(C.Structure):
    _fields_ = [('tx', I), ('ty', I), ('readonly', I), ('buffer', C.POINTER(C.c_uint16)),
                ('context', P), ('thread_id', I), ('mipmap_level', I)]

sid = lambda n: L.mypaint_brush_setting_from_cname(n.encode())
T = 64
EVENT = 0.005   # seconds from the last report to the press, and to the lift (MP_EVENT in the engine)

def stroke(brush, surf, lines, dt):
    for x0, y0, p0, x1, y1, p1 in lines:
        L.mypaint_brush_reset(brush)
        L.mypaint_brush_new_stroke(brush)
        n = max(1, round(math.hypot(x1 - x0, y1 - y0)))
        dn = dt * math.hypot(x1 - x0, y1 - y0) / n   # the pen's speed, not its sample rate (measure.mjs's clock)
        L.mypaint_surface_begin_atomic(surf)
        L.mypaint_brush_stroke_to(brush, surf, x0, y0, 0, 0, 0, 0.5, 1, 0, 0, 0)   # hovering in
        for i in range(n + 1):
            t = i / n
            L.mypaint_brush_stroke_to(brush, surf, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t,
                                      p0 + (p1 - p0) * t, 0, 0, dn if i else EVENT, 1, 0, 0, 0)
        L.mypaint_brush_stroke_to(brush, surf, x1, y1, 0, 0, 0, EVENT, 1, 0, 0, 0)    # lifted
        L.mypaint_surface_end_atomic(surf, None)

def png(path, w, h, rgba):
    raw = b''.join(b'\0' + rgba[y * w * 4:(y + 1) * w * 4] for y in range(h))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d))
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                           + ch(b'IDAT', zlib.compress(raw, 6)) + ch(b'IEND', b''))

def clear(fixed, w, h):   # a new surface is filled with 0xffff, past 1.0
    for ty in range((h + T - 1) // T):
        for tx in range((w + T - 1) // T):
            r = Req(tx, ty, 0, None, None, -1, 0)
            L.mypaint_tiled_surface_tile_request_start(fixed, C.byref(r))
            C.memset(r.buffer, 0, T * T * 8)
            L.mypaint_tiled_surface_tile_request_end(fixed, C.byref(r))

STRIPES = [(255, 0, 0), (0, 0, 255), (255, 255, 0)]   # 16px columns, opaque

def stripes(fixed, w, h):
    for ty in range((h + T - 1) // T):
        for tx in range((w + T - 1) // T):
            r = Req(tx, ty, 0, None, None, -1, 0)
            L.mypaint_tiled_surface_tile_request_start(fixed, C.byref(r))
            for y in range(T):
                for x in range(T):
                    k = (y * T + x) * 4
                    c = STRIPES[(tx * T + x) // 16 % 3]
                    for i in range(3): r.buffer[k + i] = round(c[i] * 32768 / 255)
                    r.buffer[k + 3] = 32768
            L.mypaint_tiled_surface_tile_request_end(fixed, C.byref(r))

def pixels(fixed, w, h):
    out = bytearray(w * h * 4)
    for ty in range((h + T - 1) // T):
        for tx in range((w + T - 1) // T):
            r = Req(tx, ty, 1, None, None, -1, 0)
            L.mypaint_tiled_surface_tile_request_start(fixed, C.byref(r))
            b = r.buffer
            for y in range(ty * T, min(h, ty * T + T)):
                for x in range(tx * T, min(w, tx * T + T)):
                    k = ((y - ty * T) * T + (x - tx * T)) * 4
                    a = b[k + 3]
                    if not a: continue
                    o = (y * w + x) * 4
                    for c in range(3): out[o + c] = min(255, round(b[k + c] * 255 / a))   # premultiplied, 1.0 = 1<<15
                    out[o + 3] = min(255, round(a * 255 / 32768))
            L.mypaint_tiled_surface_tile_request_end(fixed, C.byref(r))
    return bytes(out)

job = json.load(open(sys.argv[1], encoding='utf-8'))
W, H, dt = job['width'], job['height'], job.get('msPerPx', 2) / 1000
os.makedirs(job['out'], exist_ok=True)
meta = {}
for r in job['renders']:
    brush = L.mypaint_brush_new()
    L.mypaint_brush_from_defaults(brush)   # a setting the file leaves out keeps its default, as in Krita and MyPaint
    if not L.mypaint_brush_from_string(brush, open(r['file'], 'rb').read()):
        print('unreadable', r['file']); L.mypaint_brush_unref(brush); continue
    rad = math.exp(L.mypaint_brush_get_base_value(brush, sid('radius_logarithmic')))
    if r.get('maxSize') and 2 * rad > r['maxSize']: rad = r['maxSize'] / 2
    L.mypaint_brush_set_base_value(brush, sid('radius_logarithmic'), math.log(rad))
    for k in ('color_h', 'color_s', 'color_v'): L.mypaint_brush_set_base_value(brush, sid(k), 0)
    if r.get('warm'):
        s0 = L.mypaint_fixed_tiled_surface_new(W, H)
        clear(s0, W, H)
        if r.get('under'): stripes(s0, W, H)
        stroke(brush, L.mypaint_fixed_tiled_surface_interface(s0), r['lines'], dt)
        L.mypaint_surface_unref(L.mypaint_fixed_tiled_surface_interface(s0))
    fixed = L.mypaint_fixed_tiled_surface_new(W, H)
    clear(fixed, W, H)
    if r.get('under'): stripes(fixed, W, H)
    surf = L.mypaint_fixed_tiled_surface_interface(fixed)
    stroke(brush, surf, r['lines'], dt)
    px = pixels(fixed, W, H)
    png(os.path.join(job['out'], r['name'] + '.png'), W, H, px)
    meta[r['name']] = {'size': 2 * rad, 'file': os.path.basename(r['file']), 'ink': any(px[3::4]), 'under': bool(r.get('under'))}
    L.mypaint_surface_unref(surf); L.mypaint_brush_unref(brush)
mp = os.path.join(job['out'], 'meta.json')   # a job adds to what is there
json.dump({**(json.load(open(mp)) if os.path.exists(mp) else {}), **meta}, open(mp, 'w'), indent=1)
