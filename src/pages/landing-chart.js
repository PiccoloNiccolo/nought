// The landing page's live chart: one coin's market-cap candles in USD (Jupiter chart data, jc.chart) drawn with
// lightweight-charts in the theme's chart tokens (--chart-bg, --chart-grid, --chart-up, --chart-down). It is a preview,
// so it never scrolls or zooms (the page scrolls past it); the crosshair legend shows O H L C, and the newest bars
// refresh every few seconds while the tab is visible. Read-only: no orders, no wallet.
//   PREVIEW_IVS                                   [label, Jupiter interval, seconds]
//   mountPreviewChart(el, mint, {sym, iv, onFail, onOk}) → { setIv(label), destroy() }
//     onOk(): candles arrived. onFail(): Jupiter answered twice that this coin has no chart (a 4xx, an unreadable or
//     empty answer) before any candles arrived. A slowdown of the whole data host never calls onFail.
import { esc, on } from '../core/util.js';
import { jc } from '../core/jup.js';

export const PREVIEW_IVS = [['1s', '1_SECOND', 1], ['1m', '1_MINUTE', 60], ['5m', '5_MINUTE', 300], ['15m', '15_MINUTE', 900], ['1h', '1_HOUR', 3600]];
const BARS = 140;
// lightweight-charts draws UTC: shift bars to local time
const TZ = -new Date().getTimezoneOffset() * 60;
const cssVar = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;
const hex6 = (c) => (/^#[0-9a-f]{3}$/i.test(c) ? '#' + c.slice(1).replace(/./g, '$&$&') : c);
const alpha = (c, a) => (c = hex6(c), /^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, '0') : c);
// a rate limit, a server error, no answer or a full queue is the data host's state, not this coin's: keep the coin and
// try again after 12 s, 20 s, then every 30 s
const transient = (e) => !!(e?.net || e?.busy || e?.cooling || e?.status === 429 || e?.status >= 500);
const BACKOFF = [12e3, 20e3, 30e3];
const colors = () => ({ bg: cssVar('--chart-bg', '#101114'), grid: cssVar('--chart-grid', '#16171c'), up: cssVar('--chart-up', '#0b9981'), down: cssVar('--chart-down', '#f23446'), line: cssVar('--line', '#22242d'), line2: cssVar('--line-2', '#323542'), muted: cssVar('--muted', '#828598'), dim: cssVar('--dim', '#6e7184') });

// "$1.23M", "$45.6K", "$812": 3 significant digits, 4 when the price axis spans a narrow band (so ticks don't repeat)
function compact(v, sig = 3) {
  if (v == null || !isFinite(v) || v < 0) return '';
  for (const [d, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (v >= d * 0.9995) return '$' + Number((v / d).toPrecision(sig)) + u;
  return '$' + Number(v.toPrecision(sig));
}
// one bad print (a wick to ~$0 on a $75M coin) stretches the price axis until every candle is a flat line: a wick
// beyond 5x (or under a fifth of) the median close, and twice (or half) its own candle's body, is cut back to the body
function tame(b, med) {
  if (!(med > 0)) return b;
  const lo = Math.min(b.open, b.close), hi = Math.max(b.open, b.close);
  const low = b.low < med / 5 && b.low < lo / 2 ? lo : b.low, high = b.high > med * 5 && b.high > hi * 2 ? hi : b.high;
  return low === b.low && high === b.high ? b : { ...b, low, high };
}
const median = (bars) => { const c = bars.map((b) => b.close).sort((x, y) => x - y); return c.length ? c[c.length >> 1] : 0; };
// a quiet coin's flat candles would zoom the price axis to a hair's width (six labels of "$1.069M"): keep at least 4%
// of the price in view, as the token page does
const keep4 = (lo, hi) => { const mid = (lo + hi) / 2, need = Math.abs(mid) * 0.04; return hi - lo >= need ? [lo, hi] : [Math.max(0, mid - need / 2), mid + need / 2]; };

export function mountPreviewChart(el, mint, { sym = '', iv = '1m', onFail = () => {}, onOk = () => {} } = {}) {
  const LWC = window.LightweightCharts;
  el.innerHTML = '<div class="lc-box"></div><div class="lc-legend" aria-live="off"></div><div class="lc-note" hidden></div>';
  const box = el.querySelector('.lc-box'), legendEl = el.querySelector('.lc-legend'), noteEl = el.querySelector('.lc-note');
  const note = (text) => { noteEl.hidden = !text; noteEl.textContent = text || ''; };
  if (!LWC) { note('The chart library did not load. Open the coin to see its chart.'); return { setIv() {}, destroy() {} }; }

  const S = { iv: PREVIEW_IVS.some((x) => x[0] === iv) ? iv : '1m', bars: [], med: 0, seq: 0, fails: 0, waits: 0, ever: false, busy: false, alive: true, sig: 3, retry: 0 };
  const ivRow = () => PREVIEW_IVS.find((x) => x[0] === S.iv);
  let C = colors();
  const fmt = (v) => compact(v, S.sig);
  const chart = LWC.createChart(box, {
    autoSize: true,
    layout: { background: { type: 'solid', color: C.bg }, textColor: C.muted, fontFamily: 'Geist, ui-sans-serif, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    rightPriceScale: { borderColor: C.line, scaleMargins: { top: 0.16, bottom: 0.2 }, entireTextOnly: true },
    timeScale: { borderColor: C.line, timeVisible: true, secondsVisible: ivRow()[2] < 60, rightOffset: 4, barSpacing: 6, minBarSpacing: 1 },
    crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: C.dim, style: LWC.LineStyle.Dashed, labelBackgroundColor: C.line2 }, horzLine: { color: C.dim, style: LWC.LineStyle.Dashed, labelBackgroundColor: C.line2 } },
    handleScroll: false, handleScale: false,
    localization: { priceFormatter: fmt },
  });
  // the price axis follows the candle bodies on screen: a wick reaches at most one body range past them (a longer one
  // runs off the edge instead of squashing every candle), and at least 4% of the price stays in view
  const fit = (base) => {
    const r = base(), p = r?.priceRange;
    if (!p || !isFinite(p.minValue) || !isFinite(p.maxValue)) return r;
    let lo = p.minValue, hi = p.maxValue, bLo = Infinity, bHi = -Infinity;
    const v = chart.timeScale().getVisibleLogicalRange(), n = S.bars.length;
    for (const b of v ? S.bars.slice(Math.max(0, Math.floor(v.from)), Math.min(n, Math.max(0, Math.ceil(v.to) + 1))) : S.bars) { bLo = Math.min(bLo, b.open, b.close); bHi = Math.max(bHi, b.open, b.close); }
    if (bHi >= bLo) { const span = Math.max(bHi - bLo, ((bLo + bHi) / 2) * 0.04); lo = Math.max(lo, bLo - span); hi = Math.min(hi, bHi + span); }
    [lo, hi] = keep4(lo, hi);
    // a narrow band gets a 4th significant digit, so the axis labels don't repeat
    S.sig = hi > 0 && (hi - lo) / hi < 0.08 ? 4 : 3;
    return { ...r, priceRange: { minValue: lo, maxValue: hi } };
  };
  const candles = chart.addCandlestickSeries({ upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down, priceLineStyle: LWC.LineStyle.Dotted, autoscaleInfoProvider: fit, priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-9 } });
  const volume = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

  const toC = (b) => ({ time: b.time + TZ, open: b.open, high: b.high, low: b.low, close: b.close });
  const toV = (b) => ({ time: b.time + TZ, value: b.volume || 0, color: alpha(b.close >= b.open ? C.up : C.down, 0.4) });
  function legend(b = S.bars[S.bars.length - 1]) {
    if (!b) { legendEl.innerHTML = ''; return; }
    const c = b.close >= b.open ? 'up' : 'down', ch = b.open > 0 ? Number((((b.close - b.open) / b.open) * 100).toFixed(2)) || 0 : 0;
    legendEl.innerHTML = `<span class="lc-t">${esc(sym ? sym + ' · ' : '')}${esc(S.iv)}<span class="lc-mc"> · Market cap</span></span>`
      + ['O', 'H', 'L', 'C'].map((k, i) => `<span>${k}<b class="${c}">${esc(fmt([b.open, b.high, b.low, b.close][i]))}</b></span>`).join('')
      + `<b class="${ch > 0 ? 'up' : ch < 0 ? 'down' : ''}">${esc((ch > 0 ? '+' : '') + ch.toFixed(2) + '%')}</b>`;
  }
  function setAll() {
    candles.setData(S.bars.map(toC)); volume.setData(S.bars.map(toV)); legend();
    const n = S.bars.length, ts = chart.timeScale();
    // few candles (a young coin) sit at 14 px each from the right edge instead of stretching across the whole width
    if (n && n * 14 < (box.clientWidth || 600) * 0.8) { ts.applyOptions({ barSpacing: 14 }); ts.scrollToRealTime(); } else ts.fitContent();
  }
  // onFail may replace this chart (destroy() clears S.alive), so a retry is only set while it is still alive
  const retry = (ms) => { clearTimeout(S.retry); if (S.alive) S.retry = setTimeout(load, ms); };
  async function load() {
    const seq = ++S.seq; clearTimeout(S.retry);
    if (!S.bars.length) note('Loading the chart…');
    try {
      const bars = await jc.chart(mint, { interval: ivRow()[1], candles: BARS, type: 'mcap', quote: 'usd' });
      if (!S.alive || seq !== S.seq) return;
      const ok = bars.filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
      S.waits = 0; S.med = median(ok); S.bars = ok.map((b) => tame(b, S.med));
      setAll();
      if (S.bars.length) { S.fails = 0; S.ever = true; note(''); onOk(); return; }
      if (!S.ever && ++S.fails >= 2) { note('No recent trades on this coin.'); onFail(); retry(60e3); return; }
      note('No trades in this range yet.'); retry(S.ever ? 30e3 : 12e3);
    } catch (e) {
      if (!S.alive || seq !== S.seq) return;
      if (transient(e)) { note('Chart data is busy. Trying again…'); retry(BACKOFF[Math.min(S.waits++, BACKOFF.length - 1)]); return; }
      if (!S.ever && ++S.fails >= 2) { note('Chart data did not load.'); onFail(); retry(60e3); return; }
      note('Chart data did not load. Trying again…'); retry(S.ever ? 30e3 : 12e3);
    }
  }
  // the newest bars, every 5 s on candles shorter than a minute and every 10 s otherwise: enough bars to cover the gap
  const every = () => (ivRow()[2] < 60 ? 5000 : 10000);
  async function refresh() {
    if (!S.alive || document.hidden || S.busy || !S.bars.length) return;
    S.busy = true; const seq = S.seq;
    try {
      const fresh = await jc.chart(mint, { interval: ivRow()[1], candles: Math.ceil(every() / 1000 / ivRow()[2]) + 2, type: 'mcap', quote: 'usd', prio: 'low' });
      if (!S.alive || seq !== S.seq) return;
      for (const raw of fresh) {
        const last = S.bars[S.bars.length - 1];
        if (!(raw.open > 0 && raw.high > 0 && raw.low > 0 && raw.close > 0) || !last || raw.time < last.time) continue;
        const b = tame(raw, S.med);
        if (b.time === last.time) S.bars[S.bars.length - 1] = b; else S.bars.push(b);
        candles.update(toC(b)); volume.update(toV(b));
      }
      // a tab left open for hours: keep the newest 2,000 bars
      if (S.bars.length > 4000) { S.bars.splice(0, S.bars.length - 2000); candles.setData(S.bars.map(toC)); volume.setData(S.bars.map(toV)); chart.timeScale().scrollToRealTime(); }
      legend();
    } catch { /* the next tick tries again */ } finally { S.busy = false; }
  }
  let timer = 0;
  const schedule = () => { clearInterval(timer); timer = setInterval(refresh, every()); };

  chart.subscribeCrosshairMove((p) => {
    const d = p && p.time != null ? p.seriesData?.get(candles) : null;
    legend(d && d.open != null ? d : undefined);
  });
  // a theme or accent change: read the tokens again
  const offTheme = on('theme', () => {
    if (!S.alive) return;
    C = colors();
    chart.applyOptions({ layout: { background: { type: 'solid', color: C.bg }, textColor: C.muted }, grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } }, rightPriceScale: { borderColor: C.line }, timeScale: { borderColor: C.line } });
    candles.applyOptions({ upColor: C.up, downColor: C.down, wickUpColor: C.up, wickDownColor: C.down });
    if (S.bars.length) volume.setData(S.bars.map(toV));
  });

  load(); schedule();
  return {
    setIv(k) {
      if (!S.alive || k === S.iv || !PREVIEW_IVS.some((x) => x[0] === k)) return;
      S.iv = k; S.fails = 0; S.waits = 0; S.bars = []; S.med = 0;
      chart.timeScale().applyOptions({ secondsVisible: ivRow()[2] < 60 });
      candles.setData([]); volume.setData([]); legend(); note('');
      load(); schedule();
    },
    destroy() { S.alive = false; clearInterval(timer); clearTimeout(S.retry); offTheme(); try { chart.remove(); } catch { /* already gone */ } },
  };
}
