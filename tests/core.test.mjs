import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeCursor } from '../src/core/trade-cursor.js';
import { assertZeroFeeRequest, assertZeroFeeQuote } from '../src/core/fee-policy.js';
import { retryDelay } from '../src/core/retry-policy.js';
import { moduleAt } from './helpers.mjs';
const tx = (id) => ({ id: String(id), at: id, sig: String(id) });
const list = (high, low) => Array.from({ length: high - low + 1 }, (_, i) => tx(high - i));
const pageSource = (rows, calls = []) => async (cursor) => { const offset = Number(cursor || 0); calls.push(offset); return { txs: rows.slice(offset, offset + 30), next: offset + 30 < rows.length ? String(offset + 30) : null }; };

test('recovers trades beyond the newest thirty without duplicates', async () => {
  const cursor = new TradeCursor();
  assert.equal((await cursor.poll(pageSource(list(100, 1)))).backfill, true);
  const calls = [], r = await cursor.poll(pageSource(list(175, 1), calls));
  assert.equal(r.txs.length, 75); assert.equal(r.txs[0].id, '101'); assert.equal(r.txs.at(-1).id, '175');
  assert.deepEqual(calls, [0, 30, 60]);
  assert.equal((await cursor.poll(pageSource(list(175, 1)))).txs.length, 0);
});
test('catch-up resumes across bounded passes and a provider failure', async () => {
  const cursor = new TradeCursor({ pageBudget: 2 });
  await cursor.poll(pageSource(list(30, 1)));
  const calls = [], source = pageSource(list(240, 1), calls);
  assert.equal((await cursor.poll(source)).catchingUp, true);
  await assert.rejects(cursor.poll(async () => { throw new Error('offline'); }), /offline/);
  assert.equal((await cursor.poll(source)).catchingUp, true);
  assert.equal((await cursor.poll(source)).catchingUp, true);
  const result = await cursor.poll(source);
  assert.equal(result.txs.length, 210); assert.equal(result.catchingUp, false);
  assert.deepEqual(calls, [0, 30, 60, 90, 120, 150, 180, 210]);
});
test('one in-flight poll per coin and no result after leaving it', async () => {
  const cursor = new TradeCursor(); let resolve, calls = 0, active = true;
  const fetch = () => { calls++; return new Promise((r) => { resolve = r; }); };
  const a = cursor.poll(fetch, () => active), b = cursor.poll(fetch, () => active);
  assert.equal(a, b); active = false; resolve({ txs: [tx(1)], next: null });
  assert.equal((await a).txs.length, 0); assert.equal(calls, 1);
});
test('malformed repeated pagination fails visibly instead of spinning', async () => {
  const cursor = new TradeCursor(); await cursor.poll(pageSource([tx(1)]));
  await assert.rejects(cursor.poll(async () => ({ txs: [tx(2)], next: 'same' })), /repeated/);
});
test('house fees are rejected in URL, body, and standard quote', () => {
  for (const name of ['platformFeeBps', 'feeAccount', 'feeBps', 'referralAccount', 'referralFee', 'builder']) {
    assert.throws(() => assertZeroFeeRequest('https://api.jup.ag/swap/v1/quote?' + name + '=1'), /fee policy/);
    assert.throws(() => assertZeroFeeRequest('https://api.jup.ag/swap/v1/swap', { body: JSON.stringify({ [name]: '1' }) }), /fee policy/);
  }
  assert.throws(() => assertZeroFeeQuote({ platformFee: { feeBps: 1, amount: '0' } }), /platform fee/);
  assert.throws(() => assertZeroFeeRequest('https://api.jup.ag/swap/v1/swap', { body: JSON.stringify({ quoteResponse: { platformFee: { amount: '5' } } }) }), /platform fee/);
  assert.doesNotThrow(() => assertZeroFeeRequest('https://api.jup.ag/swap/v1/swap', { body: JSON.stringify({ quoteResponse: { platformFee: null, routePlan: [{ swapInfo: { feeAmount: '10' } }] } }) }));
});
test('retry delay grows, caps, and honors numeric/date Retry-After', () => {
  const none = () => 0, now = Date.UTC(2026, 9, 4);
  assert.equal(retryDelay(1, null, now, none), 10000);
  assert.equal(retryDelay(2, null, now, none), 20000);
  assert.equal(retryDelay(8, null, now, none), 120000);
  assert.equal(retryDelay(1, '300', now, none), 300000);
  assert.equal(retryDelay(1, new Date(now + 90000).toUTCString(), now, none), 90000);
});
test('critical persistence evicts only the disposable board when quota is full', async () => {
  const stored = new Map([['nought.board', 'large']]);
  const { api } = await moduleAt('src/core/util.js', {}, { localStorage: {
    getItem: (k) => stored.get(k) ?? null, removeItem: (k) => stored.delete(k),
    setItem(k, v) { if (stored.has('nought.board')) throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }); stored.set(k, v); }
  } });
  assert.equal(api.LS.set('orders', [{ id: 'keep-me' }]), true);
  assert.equal(stored.has('nought.board'), false); assert.equal(JSON.parse(stored.get('nought.orders'))[0].id, 'keep-me');
});
test('unavailable storage returns failure and emits a notice', async () => {
  const { api } = await moduleAt('src/core/util.js', {}, { localStorage: { setItem() { throw new Error('disabled'); } } });
  let failed; api.on('storage-error', (e) => { failed = e.key; });
  assert.equal(api.LS.set('settings', {}), false); assert.equal(failed, 'settings');
});
test('unchanged board does no persistence work; failed saves remain dirty', async () => {
  let writes = 0, succeeds = false;
  const { api } = await moduleAt('src/core/store.js', {
    './util.js': { LS: { get: () => [], set: () => { writes++; return succeeds; } }, emit() {}, isMint: () => true, safeUrl: (x) => x },
    './price.js': { solUsd: () => 100 }
  }, { setTimeout: () => 0 });
  api.saveBoard(); assert.equal(writes, 0);
  api.upsert('coin', { price: 1 }); api.saveBoard(); assert.equal(writes, 1);
  succeeds = true; api.saveBoard(); api.saveBoard(); assert.equal(writes, 2);
});
test('artwork emits immediately while ordinary price updates retain their render batch', async () => {
  const events = [], timers = [];
  const { api } = await moduleAt('src/core/store.js', {
    './util.js': { LS: { get: () => [], set: () => true }, emit: (name, t) => events.push({name, image:t?.image}), isMint: () => true, safeUrl: x => x },
    './price.js': { solUsd: () => 100 }
  }, { setTimeout: (fn, ms) => { timers.push({fn,ms}); return 1; } });
  api.upsert('coin',{image:'https://image.test/new.png'});
  assert.deepEqual(events, [{name:'token-artwork',image:'https://image.test/new.png'}]);
  api.upsert('coin',{price:2,image:'https://image.test/new.png'}); assert.equal(events.length,1);
  assert.equal(timers[0].ms,300); timers[0].fn(); assert.equal(events[1].name,'tokens');
});
test('holdings adapter preserves safe token-account details for withdrawal fallback', async () => {
  const mint = 'So11111111111111111111111111111111111111112', account = '11111111111111111111111111111111', program = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const { api } = await moduleAt('src/core/jup.js', {
    './util.js': { safeUrl: (x) => x || '', isMint: (x) => typeof x === 'string' && x.length >= 32 },
    './fee-policy.js': { assertZeroFeeRequest }, './retry-policy.js': { retryDelay }
  }, { fetch: async () => new Response(JSON.stringify({ amount: '1', uiAmount: 0.000000001, tokens: { [mint]: [{ account: mint, programId: program, amount: '25', decimals: 6 }, { account: 'invalid', programId: program, amount: '1' }] } })), setTimeout, clearTimeout });
  const h = await api.ju.holdings(mint);
  assert.equal(h.tokens[mint].accounts, 2); assert.equal(h.tokens[mint].tokenAccounts.length, 1);
  assert.equal(h.tokens[mint].tokenAccounts[0].amount, '25');
});

test('Pulse polling slows off-page and pauses entirely while hidden', async () => {
  let now = 100000, gems = 0, recent = 0;
  const doc = { hidden: false, body: { dataset: { page: 'pulse' } }, addEventListener() {}, removeEventListener() {} };
  class Clock extends Date { static now() { return now; } }
  const { api, timers } = await moduleAt('src/core/seed.js', {
    './util.js': { getJson() {}, isMint: () => true, queued() {}, on: () => () => {}, emit() {} },
    './store.js': { tokens: new Map(), upsert() {}, progressFromMcSol: () => 0, changed() {} },
    './price.js': { solUsd: () => 130 }, './settings.js': { settings: { stretch: 80 } },
    './jup.js': { jg: { gems: async () => { gems++; return { recent: [], aboutToGraduate: [], graduated: [] }; } }, jt: { recent: async () => { recent++; return []; } }, LAUNCHPADS: [], img: (x) => x }
  }, { document: doc, Date: Clock });
  api.startFeed();
  const step = async () => { for (let i=0;i<60;i++) { now += 1000; timers[0].fn(); await Promise.resolve(); await Promise.resolve(); } };
  await step(); assert.equal(gems,15); assert.equal(recent,6);
  gems=recent=0; doc.body.dataset.page='settings'; await step(); assert.equal(gems,2); assert.equal(recent,1);
  gems=recent=0; doc.hidden=true; await step(); assert.equal(gems,0); assert.equal(recent,0);
  api.stopFeed();
});

test('equal-time trades preserve provider order instead of sorting opaque IDs', async()=>{
 const cursor=new TradeCursor();const r=await cursor.poll(pageSource([{id:'10',at:100},{id:'9',at:100}]));assert.deepEqual(r.txs.map(x=>x.id),['9','10']);
});
