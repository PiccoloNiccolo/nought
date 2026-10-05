// Dependency-free static build. Only approved public files are copied.
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url)), out = join(root, 'dist');
await rm(out, { recursive: true, force: true }); await mkdir(out);
for (const entry of ['index.html', 'app.js', 'style.css', 'favicon.svg', 'LICENSE', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'src', 'css', 'data', 'docs']) {
  await cp(join(root, entry), join(out, entry), { recursive: true, filter: (p) => !relative(root, p).split('/').some((x) => x.startsWith('.')) });
}
const manifest = []; let bytes = 0, compressed = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { await walk(path); continue; }
    const data = await readFile(path); bytes += data.length;
    manifest.push({ path: relative(out, path), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    if (/\.(?:js|css|html|svg|json|md)$/.test(path)) {
      const br = brotliCompressSync(data); compressed += br.length;
      await writeFile(path + '.br', br); await writeFile(path + '.gz', gzipSync(data));
    } else compressed += data.length;
  }
}
await walk(out);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await writeFile(join(out, 'build-manifest.json'), JSON.stringify({ version: pkg.version, noughtFeeBps: 0, files: manifest }, null, 2) + '\n');
console.log(`Built ${manifest.length} public files: ${(bytes / 1024).toFixed(0)} KiB, ${(compressed / 1024).toFixed(0)} KiB with Brotli. Output: dist/`);
