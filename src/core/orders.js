// Orders beyond a market trade:
//   limit  Jupiter Trigger v1 limit orders: on-chain (a PDA owned by your wallet), filled by Jupiter's keepers while you
//          are away. Nought passes no feeBps/feeAccount; Jupiter's keepers take Jupiter's own fee on fill (docs: 0.1%,
//          0.03% on stable pairs), shown as Jupiter's. Checked live 2026-10-04: minimum $5, expiredAt must be a string of
//          unix seconds, pump.fun mints (Token-2022, bonding curve or graduated) build fine, and the tx has a single
//          signer (the maker), so the wallet signs and sends it; /execute is optional and not used.
//   armed  orders kept in this browser and fired by this tab: buy/sell on migration, take-profit and stop-loss legs
//          (price checked every 2 s). They need a Nought tab open (needsTab), and an external wallet asks to approve.
// All Trigger calls share one lane at ≤0.5 requests/s (api.jup.ag's keyless limit). Emits 'orders' on any change.
import { LS, emit, on, toast, esc, short, sleep, isMint, usd } from './util.js';
import { settings } from './settings.js';
import { wallet, needWallet, signAndSend } from './wallet.js';
import { SOL_MINT, JUP, JUP_API, jfetch, txFromB64, quote, trade, sellPct, holding, settle, txLink, decimalsOf, rememberDecimals, mintDecimals, mintInfo, SIG_FEE, ATA_RENT, FEE_SLACK } from './trade.js';
import { tokens } from './store.js';
import { solUsd, pricesFor } from './price.js';
import { jp, jt, coolLeft } from './jup.js';

export const MIN_LIMIT_USD = 5;
export const NEEDS_TAB = 'Runs only while a Nought tab is open. An external wallet asks you to approve when it fires.';
const JSON_POST = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const labelOf = (mint) => (tokens.get(mint)?.symbol ? '$' + tokens.get(mint).symbol : short(mint));
const needOwner = (o) => { if (!isMint(o)) throw new Error('That is not a wallet address.'); return o; };
// what placing or cancelling a Trigger order may cost on top of the amount (wallet.js C3 expect.maxFeeLamports):
// Jupiter sets the priority fee ('auto'), so the slack covers it, plus rent for the order and up to two token accounts
const CREATE_FEE = SIG_FEE + FEE_SLACK + 3 * ATA_RENT, CANCEL_FEE = SIG_FEE + FEE_SLACK;
// the signed transaction's blockhash is only known for sure when Nought signs it (an extension may rebuild it)
const ownBlockhash = (tx, owner) => (wallet.kind === 'external' && owner === wallet.owner ? null : tx?.message?.recentBlockhash || null);
// sign + send; a send that may still land (wallet.js err.maybeSent) is followed by its signature, never sent again.
// → {status: 'ok'|'failed'|'unknown', sig, expired}; an expired transaction never landed, so it counts as failed.
async function sendAndSettle(tx, owner, expect) {
  let sig;
  try { sig = await signAndSend(tx, owner, expect); } catch (e) { if (!e?.maybeSent || !e.sig) throw e; sig = e.sig; }
  const st = await settle(sig, { blockhash: ownBlockhash(tx, owner) });
  return { sig, status: st.status === 'unknown' && st.expired ? 'failed' : st.status, expired: !!st.expired };
}
// a Trigger transaction must be paid by the maker (the only signer)
const payerIs = (tx, owner) => { if (tx.message.staticAccountKeys[0]?.toBase58() !== owner) throw new Error('Jupiter built this order for another wallet. Nothing was signed.'); return tx; };

// ---- prices, supply ----
// USD prices: Map(mint → usdPrice), from the first source that answers for each coin:
//   1. Jupiter Price v3 through jup.js (lite-api, then the keyless api.jup.ag while lite-api is limiting)
//   2. Dexscreener (price.js pricesFor, Jupiter skipped; skipped too while Dexscreener is cooling down)
//   3. the store: its USD price (t.price) or its market cap over the supply, whichever is fresher, and only when that
//      figure is at most maxAgeMs old (the token page's live trades and Jupiter lookups keep it fresh); an older
//      figure is never used, so a take-profit or stop-loss can't fire on a stale price.
// opts: {prio: 'high'|'normal'|'low' (jup.js queue priority), maxAgeMs (store figures, default 2 min), decs (a Map
// that receives the decimals Jupiter reported in this call)}
export async function usdPrices(mints, { prio = 'normal', maxAgeMs = 120000, decs } = {}) {
  const out = new Map(), list = [...new Set(mints || [])].filter(isMint);
  try { for (const [m, v] of await jp.prices(list, { prio })) { out.set(m, v.price); rememberDecimals(m, v.decimals); decs?.set(m, v.decimals); } } catch { /* next source */ }
  const rest = list.filter((m) => !out.has(m));
  if (rest.length && !coolLeft('api.dexscreener.com')) try { for (const [m, v] of await pricesFor(rest, { jupiter: false, prio })) if (v.priceUsd > 0) out.set(m, v.priceUsd); } catch { /* next source */ }
  for (const m of list) if (!out.has(m)) { const p = storePrice(m, maxAgeMs); if (p > 0) out.set(m, p); }
  return out;
}
// supply known for a coin: the store's (Jupiter's circulating, else total), else one read here (supplyOf). No guess:
// new launchpad coins come with 1B or 2B supplies, so an assumed 1B can be 2× off.
const supplies = new Map();
const knownSupply = (mint) => { const t = tokens.get(mint); return t?.circSupply > 0 ? t.circSupply : t?.totalSupply > 0 ? t.totalSupply : supplies.get(mint) || 0; };
// a price from the store: t.price (stamped priceAt by upsert), or the USD or SOL market cap over the supply, whichever
// figure is freshest; null when none is at most maxAgeMs old
export function storePrice(mint, maxAgeMs = 120000) {
  const t = tokens.get(mint); if (!t) return null;
  const now = Date.now(), fresh = (v, at) => v > 0 && at > 0 && now - at <= maxAgeMs;
  const supply = knownSupply(mint);
  const cands = [];
  if (fresh(t.price, t.priceAt)) cands.push({ px: t.price, at: t.priceAt });
  if (supply > 0 && fresh(t.mcUsd, t.mcUsdAt)) cands.push({ px: t.mcUsd / supply, at: t.mcUsdAt });
  if (supply > 0 && solUsd() > 0 && fresh(t.mcSol, t.mcSolAt)) cands.push({ px: (t.mcSol * solUsd()) / supply, at: t.mcSolAt });
  // the freshest; on a tie Jupiter's own price beats a market cap divided by a supply
  return cands.reduce((a, b) => (b.at > a.at ? b : a), cands[0] || { px: null }).px;
}
// supply for market-cap targets (Jupiter's mcap = usdPrice × circSupply): the store's, Jupiter's token search, then
// the mint account over RPC (cached); refuses when none answers rather than assuming one
async function supplyOf(mint) {
  const s = knownSupply(mint);
  if (s > 0) return s;
  try {
    const x = (await jt.search([mint], { prio: 'high' })).find((y) => y.mint === mint);
    const v = x?.circSupply > 0 ? x.circSupply : x?.totalSupply > 0 ? x.totalSupply : 0;
    if (v > 0) { supplies.set(mint, v); return v; }
  } catch { /* the chain next */ }
  try { const m = await mintInfo(mint); if (m.supply > 0) { supplies.set(mint, m.supply); return m.supply; } } catch { /* unknown */ }
  throw new Error('This coin\'s supply is unknown right now, so enter a price instead of a market cap.');
}
const toUsdPrice = async (mint, target, kind) => (kind === 'mc' ? Number(target) / (await supplyOf(mint)) : Number(target));

// ---- Trigger lane: request starts at least 2 s apart; callers get their answer as soon as it arrives. Each request
// also waits in jup.js's host queue: 'high' for creating/cancelling (the user is waiting), 'normal' for listing.
let lane = Promise.resolve(), lastAt = 0;
function trig(path, opt, prio = opt?.method === 'POST' ? 'high' : 'normal') {
  const run = lane.then(async () => {
    const wait = lastAt + 2000 - Date.now(); if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return jfetch('/trigger/v1/' + path, opt, 15000, [JUP_API, JUP], { prio });
  });
  lane = run.catch(() => {});
  return run;
}

// ---- limit orders (Trigger v1) ----
// Order rows from getTriggerOrders, normalised. Amount fields arrive as UI-unit strings; raw* are base units.
function normOrder(o) {
  const buy = o.inputMint === SOL_MINT, sell = o.outputMint === SOL_MINT, mint = buy ? o.outputMint : o.inputMint;
  const making = Number(o.makingAmount) || 0, taking = Number(o.takingAmount) || 0;
  const solUi = buy ? making : sell ? taking : null, tokensUi = buy ? taking : making;
  const rawMaking = Number(o.rawMakingAmount) || 0, rawLeft = Number(o.rawRemainingMakingAmount) || 0;
  const ts = (v) => (v == null || v === '' ? null : typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);
  const sigOf = (v) => (typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v) ? v : '');
  return {
    id: o.orderKey, side: buy ? 'buy' : sell ? 'sell' : 'swap', mint, inputMint: o.inputMint, outputMint: o.outputMint,
    solUi, tokensUi, priceSol: solUi != null && tokensUi ? solUi / tokensUi : null, // the order's fixed rate, SOL per token
    filledPct: rawMaking ? Math.max(0, (1 - rawLeft / rawMaking) * 100) : 0,
    status: typeof o.status === 'string' ? o.status.slice(0, 24) : '', createdAt: ts(o.createdAt), expiredAt: ts(o.expiredAt), openTx: sigOf(o.openTx), closeTx: sigOf(o.closeTx),
    trades: Array.isArray(o.trades) ? o.trades : [], raw: o,
  };
}
const listCache = new Map();
let known = null;            // ids of the wallet's open orders at the last check (engine notices fills)
const closedByUs = new Set(); // cancelled from this tab: no "an order closed" toast for these

export const limit = {
  // Build (never sign) a limit order. side 'buy' spends amountRaw lamports; 'sell' offers amountRaw token base units.
  // target is a USD price per token (targetKind 'price') or a USD market cap ('mc'). v1 triggers on the pool rate
  // (takingAmount / makingAmount), so the target is fixed in SOL at today's SOL price. decimals (optional): the
  // decimals the caller used to turn the typed amount into amountRaw; the build refuses if the coin's differ.
  // Returns {order, tx, requestId, expect, summary}.
  async build({ side, mint, amountRaw, target, targetKind = 'price', expiresInSec, owner = wallet.owner, decimals }) {
    if (!owner) throw new Error('Connect a wallet first.');
    needOwner(owner);
    if (!isMint(mint) || mint === SOL_MINT) throw new Error('That is not a coin address.');
    if (side !== 'buy' && side !== 'sell') throw new Error('Pick buy or sell.');
    let making; try { making = BigInt(amountRaw ?? 0); } catch { throw new Error('Enter an amount.'); }
    if (making <= 0n) throw new Error('Enter an amount.');
    if (expiresInSec != null && expiresInSec !== 0 && !(Number(expiresInSec) > 0 && Number(expiresInSec) <= 366 * 86400)) throw new Error('Pick an expiry of up to a year.');
    const decs = new Map(), px = await usdPrices([SOL_MINT, mint], { prio: 'high', decs }), solPx = px.get(SOL_MINT) || solUsd(), tokPx = px.get(mint);
    if (!(solPx > 0) || !(tokPx > 0)) throw new Error('No live price for this coin yet. Try again in a moment.');
    const priceUsd = await toUsdPrice(mint, target, targetKind);
    if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) throw new Error('Enter a target price or market cap.');
    if (side === 'buy' ? priceUsd >= tokPx : priceUsd <= tokPx) throw new Error(`A limit ${side} must be ${side === 'buy' ? 'below' : 'above'} the current price (${usd(tokPx)}), or it fills at once. Use a market ${side} instead.`);
    // decimals from the chain (or Jupiter's answer in this call; a sell reads the wallet's token account, which carries
    // them): a wrong guess here would ask for 1000× too few tokens and fill at once at a far worse price
    const h = side === 'sell' ? await holding(mint, owner) : null;
    if (h?.frozen) throw new Error('This coin is frozen in your wallet, so it cannot be sold.');
    if (h && h.raw < making) throw new Error('You hold less of this coin than that.');
    const dec = await mintDecimals(mint, side === 'sell' ? h.dec : decs.get(mint));
    if (decimals != null && Number(decimals) !== dec) throw new Error(`This coin has ${dec} decimals, not ${Number(decimals)}. Enter the amount again.`);
    let taking, makingUsd;
    if (side === 'buy') {
      const solIn = Number(making) / 1e9;
      taking = BigInt(Math.floor(((solIn * solPx) / priceUsd) * 10 ** dec)); makingUsd = solIn * solPx;
    } else {
      const tokIn = Number(making) / 10 ** dec;
      taking = BigInt(Math.ceil(((tokIn * priceUsd) / solPx) * 1e9)); makingUsd = tokIn * tokPx;
    }
    if (makingUsd < MIN_LIMIT_USD) throw new Error(`Jupiter's minimum for a limit order is $${MIN_LIMIT_USD} (this one is ${usd(makingUsd, 2)}).`);
    if (taking <= 0n) throw new Error('That target rounds to zero.');
    const params = { makingAmount: making.toString(), takingAmount: taking.toString() };
    if (expiresInSec > 0) params.expiredAt = String(Math.floor(Date.now() / 1000 + Number(expiresInSec))); // a string, or zod rejects it
    const [inputMint, outputMint] = side === 'buy' ? [SOL_MINT, mint] : [mint, SOL_MINT];
    const j = await trig('createOrder', JSON_POST({ inputMint, outputMint, maker: owner, payer: owner, params, computeUnitPrice: 'auto' }));
    if (!j.transaction) throw new Error(j.error || 'Jupiter did not return an order transaction.');
    return {
      order: j.order, requestId: j.requestId, tx: payerIs(txFromB64(j.transaction), owner),
      expect: { purpose: 'limit-create', spendMint: side === 'buy' ? 'SOL' : mint, maxSpendRaw: making.toString(), receiveMint: side === 'buy' ? mint : 'SOL', maxFeeLamports: CREATE_FEE },
      summary: { side, mint, owner, dec, payUi: side === 'buy' ? Number(making) / 1e9 : Number(making) / 10 ** dec, receiveUi: side === 'buy' ? Number(taking) / 10 ** dec : Number(taking) / 1e9, priceUsd, priceSol: priceUsd / solPx, nowUsd: tokPx, makingUsd, expiresAt: params.expiredAt ? Number(params.expiredAt) * 1000 : null,
        fees: [{ who: 'jupiter', label: 'Jupiter limit-order fee, taken on fill (Jupiter\'s, not Nought\'s)', bps: 10 }, { who: 'network', label: 'Network + priority fee to place it', note: 'set by Jupiter (computeUnitPrice auto)' }] },
    };
  },
  // sign + send a built order (show its summary first). Returns {order, sig, status: 'ok'|'failed'|'unknown'}
  async submit(b) {
    const owner = needOwner(b?.summary?.owner);
    if (!b.expect || !b.tx) throw new Error('Review the order again.');
    toast(`Approve the limit ${b.summary.side === 'buy' ? 'buy' : 'sell'} of ${esc(labelOf(b.summary.mint))} in your wallet…`);
    const { sig, status: r, expired } = await sendAndSettle(b.tx, owner, b.expect);
    listCache.clear(); known = null;
    emit('orders', { type: 'limit', action: 'create', order: b.order, sig, status: r });
    toast(r === 'ok' ? `Limit ${b.summary.side} placed. ${txLink(sig)}` : expired ? `The order did not land before it expired, so nothing was placed. ${txLink(sig)}` : r === 'failed' ? `The order failed on-chain. ${txLink(sig)}` : `Still confirming. Check your open orders before placing it again. ${txLink(sig)}`, r === 'ok' ? 'ok' : r === 'failed' ? 'err' : '');
    return { order: b.order, sig, status: r };
  },
  async create(spec) {
    if (!spec.owner && !wallet.owner && !needWallet()) return null;
    return limit.submit(await limit.build(spec));
  },
  // {orders: [normalised], page, totalPages, totalItems}; 10 per page. status 'active' | 'history'. Cached 15 s.
  async list({ status = 'active', owner = wallet.owner, page = 1, mint, force = false } = {}) {
    if (!owner) return { orders: [], page: 1, totalPages: 0, totalItems: 0 };
    needOwner(owner);
    status = status === 'history' ? 'history' : 'active'; page = Math.max(1, Math.min(1000, Math.floor(Number(page)) || 1));
    const key = `${owner}|${status}|${page}`, hit = listCache.get(key);
    let j = !force && hit && Date.now() - hit.at < 15000 ? hit.j : null;
    if (!j) { j = await trig('getTriggerOrders?' + new URLSearchParams({ user: owner, orderStatus: status, page: String(page) })); listCache.set(key, { j, at: Date.now() }); }
    const orders = (Array.isArray(j.orders) ? j.orders : []).filter((o) => o && isMint(o.orderKey) && isMint(o.inputMint) && isMint(o.outputMint)).map(normOrder).filter((o) => !mint || o.mint === mint);
    if (status === 'active' && page === 1 && owner === wallet.owner && !mint) known = new Set(orders.map((o) => o.id));
    return { orders, page: j.page || page, totalPages: j.totalPages || 0, totalItems: j.totalItems || 0 };
  },
  // cancel one order: Jupiter builds the tx, your wallet signs and sends. Returns true when confirmed.
  async cancel(orderKey, owner = wallet.owner) {
    if (!owner && !needWallet()) return false;
    needOwner(owner);
    if (!isMint(orderKey)) throw new Error('That is not an order address.');
    const j = await trig('cancelOrder', JSON_POST({ maker: owner, order: orderKey, computeUnitPrice: 'auto' }));
    if (!j.transaction) throw new Error(j.error || 'Jupiter could not build the cancel.');
    return finishCancel([j.transaction], owner, [orderKey]);
  },
  // cancel every open order of the wallet (Jupiter batches 5 per transaction; each one asks your wallet)
  async cancelAll(owner = wallet.owner) {
    if (!owner && !needWallet()) return false;
    needOwner(owner);
    const j = await trig('cancelOrders', JSON_POST({ maker: owner, computeUnitPrice: 'auto' }));
    if (!Array.isArray(j.transactions) || !j.transactions.length) throw new Error(j.error || 'No open orders to cancel.');
    return finishCancel(j.transactions, owner, [...(known || [])]);
  },
};
async function finishCancel(txs, owner, ids) {
  let ok = true;
  try {
    for (const t of txs) {
      const { sig, status: r, expired } = await sendAndSettle(payerIs(txFromB64(t), owner), owner, { purpose: 'limit-cancel', spendMint: 'SOL', maxSpendRaw: '0', maxFeeLamports: CANCEL_FEE });
      ok &&= r === 'ok';
      toast(r === 'ok' ? `Order cancelled. ${txLink(sig)}` : `The cancel ${expired ? 'did not land before it expired' : r === 'failed' ? 'failed' : 'is still confirming'}. ${txLink(sig)}`, r === 'ok' ? 'ok' : r === 'failed' ? 'err' : '');
    }
  } finally { listCache.clear(); }
  if (ok) ids.forEach((id) => closedByUs.add(id));
  emit('orders', { type: 'limit', action: 'cancel', orders: ids, ok });
  return ok;
}

// ---- armed orders (this browser, this tab) ----
// {id, kind, mint, owner, preset, created, status: 'armed'|'held'|'firing'|'done'|'failed'|'cancelled', needsTab: true,
//  sol (migrate-buy), pct (sells), triggerUsd + mc? (tp/sl), group? (tp/sl legs that cancel each other), heldBy?,
//  note, firedAt, doneAt}. 'held': another leg of its group is firing; it can't fire until that one ends, and is then
// cancelled (the other leg traded, or may have) or armed again (that leg provably did not trade).
const KINDS = ['migrate-buy', 'migrate-sell', 'tp', 'sl'];
const STATUSES = ['armed', 'held', 'firing', 'done', 'failed', 'cancelled'];
const KIND_LABEL = { 'migrate-buy': 'Buy on migration', 'migrate-sell': 'Sell on migration', tp: 'Take-profit', sl: 'Stop-loss' };
const MAX_SOL = 1000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// rows can come from another tab, an older version or an imported file: keep only well-formed ones
const okLeg = (a) => a && typeof a === 'object' && typeof a.id === 'string' && KINDS.includes(a.kind) && isMint(a.mint) && isMint(a.owner) && STATUSES.includes(a.status)
  && (a.kind === 'migrate-buy' ? finite(a.sol) && a.sol > 0 && a.sol <= MAX_SOL : finite(a.pct) && a.pct > 0 && a.pct <= 100)
  && (a.kind === 'tp' || a.kind === 'sl' ? finite(a.triggerUsd) && a.triggerUsd > 0 : true);
const load = () => { const l = LS.get('armed', []); return Array.isArray(l) ? l.filter(okLeg) : []; };
const save = (l) => {
  if (!LS.set('armed', l) || JSON.stringify(LS.get('armed', null)) !== JSON.stringify(l)) throw Object.assign(new Error('Browser storage is unavailable. Armed orders are paused before signing.'), { storage: true });
  emit('orders', { type: 'armed' });
};
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const lastPx = new Map();
const presetIdx = (p) => (Number.isInteger(p) && p >= 0 && p < settings.presets.length ? p : settings.preset);

// one validated leg, not saved yet
async function makeLeg({ kind, mint, sol, pct, price, mc, preset = settings.preset, group, owner = wallet.owner }) {
  if (!KINDS.includes(kind)) throw new Error('Unknown order type.');
  if (!isMint(mint)) throw new Error('That is not a coin address.');
  if (!owner) { needWallet(); throw new Error('Connect a wallet first.'); }
  needOwner(owner);
  const a = { id: rid(), kind, mint, owner, preset: presetIdx(preset), created: Date.now(), status: 'armed', needsTab: true };
  if (kind === 'migrate-buy') { const s = Number(sol); if (!(s > 0 && s <= MAX_SOL)) throw new Error(`Enter how much SOL to buy with (at most ${MAX_SOL}).`); a.sol = s; }
  else { const p = Number(pct); if (!(p > 0 && p <= 100)) throw new Error('Pick a share to sell, 1 to 100%.'); a.pct = p; }
  if (kind.startsWith('migrate') && tokens.get(mint)?.migrated) throw new Error('This coin has already migrated.');
  if (kind === 'tp' || kind === 'sl') {
    const trig = await toUsdPrice(mint, mc ?? price, mc != null ? 'mc' : 'price');
    if (!(trig > 0) || !Number.isFinite(trig)) throw new Error('Enter a trigger price or market cap.');
    const now = (await usdPrices([mint], { prio: 'high' })).get(mint);
    if (now && (kind === 'tp' ? trig <= now : trig >= now)) throw new Error(`A ${KIND_LABEL[kind].toLowerCase()} must be ${kind === 'tp' ? 'above' : 'below'} the current price (${usd(now)}).`);
    Object.assign(a, { triggerUsd: trig, ...(mc != null && { mc: Number(mc) }), ...(group && { group: String(group) }) });
  }
  return a;
}

export const armed = {
  KIND_LABEL,
  // spec: {kind, mint, sol (migrate-buy), pct (sells, 1-100), price | mc (USD, tp/sl), preset (index), group, owner}.
  // owner: the wallet that trades when it fires (default: the active wallet); one leg per wallet.
  async add(spec) {
    const a = await makeLeg(spec || {});
    const l = load(); l.push(a); save(l);
    return a;
  },
  // take-profit and stop-loss legs for one position of one wallet that cancel each other:
  // {pct, tp, sl, targetKind: 'price'|'mc', preset, owner}. Both legs are checked before either is saved.
  async bracket(mint, { pct = 100, tp, sl, targetKind = 'price', preset, owner = wallet.owner } = {}) {
    const group = rid(), k = targetKind === 'mc' ? 'mc' : 'price', legs = [];
    if (tp > 0) legs.push(await makeLeg({ kind: 'tp', mint, pct, [k]: tp, preset, group, owner }));
    if (sl > 0) legs.push(await makeLeg({ kind: 'sl', mint, pct, [k]: sl, preset, group, owner }));
    if (legs.length) { const l = load(); l.push(...legs); save(l); }
    return legs;
  },
  // every armed order (newest first), optionally for one coin; pass active:true for only the pending ones
  // ('armed', 'held' and 'firing'). Items carry owner (the wallet that trades) and lastUsd.
  list({ mint, active = false } = {}) {
    return load().filter((a) => (!mint || a.mint === mint) && (!active || a.status === 'armed' || a.status === 'held' || a.status === 'firing')).map((a) => ({ ...a, needsTab: true, lastUsd: lastPx.get(a.mint) ?? null })).reverse();
  },
  remove(id) { save(load().filter((a) => a.id !== id)); },
  clearFinished() { save(load().filter((a) => a.status === 'armed' || a.status === 'held' || a.status === 'firing')); },
  lastPrice: (mint) => lastPx.get(mint) ?? null,
};

// One tab fires each order, and one leg per bracket: a cross-tab Web Lock per group (or per order) held for the whole
// fire, then the stored status as the claim. Claiming puts the group's other legs on hold in the same write.
const firing = new Set();
const lockName = (a) => 'nought.armed.' + (a.group || a.id);
const withLock = (a, fn) => (globalThis.navigator?.locks ? navigator.locks.request(lockName(a), { ifAvailable: true }, (lock) => (lock ? fn() : null)) : Promise.reject(new Error('Armed orders need a secure browser with Web Locks to prevent duplicate trades across tabs.')));
function claim(id) {
  const l = load(), a = l.find((x) => x.id === id);
  if (!a || a.status !== 'armed' || firing.has(id)) return null;
  Object.assign(a, { status: 'firing', firedAt: Date.now() });
  if (a.group) for (const b of l) if (b.group === a.group && b.id !== a.id && b.status === 'armed') Object.assign(b, { status: 'held', heldBy: a.id });
  save(l); firing.add(id);
  return a;
}
// close a fire: the leg's own result, and its held legs either armed again (rearm) or cancelled with a note
function finish(a, result, others) {
  const l = load(), me = l.find((x) => x.id === a.id), now = Date.now();
  if (me) Object.assign(me, result, { doneAt: now });
  for (const b of l) {
    if (b.status !== 'held' || b.heldBy !== a.id) continue;
    delete b.heldBy;
    if (others.rearm) b.status = 'armed'; else Object.assign(b, { status: 'cancelled', doneAt: now, note: others.note });
  }
  save(l);
}
// errors that mean the wallet did not sign: a rejection in the extension, a vault left locked, the local pre-signing
// check (txcheck.js) refusing or unable to run
const notSigned = (e) => e?.code === 4001 || e?.refused === true || /user rejected|rejected the request|request rejected|declined|denied|cancell?ed|still locked|cannot sign|did not sign|before signing/i.test(String(e?.message || ''));
// wait for Jupiter to have a route (a migrated pool takes a few seconds to index). Only quotes are retried, never a
// signed trade, so a retry can't double-buy.
async function waitForRoute(a, budgetMs) {
  const [inM, outM] = a.kind === 'migrate-buy' ? [SOL_MINT, a.mint] : [a.mint, SOL_MINT];
  const amt = a.kind === 'migrate-buy' ? Math.round(a.sol * 1e9) : 10 ** decimalsOf(a.mint); // a probe: decimals only scale it
  const end = Date.now() + budgetMs;
  for (let i = 1; ; i++) {
    try { await quote(inM, outM, String(amt), 50); return; } catch (e) { if (Date.now() + i * 1500 > end) throw e; await sleep(i * 1500); }
  }
}
function fire(a, why) {
  return withLock(a, async () => {
    if (!claim(a.id)) return;
    const label = labelOf(a.mint), what = a.kind === 'migrate-buy' ? `buying ${a.sol} SOL of ${label}` : `selling ${a.pct}% of ${label}`;
    toast(`${KIND_LABEL[a.kind]} triggered (${esc(why)}): ${esc(what)}…`);
    let res = null, err = null;
    try {
      await waitForRoute(a, a.kind.startsWith('migrate') ? 30000 : 6000);
      const opts = { preset: a.preset, owner: a.owner, label, detail: true };
      res = a.kind === 'migrate-buy' ? await trade('buy', a.mint, BigInt(Math.round(a.sol * 1e9)), opts) : await sellPct(a.mint, a.pct, opts);
    } catch (e) { err = e; }
    try {
      const st = res?.status;
      if (!err && st === 'ok') finish(a, { status: 'done', note: '' }, { note: 'The other leg filled.' });
      // provably no trade: stopped before signing, the wallet did not sign, it failed on-chain, or it expired unlanded
      else if (err ? !err.signing || notSigned(err) : st === 'failed' || st === 'aborted') finish(a, { status: 'failed', note: err ? String(err.message || 'Failed.') : st === 'aborted' ? 'Stopped before signing.' : 'The trade failed or did not land. Nothing was traded.' }, { rearm: true });
      else finish(a, { status: 'failed', note: 'Could not confirm the trade. Check your wallet.' }, { note: 'The other leg may have traded. Check your wallet, then arm this again if you still need it.' });
    } finally { firing.delete(a.id); }
    if (err) toast(`${KIND_LABEL[a.kind]} for ${esc(label)} failed: ${esc(err.message || 'unknown error')}`, 'err');
  }).catch((e) => { if (!e.storage) toast(esc(e.message || 'This armed order could not run.'), 'err'); });
}

// ---- the engine: migration listener, TP/SL price checks every 2 s, and a once-a-minute look at open limit orders ----
let engine = null, ticking = false, lastTick = 0;
async function tick() {
  if (ticking) return;
  const legs = load().filter((a) => a.status === 'armed' && (a.kind === 'tp' || a.kind === 'sl'));
  if (!legs.length) return;
  // while lite-api is limiting, prices come from the small keyless budget: check every 6 s instead of every 2 s
  if (coolLeft('lite-api.jup.ag') > 0 && Date.now() - lastTick < 6000) return;
  ticking = true; lastTick = Date.now();
  try {
    const px = await usdPrices(legs.map((a) => a.mint), { maxAgeMs: 30000 }); // live sources, or a store figure ≤30 s old
    for (const a of legs) {
      const p = px.get(a.mint); if (!(p > 0)) continue;
      lastPx.set(a.mint, p);
      if (a.kind === 'tp' ? p >= a.triggerUsd : p <= a.triggerUsd) fire(a, `price ${usd(p)}`);
    }
  } finally { ticking = false; }
}
function onMigrate(t) {
  for (const a of load()) if (a.status === 'armed' && a.mint === t?.mint && a.kind.startsWith('migrate')) fire(a, 'migrated');
}
// open limit orders that vanished since the last look were filled, cancelled elsewhere or expired
async function watchLimits() {
  if (!wallet.owner || (known && !known.size)) return;
  const before = known;
  try {
    const { orders } = await limit.list({ force: true });
    const now = new Set(orders.map((o) => o.id));
    for (const id of before || []) if (!now.has(id) && !closedByUs.delete(id)) { emit('orders', { type: 'limit', action: 'closed', order: id }); toast(`A limit order closed (filled, cancelled or expired). <span class="mono">${esc(short(id))}</span>`); }
  } catch { /* try again next minute */ }
}
// A fire cut off by a closed tab can't be resumed safely: flag it so the user checks their wallet, and cancel the legs
// it held (it may have traded). Another tab still firing holds the group's lock, so its legs are left alone.
async function recoverInterrupted() {
  let held = null;
  try { const q = await globalThis.navigator?.locks?.query?.(); if (q) held = new Set((q.held || []).map((x) => x.name)); } catch { /* no lock list: go by age */ }
  const l = load(), now = Date.now(), live = (a) => (held ? held.has(lockName(a)) : now - (a.firedAt || 0) < 300000);
  let dirty = false;
  for (const a of l) if (a.status === 'firing' && !firing.has(a.id) && !live(a)) { Object.assign(a, { status: 'failed', doneAt: now, note: 'Interrupted: the tab closed while it fired. Check your wallet.' }); dirty = true; }
  for (const b of l) {
    if (b.status !== 'held' || l.some((a) => a.id === b.heldBy && a.status === 'firing') || (held ? held.has(lockName(b)) : false)) continue;
    delete b.heldBy; Object.assign(b, { status: 'cancelled', doneAt: now, note: 'The other leg was interrupted while it fired and may have traded. Check your wallet, then arm this again if you still need it.' }); dirty = true;
  }
  if (dirty) save(l);
}
// Start once at boot (idempotent). Returns a stop function.
export function startOrderEngine() {
  if (engine) return engine.stop;
  recoverInterrupted().catch(() => {});
  const timers = [setInterval(tick, 2000), setInterval(watchLimits, 60000)];
  const offs = [on('migrate', onMigrate), on('wallet', () => { known = null; listCache.clear(); watchLimits(); })];
  engine = { stop() { timers.forEach(clearInterval); offs.forEach((f) => f()); engine = null; } };
  watchLimits();
  return engine.stop;
}
