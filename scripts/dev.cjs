const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'src');
const port = process.env.PORT || 1420;
const host = process.env.HOST || '127.0.0.1';

/* ── Live-reload injection ───────────────────────────────────────────── */
const RELOAD_SCRIPT = `
<script>(function(){
  var v=0;
  setInterval(function(){
    fetch('/__mtime').then(function(r){return r.text()}).then(function(t){
      var n=parseInt(t,10);
      if(v&&n!==v)location.reload();v=n;
    }).catch(function(){});
  },1000);
})()</script>
`;

function injectReloadScript(data) {
  return data.toString('utf8').replace('</body>', RELOAD_SCRIPT + '</body>');
}

/* ── MTime scanner (stat only, no content read) ──────────────────────── */
function scanMtime(dir) {
  let max = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = scanMtime(full);
        if (sub > max) max = sub;
      } else if (entry.isFile() && /\.(js|css|html?)$/i.test(entry.name)) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > max) max = m;
        } catch (_) {}
      }
    }
  } catch (_) {}
  return max;
}

/* ── Helpers ─────────────────────────────────────────────────────────── */
function contentType(file) {
  if (file.endsWith('.html')) return 'text/html';
  if (file.endsWith('.js')) return 'application/javascript';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function decodeUrlPath(urlPath) {
  try {
    return decodeURIComponent(urlPath);
  } catch (_) {
    return null;
  }
}

function resolveWithinRoot(urlPath) {
  const decoded = decodeUrlPath(urlPath);
  if (!decoded) return null;
  const normalized = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolved;
}

/* ── HTTP server ─────────────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  /* MTime endpoint for client-side polling */
  if (urlPath === '/__mtime') {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/plain');
    res.end(String(scanMtime(root)));
    return;
  }

  let filePath = urlPath;
  if (filePath === '/') filePath = '/index.html';
  const resolved = resolveWithinRoot(filePath);
  if (!resolved) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', contentType(resolved));
    res.end(filePath.endsWith('.html') ? injectReloadScript(data) : data);
  });
});

server.listen(port, host, () => {
  console.log(`Dev server running at http://${host}:${port}`);
});
