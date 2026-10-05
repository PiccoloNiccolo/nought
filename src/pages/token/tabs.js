// Token page bottom tabs: Trades, Positions, Orders, Holders, Top traders, Dev tokens.
// mountTabs(el, ctx) → cleanup. ctx = { mint, token(), pair(), on(evt, fn), refresh(), openScan(wallet), chart: {addMarkers, setLines} }.
// This file also holds the small helpers audit.js and scan.js share (trade-history caches, holders cache, wallet labels,
// tracked wallets, per-wallet stats), so all three read one copy of each Jupiter answer.
// Chart: the chart module already draws your fills, the dev's trades and your order lines; the tabs add only tracked
// wallets' and KOLs' trades, as the marker group 'tracked-wallets'.
// Data: jx.txs (trades, 30 a page, newest first), jh.holders (top 100), ju.balances, orders.js, the local trade log.
// Cadence (feature-matrix §16): trades 3 s, holders 15 s, positions 20 s, orders on 'orders' events (and once a minute);
// nothing polls while the browser tab is hidden. Top traders reads at most 150 pages at ≤3 requests a second, stoppable.
import { esc, isMint, short, usd, num, pct, cls, ago, LS, toast, sleep, on, emit, ICON } from '../../core/util.js';
import { tokens, mcUsd, all } from '../../core/store.js';
import { jx, jh, ju } from '../../core/jup.js';
import { wallet, needWallet } from '../../core/wallet.js';
import * as V from '../../core/vault.js';
import { solUsd } from '../../core/price.js';
import { watchedMints, tradeState } from '../../core/stream.js';
import { TradeCursor } from '../../core/trade-cursor.js';
import { preset, PRIO } from '../../core/settings.js';
import { sellPct, tradeLog, decimalsOf } from '../../core/trade.js';
import { limit, armed, NEEDS_TAB } from '../../core/orders.js';
import { maybeLanded } from '../../ui/instant.js';

// ============================================================================================================
// shared helpers (audit.js and scan.js import these)
// ============================================================================================================
export const EXT = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export const solscanTx = (sig) => 'https://solscan.io/tx/' + encodeURIComponent(sig);
export const solscanAcct = (a) => 'https://solscan.io/account/' + encodeURIComponent(a);
export const hidden = () => typeof document !== 'undefined' && document.hidden;
export const subscribe = (ctx, evt, fn) => { try { return (ctx.on || on)(evt, fn) || (() => {}); } catch { return () => {}; } };

// SOL amounts: more decimals as they shrink
export function fmtSol(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  return a === 0 ? '0' : a >= 100 ? n.toFixed(1) : a >= 1 ? n.toFixed(2) : a >= 0.01 ? n.toFixed(3) : n.toFixed(4);
}
export const fmtUsdS = (n) => (n == null || !isFinite(n) ? '—' : (n > 0 ? '+' : '') + usd(n));
export const fmtSolS = (n) => (n == null || !isFinite(n) ? '—' : (n > 0 ? '+' : '') + fmtSol(n));
// tiny prices with a subscript zero count: 0.00000299 → $0.0₅299
const SUB = '₀₁₂₃₄₅₆₇₈₉';
export function fmtPx(p) {
  if (!(p > 0) || !isFinite(p)) return '—';
  if (p >= 1) return '$' + p.toFixed(p >= 100 ? 2 : 4);
  const zeros = -Math.floor(Math.log10(p)) - 1;
  if (zeros < 4) return '$' + p.toPrecision(3);
  const digits = String(Math.round(p * 10 ** (zeros + 3))).slice(0, 3);
  return '$0.0' + String(zeros).split('').map((d) => SUB[d]).join('') + digits;
}
export function dur(ms) {
  if (!(ms >= 0)) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s < 86400 ? Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm' : Math.floor(s / 86400) + 'd ' + Math.floor((s % 86400) / 3600) + 'h';
}
export const plural = (n, w) => `${int(n)} ${w}${Number(n) === 1 ? '' : 's'}`;
export const int = (n) => (n == null || !isFinite(n) ? '—' : Math.abs(n) >= 10000 ? num(n) : String(Math.round(n)));
export const tokOf = (ctx) => ctx.token?.() || tokens.get(ctx.mint) || { mint: ctx.mint };
export const symOf = (ctx) => tokOf(ctx).symbol || ctx.pair?.()?.baseToken?.symbol || short(ctx.mint);
// circulating supply: Jupiter's, else Dexscreener's fdv / price, else pump.fun's 1B
export function supplyOf(ctx) {
  const t = tokOf(ctx), p = ctx.pair?.();
  if (t.circSupply > 0) return t.circSupply;
  if (t.totalSupply > 0) return t.totalSupply;
  if (p?.fdv > 0 && Number(p.priceUsd) > 0) return p.fdv / Number(p.priceUsd);
  return 1e9;
}
// USD per token right now
export function priceOf(ctx) {
  const t = tokOf(ctx), p = ctx.pair?.();
  if (t.price > 0 && (t.mcUsdAt || 0) >= (t.mcSolAt || 0)) return t.price;
  const mc = mcUsd(t); if (mc > 0) return mc / supplyOf(ctx);
  if (Number(p?.priceUsd) > 0) return Number(p.priceUsd);
  return t.price > 0 ? t.price : 0;
}

// ---- your wallets: the active one, the selected local ones and every local wallet in this browser ----
let vaultAddrs = [], vaultAt = 0;
export function refreshVault(force = false) {
  if (!force && Date.now() - vaultAt < 30000) return Promise.resolve(vaultAddrs);
  vaultAt = Date.now();
  return V.list().then((l) => (vaultAddrs = l.map((w) => w.address).filter(isMint))).catch(() => vaultAddrs);
}
export const myWallets = () => new Set([wallet.owner, ...(wallet.selected || []), ...vaultAddrs].filter(isMint));
// wallets a position is shown for: the active wallet plus the selected local wallets (at most 6)
export const positionOwners = () => [...new Set([wallet.owner, ...(wallet.selected || [])].filter(isMint))].slice(0, 6);

// ---- KOL list (data/kol-wallets.json, optional): [{address, name, twitter?, tags?}], {wallets: [...]} or {address: name} ----
let kolP = null, KOL = new Map();
export function loadKols() {
  return (kolP ||= fetch(new URL('../../../data/kol-wallets.json', import.meta.url), { cache: 'force-cache' })
    .then((r) => (r.ok ? r.json() : []))
    .then((j) => {
      const m = new Map(), list = Array.isArray(j) ? j : Array.isArray(j?.wallets) ? j.wallets : j && typeof j === 'object' ? Object.entries(j).map(([address, v]) => (typeof v === 'string' ? { address, name: v } : { address, ...v })) : [];
      for (const k of list) { const a = k?.address || k?.wallet; if (isMint(a)) m.set(a, { name: String(k.name || k.handle || k.twitter || 'KOL').slice(0, 24), x: String(k.twitter || k.x || k.handle || '').replace(/^@/, '').replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, '').slice(0, 30) }); }
      return (KOL = m);
    })
    .catch(() => KOL));
}
export const kolOf = (w) => KOL.get(w) || null;

// ---- tracked wallets. The trackers page owns the list (localStorage 'tracked': [{address, name, emoji, group, alert,
// sound, feed}]); read it defensively (older or other keys too) and add to it in the same shape. ----
const TRACK_KEYS = ['tracked', 'track.wallets', 'trackers', 'track', 'tracker.wallets', 'wallets.tracked'];
let trackCache = null, trackAt = 0;
function readTrackList() {
  for (const k of TRACK_KEYS) {
    const v = LS.get(k, null);
    if (v == null) continue;
    const list = Array.isArray(v) ? v : Array.isArray(v?.wallets) ? v.wallets : Array.isArray(v?.list) ? v.list : v && typeof v === 'object' ? Object.entries(v).map(([address, x]) => (x && typeof x === 'object' ? { address, ...x } : { address, name: typeof x === 'string' ? x : '' })) : null;
    if (list) return { key: k, raw: v, list };
  }
  return { key: null, raw: null, list: [] };
}
export function trackedWallets() {
  if (trackCache && Date.now() - trackAt < 2000) return trackCache;
  const m = new Map();
  for (const x of readTrackList().list) {
    const a = typeof x === 'string' ? x : x?.address || x?.wallet || x?.addr;
    if (isMint(a)) m.set(a, { name: x && typeof x === 'object' ? String(x.name || x.label || '').slice(0, 24) : '', emoji: x && typeof x === 'object' ? String(x.emoji || '').slice(0, 4) : '' });
  }
  trackAt = Date.now();
  return (trackCache = m);
}
export const trackedOf = (w) => trackedWallets().get(w) || null;
export const forgetTracked = () => { trackCache = null; };
// add a wallet to the trackers' list (same key and entry shape as what is already stored)
export function trackWallet(address, name = '') {
  if (!isMint(address)) return false;
  if (trackedOf(address)) { toast('Already tracked: <span class="mono">' + esc(short(address)) + '</span>'); return true; }
  const { key, raw, list } = readTrackList();
  const entry = { address, name: String(name || short(address)).slice(0, 40), emoji: '', group: 'Token page', alert: false, sound: false, feed: true };
  if (!key) LS.set('tracked', [entry]);
  else if (Array.isArray(raw)) LS.set(key, [...raw, typeof list[0] === 'string' ? address : entry]);
  else if (Array.isArray(raw?.wallets)) LS.set(key, { ...raw, wallets: [...raw.wallets, entry] });
  else if (Array.isArray(raw?.list)) LS.set(key, { ...raw, list: [...raw.list, entry] });
  else LS.set(key, { ...raw, [address]: entry });
  trackCache = null;
  if (!trackedOf(address)) { toast('Could not save the tracked wallet (storage is off).', 'err'); return false; }
  emit('tracked', readTrackList().list);
  toast('Tracking <span class="mono">' + esc(short(address)) + '</span>. Manage it on the Trackers page.', 'ok');
  return true;
}

// ---- wallet badges: dev, you, KOL, tracked, Jupiter's holder tags and labels ----
const TAGS = { sniper: 'sniper', insider: 'insider', bundler: 'bundler', bot: 'bot' };
export function badges(w, ctx, tags = [], labels = []) {
  const t = tokOf(ctx), out = [];
  if (t.dev && w === t.dev) out.push('<span class="tt-b dev" title="Created this coin">dev</span>');
  if (myWallets().has(w)) out.push('<span class="tt-b you" title="Your wallet">you</span>');
  const k = kolOf(w); if (k) out.push(`<span class="tt-b kol" title="KOL${k.x ? ' @' + esc(k.x) : ''}">${esc(k.name)}</span>`);
  const tr = trackedOf(w); if (tr) out.push(`<span class="tt-b trk" title="Tracked wallet">${esc(tr.emoji || '★')}${tr.name ? ' ' + esc(tr.name) : ''}</span>`);
  for (const g of tags || []) { const key = String(g).toLowerCase(); out.push(`<span class="tt-b tag${TAGS[key] ? ' g-' + TAGS[key] : ''}">${esc(String(g).slice(0, 14))}</span>`); }
  for (const l of labels || []) if (l?.name || l?.id) out.push(`<span class="tt-b lbl" title="${esc(l.name || l.id)}">${esc(String(l.id === 'Pool' ? 'pool' : l.name || l.id).slice(0, 18))}</span>`);
  return out.join('');
}
export const isPool = (h) => (h.labels || []).some((l) => /pool|amm|curve|vault/i.test(l.id + ' ' + l.name));

// ---- trade history caches, one per (mint) and per (mint, trader). Newest first, deduped. ----
// Shared by the Trades and Top traders tabs, the bundle checker and the trader scan.
const HIST = new Map(), HISTORY_CAP = 6000;
export const keyOf = (x) => `${x.sig}|${x.wallet}|${x.side}|${Math.round((x.tokens || 0) * 1000)}`;
export const byNewest = (a, b) => b.at - a.at || (String(b.id).length - String(a.id).length) || (String(b.id) < String(a.id) ? -1 : String(b.id) > String(a.id) ? 1 : 0);
export function hist(mint, trader = '') {
  const k = mint + '|' + (trader || '');
  let h = HIST.get(k);
  if (!h) {
    h = { mint, trader, txs: [], keys: new Set(), next: undefined, done: false, pages: 0, busy: null, err: '', ver: 0, at: 0 };
    HIST.set(k, h);
    if (HIST.size > 40) for (const [kk, hh] of HIST) { if (hh !== h && !hh.busy) { HIST.delete(kk); break; } }
  }
  return h;
}
export const histIf = (mint, trader = '') => HIST.get(mint + '|' + (trader || '')) || null;
// add trades to a cache (from a page or a 'trade' event); returns how many were new
export function addTxs(h, list) {
  let n = 0;
  for (const x of list) { const k = keyOf(x); if (h.keys.has(k)) continue; h.keys.add(k); h.txs.push(x); n++; }
  if (n) {
    h.txs.sort(byNewest);
    if (h.txs.length > HISTORY_CAP) { h.txs.length = HISTORY_CAP; h.keys = new Set(h.txs.map(keyOf)); h.capped = true; h.done = false; }
    h.ver++;
  }
  return n;
}
// a 'trade' event as a Tx
export function evToTx(d) {
  return { id: d.id || 'ev:' + d.sig, sig: d.sig, mint: d.mint, side: d.side, wallet: d.wallet, tokens: d.tokens || 0, sol: d.sol || 0, usd: d.usd || 0, priceUsd: d.tokens > 0 && d.usd > 0 ? d.usd / d.tokens : 0, mc: d.mcUsd || 0, at: d.at || Date.now(), pool: d.pool, mev: !!d.mev, tags: d.tags || [] };
}
// the next (older) page
export function loadOlder(h) {
  if (h.busy) return h.busy;
  if (h.done || h.capped) return Promise.resolve(0);
  h.busy = jx.txs(h.mint, { trader: h.trader || undefined, offset: h.next || undefined })
    .then((p) => { const n = addTxs(h, p.txs); h.next = p.next; h.done = !p.next && !h.capped; h.pages++; h.err = ''; h.at = Date.now(); h.ver++; return n; })
    .catch((e) => { h.err = e.message || 'Could not load trades.'; h.ver++; return 0; })
    .finally(() => { h.busy = null; });
  return h.busy;
}
// the newest page again: picks up trades since the last look
export async function refreshHead(h) {
  if (h.next === undefined) return loadOlder(h);
  if (h.headBusy) return h.headBusy;
  if (!h.cursor) { h.cursor = new TradeCursor(); h.cursor.started = h.txs.length > 0; h.cursor.seen = new Set(h.txs.map((x) => x.id)); }
  h.headBusy = (async () => {
  try {
    const p = await h.cursor.poll((offset) => jx.txs(h.mint, { trader: h.trader || undefined, offset, prio: 'low' }));
    h.err = p.catchingUp ? 'Catching up with recent trades…' : ''; h.at = Date.now();
    return addTxs(h, p.txs);
  } catch (e) { h.err = e.message || 'Could not load trades.'; return 0; }
  })().finally(() => { h.headBusy = null; });
  return h.headBusy;
}
// read older pages until maxPages are loaded, the history ends or stop() says so; at most rps requests a second and
// paused while the browser tab is hidden. progress(h) after each page.
export async function scanHistory(h, { maxPages = 150, rps = 3, stop = () => false, progress = () => {} } = {}) {
  const gap = Math.ceil(1000 / rps);
  let fails = 0;
  while (!h.done && !h.capped && h.pages < maxPages && !stop()) {
    if (hidden()) { await sleep(1000); continue; }
    const t0 = Date.now(), before = h.pages;
    await loadOlder(h);
    progress(h);
    if (h.pages === before) { if (++fails >= 3) break; await sleep(2500 * fails); continue; }
    fails = 0;
    const wait = gap - (Date.now() - t0); if (wait > 0) await sleep(wait);
  }
  return h;
}

// ---- holders, shared by the Holders tab, the audit grid and the trader scan (refreshed at most every 15 s) ----
const HOLD = new Map();
export function holdersOf(mint, maxAge = 15000) {
  const c = HOLD.get(mint);
  if (c && (c.busy || Date.now() - c.at < maxAge)) return c.busy || (c.data ? Promise.resolve(c.data) : Promise.reject(new Error(c.err || 'Holders did not load.')));
  const e = c || { at: 0, data: null, busy: null, err: '' }; HOLD.set(mint, e);
  e.busy = jh.holders(mint).then((d) => { e.data = d; e.at = Date.now(); e.err = ''; return d; })
    .catch((err) => { e.err = err.message || 'Could not load holders.'; e.at = Date.now() - maxAge + 5000; if (e.data) return e.data; throw err; })
    .finally(() => { e.busy = null; });
  if (HOLD.size > 12) HOLD.delete(HOLD.keys().next().value);
  return e.busy;
}
export const holdersState = (mint) => HOLD.get(mint) || null;
export const holdersCached = (mint) => HOLD.get(mint)?.data || null;
export const forgetHolders = (mint) => HOLD.delete(mint);

// ---- per-wallet numbers from its trades in one coin ----
// {buys, sells, bTok, sTok, bSol, sSol, bUsd, sUsd, first, last, trips[], medianHold, openSince, partial}
export function statsOf(txs) {
  const s = { buys: 0, sells: 0, bTok: 0, sTok: 0, bSol: 0, sSol: 0, bUsd: 0, sUsd: 0, first: 0, last: 0, trips: [], medianHold: null, openSince: null, partial: false };
  const asc = [...txs].sort((a, b) => a.at - b.at);
  let pos = 0, peak = 0, start = null;
  for (const x of asc) {
    s.first ||= x.at; s.last = x.at;
    if (x.side === 'buy') {
      s.buys++; s.bTok += x.tokens; s.bSol += x.sol; s.bUsd += x.usd;
      if (start == null || pos <= peak * 0.01) { start = x.at; peak = 0; pos = Math.max(0, pos); }
      pos += x.tokens; peak = Math.max(peak, pos);
    } else {
      s.sells++; s.sTok += x.tokens; s.sSol += x.sol; s.sUsd += x.usd;
      pos -= x.tokens;
      if (start == null) s.partial = true;
      else if (pos <= peak * 0.01) { s.trips.push(x.at - start); start = null; pos = Math.max(0, pos); peak = 0; }
    }
  }
  if (s.sTok > s.bTok * 1.001) s.partial = true;
  if (start != null && pos > peak * 0.01) s.openSince = start;
  if (s.trips.length) { const t = [...s.trips].sort((a, b) => a - b), m = t.length >> 1; s.medianHold = t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2; }
  return s;
}
// PnL from stats, a holding (tokens) and a price (USD/token). Cost basis: the average buy cost.
export function pnlOf(s, holdTok, px, sUsdNow = solUsd()) {
  const avgUsd = s.bTok > 0 ? s.bUsd / s.bTok : 0, avgSol = s.bTok > 0 ? s.bSol / s.bTok : 0;
  const soldCovered = Math.min(s.sTok, s.bTok);
  const soldShare = s.sTok > 0 ? soldCovered / s.sTok : 0; // proceeds from tokens with a known cost
  const realizedUsd = s.sUsd * soldShare - avgUsd * soldCovered, realizedSol = s.sSol * soldShare - avgSol * soldCovered;
  // only tokens with a known cost (bought, not yet sold) count toward unrealized PnL; transfers in have no cost basis
  const hold = Math.max(0, Math.min(holdTok || 0, s.bTok - soldCovered)), valueUsd = Math.max(0, holdTok || 0) * (px || 0), valueSol = sUsdNow > 0 ? valueUsd / sUsdNow : 0;
  const costLeftUsd = avgUsd * hold, costLeftSol = avgSol * hold;
  const unrealUsd = hold * (px || 0) - costLeftUsd, unrealSol = (sUsdNow > 0 ? (hold * (px || 0)) / sUsdNow : 0) - costLeftSol;
  const totalUsd = realizedUsd + unrealUsd;
  return { avgUsd, avgSol, realizedUsd, realizedSol, unrealUsd, unrealSol, valueUsd, valueSol, totalUsd: s.bTok > 0 ? totalUsd : null, totalSol: s.bTok > 0 ? realizedSol + unrealSol : null, totalPct: s.bUsd > 0 ? (totalUsd / s.bUsd) * 100 : null, known: s.bTok > 0 };
}
// behaviour (feature matrix §5): accumulating = net buyer with no sells; distributing = sold more than 50% of what it
// bought; scalping = 3+ round trips with a median hold under 5 minutes
export function behaviour(s) {
  if (s.trips.length >= 3 && s.medianHold != null && s.medianHold < 300e3) return { key: 'scalp', label: 'Scalping', note: `${s.trips.length} round trips, median hold ${dur(s.medianHold)}` };
  if (s.buys > 0 && s.sells === 0) return { key: 'acc', label: 'Accumulating', note: 'Bought and has not sold' };
  if (s.bTok > 0 && s.sTok > s.bTok * 0.5) return { key: 'dist', label: 'Distributing', note: `Sold ${Math.min(100, (s.sTok / s.bTok) * 100).toFixed(0)}% of what it bought` };
  if (!s.buys && s.sells) return { key: 'dist', label: 'Distributing', note: 'Only sells here (got the tokens another way)' };
  if (!s.buys && !s.sells) return { key: 'none', label: 'No trades', note: 'No trades in this coin' };
  return { key: 'mixed', label: 'Holding', note: 'Bought, sold less than half' };
}

// the message sits in a box pinned to the visible part of a table that scrolls sideways (phones)
const emptyRow = (cols, text, cl = '') => `<tr class="tt-empty"><td colspan="${cols}" class="${cl}"><div class="tt-e">${text}</div></td></tr>`;
const loadingRow = (cols, text = 'Loading…') => emptyRow(cols, `<span class="tt-spin"></span>${esc(text)}`);

// ============================================================================================================
// the tabs
// ============================================================================================================
const TABS = [['trades', 'Trades'], ['positions', 'Positions'], ['orders', 'Orders'], ['holders', 'Holders'], ['top', 'Top traders'], ['dev', 'Dev tokens']];

export function mountTabs(el, ctx) {
  const mint = ctx.mint, offs = [], timers = [];
  const saved = LS.get('tt', {}) || {};
  const S = {
    tab: TABS.some(([k]) => k === saved.tab) ? saved.tab : 'trades',
    alive: true, pressing: false, dirty: false,
    trades: { mode: 'all', wallet: '', minSol: Number(saved.minSol) > 0 ? Number(saved.minSol) : 0, unit: saved.unit === 'usd' ? 'usd' : 'sol', shown: 100, lastPoll: 0 },
    holders: { hidePool: saved.hidePool !== false, lastPoll: 0 },
    positions: { data: null, err: '', busy: false, lastPoll: 0, confirm: null, selling: false },
    orders: { status: 'active', data: null, err: '', busy: false, confirm: null, cancelling: false, lastPoll: 0 },
    top: { stopped: false, running: false, sort: 'pnl', lastAgg: 0, rows: null, ver: -1 },
    dev: { busy: false, err: '' },
    marked: new Map(), markedSent: false,
  };
  const persist = () => LS.set('tt', { tab: S.tab, minSol: S.trades.minSol, unit: S.trades.unit, hidePool: S.holders.hidePool });
  const all_ = () => hist(mint);

  el.innerHTML = `<div class="tt tt-tabs">
    <div class="tt-bar hfade" role="tablist" aria-label="Coin activity">${TABS.map(([k, l]) => `<button role="tab" data-ttab="${k}" class="${k === S.tab ? 'on' : ''}">${l}<span class="tt-n" data-n="${k}"></span></button>`).join('')}</div>
    <div class="tt-tool"></div>
    <div class="tt-body"></div>
  </div>`;
  const root = el.querySelector('.tt-tabs'), tool = root.querySelector('.tt-tool'), body = root.querySelector('.tt-body');
  const setN = (k, v) => { const n = root.querySelector(`[data-n="${k}"]`); if (n) n.textContent = v ? String(v) : ''; };

  loadKols().then(() => S.alive && renderBody());
  refreshVault(true).then(() => S.alive && renderBody());

  // ---------------------------------------------------------------- Trades
  function traderHists() {
    const t = tokOf(ctx), m = S.trades.mode;
    if (m === 'dev') return t.dev ? [hist(mint, t.dev)] : [];
    if (m === 'you') return [...myWallets()].slice(0, 6).map((w) => hist(mint, w));
    if (m === 'wallet') return isMint(S.trades.wallet) ? [hist(mint, S.trades.wallet)] : [];
    return [all_()];
  }
  function tradeRows() {
    const hs = traderHists(), m = S.trades.mode;
    let rows = hs.length === 1 ? hs[0].txs : hs.flatMap((h) => h.txs).sort(byNewest);
    if (m === 'tracked') { const tr = trackedWallets(); rows = rows.filter((x) => tr.has(x.wallet)); }
    if (S.trades.minSol > 0) rows = rows.filter((x) => x.sol >= S.trades.minSol);
    return rows;
  }
  function tradesTool() {
    const t = S.trades, modes = [['all', 'All'], ['dev', 'Dev'], ['you', 'You'], ['tracked', 'Tracked']];
    return `<div class="tt-seg">${modes.map(([k, l]) => `<button data-tmode="${k}" class="${t.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <label class="tt-in wide" title="Show one wallet's trades in this coin"><span>Wallet</span><input data-twallet placeholder="Paste an address" spellcheck="false" autocomplete="off" value="${esc(t.mode === 'wallet' ? t.wallet : '')}">${t.mode === 'wallet' ? `<button class="tt-x" data-tclear title="Clear" aria-label="Clear wallet filter">${ICON.close}</button>` : ''}</label>
      <label class="tt-in" title="Hide trades smaller than this"><span>Min</span><input data-tmin inputmode="decimal" placeholder="0" value="${t.minSol > 0 ? esc(String(t.minSol)) : ''}"><em>SOL</em></label>
      <span class="tt-live" data-tlive></span>`;
  }
  function tradesFoot(hs, shownAll) {
    if (hs.some((h) => h.capped)) return '<span class="dim">Showing the latest 6,000 cached trades. Older history is not included.</span>';
    if (hs.some((h) => h.busy)) return '<span class="tt-spin"></span>Loading older trades…';
    const err = hs.find((h) => h.err)?.err;
    if (err) return `<span class="down">${esc(err)}</span> <button class="tt-link" data-older>Try again</button>`;
    if (!shownAll) return '<button class="tt-link" data-older>Show more</button>';
    if (hs.every((h) => h.done)) return '<span class="dim">Start of this coin\'s trade history.</span>';
    return '<button class="tt-link" data-older>Load older trades</button>';
  }
  function tradesBody() {
    const t = S.trades, hs = traderHists(), rows = tradeRows(), shown = rows.slice(0, t.shown), supply = supplyOf(ctx), unit = t.unit;
    const loading = hs.some((h) => h.next === undefined && !h.err);
    let rowsHtml;
    if (t.mode === 'dev' && !tokOf(ctx).dev) rowsHtml = emptyRow(6, 'The creator of this coin is not known yet.');
    else if (t.mode === 'you' && !hs.length) rowsHtml = emptyRow(6, 'Connect a wallet to see your trades here. <button class="tt-link" data-connect>Connect</button>');
    else if (t.mode === 'wallet' && !hs.length) rowsHtml = emptyRow(6, 'Paste a wallet address above to see its trades.');
    else if (!shown.length && loading) rowsHtml = loadingRow(6, 'Loading trades…');
    else if (!shown.length && hs.some((h) => h.err)) rowsHtml = emptyRow(6, `Trades did not load: ${esc(hs.find((h) => h.err).err)} <button class="tt-link" data-older>Retry</button>`, 'down');
    else if (!shown.length) rowsHtml = emptyRow(6, t.mode === 'tracked' ? 'None of your tracked wallets traded this coin in the trades loaded so far.' : t.minSol > 0 ? `No trades of ${esc(String(t.minSol))} SOL or more loaded yet.` : 'No trades yet.');
    else {
      const mine = myWallets(), dev = tokOf(ctx).dev;
      rowsHtml = shown.map((x) => {
        const mc = x.mc || x.priceUsd * supply, buy = x.side === 'buy';
        return `<tr data-trade-key="${esc(keyOf(x))}" class="${buy ? 'b' : 's'}${mine.has(x.wallet) ? ' me' : ''}${dev && x.wallet === dev ? ' dv' : ''}">
          <td class="age" data-age="${x.at}">${ago(x.at)}</td>
          <td class="${buy ? 'up' : 'down'}">${buy ? 'Buy' : 'Sell'}${x.mev ? '<span class="tt-b mev" title="Jupiter flags this trade as MEV (sandwich or arbitrage)">MEV</span>' : ''}</td>
          <td>${usd(mc)}</td>
          <td>${num(x.tokens)}</td>
          <td class="${buy ? 'up' : 'down'}">${unit === 'usd' ? usd(x.usd, 2) : fmtSol(x.sol)}</td>
          <td class="who"><button class="tt-w" data-scan="${esc(x.wallet)}" title="Scan this trader">${esc(short(x.wallet))}</button>${badges(x.wallet, ctx, x.tags)}<a class="tt-tx" href="${esc(solscanTx(x.sig))}" target="_blank" rel="noopener" title="Open on Solscan" aria-label="Open on Solscan">${EXT}</a><button class="tt-ico" data-fw="${esc(x.wallet)}" title="Only this wallet" aria-label="Only this wallet">${ICON.filter}</button></td></tr>`;
      }).join('');
    }
    return `<div class="tt-scroll" data-scroll="trades"><table class="tt-t tt-trades">
      <thead><tr><th>Age</th><th>Side</th><th>MC</th><th>Amount</th><th><button class="tt-th" data-unit title="Switch SOL / USD">${unit === 'usd' ? 'USD' : 'SOL'} ⇄</button></th><th>Trader</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table>
      ${shown.length ? `<div class="tt-foot" data-tfoot>${tradesFoot(hs, shown.length >= rows.length)}</div>` : ''}</div>`;
  }
  async function pollTrades(force = false) {
    const hs = traderHists();
    if (!hs.length) return;
    const watched = watchedMints().includes(mint);
    const jobs = hs.map((h) => {
      if (h.next === undefined) return h.err && !force ? null : loadOlder(h);
      if (!force && !h.trader && watched) return null; // the live stream already polls this coin's newest page
      return refreshHead(h);
    }).filter(Boolean);
    if (!jobs.length) return;
    await Promise.all(jobs);
    if (S.alive && S.tab === 'trades') renderBody();
    pushMarkers();
  }
  function onTradeEvent(d) {
    if (!d || d.mint !== mint) return;
    const x = evToTx(d);
    let n = addTxs(all_(), [x]);
    const th = histIf(mint, d.wallet); if (th && th.next !== undefined) n += addTxs(th, [x]);
    if (n && S.tab === 'trades') renderBodySoon();
    if (n && S.tab === 'top') { S.top.rows = null; renderBodySoon(); }
    if (n) pushMarkers();
  }
  // chart markers for tracked wallets' and KOLs' trades (the chart itself draws your fills and the dev's). Sent as one
  // named group, so each call replaces the last set.
  function pushMarkers(force = false) {
    if (!S.alive || !ctx.chart?.addMarkers) return;
    const tr = trackedWallets(), mine = myWallets(), dev = tokOf(ctx).dev;
    let added = 0;
    for (const x of all_().txs.slice(0, 900)) {
      if (mine.has(x.wallet) || x.wallet === dev) continue;
      const t = tr.get(x.wallet), k = kolOf(x.wallet);
      if (!t && !k) continue;
      const key = keyOf(x); if (S.marked.has(key)) continue;
      const buy = x.side === 'buy', label = String(t ? t.emoji || t.name || 'Trk' : k.name).slice(0, 8);
      S.marked.set(key, { id: 'trk:' + key, time: Math.floor(x.at / 1000), position: buy ? 'belowBar' : 'aboveBar', color: t ? '#38d6f5' : '#7d8496', shape: buy ? 'arrowUp' : 'arrowDown', text: label });
      added++;
    }
    if (!added && S.markedSent && !force) return;
    const list = [...S.marked.values()].sort((a, b) => a.time - b.time).slice(-200);
    if (!list.length && !S.markedSent) return;
    S.markedSent = true;
    try { ctx.chart.addMarkers(list, 'tracked-wallets'); } catch (e) { console.warn('markers', e); }
  }

  // ---------------------------------------------------------------- Positions
  async function loadPositions() {
    const P = S.positions, owners = positionOwners();
    if (!owners.length) { P.data = null; if (S.tab === 'positions') renderBody(); return; }
    if (P.busy) return; P.busy = true; if (S.tab === 'positions') renderBody();
    try {
      const dec = tokOf(ctx).decimals ?? decimalsOf(mint), log = tradeLog().filter((x) => x.mint === mint);
      P.data = await Promise.all(owners.map(async (w) => {
        const h = hist(mint, w);
        if (h.next === undefined) await scanHistory(h, { maxPages: 10, rps: 3, stop: () => !S.alive }); else await refreshHead(h);
        let bal = null, balErr = '';
        try { bal = await ju.balances(w); } catch (e) { balErr = e.message || 'Balance unavailable'; }
        const sigs = new Set(h.txs.map((x) => x.sig));
        const local = log.filter((x) => x.owner === w && x.sig && !sigs.has(x.sig)).map((x) => ({ id: 'log:' + x.sig, sig: x.sig, side: x.side, wallet: w, tokens: (Number(x.tokensRaw) || 0) / 10 ** dec, sol: x.sol || 0, usd: (x.sol || 0) * (x.solUsd || solUsd()), priceUsd: 0, at: x.at, local: true, tags: [] }));
        const txs = [...h.txs, ...local], s = statsOf(txs), held = bal ? (bal.tokens[mint]?.ui || 0) : Math.max(0, s.bTok - s.sTok);
        return { w, s, held, frozen: !!bal?.tokens[mint]?.frozen, sol: bal?.sol, balErr, txCount: txs.length, histDone: h.done, err: h.err, local: local.length };
      }));
      P.err = '';
    } catch (e) { P.err = e.message || 'Could not load your position.'; }
    P.busy = false; P.lastPoll = Date.now();
    if (S.alive && S.tab === 'positions') renderBody();
  }
  function positionsBody() {
    const P = S.positions;
    if (!positionOwners().length) return `<div class="tt-msg">Connect a wallet to see your position in this coin. <button class="btn btn-accent tt-sm" data-connect>Connect wallet</button></div>`;
    if (!P.data && !P.err) return `<div class="tt-msg"><span class="tt-spin"></span>Reading your trades and balance…</div>`;
    if (P.err && !P.data) return `<div class="tt-msg down">${esc(P.err)} <button class="tt-link" data-reload>Retry</button></div>`;
    const px = priceOf(ctx), sUsd = solUsd(), sym = symOf(ctx), supply = supplyOf(ctx);
    const rows = P.data.map((r) => {
      const p = pnlOf(r.s, r.held, px, sUsd), canSell = r.w === wallet.owner || (wallet.selected || []).includes(r.w);
      const confirm = P.confirm && P.confirm.w === r.w ? P.confirm : null;
      const sells = r.held > 0 && canSell ? [25, 50, 100].map((v) => `<button class="tt-sell" data-sell="${v}" data-owner="${esc(r.w)}" ${P.selling ? 'disabled' : ''}>${v}%</button>`).join('') : `<span class="dim">${r.held > 0 ? '—' : 'none held'}</span>`;
      let html = `<tr>
        <td class="who"><a href="${esc(solscanAcct(r.w))}" target="_blank" rel="noopener" class="tt-w">${esc(short(r.w))}</a>${r.w === wallet.owner ? '<span class="tt-b you">active</span>' : ''}${r.frozen ? '<span class="tt-b bad">frozen</span>' : ''}</td>
        <td><b class="${r.s.bSol ? 'up' : ''}">${fmtSol(r.s.bSol)}</b><small>${usd(r.s.bUsd)} · ${plural(r.s.buys, 'buy')}</small></td>
        <td><b class="${r.s.sSol ? 'down' : ''}">${fmtSol(r.s.sSol)}</b><small>${usd(r.s.sUsd)} · ${plural(r.s.sells, 'sell')}</small></td>
        <td><b>${num(r.held)}</b><small>${usd(p.valueUsd)} · ${((r.held / supply) * 100).toFixed(2)}%</small></td>
        <td><b>${r.s.bTok ? usd(p.avgUsd * supply) : '—'}</b><small>${r.s.bTok ? fmtPx(p.avgUsd) : ''}</small></td>
        <td class="${cls(p.realizedSol)}"><b>${fmtSolS(p.realizedSol)}</b><small>${fmtUsdS(p.realizedUsd)}</small></td>
        <td class="${cls(p.unrealSol)}"><b>${r.held > 0 ? fmtSolS(p.unrealSol) : '—'}</b><small>${r.held > 0 ? fmtUsdS(p.unrealUsd) : ''}</small></td>
        <td class="${cls(p.totalUsd)}"><b>${pct(p.totalPct)}</b><small>${fmtUsdS(p.totalUsd)}</small></td>
        <td class="tt-sells">${sells}</td></tr>`;
      if (confirm) {
        const tok = confirm.pct >= 100 ? r.held : (r.held * confirm.pct) / 100, estSol = sUsd > 0 ? (tok * px) / sUsd : 0, pr = PRIO[preset().prio] || PRIO.fast;
        html += `<tr class="tt-confirm"><td colspan="9"><div>
          <p><b>Sell ${confirm.pct}% of your ${esc(sym)}</b>: about <span class="mono">${num(tok)} ${esc(sym)}</span> for about <span class="mono">${fmtSol(estSol)} SOL</span>, paid to the same wallet <span class="mono">${esc(short(r.w, 6))}</span>.</p>
          <p class="tt-fees">Nought fee 0% · pool and launchpad fees are in the price · network fee + priority fee up to ${pr.max} SOL${preset().mev === 'protected' ? " · Jupiter Ultra's own fee (MEV protection)" : ''} · slippage ${esc(String(preset().slippage))}% (preset ${esc(preset().name)}). This is an estimate: the sale is refused if its price impact is over 25%. For an exact quote use the Sell tab of the trade panel.</p>
          <span class="tt-acts"><button class="btn tt-sm tt-danger" data-sellgo ${P.selling ? 'disabled' : ''}>${P.selling ? 'Selling…' : 'Confirm sell'}</button><button class="btn btn-ghost tt-sm" data-sellno>Cancel</button></span></div></td></tr>`;
      }
      return html;
    }).join('');
    const notes = [];
    if (P.data.some((r) => r.local)) notes.push('Includes trades from this browser\'s log that Jupiter has not indexed yet.');
    if (P.data.some((r) => !r.histDone && r.txCount >= 300)) notes.push('Long histories are read up to 300 trades per wallet.');
    if (P.data.some((r) => r.s.partial)) notes.push('Some tokens came in without a buy (a transfer or older trades), so their cost is unknown and left out of PnL.');
    if (P.data.some((r) => r.balErr)) notes.push('A balance did not load; holdings are estimated from trades.');
    return `<div class="tt-scroll"><table class="tt-t tt-pos">
      <thead><tr><th>Wallet</th><th>Bought</th><th>Sold</th><th>Holding</th><th>Avg entry MC</th><th>Realized</th><th>Unrealized</th><th>Total PnL</th><th>Sell</th></tr></thead>
      <tbody>${rows || emptyRow(9, 'No position yet.')}</tbody></table>
      <div class="tt-foot">${P.busy ? '<span class="tt-spin"></span>Refreshing… ' : ''}<span class="dim">${notes.map(esc).join(' ')} PnL uses your average buy cost and the price now (${fmtPx(px)}).</span></div></div>`;
  }
  async function doSell() {
    const P = S.positions, c = P.confirm; if (!c || P.selling) return;
    P.selling = true; renderBody();
    // this row shows an estimate, not a quote: the 25% impact cap is what guards the price (as one-click sells)
    try { await sellPct(mint, c.pct, { owner: c.w, maxImpactPct: 25 }); }
    catch (e) { if ((await maybeLanded(e)) == null) toast(esc(e.message || 'The sale did not go through.'), 'err'); }
    P.selling = false; P.confirm = null;
    if (S.alive) { renderBody(); loadPositions(); }
  }

  // ---------------------------------------------------------------- Orders
  async function loadOrders(force = false) {
    const O = S.orders;
    if (O.busy) return; O.busy = true; if (S.tab === 'orders') renderBody();
    let lim = [], err = '';
    if (wallet.owner) {
      try { lim = (await limit.list({ status: O.status, owner: wallet.owner, mint, force })).orders.map((o) => ({ ...o, owner: wallet.owner })); }
      catch (e) { err = e.message || 'Limit orders did not load.'; }
    }
    const live = (a) => a.status === 'armed' || a.status === 'firing';
    const arm = armed.list({ mint }).filter((a) => (O.status === 'active' ? live(a) : !live(a)));
    O.data = { lim, arm }; O.err = err; O.busy = false; O.lastPoll = Date.now();
    if (O.status === 'active') setN('orders', lim.length + arm.length);
    if (S.alive && S.tab === 'orders') { renderTool(); renderBody(); }
  }
  function ordersTool() {
    const O = S.orders;
    return `<div class="tt-seg"><button data-ostatus="active" class="${O.status === 'active' ? 'on' : ''}">Open</button><button data-ostatus="history" class="${O.status === 'history' ? 'on' : ''}">History</button></div>
      <span class="tt-note">${wallet.owner ? 'Wallet <span class="mono">' + esc(short(wallet.owner)) + '</span>' : 'No wallet connected'}</span>`;
  }
  function ordersBody() {
    const O = S.orders, sUsd = solUsd(), supply = supplyOf(ctx), sym = symOf(ctx);
    if (!O.data) return `<div class="tt-msg"><span class="tt-spin"></span>Loading orders…</div>`;
    const rows = [];
    for (const o of O.data.lim) {
      const px = o.priceSol > 0 && sUsd > 0 ? o.priceSol * sUsd : null, buy = o.side === 'buy';
      rows.push(`<tr><td><span class="${buy ? 'up' : 'down'}">Limit ${buy ? 'buy' : 'sell'}</span><small>on-chain · Jupiter</small></td>
        <td>${buy ? `${fmtSol(o.solUi)} SOL` : `${num(o.tokensUi)} ${esc(sym)}`}<small>${buy ? `for ${num(o.tokensUi)} ${esc(sym)}` : `for ${fmtSol(o.solUi)} SOL`}</small></td>
        <td>${px ? usd(px * supply) : '—'}<small>${px ? fmtPx(px) : ''}</small></td>
        <td>${o.filledPct ? o.filledPct.toFixed(0) + '%' : '0%'}</td>
        <td>${o.createdAt ? `<span data-age="${o.createdAt}">${ago(o.createdAt)}</span>` : '—'}<small>${o.expiredAt ? 'ends ' + esc(new Date(o.expiredAt).toLocaleString()) : 'no expiry'}</small></td>
        <td>${esc(o.status || '')}</td>
        <td>${O.status === 'active' ? `<button class="tt-link down" data-cancel="${esc(o.id)}" data-owner="${esc(o.owner)}">Cancel</button>` : o.closeTx ? `<a class="tt-tx" href="${esc(solscanTx(o.closeTx))}" target="_blank" rel="noopener" aria-label="Open on Solscan">${EXT}</a>` : ''}</td></tr>`);
      if (O.confirm?.id === o.id) rows.push(`<tr class="tt-confirm"><td colspan="7"><div><p><b>Cancel this limit ${esc(o.side)}?</b> Your wallet signs a cancel transaction; the unfilled ${buy ? 'SOL' : esc(sym)} goes back to <span class="mono">${esc(short(o.owner, 6))}</span>.</p><p class="tt-fees">Nought fee 0% · network + priority fee only</p>
        <span class="tt-acts"><button class="btn tt-sm tt-danger" data-cancelgo ${O.cancelling ? 'disabled' : ''}>${O.cancelling ? 'Cancelling…' : 'Confirm cancel'}</button><button class="btn btn-ghost tt-sm" data-cancelno>Keep it</button></span></div></td></tr>`);
    }
    for (const a of O.data.arm) {
      const what = a.kind === 'migrate-buy' ? `${fmtSol(a.sol)} SOL` : `${a.pct}% of holding`;
      const trig = a.kind === 'tp' || a.kind === 'sl' ? (a.mc ? usd(a.mc) + ' MC' : fmtPx(a.triggerUsd)) : 'at migration';
      rows.push(`<tr><td><span class="${a.kind === 'migrate-buy' ? 'up' : a.kind === 'sl' ? 'warn' : 'acc'}">${esc(armed.KIND_LABEL?.[a.kind] || a.kind)}</span><small>this browser <span class="tt-b needs" title="${esc(NEEDS_TAB)}">needs tab</span></small></td>
        <td>${what}<small class="mono">${esc(short(a.owner || '', 4))}</small></td><td>${trig}${a.lastUsd ? `<small>now ${fmtPx(a.lastUsd)}</small>` : ''}</td><td>—</td>
        <td>${a.created ? `<span data-age="${a.created}">${ago(a.created)}</span>` : '—'}</td>
        <td>${esc(a.status)}${a.note ? `<small>${esc(String(a.note).slice(0, 80))}</small>` : ''}</td>
        <td>${a.status === 'armed' ? `<button class="tt-link down" data-disarm="${esc(a.id)}">Remove</button>` : a.status !== 'firing' ? `<button class="tt-link" data-disarm="${esc(a.id)}">Clear</button>` : ''}</td></tr>`);
    }
    const empty = O.status === 'active' ? (wallet.owner ? 'No open orders for this coin. Place limit, take-profit or stop-loss orders from the trade panel.' : 'No orders armed in this browser. Connect a wallet to see on-chain limit orders.') : 'No past orders for this coin.';
    return `<div class="tt-scroll"><table class="tt-t tt-ord">
      <thead><tr><th>Type</th><th>Amount</th><th>Trigger</th><th>Filled</th><th>Placed</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.join('') || emptyRow(7, empty)}</tbody></table>
      <div class="tt-foot">${O.busy ? '<span class="tt-spin"></span>Refreshing… ' : ''}${O.err ? `<span class="down">${esc(O.err)}</span> <button class="tt-link" data-reload>Retry</button> ` : ''}<span class="dim">Limit orders live on-chain and fill while you are away. Orders marked "needs tab" fire only while a Nought tab is open.</span></div></div>`;
  }
  async function doCancel() {
    const O = S.orders, c = O.confirm; if (!c || O.cancelling) return;
    O.cancelling = true; renderBody();
    try { await limit.cancel(c.id, c.owner); } catch (e) { if ((await maybeLanded(e)) == null) toast(esc(e.message || 'The cancel did not go through.'), 'err'); }
    O.cancelling = false; O.confirm = null;
    if (S.alive) loadOrders(true);
  }

  // ---------------------------------------------------------------- Holders
  async function loadHolders() {
    S.holders.lastPoll = Date.now();
    try { const d = await holdersOf(mint); setN('holders', d.count || ''); } catch { /* the body shows the error */ }
    if (S.alive && S.tab === 'holders') { renderTool(); renderBodySoon(); }
  }
  function holdersTool() {
    const d = holdersCached(mint);
    return `<label class="tt-chk"><input type="checkbox" data-hidepool ${S.holders.hidePool ? 'checked' : ''}> Hide pools</label>
      <span class="tt-note">${d ? `${int(d.count)} holders · top ${d.holders.length} listed` : ''}</span><span class="tt-live">Click a wallet to scan it</span>`;
  }
  function holdersBody() {
    const c = holdersState(mint), d = c?.data;
    if (!d) return c?.err ? `<div class="tt-msg down">Holders did not load: ${esc(c.err)} <button class="tt-link" data-reload>Retry</button></div>` : `<div class="tt-msg"><span class="tt-spin"></span>Loading holders…</div>`;
    const supply = supplyOf(ctx), funders = new Map();
    for (const h of d.holders) if (h.funding?.from && !isPool(h)) funders.set(h.funding.from, (funders.get(h.funding.from) || 0) + 1);
    const holderSet = new Set(d.holders.map((h) => h.wallet));
    const list = d.holders.filter((h) => !(S.holders.hidePool && isPool(h)));
    if (!list.length) return `<div class="tt-msg">No holders to show.</div>`;
    const max = Math.max(...list.map((h) => h.amount), 1);
    const rows = list.map((h, i) => {
      const share = supply > 0 ? (h.amount / supply) * 100 : 0, f = h.funding, shared = f && funders.get(f.from) > 1, fromHolder = f && holderSet.has(f.from);
      return `<tr class="tt-click${isPool(h) ? ' pool' : ''}" data-scanrow="${esc(h.wallet)}">
        <td class="dim">${i + 1}</td>
        <td class="who"><button class="tt-w" data-scan="${esc(h.wallet)}">${esc(short(h.wallet))}</button>${badges(h.wallet, ctx, h.tags, h.labels)}</td>
        <td><span class="tt-pct"><span class="tt-bar-v"><i style="width:${Math.min(100, (h.amount / max) * 100).toFixed(1)}%"></i></span><b>${share >= 0.01 ? share.toFixed(2) : '&lt;0.01'}%</b></span></td>
        <td>${num(h.amount)}</td>
        <td>${fmtSol(h.sol)}</td>
        <td class="fund">${f ? `<a href="${esc(solscanAcct(f.from))}" target="_blank" rel="noopener" title="Funding wallet">${esc(short(f.from))}</a>${shared ? `<span class="tt-b warn" title="Heuristic: ${funders.get(f.from)} top holders were funded by this same wallet">×${funders.get(f.from)}</span>` : ''}${fromHolder ? '<span class="tt-b warn" title="Funded by another top holder">by holder</span>' : ''}<small>${fmtSol(f.amount)} SOL${f.at ? ' · ' + ago(f.at) + ' ago' : ''}</small>` : '<span class="dim">—</span>'}</td>
        <td><button class="tt-ico tt-star${trackedOf(h.wallet) ? ' on' : ''}" data-track="${esc(h.wallet)}" title="${trackedOf(h.wallet) ? 'Tracked' : 'Track this wallet'}" aria-label="Track this wallet">${ICON.star}</button></td></tr>`;
    }).join('');
    return `<div class="tt-scroll"><table class="tt-t tt-hold">
      <thead><tr><th>#</th><th>Wallet</th><th>% of supply</th><th>Amount</th><th>SOL</th><th>Funded by</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="tt-foot"><span class="dim">Top ${d.holders.length} wallets by balance (Jupiter). "×n" marks wallets funded by the same source: a heuristic, not proof.${c.err ? ' The last refresh failed; showing the previous list.' : ''}</span></div></div>`;
  }

  // ---------------------------------------------------------------- Top traders
  function startTopScan() {
    const T = S.top, h = all_();
    if (T.running || h.done || h.pages >= 150) return;
    T.running = true; T.stopped = false; renderTool();
    scanHistory(h, { maxPages: 150, rps: 3, stop: () => !S.alive || T.stopped, progress: () => { if (S.alive && S.tab === 'top' && Date.now() - T.lastAgg > 900) { T.lastAgg = Date.now(); renderBodySoon(); renderTool(); } } })
      .finally(() => { T.running = false; if (S.alive && S.tab === 'top') { renderTool(); renderBody(); } });
  }
  function topRows() {
    const T = S.top, h = all_();
    if (T.rows && T.ver === h.ver) return T.rows;
    const by = new Map();
    for (const x of h.txs) { let a = by.get(x.wallet); if (!a) by.set(x.wallet, a = []); a.push(x); }
    const px = priceOf(ctx), list = [];
    for (const [w, txs] of by) {
      const s = statsOf(txs), held = Math.max(0, s.bTok - s.sTok), p = pnlOf(s, held, px);
      list.push({ w, s, held, p, tags: txs.find((x) => x.tags?.length)?.tags || [] });
    }
    T.ver = h.ver;
    return (T.rows = list);
  }
  function topTool() {
    const T = S.top, h = all_(), n = h.txs.length;
    const state = T.running ? `<span class="tt-spin"></span>Reading history: ${int(n)} trades · page ${h.pages}/150 <button class="tt-link" data-topstop>Stop</button>`
      : h.done ? `Full history: ${int(n)} trades` : n ? `Last ${int(n)} trades${h.pages >= 150 ? ' (the history is longer than 150 pages)' : T.stopped ? ' (stopped)' : ''}${h.pages < 150 ? ' <button class="tt-link" data-topgo>Read more</button>' : ''}` : '';
    const sorts = [['pnl', 'PnL'], ['bought', 'Bought'], ['sold', 'Sold'], ['trades', 'Trades']];
    return `<div class="tt-seg">${sorts.map(([k, l]) => `<button data-topsort="${k}" class="${T.sort === k ? 'on' : ''}">${l}</button>`).join('')}</div><span class="tt-note">${state}</span>`;
  }
  function topBody() {
    const h = all_(), T = S.top, unit = S.trades.unit;
    if (!h.txs.length) return h.err ? `<div class="tt-msg down">${esc(h.err)} <button class="tt-link" data-topgo>Retry</button></div>` : h.done ? '<div class="tt-msg">No trades yet.</div>' : `<div class="tt-msg"><span class="tt-spin"></span>Reading trades…</div>`;
    const key = { pnl: (r) => r.p.totalUsd ?? -Infinity, bought: (r) => r.s.bUsd, sold: (r) => r.s.sUsd, trades: (r) => r.s.buys + r.s.sells }[T.sort];
    const top = [...topRows()].sort((a, b) => key(b) - key(a)).slice(0, 100);
    const v = (solv, u) => (unit === 'usd' ? usd(u) : fmtSol(solv));
    const rows = top.map((r, i) => `<tr class="tt-click" data-scanrow="${esc(r.w)}">
      <td class="dim">${i + 1}</td>
      <td class="who"><button class="tt-w" data-scan="${esc(r.w)}">${esc(short(r.w))}</button>${badges(r.w, ctx, r.tags)}</td>
      <td class="${r.s.buys ? 'up' : ''}">${v(r.s.bSol, r.s.bUsd)}<small>${plural(r.s.buys, 'buy')}</small></td>
      <td class="${r.s.sells ? 'down' : ''}">${v(r.s.sSol, r.s.sUsd)}<small>${plural(r.s.sells, 'sell')}</small></td>
      <td>${r.held > 0 ? num(r.held) : '—'}<small>${r.held > 0 ? usd(r.p.valueUsd) : ''}</small></td>
      <td class="${cls(r.p.totalUsd)}"><b>${r.s.partial ? '≈' : ''}${unit === 'usd' ? fmtUsdS(r.p.totalUsd) : fmtSolS(r.p.totalSol)}</b><small>${pct(r.p.totalPct)}</small></td>
      <td>${r.s.buys + r.s.sells}<small><span data-age="${r.s.last}">${ago(r.s.last)}</span> ago</small></td></tr>`).join('');
    return `<div class="tt-scroll"><table class="tt-t tt-top">
      <thead><tr><th>#</th><th>Trader</th><th>Bought</th><th>Sold</th><th>Left (est.)</th><th>PnL</th><th>Trades</th></tr></thead>
      <tbody>${rows || emptyRow(7, 'No traders yet.')}</tbody></table>
      <div class="tt-foot"><span class="dim">From ${h.done ? 'the full' : 'the loaded'} trade history (${int(h.txs.length)} trades). PnL counts what is left at today's price; ≈ means the wallet sold more than it bought in the trades read, so part of its cost is unknown.</span></div></div>`;
  }

  // ---------------------------------------------------------------- Dev tokens
  async function loadDev() {
    const D = S.dev, dev = tokOf(ctx).dev;
    if (!dev || D.busy) return;
    D.busy = true;
    const h = hist(mint, dev);
    if (h.next === undefined) await scanHistory(h, { maxPages: 5, rps: 3, stop: () => !S.alive }); else await refreshHead(h);
    D.busy = false;
    if (S.alive && S.tab === 'dev') renderBody();
  }
  function devBody() {
    const t = tokOf(ctx), dev = t.dev;
    if (!dev) return `<div class="tt-msg">The creator of this coin is not known yet.</div>`;
    const theirs = all().filter((x) => x.dev === dev && x.mint !== mint).sort((a, b) => (b.created || 0) - (a.created || 0));
    const rate = t.devMints > 0 && t.devMigrations != null ? (t.devMigrations / t.devMints) * 100 : null;
    const h = histIf(mint, dev), s = h ? statsOf(h.txs) : null;
    const devLine = !h || h.next === undefined ? (h?.err ? `<span class="down">${esc(h.err)}</span>` : '<span class="tt-spin"></span>Reading the creator\'s trades in this coin…')
      : !h.txs.length ? 'No trades by the creator in this coin.'
      : `In this coin the creator bought <b class="up">${fmtSol(s.bSol)} SOL</b> and sold <b class="down">${fmtSol(s.sSol)} SOL</b> (${s.bTok ? Math.min(100, (s.sTok / s.bTok) * 100).toFixed(0) : 0}% of the tokens bought) · first trade <span data-age="${s.first}">${ago(s.first)}</span> ago${h.done ? '' : ' (recent trades only)'}`;
    const rows = theirs.slice(0, 100).map((x) => `<tr><td class="who"><a class="tt-coin" href="#/t/${esc(x.mint)}">${esc(x.symbol || short(x.mint))}</a> <span class="dim">${esc((x.name || '').slice(0, 32))}</span></td>
      <td>${x.created ? `<span data-age="${x.created}">${ago(x.created)}</span>` : '—'}</td><td>${usd(mcUsd(x))}</td>
      <td>${x.migrated ? '<span class="tt-b ok">migrated</span>' : x.progress > 0 ? (x.progress * 100).toFixed(0) + '% curve' : '—'}</td><td>${esc(x.launchpad || '')}</td></tr>`).join('');
    return `<div class="tt-scroll">
      <div class="tt-dev">
        <div class="tt-kv"><span>Creator</span><b class="mono"><button class="tt-w" data-scan="${esc(dev)}" title="Scan the creator">${esc(short(dev, 5))}</button><button class="copy" data-copy="${esc(dev)}" title="Copy address" aria-label="Copy address">${ICON.copy}</button><a class="tt-tx" href="${esc(solscanAcct(dev))}" target="_blank" rel="noopener" title="Solscan" aria-label="Open on Solscan">${EXT}</a></b></div>
        <div class="tt-kv"><span>Coins created</span><b>${int(t.devMints)}</b></div>
        <div class="tt-kv"><span>Migrated</span><b>${int(t.devMigrations)}${rate != null ? ` <small>${rate.toFixed(0)}%</small>` : ''}</b></div>
        <div class="tt-kv"><span>Dev holds</span><b>${t.devPct != null ? Number(t.devPct).toFixed(2) + '%' : '—'}</b></div>
      </div>
      <div class="tt-devline">${devLine}</div>
      <table class="tt-t tt-devt"><thead><tr><th>Other coins by this creator seen here</th><th>Age</th><th>MC</th><th>Status</th><th>Launchpad</th></tr></thead>
      <tbody>${rows || emptyRow(5, 'None seen yet. Jupiter does not list a creator\'s coins by address, so this only shows coins Nought has met in this browser.')}</tbody></table>
      <div class="tt-foot"><span class="dim">Counts from Jupiter's audit. The list grows as Pulse and the live stream see more coins.</span></div></div>`;
  }

  // ---------------------------------------------------------------- rendering
  const TOOL = { trades: tradesTool, orders: ordersTool, holders: holdersTool, top: topTool };
  const BODY = { trades: tradesBody, positions: positionsBody, orders: ordersBody, holders: holdersBody, top: topBody, dev: devBody };
  function renderTool() {
    if (tool.dataset.tab === S.tab && tool.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') { updateLive(); return; } // don't wipe what is being typed
    const f = TOOL[S.tab], html = f ? f() : '';
    tool.innerHTML = html; tool.dataset.tab = S.tab; tool.hidden = !html;
    updateLive();
  }
  function updateLive() {
    const l = tool.querySelector('[data-tlive]'); if (!l) return;
    const watched = watchedMints().includes(mint), m = S.trades.mode;
    const status = tradeState(mint);
    l.textContent = hidden() ? 'Paused while hidden' : watched && status.error ? 'Trade feed delayed' : watched && status.catchingUp ? 'Catching up…' : m === 'all' || m === 'tracked' ? 'Live · 5.5 s' : 'Live · 6 s';
    l.title = status.error || 'Trade history is polled; launch events stream separately.';
  }
  let soon = 0;
  function renderBodySoon() { if (!soon) soon = setTimeout(() => { soon = 0; if (S.alive) renderBody(); }, 150); }
  function renderBody() {
    if (S.pressing) { S.dirty = true; return; }
    const sc = body.querySelector('.tt-scroll'), top = sc ? sc.scrollTop : 0, h0 = sc ? sc.scrollHeight : 0, left = sc ? sc.scrollLeft : 0, same = body.dataset.tab === S.tab;
    const html = BODY[S.tab]();
    if (same && S.tab === 'trades' && body.querySelector('tbody [data-trade-key]')) {
      const template = document.createElement('template'); template.innerHTML = html;
      const incoming = template.content.querySelector('tbody'), existing = body.querySelector('tbody');
      const keyed = new Map([...existing.children].map((row) => [row.dataset.tradeKey, row]));
      const stable = (row) => row.outerHTML.replace(/(data-age="\d+"[^>]*>)[^<]*/g, '$1');
      const rows = [...incoming.children].map((row) => { const old = keyed.get(row.dataset.tradeKey); return old && stable(old) === stable(row) ? old : row; });
      const wanted = new Set(rows); for (const row of [...existing.children]) if (!wanted.has(row)) row.remove();
      let ref = existing.firstElementChild;
      for (const row of rows) { if (row === ref) ref = ref.nextElementSibling; else existing.insertBefore(row, ref); }
      for (const selector of ['thead', '[data-tfoot]']) {
        const old = body.querySelector(selector), fresh = template.content.querySelector(selector);
        if (old && fresh) { if (old.innerHTML !== fresh.innerHTML) old.innerHTML = fresh.innerHTML; }
        else if (old) old.remove(); else if (fresh) body.querySelector('.tt-scroll').append(fresh);
      }
    } else body.innerHTML = html;
    body.dataset.tab = S.tab;
    const sc2 = body.querySelector('.tt-scroll');
    if (sc2 && same) { sc2.scrollLeft = left; if (top > 0) sc2.scrollTop = S.tab === 'trades' ? top + Math.max(0, sc2.scrollHeight - h0) : top; } // keep the reader's place as rows arrive on top
  }
  function render() {
    root.querySelectorAll('[data-ttab]').forEach((b) => { b.classList.toggle('on', b.dataset.ttab === S.tab); b.setAttribute('aria-selected', String(b.dataset.ttab === S.tab)); });
    renderTool(); renderBody();
    const t = tokOf(ctx); if (t.devMints != null) setN('dev', t.devMints);
  }
  function enter(tab) {
    S.tab = tab; persist(); body.dataset.tab = ''; render();
    if (tab === 'trades') { S.trades.shown = 100; pollTrades(true); }
    if (tab === 'positions') loadPositions();
    if (tab === 'orders') loadOrders();
    if (tab === 'holders') loadHolders();
    if (tab === 'top') { const h = all_(); if (h.next !== undefined && !h.done) refreshHead(h).then(() => S.alive && S.tab === 'top' && renderBody()); startTopScan(); }
    if (tab === 'dev') loadDev();
  }

  // ---------------------------------------------------------------- events
  function setMode(mode, w = '') {
    const T = S.trades; T.mode = mode; T.wallet = w; T.shown = 100;
    if (document.activeElement && tool.contains(document.activeElement)) document.activeElement.blur();
    renderTool(); body.dataset.tab = ''; renderBody(); pollTrades(true);
  }
  const press = (e) => { if (body.contains(e.target)) S.pressing = true; };
  const release = () => { if (!S.pressing) return; S.pressing = false; if (S.dirty) { S.dirty = false; setTimeout(() => S.alive && renderBody(), 0); } };
  root.addEventListener('pointerdown', press);
  document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button, a, tr[data-scanrow], input, label');
    if (!b || !root.contains(b)) return;
    const d = b.dataset;
    if (d.ttab) return enter(d.ttab);
    if (d.scan) { if (isMint(d.scan)) ctx.openScan?.(d.scan); return; }
    if (d.fw) { if (isMint(d.fw)) setMode('wallet', d.fw); return; }
    if (d.tmode) return setMode(d.tmode);
    if ('tclear' in d) return setMode('all');
    if ('unit' in d) { S.trades.unit = S.trades.unit === 'usd' ? 'sol' : 'usd'; persist(); return renderBody(); }
    if ('older' in d) {
      const T = S.trades, rows = tradeRows();
      if (T.shown < rows.length) { T.shown += 100; return renderBody(); }
      traderHists().forEach((h) => { h.err = ''; if (!h.done) loadOlder(h).then(() => S.alive && S.tab === 'trades' && renderBody()); });
      return renderBody();
    }
    if ('connect' in d) { needWallet(); return; }
    if ('reload' in d) { if (S.tab === 'positions') loadPositions(); if (S.tab === 'orders') loadOrders(true); if (S.tab === 'holders') { forgetHolders(mint); loadHolders(); renderBody(); } return; }
    if (d.sell) { if (isMint(d.owner)) S.positions.confirm = { w: d.owner, pct: Number(d.sell) }; return renderBody(); }
    if ('sellno' in d) { S.positions.confirm = null; return renderBody(); }
    if ('sellgo' in d) return doSell();
    if (d.ostatus) { if (S.orders.status !== d.ostatus) { S.orders.status = d.ostatus; S.orders.data = null; S.orders.confirm = null; renderTool(); renderBody(); loadOrders(); } return; }
    if (d.cancel) { S.orders.confirm = { id: d.cancel, owner: d.owner }; return renderBody(); }
    if ('cancelno' in d) { S.orders.confirm = null; return renderBody(); }
    if ('cancelgo' in d) return doCancel();
    if (d.disarm) { armed.remove(d.disarm); return; } // the 'orders' event reloads the list
    if (d.track) { trackWallet(d.track); return renderBody(); }
    if ('topstop' in d) { S.top.stopped = true; return renderTool(); }
    if ('topgo' in d) { all_().err = ''; return startTopScan(); }
    if (d.topsort) { S.top.sort = d.topsort; renderTool(); return renderBody(); }
    if (d.scanrow && b.tagName === 'TR' && isMint(d.scanrow)) ctx.openScan?.(d.scanrow);
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-hidepool]')) { S.holders.hidePool = t.checked; persist(); renderBody(); }
    if (t.matches('[data-tmin]')) { const v = Number(String(t.value).replace(',', '.')); S.trades.minSol = v > 0 && v < 1e6 ? v : 0; persist(); S.trades.shown = 100; renderBody(); }
  });
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.matches('[data-twallet]') && e.key === 'Enter') { const v = t.value.trim(); if (!v) return setMode('all'); if (isMint(v)) setMode('wallet', v); else toast('That is not a wallet address.', 'err'); }
    if (t.matches('[data-tmin]') && e.key === 'Enter') t.blur();
  });
  root.addEventListener('paste', (e) => {
    const t = e.target; if (!t.matches('[data-twallet]')) return;
    setTimeout(() => { const v = t.value.trim(); if (isMint(v)) setMode('wallet', v); }, 0);
  });
  // infinite scroll: show more of what is loaded, then fetch the next older page
  body.addEventListener('scroll', (e) => {
    const sc = e.target; if (!sc.classList?.contains('tt-scroll') || S.tab !== 'trades') return;
    if (sc.scrollTop + sc.clientHeight < sc.scrollHeight - 160) return;
    const T = S.trades, rows = tradeRows();
    if (T.shown < rows.length) { T.shown += 100; renderBody(); return; }
    const hs = traderHists().filter((h) => !h.done && !h.busy && !h.err);
    if (hs.length) { hs.forEach((h) => loadOlder(h).then(() => S.alive && S.tab === 'trades' && renderBody())); const f = body.querySelector('[data-tfoot]'); if (f) f.innerHTML = tradesFoot(traderHists(), true); }
  }, true);

  // live data
  offs.push(subscribe(ctx, 'trade', onTradeEvent));
  offs.push(subscribe(ctx, 'traded', (d) => {
    if (d?.mint !== mint) return;
    if (S.tab === 'positions') setTimeout(() => S.alive && loadPositions(), 2500);
    positionOwners().forEach((w) => { const h = histIf(mint, w); if (h) setTimeout(() => S.alive && refreshHead(h), 4000); });
  }));
  offs.push(subscribe(ctx, 'orders', () => { if (S.tab === 'orders' || S.orders.data) loadOrders(true); }));
  offs.push(subscribe(ctx, 'wallet', () => refreshVault(true).then(() => {
    if (!S.alive) return;
    S.positions.data = null; S.positions.confirm = null; S.orders.data = null; S.orders.confirm = null;
    if (S.tab === 'positions') loadPositions(); else if (S.tab === 'orders') loadOrders(true); else { loadOrders(true); renderBody(); }
  })));
  offs.push(subscribe(ctx, 'vault', () => refreshVault(true)));
  offs.push(subscribe(ctx, 'tracked', () => { forgetTracked(); if (S.tab === 'trades' || S.tab === 'holders' || S.tab === 'top') renderBodySoon(); S.marked.clear(); pushMarkers(true); }));
  offs.push(subscribe(ctx, 'tokens', () => { const t = tokOf(ctx); if (t.devMints != null) setN('dev', t.devMints); if (S.tab === 'dev') renderBodySoon(); }));

  // one heartbeat runs each tab's cadence; nothing polls while the page is hidden
  const beat = () => {
    if (!S.alive) return;
    updateLive();
    if (hidden()) return;
    const now = Date.now();
    if (S.tab === 'trades') { const gap = 6000; if (now - S.trades.lastPoll >= gap) { S.trades.lastPoll = now; pollTrades(); } }
    if (S.tab === 'holders' && now - S.holders.lastPoll >= 15000) loadHolders();
    if (S.tab === 'positions' && now - S.positions.lastPoll >= 20000 && !S.positions.busy && !S.positions.confirm && !S.positions.selling) loadPositions();
    if (now - S.orders.lastPoll >= 60000 && !S.orders.busy && !S.orders.confirm && (S.tab === 'orders' || S.orders.data)) loadOrders();
  };
  timers.push(setInterval(beat, 1000));
  const onVis = () => { if (!hidden()) beat(); else updateLive(); };
  document.addEventListener('visibilitychange', onVis);

  // first paint, the counts in the tab bar and the active tab's data
  enter(S.tab);
  S.trades.lastPoll = Date.now();
  if (S.tab !== 'holders') holdersOf(mint).then((d) => S.alive && setN('holders', d.count || '')).catch(() => {});
  if (S.tab !== 'orders') timers.push(setTimeout(() => S.alive && loadOrders(), 1500));
  if (S.tab !== 'trades') loadOlder(all_()).then(() => S.alive && pushMarkers());

  return () => {
    S.alive = false; S.top.stopped = true;
    timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); clearTimeout(soon);
    offs.forEach((f) => { try { f(); } catch { /* already gone */ } });
    document.removeEventListener('visibilitychange', onVis);
    document.removeEventListener('pointerup', release); document.removeEventListener('pointercancel', release);
    try { if (S.markedSent) ctx.chart?.addMarkers?.([], 'tracked-wallets'); } catch { /* chart already removed */ }
    el.innerHTML = '';
  };
}
