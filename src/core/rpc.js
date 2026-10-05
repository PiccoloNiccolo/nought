// Solana JSON-RPC with failover: the user's own RPC (settings) first, then the public ones in RPCS. Each public RPC
// blocks some methods (checked live 2026-10-03), so calls skip hosts that can't answer them:
//   publicnode     no getTokenAccountsByOwner / getTokenSupply / getTokenLargestAccounts / getProgramAccounts (403)
//   solanatracker  no getTokenAccountsByOwner / getTokenLargestAccounts / getProgramAccounts / getRecentPrioritizationFees;
//                  bursts get a 429 with Retry-After: 10 and no CORS header (the browser sees a TypeError)
//   vibestation    allows everything but 429s after ~3 quick calls
//   publicnode also answers "Request blocked" to getMultipleAccounts with more than 10 keys (checked 2026-10-04), so
//   rpc() splits bigger lookups into chunks of 10
// A host that rate-limits or fails cools down and the next one is tried. Errors about the request itself (a failed
// simulation, bad params) are thrown at once. Balances come from Jupiter (ju) first: no RPC needed.
import { sleep } from './util.js';
import { b58encode } from './vault.js';
import { settings, RPCS } from './settings.js';
import { ju, jt, jh } from './jup.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const INDEXED = ['getTokenAccountsByOwner', 'getTokenSupply', 'getTokenLargestAccounts', 'getProgramAccounts'];
const blocked = new Map([
  ['solana-rpc.publicnode.com', new Set(INDEXED)],
  ['rpc.solanatracker.io', new Set(['getTokenAccountsByOwner', 'getTokenLargestAccounts', 'getProgramAccounts', 'getRecentPrioritizationFees'])],
]);
const coolUntil = new Map();
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
const canDo = (url, method) => !blocked.get(hostOf(url))?.has(method);
const learnBlock = (url, method) => { const h = hostOf(url); (blocked.get(h) || blocked.set(h, new Set()).get(h)).add(method); };
export const endpoints = () => [...new Set([settings.rpc, ...RPCS].filter((u) => /^https:\/\//.test(u || '')))];

// one POST; resolves {result} or {error, provider} where provider=true means "try another host", and ambiguous=true
// means the request may have reached the host anyway (a timeout, a dropped connection, a 5xx): sendRaw cares
async function post(url, method, params, ms) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) }); }
  catch (e) { coolUntil.set(url, Date.now() + (e?.name === 'TimeoutError' ? 3000 : 10000)); return { provider: true, ambiguous: true, error: new Error(`${hostOf(url)} did not answer`) }; }
  let j = null; try { j = await r.json(); } catch { /* HTML error page */ }
  if (r.status === 429 || j?.error?.code === -32005 || /rate limit/i.test(j?.error?.message || j?.error || '')) {
    coolUntil.set(url, Date.now() + (Number(r.headers.get('retry-after')) || (j ? 3 : 10)) * 1000);
    return { provider: true, error: new Error(`${hostOf(url)} is rate limiting`) };
  }
  const e = j?.error, msg = String(e?.message || e || '');
  if (r.status === 403 || e?.code === -32601 || /not allowed|personal token|indexed requests/i.test(msg)) { learnBlock(url, method); return { provider: true, error: new Error(msg || `${method} is not available on ${hostOf(url)}`) }; }
  if (/request blocked/i.test(msg)) return { provider: true, error: new Error(`${hostOf(url)} blocked this ${method}`) }; // a size limit, not the method
  if (!r.ok || !j || e?.code === -32603 || /upstream|no response/i.test(msg)) { coolUntil.set(url, Date.now() + 5000); return { provider: true, ambiguous: true, error: new Error(msg || `${r.status} from ${hostOf(url)}`) }; }
  if (e) return { error: Object.assign(new Error(msg || 'RPC error'), { code: e.code, data: e.data }) };
  return { result: j.result };
}
const ready = (method) => endpoints().filter((u) => canDo(u, method));
// wait (at most 5 s, and not past `until`) for the first cooling host to take requests again
const waitCool = (list, until) => sleep(Math.min(5000, Math.max(300, Math.min(...list.map((u) => coolUntil.get(u) || 0)) - Date.now()), until ? Math.max(0, until - Date.now()) : 5000));

// rpc(method, params, tries, opts): tries = extra passes over the host list when every host failed. opts:
//   accept(result) → bool: a result it refuses counts as a host failure and the next host is asked (txcheck.js uses it
//                        to skip RPCs whose simulations leave out the balances it needs)
//   until: a Date.now() deadline; no request starts after it and none runs past it
export async function rpc(method, params = [], tries = 2, { accept, until } = {}) {
  if (method === 'getMultipleAccounts' && params[0]?.length > GMA_MAX) return chunked(params, tries, { accept, until });
  let last = new Error(`No RPC can answer ${method}`);
  for (let pass = 0; pass <= tries; pass++) {
    const list = ready(method);
    if (!list.length) break;
    const open = list.filter((u) => (coolUntil.get(u) || 0) <= Date.now());
    if (!open.length) { if (until && Date.now() >= until - 300) break; await waitCool(list, until); continue; }
    for (const url of open) {
      const left = until ? until - Date.now() : Infinity;
      if (left < 300) throw last;
      const r = await post(url, method, params, Math.min(left, method === 'sendTransaction' ? 20000 : 15000));
      if (!r.error && (!accept || accept(r.result))) return r.result;
      if (!r.error) { last = new Error(`${hostOf(url)} gave an incomplete answer to ${method}`); continue; }
      if (!r.provider) throw r.error;
      last = r.error;
    }
    if (pass < tries) await sleep(Math.min(500 * (pass + 1), until ? Math.max(0, until - Date.now()) : 1e9));
  }
  throw last;
}
// getMultipleAccounts over more keys than every host allows in one call: chunks of GMA_MAX, three at a time
const GMA_MAX = 10;
async function chunked([keys, cfg], tries, opts) {
  const parts = [];
  for (let i = 0; i < keys.length; i += GMA_MAX) parts.push(keys.slice(i, i + GMA_MAX));
  const out = new Array(parts.length);
  let next = 0;
  const lane = async () => { while (next < parts.length) { const i = next++; out[i] = await rpc('getMultipleAccounts', cfg ? [parts[i], cfg] : [parts[i]], tries, opts); } };
  await Promise.all([lane(), lane(), lane()]);
  return { context: out[0]?.context, value: out.flatMap((r) => r?.value || []) };
}

// ---- sending (for transactions Nought builds and signs itself, e.g. local wallets) ----
// sendRaw(base64 signed transaction) → signature. Preflight on, the RPC rebroadcasts up to 3 times. Sending the same
// signed transaction to a second host is safe: it has one signature and can only land once. Contract C4:
//   - "already processed" from any host means an earlier attempt landed: success, return the signature;
//   - "Blockhash not found" is a lagging node: ask the next host;
//   - once an attempt may have reached a host (timeout, dropped connection, 5xx), any later failure throws with
//     err.maybeSent = true and err.sig: the caller confirms the signature instead of reporting a failure, and never
//     retries or refunds it. A plain error (e.g. preflight said it would fail) means nothing was sent.
const ALREADY = /already (been )?processed|AlreadyProcessed|duplicate signature/i;
const sigOf = (b64) => { const b = Uint8Array.from(atob(b64.slice(0, 92)), (c) => c.charCodeAt(0)); return b[0] > 0 ? b58encode(b.subarray(1, 65)) : ''; };
const maybeSent = (e, sig) => Object.assign(e instanceof Error ? e : new Error(String(e)), { sig, maybeSent: true });
export async function sendRaw(base64Tx) {
  const sig = sigOf(base64Tx), params = [base64Tx, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }];
  let maybe = false, last = new Error('No RPC accepted the transaction.');
  for (let pass = 0; pass < 2; pass++) {
    const list = ready('sendTransaction'), open = list.filter((u) => (coolUntil.get(u) || 0) <= Date.now());
    if (!open.length) { if (list.length) await waitCool(list); continue; }
    for (const url of open) {
      const r = await post(url, 'sendTransaction', params, 20000);
      if (!r.error) return typeof r.result === 'string' && r.result ? r.result : sig;
      const said = `${r.error.message} ${JSON.stringify(r.error.data?.err ?? '')}`;
      if (ALREADY.test(said)) return sig;
      last = r.error;
      if (r.provider) { maybe ||= !!r.ambiguous; continue; }
      if (/blockhash not found/i.test(said)) continue;
      throw maybe ? maybeSent(r.error, sig) : r.error;
    }
    if (pass === 0) await sleep(600);
  }
  throw maybe ? maybeSent(last, sig) : last;
}
export async function latestBlockhash(commitment = 'confirmed') { const v = (await rpc('getLatestBlockhash', [{ commitment }])).value; return { blockhash: v.blockhash, lastValidBlockHeight: v.lastValidBlockHeight }; }

// ---- balances: Jupiter first (one call, both token programs), RPC as the fallback ----
// SOL and token balance lookups that land together share one Jupiter call (3 s memo). opts (solBalance, tokenBalance):
// {prio: jup.js queue priority ('high' when a trade waits on it), jupiter: false to go straight to RPC}
const memo = new Map();
function balances(owner, { prio = 'normal', jupiter = true } = {}) {
  if (!jupiter) return Promise.reject(new Error('RPC only'));
  const hit = memo.get(owner); if (hit && Date.now() - hit.at < 3000 && prio !== 'high') return hit.p; // ('high' joins jup.js's identical request and lifts it)
  const p = ju.balances(owner, { prio }); memo.set(owner, { at: Date.now(), p }); p.catch(() => memo.delete(owner));
  if (memo.size > 50) memo.delete(memo.keys().next().value);
  return p;
}
export async function solBalance(addr, opts) {
  try { return (await balances(addr, opts)).sol; } catch { return (await rpc('getBalance', [addr, { commitment: 'confirmed' }])).value / 1e9; }
}
// One token's balance for a wallet: {raw (BigInt), dec, ui}
export async function tokenBalance(owner, mint, opts) {
  try {
    const b = (await balances(owner, opts)).tokens[mint];
    if (!b) return { raw: 0n, dec: 6, ui: 0 }; // only non-zero balances are listed
    return { raw: BigInt(b.raw), dec: b.dec ?? 6, ui: b.ui };
  } catch {
    const r = await rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    let raw = 0n, dec = 6;
    for (const acc of r.value) { const ta = acc.account.data.parsed.info.tokenAmount; raw += BigInt(ta.amount); dec = ta.decimals; }
    return { raw, dec, ui: Number(raw) / 10 ** dec };
  }
}
// Every token a wallet holds (non-zero), across both token programs: [{mint, raw (BigInt), dec, ui}]. opts as above.
export async function allTokenBalances(owner, { prio = 'normal', jupiter = true } = {}) {
  try {
    if (!jupiter) throw new Error('RPC only');
    return Object.entries((await ju.holdings(owner, { prio })).tokens).filter(([, b]) => b.raw !== '0').map(([mint, b]) => ({ mint, raw: BigInt(b.raw), dec: b.dec, ui: b.ui }));
  } catch {
    const out = new Map();
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      const r = await rpc('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const acc of r.value) {
        const info = acc.account.data.parsed.info, ta = info.tokenAmount;
        if (ta.amount === '0') continue;
        const cur = out.get(info.mint) || { mint: info.mint, raw: 0n, dec: ta.decimals, ui: 0 };
        cur.raw += BigInt(ta.amount); cur.ui = Number(cur.raw) / 10 ** cur.dec; out.set(info.mint, cur);
      }
    }
    return [...out.values()];
  }
}
export async function tokenSupply(mint) { const v = (await rpc('getTokenSupply', [mint])).value; return { raw: BigInt(v.amount), dec: v.decimals, ui: Number(v.uiAmountString) }; }
// Top holders as [{account, owner, ui, pct, tags}] (account = owner wallet when it comes from Jupiter). Prefer jh
// directly for the full picture (funding, labels, count); this keeps the old shape with an RPC fallback (top 20).
export async function topHolders(mint) {
  try {
    const [h, [t]] = await Promise.all([jh.holders(mint), jt.search(mint).catch(() => [])]);
    const supply = t?.mint === mint ? t.circSupply : 0;
    return h.holders.map((x) => ({ account: x.wallet, owner: x.wallet, ui: x.amount, pct: supply ? (x.amount / supply) * 100 : 0, tags: x.tags }));
  } catch {
    const [largest, supply] = await Promise.all([rpc('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]), tokenSupply(mint)]);
    const accs = largest.value.slice(0, 20);
    const infos = accs.length ? (await rpc('getMultipleAccounts', [accs.map((a) => a.address), { encoding: 'jsonParsed' }])).value : [];
    return accs.map((a, i) => ({ account: a.address, owner: infos[i]?.data?.parsed?.info?.owner || a.address, ui: Number(a.uiAmountString), pct: supply.ui ? (Number(a.uiAmountString) / supply.ui) * 100 : 0, tags: [] }));
  }
}
export async function signatureStatus(sig) { return (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }])).value[0]; }
export async function signaturesFor(addr, limit = 25) { return rpc('getSignaturesForAddress', [addr, { limit }]); }
