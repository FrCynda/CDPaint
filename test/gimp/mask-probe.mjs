// Black-box probe of GIMP's generated brushes (the .vbr kind): each brush is
// made through GIMP's own scripting interface and GIMP hands back the mask it
// built, byte for byte (gimp-brush-get-pixels). No painting, so no dab
// placement in the way.
//   node test/gimp/mask-probe.mjs <out> '<json>'
// json: [{ "shape": 0|1|2 (circle, square, diamond), "radius": 10, "spikes": 2,
//          "hardness": 0.5, "aspect": 1, "angle": 0, "row": false }, ...]
// row: true keeps only the middle row (big brushes are slow to write out whole).
// Writes test/krita/out/gimp-probe/<out>/masks.json: [{ ...spec, w, h, mask: [...] }].
import { REPO_ROOT } from '../browser.mjs';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const GIMP = process.env.GIMP_CONSOLE || 'C:/Program Files/GIMP 2/bin/gimp-console-2.10.exe';
const [out, spec] = process.argv.slice(2);
const specs = JSON.parse(spec);
const dir = path.join(REPO_ROOT, 'test', 'krita', 'out', 'gimp-probe', out);
const prof = path.join(dir, 'profile');
fs.rmSync(prof, { recursive: true, force: true });
fs.mkdirSync(prof, { recursive: true });
const txt = path.join(dir, 'masks.txt').replace(/\\/g, '/');
const num = v => (Number.isInteger(v) ? v + '.0' : String(v));
const scm = [`(gimp-message-set-handler 1)
(define port (open-output-file "${txt}"))
(define (put-vec v n) (let loop ((i 0)) (if (< i n) (begin (write (vector-ref v i) port) (write-char #\\space port) (loop (+ i 1))))))`];
specs.forEach((s, i) => scm.push(`(let* ((b (car (gimp-brush-new "probe${i}"))))
  (gimp-brush-set-shape b ${s.shape || 0})
  (gimp-brush-set-radius b ${num(s.radius)})
  (gimp-brush-set-spikes b ${s.spikes || 2})
  (gimp-brush-set-hardness b ${num(s.hardness)})
  (gimp-brush-set-aspect-ratio b ${num(s.aspect || 1)})
  (gimp-brush-set-angle b ${num(s.angle || 0)})
  (let* ((px (gimp-brush-get-pixels b)) (w (car px)) (h (cadr px)) (n (cadddr px)))
    (write w port) (write-char #\\space port) (write h port) (write-char #\\space port)
    ${s.row ? `(let loop ((i (* (quotient h 2) w))) (if (< i (* (+ (quotient h 2) 1) w)) (begin (write (vector-ref (list-ref px 4) i) port) (write-char #\\space port) (loop (+ i 1)))))`
            : '(put-vec (list-ref px 4) n)'} (newline port))
  (gimp-brush-delete b))`));
scm.push('(close-output-port port)', '(gimp-quit 0)');
const r = spawnSync(GIMP, ['-i', '-f', '-b', '-'], { input: scm.join('\n'), encoding: 'utf8', timeout: 600000,
    env: { ...process.env, GIMP2_DIRECTORY: prof }, maxBuffer: 1 << 26, windowsHide: true });
fs.writeFileSync(path.join(dir, 'gimp.log'), (r.stdout || '') + (r.stderr || ''));
fs.rmSync(prof, { recursive: true, force: true });
const lines = fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8').trim().split('\n') : [];
const res = lines.map((l, i) => { const v = l.trim().split(/\s+/).map(Number); return { ...specs[i], w: v[0], h: v[1], mask: v.slice(2) }; });
fs.writeFileSync(path.join(dir, 'masks.json'), JSON.stringify(res));
console.log(res.map(m => `${m.shape}/${m.radius}/${m.hardness}: ${m.w}x${m.h}`).join('\n') || 'no masks -- see gimp.log');
