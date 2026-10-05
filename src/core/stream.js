// The live launch stream (PumpPortal's free websocket). One connection for the whole app with two subscriptions:
// new coins (pool 'pump' = pump.fun, 'bonk' = any Raydium LaunchLab launch) and migrations (pool 'pump-amm' |
// 'raydium-cpmm'). Messages without a signature are acks/notices and are ignored. Reconnects with backoff 1 s → 30 s.
// PumpPortal's per-coin and per-wallet trade subscriptions need a paid key now, so they are not used:
//   watchTrades(key, mints)    polls Jupiter's trade history (jx) every 3 s for up to 6 coins and emits the same
//                              'trade' events: {mint, side, sol, tokens, usd, mcUsd, mcSol, wallet, sig, at, pool, mev,
//                              tags, backfill} (backfill: from the first page, i.e. not live). Pass null to stop.
//   watchAccounts(key, wallets) is a no-op kept so callers don't break (wallet feeds belong on RPC logsSubscribe).
// Emits 'new-token' (token), 'migrate' (token), 'trade' and 'stream' (state).
import { emit, isMint } from './util.js';
import { tokens, upsert, curveProgress } from './store.js';
import { wantMeta, wantDex } from './meta.js';
import { jt, jx } from './jup.js';
import { solUsd } from './price.js';
import { TradeCursor } from './trade-cursor.js';

const LOW = { prio: 'low' }; // background polling: behind anything a user or a trade is waiting on (jup.js queues)

let ws = null, backoff = 1000, timer = 0;
export const state = { ok: false, lastMsg: 0, rate: 0 };
const hidden = () => typeof document !== 'undefined' && document.hidden;

export function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  clearTimeout(timer);
  try { ws = new WebSocket('wss://pumpportal.fun/api/data'); } catch { retry(); return; }
  ws.onopen = () => { state.ok = true; send({ method: 'subscribeNewToken' }); send({ method: 'subscribeMigration' }); emit('stream', state); };
  ws.onclose = () => { state.ok = false; emit('stream', state); retry(); };
  ws.onerror = () => ws.close();
  ws.onmessage = (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (!d?.signature || !isMint(d.mint)) return; // control message
    state.lastMsg = Date.now(); state.rate++; backoff = 1000; // a real event: the connection is healthy
    onEvent(d);
  };
}
function retry() { clearTimeout(timer); timer = setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2); }
const send = (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

const LAUNCHPAD = { pump: 'pump.fun', bonk: 'raydium-launchlab' }; // Jupiter's names; enrichment refines 'bonk' coins
const str = (x, max) => (typeof x === 'string' && x ? x.slice(0, max) : undefined);
const pos = (x) => (Number(x) > 0 && Number.isFinite(Number(x)) ? Number(x) : undefined);
function onEvent(d) {
  const now = Date.now();
  if (d.txType === 'create') {
    const bonding = pos(d.vTokensInBondingCurve) ? curveProgress(pos(d.vTokensInBondingCurve)) : undefined, pool = str(d.pool, 40);
    const t = upsert(d.mint, {
      name: str(d.name, 80), symbol: str(d.symbol, 24), uri: str(d.uri, 500), created: tokens.get(d.mint)?.created || now,
      mcSol: pos(d.marketCapSol), progress: bonding, dev: isMint(d.traderPublicKey) ? d.traderPublicKey : undefined,
      launchpad: (pool && Object.hasOwn(LAUNCHPAD, pool) ? LAUNCHPAD[pool] : pool) || 'pump.fun', pulseCol: 'new', pulseAt: now, fresh: true,
    });
    if (pos(d.solAmount)) { t.buys = (t.buys || 0) + 1; t.devBuySol = pos(d.solAmount); if (isMint(d.traderPublicKey)) t.traders?.add(d.traderPublicKey); }
    emit('new-token', t); // let the visible board request priority metadata first
    if (t.uri) wantMeta(t);
    if (!t.symbol) enrich(d.mint); // LaunchLab ('bonk') creates carry no name, symbol or uri
  } else if (d.txType === 'migrate' || (d.pool && !d.txType)) {
    const t = upsert(d.mint, { migrated: true, migratedAt: now, progress: 1, pulseCol: 'migrated', pulseAt: now, fresh: true });
    enrich(d.mint); // rehydrate: new pool, liquidity, market cap
    emit('migrate', t);
  }
}

// Jupiter lookups for coins the stream only named by mint (batched; Jupiter indexes new coins within seconds)
const enrichQ = new Map(); let enriching = false; // mint → tries
const enrich = (mint) => { if (!enrichQ.has(mint)) enrichQ.set(mint, 0); if (enrichQ.size > 300) enrichQ.delete(enrichQ.keys().next().value); };
setInterval(async () => {
  if (hidden() || enriching || !enrichQ.size) return;
  enriching = true;
  const batch = [...enrichQ.keys()].slice(0, 50), found = new Set();
  try { for (const t of await jt.search(batch, LOW)) { found.add(t.mint); if (tokens.has(t.mint)) upsert(t.mint, t); } } catch { /* retry next round */ }
  for (const m of batch) {
    if (!enrichQ.has(m)) continue;
    const n = enrichQ.get(m) + 1;
    if (found.has(m)) enrichQ.delete(m);
    else if (n >= 6) { enrichQ.delete(m); wantDex(m); } // not on Jupiter after ~30 s: ask Dexscreener
    else enrichQ.set(m, n);
  }
  enriching = false;
}, 5000);

// ---- trade polling (stand-in for the key-gated trade subscriptions) ----
const watched = new Map(), cursors = new Map(), tradeStates = new Map();
export const tradeState = (mint) => tradeStates.get(mint) || { catchingUp: false, error: '' };
export function watchTrades(key, mints) {
  const before = new Set(watchedMints()), list = (mints || []).filter(isMint);
  list.length ? watched.set(key, list) : watched.delete(key);
  const current = watchedMints();
  for (const m of cursors.keys()) if (!current.includes(m)) { cursors.delete(m); tradeStates.delete(m); }
  if (!hidden()) for (const m of current) if (!before.has(m)) pollTrades(m);
}
export function watchAccounts() { /* no-op: PumpPortal account trades need a paid key (see the note at the top) */ }
export const watchedMints = () => [...new Set([...watched.values()].flat())].slice(0, 6);

async function pollTrades(mint) {
  let cursor = cursors.get(mint);
  if (!cursor) { cursor = new TradeCursor(); cursors.set(mint, cursor); }
  if (cursor.busy) return;
  const active = () => cursors.get(mint) === cursor && watchedMints().includes(mint);
  let result;
  try {
    result = await cursor.poll((offset) => jx.txs(mint, { ...LOW, offset }), active);
    if (!active()) return;
    tradeStates.set(mint, { catchingUp: result.catchingUp, error: '', at: Date.now() });
  } catch (e) { if (active()) tradeStates.set(mint, { catchingUp: true, error: e.message }); return; }
  const fresh = result.txs, first = result.backfill;
  if (!fresh.length) return;
  const t = tokens.get(mint), supply = t?.circSupply || 1e9, sUsd = solUsd();
  for (const x of fresh) {
    const mc = x.priceUsd * supply;
    if (t) { t.lastTrade = Math.max(t.lastTrade || 0, x.at); if (t.traders?.size < 5000) t.traders.add(x.wallet); if (x.side === 'sell' && t.dev && x.wallet === t.dev) t.devSold = true; }
    emit('trade', { id: x.id, mint, side: x.side, sol: x.sol, tokens: x.tokens, usd: x.usd, mcUsd: mc, mcSol: sUsd > 0 ? mc / sUsd : 0, wallet: x.wallet, sig: x.sig, at: x.at, pool: x.pool, mev: x.mev, tags: x.tags, backfill: first || undefined });
  }
  const last = fresh[fresh.length - 1];
  if (t && last.priceUsd > 0) upsert(mint, { price: last.priceUsd, mcUsd: last.priceUsd * supply });
}
setInterval(() => {
  if (hidden()) return;
  const mints = watchedMints();
  mints.forEach(pollTrades);
}, 5500);
