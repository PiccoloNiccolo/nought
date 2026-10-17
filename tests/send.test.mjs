import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAt } from './helpers.mjs';

const RPCS = ['https://rpc-a.test', 'https://rpc-b.test'];
// a signed transaction: 1 signature (64 bytes of 7s) then a message; only the signature matters to sendRaw
const tx = Buffer.from([1, ...new Array(64).fill(7), 1, 2, 3]).toString('base64');
async function harness(answer) {
  const calls = [];
  const fetch = (url, init) => { const body = JSON.parse(init.body); calls.push({ url, method: body.method, cfg: body.params?.[1] }); return answer(url, body); };
  const res = (status, json) => Promise.resolve({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => json });
  const { api } = await moduleAt('src/core/rpc.js', {
    './util.js': { sleep: () => Promise.resolve() }, './vault.js': { b58encode: (b) => 'SIG' + b.length },
    './settings.js': { settings: { rpc: '' }, RPCS }, './jup.js': { ju: {}, jt: {}, jh: {} },
  }, { fetch, atob, setTimeout: () => 0, AbortSignal });
  return { api, calls, res };
}
const sends = (calls) => calls.filter((c) => c.method === 'sendTransaction');

test('a local transaction goes to every RPC and every Jito engine at once, without a second preflight', async () => {
  const h = await harness((url, b) => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result: 'SIG64' }) }));
  assert.equal(await h.api.sendRaw(tx), 'SIG64');
  const s = sends(h.calls);
  assert.equal(s.length, RPCS.length + h.api.JITO.length);
  assert.ok(s.filter((c) => RPCS.includes(c.url)).every((c) => c.cfg.skipPreflight === true));
});
test('the first host that takes it wins while slower hosts are still answering', async () => {
  const h = await harness((url) => url === RPCS[0] ? Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result: 'SIG64' }) }) : new Promise(() => {}));
  assert.equal(await h.api.sendRaw(tx), 'SIG64');
});
test('"already processed" anywhere means an earlier copy landed', async () => {
  const h = await harness(() => Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ error: { code: -32002, message: 'Transaction already processed' } }) }));
  assert.equal(await h.api.sendRaw(tx), 'SIG64');
});
test('when every host refuses outright nothing was sent: a plain error, not "maybe sent"', async () => {
  // RPCs refuse with HTTP 200 and a JSON-RPC error; Jito with HTTP 400. (A bare HTTP error from an RPC counts as
  // "may have arrived", the safe side.)
  const refuse = { error: { code: -32602, message: 'invalid transaction' } };
  const h = await harness((url) => Promise.resolve(RPCS.includes(url) ? { ok: true, status: 200, headers: { get: () => null }, json: async () => refuse } : { ok: false, status: 400, headers: { get: () => null }, json: async () => refuse }));
  await assert.rejects(h.api.sendRaw(tx), (e) => !e.maybeSent);
});
test('if any host may have received it, a failure is "maybe sent" with the signature (confirm, never retry)', async () => {
  const h = await harness((url) => url === RPCS[1] ? Promise.reject(new TypeError('network down')) : Promise.resolve({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { code: -32602, message: 'invalid transaction' } }) }));
  await assert.rejects(h.api.sendRaw(tx), (e) => e.maybeSent === true && e.sig === 'SIG64');
});
