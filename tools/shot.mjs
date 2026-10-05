// Opens Nought in headless Chrome, serving this folder at http://nought.test/ (no server needed), waits, and
// saves a screenshot. Prints page errors.  node tools/shot.mjs <out.png> [hash] [waitMs] [width] [height]
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const [out = 'shot.png', hash = '#/', wait = '15000', w = '1440', h = '900'] = process.argv.slice(2);
const root = new URL('..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.route('http://nought.test/**', async (route) => {
  const p = new URL(route.request().url()).pathname, f = join(root, p === '/' ? 'index.html' : p);
  try { route.fulfill({ body: await readFile(f), contentType: types[extname(f)] || 'application/octet-stream' }); } catch { route.fulfill({ status: 404, body: 'nf' }); }
});
await page.goto('http://nought.test/' + hash);
await page.waitForTimeout(+wait);
await page.screenshot({ path: out });
console.log(await page.evaluate(() => document.querySelector('#feed-text')?.textContent));
if (errs.length) console.log('ERRORS:\n' + [...new Set(errs)].slice(0, 12).join('\n'));
await browser.close();
