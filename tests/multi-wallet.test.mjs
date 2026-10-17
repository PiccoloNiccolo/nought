import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAt } from './helpers.mjs';

const W = ['Wa11et1111111111111111111111111111111111111', 'Wa11et2222222222222222222222222222222222222', 'Wa11et3333333333333333333333333333333333333'];
const mint = 'So11111111111111111111111111111111111111112';
// buyAcross / sellAcross with a fake trade() that records each leg and only settles when the test says so
async function harness({ owners = W, mode = 'each', held = {} } = {}) {
  const legs = [], toasts = [];
  const { api } = await moduleAt('src/ui/instant.js', {
    '../core/util.js': { esc: String, LS: { get: (k, d) => d, set() {} }, on: () => () => {}, usd: String, num: String, short: (s) => s.slice(0, 6), toast: (m, k) => toasts.push([m, k]), parseAmount: Number },
    '../core/settings.js': { settings: {}, set() {}, preset: () => ({ buy: 0.1 }), PRIO: {} },
    '../core/wallet.js': { wallet: { owner: owners[0] }, needWallet: () => false, tradeOwners: () => [...owners] },
    '../core/trade.js': {
      trade: (side, m, raw, o) => new Promise((resolve) => legs.push({ side, raw, o, resolve })),
      holding: async (m, owner) => ({ raw: held[owner] ?? 0n, frozen: false }),
      tradeLog: () => [], decimalsOf: () => 6, confirm: async () => 'ok', txLink: String,
      perWalletSol: (sol, n) => (n > 1 && mode === 'split' ? sol / n : sol),
    },
    '../core/jup.js': { jx: {} }, '../core/store.js': { tokens: new Map(), mcUsd: () => 0 }, '../core/price.js': { solUsd: () => 150 },
  }, { document: { addEventListener() {} } });
  const settle = () => new Promise((r) => setImmediate(r));
  return { api, legs, toasts, settle };
}

test('a multi-wallet buy sends every wallet\'s leg before any of them confirms', async () => {
  const h = await harness();
  const done = h.api.buyAcross(mint, 0.5); await h.settle();
  assert.equal(h.legs.length, 3, 'all three legs started at once');
  assert.deepEqual(h.legs.map((l) => l.o.owner), W);
  assert.ok(h.legs.every((l) => l.raw === 500000000n), 'each wallet buys the full 0.5 SOL by default');
  h.legs.forEach((l) => l.resolve({ status: 'ok' }));
  assert.equal(await done, 3);
});
test('split mode divides the amount evenly over the wallets', async () => {
  const h = await harness({ mode: 'split' });
  const done = h.api.buyAcross(mint, 0.6); await h.settle();
  assert.ok(h.legs.every((l) => l.raw === 200000000n));
  h.legs.forEach((l) => l.resolve({ status: 'ok' })); assert.equal(await done, 3);
});
test('one wallet failing does not stop or delay the others', async () => {
  const h = await harness();
  const done = h.api.buyAcross(mint, 0.1); await h.settle();
  h.legs[0].resolve({ status: 'failed' }); h.legs[1].resolve({ status: 'ok' }); h.legs[2].resolve({ status: 'ok' });
  assert.equal(await done, 2);
});
test('parallel legs widen each minimum for the other legs\' price impact', async () => {
  const h = await harness();
  const quoted = { raw: '100000000', minOutRaw: '1000000', impactPct: 2 };
  const done = h.api.buyAcross(mint, 0.1, { quoted }); await h.settle();
  const min = BigInt(h.legs[0].o.minOutRaw);
  assert.ok(min < 1000000n && min > 800000n, 'below the single-leg minimum, within reason: ' + min);
  assert.ok(h.legs.every((l) => l.o.minOutRaw === h.legs[0].o.minOutRaw && l.o.maxImpactPct === 25));
  h.legs.forEach((l) => l.resolve({ status: 'ok' })); await done;
});
test('a multi-wallet sell sells each wallet\'s own share at once and skips wallets that hold none', async () => {
  const h = await harness({ held: { [W[0]]: 1000n, [W[2]]: 400n } });
  const done = h.api.sellAcross(mint, 50); await h.settle(); await h.settle();
  assert.deepEqual(h.legs.map((l) => [l.o.owner, l.raw]), [[W[0], 500n], [W[2], 200n]]);
  h.legs.forEach((l) => l.resolve({ status: 'ok' }));
  assert.equal(await done, 2); assert.equal(h.toasts.length, 0, 'an empty wallet is not an error when others hold the coin');
  const none = await harness(); assert.equal(await none.api.sellAcross(mint, 100), 0);
  assert.match(none.toasts[0][0], /None of your selected wallets/);
});
