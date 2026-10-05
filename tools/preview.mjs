// Start a local preview independently of the terminal/chat session that launched it.
// No login item, launch agent, external listener, or public deployment is installed.
import { spawn } from 'node:child_process';
import { mkdir, open, access, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.argv[2] || 3302);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
const url = `http://127.0.0.1:${port}`;
const stateDir = join(tmpdir(), 'nought-preview-' + createHash('sha256').update(root + port).digest('hex').slice(0, 12));
const logPath = join(stateDir, 'server.log');
const expected = await readFile(join(root, 'dist', 'build-manifest.json'), 'utf8').catch(() => { throw new Error('Build files are missing. Run npm run build first.'); });
async function running() {
  let response;
  try { response = await fetch(url + '/build-manifest.json', { signal: AbortSignal.timeout(1000) }); }
  catch { return false; }
  if (response.ok && await response.text() === expected) return true;
  throw new Error(`Port ${port} is already serving something else. No process was stopped. Choose another port.`);
}

if (await running()) {
  console.log(`Nought is already running.\nOpen ${url}/#/pulse`);
} else {
  await access(join(root, 'dist', 'index.html'));
  await mkdir(stateDir, { recursive: true });
  const log = await open(logPath, 'a');
  const child = spawn(process.execPath, [join(root, 'tools', 'serve.mjs'), String(port), '--dist'], {
    cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  let failed = null;
  child.once('error', (error) => { failed = error; });
  child.unref();
  await log.close();
  await writeFile(join(stateDir, 'process.json'), JSON.stringify({ pid: child.pid, root, port, startedAt: new Date().toISOString() }, null, 2));
  let ready = false;
  for (let i = 0; i < 30; i++) {
    if (failed) throw failed;
    if (await running()) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!ready) throw new Error(`The preview did not start. Details: ${logPath}`);
  console.log(`Nought is running independently in the background.\nOpen ${url}/#/pulse\nAfter restarting your Mac, run this launcher again.\nLog: ${logPath}`);
}
