import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageQueue } from '../src/ui/image-queue.js';

function harness(options = {}) {
  let now = 100000, id = 0; const timers = new Map(), deferred = [], requests = [];
  const q = new ImageQueue({ ...options, now: () => now, defer: fn => deferred.push(fn), later: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; }, cancelTimer: id => timers.delete(id), load: (url, success, failure) => { const r = { url, success, failure, cancelled: false }; requests.push(r); return () => { r.cancelled = true; }; } });
  const flush = () => { let turns = 0; while (deferred.length) { if (++turns > 100) throw new Error('unbounded drain'); deferred.shift()(); } };
  const tick = ms => { const end = now + ms; for (;;) { const next = [...timers].filter(([, t]) => t.at <= end).sort((a,b) => a[1].at - b[1].at)[0]; if (!next) break; timers.delete(next[0]); now = next[1].at; next[1].fn(); flush(); } now = end; };
  return { q, requests, timers, flush, tick };
}
test('visible rows across columns start before queued offscreen pictures', () => {
  const h = harness({ limit: 2, perHost: 2 });
  h.q.request('offscreen', ['https://a.test/old'], () => {}, () => {}, 10000);
  h.q.request('right', ['https://b.test/visible'], () => {}, () => {}, 180);
  h.q.request('left', ['https://a.test/visible'], () => {}, () => {}, 100);
  h.flush(); assert.deepEqual(h.requests.map(r => r.url), ['https://a.test/visible', 'https://b.test/visible']);
});
test('slow hosts cannot consume all twelve network slots', () => {
  const h = harness();
  for (let i = 0; i < 10; i++) h.q.request('slow'+i, ['https://slow.test/'+i], () => {}, () => {});
  for (let i = 0; i < 10; i++) h.q.request('other'+i, ['https://cdn'+i+'.test/img'], () => {}, () => {});
  h.flush(); assert.equal(h.requests.length, 12); assert.equal(h.requests.filter(r => r.url.includes('slow.test')).length, 4); assert.equal(h.q.active, 12);
});
test('alternate host races at 500ms, leaves the primary alive, then cancels the loser', () => {
  const h = harness(); let result;
  h.q.request('coin', ['https://slow.test/resized', 'https://slow.test/raw', 'https://backup.test/img'], u => { result = u; }, () => {});
  h.flush(); h.tick(499); assert.equal(h.requests.length, 1);
  h.tick(1); assert.equal(h.requests[1].url, 'https://backup.test/img'); assert.equal(h.requests[0].cancelled, false);
  h.requests[1].success(); h.flush(); assert.equal(result, 'https://backup.test/img'); assert.equal(h.requests[0].cancelled, true); assert.equal(h.q.active, 0);
  h.requests[0].failure(); h.flush(); assert.equal(h.requests.length, 2, 'late loser events cannot restart the job');
});
test('duplicates share one request and cancelling one subscriber keeps the other', () => {
  const h = harness(); let a = 0, b = 0;
  const first = h.q.request('same', ['https://image.test/one'], () => a++, () => {});
  h.q.request('same', ['https://image.test/one'], () => b++, () => {}); h.flush();
  assert.equal(h.requests.length, 1); first.cancel(); assert.equal(h.requests[0].cancelled, false);
  h.requests[0].success(); h.flush(); assert.equal(a, 0); assert.equal(b, 1);
});
test('removing the last subscriber cancels downloads and frees the budget', () => {
  const h = harness({ limit: 1 });
  const first = h.q.request('old', ['https://image.test/old'], () => assert.fail(), () => assert.fail());
  h.q.request('next', ['https://image.test/next'], () => {}, () => {}); h.flush(); first.cancel(); h.flush();
  assert.equal(h.requests[0].cancelled, true); assert.equal(h.requests[1].url, 'https://image.test/next'); assert.equal(h.q.active, 1);
});
test('timeouts release capacity and failure cooldown prevents request loops', () => {
  const h = harness(); let failures = 0;
  h.q.request('coin', ['https://image.test/bad'], () => {}, () => failures++); h.flush(); h.tick(3500);
  assert.equal(failures, 1); assert.equal(h.q.active, 0);
  h.q.request('coin2', ['https://image.test/bad'], () => {}, () => failures++); h.flush();
  assert.equal(h.requests.length, 1); assert.equal(failures, 2);
  h.q.clearFailures(); h.q.request('coin3', ['https://image.test/bad'], () => {}, () => {}); h.flush(); assert.equal(h.requests.length, 2);
});
test('background preloads leave immediate capacity for newly visible images on the same host', () => {
  const h = harness({ limit: 8, perHost: 8, backgroundPriority: 10000, reserve: 2, hostReserve: 2 });
  for (let i=0;i<20;i++) h.q.request('off'+i,['https://image.test/off'+i],()=>{},()=>{},10000);
  h.flush(); assert.equal(h.requests.length, 6);
  h.q.request('new',['https://image.test/visible'],()=>{},()=>{},20); h.flush();
  assert.equal(h.requests[6].url,'https://image.test/visible'); assert.equal(h.q.active,7);
});
test('scroll promotion lets an already queued offscreen image use reserved visible capacity', () => {
  const h = harness({limit:4,perHost:4,backgroundPriority:10000,reserve:2,hostReserve:2});
  for(let i=0;i<2;i++) h.q.request('off'+i,['https://image.test/'+i],()=>{},()=>{},10000);
  const target = h.q.request('target',['https://image.test/target'],()=>{},()=>{},10000); h.flush();
  assert.equal(h.requests.length,2); target.priority(100); h.flush();
  assert.equal(h.requests[2].url,'https://image.test/target');
});
