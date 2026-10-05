// Trader scan: a drawer with one wallet's story in this coin. mountScan(el, ctx) → { open(wallet), close(), cleanup }.
// Data: every trade of the wallet in this coin (jx ?traderAddress=, up to 20 pages), its balances (ju.balances) and, if it
// is a top holder, its funding source and Jupiter's tags (jh, shared cache). Behaviour labels follow feature-matrix §5.
import { esc, isMint, short, usd, num, pct, cls, ago, ICON } from '../../core/util.js';
import { ju } from '../../core/jup.js';
import { solUsd } from '../../core/price.js';
import {
  EXT, solscanTx, solscanAcct, fmtSol, plural, fmtSolS, fmtUsdS, fmtPx, dur, symOf, supplyOf, priceOf, badges, trackedOf, trackWallet,
  hist, refreshHead, scanHistory, holdersOf, holdersCached, statsOf, pnlOf, behaviour, loadKols, refreshVault, subscribe,
} from './tabs.js';

export function mountScan(el, ctx) {
  const mint = ctx.mint, offs = [];
  let cur = null, seq = 0, alive = true, lastFocus = null, bal = null, balErr = '', reading = false;
  el.innerHTML = `<div class="tt-scan" hidden>
    <div class="tt-scan-bg" data-close></div>
    <aside class="tt-scan-dr" role="dialog" aria-modal="true" aria-label="Trader scan" tabindex="-1"><div class="tt-scan-in"></div></aside>
  </div>`;
  const wrap = el.querySelector('.tt-scan'), dr = wrap.querySelector('.tt-scan-dr'), box = wrap.querySelector('.tt-scan-in');

  function render() {
    if (!cur) return;
    const w = cur, h = hist(mint, w), s = statsOf(h.txs), sym = symOf(ctx), px = priceOf(ctx), supply = supplyOf(ctx), sUsd = solUsd();
    const holder = holdersCached(mint)?.holders.find((x) => x.wallet === w) || null;
    const held = bal ? bal.tokens[mint]?.ui || 0 : holder ? holder.amount : Math.max(0, s.bTok - s.sTok);
    const p = pnlOf(s, held, px, sUsd), b = behaviour(s), tracked = !!trackedOf(w);
    const loaded = h.next !== undefined;
    const holdFor = s.openSince ? Date.now() - s.openSince : s.first && s.sells && held <= 0 ? s.last - s.first : s.first ? Date.now() - s.first : null;
    const kv = (k, v, sub = '', c = '') => `<div class="tt-kv"><span>${k}</span><b class="${c}">${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const f = holder?.funding;
    box.innerHTML = `
      <header class="tt-scan-h">
        <div class="tt-scan-id"><span class="tt-scan-t">Trader scan</span><b class="mono">${esc(short(w, 6))}</b>
          <span class="tt-scan-b">${badges(w, ctx, holder?.tags || h.txs.find((x) => x.tags?.length)?.tags || [], holder?.labels || [])}</span></div>
        <button class="tt-x tt-scan-x" data-close title="Close (Esc)" aria-label="Close">${ICON.close}</button>
      </header>
      <div class="tt-scan-acts">
        <button class="btn tt-sm" data-copy="${esc(w)}">${ICON.copy} Copy</button>
        <a class="btn tt-sm" href="${esc(solscanAcct(w))}" target="_blank" rel="noopener">Solscan ${EXT}</a>
        <button class="btn tt-sm${tracked ? ' on' : ''}" data-trackw ${tracked ? 'disabled' : ''}>${ICON.star} ${tracked ? 'Tracked' : 'Track'}</button>
        <button class="btn btn-ghost tt-sm" data-only title="Show only this wallet in Trades">Only in trades</button>
      </div>
      <div class="tt-beh b-${b.key}"><b>${loaded ? esc(b.label) : 'Reading…'}</b><span>${loaded ? esc(b.note) : 'Loading this wallet\'s trades in ' + esc(sym)}</span></div>
      <div class="tt-scan-grid">
        ${kv('Bought', `${fmtSol(s.bSol)} SOL`, `${usd(s.bUsd)} · ${plural(s.buys, 'buy')}${s.bTok ? ' · ' + num(s.bTok) : ''}`, s.buys ? 'up' : '')}
        ${kv('Sold', `${fmtSol(s.sSol)} SOL`, `${usd(s.sUsd)} · ${plural(s.sells, 'sell')}${s.sTok ? ' · ' + num(s.sTok) : ''}`, s.sells ? 'down' : '')}
        ${kv('Holding', `${held ? num(held) : '0'} ${esc(sym)}`, `${usd(p.valueUsd)} · ${((held / supply) * 100).toFixed(2)}% of supply${bal ? '' : balErr ? ' · estimated' : ''}`)}
        ${kv('Realized PnL', `${fmtSolS(p.realizedSol)} SOL`, fmtUsdS(p.realizedUsd), cls(p.realizedUsd))}
        ${kv('Unrealized', held > 0 && s.bTok ? `${fmtSolS(p.unrealSol)} SOL` : '—', held > 0 && s.bTok ? fmtUsdS(p.unrealUsd) : '', cls(p.unrealUsd))}
        ${kv('Total PnL', pct(p.totalPct), fmtUsdS(p.totalUsd), cls(p.totalUsd))}
        ${kv('Avg entry', s.bTok ? usd(p.avgUsd * supply) + ' MC' : '—', s.bTok ? fmtPx(p.avgUsd) : '')}
        ${kv('First trade', s.first ? `${ago(s.first)} ago` : '—', s.first ? esc(new Date(s.first).toLocaleString()) : '')}
        ${kv('Last trade', s.last ? `${ago(s.last)} ago` : '—', s.last ? esc(new Date(s.last).toLocaleString()) : '')}
        ${kv('Hold time', holdFor != null ? dur(holdFor) : '—', s.openSince ? 'still holding' : s.medianHold != null ? `median round trip ${dur(s.medianHold)}` : '')}
        ${kv('SOL balance', bal ? fmtSol(bal.sol) : balErr ? '—' : '…', bal ? usd(bal.sol * sUsd) : esc(balErr))}
        ${kv('Funded by', f ? `<a href="${esc(solscanAcct(f.from))}" target="_blank" rel="noopener">${esc(short(f.from))}</a>` : '—', f ? `${fmtSol(f.amount)} SOL${f.at ? ' · ' + ago(f.at) + ' ago' : ''}` : holder ? '' : 'not a top-100 holder')}
      </div>
      ${s.partial ? '<p class="tt-scan-note">This wallet sold more than it bought in the trades read (tokens came by transfer, or older trades were not read), so part of its cost is unknown and left out of PnL.</p>' : ''}
      <div class="tt-scan-list">
        <div class="tt-scan-lh"><span>Trades in ${esc(sym)}</span><span class="dim">${reading || h.busy ? '<span class="tt-spin"></span>reading…' : h.err ? `<span class="down">${esc(h.err)}</span> <button class="tt-link" data-retry>Retry</button>` : `${plural(h.txs.length, 'trade')}${h.done ? '' : ' (latest)'}`}</span></div>
        <div class="tt-scroll"><table class="tt-t">
          <thead><tr><th>Age</th><th>Side</th><th>SOL</th><th>Amount</th><th>MC</th><th></th></tr></thead>
          <tbody>${h.txs.length ? h.txs.slice(0, 200).map((x) => `<tr><td data-age="${x.at}">${ago(x.at)}</td><td class="${x.side === 'buy' ? 'up' : 'down'}">${x.side === 'buy' ? 'Buy' : 'Sell'}</td><td class="${x.side === 'buy' ? 'up' : 'down'}">${fmtSol(x.sol)}</td><td>${num(x.tokens)}</td><td>${usd(x.mc || x.priceUsd * supply)}</td><td><a class="tt-tx" href="${esc(solscanTx(x.sig))}" target="_blank" rel="noopener" aria-label="Open on Solscan">${EXT}</a></td></tr>`).join('')
              : `<tr class="tt-empty"><td colspan="6">${loaded ? 'No trades by this wallet in this coin.' : '<span class="tt-spin"></span>Loading…'}</td></tr>`}</tbody></table></div>
      </div>
      <p class="tt-scan-note">Accumulating: bought, never sold. Distributing: sold over half of what it bought. Scalping: 3+ round trips with a median hold under 5 minutes. Read from Jupiter's trade history; not advice.</p>`;
  }

  async function load(w, my) {
    const h = hist(mint, w);
    reading = true; render();
    const live = () => my === seq && alive;
    // each part repaints when it lands, so a slow balance never holds up the trades
    ju.balances(w).then((b) => { if (live()) bal = b; }).catch((e) => { if (live()) balErr = e.message || 'Balance did not load'; }).finally(() => live() && render());
    Promise.all([holdersOf(mint).catch(() => null), loadKols(), refreshVault()]).then(() => live() && render());
    await (h.next === undefined ? scanHistory(h, { maxPages: 20, rps: 3, stop: () => !live(), progress: () => live() && render() }) : refreshHead(h)).catch(() => null);
    if (!live()) return;
    reading = false; render();
  }

  function open(w) {
    if (!isMint(w) || !alive) return;
    const my = ++seq;
    cur = w; bal = null; balErr = '';
    if (wrap.hidden) lastFocus = document.activeElement;
    wrap.hidden = false;
    requestAnimationFrame(() => wrap.classList.add('on'));
    render(); dr.focus({ preventScroll: true });
    load(w, my);
  }
  function close() {
    if (wrap.hidden) return;
    seq++; cur = null;
    wrap.classList.remove('on'); wrap.hidden = true; box.innerHTML = '';
    if (lastFocus?.isConnected) try { lastFocus.focus({ preventScroll: true }); } catch { /* fine */ }
  }

  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-close], [data-trackw], [data-only], [data-retry]');
    if (!b) return;
    if ('close' in b.dataset) return close();
    if ('trackw' in b.dataset && cur) { trackWallet(cur); render(); }
    if ('retry' in b.dataset && cur) { const h = hist(mint, cur); h.err = ''; load(cur, ++seq); }
    if ('only' in b.dataset && cur) {
      // ask the Trades tab to filter: fill its wallet box and submit it
      const inp = document.querySelector('.tt-tabs [data-twallet]'), tab = document.querySelector('.tt-tabs [data-ttab="trades"]');
      if (tab && !tab.classList.contains('on')) tab.click();
      const box2 = document.querySelector('.tt-tabs [data-twallet]') || inp;
      if (box2) { box2.value = cur; box2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      close();
    }
  });
  const onKey = (e) => { if (e.key === 'Escape' && !wrap.hidden && !document.querySelector('dialog[open]')) { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey);
  offs.push(subscribe(ctx, 'trade', (d) => { if (cur && d?.mint === mint && d.wallet === cur) { const h = hist(mint, cur); if (h.next !== undefined) refreshHead(h).then(() => cur && render()); } }));

  const cleanup = () => {
    alive = false; seq++;
    document.removeEventListener('keydown', onKey);
    offs.forEach((f) => { try { f(); } catch { /* gone */ } });
    el.innerHTML = '';
  };
  return { open, close, cleanup };
}
