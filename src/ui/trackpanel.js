// Trackers panel (status bar → Trackers), like Axiom's side panel: your tracked wallets' buys and sells as they land,
// and the wallet list with a quick add. Three ways to hold it:
//   dock   pinned to the right of every page; the page narrows to make room; drag its left edge to resize
//   float  anywhere on screen: drag the header to move it, the bottom-right corner to resize
//   pop    its own browser window (the same page opened with ?panel=trackers shows the panel alone)
// Trades come from core/logs.js (the live feed pages/track.js keeps running for wallets with Feed on); the list is
// pages/track.js's. Where it sits and how big it is are remembered in localStorage 'trpanel'.
import { esc, short, usd, LS, on, isMint, toast } from '../core/util.js';
import * as logs from '../core/logs.js';
import { trackedWallets, addTracked } from '../pages/track.js';

const KEY = 'trpanel', MAXROWS = 200, MINW = 300, MAXW = 760;
const S = Object.assign({ open: false, mode: 'dock', tab: 'trades', side: 'all', w: 400, x: 0, y: 0, fw: 420, fh: 560 }, LS.get(KEY, {}) || {});
const popped = new URLSearchParams(location.search).get('panel') === 'trackers';
let el = null, body = null, trades = [], tick = 0;
const save = () => { if (!popped) LS.set(KEY, { open: S.open, mode: S.mode, tab: S.tab, side: S.side, w: S.w, x: S.x, y: S.y, fw: S.fw, fh: S.fh }); };
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const sol = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));

const IC = {
  dock: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M14.5 4.5v15" stroke="currentColor" stroke-width="1.8"/></svg>',
  float: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="3.5" y="7.5" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 4.5h11v11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pop: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M14 4.5h5.5V10M19.5 4.5 11 13M10 5.5H6A1.5 1.5 0 0 0 4.5 7v11A1.5 1.5 0 0 0 6 19.5h11a1.5 1.5 0 0 0 1.5-1.5v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
};

function css() {
  const st = document.createElement('style'); st.id = 'trp-css';
  st.textContent = `.trp { position: fixed; z-index: 70; display: grid; grid-template-rows: auto auto minmax(0, 1fr); background: var(--panel); border: 1px solid var(--line-2); box-shadow: var(--shadow-lg, 0 18px 44px rgba(0,0,0,.55)); font-size: 12.5px; color: var(--fg); }
.trp[hidden] { display: none; }
.trp.dock { right: 0; border-width: 0 0 0 1px; box-shadow: none; }
.trp.float { border-radius: 10px; overflow: hidden; resize: both; min-width: ${MINW}px; min-height: 260px; }
.trp.full { inset: 0; border: 0; box-shadow: none; }
.trp-h { display: flex; align-items: center; gap: 4px; height: 40px; padding: 0 8px 0 10px; border-bottom: 1px solid var(--line); user-select: none; }
.trp.float .trp-h { cursor: grab; } .trp.float.dragging .trp-h { cursor: grabbing; }
.trp-tabs { display: flex; gap: 2px; } .trp-tabs button, .trp-ib, .trp-seg button { border: 0; background: none; color: var(--muted); font: 500 12.5px/1 var(--sans); cursor: pointer; border-radius: 6px; }
.trp-tabs button { padding: 7px 10px; } .trp-tabs button.on { color: var(--fg); background: var(--fill, rgba(255,255,255,.05)); } .trp-tabs em { font-style: normal; color: var(--muted); margin-left: 4px; }
.trp-sp { flex: 1; }
.trp-ib { display: inline-grid; place-items: center; width: 26px; height: 26px; } .trp-ib:hover, .trp-tabs button:hover, .trp-seg button:hover { color: var(--fg); background: var(--hover); }
.trp-bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11.5px; }
.trp-seg { display: flex; gap: 2px; } .trp-seg button { padding: 5px 9px; font-size: 11.5px; } .trp-seg button.on { color: var(--fg); background: var(--fill, rgba(255,255,255,.05)); }
.trp-live { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; } .trp-live i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); } .trp-live.on i { background: var(--up, #2ecc8f); box-shadow: 0 0 8px var(--up, #2ecc8f); }
.trp-b { overflow-y: auto; min-height: 0; }
.trp-r { display: grid; grid-template-columns: 34px minmax(0, 1.1fr) minmax(0, 1.2fr) auto 64px; align-items: center; gap: 8px; padding: 0 10px; height: 40px; border-bottom: 1px solid var(--line); color: var(--fg); text-decoration: none; }
.trp-r:hover { background: var(--hover); }
.trp-r .t { color: var(--muted); font-variant-numeric: tabular-nums; } .trp-r .w, .trp-r .tok { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trp-r .w b { font-weight: 500; } .trp-r .tok { display: flex; align-items: center; gap: 6px; } .trp-r .tok img { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; flex: none; }
.trp-r .s { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; } .trp-r .s.buy { color: var(--up, #2ecc8f); } .trp-r .s.sell { color: var(--down, #f6465d); }
.trp-r .mc { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
.trp-head { display: grid; grid-template-columns: 34px minmax(0, 1.1fr) minmax(0, 1.2fr) auto 64px; gap: 8px; padding: 6px 10px; color: var(--muted); font-size: 11px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel); }
.trp-head span:nth-child(4), .trp-head span:nth-child(5) { text-align: right; }
.trp-msg { padding: 28px 18px; color: var(--muted); text-align: center; line-height: 1.5; }
.trp-add { display: grid; grid-template-columns: minmax(0, 1fr) 110px auto; gap: 6px; padding: 10px; border-bottom: 1px solid var(--line); }
.trp-add input { min-width: 0; height: 30px; padding: 0 9px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--bg); color: var(--fg); font: 12px var(--sans); }
.trp-add button, .trp-link { height: 30px; padding: 0 12px; border: 0; border-radius: 7px; background: var(--accent); color: #fff; font: 600 12px var(--sans); cursor: pointer; }
.trp-wr { display: flex; align-items: center; gap: 8px; padding: 0 10px; height: 40px; border-bottom: 1px solid var(--line); }
.trp-wr .e { width: 22px; text-align: center; } .trp-wr b { font-weight: 500; } .trp-wr .a { color: var(--muted); font-size: 11.5px; } .trp-wr .f { margin-left: auto; font-size: 11px; color: var(--muted); }
.trp-foot { padding: 10px; text-align: center; } .trp-foot a { color: var(--accent); text-decoration: none; font-size: 12px; }
.trp-grip { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: ew-resize; } .trp:not(.dock) .trp-grip { display: none; }
body.trp-docked #view { margin-right: var(--trp-w, 400px); }
body.trp-only > *:not(.trp) { display: none !important; }
@media (max-width: 900px) { body.trp-docked #view { margin-right: 0; } .trp.dock { left: 0; width: auto !important; } }`;
  document.head.appendChild(st);
}

// ---- trades ----
function rowHtml(t) {
  const name = `${t.emoji ? esc(t.emoji) + ' ' : ''}<b>${esc(t.name || short(t.wallet))}</b>`, sym = t.symbol || short(t.mint, 3);
  return `<a class="trp-r" href="#/t/${esc(t.mint)}" title="${esc(`${t.name || t.wallet} ${t.side === 'buy' ? 'bought' : 'sold'} ${sym}`)}"><span class="t" data-at="${t.at}">${ago(t.at)}</span><span class="w">${name}</span><span class="tok">${t.image ? `<img src="${esc(t.image)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : ''}${esc(sym)}</span><span class="s ${t.side === 'buy' ? 'buy' : 'sell'}">${t.side === 'buy' ? '+' : '−'}${sol(Number(t.sol) || 0)}</span><span class="mc">${t.mcUsd > 0 ? usd(t.mcUsd) : '—'}</span></a>`;
}
function tradesHtml() {
  const tracked = trackedWallets();
  if (!tracked.length) return `<div class="trp-msg">Track a wallet and its buys and sells show up here the moment they land.</div>${addHtml()}`;
  const list = trades.filter((t) => S.side === 'all' || t.side === S.side).slice(0, MAXROWS);
  const head = '<div class="trp-head"><span>Age</span><span>Wallet</span><span>Token</span><span>SOL</span><span>MC</span></div>';
  return list.length ? head + list.map(rowHtml).join('') : `<div class="trp-msg">Listening to ${tracked.filter((w) => w.feed).length} wallet${tracked.length === 1 ? '' : 's'}. Their trades show up here as they confirm.</div>`;
}
// ---- wallets ----
const addHtml = () => '<form class="trp-add" data-tkadd><input name="a" placeholder="Wallet address" spellcheck="false" autocomplete="off" aria-label="Wallet address"><input name="n" placeholder="Name" maxlength="40" autocomplete="off" aria-label="Name"><button type="submit">Track</button></form>';
function walletsHtml() {
  const l = trackedWallets();
  return addHtml() + (l.length ? l.map((w) => `<div class="trp-wr"><span class="e">${esc(w.emoji || '•')}</span><b>${esc(w.name || short(w.address))}</b><span class="a">${esc(short(w.address))}</span><span class="f">${w.feed ? 'in feed' : 'feed off'}</span></div>`).join('') : '<div class="trp-msg">No wallets tracked yet.</div>') + '<div class="trp-foot"><a href="#/track/wallets">Manage wallets, alerts and copy trading →</a></div>';
}

function paint() {
  if (!el || el.hidden) return;
  const n = trackedWallets().length;
  el.querySelector('[data-tkn]').textContent = n ? String(n) : '';
  el.querySelectorAll('[data-tkt]').forEach((b) => b.classList.toggle('on', b.dataset.tkt === S.tab));
  el.querySelectorAll('[data-tks]').forEach((b) => b.classList.toggle('on', b.dataset.tks === S.side));
  el.querySelector('.trp-bar').hidden = S.tab !== 'trades';
  liveBadge();
  body.innerHTML = S.tab === 'trades' ? tradesHtml() : walletsHtml();
}
function liveBadge() {
  const st = logs.status?.() || {}, l = el?.querySelector('.trp-live'); if (!l) return;
  l.classList.toggle('on', !!st.running); l.lastChild.textContent = st.running ? `${st.watching || trackedWallets().length} live` : 'feed off';
}
function ages() { if (el && !el.hidden) for (const s of el.querySelectorAll('[data-at]')) s.textContent = ago(Number(s.dataset.at)); }

// ---- placement ----
function place() {
  if (!el) return;
  el.classList.toggle('dock', !popped && S.mode === 'dock'); el.classList.toggle('float', !popped && S.mode === 'float'); el.classList.toggle('full', popped);
  const docked = !popped && S.open && S.mode === 'dock';
  document.body.classList.toggle('trp-docked', docked);
  el.querySelector('[data-tka="dock"]').innerHTML = S.mode === 'dock' ? IC.float : IC.dock;
  el.querySelector('[data-tka="dock"]').title = S.mode === 'dock' ? 'Float: move it anywhere' : 'Dock to the right side';
  el.querySelector('[data-tka="pop"]').hidden = popped; el.querySelector('[data-tka="dock"]').hidden = popped;
  Object.assign(el.style, { left: '', top: '', width: '', height: '', bottom: '' });
  if (popped) return;
  if (S.mode === 'dock') {
    const v = document.getElementById('view')?.getBoundingClientRect(), sb = document.querySelector('.statusbar, #status, footer')?.getBoundingClientRect();
    const w = Math.max(MINW, Math.min(MAXW, S.w, innerWidth - 320));
    el.style.top = (v ? v.top : 92) + 'px'; el.style.bottom = (sb ? innerHeight - sb.top : 35) + 'px'; el.style.width = w + 'px';
    document.body.style.setProperty('--trp-w', w + 'px');
  } else {
    const w = Math.max(MINW, Math.min(S.fw, innerWidth - 16)), h = Math.max(260, Math.min(S.fh, innerHeight - 16));
    if (!S.x && !S.y) { S.x = innerWidth - w - 24; S.y = 110; }
    S.x = Math.max(8 - w + 120, Math.min(S.x, innerWidth - 120)); S.y = Math.max(8, Math.min(S.y, innerHeight - 48));
    Object.assign(el.style, { left: S.x + 'px', top: S.y + 'px', width: w + 'px', height: h + 'px' });
  }
  window.dispatchEvent(new Event('resize')); // charts size to their box
}
function sync() {
  const b = document.querySelector('[data-st="trackers"]'); if (b) { b.setAttribute('aria-pressed', String(S.open)); b.classList.toggle('on', S.open); }
}
export function toggleTrackPanel(force) {
  S.open = typeof force === 'boolean' ? force : !S.open; save();
  if (S.open) build();
  if (el) el.hidden = !S.open;
  place(); paint(); sync();
}

function popOut() {
  const url = location.origin + location.pathname + '?panel=trackers' + location.hash;
  const w = window.open(url, 'nought-trackers', `popup=yes,width=${Math.round(S.fw || 440)},height=${Math.round(Math.max(560, S.fh || 720))}`);
  if (!w) { toast('Your browser blocked the pop-out window. Allow pop-ups for this site and try again.', 'err'); return; }
  toggleTrackPanel(false);
}

function build() {
  if (el) return;
  if (!document.getElementById('trp-css')) css();
  el = document.createElement('aside'); el.className = 'trp'; el.setAttribute('aria-label', 'Trackers'); el.hidden = true;
  el.innerHTML = `<div class="trp-grip" aria-hidden="true"></div>
    <div class="trp-h"><div class="trp-tabs" role="tablist"><button type="button" data-tkt="trades">Trades</button><button type="button" data-tkt="wallets">Wallets<em data-tkn></em></button></div><span class="trp-sp"></span>
      <button type="button" class="trp-ib" data-tka="dock"></button><button type="button" class="trp-ib" data-tka="pop" title="Pop out into its own window">${IC.pop}</button>${popped ? '' : `<button type="button" class="trp-ib" data-tka="close" title="Close">${IC.x}</button>`}</div>
    <div class="trp-bar"><div class="trp-seg" role="group" aria-label="Show"><button type="button" data-tks="all">All</button><button type="button" data-tks="buy">Buys</button><button type="button" data-tks="sell">Sells</button></div><span class="trp-live"><i></i><span></span></span></div>
    <div class="trp-b"></div>`;
  document.body.appendChild(el); body = el.querySelector('.trp-b');
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tkt]'), s = e.target.closest('[data-tks]'), a = e.target.closest('[data-tka]');
    if (t) { S.tab = t.dataset.tkt; save(); paint(); }
    else if (s) { S.side = s.dataset.tks; save(); paint(); }
    else if (a?.dataset.tka === 'close') toggleTrackPanel(false);
    else if (a?.dataset.tka === 'pop') popOut();
    else if (a?.dataset.tka === 'dock') { S.mode = S.mode === 'dock' ? 'float' : 'dock'; save(); place(); }
  });
  el.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-tkadd]'); if (!f) return; e.preventDefault();
    const a = f.a.value.trim(), n = f.n.value.trim();
    if (!isMint(a)) { toast('That is not a Solana wallet address.', 'err'); return; }
    const added = addTracked(a, n);
    toast(added ? `Tracking ${esc(n || short(a))}.` : 'That wallet is already tracked.', added ? 'ok' : '');
    paint();
  });
  // float: drag by the header; dock: drag the left edge to change the width
  let drag = null;
  el.querySelector('.trp-h').addEventListener('pointerdown', (e) => {
    if (S.mode !== 'float' || popped || e.target.closest('button')) return;
    drag = { kind: 'move', dx: e.clientX - S.x, dy: e.clientY - S.y }; el.classList.add('dragging'); e.preventDefault();
  });
  el.querySelector('.trp-grip').addEventListener('pointerdown', (e) => { drag = { kind: 'width', x0: e.clientX, w0: el.getBoundingClientRect().width }; e.preventDefault(); });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.kind === 'move') { S.x = e.clientX - drag.dx; S.y = e.clientY - drag.dy; el.style.left = S.x + 'px'; el.style.top = Math.max(8, S.y) + 'px'; }
    else { S.w = Math.max(MINW, Math.min(MAXW, drag.w0 + (drag.x0 - e.clientX))); el.style.width = S.w + 'px'; document.body.style.setProperty('--trp-w', S.w + 'px'); }
  });
  addEventListener('pointerup', () => { if (!drag) return; const k = drag.kind; drag = null; el.classList.remove('dragging'); save(); if (k === 'width') window.dispatchEvent(new Event('resize')); });
  // float: the corner resize (CSS resize) is remembered
  new ResizeObserver(() => { if (S.mode === 'float' && !popped && !el.hidden) { const r = el.getBoundingClientRect(); S.fw = Math.round(r.width); S.fh = Math.round(r.height); clearTimeout(tick); tick = setTimeout(save, 300); } }).observe(el);
}

let started = false;
export function initTrackPanel() {
  if (started) return; started = true;
  trades = (logs.recentTrades?.() || []).slice();
  on('tracker-trade', (t) => {
    if (!isMint(t?.mint)) return;
    if (!trades.some((x) => x.sig === t.sig && x.wallet === t.wallet)) { trades.unshift(t); trades.sort((a, b) => b.at - a.at); if (trades.length > 400) trades.length = 400; }
    if (!el || el.hidden || S.tab !== 'trades') return;
    // a new trade slides in on top; the rows already shown stay as they are (no picture flicker)
    const head = body.querySelector('.trp-head');
    if (head && (S.side === 'all' || t.side === S.side)) { head.insertAdjacentHTML('afterend', rowHtml(t)); const rows = body.querySelectorAll('.trp-r'); if (rows.length > MAXROWS) rows[rows.length - 1].remove(); }
    else paint();
  });
  on('tracked', () => paint());
  on('tracker-status', () => { if (el && !el.hidden) liveBadge(); });
  setInterval(ages, 5000);
  addEventListener('resize', () => { if (el && !el.hidden && S.mode === 'dock') { const v = document.getElementById('view')?.getBoundingClientRect(); if (v) el.style.top = v.top + 'px'; } });
  if (popped) { document.body.classList.add('trp-only'); document.title = 'Trackers · Nought'; S.open = true; build(); el.hidden = false; place(); paint(); return; }
  if (S.open) toggleTrackPanel(true);
  sync();
}
