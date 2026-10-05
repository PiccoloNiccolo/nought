import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageQueue } from '../src/ui/image-queue.js';
import { moduleAt } from './helpers.mjs';
import { assertZeroFeeRequest } from '../src/core/fee-policy.js';
import { retryDelay } from '../src/core/retry-policy.js';

const mint = 'So11111111111111111111111111111111111111112';
async function adapter() {
  const { api: util } = await moduleAt('src/core/util.js');
  return (await moduleAt('src/core/jup.js', { './util.js': { safeUrl: util.safeUrl, isMint: util.isMint }, './fee-policy.js': { assertZeroFeeRequest }, './retry-policy.js': { retryDelay } })).api;
}
test('images keep the original IPFS gateway and a second provider, with no duplicate attempts', async () => {
  const api = await adapter(), cid = 'Qm' + 'a'.repeat(44), original = `https://publisher.example/ipfs/${cid}/art.png`;
  const t = api.toToken({ id: mint, icon: original });
  assert.equal(t.imageOriginal, original);
  const urls = Array.from(api.imageSources({ ...t, imageAlt: 'https://cdn.example/alternate.png' }));
  assert.equal(urls[0], `https://pump.mypinata.cloud/ipfs/${cid}/art.png?img-width=160`);
  assert.equal(urls[1], 'https://cdn.example/alternate.png');
  assert.ok(urls.includes(original)); assert.ok(urls.includes(`https://gateway.pinata.cloud/ipfs/${cid}/art.png`));
  assert.equal(urls.length, new Set(urls).size);
});
test('image candidates reject executable URLs, credentials and blocked hotlinks', async () => {
  const api = await adapter();
  for (const image of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'https://user:password@example.com/image.png', 'https://gmgn.ai/external-res/test.webp']) assert.equal(api.imageSources({ image }).length, 0, image);
  assert.equal(api.imageSources({ image: 'http://cdn.example/image.png' })[0], 'https://cdn.example/image.png');
});
test('one-hour stats never invent a zero five-minute change', async () => {
  const api = await adapter(), t = api.toToken({ id: mint, stats1h: { priceChange: 20 } });
  assert.equal(t.stats5m, undefined); assert.equal(t.stats1h.priceChange, 20);
});

async function imageHarness(urls, cached = new Map(), initialVisible = false) {
  const images = [], probes = [], timeouts = new Map(), io = [], dex = [], meta = [], handlers = new Map(); let nextId = 0;
  const later = (fn, ms) => { timeouts.set(++nextId, { fn, ms }); return nextId; };
  class FakeImage {
    constructor(i) { this.dataset = { tokenImage: 'mint' + i, sources: JSON.stringify(urls(i)) }; this.isConnected = true; this.handlers = {}; this.src = ''; this.naturalWidth = 0; this.visible = initialVisible; }
    addEventListener(k, fn) { this.handlers[k] = fn; }
    removeAttribute(k) { if (k === 'src') this.src = ''; }
    getBoundingClientRect() { return { top: this.visible ? 0 : 2000, bottom: this.visible ? 64 : 2064, width: 64 }; }
  }
  const document = { hidden: false, documentElement: {}, addEventListener() {}, querySelectorAll: s => s.includes('data-failed') ? images.filter(i => i.dataset.failed) : images };
  for (let i = 0; i < 8; i++) images.push(new FakeImage(i));
  class Queue extends ImageQueue { constructor(options) { super({ ...options, defer: queueMicrotask, later, cancelTimer: id => timeouts.delete(id) }); } }
  const { api } = await moduleAt('src/ui/token-image.js', {
    '../core/util.js': { esc: String, on: (name, fn) => handlers.set(name, fn) }, '../core/jup.js': { imageSources: t => t.urls || [] }, './image-queue.js': { ImageQueue: Queue },
    './image-cache.js': { imageCache: { ready: Promise.resolve(), get: u => cached.get(u), remove: u => cached.delete(u) }, fastImageHost: host => host === 'pump.mypinata.cloud', loadImage: (url, success, failure) => {
      const probe = { src: url, naturalWidth: 0, onload() { cached.set(url, url); success(url); }, onerror: failure }; probes.push(probe);
      return () => { probe.onload = null; probe.onerror = null; };
    } },
    '../core/store.js': { tokens: new Map(images.map(i => [i.dataset.tokenImage, { uri: 'https://metadata.example/token.json' }])) },
    '../core/meta.js': { wantDex: m => dex.push(m), wantMeta: t => meta.push(t) }
  }, { document, innerHeight: 900, localStorage: { getItem: () => null, setItem() {} }, Image: class { constructor() { this.naturalWidth = 0; probes.push(this); } removeAttribute(k) { if (k === 'src') this.src = ''; } },
    IntersectionObserver: class { constructor(fn) { io.push(fn); } observe() {} unobserve() {} }, MutationObserver: class { observe() {} }, setTimeout: later, clearTimeout: id => timeouts.delete(id) });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { api, images, probes, timeouts, dex, meta, settle, emit: (name,t) => handlers.get(name)?.(t), reveal: async () => { images.forEach(i => i.visible = true); io[0](images.map(target => ({ target, isIntersecting: true }))); await settle(); } };
}
test('thumbnails wait for visibility and obey the per-host budget', async () => {
  const h = await imageHarness(i => [`https://image.example/${i}.png`]);
  assert.equal(h.probes.length, 0); await h.reveal(); assert.equal(h.probes.length, 4);
  h.probes[0].naturalWidth = 128; h.probes[0].onload(); await h.settle();
  assert.equal(h.images[0].dataset.loaded, 'true'); assert.equal(h.images[0].src, 'https://image.example/0.png'); assert.equal(h.probes.length, 5);
});
test('missing pictures request metadata immediately without consuming image slots', async () => {
  const h = await imageHarness(() => []); await h.reveal();
  assert.equal(h.probes.length, 0); assert.equal(h.dex.length, 8); assert.equal(h.images[0].dataset.failed, 'true');
  h.api.retryTokenImages(false); assert.equal(h.dex.length, 8);
  h.api.retryTokenImages(); assert.equal(h.dex.length, 16);
});
test('saved thumbnails bypass the network queue even when every host slot is occupied', async () => {
  const saved = 'data:image/png;base64,aGVsbG8=', cache = new Map([['https://image.example/7.png', saved]]);
  const h = await imageHarness(i => [`https://image.example/${i}.png`], cache); await h.reveal();
  assert.equal(h.probes.length, 4);
  assert.equal(h.images[7].src, saved); assert.equal(h.images[7].dataset.loaded, 'true');
  assert.equal(h.images[7].dataset.imageSource, 'https://image.example/7.png');
});
test('on-screen images start before IntersectionObserver delivers its first callback', async () => {
  const h = await imageHarness(i => [`https://image.example/${i}.png`], new Map(), true); await h.settle();
  assert.equal(h.probes.length, 4, 'no observer frame or row redraw is required');
});
test('artwork arriving for an empty visible row starts immediately without the 300ms board redraw', async () => {
  const h = await imageHarness(() => []); await h.reveal();
  h.emit('token-artwork', {mint:'mint0',urls:['https://image.example/fresh.png']}); await h.settle();
  assert.equal(h.probes.length, 1); assert.equal(h.probes[0].src, 'https://image.example/fresh.png');
});
test('added metadata keeps an in-flight image and a loaded image intact', async () => {
  const h = await imageHarness(i => i ? [] : ['https://image.example/first.png']); await h.reveal();
  h.emit('token-artwork', {mint:'mint0',urls:['https://image.example/first.png','https://backup.example/new.png']}); await h.settle();
  assert.equal(h.probes.length, 1); assert.equal(typeof h.probes[0].onload, 'function');
  h.probes[0].naturalWidth = 128; h.probes[0].onload(); await h.settle();
  h.api.syncTokenImage(h.images[0], {mint:'mint0',urls:['https://image.example/first.png','https://backup.example/newer.png']});
  assert.equal(h.images[0].dataset.loaded, 'true'); assert.equal(h.probes.length, 1);
});
test('incoming coins prefetch before mounting and share the result with the future row', async () => {
  const h = await imageHarness(() => []);
  h.api.primeTokenImage({mint:'mint0',uri:'https://metadata.example/0'});
  assert.equal(h.meta.length, 1);
  h.emit('token-artwork', {mint:'mint0',urls:['https://image.example/early.png']}); await h.settle();
  assert.equal(h.probes.length, 1); h.probes[0].naturalWidth = 128; h.probes[0].onload(); await h.settle();
  await h.reveal(); assert.equal(h.images[0].src, 'https://image.example/early.png'); assert.equal(h.probes.length, 1);
});
test('cached image payloads stay out of repeatedly generated row markup', async () => {
  const source = 'https://image.example/1.png', saved = 'data:image/png;base64,'+'a'.repeat(40000);
  const h = await imageHarness(() => [], new Map([[source,saved]]));
  const html = h.api.tokenImage({mint:'mint0',urls:[source]});
  assert.ok(html.length < 500); assert.ok(!html.includes('data:image'));
});
test('thumbnail CDN requests use the card size and preserve the original fallback', async () => {
  const api = await adapter(), original = 'https://cdn.dexscreener.com/cms/images/example?width=800&height=800&quality=95&format=auto';
  const urls = Array.from(api.imageSources({ image: original }, 128)), small = new URL(urls[0]);
  assert.equal(small.searchParams.get('width'), '128'); assert.equal(small.searchParams.get('height'), '128'); assert.equal(small.searchParams.get('quality'), '80');
  assert.ok(urls.includes(original));
});

test('metadata failures can retry after cooldown; alternate artwork preserves the original', async () => {
  let now = 100000, calls = 0;
  class Clock extends Date { static now() { return now; } }
  const token = { mint, uri: 'https://metadata.example/token.json', image: 'https://old.example/image.png' }, tokens = new Map([[mint, token]]);
  const { api } = await moduleAt('src/core/meta.js', {
    './util.js': { safeUrl: x => x || '', getJson: async () => { calls++; if (calls === 1) throw new Error('temporary outage'); return { image: 'https://new.example/image.png' }; } },
    './store.js': { tokens, changed() {}, upsert: (m, patch) => { for (const [k, v] of Object.entries(patch)) if (v !== undefined) token[k] = v; } },
    './jup.js': { ds: {}, cidPath: () => null, ipfs: x => x, img: x => x, imgFallback: () => '', GATEWAYS: [] }
  }, { Date: Clock });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  api.wantMeta(token); await settle(); assert.equal(calls, 1);
  api.wantMeta(token); await settle(); assert.equal(calls, 1);
  now += 1999; api.wantMeta(token, { priority: true }); await settle(); assert.equal(calls, 1);
  now += 2; api.wantMeta(token, { priority: true }); await settle(); assert.equal(calls, 2, 'fresh metadata can recover after two seconds');
  assert.equal(token.image, 'https://old.example/image.png'); assert.equal(token.imageAlt, 'https://new.example/image.png');
  now += 120000; api.wantMeta(token); await settle(); assert.equal(calls, 2, 'successful metadata stays cached');
});

test('visible-token metadata starts without waiting for four busy background jobs', async () => {
  const started = [], pending = [], tokens = new Map();
  const { api } = await moduleAt('src/core/meta.js', {
    './util.js': { safeUrl: x => x || '', getJson: u => { started.push(u); return new Promise(resolve => pending.push(resolve)); } },
    './store.js': { tokens, changed() {}, upsert() {} },
    './jup.js': { ds: {}, cidPath: () => null, ipfs: x => x, img: x => x, imgFallback: () => '', GATEWAYS: [] }
  });
  const token = i => ({ mint: 'token'+i, uri: 'https://host'+i+'.example/meta.json' });
  for (let i = 0; i < 6; i++) api.wantMeta(token(i));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 4);
  api.wantMeta(token(5), { priority: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started[4], token(5).uri);
  while (pending.length) { pending.shift()({ image: 'https://cdn.example/img.png' }); await new Promise(resolve => setImmediate(resolve)); }
});

test('a slow metadata gateway is raced after 250ms and the losing request is aborted', async () => {
  const timers = new Map(), requests = [], patches = []; let id = 0;
  const token = { mint, uri: 'https://origin.test/meta' };
  const { api } = await moduleAt('src/core/meta.js', {
    './util.js': { safeUrl: x => x || '', getJson: (url, opt) => new Promise(resolve => requests.push({url, signal: opt.signal, resolve})) },
    './store.js': { tokens: new Map([[mint, token]]), changed() {}, upsert: (m, patch) => patches.push(patch) },
    './jup.js': { ds: {}, cidPath: () => 'cid', ipfs: (u, g) => g === 1 ? 'https://backup.test/meta' : 'https://primary.test/meta', img: x => x, imgFallback: () => '', GATEWAYS: [] }
  }, { setTimeout: (fn, ms) => { timers.set(++id, {fn,ms}); return id; }, clearTimeout: id => timers.delete(id) });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  api.wantMeta(token); await settle(); assert.equal(requests.length, 1);
  [...timers.values()].find(t => t.ms === 250).fn(); await settle(); assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, false, 'primary stays alive during the race');
  requests[1].resolve({image:'https://cdn.test/fast.png'}); await settle();
  assert.equal(patches[0].image, 'https://cdn.test/fast.png'); assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({image:'https://cdn.test/late.png'}); await settle(); assert.equal(patches.length, 1, 'late losers never overwrite the winning artwork');
});

test('one missing metadata file does not suspend every new coin on its host', async () => {
  const started = [];
  const { api } = await moduleAt('src/core/meta.js', {
    './util.js': { safeUrl: x => x || '', getJson: async u => { started.push(u); throw new TypeError('unavailable file'); } },
    './store.js': { tokens: new Map(), changed() {}, upsert() {} },
    './jup.js': { ds: {}, cidPath: () => null, ipfs: u => u, img: x => x, imgFallback: () => '', GATEWAYS: [] }
  });
  api.wantMeta({mint:'first',uri:'https://same.test/missing'}); await new Promise(resolve => setImmediate(resolve));
  api.wantMeta({mint:'second',uri:'https://same.test/brand-new'}); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['https://same.test/missing','https://same.test/brand-new']);
});

async function metadataHarness({ stored = null } = {}) {
  const requests = [], patches = [], timeouts = new Map(), tokens = new Map(), storage = new Map(stored ? [['nought.metadata.v1', stored]] : []);
  let id = 0;
  const { api } = await moduleAt('src/core/meta.js', {
    './util.js': { safeUrl: x => /^https?:\/\//.test(x || '') ? x : '', getJson: (url, opt) => new Promise((resolve, reject) => requests.push({url, resolve, reject, signal:opt.signal})) },
    './store.js': { tokens, changed() {}, upsert: (mint, patch) => { patches.push({mint,patch}); for (const [k,v] of Object.entries(patch)) if(v !== undefined) tokens.get(mint)[k] = v; } },
    './jup.js': { ds: {}, cidPath: x => x?.includes('/ipfs/') ? x.split('/ipfs/')[1] : null, ipfs: (u,g=0) => u?.includes('/ipfs/') ? `https://${g ? 'backup' : 'primary'}.test/ipfs/${u.split('/ipfs/')[1]}` : u, img: x => x, imgFallback: () => '', GATEWAYS: [] }
  }, { localStorage: {getItem:k=>storage.get(k), setItem:(k,v)=>storage.set(k,v)}, setTimeout:(fn,ms)=>{timeouts.set(++id,{fn,ms});return id},clearTimeout:i=>timeouts.delete(i) });
  return {api,requests,patches,tokens,timeouts,storage,settle:()=>new Promise(r=>setImmediate(r)),token(mint,uri='https://publisher.test/metadata') { const t={mint,uri};tokens.set(mint,t);return t; }};
}
test('a launch burst sharing one metadata document uses one lookup and fills every coin', async()=>{
  const h=await metadataHarness();
  for(let i=0;i<20;i++)h.api.wantMeta(h.token('coin'+i));
  await h.settle();assert.equal(h.requests.length,1);
  h.requests[0].resolve({image:'https://cdn.test/art.png'});await h.settle();
  assert.equal(h.patches.length,20);assert.equal(h.tokens.get('coin19').image,'https://cdn.test/art.png');
  h.api.wantMeta(h.token('later'));assert.equal(h.tokens.get('later').image,'https://cdn.test/art.png');assert.equal(h.requests.length,1);
});
test('equivalent IPFS metadata URLs share their document even across gateways',async()=>{
  const h=await metadataHarness();
  h.api.wantMeta(h.token('a','https://one.test/ipfs/cid'));
  h.api.wantMeta(h.token('b','https://two.test/ipfs/cid'));
  await h.settle();assert.equal(h.requests.length,1);
  h.requests[0].resolve({image:'https://cdn.test/art.png'});await h.settle();assert.equal(h.patches.length,2);
});
test('visible metadata races both hosts immediately, including promotion of an active background lookup',async()=>{
  for(const startVisible of [true,false]){
    const h=await metadataHarness(),t=h.token('coin','https://origin.test/ipfs/cid');
    h.api.wantMeta(t,{priority:startVisible});await h.settle();
    if(!startVisible){assert.equal(h.requests.length,1);h.api.wantMeta(t,{priority:true});await h.settle();}
    assert.equal(h.requests.length,2,'no 250ms timer tick is needed');
    h.requests[1].resolve({image:'https://cdn.test/fast.png'});await h.settle();
    assert.equal(t.image,'https://cdn.test/fast.png');assert.equal(h.requests[0].signal.aborted,true);
  }
});
test('saved metadata resolves artwork before another network lookup after reload',async()=>{
  const first=await metadataHarness();first.api.wantMeta(first.token('a'));await first.settle();
  first.requests[0].resolve({image:'https://cdn.test/art.png',twitter:'https://x.com/example/status/123',unknown:'not persisted'});await first.settle();
  [...first.timeouts.values()].find(t=>t.ms===500).fn();
  const stored=first.storage.get('nought.metadata.v1');assert.ok(!stored.includes('not persisted'));
  const h=await metadataHarness({stored}),t=h.token('b');h.api.wantMeta(t);await h.settle();
  assert.equal(h.requests.length,0);assert.equal(t.image,'https://cdn.test/art.png');assert.equal(t.twitter,'https://x.com/example/status/123');
});
test('late metadata cannot overwrite a token whose metadata URI changed',async()=>{
  const h=await metadataHarness(),t=h.token('a');h.api.wantMeta(t);await h.settle();
  t.uri='https://publisher.test/replacement';h.requests[0].resolve({image:'https://cdn.test/stale.png'});await h.settle();
  assert.equal(h.patches.length,0);
});
test('untrusted saved metadata rejects credential URLs and executable artwork',async()=>{
  const stored=JSON.stringify([{key:'https://publisher.test/metadata',until:Date.now()+10000,value:{image:'javascript:alert(1)',twitter:'https://name:password@x.com/example',website:'https://safe.test'}}]);
  const h=await metadataHarness({stored}),t=h.token('a');h.api.wantMeta(t);
  assert.equal(t.image,undefined);assert.equal(t.twitter,undefined);assert.equal(t.website,'https://safe.test');
});
