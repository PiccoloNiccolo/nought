// A wallet's card, opened from a KOL bubble on the chart (like Axiom's wallet pop-up): who it is (from the public KOL
// list, never guessed), its SOL and top holdings, and its trades on the coin being viewed, with Track and Solscan.
// Read-only: it only reads public data about the address.
// Layout: a header (picture, name, @handle, address + copy, source and Solscan links, Track), three stat cells in one
// bordered box (SOL balance, total value, PnL on this coin), then one box with two tabs: trades on this coin and top
// holdings. Its styles are sealed in this module (CSS below), on the shared tokens.
import { esc, isMint, short, usd, ago, LS, emit, toast, ICON } from '../core/util.js';
import { ju, jx, jt } from '../core/jup.js';
import { pricesFor, solUsd } from '../core/price.js';
import { tokens as store } from '../core/store.js';
import { kolPic } from '../core/kols.js';
import { avatar } from './card.js';

const CSS = `
dialog.kw { width: min(660px, calc(100vw - 24px)); max-height: calc(100dvh - 32px); overflow: hidden; }
.kw .kw-in { display: grid; gap: 14px; padding: 18px 18px 18px; max-height: calc(100dvh - 34px); overflow-y: auto; }
.kw-h { display: flex; align-items: center; gap: 14px; min-width: 0; }
.kw-pfp { width: 52px; height: 52px; flex: none; border-radius: 50%; display: grid; place-items: center; overflow: hidden; background: var(--panel-2); border: 1px solid var(--line-2); color: var(--muted); }
.kw-pfp img { width: 100%; height: 100%; object-fit: cover; }
.kw-pfp svg { width: 22px; height: 22px; }
.kw-id { display: grid; gap: 6px; min-width: 0; flex: 1; }
.kw-id > b { font: 600 18px/1.15 var(--sans); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kw-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: 12px; color: var(--muted); }
.kw-sub a { color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; } .kw-sub a:hover { color: var(--fg); }
.kw-sub .xl { color: var(--info); font-weight: 500; } .kw-sub .xl:hover { color: var(--info); text-decoration: underline; }
.kw-sub .copy { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; color: var(--fg-2); font: 500 12px/1 var(--mono); }
.kw-sub .copy:hover { color: var(--fg); } .kw-sub .copy:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.kw-sub .src { padding: 2px 8px; border-radius: 999px; background: var(--fill); color: var(--fg-2); font-weight: 500; }
.kw-sub .src:hover { background: var(--fill-2); }
.kw-acts { display: flex; align-items: center; gap: 4px; flex: none; align-self: flex-start; }
.kw-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: var(--radius); }
.kw-stat { padding: 12px 14px; display: grid; gap: 5px; min-width: 0; align-content: start; }
.kw-stat + .kw-stat { border-left: 1px solid var(--line); }
.kw-stat > span { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kw-stat > b { font: 500 17px/1.15 var(--mono); font-variant-numeric: tabular-nums; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kw-stat > em { font: 11.5px/1.3 var(--mono); font-style: normal; font-variant-numeric: tabular-nums; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-height: 15px; }
.kw-bar { display: flex; gap: 2px; height: 4px; margin-top: 3px; border-radius: 2px; overflow: hidden; background: var(--line); }
.kw-bar i { display: block; min-width: 3px; } .kw-bar .buy { background: var(--up); } .kw-bar .sell { background: var(--down); }
.kw-box { border: 1px solid var(--line); border-radius: var(--radius); min-width: 0; }
.kw-tabs { display: flex; gap: 2px; padding: 0 6px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
.kw-tabs button { position: relative; flex: none; height: 40px; padding: 0 10px; border: 0; background: none; color: var(--muted); font: 500 13px/1 var(--sans); white-space: nowrap; }
.kw-tabs button:hover { color: var(--fg); }
.kw-tabs button.on { color: var(--fg); }
.kw-tabs button.on::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: -1px; height: 2px; border-radius: 1px; background: var(--fg); }
.kw-tabs b { margin-left: 4px; color: var(--dim); font: 500 11px/1 var(--mono); }
.kw-row, .kw-lh { display: grid; grid-template-columns: 48px minmax(0, 1fr) minmax(0, auto) 40px; gap: 10px; align-items: center; padding: 0 14px; }
.kw-row.h, .kw-lh.h { grid-template-columns: minmax(0, 1fr) auto 84px; }
.kw-lh { height: 30px; color: var(--muted); font-size: 12px; border-bottom: 1px solid var(--line-soft); }
.kw-lh span:nth-child(n+3), .kw-row > span:nth-child(n+3), .kw-lh.h span:nth-child(2), .kw-row.h > span:nth-child(2) { text-align: right; }
.kw-list { display: grid; align-content: start; overflow-y: auto; max-height: 252px; overscroll-behavior: contain; }
.kw-row { min-height: 38px; font: 500 12.5px/1.2 var(--mono); font-variant-numeric: tabular-nums; border-top: 1px solid var(--line-soft); color: var(--fg); text-decoration: none; white-space: nowrap; }
.kw-row:first-child { border-top: 0; } a.kw-row:hover { background: var(--hover); }
.kw-row > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.kw-row .buy { color: var(--up); font-family: var(--sans); } .kw-row .sell { color: var(--down); font-family: var(--sans); } .kw-row .dim { color: var(--muted); }
.kw-row small { margin-left: 6px; color: var(--muted); font-weight: 400; }
.kw-tok { display: flex; align-items: center; gap: 8px; font-family: var(--sans); }
.kw-tok .av.sm { width: 22px; height: 22px; font-size: 8.5px; }
.kw-empty { padding: 22px 14px; color: var(--muted); font-size: 12.5px; text-align: center; }
.kw .pos { color: var(--up); } .kw .neg { color: var(--down); }
.kw-stat > em b { font-weight: 500; color: var(--fg-2); }
.kw-in:focus { outline: none; }
@media (max-width: 520px) {
  .kw .kw-in { padding: 14px; }
  .kw-h { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 6px 12px; align-items: center; }
  .kw-pfp { grid-row: 1 / 3; align-self: start; width: 44px; height: 44px; }
  .kw-id { display: contents; }
  .kw-id > b { grid-column: 2; grid-row: 1; font-size: 16px; }
  .kw-acts { grid-column: 3; grid-row: 1; }
  .kw-sub { grid-column: 2 / 4; grid-row: 2; }
  .kw-stat { padding: 10px; } .kw-stat > b { font-size: 14px; }
  .kw-stat > span, .kw-stat > em { white-space: normal; overflow-wrap: anywhere; }
  .kw-row, .kw-lh { grid-template-columns: 38px minmax(0, 1fr) minmax(0, auto) 34px; gap: 8px; padding: 0 10px; }
  .kw-row.h, .kw-lh.h { grid-template-columns: minmax(0, 1fr) auto 72px; }
  .kw-row small { display: none; }
}
`;
let dlg = null, seq = 0;
const sol = (v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
const isTracked = (a) => (LS.get('tracked', []) || []).some((w) => w?.address === a);

function track(a, name) {
  const list = LS.get('tracked', []) || [];
  if (list.some((w) => w?.address === a)) return;
  list.push({ address: a, name: String(name || '').slice(0, 40), group: 'KOLs', feed: true });
  LS.set('tracked', list); emit('tracked', list.slice());
  toast(`<span>Tracking <span class="mono">${esc(short(a))}</span>.</span>`, 'ok');
}

// kol: an entry of the public list or null; mint/symbol: the coin being viewed
export function openKolWallet({ address, kol = null, mint = '', symbol = '' }) {
  if (!isMint(address)) return;
  if (!dlg) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    dlg = document.createElement('dialog'); dlg.className = 'kw'; document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-kw="close"]')) { dlg.close(); return; }
      const tr = e.target.closest('[data-kw="track"]');
      if (tr) { track(tr.dataset.a, tr.dataset.name); tr.disabled = true; tr.textContent = 'Tracked'; tr.classList.remove('btn-accent'); }
      const tb = e.target.closest('[data-kw-tab]');
      if (tb) {
        for (const b of dlg.querySelectorAll('[data-kw-tab]')) { const on = b === tb; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
        for (const p of dlg.querySelectorAll('[data-kw-pane]')) p.hidden = p.dataset.kwPane !== tb.dataset.kwTab;
      }
      if (e.target.closest('a.kw-row')) dlg.close();
    });
    dlg.addEventListener('close', () => { seq++; });
  }
  const my = ++seq, name = kol?.name || 'Wallet', pic = kolPic(kol), sym = symbol ? '$' + symbol : 'this coin';
  dlg.innerHTML = `<div class="kw-in" tabindex="-1">
    <div class="kw-h"><div class="kw-pfp">${pic ? `<img src="${esc(pic)}" alt="" referrerpolicy="no-referrer">` : ICON.xProfile}</div>
      <div class="kw-id"><b>${esc(name)}</b><div class="kw-sub">
        ${kol?.x ? `<a class="xl" href="https://x.com/${esc(kol.x)}" target="_blank" rel="noopener nofollow">${ICON.xProfile}@${esc(kol.x)}</a>` : ''}
        <button type="button" class="copy" data-copy="${esc(address)}" title="Copy address">${esc(short(address, 4))} ${ICON.copy}</button>
        ${kol?.tags?.includes('pump.fun') ? `<a class="src" href="https://pump.fun/profile/${esc(address)}" target="_blank" rel="noopener nofollow" title="Name and picture from the owner's pump.fun profile">pump.fun ↗</a>` : kol ? `<a class="src" href="https://kolscan.io/account/${esc(address)}" target="_blank" rel="noopener nofollow" title="Name, X account and picture from kolscan.io's public list">kolscan ↗</a>` : '<span title="Jupiter labels this wallet an influencer; no public profile names it">KOL (Jupiter)</span>'}
        <a href="https://solscan.io/account/${esc(address)}" target="_blank" rel="noopener nofollow">Solscan ↗</a>
      </div></div>
      <div class="kw-acts">${isTracked(address) ? '<button type="button" class="btn sm" disabled>Tracked</button>' : `<button type="button" class="btn btn-accent sm" data-kw="track" data-a="${esc(address)}" data-name="${esc(kol?.name || '')}">Track</button>`}<button type="button" class="btn btn-ghost icon sm" data-kw="close" aria-label="Close">${ICON.close}</button></div>
    </div>
    <div class="kw-stats"><div class="kw-stat"><span>SOL balance</span><b id="kw-sol">…</b><em id="kw-solu"></em></div><div class="kw-stat"><span>Total value</span><b id="kw-val">…</b><em id="kw-valn"></em></div><div class="kw-stat"><span>PnL on ${esc(sym)}</span><b id="kw-pnl">…</b><em id="kw-pnlx"></em></div></div>
    <div class="kw-box"><div class="kw-tabs" role="tablist"><button type="button" role="tab" class="on" aria-selected="true" data-kw-tab="trades">Trades on ${esc(sym)}<b id="kw-tn"></b></button><button type="button" role="tab" aria-selected="false" data-kw-tab="hold">Top holdings<b id="kw-hn"></b></button></div>
      <div data-kw-pane="trades"><div class="kw-lh"><span>Type</span><span>Amount</span><span>MC</span><span>Age</span></div><div class="kw-list" id="kw-trades"><div class="kw-empty">Loading…</div></div></div>
      <div data-kw-pane="hold" hidden><div class="kw-lh h"><span>Token</span><span>Amount</span><span>Value</span></div><div class="kw-list" id="kw-hold"><div class="kw-empty">Loading…</div></div></div>
    </div>
  </div>`;
  dlg.querySelector('.kw-pfp img')?.addEventListener('error', (e) => { e.target.replaceWith(document.createRange().createContextualFragment(ICON.xProfile)); });
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('.kw-in').focus();
  const $ = (id) => dlg.querySelector('#' + id), live = () => my === seq && dlg.open;

  // this coin: every trade by the wallet (up to 3 pages), realized + held PnL at the latest trade price
  if (isMint(mint)) {
    (async () => {
      const all = []; let next = null;
      for (let p = 0; p < 3; p++) { const r = await jx.txs(mint, { trader: address, ...(next ? { offset: next } : {}) }); all.push(...r.txs); if (!r.next || !r.txs.length) break; next = r.next; }
      if (!live()) return;
      if (!all.length) { $('kw-trades').innerHTML = '<div class="kw-empty">No trades on this coin in the recent history.</div>'; $('kw-pnl').textContent = '–'; $('kw-tn').textContent = '0'; return; }
      const t = store.get(mint), sup = t?.mcUsd > 0 && t?.price > 0 ? t.mcUsd / t.price : t?.circSupply || t?.totalSupply || 0;
      const shown = Math.min(40, all.length);
      $('kw-tn').textContent = shown < all.length ? `${shown} of ${all.length}` : String(shown);
      $('kw-trades').innerHTML = all.slice(0, shown).map((x) => `<a class="kw-row" href="https://solscan.io/tx/${esc(x.sig)}" target="_blank" rel="noopener nofollow"><span class="${x.side}">${x.side === 'buy' ? 'Buy' : 'Sell'}</span><span>${sol(x.sol)} SOL<small>${usd(x.usd)}</small></span><span class="dim">${x.priceUsd > 0 && sup > 0 ? usd(x.priceUsd * sup) : '—'}</span><span class="dim">${ago(x.at)}</span></a>`).join('');
      let inSol = 0, outSol = 0, tin = 0, tout = 0;
      for (const x of all) if (x.side === 'buy') { inSol += x.sol; tin += x.tokens; } else { outSol += x.sol; tout += x.tokens; }
      const px = all[0].tokens > 0 ? all[0].sol / all[0].tokens : 0, held = Math.max(0, tin - tout) * px, pnl = outSol + held - inSol;
      $('kw-pnl').innerHTML = `<span class="${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}${sol(pnl)} SOL</span>`;
      $('kw-pnl').title = `Bought ${sol(inSol)} SOL · sold ${sol(outSol)} SOL · still holding ≈ ${sol(held)} SOL (recent trades only)`;
      $('kw-pnlx').innerHTML = `Bought <b>${sol(inSol)}</b> · sold <b>${sol(outSol)}</b><span class="kw-bar">${inSol > 0 ? `<i class="buy" style="flex:${inSol.toFixed(6)}"></i>` : ''}${outSol > 0 ? `<i class="sell" style="flex:${outSol.toFixed(6)}"></i>` : ''}</span>`;
      $('kw-pnlx').title = $('kw-pnl').title;
    })().catch(() => { if (live()) { $('kw-trades').innerHTML = '<div class="kw-empty">Trades did not load.</div>'; $('kw-pnl').textContent = '–'; } });
  } else { $('kw-trades').innerHTML = '<div class="kw-empty">Open a coin to see this wallet\'s trades on it.</div>'; $('kw-pnl').textContent = '–'; }

  // balance and top holdings by value
  (async () => {
    const h = await ju.holdings(address);
    if (!live()) return;
    const su = solUsd() || 0;
    $('kw-sol').textContent = sol(h.sol) + ' SOL';
    if (su > 0) $('kw-solu').textContent = '≈ ' + usd(h.sol * su);
    const held = Object.entries(h.tokens).filter(([, t]) => t.raw !== '0').map(([m, t]) => ({ mint: m, ui: t.ui }));
    const px = await pricesFor(held.slice(0, 60).map((x) => x.mint)).catch(() => new Map());
    if (!live()) return;
    const rows = held.map((x) => ({ ...x, v: (px.get(x.mint)?.priceUsd || 0) * x.ui })).filter((x) => x.v >= 1).sort((a, b) => b.v - a.v);
    $('kw-val').textContent = usd(rows.reduce((s, x) => s + x.v, 0) + h.sol * su);
    $('kw-valn').textContent = `SOL + ${rows.length} coin${rows.length === 1 ? '' : 's'}`;
    const top = rows.slice(0, 10), names = new Map();
    $('kw-hn').textContent = top.length < rows.length ? `${top.length} of ${rows.length}` : String(top.length);
    const need = top.filter((x) => !store.get(x.mint)?.symbol).map((x) => x.mint);
    if (need.length) { try { for (const t of await jt.search(need)) if (t?.mint && t.symbol) names.set(t.mint, t); } catch { /* addresses then */ } }
    if (!live()) return;
    const amt = (u) => (u >= 1e6 ? (u / 1e6).toFixed(2) + 'M' : u >= 1e3 ? (u / 1e3).toFixed(1) + 'K' : u >= 1 ? u.toFixed(u >= 100 ? 0 : 2) : u.toPrecision(2));
    $('kw-hold').innerHTML = top.length ? top.map((x) => {
      const s = store.get(x.mint), n = names.get(x.mint), tsym = s?.symbol || n?.symbol;
      return `<a class="kw-row h" href="#/t/${esc(x.mint)}"><span class="kw-tok">${avatar({ mint: x.mint, symbol: tsym || '', image: s?.image || n?.image || '', migrated: true }, 'sm')}<span>${esc(tsym ? '$' + tsym : short(x.mint))}</span></span><span class="dim">${esc(amt(x.ui))}</span><span>${usd(x.v)}</span></a>`;
    }).join('') : '<div class="kw-empty">No priced coins held.</div>';
  })().catch(() => { if (live()) { $('kw-sol').textContent = '–'; $('kw-val').textContent = '–'; $('kw-hold').innerHTML = '<div class="kw-empty">Holdings did not load.</div>'; } });
}
