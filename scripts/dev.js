const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', 'src');
const port = process.env.PORT || 1420;
const host = process.env.HOST || '127.0.0.1';

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

const server = http.createServer((req, res) => {
  let urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = resolveWithinRoot(urlPath);
  if (!filePath) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    res.setHeader('Content-Type', contentType(filePath));
    res.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`Dev server running at http://${host}:${port}`);
});
