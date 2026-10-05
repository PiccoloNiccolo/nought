import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['app.js'];
async function walk(dir) {
  for (const entry of await readdir(root + dir, { withFileTypes: true })) {
    const path = dir + '/' + entry.name;
    if (entry.isDirectory()) await walk(path);
    else if (/\.(m?js)$/.test(path)) files.push(path);
  }
}
await walk('src'); await walk('tools');
for (const file of files) {
  const run = spawnSync(process.execPath, ['--check', root + file], { encoding: 'utf8' });
  if (run.status !== 0) { process.stderr.write(run.stderr); process.exit(1); }
}
console.log(`Syntax checked: ${files.length} JavaScript modules.`);
