/* Drives the app in a real browser, with no npm dependencies.
 *
 * Chromium is already present if Playwright has ever been installed on this
 * machine, and Node 22 ships WebSocket + fetch — so we speak the DevTools
 * Protocol directly rather than adding a driver to the project. If no browser
 * is found, findBrowser() returns null and the caller should skip.
 *
 * Two pieces:
 *   - a tiny static server, because index.html loads a module script and ES
 *     modules are blocked under file:// by CORS
 *   - a CDP client exposing eval()/run() against the live page
 */
import { createServer } from 'http';
import { spawn, spawnSync } from 'child_process';
import { readFile } from 'fs/promises';
import { existsSync, readdirSync, rmSync } from 'fs';
import { extname, join, normalize, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* Look for a usable Chromium: Playwright's download first, then a system
 * install. Returns null when there is nothing to drive. */
export function findBrowser() {
    const pw = join(homedir(), 'AppData/Local/ms-playwright');
    if (existsSync(pw)) {
        const dirs = readdirSync(pw)
            .filter(d => d.startsWith('chromium'))
            .sort()
            .reverse();
        for (const d of dirs) {
            for (const rel of [
                'chrome-headless-shell-win64/chrome-headless-shell.exe',
                'chrome-win64/chrome.exe',
                'chrome-win/chrome.exe'
            ]) {
                const p = join(pw, d, rel);
                if (existsSync(p)) return p;
            }
        }
    }
    for (const p of [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
    ]) if (existsSync(p)) return p;
    return null;
}

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm'
};

export async function startServer(root, port = 0) {
    const server = createServer(async (req, res) => {
        try {
            const path = decodeURIComponent(req.url.split('?')[0]);
            const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
            const body = await readFile(file);
            res.writeHead(200, {
                'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream'
            });
            res.end(body);
        } catch {
            res.writeHead(404); res.end('not found');
        }
    });
    await new Promise(r => server.listen(port, '127.0.0.1', r));
    return { server, port: server.address().port };
}

/* Chromium spawns a tree of processes. On Windows killing the one we
 * launched leaves the renderers running, and enough of those accumulating
 * over a run makes later suites fail with "Execution context was
 * destroyed" — a false failure that looks like a real bug in the app. */
function killTree(proc) {
    if (!proc || proc.killed || proc.pid == null) return;
    if (process.platform === 'win32') {
        try {
            spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
            return;
        } catch { /* fall through to the plain kill */ }
    }
    try { proc.kill(); } catch {}
}

class Session {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        this.logs = [];
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id != null && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
                return;
            }
            if (msg.method === 'Runtime.consoleAPICalled') {
                this.logs.push({
                    type: msg.params.type,
                    text: msg.params.args.map(a =>
                        a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ')
                });
            } else if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                this.logs.push({
                    type: 'pageerror',
                    text: (d.exception && (d.exception.description || d.exception.value)) || d.text
                });
            }
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, 30000);
        });
    }
    /* Evaluate an EXPRESSION in the page; its value is deep-copied back, so
     * return plain data rather than DOM nodes. Promises are awaited. */
    async eval(expression) {
        const src = typeof expression === 'function'
            ? `(${expression.toString()})()`
            : expression;
        return this._exec(`(async () => { return (${src}); })()`);
    }
    /* Evaluate a BLOCK of statements. Use `return` for the value you want. */
    async run(body) {
        return this._exec(`(async () => { ${body} })()`);
    }
    async _exec(wrapped) {
        const r = await this.send('Runtime.evaluate', {
            expression: wrapped,
            awaitPromise: true,
            returnByValue: true
        });
        if (r.exceptionDetails) {
            const e = r.exceptionDetails;
            throw new Error('page threw: ' +
                ((e.exception && (e.exception.description || e.exception.value)) || e.text));
        }
        return r.result.value;
    }
    errors() { return this.logs.filter(l => l.type === 'pageerror' || l.type === 'error'); }
    clearLogs() { this.logs.length = 0; }

    /* Wait for a CDP event by name. Register BEFORE the call that triggers it. */
    waitFor(method, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const done = (fn, arg) => {
                clearTimeout(timer);
                this.ws.removeEventListener('message', onMessage);
                fn(arg);
            };
            const onMessage = (ev) => {
                const msg = JSON.parse(ev.data);
                if (msg.method === method) done(resolve, msg.params);
            };
            const timer = setTimeout(
                () => done(reject, new Error(`timed out waiting for ${method}`)), timeoutMs);
            this.ws.addEventListener('message', onMessage);
        });
    }

    /* Reload with `source` installed on the fresh document, which is the only
     * way to observe the app's first frames — withPage() has already waited
     * past them by the time a suite runs.
     *
     * The reload tears down the execution context the socket is talking to, so
     * evaluating anything before the new document has loaded races it and comes
     * back as "Inspected target navigated or closed". Wait for the load event,
     * then poll for the engine. */
    async reloadWith(source) {
        await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
        const loaded = this.waitFor('Page.loadEventFired');
        await this.send('Page.reload', {});
        await loaded;
        this.clearLogs();
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.eval(`await new Promise((resolve, reject) => {
                    const t0 = Date.now();
                    (function poll() {
                        if (window.PaintApp && PaintApp.ui && PaintApp.ui.cMain) return resolve(true);
                        if (Date.now() - t0 > 20000) return reject(new Error('PaintApp never appeared'));
                        setTimeout(poll, 50);
                    })();
                })`);
            } catch (e) {
                // The old context can still be going away as the load event lands.
                if (attempt >= 4 || !/navigated|destroyed/i.test(e.message)) throw e;
                await new Promise(r => setTimeout(r, 200));
            }
        }
    }
}

/* Boot the app, hand the page to fn, then tear everything down. */
export async function withPage(fn, opts = {}) {
    const chrome = opts.browser || findBrowser();
    if (!chrome) throw new Error('no Chromium found — see findBrowser()');

    const root = opts.root || REPO_ROOT;
    const page = opts.page || '/src/index.html';
    const { server, port } = await startServer(root);
    const url = `http://127.0.0.1:${port}${page}`;

    /* Launch and connect. Suites run back to back, so a fixed debug port can
     * land on a browser that has not finished exiting — which either refuses
     * the connection or, worse, hands back the previous browser's tabs. Each
     * attempt gets its own port and its own profile directory, and a failed
     * attempt is retried rather than failing the suite. */
    let proc = null, wsUrl = null, debugPort = 0;
    const profiles = [];
    for (let attempt = 0; attempt < 3 && !wsUrl; attempt++) {
        debugPort = 9000 + Math.floor(Math.random() * 900);
        const profile = join(tmpdir(), `cdpaint-test-${process.pid}-${debugPort}`);
        profiles.push(profile);
        const args = [
            `--remote-debugging-port=${debugPort}`,
            `--user-data-dir=${profile}`,
            '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
            '--no-first-run', '--no-default-browser-check',
            '--window-size=1600,1000',
            // Canvas readback must be deterministic, not fingerprint-noised.
            '--disable-features=CanvasNoise'
        ];
        // A full Chrome needs telling to run headless; the shell build is already.
        if (!/headless-shell/.test(chrome)) args.push('--headless=new');
        proc = spawn(chrome, [...args, url], { stdio: 'ignore' });

        for (let i = 0; i < 100 && !wsUrl; i++) {
            await new Promise(r => setTimeout(r, 100));
            try {
                const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
                const target = list.find(t => t.type === 'page' &&
                    t.webSocketDebuggerUrl && t.url.startsWith(url));
                if (target) wsUrl = target.webSocketDebuggerUrl;
            } catch { /* not up yet */ }
        }
        if (!wsUrl) { killTree(proc); }
    }
    if (!wsUrl) { server.close(); throw new Error('browser did not start'); }

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
    });
    const session = new Session(ws);
    await session.send('Runtime.enable');
    await session.send('Page.enable');

    try {
        // The engine builds itself from deferred scripts; wait for it to exist.
        await session.eval(`await new Promise((resolve, reject) => {
            const t0 = Date.now();
            (function poll() {
                if (window.PaintApp && PaintApp.ui && PaintApp.ui.cMain) return resolve(true);
                if (Date.now() - t0 > 20000) return reject(new Error('PaintApp never appeared'));
                setTimeout(poll, 50);
            })();
        })`);
        return await fn(session);
    } finally {
        try { ws.close(); } catch {}
        killTree(proc);
        server.close();
        // Throw-away profiles would otherwise pile up in the temp directory,
        // one per suite per run. The browser has only just been killed and may
        // still hold its files open for a moment, so a single attempt loses the
        // race and leaves the directory behind — hundreds of them accumulate
        // over a session, and the suite gets flakier the more there are. Give
        // the handles a moment to close and try again.
        for (const dir of profiles) {
            for (let attempt = 0; attempt < 5; attempt++) {
                try { rmSync(dir, { recursive: true, force: true }); break; }
                catch { await new Promise(r => setTimeout(r, 120)); }
            }
        }
    }
}
