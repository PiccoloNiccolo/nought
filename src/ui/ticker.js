// The strip under the top bar: one row of coin chips from one source, picked with the icon toggles at its left and
// remembered in LS 'ticker.src':
//   hold     the coins your trading wallets hold right now (Jupiter holdings), biggest position first
//   watch    the watchlist (src/core/watchlist.js), in starred order (the 40 most recent stars)
//   recent   coins viewed lately (src/ui/recent.js), newest first
//   trend    Jupiter's top trending coins over the last hour (jt.top); until that answers (it rate-limits at busy
//            moments), the busiest coins the live feed has seen this hour (search.js busiestCoins, one per ticker), and
//            the toggle, its tooltip and the row's label then say "Busiest on Nought" instead of "Trending"
// A chip: picture (token-image.js, so it loads like the cards), ticker, market cap and 24h change; it opens the coin.
// Numbers come from the store when the live feed knows the coin, else from one batched Jupiter lookup per source at
// most every 40 s (trending: one call every 60 s), and only while the strip is on screen and the tab is visible. A failed
// lookup is tried again after 15 s, then 30 s, then at the normal interval.
// Switched with LS 'ticker.hidden' (star button in the top bar, key T, Settings > Display); always hidden below
// 760 px. Emits util 'ticker' (bool) when it is switched on or off.
import { $, $$, esc, on, emit, LS, isMint, short, usd } from '../core/util.js';
import { tokens, mcUsd } from '../core/store.js';
import { jt, ju } from '../core/jup.js';
import { tradeOwners } from '../core/wallet.js';
import { watchMints } from '../core/watchlist.js';
import { tokenImage } from './token-image.js';
import { recentCoins, fillRecent } from './recent.js';
import { NOT_MEMES, tickerKey, busiestCoins } from './search.js';

const SRC = ['hold', 'watch', 'recent', 'trend'], MAX = 40, EVERY = { hold: 30000, watch: 40000, recent: 40000, trend: 60000 };
// your holdings' market caps are read again every 5 s (one batched lookup); which coins you hold, every 30 s
const HOLD_PRICES = 5000;
const LABEL = { hold: 'Your holdings', watch: 'Watchlist', recent: 'Recently viewed', trend: 'Trending, last hour', busiest: 'Busiest on Nought, last hour' };
const T = { hidden: LS.get('ticker.hidden', false) === true, src: '', info: new Map(), at: {}, fails: {}, trend: [], hold: [], holdOwners: '', local: [], localAt: 0, err: {}, fresh: new Map(), busy: false, key: '', forced: 0, retry: 0 };
const narrow = typeof matchMedia === 'function' ? matchMedia('(max-width: 760px)') : { matches: false, addEventListener() {} };
const shown = () => !T.hidden && !narrow.matches;

export const tickerHidden = () => T.hidden; // the user's switch, not whether it is on screen right now
export function toggleTicker(force) {
  T.hidden = typeof force === 'boolean' ? !force : !T.hidden;
  LS.set('ticker.hidden', T.hidden);
  emit('ticker', !T.hidden);
  sync(); render(); refresh(false);
}
function pick(src) {
  if (!SRC.includes(src) || src === T.src) return;
  T.src = src; LS.set('ticker.src', src);
  render(); refresh(false); $('#tk-viewport').scrollLeft = 0;
}

// ---- data ----
// the store's busiest coins over the last hour, one per ticker, kept 30 s
function busiest() {
  if (Date.now() - T.localAt < 30000 && T.local.length) return T.local;
  T.local = busiestCoins(new Set(), 30).map((t) => t.mint);
  T.localAt = Date.now();
  return T.local;
}
// what the trend toggle really shows right now: Jupiter's list, or the local stand-in until it answers
const labelOf = (src) => (src === 'trend' && !T.trend.length ? LABEL.busiest : LABEL[src]);
const mintsOf = (src) => (src === 'hold' ? T.hold : src === 'watch' ? watchMints().filter(isMint).slice(-MAX) : src === 'recent' ? recentCoins().map((r) => r.mint) : T.trend.length ? T.trend : busiest());
const keep = (t) => { if (!isMint(t?.mint)) return; T.info.delete(t.mint); if (T.info.size > 400) T.info.delete(T.info.keys().next().value); T.info.set(t.mint, { symbol: t.symbol, name: t.name, image: t.image, imageOriginal: t.imageOriginal, mc: t.mcUsd > 0 ? t.mcUsd : null, ch: t.stats24h?.priceChange ?? null, at: Date.now() }); };
const num = (v) => (v == null || !isFinite(Number(v)) ? null : Number(v));
function coin(m, rec) {
  const s = tokens.get(m), f = T.info.get(m), r = rec?.get(m);
  // whichever is newer wins: the store (moved by the live feed and the open coin's page) or the strip's last lookup
  const sm = num(mcUsd(s)), live = sm > 0 && Math.max(s?.mcSolAt || 0, s?.mcUsdAt || 0) > (f?.at || 0);
  const mc = live && sm > 0 ? sm : f?.mc > 0 ? f.mc : sm > 0 ? sm : null;
  const ch = num(f?.ch ?? s?.stats24h?.priceChange);
  const symbol = String(s?.symbol || f?.symbol || r?.symbol || short(m, 3));
  return { mint: m, symbol, name: s?.name || f?.name || r?.name || '', mc, ch, img: { mint: m, symbol, image: s?.image || f?.image || r?.image, imageOriginal: s?.imageOriginal || f?.imageOriginal, imagePump: s?.imagePump, imageAlt: s?.imageAlt } };
}
// one lookup for the source on screen; force: now (a source switch, a new star), else only once EVERY has passed
async function refresh(force = true) {
  if (!shown() || document.hidden || !T.src) return;
  const src = T.src, now = Date.now();
  if (T.busy) return;
  if (!force && now - (T.at[src] || 0) < EVERY[src]) { if (src === 'hold' && T.hold.length && now - (T.priceAt || 0) >= HOLD_PRICES) await holdPrices(); return; }
  // at most one forced call every 8 s; a forced call inside that window runs when it ends
  if (force && now - T.forced < 8000) { clearTimeout(T.retry); T.retry = setTimeout(() => refresh(true), 8000 - (now - T.forced)); return; }
  if (force) T.forced = now;
  const list = src === 'trend' || src === 'hold' ? [] : mintsOf(src);
  if (src !== 'trend' && src !== 'hold' && !list.length) return;
  T.busy = true; T.at[src] = now;
  try {
    if (src === 'hold') {
      // every trading wallet's coins (up to 5 wallets), valued at Jupiter's price, biggest first
      const owners = tradeOwners().slice(0, 5), held = new Map();
      T.holdOwners = owners.join(',');
      for (const o of owners) { const h = await ju.holdings(o, { prio: 'low' }); for (const [m, t] of Object.entries(h.tokens)) if (t.raw !== '0' && !NOT_MEMES.has(m)) held.set(m, (held.get(m) || 0) + t.ui); }
      const mints = [...new Set([...T.fresh.keys(), ...held.keys()])].slice(0, 60), got = mints.length ? await jt.search(mints, { prio: 'low' }) : [];
      got.forEach(keep);
      const value = new Map(got.map((t) => [t.mint, (Number(t.price) || 0) * (held.get(t.mint) || 0)]));
      T.priceAt = Date.now();
      T.hold = mints.filter((m) => (value.get(m) ?? 1) >= 0.5).sort((a, b) => (value.get(b) || 0) - (value.get(a) || 0)).slice(0, MAX);
      keepFresh();
    } else if (src === 'trend') {
      // the first fill is what the person is looking at; later refreshes wait behind the live feeds
      const l = await jt.top('toptrending', '1h', 40, { prio: T.trend.length ? 'low' : 'normal' });
      l.forEach(keep);
      // Jupiter's order, one coin per ticker
      const seen = new Set();
      T.trend = l.filter((t) => { if (!isMint(t.mint) || NOT_MEMES.has(t.mint)) return false; const k = tickerKey(t.symbol) || t.mint; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 30).map((t) => t.mint);
    } else {
      const got = await jt.search(list, { prio: list.some((m) => T.info.has(m)) ? 'low' : 'normal' });
      got.forEach(keep);
      if (src === 'recent') fillRecent(got);
    }
    T.err[src] = false; T.fails[src] = 0;
  } catch {
    // a busy or failed lookup is tried again sooner than a full interval, backing off: 15 s, 30 s, then the interval
    T.err[src] = true; T.fails[src] = (T.fails[src] || 0) + 1;
    T.at[src] = Date.now() - EVERY[src] + Math.min(EVERY[src], 15000 * 2 ** (T.fails[src] - 1));
  } finally { T.busy = false; }
  render();
}
// a coin you just bought shows at once, in front, for 2 minutes even if Jupiter's holdings haven't caught up yet
function keepFresh() {
  for (const [m, at] of T.fresh) { if (Date.now() - at > 120e3) T.fresh.delete(m); else if (!T.hold.includes(m)) T.hold.unshift(m); }
  if (T.hold.length > MAX) T.hold.length = MAX;
}
// just the market caps of the coins you hold, between the 30 s holdings reads
async function holdPrices() {
  T.busy = true; T.priceAt = Date.now();
  try { (await jt.search(T.hold, { prio: 'normal' })).forEach(keep); } catch { /* the next tick tries again */ } finally { T.busy = false; }
  render();
}
// coins the strip knows nothing about yet (just starred, just opened): look them up soon
const missing = () => T.src !== 'trend' && T.src !== 'hold' && mintsOf(T.src).some((m) => !tokens.get(m)?.symbol && !T.info.get(m)?.symbol);

// ---- drawing ----
const pctTxt = (ch) => (ch == null ? '' : (ch > 0 ? '+' : '') + ch.toFixed(Math.abs(ch) >= 100 ? 0 : 1) + '%');
const chCls = (ch) => 'ch ' + (ch > 0 ? 'up' : ch < 0 ? 'down' : 'muted');
const titleOf = (c) => `${c.symbol}${c.name && c.name !== c.symbol ? ' · ' + c.name : ''}${c.mc ? ' · MC ' + usd(c.mc) : ''}${c.ch != null ? ' · 24h ' + pctTxt(c.ch) : ''}`;
function chip(c) {
  return `<a class="tk-i" href="#/t/${esc(c.mint)}" data-tk="${esc(c.mint)}" title="${esc(titleOf(c))}"><span class="tk-av" aria-hidden="true"><span>${esc(c.symbol.replace(/^\$/, '').slice(0, 1).toUpperCase())}</span>${tokenImage(c.img)}</span><b>${esc(c.symbol)}</b><span class="mc">${c.mc ? usd(c.mc) : '—'}</span><span class="${chCls(c.ch)}">${pctTxt(c.ch)}</span></a>`;
}
const STAR = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
function note() {
  if (T.src === 'hold') return `<span class="tk-note">${tradeOwners().length ? (T.at.hold ? 'No coins held right now' : 'Reading your holdings…') : 'Connect a wallet to see what you hold'}</span>`;
  if (T.src === 'watch') return `<span class="tk-note">${STAR}Star a coin and it stays pinned here</span>`;
  if (T.src === 'recent') return '<span class="tk-note">Coins you open show up here</span>';
  if (T.err.trend) return '<span class="tk-note">Trending is not answering right now. Nought tries again in a moment.</span>';
  return Array.from({ length: 8 }, () => '<span class="tk-sk skel"></span>').join('');
}
export function render() {
  sync();
  if (!shown()) return;
  const track = $('#tk-track'), list = mintsOf(T.src), rec = T.src === 'recent' ? new Map(recentCoins().map((r) => [r.mint, r])) : null, cs = list.map((m) => coin(m, rec));
  const key = T.src + '|' + cs.map((c) => `${c.mint}:${c.symbol}:${c.img.image || ''}:${c.img.imagePump || ''}`).join(',');
  if (key === T.key && list.length) { // same coins: numbers only, so nothing jumps
    for (const el of $$('[data-tk]', track)) {
      const c = cs.find((x) => x.mint === el.dataset.tk); if (!c) continue;
      const mc = el.querySelector('.mc'), ch = el.querySelector('.ch'), mt = c.mc ? usd(c.mc) : '—';
      if (mc.textContent !== mt) mc.textContent = mt;
      if (ch.textContent !== pctTxt(c.ch)) { ch.textContent = pctTxt(c.ch); ch.className = chCls(c.ch); }
      el.title = titleOf(c);
    }
    edges(); return;
  }
  T.key = key;
  track.innerHTML = list.length ? cs.map(chip).join('') : note();
  edges();
}
// a soft fade on the side that has more chips past the edge
function edges() {
  const vp = $('#tk-viewport'); if (!vp) return;
  vp.classList.toggle('more-r', vp.scrollWidth - vp.clientWidth - vp.scrollLeft > 2);
  vp.classList.toggle('more-l', vp.scrollLeft > 2);
}
function sync() {
  const el = $('#ticker'), was = el.hidden;
  el.hidden = T.hidden;
  $('#ticker-toggle')?.setAttribute('aria-pressed', String(!T.hidden));
  const n = $('#nav-ticker'); if (n) n.textContent = T.hidden ? 'Show coin strip' : 'Hide coin strip';
  for (const b of $$('[data-tk-src]', el)) {
    b.setAttribute('aria-pressed', String(b.dataset.tkSrc === T.src));
    const l = labelOf(b.dataset.tkSrc); if (l && b.dataset.tip !== l) { b.dataset.tip = l; b.setAttribute('aria-label', l); }
  }
  $('#tk-track').setAttribute('aria-label', labelOf(T.src) || 'Coins');
  if (was !== el.hidden) window.dispatchEvent(new Event('resize')); // charts size to their box
}

let started = false;
export function initTicker() {
  if (started) return; started = true;
  const saved = LS.get('ticker.src', '');
  T.src = SRC.includes(saved) ? saved : watchMints().length ? 'watch' : 'trend';
  const el = $('#ticker'), vp = $('#tk-viewport');
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-tk-src]'); if (b) pick(b.dataset.tkSrc); });
  $('#ticker-toggle')?.addEventListener('click', () => toggleTicker());
  $('#tk-hide').addEventListener('click', () => { toggleTicker(false); $('#ticker-toggle')?.focus(); });
  // a vertical wheel scrolls the row sideways
  vp.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && vp.scrollWidth > vp.clientWidth) { vp.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  vp.addEventListener('scroll', edges, { passive: true });
  const changed = (src) => () => { if (T.src !== src) return; render(); if (missing()) refresh(true); };
  on('watch', changed('watch'));
  on('recent', changed('recent'));
  // holdings change when you trade or switch wallets
  on('traded', (d) => {
    if (isMint(d?.mint) && d.status !== 'failed') { if (d.side === 'buy') T.fresh.set(d.mint, Date.now()); else T.fresh.delete(d.mint); }
    if (T.src !== 'hold') return;
    keepFresh(); render();
    setTimeout(() => refresh(true), 2500); setTimeout(() => refresh(true), 12000);
  });
  on('wallet', () => { if (T.src === 'hold' && tradeOwners().join(',') !== T.holdOwners) refresh(true); });
  narrow.addEventListener?.('change', () => { render(); refresh(false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
  let rs = 0; window.addEventListener('resize', () => { clearTimeout(rs); rs = setTimeout(edges, 200); });
  // numbers from the store every 2.5 s (no network); a lookup only once its interval has passed
  setInterval(() => { if (shown() && !document.hidden) { render(); refresh(false); } }, 2500);
  render(); refresh(false);
}
