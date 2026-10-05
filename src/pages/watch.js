// Watchlist (#/watch): the coins you starred, with live prices (Jupiter price/v3 every 10 s, Dexscreener for any it
// misses), stats (Jupiter token search every 30 s, Dexscreener while Jupiter refuses), sorting, quick buy, remove, and
// price / market-cap alerts per coin.
//   Starred mints come from src/core/watchlist.js (localStorage 'watch'; the token page, Discover and the ticker share it).
//   Alerts live in localStorage 'alerts' as [{mint, kind: 'mc'|'price', op: 'above'|'below', value (USD), fired}];
//   this page only creates, re-arms and removes them. The alerts module checks and fires them.
import { $, esc, on, usd, pct, cls, num, short, LS, toast, isMint, parseTarget, ICON } from '../core/util.js';
import { register } from '../core/router.js';
import { jt, ds, img } from '../core/jup.js';
import { pricesFor } from '../core/price.js';
import { tokens, upsert, mcUsd } from '../core/store.js';
import { avatar, socials, qbButton } from '../ui/card.js';
import { sparkCell, sparkWatcher } from '../ui/sparkline.js';
import { isWatched, setWatched, watchMints } from '../core/watchlist.js';

// ---- the starred list: core/watchlist.js owns it; these stay exported for older callers ----
export { isWatched, setWatched, watchMints };

// ---- alerts ----
const rawAlerts = () => { const l = LS.get('alerts', []); return Array.isArray(l) ? l : []; };
const sameAlert = (a, b) => a && b && a.mint === b.mint && a.kind === b.kind && a.op === b.op && Number(a.value) === Number(b.value);
export const alertsFor = (mint) => rawAlerts().filter((a) => a && a.mint === mint && (a.kind === 'mc' || a.kind === 'price'));
function addAlert(a) {
  const l = rawAlerts(), hit = l.find((x) => sameAlert(x, a));
  if (hit) hit.fired = false; else l.push({ mint: a.mint, kind: a.kind, op: a.op, value: a.value, fired: false });
  LS.set('alerts', l);
}
function editAlert(a, fn) { const l = rawAlerts(), i = l.findIndex((x) => sameAlert(x, a)); if (i < 0) return; fn(l, i); LS.set('alerts', l); }

// price / market-cap targets: "1.5m" → 1500000, "$0.0021" → 0.0021, "250k" → 250000, "0,5" → 0.5; null when unclear
// ("1,500" could be either 1.5 or 1500). util's parseTarget does the reading.
export function parseAmt(s) { const v = parseTarget(s); return Number.isFinite(v) ? v : null; }

// a Dexscreener pair as a store-style token (stats per window from the pair's m5/h1/h6/h24 figures); shared with discover.js
export const nn = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? undefined : Number(x));
const safeLink = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : undefined; } catch { return undefined; } };
export function pairToken(p, mint) {
  if (!p) return null;
  const st = (k) => ({ priceChange: nn(p.priceChange?.[k]) ?? 0, vol: nn(p.volume?.[k]) ?? 0, buys: nn(p.txns?.[k]?.buys) ?? 0, sells: nn(p.txns?.[k]?.sells) ?? 0 });
  const soc = (type) => (p.info?.socials || []).find((s) => s?.type === type)?.url;
  return {
    mint, symbol: typeof p.baseToken?.symbol === 'string' ? p.baseToken.symbol.slice(0, 24) : undefined, name: typeof p.baseToken?.name === 'string' ? p.baseToken.name.slice(0, 80) : undefined,
    image: img(p.info?.imageUrl) || undefined, created: nn(p.pairCreatedAt), price: nn(p.priceUsd), mcUsd: nn(p.marketCap) ?? nn(p.fdv), liquidity: nn(p.liquidity?.usd), volume24h: nn(p.volume?.h24),
    twitter: safeLink(soc('twitter')), telegram: safeLink(soc('telegram')), website: safeLink(p.info?.websites?.[0]?.url),
    stats5m: st('m5'), stats1h: st('h1'), stats6h: st('h6'), stats24h: st('h24'), dexPaid: p.info || p.boosts?.active ? true : undefined,
  };
}

// ---- data, kept across visits so the table paints at once ----
const stats = new Map(); // mint → Token (jt.search)
const live = new Map();  // mint → {price, change24h, liquidity} (core pricesFor: Jupiter price/v3, then Dexscreener)
const prevPrice = new Map();

const COLS = [
  { key: 'sym', label: 'Coin', cls: 'c-coin' },
  { key: null, label: '8h', cls: 'c-spark', title: 'Price over the last 8 hours (15-minute bars)' },
  { key: 'price', label: 'Price', cc: 'c-px' },
  { key: 'chg', label: '24h', cc: 'c-chg' },
  { key: 'mc', label: 'Market cap', cc: 'c-x' },
  { key: 'liq', label: 'Liquidity', cc: 'c-x' },
  { key: 'vol', label: 'Vol 24h', cc: 'c-x' },
  { key: 'holders', label: 'Holders', cc: 'c-x' },
  { key: 'organic', label: 'Organic', title: 'Jupiter organic score, 0 to 100', cc: 'c-x' },
  { key: 'alerts', label: 'Alerts', cls: 'c-al' },
  { key: null, label: '', cls: 'c-act' },
];

function rowOf(mint, order) {
  const t = stats.get(mint) || tokens.get(mint) || { mint }, lv = live.get(mint);
  const price = lv?.price ?? t.price ?? null;
  let mc = null;
  if (price != null && t.circSupply > 0) mc = price * t.circSupply;
  else if (price != null && t.mcUsd > 0 && t.price > 0) mc = (t.mcUsd * price) / t.price;
  else mc = mcUsd(t) || null;
  const al = alertsFor(mint);
  return {
    mint, t, order, price, mc, al,
    chg: lv?.change24h ?? t.stats24h?.priceChange ?? null, liq: lv?.liquidity ?? t.liquidity ?? null, vol: t.volume24h ?? null,
    holders: t.holders ?? null, organic: t.organicScore ?? null, alerts: al.filter((a) => !a.fired).length,
    sym: String(t.symbol || '').toLowerCase() || '~' + mint,
  };
}
const label = (t) => (t.symbol ? '$' + t.symbol : short(t.mint));
// prices: under $0.001 the zeros after the point go into a subscript count ($0.0₅2876), as on the token page
const SUBS = '₀₁₂₃₄₅₆₇₈₉';
export function priceTxt(p) {
  if (p == null || !isFinite(p)) return '—';
  const a = Math.abs(p), s = p < 0 ? '-' : '';
  if (a === 0 || a >= 0.001) return usd(p, 2);
  let e = Math.floor(Math.log10(a)), digits = Math.round(a / 10 ** (e - 3));
  if (digits >= 1e4) { digits = Math.round(digits / 10); e += 1; }
  const zeros = -e - 1, body = String(digits).replace(/0+$/, '') || '0';
  return s + '$0.' + (zeros < 4 ? '0'.repeat(zeros) + body : '0' + String(zeros).split('').map((d) => SUBS[d]).join('') + body);
}
const fmtAlert = (a) => `${a.kind === 'mc' ? 'Market cap' : 'Price'} ${a.op === 'below' ? 'below' : 'above'} ${a.kind === 'mc' ? usd(Number(a.value), 2) : priceTxt(Number(a.value))}`;
// "Trending now" under the empty watchlist: a few coins to star in one click (Jupiter's 1h trending, cached a minute)
const trend = { at: 0, rows: [], busy: false, err: '' };
const field = (form, name) => form.elements.namedItem(name);

register({
  id: 'watch', tab: 'watch', path: '#/watch', title: 'Watchlist · Nought',
  mount(view) {
    const W = { alive: true, q: '', sort: LS.get('watchSort', null), open: null, pAt: 0, sAt: 0, pErr: '', sErr: '', pBusy: false, sBusy: false };
    view.innerHTML = `<div class="wl">
      <div class="wl-bar">
        <div class="wl-title"><h1>Watchlist</h1><span class="wl-n mono" id="wl-n"></span></div>
        <label class="wl-q">${ICON.search}<input id="wl-q" placeholder="Filter" spellcheck="false" autocomplete="off" aria-label="Filter the watchlist by name, ticker or address"></label>
        <form class="wl-add" id="wl-add"><input name="mint" placeholder="Paste a token address to add" spellcheck="false" autocomplete="off" aria-label="Token address"><button class="btn" type="submit">Add</button></form>
        <span class="wl-upd" id="wl-upd"></span>
      </div>
      <section class="wl-alert" id="wl-alert" hidden></section>
      <div class="wl-tw" id="wl-tw"></div>
    </div>`;
    const tw = $('#wl-tw', view), panel = $('#wl-alert', view), sparks = sparkWatcher(tw);

    function sorted(rows) {
      const s = W.sort;
      if (!s || !rows.length || !(s.key in rows[0])) return rows.sort((a, b) => b.order - a.order); // newest star first
      const dir = s.dir === 'asc' ? 1 : -1;
      return rows.sort((a, b) => {
        const x = a[s.key], y = b[s.key];
        if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
      });
    }
    function head() {
      return `<thead><tr>${COLS.map((c) => {
        if (!c.key) return `<th class="${c.cls || ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`;
        const on = W.sort?.key === c.key;
        return `<th class="${c.cls || 'n'}${c.cc ? ' ' + c.cc : ''}"><button class="srt${on ? ' on' : ''}" data-sort="${c.key}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}<i>${on ? (W.sort.dir === 'asc' ? '↑' : '↓') : ''}</i></button></th>`;
      }).join('')}</tr></thead>`;
    }
    function rowHtml(r) {
      const t = r.t, prev = prevPrice.get(r.mint), fl = prev != null && r.price != null && prev !== r.price ? (r.price > prev ? ' fl-up' : ' fl-dn') : '';
      const soc = socials(t), og = r.organic;
      return `<tr data-mint="${esc(r.mint)}">
        <td class="c-coin"><div class="wl-coin">${avatar(t, 'sm')}<div class="wl-ct"><div class="wl-c1"><b>${esc(t.symbol || short(r.mint))}</b><button class="copy" data-copy="${esc(r.mint)}" title="Copy address">${ICON.copy}</button></div><div class="wl-c2"><span class="wl-nm">${esc(t.name || (stats.has(r.mint) || W.sAt ? '' : 'Loading…'))}</span>${soc ? `<span class="soc">${soc}</span>` : ''}</div></div></div></td>
        <td class="c-spark">${sparkCell(r.mint)}</td>
        <td class="n c-px${fl}"><b>${priceTxt(r.price)}</b></td>
        <td class="n c-chg ${cls(r.chg)}">${pct(r.chg)}</td>
        <td class="n c-x">${usd(r.mc)}</td>
        <td class="n c-x">${usd(r.liq)}</td>
        <td class="n c-x">${usd(r.vol)}</td>
        <td class="n c-x">${r.holders == null ? '<span class="dim">–</span>' : num(r.holders)}</td>
        <td class="n c-x">${og == null ? '<span class="dim" title="No organic score yet">–</span>' : `<span class="wl-org${og >= 60 ? ' ok' : og >= 30 ? ' mid' : ''}" title="${og >= 60 ? 'Mostly real activity' : og >= 30 ? 'Mixed activity' : 'Little activity that looks organic'}">${Math.round(og)}</span>`}</td>
        <td class="c-al"><button class="wl-bell${r.alerts ? ' on' : ''}${W.open === r.mint ? ' open' : ''}" data-al="${esc(r.mint)}" title="Price and market cap alerts" aria-label="Alerts for ${esc(label(t))}">${ICON.bell}${r.al.length ? `<b>${r.alerts}${r.al.length > r.alerts ? '/' + r.al.length : ''}</b>` : ''}</button></td>
        <td class="c-act"><div class="wl-acts">${qbButton(r.mint)}<button class="wl-rm" data-rm="${esc(r.mint)}" title="Remove from watchlist" aria-label="Remove ${esc(label(t))}">${ICON.close}</button></div></td>
      </tr>`;
    }
    function render() {
      if (!W.alive) return;
      const mints = watchMints(), q = W.q.trim().toLowerCase();
      $('#wl-n', view).textContent = mints.length ? `${mints.length} coin${mints.length === 1 ? '' : 's'}` : '';
      const err = W.pErr || W.sErr;
      $('#wl-upd', view).innerHTML = !mints.length ? '' : err ? `<span class="down" title="${esc(err)}">Refresh failed, retrying</span>`
        : W.pAt ? `Prices <span data-age="${W.pAt}">0s</span> ago · every 10 s` : '<span class="wl-dot"></span>Loading prices…';
      $('.wl-q', view).hidden = !mints.length; // nothing to filter yet
      if (!mints.length) {
        if (!$('#wl-tr', tw)) tw.innerHTML = `<div class="empty-state wl-es"><span class="es-ic">${ICON.star}</span><h3>Nothing on your watchlist yet</h3><p>Star a coin anywhere in Nought, or paste a token address above. Starred coins get live prices, an 8-hour chart and price alerts here.</p><div class="es-acts"><a class="btn btn-accent" href="#/discover">Open Discover</a><a class="btn" href="#/pulse">Open Pulse</a></div>
          <section class="wl-tr" aria-label="Trending now"><h4>Trending now <span>Jupiter · 1h</span></h4><div id="wl-tr"></div></section></div>`;
        drawTrend(); loadTrend();
        W.open = null; drawPanel(); return;
      }
      let rows = mints.map(rowOf);
      if (q) rows = rows.filter((r) => (r.t.symbol || '').toLowerCase().includes(q) || (r.t.name || '').toLowerCase().includes(q) || r.mint.toLowerCase().startsWith(q));
      rows = sorted(rows);
      tw.innerHTML = rows.length ? `<table class="wl-t">${head()}<tbody>${rows.map(rowHtml).join('')}</tbody></table>`
        : `<div class="empty-state"><span class="es-ic">${ICON.search}</span><h3>No coins match “${esc(W.q)}”</h3><div class="es-acts"><button class="btn" data-clearq>Clear filter</button></div></div>`;
      for (const r of rows) if (r.price != null) prevPrice.set(r.mint, r.price);
      sparks.scan();
      if (W.open && !mints.includes(W.open)) W.open = null;
      drawPanel(true);
    }

    function drawTrend() {
      const el = $('#wl-tr', tw); if (!el) return;
      const rows = trend.rows.filter((t) => isMint(t.mint)).slice(0, 5);
      el.innerHTML = rows.length ? rows.map((t) => {
        const ch = t.stats1h?.priceChange, sym = t.symbol || short(t.mint);
        return `<div class="wl-tr-r" data-mint="${esc(t.mint)}">${avatar(t, 'sm')}<span class="wl-tr-n"><b>${esc(sym)}</b><span>${esc(t.name || '')}</span></span><span class="wl-tr-v"><b>${usd(t.mcUsd)}</b><small class="${cls(ch)}">${pct(ch)}</small></span><button class="wl-tr-star" data-wstar="${esc(t.mint)}" title="Add ${esc(label(t))} to your watchlist" aria-label="Star ${esc(label(t))}">${ICON.star}</button></div>`;
      }).join('') : trend.err && !trend.busy ? `<p class="wl-tr-msg">Trending coins did not load. <button class="wl-mini" data-trretry>Try again</button></p>`
        : '<div class="wl-tr-r sk" aria-hidden="true"><i class="skel"></i><i class="skel"></i><i class="skel"></i></div>'.repeat(5);
    }
    let trRetry = 0, trTries = 0;
    async function loadTrend(force = false) {
      if (trend.busy || (!force && Date.now() - trend.at < 60e3)) return;
      trend.busy = true; trend.err = '';
      try { trend.rows = await jt.top('toptrending', '1h', 20, { prio: 'low' }); trend.at = Date.now(); }
      catch (e) { // a rate limit passes: try twice more quietly (skeleton rows stay) before showing the error
        const again = W.alive && !trend.rows.length && ++trTries < 3;
        trend.err = again ? '' : e?.message || 'No answer';
        if (again) trRetry = setTimeout(() => loadTrend(true), 5000 * trTries);
      }
      finally { trend.busy = false; if (W.alive) drawTrend(); }
    }

    // ---- alert editor (outside the table, so a refresh never wipes what you're typing) ----
    function drawPanel(tickOnly = false) {
      const m = W.open;
      if (!m) { panel.hidden = true; panel.innerHTML = ''; panel.dataset.mint = ''; return; }
      const r = rowOf(m, 0);
      const now = `Now: price <b>${priceTxt(r.price)}</b> · market cap <b>${usd(r.mc)}</b>`;
      const list = r.al.length ? `<ul class="wl-al-list">${r.al.map((a, i) => `<li class="${a.fired ? 'fired' : ''}"><span>${esc(fmtAlert(a))}</span><em>${a.fired ? 'fired' : 'armed'}</em>${a.fired ? `<button class="wl-mini" data-rearm="${i}">Re-arm</button>` : ''}<button class="wl-mini" data-del="${i}">Remove</button></li>`).join('')}</ul>`
        : '<p class="wl-hint">No alerts for this coin yet.</p>';
      if (tickOnly && panel.dataset.mint === m) { $('#wl-al-now', panel).innerHTML = now; $('#wl-al-items', panel).innerHTML = list; return; }
      panel.dataset.mint = m; panel.hidden = false;
      panel.innerHTML = `<div class="wl-al-h"><b>Alerts for ${esc(label(r.t))}</b><span class="mono" id="wl-al-now">${now}</span><button class="wl-x" type="button" data-close aria-label="Close alerts">${ICON.close}</button></div>
        <div id="wl-al-items">${list}</div>
        <form class="wl-al-f" id="wl-al-f">
          <select name="kind" aria-label="Alert on"><option value="mc">Market cap</option><option value="price">Price</option></select>
          <select name="op" aria-label="Direction"><option value="above">goes above</option><option value="below">goes below</option></select>
          <input name="value" inputmode="decimal" placeholder="USD, e.g. 1.5m" autocomplete="off" aria-label="Value in USD">
          <button class="btn btn-accent" type="submit">Add alert</button>
        </form>
        <p class="wl-hint">Values are in USD; k, m and b work (250k, 1.5m). Alerts are checked while Nought is open in a tab, and each fires once until you re-arm it.</p>`;
    }
    panel.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !W.open) return;
      if (b.hasAttribute('data-close')) { W.open = null; drawPanel(); render(); return; }
      const list = alertsFor(W.open);
      if (b.dataset.del != null) { const a = list[Number(b.dataset.del)]; if (a) editAlert(a, (l, i) => l.splice(i, 1)); render(); }
      if (b.dataset.rearm != null) { const a = list[Number(b.dataset.rearm)]; if (a) editAlert(a, (l, i) => { l[i].fired = false; delete l[i].firedAt; }); render(); }
    });
    panel.addEventListener('change', (e) => { if (e.target.name === 'kind') field(e.target.form, 'value').placeholder = e.target.value === 'price' ? 'USD, e.g. 0.0021' : 'USD, e.g. 1.5m'; });
    panel.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target, m = W.open; if (!m) return;
      const kind = field(f, 'kind').value === 'price' ? 'price' : 'mc', op = field(f, 'op').value === 'below' ? 'below' : 'above', inp = field(f, 'value'), value = parseAmt(inp.value);
      if (!(value > 0)) { toast(value === 0 ? 'Enter a value above zero, like 1.5m or 0.002.' : 'That value is unclear. Write 1500 or 1.5k rather than 1,500 (a lone comma reads as a decimal point).', 'err'); inp.focus(); return; }
      const r = rowOf(m, 0), cur = kind === 'mc' ? r.mc : r.price;
      addAlert({ mint: m, kind, op, value });
      const past = cur != null && (op === 'above' ? cur >= value : cur <= value);
      toast(`Alert set: ${esc(label(r.t))} ${esc(fmtAlert({ kind, op, value }).toLowerCase())}.${past ? ' It is already past that, so it will fire on the next check.' : ''}`, 'ok');
      inp.value = ''; render();
    });

    // ---- table and toolbar ----
    tw.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-mint]');
      if (tr && !tokens.has(tr.dataset.mint) && stats.has(tr.dataset.mint)) upsert(tr.dataset.mint, stats.get(tr.dataset.mint)); // the token page and quick buy read the store
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.sort) {
        const k = b.dataset.sort, first = k === 'sym' ? 'asc' : 'desc', s = W.sort;
        W.sort = s?.key !== k ? { key: k, dir: first } : s.dir === first ? { key: k, dir: first === 'asc' ? 'desc' : 'asc' } : null;
        LS.set('watchSort', W.sort); render();
      } else if (b.dataset.al) { W.open = W.open === b.dataset.al ? null : b.dataset.al; drawPanel(); render(); if (W.open) panel.scrollIntoView({ block: 'nearest' }); }
      else if (b.dataset.rm) {
        const m = b.dataset.rm, t = stats.get(m) || tokens.get(m) || { mint: m }, n = alertsFor(m).length;
        setWatched(m, false);
        if (n) LS.set('alerts', rawAlerts().filter((a) => a?.mint !== m)); // nothing left on screen to manage them
        if (W.open === m) W.open = null;
        toast(`Removed ${esc(label(t))} from your watchlist${n ? ` with its ${n} alert${n === 1 ? '' : 's'}` : ''}.`);
        render();
      } else if (b.hasAttribute('data-clearq')) { W.q = ''; $('#wl-q', view).value = ''; render(); }
      else if (b.dataset.wstar) { // a coin from "Trending now": its stats come along, so the new row is filled at once
        const m = b.dataset.wstar, t = trend.rows.find((x) => x.mint === m); if (!isMint(m)) return;
        if (t) stats.set(m, t);
        setWatched(m, true); toast(`Watching ${esc(t ? label(t) : short(m))}.`, 'ok');
      } else if (b.hasAttribute('data-trretry')) loadTrend(true);
    });
    $('#wl-q', view).addEventListener('input', (e) => { W.q = e.target.value; render(); });
    $('#wl-add', view).addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = field(e.target, 'mint'), m = inp.value.trim();
      if (!isMint(m)) { toast('That is not a Solana token address.', 'err'); inp.focus(); return; }
      if (isWatched(m)) { toast('Already on your watchlist.'); inp.value = ''; return; }
      setWatched(m, true); inp.value = ''; render(); // its 'watch' event fetches the new coin's stats and price
    });

    // ---- polling: prices every 10 s, stats every 30 s; paused while the tab is hidden ----
    async function pollPrices(only) {
      const ms = only || watchMints(); if (!ms.length || (!only && (W.pBusy || document.hidden))) return;
      if (!only) W.pBusy = true;
      try {
        const got = await pricesFor(ms); // Jupiter price/v3 in chunks of 50, then Dexscreener for whatever it misses
        if (!got.size) throw new Error('No prices came back');
        for (const [m, p] of got) {
          live.set(m, { price: p.priceUsd, change24h: p.change24h, liquidity: p.liquidity });
          if (p.pair && !stats.has(m)) stats.set(m, { ...pairToken(p.pair, m), src: 'ds' }); // Jupiter's token search may be down too
        }
        W.pErr = ''; if (!only) W.pAt = Date.now();
      }
      catch (e) { W.pErr = e?.message || 'Prices did not load'; }
      finally { if (!only) W.pBusy = false; render(); }
    }
    async function pollStats(only) {
      const ms = only || watchMints(); if (!ms.length || (!only && (W.sBusy || document.hidden))) return;
      if (!only) W.sBusy = true;
      try { for (const t of await jt.search(ms)) stats.set(t.mint, t); W.sErr = ''; if (!only) W.sAt = Date.now(); }
      catch (e) {
        W.sErr = e?.message || 'Stats did not load';
        try { for (const [m, p] of await ds.tokens(ms.filter((x) => !stats.has(x) || stats.get(x).src === 'ds'))) stats.set(m, { ...pairToken(p, m), src: 'ds' }); W.sErr = ''; } // Dexscreener stand-in
        catch { /* keep what we have */ }
      }
      finally { if (!only) W.sBusy = false; render(); }
    }
    const onVis = () => { if (!document.hidden) { pollPrices(); if (!(Date.now() - W.sAt < 30e3)) pollStats(); } };
    document.addEventListener('visibilitychange', onVis);
    const timers = [setInterval(() => pollPrices(), 10e3), setInterval(() => pollStats(), 30e3)];
    // the alerts module announces changes (an alert fired, got an id): redraw so the panel and bell counts stay true
    const offAlerts = on('alerts-list', () => render());
    // a star changed elsewhere (token page, Discover, the ticker strip, another tab): redraw, and fetch any new coin now
    const offWatch = on('watch', () => {
      if (!W.alive) return;
      if (W.open && !isWatched(W.open)) { W.open = null; drawPanel(); }
      render();
      const fresh = watchMints().filter((m) => !stats.has(m) && !live.has(m));
      if (fresh.length) { pollStats(fresh); pollPrices(fresh); }
    });
    render(); pollPrices(); pollStats();

    return () => {
      W.alive = false; timers.forEach(clearInterval); clearTimeout(trRetry); offAlerts(); offWatch();
      document.removeEventListener('visibilitychange', onVis);
      sparks.destroy();
    };
  },
});
