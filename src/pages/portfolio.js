// Portfolio (#/portfolio[/spot|activity|calendar|perps]): a view of any Solana wallet (the active one, a local vault
// wallet, or a pasted address, read-only) and of a Hyperliquid account by EVM address.
//   Spot      value = Jupiter holdings × prices + SOL. Cost basis, realized and unrealized PnL per coin come from Jupiter's
//             trade index (jx.txs with the wallet as trader, cached) merged with this browser's Nought trade log, using
//             average cost. Closed positions are the wallet's zero-balance token accounts plus logged trades. Sells only
//             for the connected wallet, after a quote review: the trade sells exactly the reviewed amount and refuses if
//             the fresh quote can't guarantee the minimum shown (minOutRaw) or its impact jumps.
//   Activity  the merged fills. Calendar: realized PnL per day from the sells. Perps: Hyperliquid clearinghouseState,
//             openOrders and userFills (POST api.hyperliquid.xyz/info: CORS open, checked 2026-10-04). Read-only.
// Gaps (said in the UI): coins whose token accounts were closed and that were never traded in Nought can't be seen;
// tokens that arrived by transfer have no cost basis.
import { $, esc, safeUrl, isMint, short, usd, num, pct, ago, LS, on, toast, ICON, parseAmount } from '../core/util.js';
import { register } from '../core/router.js';
import { wallet, openWalletPicker } from '../core/wallet.js';
import * as vault from '../core/vault.js';
import { ju, jx, jt, ds, img } from '../core/jup.js';
import { pricesFor, solUsd } from '../core/price.js';
import { tokens as store } from '../core/store.js';
import { tradeLog, feesSaved, trade, holding, quoteFor, quoteDetails, impactWarning, decimalsOf, SOL_MINT, DANGER_IMPACT } from '../core/trade.js';
import { quotedMin, maybeLanded } from '../ui/instant.js';
import { avatar } from '../ui/card.js';
import { togglePnlWidget, pnlWidgetOpen } from '../ui/pnlwidget.js';
import { info as hlInfo } from '../core/hl.js';

const TABS = [['spot', 'Spot'], ['activity', 'Activity'], ['calendar', 'Calendar'], ['perps', 'Perps']];
// SOL and dollar stablecoins (USDC, USDT, USD1, PYUSD): counted in value, never treated as trades
const BASE = new Set([SOL_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo']);
const PRICE_CAP = 300;                                // coins valued per wallet (6 Jupiter price calls)
const FILL_CAP = 40;                                  // held coins whose trade history we fetch
const PAGE_CLOSED = 15;                               // closed positions loaded per "load more"
const MAX_PAGES = 5;                                  // JX pages (30 fills) per coin; more = "partial history"
const HOLD_EVERY = 60e3, PRICE_EVERY = 30e3, HELD_TTL = 300e3, CLOSED_TTL = 1800e3, DUST_USD = 1;
const BUCKETS = [
  { label: 'Above +500%', c: 'up3', t: (p) => p > 500 },
  { label: '+200% to +500%', c: 'up2', t: (p) => p > 200 && p <= 500 },
  { label: '0% to +200%', c: 'up1', t: (p) => p >= 0 && p <= 200 },
  { label: '0% to −50%', c: 'dn1', t: (p) => p < 0 && p >= -50 },
  { label: 'Below −50%', c: 'dn2', t: (p) => p < -50 },
];
const RANGES = { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, max: Infinity };
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const REFRESH = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SHARE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 15V4m0 0L8 8m4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ---- formatting ----
// SOL on the page: exactly 0 → "0", under 0.0001 → "<0.0001", else up to 4 decimals with trailing zeros dropped
function fSol(n, signed = false) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n), sg = n < 0 ? '-' : signed ? '+' : '';
  if (a < 1e-9) return '0'; // float dust from the average-cost maths
  if (a < 1e-4) return sg + '<0.0001';
  return sg + a.toFixed(a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
// fixed decimals, for the sell review (what you get and the minimum read exactly as quoted)
function fSolFix(n, signed = false) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n), d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : a === 0 ? 2 : 4;
  return (signed && n > 0 ? '+' : n < 0 ? '-' : '') + a.toFixed(d);
}
const fUsd = (n, signed = false) => (n == null || !isFinite(n) ? '—' : (signed && n > 0 ? '+' : '') + usd(n, 2));
const tone = (n) => (n > 1e-9 ? 'up' : n < -1e-9 ? 'down' : '');
const dur = (ms) => (!(ms > 0) ? '—' : ms < 3600e3 ? Math.max(1, Math.round(ms / 60e3)) + 'm' : ms < 864e5 ? Math.round(ms / 3600e3) + 'h' : Math.round(ms / 864e5) + 'd');
const px = (n) => { n = Number(n); if (!isFinite(n)) return '—'; const a = Math.abs(n); return a >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : a >= 1 ? n.toFixed(a >= 100 ? 2 : 4) : n.toPrecision(4); };
const N = (x) => { const v = Number(x); return isFinite(v) ? v : 0; };
const fTok = (n) => (n == null || !isFinite(n) ? '—' : Math.abs(n) >= 1000 ? num(n) : Math.abs(n) >= 1 ? n.toFixed(2) : n === 0 ? '0' : Math.abs(n) < 1e-4 ? '<0.0001' : Number(n.toPrecision(3)).toString());
const fFee = (n) => (n > 0 && n < 0.001 ? Number(n.toPrecision(2)).toFixed(9).replace(/0+$/, '') : fSolFix(n));
// a count in green / red only when it isn't zero
const nTone = (n, c) => (n ? `<span class="${c}">${n}</span>` : '0');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WALLET = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="13.5" r="1.3" fill="currentColor"/></svg>';

// ---- token names and pictures: the store first, then our own cache (Jupiter search), kept in this browser ----
const meta = new Map((LS.get('pf.meta', []) || []).filter((e) => Array.isArray(e) && isMint(e[0]) && e[1] && typeof e[1] === 'object'));
let metaSaveT = 0;
const saveMeta = () => { clearTimeout(metaSaveT); metaSaveT = setTimeout(() => LS.set('pf.meta', [...meta].slice(-600)), 1500); };
function metaOf(mint) {
  const s = store.get(mint), m = meta.get(mint) || {};
  const supply = m.supply || (s?.mcUsd > 0 && s?.price > 0 ? s.mcUsd / s.price : s?.circSupply || s?.totalSupply) || null;
  return { mint, symbol: String(s?.symbol || m.symbol || '').slice(0, 24), name: String(s?.name || m.name || '').slice(0, 60), image: safeUrl(s?.image || m.image) || '', supply, price: m.price, migrated: true };
}
const symOf = (m) => (m.symbol ? '$' + m.symbol.replace(/^\$/, '') : short(m.mint));
async function loadMeta(mints) {
  const need = [...new Set(mints)].filter((m) => !store.get(m)?.symbol && !(meta.get(m)?.at > Date.now() - 6 * 3600e3)).slice(0, PRICE_CAP);
  if (!need.length) return;
  let got = false;
  try {
    for (const t of await jt.search(need)) meta.set(t.mint, { symbol: t.symbol, name: t.name, image: t.image, price: t.price, supply: t.mcUsd > 0 && t.price > 0 ? t.mcUsd / t.price : t.circSupply || t.totalSupply, at: Date.now() });
    got = true;
  } catch { /* Jupiter busy: Dexscreener, then Jupiter again in 30 minutes */ }
  if (!got) {
    try {
      for (const [m, p] of await ds.tokens(need)) {
        const pu = Number(p.priceUsd), mc = Number(p.marketCap || p.fdv);
        meta.set(m, { symbol: String(p.baseToken?.symbol || '').slice(0, 24), name: String(p.baseToken?.name || '').slice(0, 60), image: img(p.info?.imageUrl) || '', price: pu > 0 ? pu : undefined, supply: pu > 0 && mc > 0 ? mc / pu : undefined, at: Date.now() - 5.5 * 3600e3 });
      }
      got = true;
    } catch { return; }
  }
  for (const m of need) if (!meta.has(m)) meta.set(m, { at: Date.now() - 5.5 * 3600e3 });
  saveMeta();
}

// ---- the local trade log (Nought trades made in this browser) ----
let logMemo = { at: 0, v: [] };
const allLog = () => { if (Date.now() - logMemo.at > 1000) logMemo = { at: Date.now(), v: (tradeLog() || []).filter((t) => t && isMint(t.mint) && (t.side === 'buy' || t.side === 'sell')) }; return logMemo.v; };
const logFor = (addr) => allLog().filter((t) => t.owner === addr);
function fromLog(t, dec) {
  const tokens = N(t.tokensRaw) / 10 ** dec, solAmt = N(t.sol), u = solAmt * (N(t.solUsd) || solUsd());
  return { sig: String(t.sig || ''), mint: t.mint, side: t.side, tokens, sol: solAmt, usd: u, priceUsd: tokens > 0 ? u / tokens : 0, at: N(t.at), wallet: t.owner, local: true };
}

// ---- per-wallet books, kept across tab switches ----
const books = new Map();
function book(addr) {
  let b = books.get(addr);
  if (!b) { b = { addr, at: 0, pxAt: 0, sol: 0, held: [], zero: [], px: new Map(), err: '', warn: '', busy: null, pending: 0, closedShown: PAGE_CLOSED, showDust: false }; books.set(addr, b); }
  return b;
}
async function loadHoldings(b) {
  const h = await ju.holdings(b.addr);
  const held = [], zero = [];
  for (const [mint, t] of Object.entries(h.tokens)) {
    if (t.raw !== '0') held.push({ mint, ui: t.ui, raw: t.raw, dec: t.dec, frozen: t.frozen });
    else zero.push(mint);
  }
  Object.assign(b, { sol: h.sol, held, zero, at: Date.now(), err: '', warn: '' });
}
async function loadPrices(b) {
  const mints = b.held.map((h) => h.mint).slice(0, PRICE_CAP);
  b.pxAt = Date.now();
  if (!mints.length) return;
  for (const [m, p] of await pricesFor(mints)) if (p.priceUsd > 0) b.px.set(m, p.priceUsd);
}
// held coins whose trade history we load: the most valuable ones, plus anything traded in Nought
function heldTargets(b) {
  const logM = new Set(logFor(b.addr).map((t) => t.mint));
  return b.held.filter((h) => !BASE.has(h.mint))
    .map((h) => { const p = b.px.get(h.mint); return { m: h.mint, v: p ? h.ui * p : -1, log: logM.has(h.mint) }; })
    .filter((x) => x.v >= DUST_USD || x.log).sort((x, y) => y.v - x.v).slice(0, FILL_CAP).map((x) => x.m);
}
// closed positions: coins traded in Nought that the wallet no longer holds (newest first), then zero-balance accounts
function closedCandidates(b) {
  const held = new Set(b.held.map((h) => h.mint)), last = new Map();
  for (const t of logFor(b.addr)) if (!held.has(t.mint) && !BASE.has(t.mint)) last.set(t.mint, Math.max(last.get(t.mint) || 0, N(t.at)));
  const fromLog = [...last].sort((x, y) => y[1] - x[1]).map(([m]) => m), seen = new Set(fromLog);
  return [...fromLog, ...b.zero.filter((m) => !seen.has(m) && !BASE.has(m))];
}

// ---- fills from Jupiter's trade index, cached per wallet + coin ----
const fillCache = new Map(); // `${addr}:${mint}` → {at, list, partial, err}
function fresh(addr, mint, ttl) { const h = fillCache.get(addr + ':' + mint); return !!h && (h.err ? Date.now() < h.retryAt : Date.now() - h.at < ttl); }
async function fetchFills(addr, mint) {
  const k = addr + ':' + mint, prev = fillCache.get(k), out = [];
  let offset = null, partial = false;
  try {
    for (let p = 0; p < MAX_PAGES; p++) {
      const r = await jx.txs(mint, { trader: addr, offset });
      out.push(...r.txs.filter((t) => t.wallet === addr));
      if (!r.next || r.txs.length < 30) break;
      if (p === MAX_PAGES - 1) partial = true;
      offset = r.next;
    }
    fillCache.set(k, { at: Date.now(), list: out, partial, err: '' });
  } catch (e) {
    // keep what we had; try again in about a minute
    fillCache.set(k, { at: prev?.at || Date.now(), retryAt: Date.now() + 60e3, list: prev?.list || out, partial: true, err: e.message || 'Trade history unavailable' });
  }
  if (fillCache.size > 3000) fillCache.delete(fillCache.keys().next().value);
}
async function loadFills(b, mints, ttl, alive) {
  const q = mints.filter((m) => !BASE.has(m) && !fresh(b.addr, m, ttl));
  if (!q.length) return;
  b.pending += q.length; paint();
  const worker = async () => { while (q.length && alive()) { const m = q.shift(); await fetchFills(b.addr, m); b.pending = Math.max(0, b.pending - 1); paint(); } };
  await Promise.all([worker(), worker()]); // two at a time: the datapi lane is shared with the rest of the app
  b.pending = Math.max(0, b.pending - q.length);
}

// average-cost position from fills (any order). Realized PnL is booked on each sell against the average entry.
function position(list) {
  const f = [...list].sort((a, b) => a.at - b.at);
  let qty = 0, cost = 0, costUsd = 0, invested = 0, investedUsd = 0, sold = 0, soldUsd = 0, realized = 0, realizedUsd = 0, bought = 0, buys = 0, sells = 0, unknown = false;
  const events = [];
  for (const x of f) {
    if (x.side === 'buy') { qty += x.tokens; cost += x.sol; costUsd += x.usd; invested += x.sol; investedUsd += x.usd; bought += x.tokens; buys++; continue; }
    sells++; sold += x.sol; soldUsd += x.usd;
    const take = Math.min(x.tokens, qty), share = qty > 0 ? take / qty : 0, c = cost * share, cu = costUsd * share;
    if (x.tokens > qty * 1.001 + 1e-9) unknown = true; // sold more than we saw bought: tokens came in some other way
    const r = x.sol - c, ru = x.usd - cu;
    realized += r; realizedUsd += ru; cost -= c; costUsd -= cu; qty -= take;
    events.push({ at: x.at, sol: r, usd: ru });
  }
  return { qty, cost, costUsd, invested, investedUsd, sold, soldUsd, realized, realizedUsd, bought, buys, sells, unknown, events, fills: f, first: f[0]?.at || 0, last: f.at(-1)?.at || 0, avgEntryUsd: bought > 0 ? investedUsd / bought : null };
}

// everything the Solana tabs show, from the book + caches
function model(b) {
  const su = solUsd(), log = logFor(b.addr), byMint = new Map(), localSigs = new Set();
  for (const t of log) { (byMint.get(t.mint) || byMint.set(t.mint, []).get(t.mint)).push(t); if (t.sig) localSigs.add(t.sig); }
  const decOf = (mint) => b.held.find((h) => h.mint === mint)?.dec ?? decimalsOf(mint);
  const posOf = (mint) => {
    const hit = fillCache.get(b.addr + ':' + mint), local = byMint.get(mint) || [];
    if (!hit && !local.length) return null;
    const list = [...(hit?.list || [])], sigs = new Set(list.map((f) => f.sig));
    for (const t of local) if (!sigs.has(t.sig)) list.push(fromLog(t, decOf(mint)));
    return { ...position(list), partial: !!hit?.partial, err: hit?.err || '', indexed: !!hit };
  };
  const targets = new Set(heldTargets(b));
  const held = b.held.map((h) => {
    const m = metaOf(h.mint), price = b.px.get(h.mint) ?? m.price ?? null, base = BASE.has(h.mint);
    const valueUsd = price != null ? h.ui * price : null, valueSol = valueUsd != null && su > 0 ? valueUsd / su : null;
    const p = base ? null : posOf(h.mint);
    const r = { ...h, m, price, valueUsd, valueSol, p, base, waiting: !base && !p && targets.has(h.mint) && !fresh(b.addr, h.mint, Infinity) };
    if (p && p.bought > 0 && valueSol != null) {
      const share = p.qty > 0 ? Math.min(1, h.ui / p.qty) : 0;
      r.unrealSol = valueSol - p.cost * share; r.unrealUsd = valueUsd - p.costUsd * share;
      r.pnlSol = p.realized + r.unrealSol; r.pnlUsd = p.realizedUsd + r.unrealUsd;
      r.pnlPct = p.invested > 0 ? (r.pnlSol / p.invested) * 100 : null;
    }
    return r;
  }).sort((x, y) => (y.valueUsd ?? -1) - (x.valueUsd ?? -1));
  const cands = closedCandidates(b), shown = cands.slice(0, b.closedShown), closed = [];
  let noTrades = 0, waitingClosed = 0;
  for (const mint of shown) {
    const p = posOf(mint);
    if (!p) { if (!fresh(b.addr, mint, Infinity)) waitingClosed++; continue; }
    if (!p.fills.length) { noTrades++; continue; }
    closed.push({ mint, m: metaOf(mint), p, pnlSol: p.realized, pnlUsd: p.realizedUsd, pnlPct: p.invested > 0 ? (p.realized / p.invested) * 100 : null });
  }
  closed.sort((x, y) => y.p.last - x.p.last);
  const withPos = [...held.filter((r) => r.p), ...closed];
  const events = withPos.flatMap((r) => r.p.events.map((e) => ({ ...e, mint: r.mint })));
  const fills = withPos.flatMap((r) => r.p.fills.map((f) => ({ ...f, mint: r.mint, m: r.m, nought: f.local || localSigs.has(f.sig) })));
  const tokUsd = held.reduce((s, r) => s + (r.valueUsd || 0), 0), totalUsd = b.sol * su + tokUsd;
  const sum = (a, k) => a.reduce((s, r) => s + (r[k] ?? 0), 0);
  const perf = [...held.filter((r) => r.pnlPct != null), ...closed.filter((r) => r.pnlPct != null)];
  return {
    su, held, closed, cands, shown, noTrades, waitingClosed, events, fills, totalUsd, totalSol: su > 0 ? totalUsd / su : null,
    unrealSol: sum(held, 'unrealSol'), unrealUsd: sum(held, 'unrealUsd'), openKnown: held.filter((r) => r.unrealSol != null).length,
    realSol: withPos.reduce((s, r) => s + r.p.realized, 0), realUsd: withPos.reduce((s, r) => s + r.p.realizedUsd, 0),
    buys: withPos.reduce((s, r) => s + r.p.buys, 0), sells: withPos.reduce((s, r) => s + r.p.sells, 0),
    wins: closed.filter((r) => r.pnlSol > 0).length, perf, priced: held.filter((r) => r.price != null).length, coins: withPos.length,
  };
}

// ---- the mounted page ----
let ctx = null, paintT = 0;
const TAB_STATE = { range: RANGES[LS.get('pf.range', '30d')] ? LS.get('pf.range', '30d') : '30d', af: 'all', aLimit: 200, cal: null };
function paint() { if (!ctx || paintT) return; paintT = setTimeout(() => { paintT = 0; if (ctx?.alive) renderBody(); }, 200); }

const selKey = () => { const s = LS.get('pf.sel', 'active'); return s === 'active' || isMint(s) ? s : 'active'; };
const currentAddr = () => (selKey() === 'active' ? wallet.owner || null : selKey());
const recents = () => (LS.get('pf.recent', []) || []).filter(isMint).slice(0, 6);
let locals = [];
async function refreshLocals() { try { locals = await vault.list(); } catch { locals = []; } }

async function ensure(b, force = false) {
  if (b.busy) return b.busy;
  const alive = () => !!ctx?.alive && ctx.addr === b.addr;
  b.busy = (async () => {
    if (force || !b.at || Date.now() - b.at > HOLD_EVERY) {
      try { await loadHoldings(b); } catch (e) { if (b.at) b.warn = 'Could not refresh balances. Showing the last ones.'; else b.err = e.message || 'Could not read this wallet.'; return; }
      paint();
    }
    if (force || Date.now() - b.pxAt > PRICE_EVERY) { await loadPrices(b); paint(); }
    await loadMeta(b.held.map((h) => h.mint).slice(0, PRICE_CAP)); paint();
    if (!alive()) return;
    await loadFills(b, heldTargets(b), force ? 60e3 : HELD_TTL, alive);
    if (!alive()) return;
    const closed = closedCandidates(b).slice(0, b.closedShown);
    await loadMeta(closed); paint();
    await loadFills(b, closed, CLOSED_TTL, alive);
  })().catch((e) => { b.warn = e.message || 'Something went wrong while loading.'; }).finally(() => { b.busy = null; paint(); });
  return b.busy;
}

register({
  id: 'portfolio', tab: 'portfolio', match: /^#\/portfolio(?:\/([a-z]+))?$/, title: 'Portfolio · Nought',
  mount(view, [sub]) {
    const tab = TABS.some(([id]) => id === sub) ? sub : 'spot';
    view.innerHTML = `<div class="pf" data-tab="${tab}">
      <div class="pf-bar">
        <nav class="subtabs pf-tabs" aria-label="Portfolio views">${TABS.map(([id, l]) => `<a href="#/portfolio/${id}" class="${id === tab ? 'on' : ''}"${id === tab ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
        <div class="pf-who" id="pf-who"></div>
        <div class="pf-tools"><button class="btn btn-ghost icon" data-act="refresh" title="Refresh" aria-label="Refresh">${REFRESH}</button><button class="btn btn-ghost" data-act="widget" id="pf-wbtn" title="A floating box with this session's PnL for the active wallet">Live PnL</button></div>
      </div>
      <div class="pf-main" id="pf-body"></div>
    </div>`;
    const me = ctx = { alive: true, tab, addr: tab === 'perps' ? null : currentAddr(), view };
    const root = view.querySelector('.pf');
    renderWho(); renderBody();
    refreshLocals().then(() => { if (me.alive) renderWho(); });
    const tick = () => { if (!me.alive || document.hidden) return; if (me.tab === 'perps') loadPerps(); else if (me.addr) ensure(book(me.addr)); };
    const onVis = () => { if (!document.hidden) tick(); };
    tick();
    const timer = setInterval(tick, 15000);
    let tradedT = 0;
    const offs = [
      on('wallet', () => { if (me.tab !== 'perps' && selKey() === 'active' && me.addr !== wallet.owner) { me.addr = wallet.owner || null; tick(); } renderWho(); renderBody(); }),
      on('vault', () => refreshLocals().then(() => { if (me.alive) renderWho(); })),
      on('sol', paint),
      on('traded', (d) => {
        if (!d?.owner || !books.has(d.owner)) return;
        fillCache.delete(d.owner + ':' + d.mint); logMemo.at = 0;
        clearTimeout(tradedT); tradedT = setTimeout(() => { const b = books.get(d.owner); if (b && me.alive) { b.at = 0; ensure(b); } }, 3000);
      }),
    ];
    document.addEventListener('visibilitychange', onVis);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('submit', onSubmit);
    return () => {
      me.alive = false; if (ctx === me) ctx = null;
      clearInterval(timer); clearTimeout(tradedT); clearTimeout(paintT); paintT = 0;
      offs.forEach((f) => f()); document.removeEventListener('visibilitychange', onVis);
    };
  },
});

// Refresh needs something to load; Live PnL follows the active wallet (it stays clickable while open, to close it)
function syncTools() {
  if (!ctx) return;
  const rb = $('[data-act="refresh"]', ctx.view), wb = $('#pf-wbtn', ctx.view);
  if (rb) rb.disabled = ctx.tab === 'perps' ? !perps.addr : !ctx.addr;
  if (wb) { const open = pnlWidgetOpen(); wb.classList.toggle('on', open); wb.disabled = !wallet.owner && !open; wb.title = wb.disabled ? 'Connect a wallet to track its session PnL' : "A floating box with this session's PnL for the active wallet"; }
}
function renderWho() {
  const el = ctx && $('#pf-who', ctx.view); if (!el) return;
  syncTools();
  if (ctx.tab === 'perps') {
    el.innerHTML = `<form class="pf-paste" data-form="evm"><input name="a" value="${esc(perps.addr)}" placeholder="Paste an EVM address (0x…)" spellcheck="false" autocomplete="off" aria-label="Hyperliquid account address"><button class="btn">View</button></form>`;
    return;
  }
  const s = selKey(), opts = [['active', wallet.owner ? `Active · ${wallet.name || 'Wallet'} · ${short(wallet.owner)}` : 'Active wallet · none']];
  for (const l of locals) opts.push([l.address, `Local · ${l.name || 'Wallet'} · ${short(l.address)}`]);
  for (const r of recents()) if (!opts.some(([v]) => v === r)) opts.push([r, `Address · ${short(r)}`]);
  if (s !== 'active' && !opts.some(([v]) => v === s)) opts.push([s, `Address · ${short(s)}`]);
  el.innerHTML = `<select class="pf-select" data-sel aria-label="Wallet to view">${opts.map(([v, l]) => `<option value="${esc(v)}"${v === s ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <form class="pf-paste" data-form="sol"><input name="a" placeholder="Paste any Solana address" spellcheck="false" autocomplete="off" aria-label="Solana address to view"><button class="btn">View</button></form>`;
}

function renderBody() {
  const el = ctx && $('#pf-body', ctx.view); if (!el) return;
  const keep = [...el.querySelectorAll('.pf-tw')].map((t) => t.scrollLeft);
  el.innerHTML = ctx.tab === 'perps' ? perpsHtml() : solanaHtml();
  el.querySelectorAll('.pf-tw').forEach((t, i) => { if (keep[i]) t.scrollLeft = keep[i]; });
}

// a scrolling table, or (when there are no rows) the empty/loading state on its own so it stays readable on phones
const tbl = (head, body, empty) => (body ? `<div class="pf-tw"><table class="pf-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` : empty);
const emptyBox = (title, text, extra = '') => `<div class="empty-state pf-es"><h3>${title}</h3><p>${text}</p>${extra ? `<div class="es-acts">${extra}</div>` : ''}</div>`;
const loadingRows = (n = 5) => `<div class="pf-skel" aria-label="Loading">${'<i></i>'.repeat(n)}</div>`;
const STAT_NAMES = ['Total value', 'SOL available', 'Unrealized PnL', 'Realized PnL', 'Trades', 'Fees saved'];
const skelStats = () => `<div class="pf-stats">${STAT_NAMES.map(() => '<div class="pf-stat"><span class="eyebrow">&nbsp;</span><b class="pf-ld"></b></div>').join('')}</div>`;
// nothing to show yet: what to do, over a still preview of the stat tiles
const noWallet = () => `<div class="empty-state pf-start"><span class="es-ic">${WALLET}</span><h3>No wallet picked</h3>
    <p>Connect a wallet, make a local one in this browser, or paste any Solana address to see its holdings and PnL. A pasted address is view only.</p>
    <div class="es-acts"><button class="btn btn-accent" data-act="connect">Connect wallet</button>${vault.supported() ? '<button class="btn" data-act="newlocal">Create local wallet</button>' : ''}<button class="btn btn-ghost" data-act="paste">Paste an address</button></div></div>
  <div class="pf-stats pf-ghost" aria-hidden="true">${STAT_NAMES.map((k) => `<div class="pf-stat"><span class="eyebrow">${k}</span><b><i class="skel"></i></b><em><i class="skel"></i></em></div>`).join('')}</div>`;

function solanaHtml() {
  if (!ctx.addr) return noWallet();
  const b = book(ctx.addr);
  if (b.err && !b.at) return addrLine(b) + emptyBox('Could not load this wallet', esc(b.err), '<button class="btn" data-act="retry">Try again</button>');
  if (!b.at) return addrLine(b) + skelStats() + loadingRows(6);
  const M = model(b);
  const warn = b.warn ? `<div class="pf-warn">${esc(b.warn)}</div>` : '';
  if (ctx.tab === 'activity') return addrLine(b) + warn + activityHtml(b, M);
  if (ctx.tab === 'calendar') return addrLine(b) + warn + calendarHtml(b, M);
  return addrLine(b) + warn + spotHtml(b, M);
}
function addrLine(b) {
  const ro = b.addr !== wallet.owner, badge = `<span class="pf-badge${ro ? '' : ' on'}" title="${ro ? 'Nought can show this wallet but cannot trade from it.' : 'The active wallet: you can sell from here.'}">${ro ? 'View only' : 'Active wallet'}</span>`;
  return `<div class="pf-addr">${badge}<span class="mono">${esc(b.addr)}</span><button class="copy" data-copy="${esc(b.addr)}" title="Copy address">${ICON.copy}</button><a href="https://solscan.io/account/${esc(b.addr)}" target="_blank" rel="noopener">Solscan</a>${b.at ? `<span class="dim">updated <span data-age="${b.at}">${ago(b.at)}</span> ago</span>` : ''}${b.busy || b.pending ? '<span class="pf-spin" title="Loading"></span>' : ''}</div>`;
}
const stat = (k, v, sub = '', c = '', title = '') => `<div class="pf-stat"${title ? ` title="${esc(title)}"` : ''}><span class="eyebrow">${k}</span><b class="${c}">${v}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
const canSell = () => !!wallet.owner && ctx?.addr === wallet.owner;
const tokCell = (m) => `<div class="pf-tok">${avatar(m, 'sm')}<div><b>${esc(symOf(m))}</b><span>${esc(m.name || short(m.mint))}</span></div></div>`;

// ---- Spot ----
function spotHtml(b, M) {
  const fs = feesSaved(b.addr), su = M.su;
  const stats = `<div class="pf-stats">
    ${stat('Total value', usd(M.totalUsd, 2), M.totalSol != null ? `${fSol(M.totalSol)} SOL` : '', '', `SOL plus ${M.priced} priced coins`)}
    ${stat('SOL available', `${fSol(b.sol)} SOL`, usd(b.sol * su, 2))}
    ${stat('Unrealized PnL', `${fSol(M.unrealSol, true)} SOL`, `${fUsd(M.unrealUsd, true)} · ${M.openKnown} open`, tone(M.unrealSol), 'Value of what you hold minus its average cost, for coins with a known cost')}
    ${stat('Realized PnL', `${fSol(M.realSol, true)} SOL`, `${fUsd(M.realUsd, true)} · ${M.coins} coin${M.coins === 1 ? '' : 's'}`, tone(M.realSol), 'Booked on each sell against your average entry')}
    ${stat('Trades', `${nTone(M.buys, 'up')} / ${nTone(M.sells, 'down')}`, M.closed.length ? `${Math.round((M.wins / M.closed.length) * 100)}% of closed in profit` : 'buys / sells')}
    ${stat('Fees saved', `${fSol(fs.sol)} SOL`, `${usd(fs.usd, 2)} on ${fs.trades} Nought trade${fs.trades === 1 ? '' : 's'}`, fs.sol > 0 ? 'up' : '', 'What a typical 1% terminal fee would have cost on trades you made in Nought in this browser. Nought charges 0%.')}
  </div>`;
  const totalPnl = M.perf.reduce((s, r) => s + (r.pnlSol || 0), 0), totalPnlUsd = M.perf.reduce((s, r) => s + (r.pnlUsd || 0), 0);
  const counts = BUCKETS.map((k) => M.perf.filter((r) => k.t(r.pnlPct)).length), max = Math.max(1, ...counts);
  const perf = `<section class="pf-card pf-perf"><div class="pf-card-h"><h3>Performance</h3><span class="pf-mut">${M.perf.length} coin${M.perf.length === 1 ? '' : 's'} with a known cost</span></div>
    <div class="pf-total"><span class="eyebrow">Total PnL</span><b class="${tone(totalPnl)}">${fSol(totalPnl, true)} SOL</b><em>${fUsd(totalPnlUsd, true)}</em></div>
    <div class="pf-bks">${BUCKETS.map((k, i) => `<div class="pf-bk"><span>${k.label}</span><i>${counts[i] ? `<s class="${k.c}" style="width:${((counts[i] / max) * 100).toFixed(1)}%"></s>` : ''}</i><b class="${counts[i] ? '' : 'dim'}">${counts[i]}</b></div>`).join('')}</div></section>`;
  const chart = `<section class="pf-card pf-chart"><div class="pf-card-h"><h3>Realized PnL</h3><div class="pf-seg">${Object.keys(RANGES).map((r) => `<button data-range="${r}" class="${r === TAB_STATE.range ? 'on' : ''}">${r === 'max' ? 'Max' : r.toUpperCase()}</button>`).join('')}</div></div>${pnlChart(M.events, TAB_STATE.range)}</section>`;
  return stats + `<div class="pf-duo">${perf}${chart}</div>` + positionsHtml(b, M) + historyHtml(b, M);
}

// Realized PnL per day over the range (per hour on 1D, per week when Max spans months): green and red bars from the
// zero line, the largest gain (and loss) on the axis. With fewer than 3 active days it draws dots with their values, so
// one sell reads as a point rather than a spike at the edge.
const sod = (y, m, d) => new Date(y, m, d).getTime();
function pnlBuckets(events, range) {
  const now = new Date();
  if (range === '1d') {
    const h0 = new Date(now); h0.setMinutes(0, 0, 0); const t0 = h0.getTime() - 23 * 3600e3;
    return { n: 24, from: t0, idx: (at) => Math.floor((at - t0) / 3600e3), at: (i) => t0 + i * 3600e3, label: (ms) => `${String(new Date(ms).getHours()).padStart(2, '0')}:00` };
  }
  const Y = now.getFullYear(), M = now.getMonth(), D = now.getDate(), today = sod(Y, M, D);
  let days = range === '7d' ? 7 : 30, per = 1;
  if (range === 'max') {
    const first = events.reduce((m, e) => Math.min(m, e.at), Infinity), f = new Date(isFinite(first) ? first : today);
    days = Math.max(7, Math.round((today - sod(f.getFullYear(), f.getMonth(), f.getDate())) / 864e5) + 1);
    if (days > 120) per = 7;
  }
  const n = Math.ceil(days / per), back = n * per - 1, base = sod(Y, M, D - back);
  const dayOf = (at) => { const d = new Date(at); return Math.round((sod(d.getFullYear(), d.getMonth(), d.getDate()) - base) / 864e5); }; // rounding absorbs DST hours
  return { n, from: base, idx: (at) => Math.floor(dayOf(at) / per), at: (i) => sod(Y, M, D - back + i * per), label: (ms) => { const d = new Date(ms); return `${MON[d.getMonth()]} ${d.getDate()}`; } };
}
function pnlChart(events, range) {
  const B = pnlBuckets(events, range), ev = events.filter((e) => e.at >= B.from);
  const span = range === 'max' ? 'in all' : 'in the last ' + { '1d': 'day', '7d': '7 days', '30d': '30 days' }[range];
  if (!ev.length) return `<div class="pf-chart-empty">No sells ${range === 'max' ? 'found yet' : 'in this range'}. Realized PnL shows here as you close trades.</div>`;
  const v = Array.from({ length: B.n }, (_, i) => ({ i, sol: 0, usd: 0, k: 0 }));
  for (const e of ev) { const x = v[B.idx(e.at)]; if (x) { x.sol += e.sol; x.usd += e.usd; x.k++; } }
  const hit = v.filter((x) => x.k), run = ev.reduce((t, e) => t + e.sol, 0), c = tone(run);
  const hi = Math.max(0, ...hit.map((x) => x.sol)), lo = Math.min(0, ...hit.map((x) => x.sol)), sp = hi - lo || 1;
  const Yp = (y) => (((hi - y) / sp) * 100).toFixed(2), X = (i) => (((i + 0.5) / B.n) * 100).toFixed(2), y0 = Yp(0);
  const tip = (x) => esc(`${B.label(B.at(x.i))}: ${fSol(x.sol, true)} SOL · ${fUsd(x.usd, true)} · ${x.k} sell${x.k === 1 ? '' : 's'}`);
  // axis: 0, plus the largest gain and loss when they sit clear of the zero line
  let marks = `<i class="pf-gl z" style="top:${y0}%"></i><span class="pf-yl" style="top:${y0}%">0</span>`;
  if (hi > 0 && Yp(0) > 14) marks += `<i class="pf-gl" style="top:0%"></i><span class="pf-yl" style="top:0%">${fSol(hi, true)}</span>`;
  if (lo < 0 && 100 - Yp(0) > 14) marks += `<i class="pf-gl" style="top:100%"></i><span class="pf-yl" style="top:100%">${fSol(lo, true)}</span>`;
  const plot = hit.length < 3
    ? hit.map((x) => { const t = tone(x.sol) || 'flat', y = Yp(x.sol), al = X(x.i) > 80 ? ' r' : ''; return `<i class="pf-stem ${t}" style="left:${X(x.i)}%;top:${Math.min(y, y0)}%;height:${Math.abs(y - y0).toFixed(2)}%"></i><i class="pf-dot ${t}" style="left:${X(x.i)}%;top:${y}%" title="${tip(x)}"></i><span class="pf-dl ${t}${al}" style="left:${X(x.i)}%;top:${y}%">${fSol(x.sol, true)}</span>`; }).join('')
    : hit.map((x) => (x.sol >= 0
      ? `<b class="pf-pb up" style="left:${X(x.i)}%;bottom:${(100 - y0).toFixed(2)}%;height:${(y0 - Yp(x.sol)).toFixed(2)}%" title="${tip(x)}"></b>`
      : `<b class="pf-pb down" style="left:${X(x.i)}%;top:${y0}%;height:${(Yp(x.sol) - y0).toFixed(2)}%" title="${tip(x)}"></b>`)).join('');
  const picks = B.n <= 7 ? v.map((x) => x.i) : [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * (B.n - 1))))];
  // up to 7 day labels (every other one on a phone), or 5 spread ones with the outer two kept inside the edges
  const xl = picks.map((i, k) => `<span class="${B.n > 7 ? (k === 0 ? 'l' : k === picks.length - 1 ? 'r' : '') : k % 2 ? 'o' : ''}" style="left:${X(i)}%">${B.label(B.at(i))}</span>`).join('');
  return `<div class="pf-chart-v"><b class="${c}">${fSol(run, true)} SOL</b><span>${fUsd(ev.reduce((t, e) => t + e.usd, 0), true)} · ${ev.length} sell${ev.length === 1 ? '' : 's'} ${span}</span></div>
    <div class="pf-pc" style="--n:${B.n}" role="img" aria-label="Realized PnL per ${range === '1d' ? 'hour' : 'day'}, ${esc(fSol(run, true))} SOL ${span}"><div class="pf-plot">${marks}${plot}</div><div class="pf-xl">${xl}</div></div>`;
}

function positionsHtml(b, M) {
  const sell = canSell();
  const big = M.held.filter((r) => r.base || (r.valueUsd ?? 0) >= DUST_USD || r.p), small = M.held.length - big.length;
  const rows = b.showDust ? M.held.slice(0, 400) : big;
  const status = b.pending ? `Loading cost basis · ${b.pending} left` : M.held.length > PRICE_CAP ? `Valued the first ${PRICE_CAP} of ${M.held.length} coins` : `${M.priced} of ${M.held.length} priced`;
  const body = rows.length ? rows.map((r) => {
    const p = r.p, m = r.m, entryMc = p?.avgEntryUsd && m.supply ? p.avgEntryUsd * m.supply : null;
    const wait = r.waiting ? '<span class="pf-ld"></span>' : '—';
    const flags = p ? [p.unknown ? '<span class="pf-flag" title="Sold more than the buys found: some tokens came in by transfer, so their cost is unknown">basis?</span>' : '', p.partial ? `<span class="pf-flag" title="${esc(p.err || `Only the latest ${MAX_PAGES * 30} trades were read`)}">partial</span>` : ''].join('') : '';
    const sellBtns = sell && !r.base && !r.frozen ? [25, 50, 100].map((v) => `<button class="pf-sell" data-sell="${esc(r.mint)}" data-pct="${v}" title="Sell ${v}% (you review the quote first)">${v === 100 ? 'All' : v + '%'}</button>`).join('') : '';
    const share = p && p.bought > 0 && r.pnlSol != null ? `<button class="pf-ic" data-share="${esc(r.mint)}" title="Make a PnL card" aria-label="Make a PnL card">${SHARE}</button>` : '';
    return `<tr data-mint="${esc(r.mint)}">
      <td>${tokCell(m)}</td>
      <td class="r">${fTok(r.ui)}${r.frozen ? ' <span class="pf-flag down" title="Frozen by the token">frozen</span>' : ''}</td>
      <td class="r">${usd(r.valueUsd, 2)}<em>${r.valueSol != null ? fSol(r.valueSol) + ' SOL' : 'no price'}</em></td>
      <td class="r">${r.base ? '' : entryMc ? usd(entryMc) : p && !p.bought ? '<span class="dim" title="No buys found: received by transfer or airdrop">no buys</span>' : wait}${p?.avgEntryUsd ? `<em>$${px(p.avgEntryUsd)}</em>` : ''}</td>
      <td class="r">${p ? fSol(p.invested) : r.base ? '' : wait}${p ? `<em>${p.buys} buy${p.buys === 1 ? '' : 's'}</em>` : ''}</td>
      <td class="r">${p ? fSol(p.sold) : ''}${p?.sells ? `<em class="${tone(p.realized)}">${fSol(p.realized, true)} real.</em>` : ''}</td>
      <td class="r ${tone(r.unrealSol)}">${r.unrealSol != null ? fSol(r.unrealSol, true) : ''}${r.unrealUsd != null ? `<em>${fUsd(r.unrealUsd, true)}</em>` : ''}</td>
      <td class="r ${tone(r.pnlSol)}">${r.pnlSol != null ? fSol(r.pnlSol, true) : ''}${r.pnlPct != null ? `<em>${pct(r.pnlPct)}</em>` : ''}${flags}</td>
      <td class="pf-act">${sellBtns}${share}</td></tr>`;
  }).join('') : '';
  return `<section class="pf-card"><div class="pf-card-h"><h3>Active positions <span class="pf-n">${big.length}</span></h3><span class="pf-mut">${status}</span>${sell ? '<span class="pf-fee">Nought fee 0% on sells</span>' : ''}</div>
    ${tbl(`<th>Token</th><th class="r">Holding</th><th class="r">Value</th><th class="r">Avg entry MC</th><th class="r">Bought (SOL)</th><th class="r">Sold (SOL)</th><th class="r">Unrealized</th><th class="r">Total PnL</th><th class="r">${sell ? 'Sell' : ''}</th>`, body, emptyBox('No open positions', 'This wallet holds no tokens right now.'))}
    ${small ? `<button class="pf-more" data-act="dust">${b.showDust ? 'Hide' : 'Show'} ${small} small or unpriced balance${small === 1 ? '' : 's'}</button>` : ''}</section>`;
}

function historyHtml(b, M) {
  const left = M.cands.length - M.shown.length;
  const body = M.closed.length ? M.closed.map((r) => `<tr data-mint="${esc(r.mint)}">
      <td>${tokCell(r.m)}</td>
      <td class="r">${fSol(r.p.invested)}</td><td class="r">${fSol(r.p.sold)}</td>
      <td class="r ${tone(r.pnlSol)}">${fSol(r.pnlSol, true)}<em>${fUsd(r.pnlUsd, true)}</em></td>
      <td class="r ${tone(r.pnlSol)}">${r.pnlPct != null ? pct(r.pnlPct) : '—'}${r.p.unknown ? '<span class="pf-flag" title="Some tokens came in by transfer, so part of the cost is unknown">basis?</span>' : ''}${r.p.partial ? '<span class="pf-flag" title="Only the latest trades were read">partial</span>' : ''}</td>
      <td class="r">${nTone(r.p.buys, 'up')}/${nTone(r.p.sells, 'down')}</td>
      <td class="r">${dur(r.p.last - r.p.first)}</td>
      <td class="r"><span data-age="${r.p.last}">${ago(r.p.last)}</span></td>
      <td class="pf-act"><button class="pf-ic" data-share="${esc(r.mint)}" title="Make a PnL card" aria-label="Make a PnL card">${SHARE}</button></td></tr>`).join('')
    : '';
  return `<section class="pf-card"><div class="pf-card-h"><h3>History <span class="pf-n">${M.closed.length}</span></h3><span class="pf-mut">Checked ${M.shown.length} of ${M.cands.length} closed coin${M.cands.length === 1 ? '' : 's'}${M.noTrades ? ` · ${M.noTrades} had no trades (airdrops or transfers)` : ''}</span></div>
    ${tbl('<th>Token</th><th class="r">Bought (SOL)</th><th class="r">Sold (SOL)</th><th class="r">Realized PnL</th><th class="r">Return</th><th class="r">Buys/sells</th><th class="r">Held</th><th class="r">Last trade</th><th></th>', body, M.waitingClosed ? loadingRows(3) : emptyBox('No closed positions found', M.cands.length ? 'None of the coins checked so far has trades on record.' : 'This wallet has no closed token accounts and no Nought trades in this browser.'))}
    ${left > 0 ? `<button class="pf-more" data-act="more"${b.pending ? ' disabled' : ''}>Check ${Math.min(PAGE_CLOSED, left)} more (${left} left)</button>` : ''}
    <p class="pf-fine">Cost basis comes from Jupiter's trade index plus the Nought trades logged in this browser, at your average entry. Nought can only find coins whose token accounts still exist in this wallet or that you traded in Nought here: coins whose accounts were closed elsewhere are missing. Tokens received by transfer have no cost, so their PnL is marked "basis?".</p></section>`;
}

// ---- Activity ----
function activityHtml(b, M) {
  const f = M.fills.filter((x) => TAB_STATE.af === 'all' || x.side === TAB_STATE.af).sort((x, y) => y.at - x.at);
  const coins = new Set(M.fills.map((x) => x.mint)).size, loading = !!(b.pending || b.busy);
  const rows = f.slice(0, TAB_STATE.aLimit).map((x) => {
    const mc = x.priceUsd > 0 && x.m.supply ? x.priceUsd * x.m.supply : null;
    return `<tr data-mint="${esc(x.mint)}"><td><span data-age="${x.at}">${ago(x.at)}</span></td>
      <td class="${x.side === 'buy' ? 'up' : 'down'}">${x.side === 'buy' ? 'Buy' : 'Sell'}${x.nought ? ' <span class="pf-flag acc" title="Made in Nought">N</span>' : ''}</td>
      <td>${tokCell(x.m)}</td><td class="r">${fTok(x.tokens)}</td><td class="r ${x.side === 'buy' ? 'up' : 'down'}">${fSol(x.sol)}</td><td class="r">${usd(x.usd, 2)}</td>
      <td class="r">${mc ? usd(mc) : '—'}</td>
      <td class="r">${SIG.test(x.sig) ? `<a href="https://solscan.io/tx/${esc(x.sig)}" target="_blank" rel="noopener" title="Open on Solscan">Solscan</a>` : '—'}</td></tr>`;
  }).join('');
  return `<section class="pf-card"><div class="pf-card-h"><h3>Activity <span class="pf-n">${f.length}</span></h3>
      <div class="pf-seg">${[['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']].map(([v, l]) => `<button data-af="${v}" class="${v === TAB_STATE.af ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="pf-mut">${coins} coin${coins === 1 ? '' : 's'} · ${loading ? 'loading more…' : 'newest first'}</span></div>
    ${tbl('<th>Age</th><th>Type</th><th>Token</th><th class="r">Amount</th><th class="r">SOL</th><th class="r">USD</th><th class="r">MC at fill</th><th class="r">Tx</th>', rows, loading ? loadingRows(4) : emptyBox('No fills yet', 'Trades for the coins this wallet holds or closed show up here.'))}
    ${f.length > TAB_STATE.aLimit ? `<button class="pf-more" data-act="amore">Show ${Math.min(200, f.length - TAB_STATE.aLimit)} more</button>` : ''}
    ${M.cands.length > M.shown.length ? `<button class="pf-more" data-act="more"${b.pending ? ' disabled' : ''}>Check older closed coins (${M.cands.length - M.shown.length} left)</button>` : ''}
    <p class="pf-fine">Fills come from Jupiter's trade index for the ${FILL_CAP} largest holdings and the closed coins checked so far, plus Nought trades logged in this browser (marked N). MC at fill uses today's supply.</p></section>`;
}

// ---- Calendar ----
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const fDay = (n) => { const a = Math.abs(n); return (n > 0 ? '+' : n < 0 ? '-' : '') + a.toFixed(a >= 10 ? 0 : a >= 1 ? 1 : 2); }; // fits a phone-width day cell
function calData(events, y, m) {
  const days = new Map();
  for (const e of events) { const d = new Date(e.at); if (d.getFullYear() !== y || d.getMonth() !== m) continue; const k = d.getDate(), v = days.get(k) || { sol: 0, usd: 0, n: 0 }; v.sol += e.sol; v.usd += e.usd; v.n++; days.set(k, v); }
  const list = [...days.values()];
  return { days, total: list.reduce((s, v) => s + v.sol, 0), totalUsd: list.reduce((s, v) => s + v.usd, 0), green: list.filter((v) => v.sol > 0).length, red: list.filter((v) => v.sol < 0).length, best: Math.max(0, ...list.map((v) => v.sol)), worst: Math.min(0, ...list.map((v) => v.sol)) };
}
function calendarHtml(b, M) {
  const now = new Date(), c = TAB_STATE.cal || (TAB_STATE.cal = { y: now.getFullYear(), m: now.getMonth() });
  const D = calData(M.events, c.y, c.m), first = (new Date(c.y, c.m, 1).getDay() + 6) % 7, n = new Date(c.y, c.m + 1, 0).getDate();
  const peak = Math.max(1e-9, D.best, -D.worst), isNow = c.y === now.getFullYear() && c.m === now.getMonth();
  let cells = '';
  for (let i = 0; i < first; i++) cells += '<div class="pf-day blank"></div>';
  for (let d = 1; d <= n; d++) {
    const v = D.days.get(d), a = v ? Math.min(1, Math.abs(v.sol) / peak) : 0, future = new Date(c.y, c.m, d) > now;
    cells += `<div class="pf-day ${v ? tone(v.sol) || 'flat' : ''}${isNow && d === now.getDate() ? ' today' : ''}${future ? ' fut' : ''}" style="--k:${a.toFixed(2)}"><span>${d}</span>${v ? `<b title="${fSol(v.sol, true)} SOL · ${fUsd(v.usd, true)}"><i class="lg">${fSol(v.sol, true)}</i><i class="sm">${fDay(v.sol)}</i></b><em>${v.n} sell${v.n === 1 ? '' : 's'}</em>` : ''}</div>`;
  }
  const more = M.cands.length > M.shown.length ? ` <button class="pf-link" data-act="more"${b.pending ? ' disabled' : ''}>Check ${Math.min(PAGE_CLOSED, M.cands.length - M.shown.length)} more closed coins</button>` : '';
  return `<section class="pf-card pf-cal"><div class="pf-card-h"><div class="pf-calnav"><button class="btn btn-ghost icon" data-cal="-1" aria-label="Previous month">‹</button><h3>${MONTHS[c.m]} ${c.y}</h3><button class="btn btn-ghost icon" data-cal="1" aria-label="Next month">›</button>${isNow ? '' : '<button class="btn btn-ghost" data-cal="0">This month</button>'}</div><button class="btn btn-ghost" data-act="calpng">Save PNG</button></div>
    <div class="pf-stats pf-calsum">${stat('Month', `${fSol(D.total, true)} SOL`, fUsd(D.totalUsd, true), tone(D.total))}${stat('Green days', String(D.green), '', D.green ? 'up' : '')}${stat('Red days', String(D.red), '', D.red ? 'down' : '')}${stat('Best day', D.best > 0 ? `${fSol(D.best, true)} SOL` : '—', '', D.best > 0 ? 'up' : '')}${stat('Worst day', D.worst < 0 ? `${fSol(D.worst, true)} SOL` : '—', '', D.worst < 0 ? 'down' : '')}</div>
    <div class="pf-calgrid">${DOW.map((d) => `<div class="pf-dow">${d}</div>`).join('')}${cells}</div>
    <p class="pf-fine">Each sell books its gain or loss against your average entry on the day it happened (your local time), in SOL. Counts the ${M.coins} coin${M.coins === 1 ? '' : 's'} loaded so far${b.pending ? ' (still loading)' : ''}.${more}</p></section>`;
}
function calendarPng(b, M) {
  const c = TAB_STATE.cal, D = calData(M.events, c.y, c.m), first = (new Date(c.y, c.m, 1).getDay() + 6) % 7, n = new Date(c.y, c.m + 1, 0).getDate();
  const rows = Math.ceil((first + n) / 7), cw = 156, ch = 104, pad = 52, top = 190, W = pad * 2 + cw * 7, H = top + 40 + rows * ch + 70;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d'), S = '"Geist", system-ui, sans-serif', Mo = '"Geist Mono", ui-monospace, monospace', up = '#2fd38b', down = '#ff5d6c', fg = '#e7e9ef', mut = '#7d8496';
  x.fillStyle = '#07080b'; x.fillRect(0, 0, W, H);
  x.lineCap = 'round'; x.strokeStyle = fg; x.lineWidth = 6; x.beginPath(); x.arc(pad + 16, 62, 16, 0, Math.PI * 2); x.stroke();
  x.strokeStyle = '#38d6f5'; x.lineWidth = 5; x.beginPath(); x.moveTo(pad + 4, 74); x.lineTo(pad + 28, 50); x.stroke();
  x.fillStyle = fg; x.font = `600 30px ${S}`; x.textBaseline = 'middle'; x.fillText('nought', pad + 46, 63);
  x.textAlign = 'right'; x.fillStyle = up; x.font = `600 22px ${Mo}`; x.fillText('0% fees', W - pad, 63); x.textAlign = 'left';
  x.fillStyle = fg; x.font = `700 40px ${S}`; x.fillText(`${MONTHS[c.m]} ${c.y}`, pad, 128);
  x.font = `600 30px ${Mo}`; x.fillStyle = D.total >= 0 ? up : down; x.textAlign = 'right'; x.fillText(`${fSol(D.total, true)} SOL`, W - pad, 128); x.textAlign = 'left';
  x.font = `500 18px ${S}`; x.fillStyle = mut; x.fillText(`Realized PnL · ${short(b.addr)} · ${D.green} green / ${D.red} red days`, pad, 166);
  DOW.forEach((d, i) => x.fillText(d, pad + i * cw + 10, top + 14));
  const peak = Math.max(1e-9, D.best, -D.worst);
  for (let d = 1; d <= n; d++) {
    const i = first + d - 1, X = pad + (i % 7) * cw, Y = top + 36 + Math.floor(i / 7) * ch, v = D.days.get(d);
    x.fillStyle = v ? (v.sol >= 0 ? `rgba(47,211,139,${0.1 + 0.5 * Math.min(1, v.sol / peak)})` : `rgba(255,93,108,${0.1 + 0.5 * Math.min(1, -v.sol / peak)})`) : '#0c0e13';
    x.fillRect(X + 3, Y + 3, cw - 6, ch - 6); x.strokeStyle = '#1b1f29'; x.lineWidth = 1; x.strokeRect(X + 3.5, Y + 3.5, cw - 7, ch - 7);
    x.fillStyle = mut; x.font = `500 16px ${Mo}`; x.fillText(String(d), X + 14, Y + 24);
    if (v) { x.fillStyle = fg; x.font = `600 22px ${Mo}`; x.fillText(fSol(v.sol, true), X + 14, Y + 62); x.fillStyle = mut; x.font = `400 14px ${S}`; x.fillText(`${v.n} sell${v.n === 1 ? '' : 's'}`, X + 14, Y + 86); }
  }
  x.fillStyle = mut; x.font = `400 16px ${S}`; x.fillText('Traded with zero platform fees · in SOL, local time', pad, H - 32);
  cv.toBlob((blob) => {
    if (!blob) { toast('Could not make the image.', 'err'); return; }
    const a = document.createElement('a'), u = URL.createObjectURL(blob);
    a.href = u; a.download = `nought-calendar-${c.y}-${String(c.m + 1).padStart(2, '0')}.png`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 4000);
  }, 'image/png');
}

// ---- Perps (Hyperliquid, read-only) ----
const isEvm = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
const perps = { addr: isEvm(LS.get('pf.evm', '')) ? LS.get('pf.evm', '') : '', st: null, orders: [], fills: [], at: 0, fillsAt: 0, err: '', busy: false };
const hl = (body) => hlInfo(body, { ttl: 5000 });
async function loadPerps(force = false) {
  const a = perps.addr;
  if (!isEvm(a) || perps.busy) return;
  if (!force && Date.now() - perps.at < 14000) return;
  perps.busy = true; paint();
  try {
    const needFills = force || Date.now() - perps.fillsAt > 60e3;
    const [st, oo, fl] = await Promise.all([hl({ type: 'clearinghouseState', user: a }), hl({ type: 'openOrders', user: a }), needFills ? hl({ type: 'userFills', user: a }) : null]);
    if (a !== perps.addr) return;
    if (!st || typeof st !== 'object' || !st.marginSummary) throw new Error('Unexpected answer from Hyperliquid.');
    perps.st = st; perps.orders = Array.isArray(oo) ? oo : [];
    if (needFills) { perps.fills = Array.isArray(fl) ? fl : []; perps.fillsAt = Date.now(); }
    perps.at = Date.now(); perps.err = '';
  } catch (e) { if (a === perps.addr) { perps.err = e.message || 'Hyperliquid did not answer.'; perps.at = Date.now(); } }
  finally { perps.busy = false; paint(); }
}
function perpsHtml() {
  const note = '<p class="pf-fine">Read-only, from Hyperliquid\'s public API. Paste any address to look; Nought never asks for keys here and adds no fee. Funding and fees shown are Hyperliquid\'s own.</p>';
  if (!perps.addr) return emptyBox('Paste an EVM address', 'See any Hyperliquid account: open positions, margin, PnL, open orders and recent fills.') + note;
  const s = perps.st;
  if (!s) return perps.err && !perps.busy ? emptyBox('Could not load this account', esc(perps.err), '<button class="btn" data-act="retry">Try again</button>') : skelStats() + loadingRows(5);
  const ms = s.marginSummary || {}, pos = (Array.isArray(s.assetPositions) ? s.assetPositions : []).map((x) => x?.position).filter((p) => p && p.coin && N(p.szi));
  const upnl = pos.reduce((t, p) => t + N(p.unrealizedPnl), 0), val = N(ms.accountValue), ntl = N(ms.totalNtlPos);
  const fills = perps.fills, realized = fills.reduce((t, f) => t + N(f.closedPnl) - N(f.fee), 0);
  const stats = `<div class="pf-stats">
    ${stat('Account value', usd(val, 2), `withdrawable ${usd(N(s.withdrawable), 2)}`)}
    ${stat('Unrealized PnL', fUsd(upnl, true), `${pos.length} position${pos.length === 1 ? '' : 's'}`, tone(upnl))}
    ${stat('Margin used', usd(N(ms.totalMarginUsed), 2), val > 0 ? `${((N(ms.totalMarginUsed) / val) * 100).toFixed(1)}% of value` : '')}
    ${stat('Open notional', usd(ntl, 2), val > 0 ? `${(ntl / val).toFixed(2)}x account leverage` : '')}
    ${stat('Realized (fills)', fUsd(realized, true), `last ${fills.length} fills, after fees`, tone(realized))}
    ${stat('Open orders', String(perps.orders.length), perps.at ? `updated <span data-age="${perps.at}">${ago(perps.at)}</span> ago` : '')}
  </div>`;
  const posRows = pos.length ? pos.map((p) => {
    const sz = N(p.szi), size = Math.abs(sz), value = N(p.positionValue), mark = size ? value / size : 0, u = N(p.unrealizedPnl), lev = p.leverage || {}, fund = -N(p.cumFunding?.sinceOpen);
    return `<tr><td><b>${esc(p.coin)}</b></td><td class="${sz > 0 ? 'up' : 'down'}">${sz > 0 ? 'Long' : 'Short'}</td><td class="r">${px(size)}</td><td class="r">${px(p.entryPx)}</td><td class="r">${px(mark)}</td><td class="r">${usd(value, 2)}</td>
      <td class="r ${tone(u)}">${fUsd(u, true)}<em>${pct(N(p.returnOnEquity) * 100)}</em></td><td class="r">${p.liquidationPx ? px(p.liquidationPx) : '—'}</td>
      <td class="r">${usd(N(p.marginUsed), 2)}<em>${N(lev.value)}x ${lev.type === 'isolated' ? 'isolated' : 'cross'}</em></td><td class="r ${tone(fund)}" title="Funding since the position opened (negative = paid)">${fUsd(fund, true)}</td></tr>`;
  }).join('') : '';
  const ordRows = perps.orders.length ? perps.orders.slice(0, 100).map((o) => `<tr><td><b>${esc(o.coin)}</b></td><td class="${o.side === 'B' ? 'up' : 'down'}">${o.side === 'B' ? 'Buy' : 'Sell'}</td><td class="r">${px(o.limitPx)}</td><td class="r">${px(o.sz)}</td><td class="r">${px(N(o.origSz) - N(o.sz))}</td><td class="r">${usd(N(o.limitPx) * N(o.sz), 2)}</td><td class="r"><span data-age="${N(o.timestamp)}">${ago(N(o.timestamp))}</span></td></tr>`).join('')
    : '';
  const fillRows = fills.length ? fills.slice(0, 100).map((f) => { const cp = N(f.closedPnl), dir = String(f.dir || (f.side === 'B' ? 'Buy' : 'Sell')); return `<tr><td><span data-age="${N(f.time)}">${ago(N(f.time))}</span></td><td><b>${esc(f.coin)}</b></td><td class="${f.side === 'B' ? 'up' : 'down'}">${esc(dir)}</td><td class="r">${px(f.px)}</td><td class="r">${px(f.sz)}</td><td class="r">${usd(N(f.px) * N(f.sz), 2)}</td><td class="r ${tone(cp)}">${cp ? fUsd(cp, true) : '—'}</td><td class="r">${fUsd(-N(f.fee), true)}</td></tr>`; }).join('')
    : '';
  return `<div class="pf-addr"><span class="mono">${esc(perps.addr)}</span><button class="copy" data-copy="${esc(perps.addr)}" title="Copy address">${ICON.copy}</button><a href="https://app.hyperliquid.xyz/explorer/address/${esc(perps.addr)}" target="_blank" rel="noopener">Explorer</a>${perps.busy ? '<span class="pf-spin"></span>' : ''}${perps.err ? `<span class="down">${esc(perps.err)}</span>` : ''}</div>
    ${stats}
    <section class="pf-card"><div class="pf-card-h"><h3>Positions <span class="pf-n">${pos.length}</span></h3></div>${tbl('<th>Market</th><th>Side</th><th class="r">Size</th><th class="r">Entry</th><th class="r">Mark</th><th class="r">Value</th><th class="r">PnL (ROE)</th><th class="r">Liq. price</th><th class="r">Margin</th><th class="r">Funding</th>', posRows, emptyBox('No open positions', 'This account has no perp positions right now.'))}</section>
    <section class="pf-card"><div class="pf-card-h"><h3>Open orders <span class="pf-n">${perps.orders.length}</span></h3></div>${tbl('<th>Market</th><th>Side</th><th class="r">Price</th><th class="r">Size</th><th class="r">Filled</th><th class="r">Value</th><th class="r">Age</th>', ordRows, '<div class="pf-mini">No open orders.</div>')}</section>
    <section class="pf-card"><div class="pf-card-h"><h3>Recent fills <span class="pf-n">${fills.length}</span></h3><span class="pf-mut">newest 100 shown</span></div>${tbl('<th>Age</th><th>Market</th><th>Direction</th><th class="r">Price</th><th class="r">Size</th><th class="r">Value</th><th class="r">Closed PnL</th><th class="r">Fee</th>', fillRows, '<div class="pf-mini">No fills on record.</div>')}</section>
    ${note}`;
}

// ---- interaction ----
function select(addr) {
  if (!ctx) return;
  LS.set('pf.sel', addr === 'active' || !isMint(addr) ? 'active' : addr);
  ctx.addr = currentAddr();
  renderWho(); renderBody();
  if (ctx.addr) ensure(book(ctx.addr));
}
function onSubmit(e) {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  const v = String(f.elements.a?.value || '').trim();
  if (f.dataset.form === 'evm') {
    if (!isEvm(v)) { toast('That is not an EVM address (0x and 40 hex characters).', 'err'); return; }
    if (v.toLowerCase() !== perps.addr.toLowerCase()) Object.assign(perps, { addr: v, st: null, orders: [], fills: [], at: 0, fillsAt: 0, err: '' });
    LS.set('pf.evm', v); syncTools(); renderBody(); loadPerps(true);
    return;
  }
  if (!isMint(v)) { toast('That is not a Solana address.', 'err'); return; }
  LS.set('pf.recent', [v, ...recents().filter((x) => x !== v)].slice(0, 6));
  select(v);
}
function onChange(e) { if (e.target.matches('[data-sel]')) select(e.target.value); }
function onClick(e) {
  const t = e.target.closest('button'); if (!t || !ctx) return;
  const b = ctx.addr ? book(ctx.addr) : null, act = t.dataset.act;
  if (t.dataset.range) { TAB_STATE.range = t.dataset.range; LS.set('pf.range', TAB_STATE.range); renderBody(); return; }
  if (t.dataset.af) { TAB_STATE.af = t.dataset.af; TAB_STATE.aLimit = 200; renderBody(); return; }
  if (t.dataset.cal) { const k = Number(t.dataset.cal), now = new Date(), c = TAB_STATE.cal || { y: now.getFullYear(), m: now.getMonth() }, d = k ? new Date(c.y, c.m + k, 1) : now; TAB_STATE.cal = { y: d.getFullYear(), m: d.getMonth() }; renderBody(); return; }
  if (t.dataset.sell) { const p = parseAmount(t.dataset.pct); if (isMint(t.dataset.sell) && p > 0 && p <= 100) sellFlow(t.dataset.sell, p); return; }
  if (t.dataset.share) { share(t.dataset.share); return; }
  if (act === 'widget') { togglePnlWidget(); renderWho(); return; }
  if (act === 'connect') { openWalletPicker(); return; }
  if (act === 'newlocal') { import('../ui/wallets.js').then((m) => m.openWalletManager('new')).catch(() => toast('The wallet manager did not load. Reload to try again.', 'err')); return; }
  if (act === 'paste') { const i = $('.pf-paste input', ctx.view); i?.focus(); i?.select?.(); return; }
  if (act === 'refresh' || act === 'retry') {
    if (ctx.tab === 'perps') { loadPerps(true); return; }
    if (b) { b.err = ''; b.warn = ''; ensure(b, true); renderBody(); }
    return;
  }
  if (!b) return;
  if (act === 'dust') { b.showDust = !b.showDust; renderBody(); }
  else if (act === 'more') { b.closedShown += PAGE_CLOSED; renderBody(); ensure(b); }
  else if (act === 'amore') { TAB_STATE.aLimit += 200; renderBody(); }
  else if (act === 'calpng') calendarPng(b, model(b));
}

function share(mint) {
  const b = ctx?.addr && book(ctx.addr); if (!b) return;
  const M = model(b), r = M.held.find((x) => x.mint === mint) || M.closed.find((x) => x.mint === mint);
  if (!r?.p) { toast('No trades found for this coin yet.', 'err'); return; }
  const data = { mint, symbol: r.m.symbol, image: r.m.image, investedSol: r.p.invested, soldSol: r.p.sold, pnlSol: r.pnlSol ?? r.p.realized, pnlPct: r.pnlPct, pnlUsd: r.pnlUsd ?? r.p.realizedUsd };
  import('../ui/pnlcard.js').then((m) => m.openPnlCard(data)).catch(() => toast('Could not open the PnL card.', 'err'));
}

// sell review: amount, token, what comes back and where it goes, every third-party fee and "Nought fee 0%". Confirming
// sells exactly the reviewed amount, with the minimum shown (contract C2 minOutRaw) and an impact cap.
const REVIEW_TTL = 60e3;
function sellFlow(mint, pctN) {
  const owner = ctx?.addr;
  if (!owner || owner !== wallet.owner) { toast('Make this the active wallet to sell from it.', 'err'); return; }
  const m = metaOf(mint), sym = symOf(m);
  let rev = null; // {raw (BigInt), minOutRaw, impactPct, danger, at}
  const d = document.createElement('dialog'); d.className = 'pfs-dlg';
  d.innerHTML = `<form method="dialog" class="dlg"><h2>Sell ${pctN}% of ${esc(sym)}</h2><div class="pf-q" data-q><div class="pf-mut">Getting a quote…</div></div>
    <div class="row-end"><button class="btn btn-ghost" value="cancel">Cancel</button><button class="btn pf-go" value="ok" data-go disabled>Sell ${pctN}%</button></div></form>`;
  document.body.appendChild(d);
  d.addEventListener('close', async () => {
    setTimeout(() => d.remove(), 0);
    if (d.returnValue !== 'ok' || !rev) return;
    if (wallet.owner !== owner) { toast('The active wallet changed, so nothing was sold.', 'err'); return; }
    if (Date.now() - rev.at > REVIEW_TTL) { toast('That quote is over a minute old, so nothing was sold. Open the sale again for a fresh one.', 'err'); return; }
    try {
      const h = await holding(mint, owner);
      if (h.frozen) { toast('This coin is frozen in your wallet, so it cannot be sold.', 'err'); return; }
      if (h.raw < rev.raw) { toast('Your balance changed since the review, so nothing was sold. Open the sale again.', 'err'); return; }
      const maxImpactPct = rev.danger ? Math.min(99, rev.impactPct + 10) : Math.max(DANGER_IMPACT, rev.impactPct + 5);
      await trade('sell', mint, rev.raw, { owner, minOutRaw: rev.minOutRaw, maxImpactPct, label: sym });
    } catch (e) { if ((await maybeLanded(e)) == null) toast(esc(e.message || 'The sale did not go through.'), 'err'); }
  });
  d.showModal();
  (async () => {
    const q = d.querySelector('[data-q]');
    const slow = setTimeout(() => { if (d.open && q.querySelector('.pf-mut')) q.innerHTML = '<div class="pf-mut">Jupiter is slow to answer right now. Still trying…</div>'; }, 8000);
    try {
      // the balance this page already read (under 90 s old); it is read again before anything is signed
      const known = books.get(owner)?.held.find((x) => x.mint === mint);
      const h = known && books.get(owner).at > Date.now() - 90e3 ? { raw: BigInt(known.raw), dec: known.dec, frozen: known.frozen } : await holding(mint, owner);
      if (h.frozen) throw new Error('This coin is frozen in your wallet, so it cannot be sold.');
      if (!(h.raw > 0n)) throw new Error('This wallet holds none of this coin now.');
      const raw = pctN >= 100 ? h.raw : (h.raw * BigInt(Math.round(pctN * 100))) / 10000n;
      if (raw <= 0n) throw new Error('That share of your balance rounds to zero.');
      const quote = await quoteFor(mint, SOL_MINT, raw.toString(), {});
      const dt = quoteDetails(quote, { inDec: h.dec, outDec: 9 }), w = impactWarning(dt, store.get(mint)?.liquidity), minOutRaw = dt.minOutRaw || quotedMin(quote);
      if (!minOutRaw || !(BigInt(minOutRaw) > 0n)) throw new Error('Jupiter sent a quote without a minimum. Try again.');
      if (!d.open) return;
      const minUi = Number(minOutRaw) / 1e9;
      const row = (k, v, c = '') => `<div><span>${k}</span><b class="${c}">${v}</b></div>`;
      q.innerHTML = row('You sell', `${fTok(dt.inUi)} ${esc(sym)}`)
        + row('You get about', `${fSolFix(dt.outUi)} SOL`, 'up') + row('At least', `${fSolFix(minUi)} SOL`)
        + row('Price impact', `${dt.impactPct.toFixed(2)}%`, dt.impactPct >= 5 ? 'down' : '')
        + row('Route', esc(dt.routeLabel)) + row('Mode', dt.mode === 'protected' ? 'MEV-protected (Jupiter Ultra)' : 'Standard route')
        + dt.fees.map((f) => row(esc(f.label), f.sol != null ? `${fFee(f.sol)} SOL${f.note ? ` <i>${esc(f.note)}</i>` : ''}` : f.bps != null ? `${(f.bps / 100).toFixed(2)}%` : `<i>${esc(f.note || '')}</i>`)).join('')
        + row('Nought fee', '0%', 'up') + row('SOL goes to', `${esc(short(owner))} (this wallet)`)
        + (w ? `<p class="pf-w ${w.level}">${esc(w.text)}</p>` : '') + '<p class="pf-mut">Your wallet asks you to approve. If the price moves so that "At least" can no longer be met, nothing is sent.</p>';
      rev = { raw, minOutRaw, impactPct: dt.impactPct, danger: w?.level === 'danger', at: Date.now() };
      const go = d.querySelector('[data-go]'); go.disabled = false; go.classList.toggle('danger', w?.level === 'danger');
    } catch (e) { if (d.open) q.innerHTML = `<div class="down">${esc(e.message || 'No quote right now. Try again in a moment.')}</div>`; }
    finally { clearTimeout(slow); }
  })();
}
