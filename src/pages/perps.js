// Perps: Hyperliquid markets inside Nought. Screener (left), live chart with funding and a read-only account view
// (center), order book and trades, and an order preview. Orders are placed on Hyperliquid's own site for now: Nought
// has not verified the EVM agent-key signing flow end to end, so it signs nothing here. Nought adds no fee either way.
import { $, $$, esc, safeUrl, usd, pct, cls, num, LS, toast, short, on as onEvent } from '../core/util.js';
import { register } from '../core/router.js';
import * as hl from '../core/hl.js';

const IVS = Object.keys(hl.INTERVALS);
const COLS = [['coin', 'Market'], ['mark', 'Price'], ['change', '24h'], ['funding', 'Funding 1h'], ['oiUsd', 'Open int.'], ['vol', 'Volume 24h'], ['maxLeverage', 'Max lev']];
const LOW_TABS = [['funding', 'Funding'], ['positions', 'Positions'], ['orders', 'Open orders'], ['fills', 'Fills']];
const PANES = [['markets', 'Markets'], ['chart', 'Chart'], ['book', 'Book'], ['trade', 'Trade']];
const TZ = -new Date().getTimezoneOffset() * 60; // charts read local time
const ROW_H = 19; // order book row height (px), kept in step with css/perps.css
const STAR = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z" fill="var(--f, none)" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';

// remembered between visits (this browser only)
const memo = { list: [], at: 0 }; // last market list, so the page draws at once when you come back
const favs = new Set((LS.get('perps.favs', []) || []).filter((c) => hl.COIN_RE.test(c)));
const saveFavs = () => LS.set('perps.favs', [...favs]);
const ui = (() => {
  const u = Object.assign({ iv: '15m', sort: 'vol', dir: -1, only: 'all', bookUnit: 'coin', low: 'funding', sizeUnit: 'usd' }, LS.get('perps.ui', {}));
  if (!IVS.includes(u.iv)) u.iv = '15m';
  if (!COLS.some(([k]) => k === u.sort)) u.sort = 'vol';
  if (u.dir !== 1) u.dir = -1;
  if (u.only !== 'fav') u.only = 'all';
  if (u.bookUnit !== 'usd') u.bookUnit = 'coin';
  if (!LOW_TABS.some(([k]) => k === u.low)) u.low = 'funding';
  if (u.sizeUnit !== 'coin') u.sizeUnit = 'usd';
  return u;
})();
const saveUi = () => LS.set('perps.ui', ui);
const loadAddr = () => { const a = LS.get('perps.addr', ''); return hl.isAddr(a) ? a : ''; };

// formatting: Hyperliquid prices carry at most 5 significant figures and (6 − szDecimals) decimals
const NF = new Map();
const nf = (d) => NF.get(d) || NF.set(d, new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })).get(d);
const intDigits = (x) => Math.floor(Math.log10(Math.abs(x))) + 1;
const pxDec = (ref, szDec = 0) => (!ref || !isFinite(ref) ? 2 : Math.max(0, Math.min(6 - szDec, 5 - intDigits(ref))));
const fpx = (p, m) => (p == null || !isFinite(p) ? '—' : nf(pxDec(m?.mark || p, m?.szDecimals ?? 0)).format(p));
const fsz = (s, m) => (s == null || !isFinite(s) ? '—' : Math.abs(s) >= 1e5 ? num(s) : s === 0 ? '0' : nf(Math.max(0, Math.min(m?.szDecimals ?? 4, 5 - intDigits(s)))).format(s));
// book and trade sizes: the market's own step (szDecimals), trimmed so the largest figure on screen stays about 7 digits
// wide; one count for the whole column, so the decimal points line up
const colDec = (max, m) => Math.max(0, Math.min(m?.szDecimals ?? 4, 7 - Math.max(1, intDigits(max || 1))));
const fcol = (s, d) => (s == null || !isFinite(s) ? '—' : Math.abs(s) >= 1e7 ? num(s) : nf(d).format(s));
const fval = (v) => (v == null || !isFinite(v) ? '—' : Math.abs(v) >= 1e4 ? usd(v) : (v < 0 ? '-$' : '$') + nf(2).format(Math.abs(v)));
const frate = (r, d = 4) => (r == null ? '—' : (r > 0 ? '+' : '') + (r * 100).toFixed(d) + '%');
const fapr = (r, hours = 1) => (r == null ? '—' : (r > 0 ? '+' : '') + ((r / hours) * 24 * 365 * 100).toFixed(1) + '%');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const stamp = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const pnum = (s) => { const v = Number(String(s ?? '').replace(/[, ]/g, '')); return Number.isFinite(v) && v > 0 ? v : 0; };
const floorTo = (v, d) => { const f = 10 ** d; return Math.floor(v * f + 1e-9) / f; };
const nextFunding = () => Math.ceil((Date.now() + 1) / 3600e3) * 3600e3; // Hyperliquid pays funding every hour, on the hour
const countdown = () => { const s = Math.max(0, Math.floor((nextFunding() - Date.now()) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const evmProvider = () => (window.ethereum?.request ? window.ethereum : window.phantom?.ethereum?.request ? window.phantom.ethereum : null);
const token = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
// chart colours from the theme's CSS tokens (read again whenever the theme or accent changes)
const hex6 = (c) => (/^#[0-9a-f]{3}$/i.test(c) ? '#' + c.slice(1).replace(/./g, '$&$&') : c);
const withAlpha = (c, aa) => (c = hex6(c), /^#[0-9a-f]{6}$/i.test(c) ? c + aa : c);
function mixHex(a, b, t) {
  a = hex6(a); b = hex6(b);
  if (!/^#[0-9a-f]{6}$/i.test(a) || !/^#[0-9a-f]{6}$/i.test(b)) return b;
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  return '#' + [16, 8, 0].map((s) => { const u = (x >> s) & 255, v = (y >> s) & 255; return Math.round(u + (v - u) * t).toString(16).padStart(2, '0'); }).join('');
}
function palette() {
  const bg = token('--bg', '#07080b'), panel = token('--panel', '#0c0e13'), line = token('--line', '#1b1f29');
  return { up: token('--up', '#2fd38b'), down: token('--down', '#ff5d6c'), line, muted: token('--muted', '#7d8496'), bg, panel, grid: mixHex(bg, line, 0.55), fgrid: mixHex(panel, line, 0.6) };
}
const mobile = () => matchMedia('(max-width: 1100px)').matches;

register({
  id: 'perps', tab: 'perps', match: /^#\/perps(?:\/([A-Za-z0-9]{1,24}))?\/?$/, title: ([c]) => `${c ? c + ' perp' : 'Perps'} · Nought`,
  mount(view, [param]) {
    const S = {
      alive: true, coin: param || LS.get('perps.coin', 'BTC'), list: memo.list, by: new Map(memo.list.map((m) => [m.coin, m])), mkErr: '', mkBusy: false, prevMark: new Map(), q: '',
      book: null, nsig: 0, trades: [], tradesReady: false, last: null, pane: 'chart', feeds: [], candleOff: null,
      chart: null, candle: null, vol: null, bars: [], cseq: 0, fchart: null, fseries: null, fund: [], fundErr: '', fundCoin: '', pred: null,
      addr: loadAddr(), acct: null, orders: null, fills: null, acctErr: '', acctBusy: false, acctFor: '', raf: 0, dirty: new Set(), formFor: '',
      F: { side: 'long', type: 'market', px: '', size: '', lev: 0, levPick: 0, margin: 'cross', reduce: false, tpsl: false, tp: '', sl: '' },
    };
    if (!hl.COIN_RE.test(S.coin)) S.coin = 'BTC';
    const mk = () => S.by.get(S.coin);
    const offs = [];

    view.innerHTML = `<div class="pp" data-pane="chart">
      <nav class="pp-switch" aria-label="Perps sections">${PANES.map(([k, l]) => `<button type="button" data-pane="${k}" class="${k === 'chart' ? 'on' : ''}">${l}</button>`).join('')}</nav>
      <section class="pp-scr" aria-label="Markets">
        <div class="pp-scr-h">
          <label class="pp-q"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><input id="pp-q" placeholder="Search markets" spellcheck="false" autocomplete="off" aria-label="Search markets"></label>
          <div class="pp-only"><button type="button" data-only="all">All <span id="pp-n" class="dim"></span></button><button type="button" data-only="fav">${STAR} Starred</button><button type="button" class="pp-wide" data-wide title="Show every column">Expand ⇔</button></div>
        </div>
        <div class="pp-tbl-wrap"><table class="pp-tbl"><thead><tr id="pp-th"></tr></thead><tbody id="pp-rows"></tbody></table></div>
      </section>
      <header class="pp-head" id="pp-head"></header>
      <section class="pp-mid">
        <div class="pp-bar">${IVS.map((k) => `<button type="button" data-iv="${k}" class="${k === ui.iv ? 'on' : ''}">${k}</button>`).join('')}<span class="pp-src"><i class="pp-dot" id="pp-dot"></i><span id="pp-src">Hyperliquid</span></span></div>
        <div class="pp-chart" id="pp-chart"><div class="pp-note" id="pp-cnote">Loading chart…</div></div>
        <div class="pp-low">
          <div class="pp-tabs">${LOW_TABS.map(([k, l]) => `<button type="button" data-low="${k}" class="${k === ui.low ? 'on' : ''}">${l}</button>`).join('')}<span class="pp-tabs-r" id="pp-acct-line"></span></div>
          <div class="pp-fund" id="pp-fund"><div class="pp-fwrap"><div class="pp-fhd"><span>Hourly funding, last 7 days</span><span id="pp-favg" class="mono"></span></div><div class="pp-fchart" id="pp-fchart"><div class="pp-note" id="pp-fnote">Loading funding…</div></div></div><div class="pp-fside" id="pp-fside"></div></div>
          <div class="pp-acct" id="pp-acct" hidden></div>
        </div>
      </section>
      <section class="pp-ob" aria-label="Order book and trades">
        <div class="pp-sec-h"><b>Order book</b><select id="pp-group" aria-label="Group price levels"><option value="0">Exact</option></select><button type="button" class="pp-unit" id="pp-bunit" title="Show sizes in coin or USD"></button></div>
        <div class="pp-cols"><span>Price</span><span>Size</span><span>Total</span></div>
        <div class="pp-asks" id="pp-asks"></div>
        <div class="pp-spread" id="pp-spread"><span class="dim">Spread</span></div>
        <div class="pp-bids" id="pp-bids"></div>
        <div class="pp-sec-h pp-tr-h"><b>Trades</b><span class="dim" id="pp-tr-n"></span></div>
        <div class="pp-cols"><span>Price</span><span>Size</span><span>Time</span></div>
        <div class="pp-trades" id="pp-trades"></div>
      </section>
      <aside class="pp-form" id="pp-form" aria-label="Order preview"></aside>
    </div>`;
    const root = $('.pp', view);

    // ---------- screener
    function screenerRows() {
      const q = S.q.trim().toLowerCase(), k = ui.sort, d = ui.dir;
      const l = S.list.filter((m) => (!q || m.coin.toLowerCase().includes(q)) && (ui.only !== 'fav' || favs.has(m.coin)));
      return l.sort((a, b) => (k === 'coin' ? d * a.coin.localeCompare(b.coin) : d * ((a[k] ?? -1e30) - (b[k] ?? -1e30)) || a.coin.localeCompare(b.coin)));
    }
    function drawScreener() {
      $('#pp-th', view).innerHTML = COLS.map(([k, l]) => `<th data-sort="${k}" class="${k === ui.sort ? 'on' : ''}" aria-sort="${k === ui.sort ? (ui.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${k === ui.sort ? (ui.dir > 0 ? ' ▴' : ' ▾') : ''}</th>`).join('');
      $$('[data-only]', view).forEach((b) => b.classList.toggle('on', b.dataset.only === ui.only));
      $('#pp-n', view).textContent = S.list.length || '';
      const body = $('#pp-rows', view);
      if (!S.list.length) { body.innerHTML = `<tr><td colspan="7" class="pp-empty">${S.mkErr ? `Couldn't load Hyperliquid markets. ${esc(S.mkErr)} Retrying every 15 s.` : '<span class="pp-pulse"></span>Loading markets…'}</td></tr>`; return; }
      const rows = screenerRows();
      if (!rows.length) { body.innerHTML = `<tr><td colspan="7" class="pp-empty">${ui.only === 'fav' && !favs.size ? 'Star a market to keep it here.' : `No market matches “${esc(S.q.trim())}”.`}</td></tr>`; return; }
      body.innerHTML = rows.map((m) => {
        const pm = S.prevMark.get(m.coin), fl = pm == null || pm === m.mark ? '' : m.mark > pm ? 'fl-up' : 'fl-dn';
        return `<tr data-coin="${esc(m.coin)}" class="${m.coin === S.coin ? 'on' : ''}"><td class="c0"><button type="button" class="pp-fav${favs.has(m.coin) ? ' on' : ''}" data-fav="${esc(m.coin)}" aria-label="${favs.has(m.coin) ? 'Unstar' : 'Star'} ${esc(m.coin)}">${STAR}</button><b>${esc(m.coin)}</b></td><td class="${fl}">${fpx(m.mark, m)}</td><td class="${cls(m.change)}">${pct(m.change, 2)}</td><td class="${cls(m.funding)}">${frate(m.funding)}</td><td>${usd(m.oiUsd)}</td><td>${usd(m.vol)}</td><td>${m.maxLeverage}x</td></tr>`;
      }).join('');
    }
    async function loadMarkets() {
      if (S.mkBusy) return; S.mkBusy = true;
      try {
        const list = await hl.markets(); if (!S.alive) return;
        const had = S.by.has(S.coin);
        S.list = list; S.by = new Map(list.map((m) => [m.coin, m])); S.mkErr = '';
        memo.list = list; memo.at = Date.now();
        drawScreener(); list.forEach((m) => S.prevMark.set(m.coin, m.mark));
        if (!S.by.has(S.coin)) {
          const alt = list.find((m) => m.coin.toLowerCase() === S.coin.toLowerCase());
          if (alt) select(alt.coin, { replace: true });
          else { toast(`Hyperliquid has no live market called ${esc(S.coin)}. Showing BTC.`, 'err'); select('BTC', { replace: true }); }
          return;
        }
        drawHead(); drawFundSide();
        if (!had || S.formFor !== S.coin) { drawForm(); groupOptions(); applyPriceFormat(); } else calcForm();
        if (ui.low === 'positions' && S.acct) drawAccount();
        const s = $('#pp-src', view); if (s && hl.wsState().ok) s.textContent = 'Hyperliquid · live';
      } catch (e) {
        if (!S.alive) return;
        S.mkErr = e.message || 'Network error.';
        if (!S.list.length) { drawScreener(); drawHead(); calcForm(); } else { const s = $('#pp-src', view); if (s) s.textContent = 'Hyperliquid · stats delayed'; }
      } finally { S.mkBusy = false; }
    }

    // ---------- header
    function drawHead() {
      const m = mk(), c = S.coin, href = safeUrl(hl.tradeUrl(c));
      const id = `<div class="pp-id"><button type="button" class="pp-fav${favs.has(c) ? ' on' : ''}" data-fav="${esc(c)}" aria-label="${favs.has(c) ? 'Unstar' : 'Star'} ${esc(c)}">${STAR}</button><b class="pp-coin">${esc(c)}</b><span class="pp-tag pp-q-tag">USDC perp</span>${m ? `<span class="pp-tag lev">${m.maxLeverage}x</span>${m.onlyIsolated ? '<span class="pp-tag">isolated</span>' : ''}` : ''}</div>`;
      const px = S.last ?? m?.mid ?? m?.mark;
      $('#pp-head', view).innerHTML = `${id}<b class="pp-last" id="pp-last">${fpx(px, m)}</b>
        <div class="pp-stats">${m ? [['Mark', fpx(m.mark, m)], ['Oracle', fpx(m.oracle, m)], ['24h', pct(m.change, 2), cls(m.change)], ['24h volume', usd(m.vol)], ['Open interest', usd(m.oiUsd)], ['Funding 1h · next', `<i class="${cls(m.funding)}">${frate(m.funding)}</i> <i class="dim" id="pp-cd">${countdown()}</i>`]]
          .map(([k, v, c2]) => `<div><span>${k}</span><b class="${c2 || ''}">${v}</b></div>`).join('') : `<div><span>Market</span><b class="muted">${S.mkErr ? 'Stats unavailable' : 'Loading…'}</b></div>`}</div>
        ${href ? `<a class="pp-out" href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="Open ${esc(c)} on Hyperliquid">Hyperliquid ↗</a>` : ''}`;
    }
    function setLast(px) {
      if (px == null) return;
      const prev = S.last; S.last = px;
      const el = $('#pp-last', view); if (!el) return;
      el.textContent = fpx(px, mk());
      if (prev != null && prev !== px) { el.classList.remove('fl-up', 'fl-dn'); void el.offsetWidth; el.classList.add(px > prev ? 'fl-up' : 'fl-dn'); }
    }

    // ---------- chart
    function makeChart() {
      if (typeof LightweightCharts === 'undefined') { $('#pp-cnote', view).textContent = 'The chart library did not load. Check your connection and reload.'; return; }
      const { up, down, line, muted, bg, grid } = palette();
      S.chart = LightweightCharts.createChart($('#pp-chart', view), { autoSize: true, layout: { background: { color: bg }, textColor: muted, fontFamily: 'Geist Mono, ui-monospace, monospace', fontSize: 11 }, grid: { vertLines: { color: grid }, horzLines: { color: grid } }, rightPriceScale: { borderColor: line }, timeScale: { borderColor: line, timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 } });
      S.candle = S.chart.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
      S.candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
      S.vol = S.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      S.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
      S.upA = withAlpha(up, '55'); S.downA = withAlpha(down, '55');
    }
    // the theme or accent changed: repaint both charts with the new tokens
    function recolor() {
      if (!S.alive) return;
      const { up, down, line, muted, bg, panel, grid, fgrid } = palette();
      if (S.chart) {
        S.chart.applyOptions({ layout: { background: { color: bg }, textColor: muted }, grid: { vertLines: { color: grid }, horzLines: { color: grid } }, rightPriceScale: { borderColor: line }, timeScale: { borderColor: line } });
        S.candle.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
        S.upA = withAlpha(up, '55'); S.downA = withAlpha(down, '55');
        if (S.bars.length) S.vol.setData(S.bars.map(volBar));
      }
      if (S.fchart) {
        S.fchart.applyOptions({ layout: { background: { color: panel }, textColor: muted }, grid: { horzLines: { color: fgrid } }, rightPriceScale: { borderColor: line }, timeScale: { borderColor: line } });
        drawFunding();
      }
    }
    offs.push(onEvent('theme', recolor));
    const shift = (b) => ({ ...b, time: b.time + TZ });
    const volBar = (b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? S.upA : S.downA });
    function applyPriceFormat() {
      const m = mk(); if (!S.candle || !m) return;
      const d = pxDec(m.mark, m.szDecimals);
      S.candle.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: 1 / 10 ** d } });
    }
    const chartNote = (t) => { const n = $('#pp-cnote', view); if (n) { n.textContent = t; n.hidden = !t; } };
    async function loadChart() {
      if (!S.chart) return;
      const seq = ++S.cseq, coin = S.coin, iv = ui.iv;
      chartNote('Loading chart…');
      try {
        const bars = await hl.candles(coin, iv);
        if (seq !== S.cseq || !S.alive) return;
        const live = S.bars.at(-1);
        S.bars = bars.map(shift);
        if (live && S.bars.length && live.time > S.bars.at(-1).time) S.bars.push(live); // keep a live bar that arrived first
        applyPriceFormat();
        S.candle.setData(S.bars); S.vol.setData(S.bars.map(volBar));
        if (S.bars.length) S.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, S.bars.length - 140), to: S.bars.length + 4 });
        chartNote(S.bars.length ? '' : 'No candles for this market yet.');
      } catch (e) {
        if (seq !== S.cseq || !S.alive) return;
        S.bars = []; S.candle.setData([]); S.vol.setData([]);
        chartNote(`Chart history did not load. ${e.message || ''}`);
      }
    }
    function watchCandle() {
      S.candleOff?.(); S.bars = [];
      const coin = S.coin, iv = ui.iv;
      S.candleOff = hl.candleFeed(coin, iv, (b) => {
        if (!S.candle || coin !== S.coin || iv !== ui.iv) return;
        const x = shift(b), last = S.bars.at(-1);
        if (last && x.time < last.time) return;
        if (last && x.time === last.time) S.bars[S.bars.length - 1] = x; else S.bars.push(x);
        try { S.candle.update(x); S.vol.update(volBar(x)); } catch { /* history is being swapped in */ }
        if (S.bars.length) chartNote('');
      });
    }

    // ---------- order book and trades (websocket), drawn at most once per frame
    function later(what) { S.dirty.add(what); if (!S.raf) S.raf = requestAnimationFrame(flush); }
    function flush() {
      S.raf = 0; if (!S.alive) return;
      if (S.dirty.has('book')) drawBook();
      if (S.dirty.has('trades')) drawTrades();
      S.dirty.clear();
    }
    const bookMid = () => (S.book?.bids[0] && S.book?.asks[0] ? (S.book.bids[0].px + S.book.asks[0].px) / 2 : null);
    function drawBook() {
      const asksEl = $('#pp-asks', view), bidsEl = $('#pp-bids', view), sp = $('#pp-spread', view), m = mk(), b = S.book;
      $('#pp-bunit', view).textContent = ui.bookUnit === 'usd' ? 'USD' : S.coin;
      if (!b) { asksEl.innerHTML = ''; bidsEl.innerHTML = '<div class="pp-empty"><span class="pp-pulse"></span>Loading the book…</div>'; sp.innerHTML = '<span class="dim">Spread</span>'; return; }
      if (!b.asks.length && !b.bids.length) { asksEl.innerHTML = ''; bidsEl.innerHTML = '<div class="pp-empty">No resting orders right now.</div>'; sp.innerHTML = '<span class="dim">Spread</span>'; return; }
      const fit = (el) => Math.max(3, Math.min(20, Math.floor((el.clientHeight || ROW_H * 10) / ROW_H)));
      const asks = b.asks.slice(0, fit(asksEl)), bids = b.bids.slice(0, fit(bidsEl));
      const val = (l) => (ui.bookUnit === 'usd' ? l.sz * l.px : l.sz);
      let ca = 0, cb = 0;
      const A = asks.map((l) => ({ ...l, cum: (ca += val(l)) })), B = bids.map((l) => ({ ...l, cum: (cb += val(l)) }));
      const d = colDec(Math.max(ca, cb), m), fv = (v) => (ui.bookUnit === 'usd' ? usd(v) : fcol(v, d));
      const max = Math.max(ca, cb) || 1, ref = m?.mark || b.bids[0]?.px || b.asks[0]?.px;
      const gp = S.nsig && ref ? (p) => nf(Math.min(pxDec(ref, m?.szDecimals ?? 0), Math.max(0, S.nsig - intDigits(ref)))).format(p) : (p) => fpx(p, m); // grouped levels at the group's precision
      const row = (l, side) => `<div class="pp-lv ${side}" data-px="${esc(String(l.px))}" style="--w:${((l.cum / max) * 100).toFixed(1)}%"><span>${gp(l.px)}</span><span>${fv(val(l))}</span><span>${fv(l.cum)}</span></div>`;
      asksEl.innerHTML = A.slice().reverse().map((l) => row(l, 'a')).join('');
      bidsEl.innerHTML = B.map((l) => row(l, 'b')).join('');
      const a0 = b.asks[0]?.px, b0 = b.bids[0]?.px;
      sp.innerHTML = a0 != null && b0 != null ? `<span class="dim">Spread</span><b>${gp(a0 - b0)}</b><span class="dim">${(((a0 - b0) / ((a0 + b0) / 2)) * 100).toFixed(3)}%</span>` : '<span class="dim">One side is empty</span>';
    }
    function drawTrades() {
      const el = $('#pp-trades', view), m = mk();
      if (!S.trades.length) { el.innerHTML = `<div class="pp-empty">${S.tradesReady ? 'No trades yet.' : '<span class="pp-pulse"></span>Waiting for trades…'}</div>`; return; }
      const d = colDec(Math.max(...S.trades.map((t) => t.sz)), m);
      el.innerHTML = S.trades.map((t) => `<div class="pp-tr ${t.side}"><span>${fpx(t.px, m)}</span><span>${ui.bookUnit === 'usd' ? usd(t.px * t.sz) : fcol(t.sz, d)}</span><span>${clock(t.time)}</span></div>`).join('');
    }
    function groupOptions() {
      const m = mk(), ref = bookMid() ?? m?.mark, sel = $('#pp-group', view);
      if (!sel) return;
      const tick = ref ? 10 ** -pxDec(m?.mark || ref, m?.szDecimals ?? 0) : null;
      const label = (s) => (s >= 1 ? nf(0).format(s) : s.toFixed(Math.min(8, Math.ceil(-Math.log10(s) - 1e-9))));
      const opts = [[0, tick ? label(tick) : 'Exact']];
      if (ref) for (const n of [5, 4, 3, 2]) { const step = 10 ** (intDigits(ref) - n); if (!tick || step > tick * 1.0001) opts.push([n, label(step)]); }
      if (!opts.some(([n]) => n === S.nsig)) S.nsig = 0;
      sel.innerHTML = opts.map(([n, l]) => `<option value="${n}" ${n === S.nsig ? 'selected' : ''}>${esc(l)}</option>`).join('');
    }
    function watchBook() {
      S.feeds.find((f) => f.k === 'book')?.off();
      S.feeds = S.feeds.filter((f) => f.k !== 'book');
      const coin = S.coin, nsig = S.nsig;
      S.feeds.push({ k: 'book', off: hl.bookFeed(coin, nsig || null, (b) => { if (coin !== S.coin || nsig !== S.nsig) return; const first = !S.book; S.book = b; later('book'); if (first) { groupOptions(); calcForm(); } }) });
    }
    function watchTrades() {
      S.feeds.find((f) => f.k === 'trades')?.off();
      S.feeds = S.feeds.filter((f) => f.k !== 'trades');
      const coin = S.coin;
      S.feeds.push({ k: 'trades', off: hl.tradeFeed(coin, (list) => {
        if (coin !== S.coin) return;
        const seen = new Set(S.trades.map((t) => t.tid));
        const fresh = list.filter((t) => !seen.has(t.tid));
        S.tradesReady = true;
        if (!fresh.length) return;
        S.trades = fresh.concat(S.trades).sort((a, b) => b.time - a.time).slice(0, 60);
        setLast(S.trades[0].px);
        later('trades');
      }) });
    }
    on(view, 'click', '#pp-asks .pp-lv, #pp-bids .pp-lv', (el) => {
      const px = Number(el.dataset.px); if (!(px > 0)) return;
      S.F.type = 'limit'; S.F.px = String(px); drawForm();
      if (mobile()) setPane('trade');
    });

    // ---------- funding
    async function loadFunding() {
      const coin = S.coin;
      try {
        const rows = await hl.fundingHistory(coin);
        if (!S.alive || coin !== S.coin) return;
        S.fund = rows; S.fundErr = ''; S.fundCoin = coin;
      } catch (e) { if (!S.alive || coin !== S.coin) return; S.fundErr = e.message || 'Network error.'; if (S.fundCoin !== coin) S.fund = []; }
      drawFunding();
    }
    async function loadPredicted() {
      try { S.pred = await hl.predictedFundings(); } catch { /* keep the last one */ }
      if (S.alive) drawFundSide();
    }
    function drawFunding() {
      const note = $('#pp-fnote', view);
      if (S.fchart === null && typeof LightweightCharts !== 'undefined' && ui.low === 'funding') {
        const { line, muted, panel: bg, fgrid } = palette();
        S.fchart = LightweightCharts.createChart($('#pp-fchart', view), { autoSize: true, grid: { vertLines: { visible: false }, horzLines: { color: fgrid } }, rightPriceScale: { borderColor: line }, timeScale: { borderColor: line, timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 }, handleScroll: false, handleScale: false, layout: { background: { color: bg }, textColor: muted, fontFamily: 'Geist Mono, ui-monospace, monospace', fontSize: 10, attributionLogo: false } });
        // no last-value label: it sat on the top axis label, and the current rate is listed right beside the chart
        S.fseries = S.fchart.addHistogramSeries({ priceFormat: { type: 'custom', formatter: (v) => v.toFixed(4) + '%', minMove: 0.00001 }, priceLineVisible: false, lastValueVisible: false });
        S.fseries.priceScale().applyOptions({ scaleMargins: { top: 0.14, bottom: 0.06 } });
      }
      const up = token('--up', '#2fd38b'), down = token('--down', '#ff5d6c');
      if (S.fseries) {
        S.fseries.setData(S.fund.map((x) => ({ time: Math.floor(x.time / 3600e3) * 3600 + TZ, value: x.rate * 100, color: x.rate >= 0 ? up : down })).filter((x, i, a) => !i || x.time > a[i - 1].time));
        S.fchart.timeScale().fitContent();
      }
      if (note) { note.hidden = S.fund.length > 0; note.textContent = S.fundErr ? `Funding history did not load. ${S.fundErr}` : S.fundCoin === S.coin ? 'No funding history yet.' : 'Loading funding…'; }
      const avg = (h) => { const r = S.fund.filter((x) => x.time >= Date.now() - h * 3600e3); return r.length ? r.reduce((s, x) => s + x.rate, 0) / r.length : null; };
      const a24 = avg(24), a7 = avg(168);
      $('#pp-favg', view).innerHTML = S.fund.length ? `avg 24h <b class="${cls(a24)}">${frate(a24)}</b> · 7d <b class="${cls(a7)}">${frate(a7)}</b>` : '';
      drawFundSide();
    }
    function drawFundSide() {
      const el = $('#pp-fside', view); if (!el) return;
      const m = mk(), pred = S.pred?.get(S.coin) || [];
      const venues = pred.slice().sort((a, b) => (a.venue === 'HlPerp' ? -1 : b.venue === 'HlPerp' ? 1 : a.label.localeCompare(b.label)));
      el.innerHTML = `<div class="pp-kv"><span>Now, per hour</span><b class="${cls(m?.funding)}">${frate(m?.funding)}</b></div>
        <div class="pp-kv"><span>Yearly at this rate</span><b class="${cls(m?.funding)}">${fapr(m?.funding)}</b></div>
        <div class="pp-kv"><span>Next payment in</span><b id="pp-cd2">${countdown()}</b></div>
        <p class="pp-hint">${m?.funding == null ? '' : m.funding >= 0 ? 'Positive: longs pay shorts.' : 'Negative: shorts pay longs.'}</p>
        <table class="pp-mini"><thead><tr><th>Predicted</th><th>Rate</th><th>Every</th><th>Yearly</th></tr></thead><tbody>${venues.length ? venues.map((v) => `<tr><td>${esc(v.label)}</td><td class="${cls(v.rate)}">${frate(v.rate)}</td><td>${esc(String(v.hours))}h</td><td class="${cls(v.rate)}">${fapr(v.rate, v.hours)}</td></tr>`).join('') : `<tr><td colspan="4" class="dim">${S.pred ? 'No prediction for this market.' : 'Loading…'}</td></tr>`}</tbody></table>`;
    }

    // ---------- read-only account view (positions, open orders, fills of any 0x address)
    const acctTab = () => ui.low !== 'funding';
    async function loadAccount() {
      if (!S.addr || S.acctBusy) return;
      S.acctBusy = true; const a = S.addr;
      try {
        const [acct, orders, fl] = await Promise.all([hl.account(a), ui.low === 'orders' || !S.orders ? hl.openOrders(a) : S.orders, ui.low === 'fills' || !S.fills ? hl.fills(a) : S.fills]);
        if (!S.alive || a !== S.addr) return;
        S.acct = acct; S.orders = orders; S.fills = fl; S.acctErr = ''; S.acctFor = a;
      } catch (e) { if (!S.alive || a !== S.addr) return; S.acctErr = e.message || 'Network error.'; }
      finally { S.acctBusy = false; }
      drawAccount();
    }
    function setAddr(a) {
      S.addr = hl.isAddr(a) ? a : ''; LS.set('perps.addr', S.addr);
      S.acct = S.orders = S.fills = null; S.acctErr = ''; S.acctFor = '';
      drawAccount(); if (S.addr) { due.acct = Date.now() + 15e3; loadAccount(); }
    }
    function drawAccount() {
      const line = $('#pp-acct-line', view), el = $('#pp-acct', view);
      line.innerHTML = S.addr ? `<span class="dim">Viewing</span> <span class="mono">${esc(short(S.addr, 5))}</span>${S.acct ? ` · <span class="dim">value</span> <b class="mono">${fval(S.acct.value)}</b>` : ''} <button type="button" class="pp-link" data-act="change-addr">Change</button>` : '';
      if (!acctTab()) return;
      if (!S.addr) {
        el.innerHTML = `<form class="pp-addr" id="pp-addr" autocomplete="off"><p>See any Hyperliquid account's positions, open orders and fills by its EVM address. Read-only: nothing is signed and no funds move.</p>
          <div class="pp-addr-row"><input name="a" placeholder="0x… address" spellcheck="false" aria-label="EVM address"><button class="btn">View</button>${evmProvider() ? '<button type="button" class="btn btn-ghost" data-act="evm">Use my EVM wallet</button>' : ''}</div></form>`;
        return;
      }
      if (S.acctFor !== S.addr) { el.innerHTML = `<div class="pp-empty">${S.acctErr ? `Couldn't load this account. ${esc(S.acctErr)}` : '<span class="pp-pulse"></span>Loading account…'}</div>`; return; }
      const err = S.acctErr ? `<div class="pp-warn">Showing the last data. ${esc(S.acctErr)}</div>` : '';
      const coinCell = (c) => (S.by.has(c) ? `<button type="button" class="pp-link" data-goto="${esc(c)}">${esc(c)}</button>` : esc(c));
      let html = '';
      if (ui.low === 'positions') {
        const a = S.acct, p = a.positions;
        html = `<div class="pp-sum"><span>Account value <b>${fval(a.value)}</b></span><span>Margin used <b>${fval(a.marginUsed)}</b></span><span>Position value <b>${fval(a.ntl)}</b></span><span>Withdrawable <b>${fval(a.withdrawable)}</b></span></div>`
          + (p.length ? `<div class="pp-t-wrap"><table class="pp-t"><thead><tr><th>Market</th><th>Size</th><th>Value</th><th>Entry</th><th>Mark</th><th>PnL (ROE)</th><th>Liq. price</th><th>Margin</th><th>Funding</th></tr></thead><tbody>${p.map((x) => {
            const m = S.by.get(x.coin);
            return `<tr><td>${coinCell(x.coin)} <span class="dim">${x.lev.value ? esc(String(x.lev.value)) + 'x ' : ''}${x.lev.type}</span></td><td class="${x.size > 0 ? 'up' : 'down'}">${x.size > 0 ? 'Long' : 'Short'} ${fsz(Math.abs(x.size), m)}</td><td>${fval(x.value)}</td><td>${fpx(x.entry, m)}</td><td>${fpx(m?.mark, m)}</td><td class="${cls(x.upnl)}">${fval(x.upnl)} (${pct(x.roe == null ? null : x.roe * 100, 1)})</td><td>${x.liq ? fpx(x.liq, m) : '—'}</td><td>${fval(x.marginUsed)}</td><td class="${cls(-(x.funding || 0))}">${fval(x.funding == null ? null : -x.funding)}</td></tr>`;
          }).join('')}</tbody></table></div>` : '<div class="pp-empty">No open positions.</div>');
      } else if (ui.low === 'orders') {
        const o = S.orders || [];
        html = o.length ? `<div class="pp-t-wrap"><table class="pp-t"><thead><tr><th>Market</th><th>Type</th><th>Side</th><th>Price</th><th>Size</th><th>Trigger</th><th>Reduce only</th><th>Placed</th></tr></thead><tbody>${o.map((x) => {
          const m = S.by.get(x.coin);
          return `<tr><td>${coinCell(x.coin)}</td><td>${esc(x.type)}</td><td class="${x.side === 'buy' ? 'up' : 'down'}">${x.side === 'buy' ? 'Buy' : 'Sell'}</td><td>${fpx(x.px, m)}</td><td>${x.sz ? fsz(x.sz, m) : '<span class="dim">whole position</span>'}</td><td>${x.trigger ? esc(x.trigger) : '—'}</td><td>${x.reduceOnly ? 'Yes' : 'No'}</td><td>${stamp(x.time)}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="pp-empty">No open orders.</div>';
      } else {
        const f = S.fills || [];
        html = f.length ? `<div class="pp-t-wrap"><table class="pp-t"><thead><tr><th>Time</th><th>Market</th><th>Direction</th><th>Price</th><th>Size</th><th>Value</th><th>Hyperliquid fee</th><th>App (builder) fee</th><th>Closed PnL</th></tr></thead><tbody>${f.map((x) => {
          const m = S.by.get(x.coin), hlFee = x.fee == null ? null : x.fee - x.builderFee;
          return `<tr><td>${stamp(x.time)}</td><td>${coinCell(x.coin)}</td><td class="${x.side === 'buy' ? 'up' : 'down'}">${esc(x.dir || (x.side === 'buy' ? 'Buy' : 'Sell'))}</td><td>${fpx(x.px, m)}</td><td>${fsz(x.sz, m)}</td><td>${fval(x.px * x.sz)}</td><td>${fval(hlFee)}</td><td class="${x.builderFee > 0 ? 'pp-warn-t' : 'dim'}">${x.builderFee > 0 ? fval(x.builderFee) : '0'}</td><td class="${cls(x.pnl)}">${x.pnl ? fval(x.pnl) : '—'}</td></tr>`;
        }).join('')}</tbody></table></div><p class="pp-hint">An app (builder) fee is what the app used for that trade added on top of Hyperliquid's fee. Nought's is 0.</p>` : '<div class="pp-empty">No fills yet.</div>';
      }
      el.innerHTML = err + html;
    }
    async function useEvm() {
      const p = evmProvider();
      if (!p) { toast('No EVM wallet found in this browser.', 'err'); return; }
      try {
        const a = await p.request({ method: 'eth_requestAccounts' });
        const x = Array.isArray(a) ? a[0] : '';
        if (!hl.isAddr(x)) throw new Error('The wallet did not share an address.');
        if (S.alive) setAddr(x);
      } catch (e) { toast(esc(e?.message || 'The wallet did not connect.'), 'err'); }
    }
    function setLow(k) {
      ui.low = k; saveUi();
      $$('[data-low]', view).forEach((b) => b.classList.toggle('on', b.dataset.low === k));
      $('#pp-fund', view).hidden = k !== 'funding'; $('#pp-acct', view).hidden = k === 'funding';
      if (k === 'funding') drawFunding();
      else { drawAccount(); if (S.addr) { due.acct = Date.now() + 15e3; loadAccount(); } }
    }

    // ---------- order preview (read-only: nothing here signs or sends)
    function drawForm() {
      const m = mk(), F = S.F, c = S.coin, href = safeUrl(hl.tradeUrl(c));
      const fresh = m && S.formFor !== c;
      S.formFor = m ? c : '';
      const maxL = m?.maxLeverage || 1;
      if (fresh || !F.lev || F.lev > maxL) F.lev = Math.min(F.levPick || 10, maxL);
      if (m?.onlyIsolated) F.margin = 'isolated';
      const unit = ui.sizeUnit === 'usd' ? 'USD' : c;
      $('#pp-form', view).innerHTML = `
        <div class="pp-fh"><b>Order preview</b><span class="pp-ro" title="Nought does not place Hyperliquid orders yet">Read-only</span></div>
        <div class="bs"><button type="button" class="buy ${F.side === 'long' ? 'on' : ''}" data-fside="long">Long</button><button type="button" class="sell ${F.side === 'short' ? 'on' : ''}" data-fside="short">Short</button></div>
        <div class="pp-seg"><button type="button" data-ftype="market" class="${F.type === 'market' ? 'on' : ''}">Market</button><button type="button" data-ftype="limit" class="${F.type === 'limit' ? 'on' : ''}">Limit</button></div>
        ${F.type === 'limit' ? `<div class="field"><span>Limit price</span><div class="amt"><input id="pp-px" inputmode="decimal" value="${esc(F.px)}" placeholder="0" aria-label="Limit price"><button type="button" class="pp-mini-btn" data-act="mid">Mid</button><em>USD</em></div></div>` : ''}
        <div class="field"><span>Size<span class="mono" id="pp-sz-alt"></span></span><div class="amt"><input id="pp-sz" inputmode="decimal" value="${esc(F.size)}" placeholder="0" aria-label="Order size"><button type="button" class="pp-mini-btn" data-act="unit" title="Switch between USD and ${esc(c)}">${esc(unit)} ⇄</button></div>
          ${ui.sizeUnit === 'usd' ? `<div class="presets">${[100, 500, 1000, 5000].map((v) => `<button type="button" data-qsz="${v}">$${v >= 1000 ? v / 1000 + 'K' : v}</button>`).join('')}</div>` : ''}</div>
        <div class="field"><span>Leverage<b class="mono" id="pp-levv">${F.lev}x</b></span><input type="range" id="pp-lev" class="pp-range" min="1" max="${maxL}" step="1" value="${F.lev}" aria-label="Leverage"><div class="pp-ticks"><span>1x</span><span>${Math.max(1, Math.round(maxL / 2))}x</span><span>${maxL}x max</span></div></div>
        <div class="pp-seg">${m?.onlyIsolated ? '<button type="button" class="on" disabled>Isolated only</button>' : `<button type="button" data-fmargin="cross" class="${F.margin === 'cross' ? 'on' : ''}">Cross</button><button type="button" data-fmargin="isolated" class="${F.margin === 'isolated' ? 'on' : ''}">Isolated</button>`}</div>
        <label class="pp-check"><input type="checkbox" id="pp-reduce" ${F.reduce ? 'checked' : ''}> Reduce only</label>
        <label class="pp-check"><input type="checkbox" id="pp-tpsl" ${F.tpsl ? 'checked' : ''}> Take profit / stop loss</label>
        ${F.tpsl ? `<div class="pp-tpsl"><div class="field"><span>Take profit at</span><div class="amt"><input id="pp-tp" inputmode="decimal" value="${esc(F.tp)}" placeholder="price" aria-label="Take profit price"><em>USD</em></div></div><div class="field"><span>Stop loss at</span><div class="amt"><input id="pp-sl" inputmode="decimal" value="${esc(F.sl)}" placeholder="price" aria-label="Stop loss price"><em>USD</em></div></div></div>` : ''}
        <div class="quote" id="pp-sum"></div>
        <button type="button" class="go ${F.side === 'long' ? 'buy' : 'sell'}" disabled>Order entry is off in Nought for now</button>
        ${href ? `<a class="btn btn-accent pp-hl" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Trade ${esc(c)} on Hyperliquid ↗</a>` : ''}
        <p class="note">Nought shows Hyperliquid's live data and adds no fee. Placing orders from here needs an EVM wallet and a Hyperliquid agent key. We have not verified that signing flow end to end, so for now you place orders on Hyperliquid's own site.</p>
        <p class="note">Perps use leverage: a small move against you can wipe out your margin. Hyperliquid charges its own trading fees and funding, and it is not available in every country. Check the rules where you live. Nothing here is advice.</p>`;
      calcForm();
    }
    function calcForm() {
      const sum = $('#pp-sum', view); if (!sum) return;
      const m = mk(), F = S.F;
      if (!m) { sum.innerHTML = `<div><span>Market</span><b class="muted">${S.mkErr ? 'Stats unavailable' : 'Loading…'}</b></div><div><span>Nought fee</span><b class="up">0%</b></div>`; return; }
      const mid = bookMid() ?? m.mid ?? m.mark;
      const px = F.type === 'limit' ? pnum(F.px) : mid, raw = pnum(F.size), s = F.side === 'long' ? 1 : -1;
      const size = px > 0 && raw > 0 ? floorTo(ui.sizeUnit === 'usd' ? raw / px : raw, m.szDecimals) : 0;
      const ntl = size * px, margin = ntl / F.lev, iso = F.margin === 'isolated' || m.onlyIsolated, mmf = 1 / (2 * m.maxLeverage);
      const liq = iso && px > 0 ? px - (s * px * (1 / F.lev - mmf)) / (1 - s * mmf) : null;
      const tp = F.tpsl ? pnum(F.tp) : 0, sl = F.tpsl ? pnum(F.sl) : 0;
      const alt = $('#pp-sz-alt', view); if (alt) alt.textContent = size ? (ui.sizeUnit === 'usd' ? `≈ ${fsz(size, m)} ${S.coin}` : `≈ ${fval(ntl)}`) : '';
      const warn = [];
      if (F.type === 'limit' && !px) warn.push('Enter a limit price.');
      if (raw > 0 && px > 0 && !size) warn.push(`Too small: ${S.coin} trades in steps of ${(1 / 10 ** m.szDecimals).toFixed(m.szDecimals)}.`);
      else if (ntl > 0 && ntl < hl.MIN_ORDER_USD) warn.push(`Hyperliquid's minimum order is $${hl.MIN_ORDER_USD}.`);
      if (F.type === 'limit' && px > 0 && mid && Math.abs(px / mid - 1) > 0.2) warn.push('This limit price is more than 20% from the market.');
      if (tp && px && (tp - px) * s <= 0) warn.push(`Take profit should be ${s > 0 ? 'above' : 'below'} the entry price.`);
      if (sl && px && (sl - px) * s >= 0) warn.push(`Stop loss should be ${s > 0 ? 'below' : 'above'} the entry price.`);
      if (sl && liq && (sl - liq) * s <= 0) warn.push('Your stop loss is past the estimated liquidation price.');
      const takerFee = (ntl * hl.HL_FEES.taker) / 100;
      const rows = [
        ['Size', size ? `${fsz(size, m)} ${esc(S.coin)}` : '—'],
        [F.type === 'limit' ? 'Limit price' : 'Price now (mid)', fpx(px || null, m)],
        ['Order value', ntl ? fval(ntl) : '—'],
        ['Margin needed', ntl ? `${fval(margin)} at ${F.lev}x` : '—'],
        ['Liquidation (est.)', iso ? (liq && ntl ? fpx(Math.max(0, liq), m) : '—') : '<span class="muted pp-prose" title="Cross margin: the liquidation price depends on your whole account">depends on account</span>'],
      ];
      if (tp && size) rows.push(['At take profit', `<span class="${cls((tp - px) * s)}">${fval((tp - px) * s * size)}</span>`]);
      if (sl && size) rows.push(['At stop loss', `<span class="${cls((sl - px) * s)}">${fval((sl - px) * s * size)}</span>`]);
      rows.push(
        ['Hyperliquid fee', F.type === 'market' ? `${ntl ? '≈ ' + fval(takerFee) + ' · ' : ''}${hl.HL_FEES.taker}% taker` : `${hl.HL_FEES.maker}% if it rests, ${hl.HL_FEES.taker}% if it fills at once`],
        ['Builder fee', 'none'],
        ['Nought fee', '<span class="up">0%</span>'],
      );
      sum.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') + (warn.length ? `<div class="pp-warns">${warn.map((w) => `<p>${esc(w)}</p>`).join('')}</div>` : '') + '<p class="pp-hint">Base-tier fees. Estimates only; Hyperliquid has the final numbers.</p>';
    }

    // ---------- selecting a market
    function select(coin, { replace = false } = {}) {
      if (!hl.COIN_RE.test(coin)) return;
      const changed = coin !== S.coin; S.coin = coin; LS.set('perps.coin', coin);
      const h = '#/perps/' + coin;
      if (location.hash !== h) history[replace ? 'replaceState' : 'pushState'](null, '', h);
      document.title = `${coin} perp · Nought`;
      if (changed || !S.feeds.length) {
        S.book = null; S.trades = []; S.tradesReady = false; S.last = null; S.nsig = 0; S.fund = []; S.fundErr = ''; S.fundCoin = '';
        $('#pp-group', view).innerHTML = '<option value="0">Exact</option>';
        watchBook(); watchTrades(); watchCandle(); loadChart(); drawBook(); drawTrades();
        due.fund = 0;
      }
      $$('#pp-rows tr[data-coin]', view).forEach((r) => r.classList.toggle('on', r.dataset.coin === coin));
      drawHead(); drawForm(); groupOptions(); applyPriceFormat(); drawFunding(); if (ui.low === 'positions' && S.acct) drawAccount();
      tick();
    }
    function setPane(p) {
      S.pane = p; root.dataset.pane = p;
      $$('.pp-switch [data-pane]', view).forEach((b) => b.classList.toggle('on', b.dataset.pane === p));
      later('book');
    }

    // ---------- events (delegated; nothing here builds handlers from data)
    function on(el, type, sel, fn) { const h = (e) => { const t = e.target.closest(sel); if (t && el.contains(t)) fn(t, e); }; el.addEventListener(type, h); offs.push(() => el.removeEventListener(type, h)); }
    on(view, 'click', '[data-fav]', (b, e) => {
      e.stopPropagation(); const c = b.dataset.fav; if (!hl.COIN_RE.test(c)) return;
      if (favs.has(c)) favs.delete(c); else favs.add(c);
      saveFavs(); drawScreener(); drawHead();
    });
    on(view, 'click', '#pp-rows tr[data-coin]', (r, e) => { if (e.target.closest('[data-fav]')) return; select(r.dataset.coin); setWide(false); if (mobile()) setPane('chart'); });
    function setWide(w) { root.classList.toggle('wide', w); const b = $('[data-wide]', view); if (b) b.textContent = w ? 'Collapse ⇔' : 'Expand ⇔'; }
    on(view, 'click', '[data-wide]', () => setWide(!root.classList.contains('wide')));
    on(view, 'click', '#pp-th [data-sort]', (th) => { const k = th.dataset.sort; if (ui.sort === k) ui.dir = -ui.dir; else { ui.sort = k; ui.dir = k === 'coin' ? 1 : -1; } saveUi(); drawScreener(); });
    on(view, 'click', '[data-only]', (b) => { ui.only = b.dataset.only === 'fav' ? 'fav' : 'all'; saveUi(); drawScreener(); });
    on(view, 'input', '#pp-q', (i) => { S.q = i.value.slice(0, 24); drawScreener(); });
    on(view, 'keydown', '#pp-q', (i, e) => { if (e.key === 'Enter') { const first = screenerRows()[0]; if (first) { select(first.coin); if (mobile()) setPane('chart'); } } });
    on(view, 'click', '[data-iv]', (b) => { if (!IVS.includes(b.dataset.iv) || b.dataset.iv === ui.iv) return; ui.iv = b.dataset.iv; saveUi(); $$('[data-iv]', view).forEach((x) => x.classList.toggle('on', x === b)); watchCandle(); loadChart(); });
    on(view, 'click', '.pp-switch [data-pane]', (b) => setPane(b.dataset.pane));
    on(view, 'click', '[data-low]', (b) => setLow(b.dataset.low));
    on(view, 'change', '#pp-group', (s) => { S.nsig = Number(s.value) || 0; S.book = null; drawBook(); watchBook(); });
    on(view, 'click', '#pp-bunit', () => { ui.bookUnit = ui.bookUnit === 'usd' ? 'coin' : 'usd'; saveUi(); drawBook(); drawTrades(); });
    on(view, 'click', '[data-goto]', (b) => { if (S.by.has(b.dataset.goto)) select(b.dataset.goto); });
    on(view, 'click', '[data-act]', (b) => {
      const a = b.dataset.act;
      if (a === 'evm') useEvm();
      else if (a === 'change-addr') { setAddr(''); if (!acctTab()) setLow('positions'); }
      else if (a === 'mid') { const m = mk(), mid = bookMid() ?? m?.mid ?? m?.mark; if (mid) { S.F.px = String(Number(mid.toFixed(pxDec(m?.mark || mid, m?.szDecimals ?? 0)))); drawForm(); } }
      else if (a === 'unit') {
        const m = mk(), px = S.F.type === 'limit' ? pnum(S.F.px) : bookMid() ?? m?.mark, v = pnum(S.F.size);
        ui.sizeUnit = ui.sizeUnit === 'usd' ? 'coin' : 'usd'; saveUi();
        if (v && px && m) S.F.size = String(ui.sizeUnit === 'usd' ? Math.round(v * px * 100) / 100 : floorTo(v / px, m.szDecimals));
        drawForm();
      }
    });
    on(view, 'submit', '#pp-addr', (f, e) => { e.preventDefault(); const a = String(new FormData(f).get('a') || '').trim(); if (hl.isAddr(a)) setAddr(a); else toast('Enter a 0x address with 40 hex characters.', 'err'); });
    on(view, 'click', '[data-fside]', (b) => { S.F.side = b.dataset.fside === 'short' ? 'short' : 'long'; drawForm(); });
    on(view, 'click', '[data-ftype]', (b) => { S.F.type = b.dataset.ftype === 'limit' ? 'limit' : 'market'; if (S.F.type === 'limit' && !S.F.px) { const m = mk(), mid = bookMid() ?? m?.mark; if (mid) S.F.px = String(Number(mid.toFixed(pxDec(m?.mark || mid, m?.szDecimals ?? 0)))); } drawForm(); });
    on(view, 'click', '[data-fmargin]', (b) => { S.F.margin = b.dataset.fmargin === 'isolated' ? 'isolated' : 'cross'; drawForm(); });
    on(view, 'click', '[data-qsz]', (b) => { S.F.size = b.dataset.qsz; const i = $('#pp-sz', view); if (i) i.value = S.F.size; calcForm(); });
    on(view, 'input', '#pp-form input', (i) => {
      const F = S.F;
      if (i.id === 'pp-px') F.px = i.value; else if (i.id === 'pp-sz') F.size = i.value; else if (i.id === 'pp-tp') F.tp = i.value; else if (i.id === 'pp-sl') F.sl = i.value;
      else if (i.id === 'pp-lev') { F.lev = F.levPick = Math.max(1, Math.min(mk()?.maxLeverage || 1, Number(i.value) || 1)); $('#pp-levv', view).textContent = F.lev + 'x'; }
      calcForm();
    });
    on(view, 'change', '#pp-form input[type=checkbox]', (i) => { if (i.id === 'pp-reduce') S.F.reduce = i.checked; if (i.id === 'pp-tpsl') { S.F.tpsl = i.checked; drawForm(); } });

    // ---------- polling: markets 15 s, predicted funding 60 s, funding history 5 min, account 15 s; paused while hidden
    const due = { mk: 0, fund: 0, pred: 0, acct: 0 };
    function tick() {
      if (!S.alive || document.hidden) return;
      const now = Date.now();
      if (now >= due.mk) { due.mk = now + 15e3; loadMarkets(); }
      if (now >= due.pred) { due.pred = now + 60e3; loadPredicted(); }
      if (now >= due.fund) { due.fund = now + 300e3; loadFunding(); }
      if (acctTab() && S.addr && now >= due.acct) { due.acct = now + 15e3; loadAccount(); }
      const cd = countdown(); [$('#pp-cd', view), $('#pp-cd2', view)].forEach((el) => { if (el) el.textContent = cd; });
    }
    const timer = setInterval(tick, 1000);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVis);
    const wsOff = hl.onWs((st) => { const d = $('#pp-dot', view); if (d) d.className = 'pp-dot ' + (st.ok ? 'live' : 'bad'); const s = $('#pp-src', view); if (s) s.textContent = st.ok ? 'Hyperliquid · live' : 'Reconnecting…'; });

    // ---------- go
    makeChart();
    drawScreener();
    setLow(ui.low);
    select(S.coin, { replace: true });

    return () => {
      S.alive = false;
      clearInterval(timer); cancelAnimationFrame(S.raf);
      document.removeEventListener('visibilitychange', onVis);
      wsOff(); S.candleOff?.(); S.feeds.forEach((f) => f.off()); S.feeds = [];
      offs.forEach((f) => f());
      try { S.chart?.remove(); } catch { /* gone */ }
      try { S.fchart?.remove(); } catch { /* gone */ }
      S.chart = S.fchart = null;
    };
  },
});
