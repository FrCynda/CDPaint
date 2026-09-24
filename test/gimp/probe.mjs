// Black-box probe of GIMP's paintbrush: GIMP's own brushes (by name) painted
// with the given strokes, one PNG per brush and stroke set, the way the bank
// paints them (gimp-console, private profile, Dynamics Off, opacity 100).
//   node test/gimp/probe.mjs <out> '<json>'
// json: { "brushes": [{ "name": "2. Hardness 050", "size": 30, "spacing": 10 }],
//         "strokes": { "dab": [[100, 50.5]], "line": [[40, 50, 160, 50]] }, "w": 200, "h": 100 }
// A stroke is one or more polylines; a single point is a lone dab. Writes
// test/krita/out/gimp-probe/<out>/<brush index>-<stroke>.png.
import { REPO_ROOT } from '../browser.mjs';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const GIMP = process.env.GIMP_CONSOLE || 'C:/Program Files/GIMP 2/bin/gimp-console-2.10.exe';
const [out, spec] = process.argv.slice(2);
const job = JSON.parse(spec);
const W = job.w || 200, H = job.h || 100;
const dir = path.join(REPO_ROOT, 'test', 'krita', 'out', 'gimp-probe', out);
const prof = path.join(dir, 'profile');
fs.rmSync(prof, { recursive: true, force: true });
fs.mkdirSync(path.join(prof, 'brushes'), { recursive: true });
const q = s => '"' + s.replace(/\\/g, '/') + '"';
const num = v => (Number.isInteger(v) ? v + '.0' : String(v));
const scm = [`(gimp-message-set-handler 1)
(gimp-context-set-dynamics "Dynamics Off")
(gimp-context-set-opacity 100)
(gimp-context-set-paint-mode LAYER-MODE-NORMAL)
(gimp-context-set-foreground '(0 0 0))`];
job.brushes.forEach((b, i) => {
    for (const [sname, lines] of Object.entries(job.strokes)) {
        const file = path.join(dir, i + '-' + sname + '.png');
        scm.push(`(let* ((img (car (gimp-image-new ${W} ${H} RGB)))
       (lay (car (gimp-layer-new img ${W} ${H} RGBA-IMAGE "ink" 100 LAYER-MODE-NORMAL))))
  (gimp-image-insert-layer img lay 0 0)
  (gimp-context-set-brush ${q(b.name)})
  (gimp-context-set-brush-default-size)
  (gimp-context-set-brush-default-hardness)
  ${b.size ? `(gimp-context-set-brush-size ${num(b.size)})` : ''}
  ${b.spacing != null ? `(gimp-context-set-brush-spacing ${num(b.spacing)})` : '(gimp-context-set-brush-default-spacing)'}
  (gimp-context-set-brush-aspect-ratio 0) (gimp-context-set-brush-angle 0)
${lines.map(l => {
    const pts = l.length === 2 ? [...l, ...l] : l;
    return `  (gimp-paintbrush lay 0 ${pts.length} #(${pts.map(num).join(' ')}) PAINT-CONSTANT 0)`;
}).join('\n')}
  (gimp-file-save RUN-NONINTERACTIVE img lay ${q(file)} ${q(file)})
  (gimp-image-delete img))`);
    }
});
scm.push('(gimp-quit 0)');
fs.writeFileSync(path.join(dir, 'render.scm'), scm.join('\n'));
const r = spawnSync(GIMP, ['-i', '-f', '-b', '-'], { input: scm.join('\n'), encoding: 'utf8', timeout: 600000,
    env: { ...process.env, GIMP2_DIRECTORY: prof }, maxBuffer: 1 << 26, windowsHide: true });
fs.writeFileSync(path.join(dir, 'gimp.log'), (r.stdout || '') + (r.stderr || ''));
fs.rmSync(prof, { recursive: true, force: true });
console.log(fs.readdirSync(dir).filter(f => f.endsWith('.png')).join(' '));
