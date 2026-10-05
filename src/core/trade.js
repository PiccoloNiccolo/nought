// Trading through Jupiter with NO platform fee: Nought never passes platformFeeBps, feeAccount or a referral.
// Two execution modes, picked per preset (preset.mev, default 'off'):
//   'off'        Metis route via /swap/v1 (quote → swap); your wallet signs and sends.
//   'protected'  Jupiter Ultra (/ultra/v1/order → sign → /execute): Jupiter lands the tx with its own MEV-protected
//                sender. Ultra charges JUPITER's own fee (checked 2026-10-04: 10 bps on memecoins incl. pump.fun,
//                2 bps SOL→USDC, returned as order.feeBps). The UI shows it as Jupiter's fee, never as Nought's.
//                Ultra picks its own slippage and priority fee; the preset's priority applies to 'off' only, and its
//                slippage is the most an Ultra order may use when the trade came from a reviewed quote (see quoteFor).
// Every mint and amount is checked before it goes into a Jupiter URL (built with URLSearchParams, so nothing can add
// a parameter), and every signing call says what the transaction may spend (wallet.js checks local signatures).
// Every trade made in Nought is logged in this browser ('trades') for PnL and the fees-saved counter.
import { toast, esc, short, LS, emit, on, sleep, usd, isMint } from './util.js';
import { settings, PRIO, preset } from './settings.js';
import { wallet, needWallet, signAndSend, signTx } from './wallet.js';
import { rpc, signatureStatus, TOKEN_PROGRAM, TOKEN_2022 } from './rpc.js';
import { tokens } from './store.js';
import { solUsd } from './price.js';
import { ju, jupRaw, coolLeft } from './jup.js';
import { assertZeroFeeQuote } from './fee-policy.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const JUP = 'https://lite-api.jup.ag';
export const JUP_API = 'https://api.jup.ag'; // keyless gateway (~0.5 rps): lite-api's replacement, used as fallback
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const FEE_REF = 0.01;                  // "a typical terminal fee" (1% of notional) for the fees-saved counter
export const LOW_LIQ_USD = 5000, WARN_IMPACT = 5, DANGER_IMPACT = 15;
export const MAX_QUICK_SOL = 1000;            // the most a one-click buy may spend
// what signing may cost on top of the amount (wallet.js / txcheck.js expect.maxFeeLamports): one signature, rent for
// up to two new token accounts, and 0.005 SOL of slack for a Jito tip or Ultra's own fees
export const SIG_FEE = 5000, ATA_RENT = 2039280, FEE_SLACK = 5000000;
const JSON_POST = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const HIGH = { prio: 'high' }; // a trade is waiting on it: goes ahead of background polling in jup.js's queues

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
export const txFromB64 = (b64) => window.solanaWeb3.VersionedTransaction.deserialize(b64ToBytes(b64));
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) { let n = 0n, s = ''; for (const b of bytes) n = n * 256n + BigInt(b); while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b) break; s = '1' + s; } return s; }
const big = (v, d = null) => { try { return v == null || v === '' ? d : BigInt(v); } catch { return d; } };

// ---- input checks: nothing unchecked reaches a Jupiter URL or a transaction ----
const needMint = (m, what = 'coin') => { if (!isMint(m)) throw new Error(`That is not a valid ${what} address.`); return String(m); };
// a positive amount of raw base units (bigint, safe integer or digit string) → its digit string
function rawStr(a) {
  const s = typeof a === 'bigint' ? a.toString() : typeof a === 'number' ? (Number.isSafeInteger(a) ? String(a) : '') : String(a ?? '').trim();
  if (!/^\d{1,20}$/.test(s) || BigInt(s) <= 0n || BigInt(s) > 18446744073709551615n) throw new Error('Enter an amount above zero.');
  return BigInt(s).toString();
}
const slipBps = (pct) => { const n = Number(pct); if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Set a slippage from 0 to 100% in your preset.'); return Math.round(n * 100); };
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();

// Jupiter error bodies come in three shapes: {error:'text'}, {errorMessage}, and zod {error:{issues:[...]}}
const jupError = (j) => (typeof j?.error === 'string' ? j.error : j?.errorMessage || j?.cause || j?.message || (j?.error?.issues || j?.issues || []).map((i) => `${(i.path || []).join('.')}: ${i.message}`).join('; '));

// fetch JSON from Jupiter, failing over lite-api → api.jup.ag on network errors, 429 and 5xx (a real 4xx answer is
// final); a host that is cooling down after a 429 is tried last. Requests wait in jup.js's per-host queues (shared
// with every adapter, so the keyless budget is counted once) at priority q.prio: 'high' for what a trade waits on
// (quotes, building transactions), 'normal' otherwise. q.queue = false sends at once (handing over a signed
// transaction). The host that answered is kept on the result as a non-enumerable `host` (Ultra executes on the same one).
export async function jfetch(path, opt = {}, ms = 15000, hosts = [JUP, JUP_API], q = {}) {
  const { prio = 'normal', queue = true } = q || {};
  const hostKey = (h) => new URL(h).host;
  const order = hosts.length > 1 ? [...hosts].sort((a, b) => (coolLeft(hostKey(a)) > 0) - (coolLeft(hostKey(b)) > 0)) : hosts;
  let last = new Error('Jupiter did not answer.');
  for (const [i, host] of order.entries()) {
    let res;
    const read = !opt.method || opt.method === 'GET';
    try { res = await jupRaw(host + path, opt, { prio, timeout: read && i < order.length - 1 ? Math.min(ms, 3500) : ms, queue, failover: i < order.length - 1 }); } catch (e) { last = e; continue; }
    const { status, ok, j } = res;
    if (ok && j) { if (typeof j === 'object') Object.defineProperty(j, 'host', { value: host }); return j; }
    last = new Error(jupError(j) || (status === 429 ? 'Jupiter is rate limiting right now. Try again in a few seconds.' : `${status} from ${hostKey(host)}`));
    last.status = status;
    if (status !== 429 && status < 500) break;
  }
  throw last;
}

// ---- decimals and supply ----
// decimalsOf(mint) is for DISPLAY only: SOL 9, else what we've seen (balances, prices, the store), else 6. Anything
// that builds a transaction uses mintDecimals(), which never guesses.
const DEC = new Map([[SOL_MINT, 9]]);
const VDEC = new Map([[SOL_MINT, 9]]); // read from the chain (the mint account or a token account): exact
export const decimalsOf = (mint) => VDEC.get(mint) ?? DEC.get(mint) ?? tokens.get(mint)?.decimals ?? tokens.get(mint)?.dec ?? 6;
export const rememberDecimals = (mint, d) => { if (Number.isInteger(d) && d >= 0 && d <= 255) DEC.set(mint, d); };
const chainDecimals = (mint, d) => { if (Number.isInteger(d) && d >= 0 && d <= 255) { VDEC.set(mint, d); DEC.set(mint, d); } };
// The mint account over RPC: {dec, supplyRaw (BigInt), supply (UI units), program}. getAccountInfo works on every
// public RPC (getTokenSupply doesn't). Decimals never change; the supply is re-read after maxAgeMs (default 10 min).
const MINTS = new Map();
export async function mintInfo(mint, { maxAgeMs = 600000 } = {}) {
  needMint(mint);
  const hit = MINTS.get(mint);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit;
  const v = (await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value, info = v?.data?.parsed?.info;
  if (!v || (v.owner !== TOKEN_PROGRAM && v.owner !== TOKEN_2022) || v.data?.parsed?.type !== 'mint' || !Number.isInteger(info?.decimals)) throw Object.assign(new Error('That address is not a token mint.'), { notMint: true });
  const supplyRaw = big(info.supply, 0n), r = { dec: info.decimals, supplyRaw, supply: Number(supplyRaw) / 10 ** info.decimals, program: v.owner, at: Date.now() };
  MINTS.set(mint, r); chainDecimals(mint, r.dec);
  return r;
}
// Decimals for building a transaction: read from the chain (cached for good), else jupDec when the caller has
// Jupiter's answer from this very call; never a default. Throws when unknown.
export async function mintDecimals(mint, jupDec) {
  needMint(mint);
  if (VDEC.has(mint)) return VDEC.get(mint);
  try { return (await mintInfo(mint, { maxAgeMs: Infinity })).dec; } catch (e) { if (e.notMint) throw e; }
  if (Number.isInteger(jupDec) && jupDec >= 0 && jupDec <= 18) return jupDec;
  throw new Error('Could not read this coin\'s decimals right now, so the amount can\'t be worked out safely. Try again in a moment.');
}

// ---- standard route (swap/v1) ----
export async function quote(input, output, amountRaw, slippagePct = preset().slippage) {
  const q = await jfetch('/swap/v1/quote?' + qs({ inputMint: needMint(input), outputMint: needMint(output), amount: rawStr(amountRaw), slippageBps: slipBps(slippagePct), restrictIntermediateTokens: 'true' }), {}, 12000, undefined, HIGH);
  if (q.error || !q.outAmount) throw new Error(q.error || 'No route for this coin yet.');
  assertZeroFeeQuote(q);
  return q;
}
// build (never send) the swap for a quote: {tx, prioritizationFeeLamports, computeUnitLimit, lastValidBlockHeight}
export async function buildSwap(q, prioKey = preset().prio, owner = wallet.owner) {
  assertZeroFeeQuote(q);
  needMint(owner, 'wallet');
  const p = PRIO[prioKey] || PRIO.fast;
  const body = { quoteResponse: q, userPublicKey: owner, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Math.round(p.max * 1e9), priorityLevel: p.level } } };
  const j = await jfetch('/swap/v1/swap', JSON_POST(body), 15000, undefined, HIGH);
  if (!j.swapTransaction) throw new Error(jupError(j) || 'No transaction came back from the router.');
  // Jupiter dry-runs the swap; an error here (e.g. 0x1 = not enough SOL for amount + fees) would only burn fees on-chain
  if (j.simulationError) throw new Error(`This trade would fail on-chain (${j.simulationError.error || j.simulationError.errorCode}). Check your balance covers the amount plus fees.`);
  const tx = txFromB64(j.swapTransaction);
  if (tx.message.staticAccountKeys[0]?.toBase58() !== owner) throw new Error('The router built this trade for another wallet. Nothing was signed.');
  return { tx, prioritizationFeeLamports: j.prioritizationFeeLamports, computeUnitLimit: j.computeUnitLimit, lastValidBlockHeight: j.lastValidBlockHeight };
}
export async function swapTx(q, prioKey = preset().prio, owner = wallet.owner) { return (await buildSwap(q, prioKey, owner)).tx; }

// ---- protected route (Ultra). Without a taker the order is a quote only (no transaction). ----
export async function ultraOrder(input, output, amountRaw, taker = null) {
  const o = await jfetch('/ultra/v1/order?' + qs({ inputMint: needMint(input), outputMint: needMint(output), amount: rawStr(amountRaw), taker: taker ? needMint(taker, 'wallet') : null }), {}, 12000, undefined, HIGH);
  if (!o.outAmount || o.outAmount === '0') throw new Error(o.errorMessage || jupError(o) || 'No route for this coin yet.');
  if (taker && !o.transaction) throw new Error(o.errorMessage || 'Jupiter could not build this trade.'); // e.g. 'Insufficient funds' (errorCode 1)
  return o;
}
// sign without sending (wallet.js signTx: the extension's signTransaction, or the local vault key)
async function signOnly(tx, owner, expect) {
  try { return await signTx(tx, owner, expect); }
  catch (e) { throw /cannot sign without sending/.test(e?.message) ? new Error('This wallet cannot sign without sending, so MEV protection is unavailable. Turn it off in your preset.') : e; }
}
// What a swap may cost the owner (wallet.js C3 expect): the amount in, plus the priority cap, one signature, two token
// accounts' rent and the slack. extra adds Ultra's own fee when Jupiter takes it in SOL on top of the amount.
const solOr = (m) => (m === SOL_MINT ? 'SOL' : m);
const prioCap = (prioKey) => Math.round(((PRIO[prioKey] || PRIO.fast).max) * 1e9);
// minRecv (raw, optional): the swap's own guaranteed minimum; txcheck.js then also refuses a token buy whose simulation
// delivers less.
const swapExpect = (inM, outM, inRaw, prioLamports, extra = 0, minRecv = null) => ({ purpose: 'swap', spendMint: solOr(inM), maxSpendRaw: String(inRaw), receiveMint: solOr(outM), maxFeeLamports: prioLamports + SIG_FEE + 2 * ATA_RENT + FEE_SLACK + extra, ...(minRecv != null && { minReceiveRaw: String(minRecv) }) });
function ultraExpect(o, prioKey = preset().prio) {
  const fee = o.inputMint === SOL_MINT && o.feeMint === SOL_MINT ? Math.ceil((Number(o.inAmount) * Math.min(100, Math.max(0, Number(o.feeBps) || 0))) / 1e4) : 0;
  return swapExpect(o.inputMint, o.outputMint, o.inAmount, Math.max(prioCap(prioKey), Math.min(10000000, Number(o.prioritizationFeeLamports) || 0)), fee);
}
// Sign an Ultra order and hand it to Jupiter, which lands it. Returns Jupiter's answer ({status: 'Success'|'Failed',
// code, error, ...}) with `signature` read from the signed transaction itself and its `blockhash`. If /execute doesn't
// answer (timeout, network, 429/5xx), the SAME signed transaction and requestId go once more (Jupiter answers a repeat
// with the status of the first, so it can't land twice); when that fails too it throws {maybeSent, sig, blockhash}:
// settle(sig) tells whether it landed. Never build a new order after a maybeSent.
export async function ultraExecute(o, owner = wallet.owner, expect = ultraExpect(o)) {
  const s = await signOnly(txFromB64(o.transaction), owner, expect);
  const bytes = s instanceof Uint8Array ? s : s?.serialize ? s.serialize() : typeof s?.signedTransaction === 'string' ? b64ToBytes(s.signedTransaction) : s?.signedTransaction;
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('Your wallet did not sign the transaction.');
  const vt = window.solanaWeb3.VersionedTransaction.deserialize(bytes), first = vt.signatures[0];
  // signature 0 is the fee payer's: the taker's, unless Jupiter pays (gasless), which signs only when it lands it
  const sig = first?.some((b) => b) ? b58(first) : null, blockhash = vt.message.recentBlockhash;
  const body = JSON_POST({ signedTransaction: bytesToB64(bytes), requestId: o.requestId });
  let last = null, unsure = false;
  for (let i = 0; i < 2; i++) {
    if (i) await sleep(2000);
    try {
      const x = await jfetch('/ultra/v1/execute', body, i ? 30000 : 40000, [o.host || JUP], { queue: false });
      return Object.assign(x, { signature: sig || x.signature, blockhash });
    } catch (e) { last = e; if (!e.status || e.status >= 500) unsure = true; else if (e.status !== 429) break; }
  }
  if (unsure) throw Object.assign(new Error('Jupiter did not confirm it took the trade.'), { maybeSent: true, sig, blockhash });
  throw last; // a real answer: Jupiter refused the transaction, so it was never sent
}
// Ultra /execute codes where Jupiter refused the transaction before sending it (expired order, bad or unsigned
// transaction, stale block height, expired or rejected quote); a positive code is the program's own error.
const UNSENT = new Set([-1, -2, -3, -4, -5, -1002, -1003, -1004, -2002, -2003, -2004]);
const ultraFailed = (code) => Number(code) > 0 || UNSENT.has(Number(code));

const presetOf = (x) => (typeof x === 'number' ? settings.presets[x] : x) || preset();
// A quote for the UI in the preset's mode: a swap/v1 quote ('off') or an Ultra order without a taker ('protected').
// opts: {mev, slippage, preset (index or object)}
// An Ultra order only gets its slippage once it is built for a wallet, so without a taker it says 0 and its minimum
// is the full amount. Here the minimum is the preset's slippage below the quote instead, and trade({minOutRaw})
// refuses an Ultra order whose own slippage could pay out less than that.
export async function quoteFor(input, output, amountRaw, opts = {}) {
  const p = presetOf(opts.preset), slip = opts.slippage ?? p.slippage;
  if ((opts.mev ?? p.mev) !== 'protected') return quote(input, output, amountRaw, slip);
  const o = await ultraOrder(input, output, amountRaw), bps = slipBps(slip), out = big(o.outAmount, 0n);
  if (!(Number(o.slippageBps) > 0)) Object.assign(o, { slippageBps: bps, otherAmountThreshold: String((out * BigInt(10000 - bps)) / 10000n), slippageFromPreset: true });
  return o;
}
// The least a quote or order can pay out, in raw output units: swap/v1's otherAmountThreshold; for Ultra the lower of
// that and outAmount less its slippageBps.
export function minOutOf(q) {
  const out = big(q?.outAmount, 0n), oat = big(q?.otherAmountThreshold, out);
  if (!(q?.mode === 'ultra' || q?.requestId)) return oat;
  const bySlip = (out * BigInt(10000 - Math.min(10000, Math.max(0, Math.round(Number(q.slippageBps) || 0))))) / 10000n;
  return oat < bySlip ? oat : bySlip;
}
// Hold a fresh swap/v1 quote to the minimum the user approved: if the price moved against them but the quote still
// pays at least that much, tighten its slippage so the swap itself guarantees it (Jupiter builds the swap from
// quoteResponse.slippageBps; checked 2026-10-04). null when the quote pays less than the minimum.
function holdToMin(q, minOut) {
  if (minOutOf(q) >= minOut) return q;
  const out = big(q.outAmount, 0n);
  if (out <= 0n || out < minOut) return null;
  const bps = Number(((out - minOut) * 10000n) / out); // rounded down, so out × (1 − bps) stays ≥ minOut
  return { ...q, slippageBps: bps, otherAmountThreshold: String((out * BigInt(10000 - bps)) / 10000n) };
}

// What the trade panel shows for a quote from quote(), quoteFor() or ultraOrder(). opts: {inDec, outDec, prio}
// fees lists THIRD-PARTY costs only ({who, label, sol?, bps?, note?}); Nought's own fee is always 0. minOutRaw (string,
// raw output units) is what to pass to trade() as opts.minOutRaw when the user acts on this quote.
export function quoteDetails(q, opts = {}) {
  const ultra = q.mode === 'ultra' || !!q.requestId;
  const inDec = opts.inDec ?? decimalsOf(q.inputMint), outDec = opts.outDec ?? decimalsOf(q.outputMint);
  const inUi = Number(q.inAmount) / 10 ** inDec, outUi = Number(q.outAmount) / 10 ** outDec, minOut = minOutOf(q);
  const solSide = q.inputMint === SOL_MINT ? inUi : q.outputMint === SOL_MINT ? outUi : null;
  const prio = PRIO[opts.prio ?? preset().prio] || PRIO.fast, fees = [];
  if (ultra && q.feeBps > 0) fees.push({ who: 'jupiter', label: 'Jupiter Ultra fee (Jupiter\'s, not Nought\'s)', bps: q.feeBps, sol: solSide != null && q.feeMint === SOL_MINT ? (solSide * q.feeBps) / 1e4 : null });
  fees.push({ who: 'pool', label: 'Pool and launchpad fees', note: 'included in the quoted price' });
  fees.push(ultra ? { who: 'priority', label: 'Priority fee', sol: (q.prioritizationFeeLamports || 0) / 1e9, note: 'set by Jupiter' } : { who: 'priority', label: 'Priority fee', sol: prio.max, note: `at most (${prio.label})` });
  fees.push({ who: 'network', label: 'Network fee', sol: (q.signatureFeeLamports || 5000) / 1e9 });
  if (q.rentFeeLamports > 0) fees.push({ who: 'rent', label: 'Token account rent', sol: q.rentFeeLamports / 1e9, note: 'refunded if the account is closed' });
  return {
    mode: ultra ? 'protected' : 'standard', inUi, outUi, solSide,
    impactPct: Math.abs(Number(q.priceImpactPct) || 0) * 100, // both APIs give a fraction (Ultra signs it negative)
    minOutUi: Number(minOut) / 10 ** outDec, minOutRaw: minOut.toString(), slippageBps: Number(q.slippageBps) || 0,
    routeLabel: [...new Set((q.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean))].join(' → ') || '—',
    usdValue: Number(q.swapUsdValue || q.inUsdValue) || null, noughtFeePct: 0, fees,
  };
}
// Low-liquidity / high-impact warning: null or {level:'warn'|'danger', text}. Pass quoteDetails() and pool liquidity (USD).
export function impactWarning(d, liqUsd) {
  const imp = d?.impactPct ?? 0;
  if (imp >= DANGER_IMPACT) return { level: 'danger', text: `Price impact ${imp.toFixed(1)}%: a large part of this trade goes into moving the price. Use a smaller amount.` };
  if (imp >= WARN_IMPACT) return { level: 'warn', text: `Price impact ${imp.toFixed(1)}%. Consider a smaller amount.` };
  if (liqUsd != null && liqUsd < LOW_LIQ_USD) return { level: 'warn', text: `Thin liquidity (${usd(liqUsd)}): the price can jump and fills can miss.` };
  return null;
}

// ---- confirming ----
// Follow a sent transaction until it confirms, fails, or can no longer land. opts: {blockhash: the SIGNED
// transaction's recentBlockhash, lastValidBlockHeight (when the caller fetched that blockhash itself), capMs}
// → {status: 'ok'|'failed'|'unknown', expired, slot}.
// With a blockhash (or its last valid height) it polls until that blockhash has run out, asking a node at least as far
// along as the one that last called it valid (a lagging node can only report a lower height), then looks once more:
// no signature by then means it never landed and never will (status 'unknown', expired: true). Without either it
// stops after capMs (90 s) and 'unknown' only means "not seen yet".
export async function settle(sig, { blockhash, lastValidBlockHeight, capMs } = {}) {
  if (typeof sig !== 'string' || !sig) return { status: 'unknown', expired: false };
  const lvh = Number(lastValidBlockHeight) > 0 ? Number(lastValidBlockHeight) : null, known = !!(blockhash || lvh);
  const end = Date.now() + Math.min(Math.max(capMs ?? (known ? 150000 : 90000), 3000), 180000);
  let validAt = 0, gone = 0;
  const look = async (history) => { const s = history ? (await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]))?.value?.[0] : await signatureStatus(sig); return s?.err ? { status: 'failed', slot: s.slot } : s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') ? { status: 'ok', slot: s.slot } : s ? 'seen' : null; };
  // true once the blockhash has run out, false while it is valid, undefined when this round can't tell
  const past = async () => {
    if (!blockhash) return Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > lvh;
    const v = await rpc('isBlockhashValid', [blockhash, { commitment: 'confirmed', ...(validAt && { minContextSlot: validAt }) }]);
    if (v?.value === true) { validAt = Math.max(validAt, v.context?.slot || 0); return false; }
    return v?.value === false && validAt ? true : undefined;
  };
  for (let i = 0; ; i++) {
    await sleep(i ? 1500 : 800);
    let seen = false;
    try { const r = await look(false); if (r && r !== 'seen') return r; seen = r === 'seen'; } catch { /* keep waiting */ }
    if (known && !seen && i % 2 === 1) {
      try {
        const p = await past();
        if (p === false) gone = 0;
        else if (p && ++gone >= 2) {
          await sleep(2000);
          const r = await look(true).catch(() => 'seen');
          if (r && r !== 'seen') return r;
          if (r === null) return { status: 'unknown', expired: true };
          gone = 0;
        }
      } catch { /* a node behind validAt (-32016) or no answer: no verdict this round */ }
    }
    if (Date.now() > end) return { status: 'unknown', expired: false };
  }
}
// 'ok' | 'failed' | 'unknown'. opts: a number of 1.5 s polls (old form), or settle()'s {blockhash, lastValidBlockHeight, capMs}.
export async function confirm(sig, opts) { return (await settle(sig, typeof opts === 'number' ? { capMs: opts * 1500 } : opts)).status; }
export const txLink = (sig) => `<a href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">View on Solscan</a>`;
// true when Nought signs for owner itself (local vault): the transaction it sends is exactly the one built here
const signsHere = (owner) => !(wallet.kind === 'external' && owner === wallet.owner);

// ---- trades in the last minute, per wallet and coin: Jupiter's balance index trails fills, so holding() skips it ----
const lastTrade = new Map(); // owner|mint → {at, slot}
function markTrade(owner, mint, slot) {
  if (!owner || !mint) return;
  const k = owner + '|' + mint, was = lastTrade.get(k);
  lastTrade.set(k, { at: Date.now(), slot: Math.max(slot || 0, was && Date.now() - was.at < 60000 ? was.slot || 0 : 0) || null });
  if (lastTrade.size > 200) lastTrade.delete(lastTrade.keys().next().value);
}
const recentTrade = (owner, mint) => { const x = lastTrade.get(owner + '|' + mint); return x && Date.now() - x.at < 60000 ? x : null; };
on('traded', (e) => markTrade(e?.owner, e?.mint));

// side 'buy' spends amountRaw lamports; 'sell' sells amountRaw token base units.
// opts: {slippage, prio, mev, preset (index or object), label, owner, maxImpactPct, minOutRaw, detail}
//   minOutRaw  the minimum (raw output units) the user saw on a review or quote (quoteDetails().minOutRaw). A standard
//              route is held to it on-chain; when the fresh quote can't pay it, or an Ultra order's slippage could
//              pay less, the trade stops before signing and returns false.
//   detail     return {status: 'ok'|'failed'|'unknown'|'aborted', sig, slot, expired} instead of a boolean.
// Errors before signing are thrown as they are; errors from signing onwards carry e.signing = true. A transaction
// that may have been sent is never retried: it is followed until it lands or expires.
export async function trade(side, mint, amountRaw, opts = {}) {
  const r = await runTrade(side, mint, amountRaw, opts);
  return opts.detail ? r : r.status === 'ok';
}
async function runTrade(side, mint, amountRaw, opts) {
  if (side !== 'buy' && side !== 'sell') throw new Error('Pick buy or sell.');
  needMint(mint);
  const owner = opts.owner || wallet.owner;
  if (!owner) { needWallet(); return { status: 'aborted' }; }
  needMint(owner, 'wallet');
  const raw = rawStr(amountRaw), minOut = opts.minOutRaw == null ? null : big(opts.minOutRaw, -1n);
  if (minOut != null && minOut < 0n) throw new Error('The reviewed minimum is not a whole number of base units.');
  const p = presetOf(opts.preset), slippage = opts.slippage ?? p.slippage, prio = opts.prio ?? p.prio, mev = opts.mev ?? p.mev ?? 'off';
  const label = opts.label || (tokens.get(mint)?.symbol ? '$' + tokens.get(mint).symbol : short(mint));
  const [inM, outM] = side === 'buy' ? [SOL_MINT, mint] : [mint, SOL_MINT];
  const moved = () => { toast('The price moved since you reviewed it. Check the new quote and try again.', 'err'); return { status: 'aborted' }; };
  let q, sig, st, outRaw, signing = false, note = '';
  try {
    if (mev === 'protected') {
      q = await ultraOrder(inM, outM, raw, owner);
      sameTrade(q, inM, outM, raw);
      guardImpact(q, opts.maxImpactPct);
      if (minOut != null && minOutOf(q) < minOut) return moved();
      toast(`Approve the ${side} of ${esc(label)} in your wallet… (MEV-protected; Jupiter's Ultra fee ${(q.feeBps || 0) / 100}%)`);
      signing = true; markTrade(owner, mint);
      let x;
      try { x = await ultraExecute(q, owner, ultraExpect(q, prio)); }
      catch (e) { if (!e?.maybeSent) throw e; toast(`Jupiter did not answer in time. Checking whether the ${side} landed…`); x = { signature: e.sig, blockhash: e.blockhash, pending: true }; }
      sig = x.signature;
      if (!sig) {
        toast(`Jupiter did not answer, so it is unclear whether the ${side} of ${esc(label)} landed. Check your wallet before trying again.`, 'err');
        emit('traded', { mint, side, sig: null, status: 'unknown', owner });
        return { status: 'unknown', sig: null };
      }
      if (x.status === 'Success') { st = { status: 'ok' }; try { st.slot = (await signatureStatus(sig))?.slot; } catch { /* the balance read just won't wait for it */ } }
      else if (x.status === 'Failed' && ultraFailed(x.code)) { st = { status: 'failed' }; note = x.error || jupError(x) || ''; }
      else { if (x.status === 'Failed') toast(`Jupiter reports the ${side} did not land. Checking the network to be sure… ${txLink(sig)}`); st = await settle(sig, { blockhash: x.blockhash }); }
      outRaw = x.outputAmountResult || x.totalOutputAmount || q.outAmount;
    } else {
      q = await quote(inM, outM, raw, slippage);
      sameTrade(q, inM, outM, raw);
      guardImpact(q, opts.maxImpactPct);
      if (minOut != null) { const held = holdToMin(q, minOut); if (!held) return moved(); q = held; }
      const built = await buildSwap(q, prio, owner), bh = signsHere(owner) ? built.tx.message.recentBlockhash : null;
      toast(`Approve the ${side} of ${esc(label)} in your wallet…`);
      signing = true; markTrade(owner, mint);
      try { sig = await signAndSend(built.tx, owner, swapExpect(inM, outM, raw, prioCap(prio), 0, minOutOf(q))); }
      catch (e) { if (!e?.maybeSent || !e.sig) throw e; sig = e.sig; }
      toast(`Sent. Confirming… ${txLink(sig)}`);
      st = await settle(sig, { blockhash: bh });
      outRaw = q.outAmount;
    }
  } catch (e) {
    if (!signing) throw e;
    throw Object.assign(e instanceof Error ? e : new Error(e?.message || String(e || 'The wallet did not sign.')), { signing: true, ...(e?.code != null && { code: e.code }) });
  }
  markTrade(owner, mint, st.slot);
  // a transaction whose blockhash ran out without landing cost nothing and can't land later: report it as failed
  const r = st.status === 'unknown' && st.expired ? 'failed' : st.status;
  const solAmt = side === 'buy' ? Number(raw) / 1e9 : Number(outRaw) / 1e9, tokAmt = side === 'buy' ? Number(outRaw) : Number(raw);
  if (r === 'ok') {
    const su = solUsd();
    logTrade({ mint, side, sol: solAmt, tokensRaw: tokAmt, sig, at: Date.now(), owner, solUsd: su, mode: mev === 'protected' ? 'ultra' : 'swap', jupFeeBps: mev === 'protected' ? q.feeBps || 0 : 0, route: quoteDetails(q).routeLabel, savedSol: solAmt * FEE_REF, savedUsd: solAmt * FEE_REF * su });
  }
  toast(r === 'ok' ? `${side === 'buy' ? 'Bought' : 'Sold'} ${esc(label)}. ${txLink(sig)}`
    : st.expired ? `The ${side} of ${esc(label)} did not land before it expired, so nothing was traded. ${txLink(sig)}`
    : r === 'failed' ? `The trade failed${note ? ': ' + esc(String(note).slice(0, 160)) : ' on-chain (often slippage)'}. ${txLink(sig)}`
    : `Still confirming. Check your wallet before trying again. ${txLink(sig)}`, r === 'ok' ? 'ok' : r === 'failed' ? 'err' : '');
  emit('traded', { mint, side, sig, status: r, owner });
  return { status: r, sig, slot: st.slot || null, expired: !!st.expired };
}
// the quote must be for exactly what was asked, and carry no platform fee (Ultra's feeBps is Jupiter's own)
function sameTrade(q, inM, outM, raw) {
  if ((q.inputMint && q.inputMint !== inM) || (q.outputMint && q.outputMint !== outM) || String(q.inAmount) !== raw) throw new Error('Jupiter answered for a different trade. Nothing was signed; try again.');
  if (!q.requestId && Number(q.platformFee?.feeBps) > 0) throw new Error('This route carries a platform fee, which Nought never pays. Nothing was signed.');
}
function guardImpact(q, max) {
  const imp = Math.abs(Number(q.priceImpactPct) || 0) * 100;
  if (max != null && imp > max) throw new Error(`Price impact is ${imp.toFixed(1)}% (limit ${max}%). Use a smaller amount or trade from the coin's page.`);
}

// one-click buy of sol SOL (default: the preset's amount), 0 < sol ≤ MAX_QUICK_SOL
export async function quickBuy(mint, btn, amountSol = preset().buy) {
  const sol = Number(amountSol);
  if (!isMint(mint)) { toast('That is not a coin address.', 'err'); return; }
  if (!(sol > 0 && sol <= MAX_QUICK_SOL)) { toast(`Set a buy amount above 0 and at most ${MAX_QUICK_SOL} SOL in your preset.`, 'err'); return; }
  if (btn) btn.disabled = true;
  try { await trade('buy', mint, BigInt(Math.round(sol * 1e9)), { maxImpactPct: 25 }); } // one-click buys never see a quote
  catch (e) { toast(esc(e?.message || 'The trade did not go through.'), 'err'); }
  if (btn) btn.disabled = false;
}

// ---- balances and selling a share of a holding ----
// One token's balance as {raw (BigInt), dec, ui, frozen}. The wallet's own token accounts over RPC first (both token
// programs; exact, and after a trade read at or after the slot it landed in); Jupiter's balances only when every RPC
// failed, and never within 60 s of a trade of this coin by this wallet (its index trails fills, and a % sell on the
// old balance would sell everything left); then the indexed getTokenAccountsByOwner (custom RPCs and vibestation).
export async function holding(mint, owner = wallet.owner) {
  needMint(mint);
  const none = { raw: 0n, dec: decimalsOf(mint), ui: 0, frozen: false };
  if (!owner) return none;
  needMint(owner, 'wallet');
  const fresh = recentTrade(owner, mint);
  try { return await ataBalance(owner, mint, fresh?.slot); } catch { /* no RPC answered: Jupiter, then the indexed read */ }
  if (!fresh) {
    try {
      const b = await ju.balances(owner, HIGH), e = b?.tokens?.[mint];
      if (b && typeof b === 'object' && !e) return none; // Jupiter lists every non-zero balance
      const raw = big(e?.raw, null);
      if (raw != null && raw >= 0n) {
        const ui = Number(e.ui), dec = Number.isInteger(e.dec) ? e.dec : ui > 0 ? Math.round(Math.log10(Number(raw) / ui)) : decimalsOf(mint);
        rememberDecimals(mint, dec);
        return { raw, dec, ui: Number(raw) / 10 ** dec, frozen: !!e.frozen };
      }
    } catch { /* indexed RPC next */ }
  }
  try {
    const r = await rpcAtLeast('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }], fresh?.slot);
    let raw = 0n, dec = null, frozen = false;
    for (const acc of r?.value || []) { const info = acc?.account?.data?.parsed?.info, ta = info?.tokenAmount; if (!ta) continue; raw += BigInt(ta.amount); dec = ta.decimals; frozen ||= info.state === 'frozen'; }
    if (dec != null) chainDecimals(mint, dec);
    const d = dec ?? decimalsOf(mint);
    return { raw, dec: d, ui: Number(raw) / 10 ** d, frozen };
  } catch { throw new Error(fresh ? 'Could not read your balance right after the trade. Try again in a few seconds.' : 'Could not read your balance. Try again, or set your own RPC in settings.'); }
}
// an RPC read that must reflect slot minSlot or later: a node that is behind answers -32016, so wait and ask again
async function rpcAtLeast(method, params, minSlot) {
  const p = minSlot ? [...params.slice(0, -1), { ...params.at(-1), minContextSlot: minSlot }] : params;
  for (let i = 0; ; i++) {
    try { return await rpc(method, p); } catch (e) { if (e?.code !== -32016 || i >= 4) throw e; await sleep(700); }
  }
}
async function ataBalance(owner, mint, minSlot) {
  const P = window.solanaWeb3.PublicKey, o = new P(owner).toBytes(), m = new P(mint).toBytes(), ataProgram = new P(ATA_PROGRAM);
  const addrs = [TOKEN_PROGRAM, TOKEN_2022].map((p) => P.findProgramAddressSync([o, new P(p).toBytes(), m], ataProgram)[0].toBase58());
  const res = await rpcAtLeast('getMultipleAccounts', [addrs, { encoding: 'jsonParsed', commitment: 'confirmed' }], minSlot);
  if (!Array.isArray(res?.value)) throw new Error('Unreadable answer from the RPC');
  let raw = 0n, dec = null, frozen = false;
  for (const a of res.value) { const info = a?.data?.parsed?.info, ta = info?.tokenAmount; if (!ta) continue; raw += BigInt(ta.amount); dec = ta.decimals; frozen ||= info.state === 'frozen'; }
  if (dec != null) chainDecimals(mint, dec);
  const d = dec ?? decimalsOf(mint);
  return { raw, dec: d, ui: Number(raw) / 10 ** d, frozen };
}
// sell pct% (0–100] of the wallet's balance of mint. opts as trade().
export async function sellPct(mint, pct, opts = {}) {
  needMint(mint);
  const owner = opts.owner || wallet.owner;
  if (!owner) { needWallet(); return opts.detail ? { status: 'aborted' } : false; }
  const p = Math.min(100, Number(pct));
  if (!(p > 0)) throw new Error('Pick how much to sell.');
  const h = await holding(mint, owner);
  if (h.frozen) throw new Error('This coin is frozen in your wallet, so it cannot be sold.');
  if (!(h.raw > 0n)) throw new Error('You hold none of this coin.');
  const raw = p >= 100 ? h.raw : (h.raw * BigInt(Math.round(p * 100))) / 10000n;
  if (raw <= 0n) throw new Error('That share of your balance rounds to zero.');
  return trade('sell', mint, raw, { ...opts, owner });
}
export async function quickSell(mint, btn, pct = preset().sellPct) {
  if (!isMint(mint)) { toast('That is not a coin address.', 'err'); return; }
  if (btn) btn.disabled = true;
  try { if (needWallet()) await sellPct(mint, pct); }
  catch (e) { toast(esc(e?.message || 'The sale did not go through.'), 'err'); }
  if (btn) btn.disabled = false;
}

// ---- local trade log for PnL: [{mint, side, sol, tokensRaw, sig, at, owner, solUsd, mode, jupFeeBps, route, savedSol, savedUsd}] ----
// Read back through cleanTrade(): the log can come from an imported file, so a row with a bad coin, side, amount or
// time is dropped and every number is a finite number (savedSol/savedUsd stay undefined when missing).
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const fin = (v) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) ? n : undefined; };
const nonNeg = (v) => { const n = fin(v); return n >= 0 ? n : undefined; };
function cleanTrade(t) {
  if (!t || typeof t !== 'object' || !isMint(t.mint) || (t.side !== 'buy' && t.side !== 'sell')) return null;
  const sol = nonNeg(t.sol), at = fin(t.at);
  if (sol == null || !(at > 0)) return null;
  return { mint: t.mint, side: t.side, sol, tokensRaw: nonNeg(t.tokensRaw) ?? 0, sig: typeof t.sig === 'string' && SIG_RE.test(t.sig) ? t.sig : '', at, owner: isMint(t.owner) ? t.owner : null, solUsd: nonNeg(t.solUsd) ?? 0, mode: t.mode === 'ultra' ? 'ultra' : 'swap', jupFeeBps: nonNeg(t.jupFeeBps) ?? 0, route: typeof t.route === 'string' ? t.route.slice(0, 120) : '', savedSol: nonNeg(t.savedSol), savedUsd: nonNeg(t.savedUsd) };
}
export const tradeLog = () => { const l = LS.get('trades', []); return Array.isArray(l) ? l.map(cleanTrade).filter(Boolean) : []; };
function logTrade(t) { const l = tradeLog(); l.unshift(t); LS.set('trades', l.slice(0, 2000)); }
// Fees saved: what a typical 1% terminal fee would have cost on every Nought trade logged in this browser.
export function feesSaved(owner) {
  let sol = 0, usdv = 0, trades = 0;
  for (const t of tradeLog()) {
    if (owner && t.owner !== owner) continue;
    const s = t.savedSol ?? t.sol * FEE_REF, u = t.savedUsd ?? s * (t.solUsd || solUsd() || 0);
    if (!Number.isFinite(s) || !Number.isFinite(u)) continue;
    sol += s; usdv += u; trades++;
  }
  return { sol, usd: usdv, trades, rate: FEE_REF };
}
