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
import { $$, esc, ICON, ago, LS, usd, num, parseTarget } from '../../core/util.js';
import { jc, jx, ds } from '../../core/jup.js';
import { solUsd } from '../../core/price.js';
import { wallet, tradeOwners } from '../../core/wallet.js';
import { limit, armed } from '../../core/orders.js';
import { watchTrades } from '../../core/stream.js';
import { fillsFor, supplyOf } from '../../ui/instant.js';
import { loadKols as kolList, kolPic, whoIs, whoAnswered, callouts } from '../../core/kols.js';

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
// the theme's colours for a lightweight-charts chart, read from the CSS tokens on :root (themes and the accent change them).
// The chart sits on the panel colour with a near-invisible grid; candles use the --chart-up / --chart-down pair.
export function chartColors() {
  const bg = cssVar('--chart-bg', '') || cssVar('--panel', '#101114'), line = cssVar('--line', '#22242d'), muted = cssVar('--muted', '#828598');
  return {
    bg, line, grid: cssVar('--chart-grid', '') || mixHex(bg, line, 0.45), panel: cssVar('--panel', '#101114'),
    up: cssVar('--chart-up', '') || cssVar('--up', '#12af80'), down: cssVar('--chart-down', '') || cssVar('--down', '#f25461'),
    warn: cssVar('--warn', '#f5c84c'), acc: cssVar('--accent', '#526fff'), muted,
    axis: mixHex(cssVar('--fg-2', '#c8c9d1'), muted, 0.45), cross: mixHex(muted, bg, 0.2), label: cssVar('--line-2', '#323542'),
  };
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
  const pref = Object.assign({ iv: '1m', type: 'mcap', quote: 'usd', vol: true, sma: false, ema: false, kol: true, pf: true, un: true, trk: true, own: true, dev: true, ss: true, dex: true }, LS.get('chart', {}));
  if (!IVS.some((x) => x[0] === pref.iv)) pref.iv = '1m';
  const S = { bars: [], seq: 0, loading: false, older: false, noMore: false, failed: false, retryAt: 0, alive: true, mine: [], dev: [], kol: [], snipe: [], dexm: [], calls: [], ownLines: [], lineHandles: [], polling: false };
  const iv = () => IVS.find((x) => x[0] === pref.iv);
  const step = () => iv()[2];
  const save = () => LS.set('chart', pref);

  // toolbar: intervals as plain text (the open one boxed), then the USD/SOL and MC/Price pairs (the active half in the
  // accent), then the indicator and marker toggles
  el.innerHTML = `<div class="tp-cbar hfade">
      <div class="tp-ivs" role="group" aria-label="Candle interval">${IVS.map(([k]) => `<button type="button" data-iv="${k}">${k}</button>`).join('')}</div>
      <span class="tp-csep"></span>
      <div class="tp-pair" role="group" aria-label="Currency"><button type="button" data-quote="usd">USD</button><i aria-hidden="true">/</i><button type="button" data-quote="native">SOL</button></div>
      <span class="tp-csep"></span>
      <div class="tp-pair" role="group" aria-label="Value"><button type="button" data-type="mcap" title="Market cap">MC</button><i aria-hidden="true">/</i><button type="button" data-type="price">Price</button></div>
      <span class="tp-csep"></span>
      <div class="tp-inds" role="group" aria-label="Indicators and markers"><button type="button" class="tp-tg" data-ind="vol" title="Volume bars">Vol</button><button type="button" class="tp-tg" data-ind="sma" title="Simple moving average, 20 candles">SMA 20</button><button type="button" class="tp-tg" data-ind="ema" title="Exponential moving average, 50 candles">EMA 50</button><button type="button" class="tp-tg" data-ind="pf" title="pump.fun callouts: calls posted on the pump.fun app, shown with the caller's picture at the moment they called">PF</button><button type="button" class="tp-tg" data-ind="trk" title="Buys and sells by the wallets you track">Tracked</button><button type="button" class="tp-tg" data-ind="dev" title="Dev buys and sells: DB / DS bubbles for the creator wallet">DB/DS</button><button type="button" class="tp-tg" data-ind="ss" title="Sniper buys and sells: SB / SS bubbles for wallets Jupiter tags as snipers (they bought in the coin's first moments)">SB/SS</button><button type="button" class="tp-tg" data-ind="own" title="Your own buys and sells (B / S bubbles) and your average entry / exit lines">My trades</button><button type="button" class="tp-tg" data-ind="dex" title="When a Dexscreener profile, ad or boost was paid">DEX</button></div>
      <button type="button" class="tp-tg tp-live" data-act="latest" title="Scroll to the newest candle"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M4 12h12m-5-5 5 5-5 5M20 5v14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Latest</button>
      <i class="tp-cbr" aria-hidden="true"></i>
    </div>
    <div class="tp-cbox"><div class="tp-legend" aria-live="off"></div><div class="tp-cnote"></div></div>`;
  const box = el.querySelector('.tp-cbox'), legend = el.querySelector('.tp-legend'), noteEl = el.querySelector('.tp-cnote');
  const syncBar = () => {
    const mark = (b, on) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); };
    $$('[data-iv]', el).forEach((b) => mark(b, b.dataset.iv === pref.iv));
    $$('[data-type]', el).forEach((b) => mark(b, b.dataset.type === pref.type));
    $$('[data-quote]', el).forEach((b) => mark(b, b.dataset.quote === pref.quote));
    $$('[data-ind]', el).forEach((b) => mark(b, !!pref[b.dataset.ind]));
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
  // the look: panel-coloured background, a near-invisible grid, borderless candles with same-colour wicks, a dotted
  // live-price line with a solid price tag, faint volume, thin dashed crosshair, 12 px grey axis labels
  const LS_ = LWC.LineStyle || { Dotted: 1, LargeDashed: 3 };
  const cross = () => ({ color: C.cross, width: 1, style: LS_.LargeDashed, labelBackgroundColor: C.label });
  const look = () => ({
    layout: { background: { type: 'solid', color: C.bg }, textColor: C.axis, fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 12 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false },
    crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: cross(), horzLine: cross() },
  });
  const chart = LWC.createChart(box, {
    autoSize: true,
    ...look(),
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.22 }, entireTextOnly: true },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: step() < 60, rightOffset: 6, barSpacing: 7, minBarSpacing: 0.6, tickMarkFormatter: dayTick },
    localization: { priceFormatter: fmt },
  });
  // a brand-new coin's few flat candles would zoom the price axis to a hair's width (eight labels of "$2.92574415K"):
  // keep at least 4% of the price in view
  const padFlat = (base) => {
    const r = base(), lo = r?.priceRange?.minValue, hi = r?.priceRange?.maxValue;
    if (!(isFinite(lo) && isFinite(hi))) return r;
    const mid = (lo + hi) / 2, need = Math.abs(mid) * 0.04;
    return hi - lo >= need ? r : { ...r, priceRange: { minValue: Math.max(0, mid - need / 2), maxValue: mid + need / 2 } };
  };
  // the bottom-right corner buttons, as on TradingView and Axiom: % (percent scale), log, and auto (fit the price axis
  // to the candles in view again after it was dragged or squeezed)
  const foot = document.createElement('div'); foot.className = 'tp-cfoot';
  const scl = document.createElement('div'); scl.className = 'tp-scl'; scl.setAttribute('role', 'group'); scl.setAttribute('aria-label', 'Price scale');
  scl.innerHTML = '<button type="button" data-scale="pct" title="Percentage scale">%</button><button type="button" data-scale="log" title="Logarithmic scale">log</button><button type="button" data-scale="auto" title="Auto: fit the price axis to the candles in view">auto</button>';
  foot.appendChild(scl); box.after(foot);
  const SCALE_MODE = { pct: 2, log: 1 };
  const applyScale = () => chart.priceScale('right').applyOptions({ mode: SCALE_MODE[pref.scale] ?? 0 });
  const syncScl = () => {
    const ps = chart.priceScale('right'), auto = !!ps.options().autoScale;
    for (const b of scl.children) { const on = b.dataset.scale === 'auto' ? auto : pref.scale === b.dataset.scale; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  };
  scl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scale]'); if (!b) return;
    if (b.dataset.scale !== 'auto') { pref.scale = pref.scale === b.dataset.scale ? '' : b.dataset.scale; save(); applyScale(); }
    chart.priceScale('right').applyOptions({ autoScale: true });
    // auto is a full reset: prices fit again AND the time axis goes back to the default view at the newest candle
    if (b.dataset.scale === 'auto') showRecent();
    syncScl();
  });
  applyScale();
  candles = chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN, priceLineStyle: LS_.Dotted, priceLineWidth: 1, autoscaleInfoProvider: padFlat, priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-12 } });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  const smaS = chart.addLineSeries({ color: WARN, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const emaS = chart.addLineSeries({ color: ACC, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });

  const toC = (b) => ({ time: b.time + TZ, open: b.open, high: b.high, low: b.low, close: b.close });
  const toV = (b) => ({ time: b.time + TZ, value: b.volume || 0, color: alpha(b.close >= b.open ? UP : DOWN, 0.3) });
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
      S.bars = bars; link(); S.noMore = bars.length < PAGE * 0.9;
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
      S.bars = fresh.concat(S.bars); link();
      setAll();
      if (r) chart.timeScale().setVisibleLogicalRange({ from: r.from + fresh.length, to: r.to + fresh.length });
    } catch { /* scroll again to retry */ } finally { S.older = false; }
  }
  // merge fresh candles (from the 3 s refresh) into the series without redrawing everything
  // connected candles, like Axiom: each one opens where the one before it closed (a coin can jump between two trades,
  // and a candle that opens at its own first trade leaves a gap); its high and low stretch to cover that open
  const joined = (c, prev) => (prev && prev.close !== c.open ? { ...c, open: prev.close, high: Math.max(c.high, prev.close), low: Math.min(c.low, prev.close) } : c);
  const link = () => { for (let i = 1; i < S.bars.length; i++) S.bars[i] = joined(S.bars[i], S.bars[i - 1]); };
  const before = (t) => { let i = S.bars.length - 1; while (i >= 0 && S.bars[i].time >= t) i--; return S.bars[i]; };
  function merge(list) {
    let full = false, touched = false;
    for (const raw of list.slice().sort((a, b) => a.time - b.time)) {
      const c = joined(raw, before(raw.time));
      const last = S.bars[S.bars.length - 1];
      if (!last || c.time > last.time) { S.bars.push(c); touched = true; if (!full) { candles.update(toC(c)); if (pref.vol) volume.update(toV(c)); } }
      else if (c.time === last.time) { S.bars[S.bars.length - 1] = c; touched = true; if (!full) { candles.update(toC(c)); if (pref.vol) volume.update(toV(c)); } }
      else {
        let i = S.bars.length - 1; while (i >= 0 && S.bars[i].time > c.time) i--;
        if (i >= 0 && S.bars[i].time === c.time) S.bars[i] = c; else S.bars.splice(i + 1, 0, c);
        full = true; touched = true;
      }
    }
    if (full) { link(); const r = chart.timeScale().getVisibleLogicalRange(); setAll(); if (r) chart.timeScale().setVisibleLogicalRange(r); }
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
    if (isPerson(d, trackedNames()) && !S.kol.some((m) => m.key === d.id)) { S.kol.push(kolMarker(d, trackedNames())); if (S.kol.length > MARKER_CAP) S.kol.shift(); bubblesNow(); lookupWho(); }
    else if (isSniperSell(d) && !S.snipe.some((m) => m.key === d.id)) { S.snipe.push(sniperMarker(d)); if (S.snipe.length > MARKER_CAP) S.snipe.shift(); bubblesNow(); }
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
    const extra = [];
    // your fills, the dev's trades, KOLs and tracked wallets are drawn as bubbles (below); the Trades tab's
    // 'tracked-wallets' marker group would only repeat them as text arrows
    const all = [...(pref.dex ? S.dexm : []), ...extra, ...[...bridge.groups].filter(([k]) => k !== 'g:tracked-wallets').flatMap(([, v]) => v)];
    const seen = new Set(), out = [];
    for (const m of all) {
      if (m.time < first || m.time > end) continue;
      const at = snap(m.time); if (at == null) continue;
      const key = `${at}|${m.position}|${m.text}|${m.tone || m.color}`; if (seen.has(key)) continue; seen.add(key);
      out.push({ time: at + TZ, position: m.position, shape: m.shape, color: (m.tone && tone(m.tone)) || m.color, text: m.text, size: m.size || MARKER_SIZE });
    }
    out.sort((a, b) => a.time - b.time);
    try { candles.setMarkers(out.slice(-MARKER_CAP)); } catch { /* bad marker: skip this round */ }
    bubblesNow();
  }
  async function loadFills() {
    if (!S.alive) return;
    const owners = tradeOwners().slice(0, 3), t = ctx.token();
    const mine = [], dev = [];
    try {
      const lists = await Promise.all(owners.map((o) => fillsFor(ctx.mint, o).catch(() => [])));
      for (const f of lists.flat()) mine.push({ time: Math.floor(f.at / 1000), side: f.side, sol: Number(f.sol) || 0, wallet: f.owner, kind: 'me', key: 'me:' + f.sig });
      // your average entry and exit (SOL per token, all wallets in this trade): drawn as dashed lines like Axiom's cost basis
      let bS = 0, bT = 0, sS = 0, sT = 0;
      for (const f of lists.flat()) { const sol = Number(f.sol) || 0, tok = Number(f.tokens) || 0; if (!(sol > 0 && tok > 0)) continue; if (f.side === 'buy') { bS += sol; bT += tok; } else { sS += sol; sT += tok; } }
      S.avg = { entry: bT > 0 ? bS / bT : null, exit: sT > 0 ? sS / sT : null };
    } catch { /* keep what we had */ }
    if (t?.dev) {
      try {
        const { txs } = await jx.txs(ctx.mint, { trader: t.dev });
        for (const x of txs) dev.push({ time: Math.floor(x.at / 1000), side: x.side, sol: x.sol, wallet: t.dev, kind: 'dev', key: 'dev:' + x.id });
      } catch { /* dev markers are optional */ }
    }
    if (!S.alive) return;
    // a trade just made here shows at once (see 'traded' below) and stays until Jupiter's feed lists it
    const known = new Set(mine.map((m) => m.key)), now = Date.now() / 1000;
    S.mine = [...mine, ...S.mine.filter((m) => m.optimistic && !known.has(m.key) && now - m.time < 180)]; S.dev = dev; drawMarkers(); drawLines();
  }

  // ---- trade bubbles (KOLs, tracked wallets, the dev, you) and Dexscreener updates ----
  // KOLs are wallets Jupiter's trade feed labels 'influencer' or that the public KOL list names (Nought adds no
  // attribution of its own); tracked wallets are the ones saved in Trackers, shown under their saved name. Up to 4 pages
  // (120 trades) are read on load, then live trades add to them. Your fills and the dev's trades come from loadFills().
  const KOL = '#f5c84c', DEXC = '#5fc8ff';
  const trackedNames = () => { const m = new Map(); for (const w of LS.get('tracked', []) || []) if (w?.address) m.set(w.address, `${w.emoji || ''}${w.name || ''}`.trim()); return m; };
  const isPerson = (x, names) => x.sol > 0 && x.wallet !== ctx.token()?.dev && !tradeOwners().includes(x.wallet) && names.has(x.wallet);
  // sniper buys and sells (SB / SS): trades by wallets Jupiter's trade feed tags 'sniper' (bought in the coin's first moments)
  const isSniperSell = (x) => x.sol > 0 && x.tags?.includes('sniper') && x.wallet !== ctx.token()?.dev && !tradeOwners().includes(x.wallet);
  const sniperMarker = (x) => ({ time: Math.floor(x.at / 1000), side: x.side, sol: x.sol, who: '', wallet: x.wallet, kind: 'sniper', key: x.id });
  const kolMarker = (x, names) => ({ time: Math.floor(x.at / 1000), side: x.side, sol: x.sol, who: names.get(x.wallet) || '', wallet: x.wallet, kind: 'tracked', key: x.id });
  // Drawn like Axiom: round bubbles under the candle's low (buys, green ring) or over its high (sells, red ring). A KOL
  // shows their X picture (a person icon when no public profile names them), a tracked wallet its emoji or initials,
  // the dev "DB"/"DS", you "B"/"S" on a solid bubble. Trades close together share one bubble group (up to four stacked,
  // then +n), sized so groups never cover each other at the current zoom. Hover shows who and how much; click opens
  // the wallet. Bubbles follow the chart every frame while it pans, zooms or rescales, and existing ones are moved, not
  // rebuilt, so pictures never flicker.
  const kolLayer = document.createElement('div'); kolLayer.className = 'tp-kols'; box.appendChild(kolLayer);
  // a picture that fails becomes the person icon (inline onerror is blocked by the page's CSP)
  kolLayer.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.outerHTML = ICON.xProfile; }, true);
  const hue = (w) => { let h = 0; for (const c of w || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; };
  const kolSpan = () => Math.max(1, Math.ceil(28 / (chart.timeScale().options().barSpacing || 7)));
  const RANK = { mig: -1, me: 0, dev: 1, pf: 2, kol: 2, tracked: 3, sniper: 4 };
  // the migration: one blue "M" bubble over the candle it happened in
  const migItem = () => { const t = ctx.token(); return t?.migratedAt ? [{ time: Math.floor(t.migratedAt / 1000), side: 'sell', sol: 0, wallet: 'migration', kind: 'mig', key: 'mig' }] : []; };
  const items = () => [...migItem(), ...(pref.own ? S.mine : []), ...(pref.dev ? S.dev : []), ...(pref.trk ? S.kol : []), ...(pref.pf ? S.calls : []), ...(pref.ss ? S.snipe : [])];
  function kolGrouped() {
    const b = S.bars, span = kolSpan(), slot = span * step(), groups = new Map();
    for (const m of items()) {
      let lo = 0, hi = b.length - 1, i = -1;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (b[mid].time <= m.time) { i = mid; lo = mid + 1; } else hi = mid - 1; }
      if (i < 0) continue;
      const k = m.side + Math.floor(b[i].time / slot), g = groups.get(k) || { key: k, side: m.side, bar: b[i], people: new Map(), trades: [] };
      if (m.side === 'buy' ? b[i].low < g.bar.low : b[i].high > g.bar.high) g.bar = b[i];
      g.trades.push(m); const pk = m.kind + ':' + m.wallet; if (!g.people.has(pk)) g.people.set(pk, m); groups.set(k, g);
    }
    return groups;
  }
  function avatar(m, gk) {
    const k = S.kolBy?.get(m.wallet), pic = m.kind === 'kol' || m.kind === 'pf' || m.kind === 'tracked' ? kolPic(k) : '';
    const face = m.kind === 'me' ? (m.side === 'buy' ? 'B' : 'S') : m.kind === 'dev' ? (m.side === 'buy' ? 'DB' : 'DS') : m.kind === 'mig' ? 'M': m.kind === 'sniper' ? (m.side === 'buy' ? 'SB' : 'SS')
      : pic ? `<img src="${esc(warm(pic))}" alt="" draggable="false" referrerpolicy="no-referrer">`
      : m.kind === 'tracked' && m.who ? esc([...m.who.replace(/\s+/g, '')].slice(0, /\p{Extended_Pictographic}/u.test(m.who) ? 1 : 2).join('').toUpperCase()) : ICON.xProfile;
    return `<i class="k-${m.kind}" data-g="${esc(gk)}" data-p="${esc(m.kind + ':' + m.wallet)}" data-w="${esc(m.wallet)}" style="--h:${hue(m.wallet)}">${face}</i>`;
  }
  let kolLoop = 0, kolGroups = new Map(), kolSig = '';
  // keep each picture decoded in memory, so a bubble that is created again (zoom, new trades) paints at once
  const warmed = new Map();
  const warm = (url) => { if (!warmed.has(url)) { const im = new Image(); im.referrerPolicy = 'no-referrer'; im.src = url; im.decode?.().catch(() => {}); warmed.set(url, im); if (warmed.size > 300) warmed.delete(warmed.keys().next().value); } return url; };
  const kolEls = new Map(); // group key → element, reused while its contents are unchanged
  function drawKols() {
    if (!S.alive) return;
    kolGroups = S.bars.length ? kolGrouped() : new Map();
    const ts = chart.timeScale(), w = box.clientWidth - (chart.priceScale('right').width() || 0), h = box.clientHeight, keep = new Set();
    for (const [gk, g] of kolGroups) {
      const x = ts.timeToCoordinate(g.bar.time + TZ), edge = candles.priceToCoordinate(g.side === 'buy' ? g.bar.low : g.bar.high);
      if (x == null || edge == null || x < -40 || x > w + 10) continue;
      const raw = g.side === 'buy' ? edge + 14 : edge - 14;
      if (raw < -60 || raw > h + 60) continue;
      // a wick at the very top or bottom keeps its bubbles inside the chart
      const y = Math.max(12, Math.min(h - 12, raw));
      const people = [...g.people.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || !!kolPic(S.kolBy?.get(b.wallet)) - !!kolPic(S.kolBy?.get(a.wallet)));
      const inner = people.slice(0, 4).map((m) => avatar(m, gk)).join('') + (people.length > 4 ? `<em>+${people.length - 4}</em>` : '');
      let el = kolEls.get(gk);
      if (!el) { el = document.createElement('div'); kolEls.set(gk, el); kolLayer.prepend(el); }
      if (el._inner !== inner) { el.innerHTML = inner; el._inner = inner; el.className = `tp-kol ${g.side}`; }
      el.style.transform = `translate(${(x - 10).toFixed(1)}px, ${y.toFixed(1)}px) translateY(-50%)`; el.hidden = false;
      keep.add(gk);
    }
    for (const [gk, el] of kolEls) {
      if (keep.has(gk)) continue;
      if (kolGroups.has(gk) && kolEls.size < 600) el.hidden = true; else { el.remove(); kolEls.delete(gk); }
    }
  }
  // follow the chart: redraw on the frame after anything that moves candles (pan, zoom, price-axis rescale, resize, data)
  function followBubbles() {
    kolLoop = requestAnimationFrame(followBubbles);
    if (!S.alive || document.hidden) return;
    const r = chart.timeScale().getVisibleLogicalRange();
    const sig = `${r?.from}|${r?.to}|${candles.coordinateToPrice(0)}|${candles.coordinateToPrice(200)}|${box.clientWidth}|${box.clientHeight}|${S.bars.length}`;
    if (sig !== kolSig) { kolSig = sig; drawKols(); syncScl(); }
  }
  const bubblesNow = () => { kolSig = ''; };
  // hover: who, what and when; click: the wallet's card
  const kolTip = document.createElement('div'); kolTip.className = 'tp-kol-tip'; kolTip.hidden = true; kolLayer.appendChild(kolTip);
  const WHO = { me: 'You', dev: 'Dev (creator wallet)', sniper: 'Sniper', mig: 'Migrated' };
  // no hover card while the chart is being dragged (it would pop up on every bubble the cursor crosses)
  let dragging = false;
  box.addEventListener('pointerdown', () => { dragging = true; kolTip.hidden = true; });
  addEventListener('pointerup', () => { dragging = false; });
  kolLayer.addEventListener('mouseover', (e) => {
    const el = e.target.closest('.tp-kol i'); if (!el || dragging) return;
    const g = kolGroups.get(el.dataset.g), m = g?.people.get(el.dataset.p); if (!m) return;
    const tr = g.trades.filter((x) => x.kind + ':' + x.wallet === el.dataset.p), k = S.kolBy?.get(m.wallet);
    const total = tr.reduce((s, x) => s + (x.sol || 0), 0), last = Math.max(...tr.map((x) => x.time));
    const short4 = m.wallet.slice(0, 4) + '…' + m.wallet.slice(-4), name = WHO[m.kind] || m.who || k?.name || short4, pic = m.kind === 'kol' || m.kind === 'pf' || m.kind === 'tracked' ? kolPic(k) : '';
    if (m.kind === 'mig') { kolTip.innerHTML = `<div class="tp-kt-h"><i class="k-mig">M</i><div><b>Migrated</b><span>moved from the bonding curve to its pool</span></div></div><div class="tp-kt-f">${esc(ago(m.time * 1000))}</div>`; const r = el.getBoundingClientRect(), br = box.getBoundingClientRect(); kolTip.hidden = false; kolTip.style.left = Math.min(Math.max(4, r.left - br.left - 60), br.width - kolTip.offsetWidth - 4) + 'px'; kolTip.style.top = Math.max(4, r.top - br.top - kolTip.offsetHeight - 8) + 'px'; return; }
    if (m.kind === 'pf') {
      const c = m.call, x = (v) => (v >= 10 ? Math.round(v) : v.toFixed(1)) + 'x';
      kolTip.innerHTML = `<div class="tp-kt-h">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<i class="k-pf">${ICON.xProfile}</i>`}<div><b>${esc(name)}</b><span>${esc((k?.x ? '@' + k.x + ' · ' : '') + 'pump.fun call')}</span></div></div><div class="tp-kt-b buy">Called${c.mc ? ' at ' + usd(c.mc) + ' MC' : ''}</div>${c.multiple != null || c.max ? `<div class="tp-kt-f">${c.multiple != null ? 'now ' + x(c.multiple) : ''}${c.multiple != null && c.max ? ' · ' : ''}${c.max ? 'peak ' + x(c.max) : ''}</div>` : ''}${c.note ? `<div class="tp-kt-n">${esc(c.note)}</div>` : ''}<div class="tp-kt-f">${esc(ago(c.at))} · click to open wallet</div>`;
      const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
      kolTip.hidden = false;
      kolTip.style.left = Math.min(Math.max(4, r.left - br.left + r.width / 2 - kolTip.offsetWidth / 2), br.width - kolTip.offsetWidth - 4) + 'px'; kolTip.style.top = Math.max(4, r.bottom - br.top + 8) + 'px';
      return;
    }
    const sub = m.kind === 'me' || m.kind === 'dev' || m.kind === 'sniper' ? short4 : (k?.x ? '@' + k.x + ' · ' : '') + (m.kind === 'tracked' ? 'Tracked wallet' : m.kind === 'pf' ? 'PF KOL' : 'KOL');
    kolTip.innerHTML = `<div class="tp-kt-h">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : `<i class="k-${m.kind}">${m.kind === 'me' || m.kind === 'dev' || m.kind === 'sniper' ? esc(el.textContent) : ICON.xProfile}</i>`}<div><b>${esc(name)}</b><span>${esc(sub)}</span></div></div><div class="tp-kt-b ${g.side}">${g.side === 'buy' ? 'Bought' : 'Sold'} ${total >= 10 ? Math.round(total) : total.toFixed(2)} SOL${tr.length > 1 ? ` in ${tr.length} trades` : ''}</div><div class="tp-kt-f">${esc(ago(last * 1000))}${m.kind === 'me' ? '' : ' · click to open wallet'}</div>`;
    const r = el.getBoundingClientRect(), br = box.getBoundingClientRect();
    kolTip.hidden = false;
    const left = Math.min(Math.max(4, r.left - br.left + r.width / 2 - kolTip.offsetWidth / 2), br.width - kolTip.offsetWidth - 4);
    const top = g.side === 'buy' ? r.bottom - br.top + 8 : r.top - br.top - kolTip.offsetHeight - 8;
    kolTip.style.left = left + 'px'; kolTip.style.top = Math.max(4, top) + 'px';
  });
  kolLayer.addEventListener('mouseout', (e) => { if (e.target.closest('.tp-kol i') && !e.relatedTarget?.closest?.('.tp-kol i')) kolTip.hidden = true; });
  kolLayer.addEventListener('click', (e) => {
    const el = e.target.closest('.tp-kol i'); if (!el || el.classList.contains('k-me') || el.classList.contains('k-mig')) return;
    kolTip.hidden = true;
    const t = ctx.token();
    import('../../ui/kol-wallet.js').then((m) => m.openKolWallet({ address: el.dataset.w, kol: S.kolBy?.get(el.dataset.w) || null, mint: ctx.mint, symbol: t?.symbol || '' }));
  });
  const kolSoon = bubblesNow;


  // pump.fun callouts (PF): calls posted on the pump.fun app, a bubble with the caller's picture under the candle of the
  // moment they called. Read through the relay, then every 45 s while the coin is open.
  async function loadCalls() {
    if (!S.alive) return;
    try {
      const list = await callouts(ctx.mint);
      if (!S.alive) return;
      S.calls = list.map((c) => ({ time: Math.floor(c.at / 1000), side: 'buy', sol: 0, wallet: c.wallet, kind: 'pf', key: 'call:' + c.id, call: c }));
      S.kolBy = new Map([...(S.kolBy || []), ...list.map((c) => [c.wallet, c.kol])]);
      bubblesNow();
    } catch { /* callouts are optional */ }
    setTimeout(loadCalls, 45000);
  }
  async function loadKols() {
    if (!S.alive) return;
    S.kolBy = new Map([...(await kolList()).by, ...(S.kolBy || [])]);
    const names = trackedNames(), seen = new Set([...S.kol, ...S.snipe].map((m) => m.key));
    const take = (x) => { if (seen.has(x.id)) return; seen.add(x.id); if (isPerson(x, names)) S.kol.push(kolMarker(x, names)); else if (isSniperSell(x)) S.snipe.push(sniperMarker(x)); };
    // the latest 120 trades (tracked wallets, KOLs from the public list), then the coin's WHOLE history of KOL trades
    // and sniper trades, which Jupiter filters server side (categories=influencer, tags=sniper), so bubbles cover the
    // chart from launch instead of only its last minutes. Each page shows at once and its new names are looked up.
    const pages = async (filter, max) => {
      let next = null;
      for (let page = 0; page < max; page++) {
        const { txs, next: n } = await jx.txs(ctx.mint, { ...filter, prio: 'low', ...(next ? { offset: next } : {}) });
        if (!S.alive) return;
        txs.forEach(take);
        if (S.kol.length > MARKER_CAP) S.kol = S.kol.slice(-MARKER_CAP);
        if (S.snipe.length > MARKER_CAP) S.snipe = S.snipe.slice(-MARKER_CAP);
        bubblesNow(); lookupWho();
        if (!n || !txs.length) break; next = n;
      }
    };
    await Promise.allSettled([pages({}, 4), pages({ tags: 'sniper' }, 6)]);
  }
  // KOLs Jupiter labels that the public list doesn't name: their pump.fun profile, when they set one up. Looked up in
  // batches as trades arrive (live ones too); kols.js remembers the answers for a day.
  const whoAsked = new Set(), whoTries = new Map();
  let whoBusy = false, whoAgain = false;
  async function lookupWho() {
    if (whoBusy) { whoAgain = true; return; }
    const unknown = [...new Set(S.kol.filter((m) => m.kind === 'kol').map((m) => m.wallet))].filter((w) => !S.kolBy?.has(w) && !whoAsked.has(w));
    if (!unknown.length) return;
    unknown.forEach((w) => whoAsked.add(w)); whoBusy = true;
    try { const found = await whoIs(unknown); if (S.alive && found.size) { S.kolBy = new Map([...S.kolBy, ...found]); bubblesNow(); } }
    catch { /* names are optional */ }
    finally {
      whoBusy = false;
      // wallets the relay could not answer yet (pump.fun busy): try again shortly, at most 3 times each
      const retry = unknown.filter((w) => !whoAnswered(w) && (whoTries.set(w, (whoTries.get(w) || 0) + 1).get(w) < 3));
      retry.forEach((w) => whoAsked.delete(w));
      if (S.alive && (whoAgain || retry.length)) { whoAgain = false; setTimeout(() => { if (S.alive) lookupWho(); }, retry.length ? 4000 : 0); }
    }
  }
  const DEX_LABEL = { tokenProfile: 'DEX paid', communityTakeover: 'CTO', tokenAd: 'DEX ad', trendingBarAd: 'DEX trending' };
  async function loadDex() {
    if (!S.alive) return;
    try {
      const d = await ds.orders(ctx.mint), out = [];
      for (const o of d.orders) if (o.status === 'approved' && o.at > 0) out.push({ time: Math.floor(o.at / 1000), position: 'aboveBar', shape: 'square', color: DEXC, text: DEX_LABEL[o.type] || 'DEX' });
      for (const b of d.boosts || []) { const at = Number(b?.paymentTimestamp); if (at > 0) out.push({ time: Math.floor(at / 1000), position: 'aboveBar', shape: 'square', color: DEXC, text: `Boost${Number(b?.amount) > 0 ? ' ' + Number(b.amount) : ''}` }); }
      if (!S.alive) return;
      S.dexm = out; drawMarkers();
    } catch { /* Dexscreener is optional */ }
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
    if (pref.own !== false && S.avg?.entry) list.push({ priceSolPerToken: S.avg.entry, tone: 'up', title: 'Avg entry', style: 2 });
    if (pref.own !== false && S.avg?.exit) list.push({ priceSolPerToken: S.avg.exit, tone: 'down', title: 'Avg exit', style: 2 });
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
    const sym = ctx.token()?.symbol || ctx.pair()?.baseToken?.symbol || '';
    const title = `${sym ? esc(sym) + '/' : ''}${pref.quote === 'usd' ? 'USD' : 'SOL'} · ${pref.type === 'mcap' ? 'Market cap' : 'Price'} · ${esc(pref.iv)}`;
    legend.innerHTML = `<span class="tp-lt">${title}</span><span>O<b class="${c}">${esc(fmtL(b.open))}</b></span><span>H<b class="${c}">${esc(fmtL(b.high))}</b></span><span>L<b class="${c}">${esc(fmtL(b.low))}</b></span><span>C<b class="${c}">${esc(fmtL(b.close))}</b></span><span class="tp-lc ${c}">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span><span class="tp-lv">Vol<b>${pref.quote === 'usd' ? usd(b.volume || 0) : num(b.volume || 0) + ' SOL'}</b></span>`;
  }
  chart.subscribeCrosshairMove((p) => {
    if (!p?.time) { showLegend(); return; }
    const sec = Number(p.time) - TZ, b = S.bars[S.bars.length - 1]?.time === sec ? S.bars[S.bars.length - 1] : S.bars.find((x) => x.time === sec);
    showLegend(b);
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && r.from < 20) loadOlder(); kolSoon(); });
  // the price axis rescales as candles arrive, and dragging it moves nothing else we can hear: keep bubbles on their candles
  kolLoop = requestAnimationFrame(followBubbles);

  // ---- toolbar ----
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !el.contains(b)) return;
    if (b.dataset.iv && b.dataset.iv !== pref.iv) { pref.iv = b.dataset.iv; chart.applyOptions({ timeScale: { secondsVisible: step() < 60 } }); reset(); }
    else if (b.dataset.type && b.dataset.type !== pref.type) { pref.type = b.dataset.type; reset(); }
    else if (b.dataset.quote && b.dataset.quote !== pref.quote) { pref.quote = b.dataset.quote; reset(); }
    else if (b.dataset.ind) { pref[b.dataset.ind] = !pref[b.dataset.ind]; save(); syncBar(); if (['kol', 'pf', 'un', 'trk', 'own', 'dev', 'ss', 'dex'].includes(b.dataset.ind)) { drawMarkers(); drawLines(); } else setAll(); }
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
    chart.applyOptions(look());
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
  // your own buy or sell: its B/S bubble appears the moment the trade lands, then the fills are re-read
  ctx.on('traded', (d) => {
    if (!S.alive || d?.mint !== ctx.mint || d.status !== 'ok' || !d.sig) return;
    if (!S.mine.some((m) => m.key === 'me:' + d.sig)) S.mine.push({ time: Math.floor(Date.now() / 1000), side: d.side, sol: Number(d.sol) || 0, wallet: d.owner, kind: 'me', key: 'me:' + d.sig, optimistic: true });
    bubblesNow(); loadOwnLines();
    setTimeout(() => { if (S.alive) loadFills(); }, 4000);
  });
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
  const timers = [setInterval(poll, 3000), setInterval(() => { if (!document.hidden) loadFills(); }, 30000), setInterval(() => { if (!document.hidden) loadOwnLines(); }, 30000), setInterval(() => { if (!document.hidden) loadDex(); }, 600000)];
  load().then(() => { loadFills(); loadOwnLines(); loadKols(); loadCalls(); loadDex(); });

  return () => {
    S.alive = false; S.seq++;
    timers.forEach(clearInterval); cancelAnimationFrame(kolLoop);
    watchTrades('token-chart', null);
    bridge.detach();
    try { chart.remove(); } catch { /* already gone */ }
  };
}
