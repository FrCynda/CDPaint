// Render reference strokes with the real Krita, headless.
//
//   node test/krita/render.mjs job.json
//
// Krita's Python API (Node.paintLine) drives Krita's own freehand stroke
// strategy with the pressures we give it -- no mouse, no window: Krita runs
// on Qt's offscreen platform. See test/krita/README.md for the job format
// and why it is done this way rather than with kritarunner.
//
// krita.exe has no switch for a private config, so this borrows the user's:
// it refuses to run while Krita is open, snapshots every file it touches,
// installs the plugin for this one run and puts everything back in `finally`.
import { spawnSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const KRITA = process.env.KRITA_EXE || 'C:/Program Files/Krita (x64)/bin/krita.exe';
const LOCAL = process.env.LOCALAPPDATA, ROAMING = process.env.APPDATA;
const PYK = path.join(ROAMING, 'krita', 'pykrita');
const SNAP = [path.join(LOCAL, 'kritarc'), path.join(LOCAL, 'kritadisplayrc'),
    path.join(ROAMING, 'krita', 'resourcecache.sqlite')];

export function renderKrita(jobFile, { timeoutMs = 180000 } = {}) {
    jobFile = path.resolve(jobFile);
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    fs.mkdirSync(job.out, { recursive: true });
    const log = path.join(path.dirname(jobFile), 'harness.log');
    fs.rmSync(log, { force: true });

    if (/krita\.exe/i.test(execSync('tasklist', { encoding: 'utf8' })))
        throw new Error('Krita is open. Close it first: this borrows its settings for a few seconds.');

    const bak = fs.mkdtempSync(path.join(path.dirname(jobFile), 'krita-bak-'));
    const saved = SNAP.filter(f => fs.existsSync(f)).map(f => {
        const b = path.join(bak, path.basename(f)); fs.copyFileSync(f, b); return [f, b];
    });
    const created = [path.join(PYK, 'cdp_harness.desktop'), path.join(PYK, 'cdp_harness')];
    try {
        fs.mkdirSync(PYK, { recursive: true });
        fs.copyFileSync(path.join(here, 'cdp_harness.desktop'), created[0]);
        fs.cpSync(path.join(here, 'cdp_harness'), created[1], { recursive: true });
        fs.appendFileSync(path.join(LOCAL, 'kritarc'), '\r\n[python]\r\nenable_cdp_harness=true\r\n');
        // No GPU canvas: the offscreen platform has no OpenGL to give it.
        const drc = path.join(LOCAL, 'kritadisplayrc');
        const d = fs.existsSync(drc) ? fs.readFileSync(drc, 'utf8').replace(/^OpenGLRenderer=.*$/m, '') : '';
        fs.writeFileSync(drc, /^\[General\]/m.test(d) ? d.replace(/^\[General\]\r?\n/m, '[General]\r\nOpenGLRenderer=none\r\n')
            : d + '\r\n[General]\r\nOpenGLRenderer=none\r\n');

        // Krita crashes on Qt's offscreen/minimal platforms (it probes
        // OpenGL at startup), so it gets a real one on an invisible desktop.
        const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
            path.join(here, 'hidden-desktop.ps1'), '-Exe', KRITA, '-ExeArgs', '--nosplash',
            '-TimeoutSec', String(Math.round(timeoutMs / 1000))], {
            env: { ...process.env, CDP_KRITA_JOB: jobFile },
            timeout: timeoutMs + 30000, stdio: 'ignore', windowsHide: true,
        });
        const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
        if (!/^DONE$/m.test(text))
            throw new Error(`Krita did not finish (status ${r.status}, ${r.error ? r.error.code : 'no error'}).\n${text}`);
        return text;
    } finally {
        for (const f of created) fs.rmSync(f, { recursive: true, force: true });
        for (const [f, b] of saved) fs.copyFileSync(b, f);
        fs.rmSync(bak, { recursive: true, force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (!process.argv[2]) { console.error('usage: node test/krita/render.mjs job.json'); process.exit(2); }
    console.log(renderKrita(process.argv[2]));
}
