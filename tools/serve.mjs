// Local preview only. Never serves hidden files, tools, tests or files outside root.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import { extname, join, relative, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
const publicTop = new Set(['index.html', 'app.js', 'style.css', 'favicon.svg', 'LICENSE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'PROJECT_BIBLE.md', 'build-manifest.json']);
export function createAppServer(root = source) {
  const cache = new Map();
  return createServer(async (req, res) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { allow: 'GET, HEAD' }).end(); return; }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
    const parts = path.split('/').filter(Boolean);
    if (parts.some((p) => p.startsWith('.') || p.includes('\\') || p.includes('\0')) || (parts.length && !publicTop.has(parts[0]) && !['src', 'css', 'data', 'docs'].includes(parts[0]))) { res.writeHead(403).end(); return; }
    const file = join(root, path.endsWith('/') ? path + 'index.html' : path);
    try {
      const canonical = await realpath(file), rel = relative(await realpath(root), canonical);
      if (rel.startsWith('..' + sep) || rel === '..') { res.writeHead(403).end(); return; }
      const info = await stat(canonical);
      if (!info.isFile()) { res.writeHead(404).end(); return; }
      let asset = cache.get(file);
      if (!asset || asset.mtime !== info.mtimeMs) {
        const body = await readFile(canonical);
        asset = { body, mtime: info.mtimeMs, etag: 'W/"' + createHash('sha256').update(body).digest('hex').slice(0, 24) + '"', br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }), gzip: gzipSync(body) };
        cache.set(file, asset); if (cache.size > 150) cache.delete(cache.keys().next().value);
      }
      const headers = { 'content-type': types[extname(file)] || 'text/plain', 'cache-control': 'no-cache', etag: asset.etag, vary: 'Accept-Encoding', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
      if (req.headers['if-none-match'] === asset.etag) { res.writeHead(304, headers).end(); return; }
      const accepted = String(req.headers['accept-encoding'] || '').split(',').map((x) => x.trim()).filter((x) => !/;\s*q=0(?:\.0*)?$/.test(x));
      const encoding = accepted.some((x) => /^br(?:;|$)/.test(x)) ? 'br' : accepted.some((x) => /^gzip(?:;|$)/.test(x)) ? 'gzip' : null;
      const body = encoding ? asset[encoding] : asset.body;
      if (encoding) headers['content-encoding'] = encoding;
      res.writeHead(200, { ...headers, 'content-length': body.length }).end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 3300, root = process.argv.includes('--dist') ? join(source, 'dist') : source;
  createAppServer(root).listen(port, '127.0.0.1', () => console.log(`Nought on http://127.0.0.1:${port}/#/pulse`));
}
