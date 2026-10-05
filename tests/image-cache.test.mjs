import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageCache } from '../src/ui/image-cache.js';
const data = 'data:image/webp;base64,aGVsbG8=';
test('persisted raster thumbnails restore without fetching the image origin', async () => {
  const c = new ImageCache({ now: () => 100000, storage: { read: async () => [{ url: 'https://img.test/a', data, at: 99999 }] } });
  await c.ready; assert.equal(c.get('https://img.test/a'), data);
});
test('unavailable local storage never blocks image loading', async () => {
  const c = new ImageCache({ storage: { read: async () => { throw new Error('storage disabled'); } } });
  await c.ready; assert.equal(c.get('https://img.test/a'), '');
  c.put('https://img.test/a'); assert.equal(c.get('https://img.test/a'), 'https://img.test/a');
});
test('cache refuses active content, non-images, credential URLs and oversized payloads', async () => {
  const c = new ImageCache(); await c.ready;
  for (const value of ['data:text/html;base64,aGVsbG8=', 'data:image/svg+xml;base64,aGVsbG8=', 'javascript:alert(1)', 'data:image/png;base64,' + 'a'.repeat(512*1024)]) assert.equal(c.put('https://img.test/a', value), false);
  assert.equal(c.put('https://user:password@img.test/a', data), false); assert.equal(c.put('javascript:alert(1)', data), false);
});
test('cache bounds memory and expires yesterday’s thumbnails', async () => {
  let now = 100000; const c = new ImageCache({ now: () => now }); await c.ready;
  for (let i = 0; i < 300; i++) c.put('https://img.test/'+i, data);
  assert.equal(c.entries.size, 240); assert.equal(c.get('https://img.test/0'), ''); assert.equal(c.get('https://img.test/299'), data);
  now += 86400001; assert.equal(c.get('https://img.test/299'), '');
  const large = 'data:image/png;base64,' + 'a'.repeat(200000);
  for (let i = 0; i < 100; i++) c.put('https://img.test/large'+i, large);
  assert.ok(c.bytes <= 8*1024*1024);
});
test('late cache restoration never overwrites an image loaded in the current session', async () => {
  let restore; const c = new ImageCache({ storage: { read: () => new Promise(resolve => { restore = resolve; }) } });
  await Promise.resolve(); c.put('https://img.test/a'); restore([{ url:'https://img.test/a', data, at:Date.now() }]);
  await c.ready; assert.equal(c.get('https://img.test/a'), 'https://img.test/a');
});
