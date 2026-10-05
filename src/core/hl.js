// Hyperliquid public data: the info endpoint and one shared websocket. Read-only: nothing in here signs or sends funds.
// Every number from Hyperliquid arrives as a string; the parsers below turn them into numbers (null when missing).
//   info(body, {ttl})              POST https://api.hyperliquid.xyz/info, weight-budgeted, in-flight deduped, optional cache
//   markets()                      metaAndAssetCtxs → Market[] (delisted removed)
//   candles(coin, iv, {start,end}) candleSnapshot → [{time (s), open, high, low, close, volume}] oldest first
//   fundingHistory(coin, start)    → [{time (ms), rate (hourly fraction), premium}]
//   predictedFundings()            → Map(coin → [{venue, label, rate, hours, next (ms)}])
//   l2Book(coin, nSigFigs) · recentTrades(coin) · allMids() → {COIN: number} (10 s cache, for the status bar)
//   account(user) · openOrders(user) · fills(user)   read-only views of any 0x address
//   bookFeed(coin, nSigFigs, fn) · tradeFeed(coin, fn) · candleFeed(coin, iv, fn) · midsFeed(fn) → unsubscribe
//   wsState() → {ok, lastMsg} · onWs(fn) → unsubscribe
import { sleep } from './util.js';

export const HL_INFO = 'https://api.hyperliquid.xyz/info';
export const HL_WS = 'wss://api.hyperliquid.xyz/ws';
export const tradeUrl = (coin) => 'https://app.hyperliquid.xyz/trade/' + encodeURIComponent(String(coin || 'BTC'));
export const INTERVALS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 };
// Hyperliquid's base-tier perp fees (its own, never Nought's). Volume tiers and staking lower them.
export const HL_FEES = { taker: 0.045, maker: 0.015 };
export const MIN_ORDER_USD = 10;
export const COIN_RE = /^[A-Za-z0-9]{1,24}$/;
export const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
export const toNum = (x) => { if (x == null || x === '') return null; const v = Number(x); return Number.isFinite(v) ? v : null; };

// --- request budget: Hyperliquid allows 1,200 weight per minute per IP. Nought keeps itself to half of that.
const LIGHT = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);
const BUDGET = 600, WINDOW = 60e3, MAX_PARALLEL = 4;
const spent = []; let cool = 0, running = 0;
const pending = new Map(), cache = new Map();
async function slot(w) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0][0] > WINDOW) spent.shift();
    const used = spent.reduce((s, x) => s + x[1], 0);
    const wait = Math.max(cool - now, used + w > BUDGET && spent.length ? WINDOW - (now - spent[0][0]) + 25 : 0, running >= MAX_PARALLEL ? 60 : 0);
    if (wait <= 0) { spent.push([now, w]); running++; return; }
    await sleep(Math.min(wait, 2000));
  }
}
export async function info(body, { ttl = 0, ms = 12000 } = {}) {
  const key = JSON.stringify(body);
  const hit = ttl && cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    await slot(LIGHT.has(body.type) ? 2 : 20);
    try {
      let r;
      try { r = await fetch(HL_INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: key, signal: AbortSignal.timeout(ms) }); }
      catch (e) { throw new Error(e?.name === 'TimeoutError' ? 'Hyperliquid did not answer in time.' : 'Could not reach Hyperliquid.'); }
      if (r.status === 429) { cool = Date.now() + 15e3; throw new Error('Hyperliquid is rate limiting. Retrying shortly.'); }
      if (!r.ok) throw new Error(`Hyperliquid answered ${r.status}.`);
      const data = await r.json();
      if (ttl) cache.set(key, { at: Date.now(), data });
      return data;
    } finally { running--; }
  })();
  pending.set(key, p);
  p.finally(() => pending.delete(key)).catch(() => {});
  return p;
}

// --- markets
export async function markets() {
  const d = await info({ type: 'metaAndAssetCtxs' });
  if (!Array.isArray(d) || !Array.isArray(d[0]?.universe) || !Array.isArray(d[1])) throw new Error('Unexpected market data from Hyperliquid.');
  const out = [];
  d[0].universe.forEach((u, idx) => {
    const c = d[1][idx];
    if (!u || !c || u.isDelisted || typeof u.name !== 'string' || !COIN_RE.test(u.name)) return;
    const mark = toNum(c.markPx), prev = toNum(c.prevDayPx), oi = toNum(c.openInterest);
    if (mark == null) return;
    out.push({
      coin: u.name, idx, szDecimals: Math.max(0, Math.min(8, Number(u.szDecimals) | 0)), maxLeverage: Math.max(1, toNum(u.maxLeverage) || 1),
      onlyIsolated: !!u.onlyIsolated || /isolated/i.test(String(u.marginMode || '')),
      mark, mid: toNum(c.midPx), oracle: toNum(c.oraclePx), prevDay: prev, change: prev ? (mark / prev - 1) * 100 : null,
      funding: toNum(c.funding), premium: toNum(c.premium), oi, oiUsd: oi != null ? oi * mark : null,
      vol: toNum(c.dayNtlVlm), volBase: toNum(c.dayBaseVlm), impact: Array.isArray(c.impactPxs) ? c.impactPxs.map(toNum) : null,
    });
  });
  if (!out.length) throw new Error('Hyperliquid returned no markets.');
  return out;
}

// --- candles
export function parseCandle(c) {
  const b = { time: Math.floor(Number(c?.t) / 1000), open: toNum(c?.o), high: toNum(c?.h), low: toNum(c?.l), close: toNum(c?.c), volume: toNum(c?.v) || 0 };
  return Number.isFinite(b.time) && b.open != null && b.high != null && b.low != null && b.close != null ? b : null;
}
export async function candles(coin, interval, { start, end = Date.now() } = {}) {
  const step = INTERVALS[interval]; if (!step) throw new Error('Unknown interval.');
  const d = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: Math.floor(start ?? end - 400 * step), endTime: Math.floor(end) } });
  if (!Array.isArray(d)) return [];
  const seen = new Map();
  for (const c of d) { const b = parseCandle(c); if (b) seen.set(b.time, b); }
  return [...seen.values()].sort((a, b) => a.time - b.time);
}

// --- funding
export async function fundingHistory(coin, start = Date.now() - 7 * 86400e3, end) {
  const d = await info({ type: 'fundingHistory', coin, startTime: Math.floor(start), ...(end ? { endTime: Math.floor(end) } : {}) });
  if (!Array.isArray(d)) return [];
  return d.map((x) => ({ time: Number(x?.time), rate: toNum(x?.fundingRate), premium: toNum(x?.premium) })).filter((x) => Number.isFinite(x.time) && x.rate != null).sort((a, b) => a.time - b.time);
}
const VENUE = { HlPerp: 'Hyperliquid', BinPerp: 'Binance', BybitPerp: 'Bybit' };
export async function predictedFundings() {
  const d = await info({ type: 'predictedFundings' }, { ttl: 30e3 });
  if (!Array.isArray(d)) throw new Error('Unexpected funding data from Hyperliquid.');
  const out = new Map();
  for (const row of d) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) continue;
    out.set(row[0], row[1].filter((v) => Array.isArray(v) && v[1]).map(([venue, v]) => ({ venue: String(venue), label: VENUE[venue] || String(venue), rate: toNum(v.fundingRate), hours: toNum(v.fundingIntervalHours) || 1, next: toNum(v.nextFundingTime) })).filter((v) => v.rate != null));
  }
  return out;
}

// --- book, trades, mids
const lv = (x) => ({ px: toNum(x?.px), sz: toNum(x?.sz), n: Number(x?.n) || 0 });
export function parseBook(d) {
  if (!d || !Array.isArray(d.levels)) return null;
  const [b = [], a = []] = d.levels;
  return { coin: d.coin, time: Number(d.time) || Date.now(), bids: b.map(lv).filter((x) => x.px != null && x.sz != null), asks: a.map(lv).filter((x) => x.px != null && x.sz != null) };
}
export async function l2Book(coin, nSigFigs) { return parseBook(await info({ type: 'l2Book', coin, ...(nSigFigs ? { nSigFigs } : {}) })); }
export function parseTrade(t) {
  const px = toNum(t?.px), sz = toNum(t?.sz);
  return px == null || sz == null ? null : { coin: t.coin, px, sz, side: t.side === 'B' ? 'buy' : 'sell', time: Number(t.time) || Date.now(), tid: String(t.tid ?? ''), hash: typeof t.hash === 'string' ? t.hash : '' };
}
export async function recentTrades(coin) { const d = await info({ type: 'recentTrades', coin }); return Array.isArray(d) ? d.map(parseTrade).filter(Boolean) : []; }
let wsMids = null, wsMidsAt = 0;
const parseMids = (m) => { const o = {}; for (const [k, v] of Object.entries(m || {})) { if (k[0] === '@' || k[0] === '#') continue; const x = toNum(v); if (x != null) o[k] = x; } return o; };
/** Mid prices of every perp, e.g. allMids().then((m) => m.BTC). Cached 10 s, so calling it often is cheap. */
export async function allMids() {
  if (wsMids && Date.now() - wsMidsAt < 10e3) return wsMids;
  const d = await info({ type: 'allMids' }, { ttl: 10e3 });
  if (!d || typeof d !== 'object') throw new Error('Unexpected price data from Hyperliquid.');
  return parseMids(d);
}

// --- read-only account views (any address; no signature needed)
export async function account(user) {
  if (!isAddr(user)) throw new Error('That is not an EVM address.');
  const d = await info({ type: 'clearinghouseState', user });
  if (!d || !d.marginSummary) throw new Error('Unexpected account data from Hyperliquid.');
  const ms = d.marginSummary;
  return {
    value: toNum(ms.accountValue), ntl: toNum(ms.totalNtlPos), marginUsed: toNum(ms.totalMarginUsed), withdrawable: toNum(d.withdrawable), maint: toNum(d.crossMaintenanceMarginUsed),
    positions: (d.assetPositions || []).map((p) => p?.position).filter(Boolean).map((p) => ({
      coin: String(p.coin), size: toNum(p.szi) || 0, entry: toNum(p.entryPx), value: toNum(p.positionValue), upnl: toNum(p.unrealizedPnl), roe: toNum(p.returnOnEquity),
      liq: toNum(p.liquidationPx), marginUsed: toNum(p.marginUsed), lev: { type: p.leverage?.type === 'isolated' ? 'isolated' : 'cross', value: toNum(p.leverage?.value) }, funding: toNum(p.cumFunding?.sinceOpen),
    })),
  };
}
export async function openOrders(user) {
  if (!isAddr(user)) throw new Error('That is not an EVM address.');
  const d = await info({ type: 'frontendOpenOrders', user });
  if (!Array.isArray(d)) throw new Error('Unexpected order data from Hyperliquid.');
  return d.map((o) => ({ coin: String(o.coin), side: o.side === 'B' ? 'buy' : 'sell', px: toNum(o.limitPx), sz: toNum(o.sz), origSz: toNum(o.origSz), oid: String(o.oid ?? ''), time: Number(o.timestamp) || 0, type: String(o.orderType || 'Limit'), trigger: o.isTrigger ? String(o.triggerCondition || '') : '', triggerPx: toNum(o.triggerPx), reduceOnly: !!o.reduceOnly, tif: o.tif ? String(o.tif) : '' }));
}
export async function fills(user, limit = 200) {
  if (!isAddr(user)) throw new Error('That is not an EVM address.');
  const d = await info({ type: 'userFills', user });
  if (!Array.isArray(d)) throw new Error('Unexpected fill data from Hyperliquid.');
  return d.slice(0, limit).map((f) => ({ coin: String(f.coin), px: toNum(f.px), sz: toNum(f.sz), side: f.side === 'B' ? 'buy' : 'sell', time: Number(f.time) || 0, dir: String(f.dir || ''), pnl: toNum(f.closedPnl), fee: toNum(f.fee), builderFee: toNum(f.builderFee) || 0, feeToken: String(f.feeToken || 'USDC'), hash: typeof f.hash === 'string' ? f.hash : '' }));
}

// --- websocket: one shared socket, reference-counted subscriptions, ping every 50 s, reconnect with backoff 1 s → 30 s
const ws = { sock: null, subs: new Map(), wait: 1000, retry: 0, ping: 0, idle: 0, ok: false, lastMsg: 0, listeners: new Set() };
export const wsState = () => ({ ok: ws.ok, lastMsg: ws.lastMsg });
export const onWs = (fn) => { ws.listeners.add(fn); return () => ws.listeners.delete(fn); };
const notify = () => ws.listeners.forEach((fn) => { try { fn(wsState()); } catch (e) { console.error(e); } });
const subKey = (s) => JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
const subRoute = (s) => (s.type === 'allMids' ? 'allMids' : s.type === 'candle' ? `candle:${s.coin}:${s.interval}` : `${s.type}:${s.coin}`);
function msgRoute(m) {
  const d = m?.data;
  if (m?.channel === 'allMids') return 'allMids';
  if (m?.channel === 'l2Book') return 'l2Book:' + d?.coin;
  if (m?.channel === 'trades') return Array.isArray(d) && d.length ? 'trades:' + d[0]?.coin : null;
  if (m?.channel === 'candle') return `candle:${d?.s}:${d?.i}`;
  return null;
}
const send = (m) => { if (ws.sock?.readyState === 1) ws.sock.send(JSON.stringify(m)); };
function open() {
  if (ws.sock || ws.retry || typeof WebSocket === 'undefined') return;
  let s;
  try { s = new WebSocket(HL_WS); } catch { schedule(); return; }
  ws.sock = s;
  s.onopen = () => {
    ws.ok = true; ws.lastMsg = Date.now();
    for (const e of ws.subs.values()) send({ method: 'subscribe', subscription: e.sub });
    clearInterval(ws.ping);
    ws.ping = setInterval(() => { if (Date.now() - ws.lastMsg > 75e3) { try { s.close(); } catch { /* gone */ } return; } send({ method: 'ping' }); }, 50e3);
    notify();
  };
  s.onmessage = (ev) => {
    ws.lastMsg = Date.now(); ws.wait = 1000;
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m?.channel === 'error') { console.warn('Hyperliquid socket:', String(m.data).slice(0, 200)); return; }
    const r = msgRoute(m); if (!r) return;
    if (r === 'allMids') { wsMids = parseMids(m.data?.mids); wsMidsAt = Date.now(); }
    for (const e of ws.subs.values()) if (e.route === r) e.fns.forEach((fn) => { try { fn(m.data); } catch (err) { console.error(err); } });
  };
  s.onclose = () => { clearInterval(ws.ping); if (ws.sock === s) ws.sock = null; ws.ok = false; notify(); if (ws.subs.size) schedule(); };
  s.onerror = () => { try { s.close(); } catch { /* closing */ } };
}
function schedule() { if (ws.retry) return; ws.retry = setTimeout(() => { ws.retry = 0; open(); }, ws.wait); ws.wait = Math.min(ws.wait * 2, 30e3); }
function shut() {
  if (ws.subs.size) return;
  clearTimeout(ws.retry); ws.retry = 0; clearInterval(ws.ping);
  const s = ws.sock; ws.sock = null; ws.ok = false;
  if (s) { s.onclose = null; s.onerror = null; s.onmessage = null; try { s.close(); } catch { /* closed */ } }
  notify();
}
/** Low-level: subscribe to a raw Hyperliquid subscription; fn gets the raw `data`. Returns an unsubscribe. */
export function subscribe(sub, fn) {
  const key = subKey(sub);
  let e = ws.subs.get(key);
  if (!e) { e = { sub, route: subRoute(sub), fns: new Set() }; ws.subs.set(key, e); send({ method: 'subscribe', subscription: sub }); }
  e.fns.add(fn);
  clearTimeout(ws.idle); open();
  let done = false;
  return () => {
    if (done) return; done = true;
    e.fns.delete(fn);
    if (e.fns.size || ws.subs.get(key) !== e) return;
    ws.subs.delete(key); send({ method: 'unsubscribe', subscription: sub });
    if (!ws.subs.size) { clearTimeout(ws.idle); ws.idle = setTimeout(shut, 20e3); } // stay open briefly for the next page
  };
}
// Note: messages don't say which nSigFigs they were grouped by, so keep one book subscription per coin at a time.
export const bookFeed = (coin, nSigFigs, fn) => subscribe({ type: 'l2Book', coin, ...(nSigFigs ? { nSigFigs } : {}) }, (d) => { const b = parseBook(d); if (b) fn(b); });
export const tradeFeed = (coin, fn) => subscribe({ type: 'trades', coin }, (d) => { const t = (Array.isArray(d) ? d : []).map(parseTrade).filter(Boolean); if (t.length) fn(t); });
export const candleFeed = (coin, interval, fn) => subscribe({ type: 'candle', coin, interval }, (d) => { const b = parseCandle(d); if (b) fn(b); });
export const midsFeed = (fn) => subscribe({ type: 'allMids' }, (d) => fn(parseMids(d?.mids)));
