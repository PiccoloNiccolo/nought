// Token page chart. Candles come from Jupiter's chart data (jc: bonding curve and migrated pool in one series). The
// first load asks for 1,000 bars, scrolling left pages back, the last bars refresh every 3 s (paused while the tab is
// hidden) and live trades from watchTrades() move the last bar in between. Volume, SMA 20 and EMA 50 are computed
// here. Markers: your fills, the dev's buys and sells, the migration, plus anything another tab adds through
// ctx.chart.addMarkers(). Lines: your limit orders, armed TP/SL legs, the pump.fun migration market cap, plus lines
// another tab sets through ctx.chart.setLines().
//
//   chartBridge()                 → { api: {addMarkers, setLines}, ... }   token.js puts api on ctx.chart
//   mountChart(el, ctx, bridge)   → cleanup
//   addMarkers(markers[], group?) markers are lightweight-charts markers with `time` in unix SECONDS (UTC); an optional
//                                 group name replaces that group's earlier markers instead of adding to them
//   setLines(lines[])             [{price (USD per token), color, title, id}] (or {mc} = USD market cap instead of
//                                 price); replaces the previous set. The chart converts to MC / SOL as needed.
// Also exports the number helpers the token page shares: fmtPrice (subscript-zero prices), parseNum (= core
// parseTarget: "50k" → 50000, ambiguous "1,500" → NaN), supplyOf (the coin's known supply or null, from instant.js).
import { $$, esc, LS, usd, num, parseTarget } from '../../core/util.js';
import { jc, jx } from '../../core/jup.js';
import { solUsd } from '../../core/price.js';
import { wallet, tradeOwners } from '../../core/wallet.js';
import { limit, armed } from '../../core/orders.js';
import { watchTrades } from '../../core/stream.js';
import { fillsFor, supplyOf } from '../../ui/instant.js';

// ---- number helpers (shared by the token page) ----
const SUB = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n) => String(n).replace(/\d/g, (d) => SUB[d]);
// $0.0₅71 for tiny prices: the subscript counts the zeros after "0.0"
export function fmtPrice(p, prefix = '$', sig = 4) {
  if (p == null || !isFinite(p)) return '—';
  if (p === 0) return prefix + '0';
  const a = Math.abs(p), s = p < 0 ? '-' : '';
  if (a >= 1e5) return s + prefix + num(a);
  if (a >= 1) return s + prefix + a.toFixed(a >= 1000 ? 0 : a >= 100 ? 2 : 4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  if (a >= 0.001) return s + prefix + Number(a.toPrecision(sig)).toString();
  let e = Math.floor(Math.log10(a)), digits = Math.round(a / 10 ** (e - sig + 1));
  if (digits >= 10 ** sig) { digits = Math.round(digits / 10); e += 1; }
  const zeros = -e - 1, body = String(digits).replace(/0+$/, '') || '0';
  return zeros < 4 ? s + prefix + '0.' + '0'.repeat(zeros) + body : s + prefix + '0.0' + sub(zeros) + body;
}
// price / market-cap targets: "50k" → 50000, "$31,000.5" → 31000.5, "0,5" → 0.5; NaN when unclear ("1,500"). Kept for
// older callers; amounts that get traded go through core parseAmount instead.
export const parseNum = (v) => parseTarget(v);
// a plain decimal string for an input box (no exponent), about 4 significant digits
export function plainNum(v) {
  if (!(v > 0) || !isFinite(v)) return '';
  if (v >= 1000) return String(Math.round(v));
  return v.toFixed(Math.min(18, Math.max(2, 3 - Math.floor(Math.log10(v))))).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
// compact numbers that round up across units (999,999,432 → 1.00B, never 1000.00M)
export function cnum(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= v * 0.9995) { const x = n / v, ax = Math.abs(x); return x.toFixed(ax >= 99.95 ? 0 : ax >= 9.995 ? 1 : 2) + u; }
  return a >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2);
}
export const int = (n) => (n == null || !isFinite(n) ? '—' : Math.abs(n) >= 1e4 ? cnum(n) : String(Math.round(n)));
// this coin's open limit orders for the active wallet; the chart and the trade panel share one request at a time
// (Jupiter's Trigger API allows about one call every 2 s, and orders.js caches answers for 15 s)
// After a failed lookup (usually a rate limit) the next 15 s reuse that failure instead of queueing more calls.
const ordersInflight = new Map(), ordersFail = new Map();
export function openOrders(mint, force = false) {
  const owner = wallet.owner || '', k = `${owner}|${mint}|${force ? 1 : 0}`, f = ordersFail.get(owner);
  if (ordersInflight.has(k)) return ordersInflight.get(k);
  if (f && Date.now() - f.at < 15000) return Promise.reject(f.err);
  const p = limit.list({ mint, force })
    .then((r) => { ordersFail.delete(owner); return r; }, (err) => { ordersFail.set(owner, { at: Date.now(), err }); throw err; })
    .finally(() => ordersInflight.delete(k));
  ordersInflight.set(k, p);
  return p;
}
export { supplyOf }; // the coin's known supply or null: never a guessed 1B

// pump.fun's standard curve completes at 115 virtual SOL against 279.9M virtual tokens: a market cap of about
// 410.9 SOL on its 1B supply. Shown as a dotted line on coins still on that curve.
export const PUMP_GRAD_MC_SOL = (115.005 / 279.9e6) * 1e9;

const IVS = [['1s', '1_SECOND', 1], ['15s', '15_SECOND', 15], ['30s', '30_SECOND', 30], ['1m', '1_MINUTE', 60], ['5m', '5_MINUTE', 300], ['15m', '15_MINUTE', 900], ['1h', '1_HOUR', 3600], ['4h', '4_HOUR', 14400], ['1d', '1_DAY', 86400]];
const PAGE = 1000;
const TZ = -new Date().getTimezoneOffset() * 60; // lightweight-charts draws UTC: shift bars to local time
const MARKER_CAP = 300;
const FEW = 80;           // below this many bars the chart keeps a fixed bar width instead of fitting them
const MARKER_SIZE = 0.6;  // lightweight-charts' default (1) is oversized next to 7 px candles
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// the time axis shows "Oct 4" where a new day starts, not a bare "4" (bar times are already shifted to local time)
const dayTick = (t, type) => { if (type !== 2 || typeof t !== 'number') return null; const d = new Date(t * 1000); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
// a compact number in K/M/B with sig significant digits, or more decimals when span (the visible range) needs them
// to tell neighbouring axis ticks apart; trailing zeros dropped ("100K", "82.5K", "2.77K")
export function compact(v, sig = 3, span = 0) {
  const a = Math.abs(v); let d = 1, u = '';
  for (const [x, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= x * (1 - 0.5 / 10 ** sig)) { d = x; u = s; break; }
  const ax = a / d; let dec = Math.max(0, sig - 1 - Math.floor(Math.log10(Math.max(ax, 1e-12))));
  if (ax >= 10 ** sig - 0.5) dec = 0;
  if (span > 0 && isFinite(span)) dec = Math.max(dec, Math.min(8, Math.ceil(-Math.log10(span / 10 / d))));
  return (v / d).toFixed(Math.min(8, dec)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + u;
}

export function chartBridge() {
  const groups = new Map(); let ext = [], impl = null;
  const cleanMarker = (m) => (m && Number.isFinite(Number(m.time)) ? {
    time: Math.floor(Number(m.time) > 1e11 ? Number(m.time) / 1000 : Number(m.time)),
    position: ['aboveBar', 'belowBar', 'inBar'].includes(m.position) ? m.position : 'aboveBar',
    shape: ['arrowUp', 'arrowDown', 'circle', 'square'].includes(m.shape) ? m.shape : 'circle',
    color: typeof m.color === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(m.color) ? m.color : '#7d8496',
    text: typeof m.text === 'string' ? m.text.slice(0, 14) : '', size: Number(m.size) > 0 ? Math.min(3, Number(m.size)) : undefined,
    id: m.id != null ? String(m.id) : undefined,
  } : null);
  const api = {
    addMarkers(list, group) {
      const clean = (Array.isArray(list) ? list : []).map(cleanMarker).filter(Boolean);
      if (group) groups.set('g:' + group, clean);
      else {
        const cur = groups.get('ext') || [], key = (m) => m.id || `${m.time}|${m.position}|${m.text}`, have = new Set(cur.map(key));
        groups.set('ext', cur.concat(clean.filter((m) => !have.has(key(m)))).slice(-MARKER_CAP));
      }
      impl?.markers();
    },
    setLines(lines) {
      ext = (Array.isArray(lines) ? lines : []).filter((l) => l && (Number(l.price) > 0 || Number(l.mc) > 0)).slice(0, 40).map((l) => ({
        priceUsd: Number(l.price) > 0 ? Number(l.price) : null, mcUsd: Number(l.mc) > 0 ? Number(l.mc) : null,
        color: typeof l.color === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(l.color) ? l.color : '#38d6f5',
        title: typeof l.title === 'string' ? l.title.slice(0, 24) : '', id: l.id != null ? String(l.id) : undefined,
      }));
      impl?.lines();
    },
  };
  return { api, groups, lines: () => ext, attach(i) { impl = i; }, detach() { impl = null; } };
}

const cssVar = (v, d) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || d;
// #abc → #aabbcc; anything that isn't a hex colour comes back unchanged
const hex6 = (c) => (/^#[0-9a-f]{3}$/i.test(c) ? '#' + c.slice(1).replace(/./g, '$&$&') : c);
const alpha = (hex, a) => (hex = hex6(hex), /^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex);
// t of the way from colour a to colour b (both hex); b when either isn't hex
function mixHex(a, b, t) {
  a = hex6(a); b = hex6(b);
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return b;
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  return '#' + [16, 8, 0].map((s) => { const u = (x >> s) & 255, v = (y >> s) & 255; return Math.round(u + (v - u) * t).toString(16).padStart(2, '0'); }).join('');
}
// the theme's colours for a lightweight-charts chart, read from the CSS tokens on :root (themes and the accent change them)
export function chartColors() {
  const bg = cssVar('--bg', '#07080b'), line = cssVar('--line', '#1b1f29');
  return { bg, line, grid: mixHex(bg, line, 0.55), panel: cssVar('--panel', '#0c0e13'), up: cssVar('--up', '#2fd38b'), down: cssVar('--down', '#ff5d6c'), warn: cssVar('--warn', '#ffc24b'), acc: cssVar('--accent', '#38d6f5'), muted: cssVar('--muted', '#7d8496') };
}
function sma(bars, n) {
  const out = []; let s = 0;
  for (let i = 0; i < bars.length; i++) { s += bars[i].close; if (i >= n) s -= bars[i - n].close; if (i >= n - 1) out.push({ time: bars[i].time + TZ, value: s / n }); }
  return out;
}
function ema(bars, n) {
  const out = [], k = 2 / (n + 1); let e = null;
  for (let i = 0; i < bars.length; i++) { e = e == null ? bars[i].close : bars[i].close * k + e * (1 - k); if (i >= n - 1) out.push({ time: bars[i].time + TZ, value: e }); }
  return out;
}

export function mountChart(el, ctx, bridge) {
  const LWC = window.LightweightCharts;
  const pref = Object.assign({ iv: '1m', type: 'mcap', quote: 'usd', vol: true, sma: false, ema: false }, LS.get('chart', {}));
  if (!IVS.some((x) => x[0] === pref.iv)) pref.iv = '1m';
  const S = { bars: [], seq: 0, loading: false, older: false, noMore: false, failed: false, retryAt: 0, alive: true, mine: [], dev: [], ownLines: [], lineHandles: [], polling: false };
  const iv = () => IVS.find((x) => x[0] === pref.iv);
  const step = () => iv()[2];
  const save = () => LS.set('chart', pref);

  el.innerHTML = `<div class="tp-cbar hfade">
      <div class="tp-ivs" role="group" aria-label="Candle interval">${IVS.map(([k]) => `<button type="button" data-iv="${k}">${k}</button>`).join('')}</div>
      <span class="tp-csep"></span>
      <div class="tp-seg" role="group" aria-label="Value"><button type="button" data-type="mcap">MC</button><button type="button" data-type="price">Price</button></div>
      <div class="tp-seg" role="group" aria-label="Currency"><button type="button" data-quote="usd">USD</button><button type="button" data-quote="native">SOL</button></div>
      <span class="tp-csep"></span>
      <button type="button" class="tp-tg" data-ind="vol">Vol</button><button type="button" class="tp-tg" data-ind="sma">SMA 20</button><button type="button" class="tp-tg" data-ind="ema">EMA 50</button>
      <button type="button" class="tp-tg tp-live" data-act="latest" title="Scroll to the newest candle">Latest</button>
      <i class="tp-cbr" aria-hidden="true"></i>
    </div>
    <div class="tp-cbox"><div class="tp-legend mono" aria-live="off"></div><div class="tp-cnote"></div></div>`;
  const box = el.querySelector('.tp-cbox'), legend = el.querySelector('.tp-legend'), noteEl = el.querySelector('.tp-cnote');
  const syncBar = () => {
    $$('[data-iv]', el).forEach((b) => b.classList.toggle('on', b.dataset.iv === pref.iv));
    $$('[data-type]', el).forEach((b) => b.classList.toggle('on', b.dataset.type === pref.type));
    $$('[data-quote]', el).forEach((b) => b.classList.toggle('on', b.dataset.quote === pref.quote));
    $$('[data-ind]', el).forEach((b) => b.classList.toggle('on', !!pref[b.dataset.ind]));
  };
  function note(text, retry) {
    noteEl.hidden = !text;
    noteEl.innerHTML = text ? `<span>${esc(text)}</span>${retry ? '<button type="button" class="btn" data-act="retry">Try again</button>' : ''}` : '';
  }
  syncBar();
  if (!LWC) { note('The chart library did not load. Reload the page.'); return () => {}; }

  // colours come from the CSS tokens and are read again on every 'theme' event (see recolor below)
  let C = chartColors(), UP = C.up, DOWN = C.down, WARN = C.warn, ACC = C.acc, MUTED = C.muted;
  const tone = (k) => ({ up: UP, down: DOWN, warn: WARN, acc: ACC, muted: MUTED })[k];
  // axis labels: market caps in 3 significant digits ("$100K", "$82.5K", "$2.77K"), more only when the visible range is
  // so tight that 3 would print two ticks alike; the legend shows 4
  let candles = null;
  const span = () => { try { const h = box.clientHeight, a = candles?.coordinateToPrice(0), b = candles?.coordinateToPrice(h); return a != null && b != null ? Math.abs(a - b) : 0; } catch { return 0; } };
  const mcTxt = (v, sig) => (pref.quote === 'usd' ? '$' : '') + compact(v, sig, sig === 3 ? span() : 0) + (pref.quote === 'usd' ? '' : ' SOL');
  const fmt = (v) => {
    if (v == null || !isFinite(v) || v < 0) return ''; // (the axis margin below the lowest candle: no negative prices)
    if (pref.type === 'mcap') return mcTxt(v, 3);
    return pref.quote === 'usd' ? fmtPrice(v) : fmtPrice(v, '') + ' SOL';
  };
  const fmtL = (v) => (v == null || !isFinite(v) || v < 0 ? '' : pref.type === 'mcap' ? mcTxt(v, 4) : fmt(v));
  const chart = LWC.createChart(box, {
    autoSize: true,
    layout: { background: { type: 'solid', color: C.bg }, textColor: MUTED, fontFamily: 'Geist Mono, ui-monospace, monospace', fontSize: 11 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.08, bottom: 0.25 }, entireTextOnly: true },
    timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: step() < 60, rightOffset: 6, barSpacing: 7, minBarSpacing: 0.6, tickMarkFormatter: dayTick },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    localization: { priceFormatter: fmt },
  });
  candles = chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-12 } });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const smaS = chart.addLineSeries({ color: WARN, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const emaS = chart.addLineSeries({ color: ACC, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  const toC = (b) => ({ time: b.time + TZ, open: b.open, high: b.high, low: b.low, close: b.close });
  const toV = (b) => ({ time: b.time + TZ, value: b.volume || 0, color: alpha(b.close >= b.open ? UP : DOWN, 0.38) });
  function indicators() {
    smaS.setData(pref.sma ? sma(S.bars, 20) : []);
    emaS.setData(pref.ema ? ema(S.bars, 50) : []);
  }
  function setAll() {
    candles.setData(S.bars.map(toC));
    volume.setData(pref.vol ? S.bars.map(toV) : []);
    indicators(); drawMarkers(); showLegend();
  }
  // a young coin's few candles keep a normal width from the right edge (fitting them would make each one ~70 px wide)
  function showRecent() {
    const n = S.bars.length, ts = chart.timeScale(); if (!n) return;
    if (n < FEW) { ts.applyOptions({ barSpacing: 7, minBarSpacing: 2, rightOffset: 8 }); ts.scrollToRealTime(); return; }
    ts.applyOptions({ minBarSpacing: 0.6, rightOffset: 6 });
    ts.setVisibleLogicalRange({ from: Math.max(-4, n - 160), to: n + 6 });
  }

  // ---- value conversions (USD per token → what the chart shows) ----
  const conv = (pUsd, mcUsdV) => {
    const sup = supplyOf(ctx.token(), ctx.pair()); // unknown supply: a line that needs it is left out, not misplaced
    let v = pref.type === 'mcap' ? (mcUsdV ?? pUsd * sup) : (pUsd ?? mcUsdV / sup);
    if (pref.quote === 'native') { const s = solUsd(); if (!(s > 0)) return null; v /= s; }
    return v > 0 && isFinite(v) ? v : null;
  };

  // ---- loading ----
  async function load() {
    const seq = ++S.seq; S.loading = true; S.noMore = false; S.failed = false;
    if (!S.bars.length) note('Loading chart…');
    try {
      const bars = await jc.chart(ctx.mint, { interval: iv()[1], candles: PAGE, type: pref.type, quote: pref.quote });
      if (seq !== S.seq || !S.alive) return;
      S.bars = bars; S.noMore = bars.length < PAGE * 0.9;
      setAll(); showRecent();
      note(bars.length ? '' : 'No trades on this coin yet. Candles appear with the first trade.');
    } catch {
      if (seq !== S.seq || !S.alive) return;
      S.failed = true; S.retryAt = Date.now() + 9000;
      if (!S.bars.length) note('Chart data did not load. Trying again shortly.', true);
    } finally { if (seq === S.seq) S.loading = false; }
  }
  async function loadOlder() {
    if (S.older || S.noMore || S.loading || !S.bars.length) return;
    S.older = true; const seq = S.seq, first = S.bars[0].time;
    try {
      const got = await jc.chart(ctx.mint, { interval: iv()[1], to: first * 1000, candles: PAGE, type: pref.type, quote: pref.quote });
      if (seq !== S.seq || !S.alive) return;
      const fresh = got.filter((c) => c.time < first);
      if (got.length < PAGE * 0.9) S.noMore = true;
      if (!fresh.length) { S.noMore = true; return; }
      const r = chart.timeScale().getVisibleLogicalRange();
      S.bars = fresh.concat(S.bars);
      setAll();
      if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + fresh.length, to: r.to + fresh.length });
    } catch { /* scroll again to retry */ } finally { S.older = false; }
  }
  // merge fresh candles (from the 3 s refresh) into the series without redrawing everything
  function merge(list) {
    let full = false, touched = false;
    for (const c of list.slice().sort((a, b) => a.time - b.time)) {
      const last = S.bars[S.bars.length - 1];
      if (!last || c.time > last.time) { S.bars.push(c); touched = true; if (!full) { candles.update(toC(c)); if (pref.vol) volume.update(toV(c)); } }
      else if (c.time === last.time) { S.bars[S.bars.length - 1] = c; touched = true; if (!full) { candles.update(toC(c)); if (pref.vol) volume.update(toV(c)); } }
      else {
        let i = S.bars.length - 1; while (i >= 0 && S.bars[i].time > c.time) i--;
        if (i >= 0 && S.bars[i].time === c.time) S.bars[i] = c; else S.bars.splice(i + 1, 0, c);
        full = true; touched = true;
      }
    }
    if (full) { const r = chart.timeScale().getVisibleLogicalRange(); setAll(); if (r) chart.timeScale().setVisibleLogicalRange(r); }
    else if (touched) { indicators(); showLegend(); }
    if (touched && S.bars.length) note('');
  }
  async function poll() {
    if (!S.alive || document.hidden || S.polling) return;
    if (!S.bars.length) { if (!S.loading && (!S.failed || Date.now() >= S.retryAt)) load(); return; }
    if (S.loading) return;
    S.polling = true; const seq = S.seq;
    try {
      const got = await jc.chart(ctx.mint, { interval: iv()[1], candles: Math.min(10, Math.ceil(3 / step()) + 2), type: pref.type, quote: pref.quote });
      if (seq === S.seq && S.alive && got.length) merge(got);
    } catch { /* next tick */ } finally { S.polling = false; }
  }
  // live trades between refreshes
  function onTrade(d) {
    if (!S.alive || d?.mint !== ctx.mint || d.backfill || !S.bars.length) return;
    const sup = supplyOf(ctx.token(), ctx.pair());
    let v = pref.type === 'mcap' ? (pref.quote === 'usd' ? d.mcUsd : d.mcSol) : (pref.quote === 'usd' ? d.mcUsd / sup : d.mcSol / sup);
    if (!(v > 0) || !isFinite(v)) return;
    const t = Math.floor(d.at / 1000 / step()) * step(), last = S.bars[S.bars.length - 1], vol = pref.quote === 'usd' ? d.usd || 0 : d.sol || 0;
    if (t < last.time) return;
    if (t === last.time) { last.high = Math.max(last.high, v); last.low = Math.min(last.low, v); last.close = v; last.volume = (last.volume || 0) + vol; merge([{ ...last }]); }
    else merge([{ time: t, open: last.close, high: Math.max(last.close, v), low: Math.min(last.close, v), close: v, volume: vol }]);
  }

  // ---- markers ----
  const snap = (sec) => { // the open time of the bar that holds sec (bars can have gaps)
    const b = S.bars; let lo = 0, hi = b.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (b[mid].time <= sec) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans < 0 ? null : b[ans].time;
  };
  function drawMarkers() {
    if (!S.bars.length) { candles.setMarkers([]); return; }
    const t = ctx.token(), first = S.bars[0].time, end = S.bars[S.bars.length - 1].time + step() * 2;
    const extra = t?.migratedAt ? [{ time: Math.floor(t.migratedAt / 1000), position: 'aboveBar', shape: 'square', tone: 'acc', text: 'Migrated' }] : [];
    const all = [...S.mine, ...S.dev, ...extra, ...[...bridge.groups.values()].flat()];
    const seen = new Set(), out = [];
    for (const m of all) {
      if (m.time < first || m.time > end) continue;
      const at = snap(m.time); if (at == null) continue;
      const key = `${at}|${m.position}|${m.text}|${m.tone || m.color}`; if (seen.has(key)) continue; seen.add(key);
      out.push({ time: at + TZ, position: m.position, shape: m.shape, color: (m.tone && tone(m.tone)) || m.color, text: m.text, size: m.size || MARKER_SIZE });
    }
    out.sort((a, b) => a.time - b.time);
    try { candles.setMarkers(out.slice(-MARKER_CAP)); } catch { /* bad marker: skip this round */ }
  }
  async function loadFills() {
    if (!S.alive) return;
    const owners = tradeOwners().slice(0, 3), t = ctx.token();
    const mine = [], dev = [];
    try {
      const lists = await Promise.all(owners.map((o) => fillsFor(ctx.mint, o).catch(() => [])));
      for (const f of lists.flat()) mine.push({ time: Math.floor(f.at / 1000), position: f.side === 'buy' ? 'belowBar' : 'aboveBar', shape: f.side === 'buy' ? 'arrowUp' : 'arrowDown', tone: f.side === 'buy' ? 'up' : 'down', text: f.side === 'buy' ? 'B' : 'S' });
    } catch { /* keep what we had */ }
    if (t?.dev) {
      try {
        const { txs } = await jx.txs(ctx.mint, { trader: t.dev });
        for (const x of txs) dev.push({ time: Math.floor(x.at / 1000), position: x.side === 'buy' ? 'belowBar' : 'aboveBar', shape: 'circle', tone: 'warn', text: x.side === 'buy' ? 'DB' : 'DS' });
      } catch { /* dev markers are optional */ }
    }
    if (!S.alive) return;
    S.mine = mine; S.dev = dev; drawMarkers();
  }

  // ---- horizontal lines: your limit orders, armed TP/SL, pump.fun migration MC, and lines from other tabs ----
  async function loadOwnLines() {
    if (!S.alive) return;
    const own = [];
    // legs at the same level (one per wallet after a multi-wallet arm) share one line: "TP 100% ×3"
    const legs = new Map();
    for (const a of armed.list({ mint: ctx.mint, active: true })) {
      if ((a.kind !== 'tp' && a.kind !== 'sl') || !(a.triggerUsd > 0)) continue;
      const k = a.kind + '|' + Number(a.triggerUsd).toPrecision(6), x = legs.get(k);
      if (x) { x.n++; if (x.pct !== a.pct) x.pct = null; } else legs.set(k, { kind: a.kind, priceUsd: a.triggerUsd, pct: a.pct, n: 1 });
    }
    for (const l of legs.values()) own.push({ priceUsd: l.priceUsd, tone: l.kind === 'tp' ? 'up' : 'down', title: `${l.kind === 'tp' ? 'TP' : 'SL'}${l.pct != null ? ` ${l.pct}%` : ''}${l.n > 1 ? ` ×${l.n}` : ''}` });
    if (wallet.owner) {
      try {
        const { orders } = await openOrders(ctx.mint);
        for (const o of orders) if (o.priceSol > 0) own.push({ priceSolPerToken: o.priceSol, tone: o.side === 'buy' ? 'up' : 'down', title: `Limit ${o.side}` });
      } catch { /* the Trigger API is slow to answer at times */ }
    }
    if (!S.alive) return;
    S.ownLines = own; drawLines();
  }
  function drawLines() {
    for (const h of S.lineHandles) { try { candles.removePriceLine(h); } catch { /* gone */ } }
    S.lineHandles = [];
    const t = ctx.token(), s = solUsd(), list = [...S.ownLines, ...bridge.lines()];
    if (t && !t.migrated && (t.launchpad === 'pump.fun' || /pump$/.test(ctx.mint)) && s > 0) list.push({ mcUsd: PUMP_GRAD_MC_SOL * s, tone: 'muted', title: 'Migrates ≈', style: 1 });
    for (const l of list) {
      const pUsd = l.priceSolPerToken ? (s > 0 ? l.priceSolPerToken * s : null) : l.priceUsd;
      const v = conv(pUsd, l.mcUsd);
      if (v == null) continue;
      S.lineHandles.push(candles.createPriceLine({ price: v, color: (l.tone && tone(l.tone)) || l.color, lineWidth: 1, lineStyle: l.style ?? 2, axisLabelVisible: true, title: l.title || '' }));
    }
  }

  // ---- legend ----
  function showLegend(bar) {
    const b = bar || S.bars[S.bars.length - 1];
    if (!b) { legend.innerHTML = ''; return; }
    const ch = b.open ? ((b.close - b.open) / b.open) * 100 : 0, c = ch >= 0 ? 'up' : 'down';
    legend.innerHTML = `<span>O <b class="${c}">${esc(fmtL(b.open))}</b></span><span>H <b class="${c}">${esc(fmtL(b.high))}</b></span><span>L <b class="${c}">${esc(fmtL(b.low))}</b></span><span>C <b class="${c}">${esc(fmtL(b.close))}</b></span><span class="${c}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span><span class="tp-lv">V <b>${pref.quote === 'usd' ? usd(b.volume || 0) : num(b.volume || 0) + ' SOL'}</b></span>`;
  }
  chart.subscribeCrosshairMove((p) => {
    if (!p?.time) { showLegend(); return; }
    const sec = Number(p.time) - TZ, b = S.bars[S.bars.length - 1]?.time === sec ? S.bars[S.bars.length - 1] : S.bars.find((x) => x.time === sec);
    showLegend(b);
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && r.from < 20) loadOlder(); });

  // ---- toolbar ----
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !el.contains(b)) return;
    if (b.dataset.iv && b.dataset.iv !== pref.iv) { pref.iv = b.dataset.iv; chart.applyOptions({ timeScale: { secondsVisible: step() < 60 } }); reset(); }
    else if (b.dataset.type && b.dataset.type !== pref.type) { pref.type = b.dataset.type; reset(); }
    else if (b.dataset.quote && b.dataset.quote !== pref.quote) { pref.quote = b.dataset.quote; reset(); }
    else if (b.dataset.ind) { pref[b.dataset.ind] = !pref[b.dataset.ind]; save(); syncBar(); setAll(); }
    else if (b.dataset.act === 'latest') showRecent();
    else if (b.dataset.act === 'retry') { S.retryAt = 0; load(); }
  });
  function reset() {
    save(); syncBar();
    S.bars = []; candles.setData([]); volume.setData([]); smaS.setData([]); emaS.setData([]); candles.setMarkers([]);
    candles.applyOptions({ priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-12 } });
    load().then(drawLines);
  }

  // a theme or accent change: read the tokens again and repaint everything that carries a colour
  function recolor() {
    if (!S.alive) return;
    C = chartColors(); UP = C.up; DOWN = C.down; WARN = C.warn; ACC = C.acc; MUTED = C.muted;
    chart.applyOptions({ layout: { background: { type: 'solid', color: C.bg }, textColor: MUTED }, grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } }, rightPriceScale: { borderColor: C.line }, timeScale: { borderColor: C.line } });
    candles.applyOptions({ upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN });
    smaS.applyOptions({ color: WARN }); emaS.applyOptions({ color: ACC });
    const r = chart.timeScale().getVisibleLogicalRange();
    if (S.bars.length) setAll(); else drawMarkers();
    if (r) chart.timeScale().setVisibleLogicalRange(r);
    drawLines();
  }

  bridge.attach({ markers: drawMarkers, lines: drawLines });
  ctx.on('theme', recolor);
  watchTrades('token-chart', [ctx.mint]);
  ctx.on('trade', onTrade);
  ctx.on('traded', (d) => { if (d?.mint === ctx.mint) setTimeout(loadFills, 2500); });
  ctx.on('wallet', () => { loadFills(); loadOwnLines(); });
  ctx.on('orders', loadOwnLines);
  ctx.on('sol', drawLines);
  ctx.on('migrate', (t) => { if (t?.mint === ctx.mint) { drawMarkers(); drawLines(); } });
  let seenMig = ctx.token()?.migratedAt, seenDev = ctx.token()?.dev;
  ctx.on('tokens', () => { // the migration time and dev can arrive (or get corrected) after the chart loads
    const t = ctx.token(); if (!t || (t.migratedAt === seenMig && t.dev === seenDev)) return;
    const devNew = t.dev !== seenDev; seenMig = t.migratedAt; seenDev = t.dev;
    drawMarkers(); drawLines(); if (devNew) loadFills();
  });
  const timers = [setInterval(poll, 3000), setInterval(() => { if (!document.hidden) loadFills(); }, 30000), setInterval(() => { if (!document.hidden) loadOwnLines(); }, 30000)];
  load().then(() => { loadFills(); loadOwnLines(); });

  return () => {
    S.alive = false; S.seq++;
    timers.forEach(clearInterval);
    watchTrades('token-chart', null);
    bridge.detach();
    try { chart.remove(); } catch { /* already gone */ }
  };
}
