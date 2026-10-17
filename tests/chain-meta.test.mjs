import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAt } from './helpers.mjs';

// Values built inside the module sandbox have that realm's prototypes; compare their JSON.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);

const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', SPL = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bcd8kcrTd';
// A Metaplex metadata account: key 4, authority, mint, then fixed-width padded name/symbol/uri strings.
function metaplexAccount(uri) {
  const str = (s, width) => { const b = new Uint8Array(4 + width); new DataView(b.buffer).setUint32(0, width, true); b.set(new TextEncoder().encode(s), 4); return b; };
  const parts = [Uint8Array.of(4), new Uint8Array(64), str('Coin', 32), str('COIN', 10), str(uri, 200)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return Buffer.from(out).toString('base64');
}
async function harness(accounts, { web3 = true } = {}) {
  const timers = [], calls = [], upserts = [], metas = [], document = { hidden: false, addEventListener() {} };
  const tokens = new Map(Object.keys(accounts).map((mint) => [mint, { mint }]));
  const rpc = async (method, [keys, cfg]) => {
    calls.push({ method, keys, encoding: cfg.encoding });
    return { value: keys.map((k) => (typeof accounts[k] === 'function' ? accounts[k]() : accounts[k]) ?? null) };
  };
  const PublicKey = class {
    constructor(s) { this.s = s; }
    toBytes() { return new TextEncoder().encode(this.s); }
    static findProgramAddressSync([, , mint]) { return [{ toBase58: () => 'pda:' + new TextDecoder().decode(mint) }]; }
  };
  const { api } = await moduleAt('src/core/chain-meta.js', {
    './rpc.js': { rpc, TOKEN_PROGRAM: SPL, TOKEN_2022: T22 },
    './store.js': { tokens, upsert: (mint, patch) => { upserts.push([mint, patch]); Object.assign(tokens.get(mint), patch); return tokens.get(mint); } },
    './meta.js': { wantMeta: (t, o) => metas.push([t.mint, o]) },
  }, { document, atob, TextEncoder, TextDecoder, setTimeout: (fn) => { timers.push(fn); return timers.length; }, ...(web3 ? { solanaWeb3: { PublicKey } } : {}) });
  const flush = async () => { while (timers.length) { await timers.shift()(); await new Promise((r) => setImmediate(r)); } };
  return { api, calls, upserts, metas, tokens, flush, document };
}

test('Token-2022 coins get their URI from the mint extension and start a priority metadata lookup', async () => {
  const h = await harness({ a: { owner: T22, data: { parsed: { info: { extensions: [{ extension: 'tokenMetadata', state: { uri: 'https://ipfs.io/ipfs/QmA' } }] } } } } });
  h.api.wantUri('a'); await h.flush();
  same(h.upserts, [['a', { uri: 'https://ipfs.io/ipfs/QmA' }]]);
  assert.equal(h.metas[0][0], 'a'); assert.equal(h.metas[0][1].priority, true);
});
test('classic SPL coins read the padded URI from their Metaplex account', async () => {
  const h = await harness({ b: { owner: SPL }, 'pda:b': { owner: METAPLEX, data: [metaplexAccount('ipfs://QmB'), 'base64'] } });
  h.api.wantUri('b'); await h.flush();
  same(h.calls.map((c) => c.encoding), ['jsonParsed', 'base64']);
  same(h.calls[1].keys, ['pda:b']);
  same(h.upserts, [['b', { uri: 'ipfs://QmB' }]]);
});
test('lookups batch ten mints per call and never re-ask a coin within a minute', async () => {
  const accounts = Object.fromEntries(Array.from({ length: 23 }, (_, i) => ['m' + i, null]));
  const h = await harness(accounts);
  for (const m of Object.keys(accounts)) h.api.wantUri(m);
  await h.flush();
  same(h.calls.map((c) => c.keys.length), [10, 10, 3]);
  for (const m of Object.keys(accounts)) h.api.wantUri(m);
  await h.flush();
  assert.equal(h.calls.length, 3, 'unanswered mints wait for the retry window');
});
test('coins that already have a URI, unsafe URIs and RPC failures change nothing', async () => {
  const h = await harness({
    has: { owner: T22 },
    bad: { owner: T22, data: { parsed: { info: { extensions: [{ extension: 'tokenMetadata', state: { uri: 'javascript:alert(1)' } }] } } } },
    boom: () => { throw new Error('rpc down'); },
  });
  h.tokens.get('has').uri = 'https://x.test/a.json';
  h.api.wantUri('has'); await h.flush(); assert.equal(h.calls.length, 0);
  h.api.wantUri('bad'); await h.flush(); assert.equal(h.upserts.length, 0);
  h.api.wantUri('boom'); await h.flush(); assert.equal(h.upserts.length, 0);
});
test('without web3.js classic coins are skipped instead of failing the batch', async () => {
  const h = await harness({ c: { owner: SPL }, d: { owner: T22, data: { parsed: { info: { extensions: [{ extension: 'tokenMetadata', state: { uri: 'https://d.test/m.json' } }] } } } } }, { web3: false });
  h.api.wantUri('c'); h.api.wantUri('d'); await h.flush();
  assert.equal(h.calls.length, 1); same(h.upserts, [['d', { uri: 'https://d.test/m.json' }]]);
});
test('a hidden page queues lookups without calling the RPC', async () => {
  const h = await harness({ e: { owner: T22 } });
  h.document.hidden = true; h.api.wantUri('e'); await h.flush();
  assert.equal(h.calls.length, 0);
});
