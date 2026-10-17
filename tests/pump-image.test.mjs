import test from 'node:test';
import assert from 'node:assert/strict';
import { PumpImages, pumpCdnUrl } from '../src/ui/pump-image.js';

const mint = '2TfNWQrNuUHdbs1z78ed5T732ihAVL6iq6wGBnfmpump';
function harness(answers, opts = {}) {
  let now = 1_000_000; const timers = [], calls = [], ready = [], cache = new Map();
  const fetch = async (url, init) => { calls.push({ url, init }); const a = answers(calls.length); if (a instanceof Error) throw a; return a; };
  const p = new PumpImages({ fetch, cache: { put: (u, d) => cache.set(u, d) }, onReady: (m, u) => ready.push([m, u]), readData: async () => 'data:image/png;base64,AAAA', now: () => now, later: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; }, ...opts });
  const settle = () => new Promise(r => setImmediate(r));
  const advance = async (ms) => { const end = now + ms; for (;;) { await settle(); timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.fn(); } now = end; await settle(); };
  return { p, calls, ready, cache, advance, settle, setNow: (v) => { now = v; }, get now() { return now; } };
}
const placeholder = { type: 'opaqueredirect', ok: false, status: 0, headers: new Map() };
const picture = { type: 'cors', ok: true, status: 200, headers: new Map([['content-type', 'image/png']]), blob: async () => ({ size: 3000 }) };

test('a new coin is polled until the real picture replaces the placeholder, then cached and announced once', async () => {
  const h = harness((n) => (n < 4 ? placeholder : picture));
  h.p.watch(mint, h.now); await h.settle();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, pumpCdnUrl(mint)); assert.equal(h.calls[0].init.redirect, 'manual');
  await h.advance(1000);
  assert.deepEqual(h.ready, [[mint, pumpCdnUrl(mint)]]); assert.equal(h.cache.get(pumpCdnUrl(mint)), 'data:image/png;base64,AAAA');
  const n = h.calls.length; h.p.watch(mint, h.now); await h.advance(2000); assert.equal(h.calls.length, n, 'a ready coin is never asked again');
});
test('polling stops after the window, and a coin older than two minutes gets a single probe', async () => {
  const h = harness(() => placeholder);
  h.p.watch(mint, h.now); await h.advance(25000);
  assert.ok(h.calls.length >= 90 && h.calls.length <= 140, 'about every 150 ms for 20 s, got ' + h.calls.length);
  const n = h.calls.length; await h.advance(5000); assert.equal(h.calls.length, n);
  const old = harness(() => placeholder); old.p.watch(mint, old.now - 600000); await old.advance(5000);
  assert.equal(old.calls.length, 1); assert.equal(old.ready.length, 0);
});
test('network errors count as not ready, non-images are refused, and concurrency is bounded', async () => {
  const pending = [];
  const h = harness(() => new Promise(r => pending.push(r)), { limit: 2 });
  for (let i = 0; i < 5; i++) h.p.watch(mint.slice(0, -1) + i, h.now);
  await h.settle(); assert.equal(h.calls.length, 2);
  pending.shift()(new Error('offline')); pending.shift()({ type: 'cors', ok: true, headers: new Map([['content-type', 'text/html']]), blob: async () => ({ size: 10 }) });
  await h.advance(500); assert.equal(h.ready.length, 0); assert.ok(h.calls.length > 2);
});
