// Token page (#/t/<mint>): header (identity, links, market cap, price, liquidity, holders, supply, ATH, bonding curve),
// chart (./token/chart.js), bottom tabs, and the trade column on the right: the stats block (5m / 1h / 6h / 24h), the
// trade panel (./token/panel.js), token info (audit), similar coins; plus the trader scan drawer and the Instant panel.
//
// Sub-modules export mount functions (el, ctx) => cleanup. ctx:
//   mint                  the coin's address
//   token()               tokens.get(mint): the store object (fields in docs/BUILD.md)
//   pair()                the best Dexscreener pair, or null
//   on(evt, fn)           util.on, unsubscribed automatically when the page unmounts; returns an unsubscribe
//   refresh()             refetch the header data now (Jupiter token + Dexscreener pair)
//   openScan(wallet)      open the trader scan drawer for a wallet
//   chart.addMarkers(m[]) lightweight-charts markers, time in unix seconds (optional 2nd arg: a group name to replace)
//   chart.setLines(l[])   [{price (USD per token), color, title, id}] horizontal lines; replaces the last set
// Data: Jupiter token search every 10 s, Dexscreener pair every 30 s, ATH from hourly candles, pump.fun bonding curve
// from its on-chain account every 10 s until it migrates. Everything pauses while the tab is hidden.
// The star reads and writes the shared watchlist (src/core/watchlist.js); the bell opens a small dialog that adds a
// price or market-cap alert through src/ui/alerts.js (which checks them every 10 s on every page).
import { esc, on, emit, usd, pct, cls, ago, short, safeUrl, LS, ICON, toast, copy, isMint, parseTarget } from '../core/util.js';
import { tokens, upsert, mcUsd, changed } from '../core/store.js';
import { wantMeta, applyPair } from '../core/meta.js';
import { wantUri } from '../core/chain-meta.js';
import { jt, jc, ds } from '../core/jup.js';
import { rpc } from '../core/rpc.js';
import { register } from '../core/router.js';
import { avatar, socials, lpInfo } from '../ui/card.js';
import { watchlist, isWatched, toggleWatch } from '../core/watchlist.js';
import { chartBridge, mountChart, fmtPrice, cnum, int, plainNum } from './token/chart.js';
import { mountPanel } from './token/panel.js';
import { openInstant, toggleInstant, detachInstant, priceUsdOf } from '../ui/instant.js';

// kept for older callers: the watchlist now lives in src/core/watchlist.js (use isWatched / toggleWatch / setWatched)
export { watchlist };
export const saveWatch = () => { LS.set('watch', [...watchlist]); emit('watch', { mint: null, watched: null, list: [...watchlist], external: true }); };

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const STAT_IVS = ['5m', '1h', '6h', '24h'];
const SHARE = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// 14 px glyphs for the header's outside links (generic shapes; the link's title names the site)
const LK = {
  explorer: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Zm0 0v9m0 0 8-4.5M12 12 4 7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M7 4v3m0 9v4M17 3v4m0 8v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="4.5" y="7" width="5" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="14.5" y="7" width="5" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  launch: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 19c4-.5 7-3 9-6.5S16.5 6 20 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15 5h5v5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 21h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" opacity=".45"/></svg>',
  searchX: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15.5 15.5 5 5M8.2 8.2l4.6 4.6m0-4.6-4.6 4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
const LP_NAME = { 'pump.fun': 'pump.fun', 'letsbonk.fun': 'Bonk', 'raydium-launchlab': 'LaunchLab', 'met-dbc': 'Meteora DBC', 'bags.fun': 'Bags', moonshot: 'Moonshot', 'jup-studio': 'Jup Studio', stonkfun: 'Stonk', forge: 'Forge' };

register({
  id: 'token', tab: '', match: /^#\/(?:t|token)\/([1-9A-HJ-NP-Za-km-z]{32,44})$/,
  title: ([m]) => `${tokens.get(m)?.symbol ? '$' + tokens.get(m).symbol : 'Token'} · Nought`,
  mount(view, [mint]) {
    if (!isMint(mint)) { view.innerHTML = '<div class="empty">That is not a coin address.</div>'; return () => {}; }
    const S = { alive: true, pair: null, ath: null, curve: null, curveDone: false, loadedJt: false, loadedDs: false, failed: 0, statIv: LS.get('tp.statIv', '1h'), lastRefresh: 0, heads: {}, dex: null };
    if (!STAT_IVS.includes(S.statIv)) S.statIv = '1h';
    const known = tokens.has(mint);
    if (!known) upsert(mint, {});
    const cleanups = [], offs = [];
    const ctxOn = (evt, fn) => { const off = on(evt, fn); offs.push(off); return off; };
    const bridge = chartBridge();
    let scan = null, pendingScan = null;
    const ctx = {
      mint,
      token: () => tokens.get(mint),
      pair: () => S.pair || tokens.get(mint)?.pair || null,
      on: ctxOn,
      refresh: () => refresh(),
      openScan: (w) => { if (!isMint(w)) return; if (scan?.open) scan.open(w); else pendingScan = w; },
      chart: bridge.api,
    };

    // desktop: the trade column runs the full height on the right; header, chart and tabs stack on the left
    view.innerHTML = `<div class="tkp">
      <header class="tp-head"><div class="tp-id" data-h="id"></div><div class="tp-figs hfade" data-h="figs"></div>
        <div class="tp-acts"><button type="button" class="btn btn-ghost sm icon tp-bell" data-act="alert" title="Set a price or market-cap alert" aria-label="Set a price or market-cap alert" aria-haspopup="dialog">${ICON.bell}</button><button type="button" class="btn btn-ghost sm tp-instant" data-act="instant" title="Instant trade panel (i)">${ICON.bolt}<span>Instant</span></button></div></header>
      <section class="tp-chart" aria-label="Chart"></section>
      <aside class="tp-side"><div class="tp-stats" data-h="stats" aria-label="Trading stats"></div><div class="tp-ivm" role="menu" aria-label="Stats window" hidden>${STAT_IVS.map((v) => `<button type="button" role="menuitemradio" aria-checked="false" data-siv="${v}">${v}</button>`).join('')}</div><div class="tp-trade"></div><div class="tp-audit"></div><div class="tp-similar"></div></aside>
      <section class="tp-tabs" aria-label="Trades, holders and more"></section>
      <div class="tp-scan"></div>
      <dialog class="tp-adlg" aria-labelledby="tp-adlg-h"><form method="dialog" class="dlg tp-al"></form></dialog>
    </div>`;
    const root = view.querySelector('.tkp'), ivm = root.querySelector('.tp-ivm');
    // drag the top edge of the tabs panel to resize it (like Axiom); double-click resets it
    {
      const tabsEl = root.querySelector('.tp-tabs'), grip = document.createElement('div');
      grip.className = 'tp-grip'; grip.setAttribute('role', 'separator'); grip.setAttribute('aria-orientation', 'horizontal'); grip.title = 'Drag to resize · double-click to reset';
      root.appendChild(grip); void tabsEl;
      const apply = (h) => { if (h > 0) root.style.setProperty('--tabs-h', h + 'px'); else root.style.removeProperty('--tabs-h'); root.classList.toggle('tabs-sized', h > 0); };
      apply(Number(LS.get('tp.tabsH', 0)) || 0);
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); grip.setPointerCapture(e.pointerId); root.classList.add('tabs-drag');
        const r = root.getBoundingClientRect(), move = (ev) => apply(Math.round(Math.max(160, Math.min(r.height - 220, r.bottom - ev.clientY))));
        const up = () => { grip.removeEventListener('pointermove', move); root.classList.remove('tabs-drag'); LS.set('tp.tabsH', parseInt(root.style.getPropertyValue('--tabs-h')) || 0); window.dispatchEvent(new Event('resize')); };
        grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up, { once: true }); grip.addEventListener('lostpointercapture', up, { once: true });
      });
      grip.addEventListener('dblclick', () => { apply(0); LS.set('tp.tabsH', 0); window.dispatchEvent(new Event('resize')); });
    }
    const part = (k) => root.querySelector(`[data-h="${k}"]`);

    // ---------- header ----------
    function setHtml(k, html) { if (S.heads[k] === html) return; S.heads[k] = html; part(k).innerHTML = html; }
    function render() {
      if (!S.alive) return;
      const t = tokens.get(mint) || { mint }, p = ctx.pair();
      const sym = t.symbol || p?.baseToken?.symbol || '', name = t.name || p?.baseToken?.name || '';
      const ageKnown = S.loadedJt || S.loadedDs || known;
      const lp = t.launchpad ? LP_NAME[t.launchpad] || t.launchpad : null;
      const links = [[`https://solscan.io/token/${mint}`, 'Solscan', LK.explorer], [safeUrl(p?.url), 'Dexscreener', LK.chart], [t.launchpad === 'pump.fun' || /pump$/.test(mint) ? `https://pump.fun/coin/${mint}` : '', 'pump.fun', LK.launch], [`https://x.com/search?q=${mint}&f=live`, 'Search X for this address', LK.searchX]]
        .map(([u, l, ic]) => [/^https:\/\//.test(u || '') ? safeUrl(u) : '', l, ic]).filter(([u]) => u);
      const star = isWatched(mint);
      // Dexscreener: when the profile/ad was paid (a link to the pair), and the project links its paid profile lists
      // that the socials above don't already show (Discord, a second website, ...)
      const paid = S.dex?.orders?.filter((o) => o.status === 'approved' && o.at > 0).sort((a, b) => a.at - b.at)[0];
      const dexBadge = paid ? `<a class="flag tp-dexf" href="${esc(safeUrl(p?.url) || `https://dexscreener.com/solana/${mint}`)}" target="_blank" rel="noopener nofollow" title="Dexscreener ${esc(paid.type === 'communityTakeover' ? 'community takeover' : 'profile')} paid ${esc(new Date(paid.at).toLocaleString())}">DEX ${paid.type === 'communityTakeover' ? 'CTO' : 'paid'} · ${esc(ago(paid.at))}</a>` : '';
      const shown = new Set([t.twitter, t.telegram, t.website].filter(Boolean).map((u) => String(u).replace(/\/$/, '')));
      const extra = [...(p?.info?.websites || []).map((w) => [w?.url, w?.label || 'Website']), ...(p?.info?.socials || []).map((x) => [x?.url, x?.type ? x.type[0].toUpperCase() + x.type.slice(1) : 'Link'])]
        .map(([u, l]) => [safeUrl(u), String(l).slice(0, 16)]).filter(([u]) => u && !shown.has(u.replace(/\/$/, ''))).slice(0, 4);
      const dexLinks = extra.map(([u, l]) => `<a class="flag tp-dexl" href="${esc(u)}" target="_blank" rel="noopener nofollow" title="${esc(u)}">${esc(l)}</a>`).join('');
      // the picture sits in a frame tinted with the launchpad's colour (pump.fun green, Bonk orange, ...)
      const lpCol = (lpInfo(t.launchpad) || (/pump$/.test(mint) ? lpInfo('pump.fun') : null))?.color || '';
      setHtml('id', `<div class="tp-avf${lpCol ? '' : ' none'}" style="${lpCol ? `--lp:${esc(lpCol)}` : ''}" title="${esc(lp || 'Launchpad unknown')}">${avatar({ ...t, symbol: sym || short(mint, 2) })}</div>
        <div class="tp-names">
          <div class="tp-l1"><span class="tp-sym">${sym ? esc(sym) : '<span class="dim">Loading…</span>'}</span><span class="tp-nm" title="${esc(name)}">${esc(name)}</span>
            <button type="button" class="tp-ib tp-ca" data-copy="${esc(mint)}" title="Copy contract address ${esc(mint)}">${ICON.copy}<span class="mono">${esc(short(mint, 4))}</span></button>
            <button type="button" class="tp-ib" data-act="share" title="Share this page" aria-label="Share">${SHARE}</button>
            <button type="button" class="tp-ib tp-star${star ? ' on' : ''}" data-act="star" title="${star ? 'Remove from watchlist' : 'Add to watchlist'}" aria-pressed="${star}" style="--f:${star ? 'var(--warn)' : 'none'}">${ICON.star}</button>
          </div>
          <div class="tp-l2">${ageKnown && t.created ? `<span class="tp-age mono" data-age="${Number(t.created)}" title="Age"></span>` : ''}${lp ? `<span class="tp-lp" style="${lpCol ? `--lp:${esc(lpCol)}` : ''}">${esc(lp)}</span>` : ''}${t.migrated ? '<span class="flag tp-migf">Migrated</span>' : ''}${t.verified ? '<span class="flag">Verified</span>' : ''}<span class="soc">${socials(t)}</span>${dexBadge}${dexLinks}<span class="tp-lks">${links.map(([u, l, ic]) => `<a class="tp-lk" href="${esc(u)}" target="_blank" rel="noopener nofollow" title="${esc(l)}" aria-label="${esc(l)}">${ic}</a>`).join('')}</span></div>
        </div>`);
      const age = part('id').querySelector('.tp-age'); if (age && !age.textContent) age.textContent = ago(Number(age.dataset.age)); // the shell ticks it after this
      const l2 = part('id').querySelector('.tp-l2'); if (l2) l2.classList.toggle('ovf', l2.scrollWidth > l2.clientWidth + 1); // fade the cut edge only when something is cut
      const mc = curMc(), price = curPrice();
      const st = t['stats' + S.statIv], ch = st ? st.priceChange : S.statIv === '24h' ? p?.priceChange?.h24 : S.statIv === '1h' ? p?.priceChange?.h1 : S.statIv === '6h' ? p?.priceChange?.h6 : p?.priceChange?.m5;
      const liq = t.liquidity ?? p?.liquidity?.usd, ath = S.ath != null ? Math.max(S.ath, mc || 0) : null;
      const prog = !t.migrated ? (S.curve ?? (t.progress > 0 ? t.progress : null)) : null;
      const cells = [
        `<div class="tp-mc" title="Market cap"><b class="mono">${usd(mc)}</b>${ch != null && isFinite(ch) ? `<i class="mono ${cls(ch)}">${pct(Number(ch))} <em>${S.statIv}</em></i>` : ''}</div>`,
        `<div><span>Price</span><b class="mono">${fmtPrice(price)}</b></div>`,
        `<div><span>Liquidity</span><b class="mono">${usd(liq)}</b></div>`,
        `<div><span>Holders</span><b class="mono">${t.holders != null ? int(t.holders) : '—'}</b></div>`,
        `<div class="tp-sup" title="Circulating / total supply"><span>Supply</span><b class="mono">${t.circSupply ? cnum(t.circSupply) : '—'}${t.totalSupply && cnum(t.totalSupply) !== cnum(t.circSupply) ? `<i class="dim"> / ${cnum(t.totalSupply)}</i>` : ''}</b></div>`,
        `<div title="Highest hourly market cap"><span>ATH</span><b class="mono">${ath ? usd(ath) : '—'}${ath && mc ? `<i class="${mc >= ath * 0.995 ? 'up' : 'down'}"> ${mc >= ath * 0.995 ? 'at ATH' : pct((mc / ath - 1) * 100, 0)}</i>` : ''}</b></div>`,
        prog != null ? `<div title="Bonding curve progress${S.curve != null ? ' (read on-chain)' : ''}"><span>Bonding</span><b class="mono">${S.curveDone ? 'Migrating' : (prog * 100).toFixed(1) + '%'}</b><u class="tp-bar"><s style="width:${Math.min(100, prog * 100).toFixed(1)}%"></s></u></div>` : '',
      ];
      setHtml('figs', cells.join(''));
      renderStats(t, p);
      root.querySelector('.tp-ivb')?.setAttribute('aria-expanded', String(!ivm.hidden));
      const title = `${sym ? '$' + sym : 'Token'} · Nought`; if (document.title !== title) document.title = title;
    }
    function curMc() { const t = tokens.get(mint) || { mint }, p = ctx.pair(); return mcUsd(t) || Number(p?.marketCap || p?.fdv) || null; }
    function curPrice() { const t = tokens.get(mint) || { mint }, p = ctx.pair(); return priceUsdOf(t) || Number(p?.priceUsd) || null; }
    // the stats block at the top of the trade column: window volume, buys and sells (count / USD), net volume and a
    // two-colour bar, then traders, net buyers and organic volume. The window button opens a small 5m / 1h / 6h / 24h menu.
    // USD here keeps three significant figures ($508K, $50.7K, $6.99K) so busy coins still fit the 300px column.
    const cu = (n) => { if (n == null || !isFinite(n)) return '—'; const a = Math.abs(n); for (const [v, u] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= v * 0.9995) { const x = a / v; return (n < 0 ? '-$' : '$') + x.toFixed(x >= 99.95 ? 0 : x >= 9.995 ? 1 : 2) + u; } return usd(n); };
    function renderStats(t, p) {
      const s = t['stats' + S.statIv];
      const ivb = `<button type="button" class="tp-ivb" data-ivm aria-haspopup="menu" aria-expanded="false" title="Stats window" aria-label="Stats window: ${S.statIv}">${S.statIv}<svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
      const cell = (label, val, c = '', tip = '') => `<div${tip ? ` title="${esc(tip)}"` : ''}><span>${label}</span><b class="${c}">${val}</b></div>`;
      const bar = (a, b, tip) => { const tot = a + b, sh = tot > 0 ? (a / tot) * 100 : 50; return `<div class="tp-sbar" title="${esc(tip(sh))}"><s class="b" style="flex:${sh.toFixed(1)}"></s><s class="s" style="flex:${(100 - sh).toFixed(1)}"></s></div>`; };
      if (!s) {
        const vol = S.statIv === '5m' ? p?.volume?.m5 : S.statIv === '1h' ? p?.volume?.h1 : S.statIv === '6h' ? p?.volume?.h6 : p?.volume?.h24;
        const tx = p?.txns?.[{ '5m': 'm5', '1h': 'h1', '6h': 'h6', '24h': 'h24' }[S.statIv]];
        if (vol == null && !tx) { setHtml('stats', `<div class="tp-sg">${cell(`${ivb} Vol`, '—')}<div class="tp-snote">${S.loadedJt ? 'No trading stats for this window yet.' : 'Loading stats…'}</div></div>`); return; }
        const b = Number(tx?.buys) || 0, sl = Number(tx?.sells) || 0;
        setHtml('stats', `<div class="tp-sg">${cell(`${ivb} Vol`, usd(vol))}${cell('Buys', int(tx?.buys ?? null), 'up')}${cell('Sells', int(tx?.sells ?? null), 'down')}${cell('Net Vol.', '—', 'dim')}</div>
          ${b + sl > 0 ? bar(b, sl, (sh) => `Buys ${sh.toFixed(0)}% · sells ${(100 - sh).toFixed(0)}% of trades`) : ''}<div class="tp-sx"><span class="dim">Counts from Dexscreener</span></div>`);
        return;
      }
      const net = s.buyVol - s.sellVol;
      setHtml('stats', `<div class="tp-sg">
          ${cell(`${ivb} Vol`, usd(s.vol))}
          ${cell('Buys', `${int(s.buys)}<i>/</i>${cu(s.buyVol)}`, 'up', `${int(s.buys)} buys · ${usd(s.buyVol)}`)}
          ${cell('Sells', `${int(s.sells)}<i>/</i>${cu(s.sellVol)}`, 'down', `${int(s.sells)} sells · ${usd(s.sellVol)}`)}
          ${cell('Net Vol.', `${net > 0 ? '+' : ''}${cu(net)}`, cls(net), `Net volume ${net > 0 ? '+' : ''}${usd(net)}`)}
        </div>
        ${bar(s.buyVol, s.sellVol, (sh) => `Buy volume ${sh.toFixed(0)}% · sell volume ${(100 - sh).toFixed(0)}%`)}
        <div class="tp-sx"><span>Traders <b>${int(s.traders)}</b></span><span>Net buyers <b class="${cls(s.netBuyers)}">${s.netBuyers > 0 ? '+' : ''}${int(s.netBuyers)}</b></span><span title="Volume from wallets Jupiter scores as organic">Organic <b>${usd(s.organicVol)}</b></span></div>`);
    }

    // ---------- data ----------
    async function loadToken() {
      try {
        const [t] = await jt.search([mint]);
        if (!S.alive) return;
        if (t) { upsert(mint, t); S.loadedJt = true; const x = tokens.get(mint); if (x?.uri) wantMeta(x); else wantUri(mint); } // no URI from Jupiter: read it on-chain, then the metadata (socials)
        else S.failed++;
      } catch { /* rate limit or network: not the same as "not listed" */ }
      render(); notFound();
    }
    async function loadPair() {
      try {
        const p = (await ds.tokens([mint])).get(mint);
        if (!S.alive || !p) return;
        S.pair = p; S.loadedDs = true;
        const t = tokens.get(mint);
        if (t) { if (!S.loadedJt && !known && p.pairCreatedAt) t.created = Number(p.pairCreatedAt); applyPair(t, p); t.pair = p; changed(); }
      } catch { /* Dexscreener is optional */ }
      render();
      try { S.dex = await ds.orders(mint); if (S.alive) render(); } catch { /* optional */ }
    }
    async function loadAth() {
      try {
        const c = await jc.chart(mint, { interval: '1_HOUR', candles: 2000, type: 'mcap', quote: 'usd' });
        if (!S.alive || !c.length) return;
        S.ath = c.reduce((m, x) => Math.max(m, x.high || 0), 0); render();
      } catch { /* ATH is optional */ }
    }
    // pump.fun bonding curve account: u64 virtual tokens @8, real tokens @24, complete flag @48. The standard curve
    // keeps virtual − real = 279.9M tokens and starts with 793.1M real; other curve shapes fall back to Jupiter's figure.
    async function loadCurve() {
      const t = tokens.get(mint);
      if (!t || t.migrated || !(t.launchpad === 'pump.fun' || /pump$/.test(mint)) || !window.solanaWeb3) return;
      try {
        const P = window.solanaWeb3.PublicKey;
        const pda = P.findProgramAddressSync([new TextEncoder().encode('bonding-curve'), new P(mint).toBytes()], new P(PUMP_PROGRAM))[0].toBase58();
        const v = (await rpc('getAccountInfo', [pda, { encoding: 'base64', commitment: 'confirmed' }]))?.value;
        if (!S.alive || !v?.data?.[0]) return;
        const b = Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0)); if (b.length < 49) return;
        const dv = new DataView(b.buffer), vTok = Number(dv.getBigUint64(8, true)), real = Number(dv.getBigUint64(24, true));
        S.curveDone = b[48] === 1;
        S.curve = S.curveDone ? 1 : Math.abs(vTok - real - 279.9e12) < 1e10 ? Math.max(0, Math.min(1, 1 - real / 793.1e12)) : null;
        render();
      } catch { /* RPC busy: keep Jupiter's figure */ }
    }
    function notFound() {
      if (S.loadedJt || S.loadedDs || tokens.get(mint)?.symbol || S.failed < 2) return;
      setHtml('figs', '<div class="tp-nf">Jupiter and Dexscreener don\'t list this address yet. Brand-new coins appear within seconds; anything else may not be a token.</div>');
    }
    function refresh() {
      if (!S.alive || Date.now() - S.lastRefresh < 2000) return;
      S.lastRefresh = Date.now(); loadToken(); loadPair(); loadCurve();
    }

    // ---------- header actions ----------
    root.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !root.contains(b)) return;
      if ('ivm' in b.dataset) { ivMenu(ivm.hidden); return; }
      if (b.dataset.siv) { if (STAT_IVS.includes(b.dataset.siv) && b.dataset.siv !== S.statIv) { S.statIv = b.dataset.siv; LS.set('tp.statIv', S.statIv); render(); } ivMenu(false, true); return; }
      if (!b.closest('.tp-head')) return;
      const act = b.dataset.act;
      if (act === 'star') { const yes = toggleWatch(mint); render(); toast(yes ? 'Added to your watchlist. <a href="#/watch">Open watchlist</a>' : 'Removed from your watchlist.', yes ? 'ok' : ''); }
      else if (act === 'share') share();
      else if (act === 'alert') openAlert();
      else if (act === 'instant') toggleInstant(mint);
    });
    // the stats window menu (5m / 1h / 6h / 24h) under the window button; Escape, Tab or a click elsewhere closes it
    function ivMenu(open, refocus = false) {
      ivm.hidden = !open;
      const btn = root.querySelector('.tp-ivb'); btn?.setAttribute('aria-expanded', String(open));
      if (open) {
        ivm.querySelectorAll('[data-siv]').forEach((x) => { const on = x.dataset.siv === S.statIv; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
        (ivm.querySelector('.on') || ivm.querySelector('button'))?.focus();
      } else if (refocus) btn?.focus();
    }
    ivm.addEventListener('keydown', (e) => {
      const items = [...ivm.querySelectorAll('button')], i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ivMenu(false, true); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus(); }
      else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus(); }
      else if (e.key === 'Tab') ivMenu(false);
    });
    const onDocDown = (e) => { if (!ivm.hidden && !ivm.contains(e.target) && !e.target.closest?.('.tp-ivb')) ivMenu(false); };
    document.addEventListener('pointerdown', onDocDown);
    async function share() {
      const url = location.href.split('#')[0] + '#/t/' + mint, sym = tokens.get(mint)?.symbol;
      if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title: `${sym ? '$' + sym : 'Coin'} on Nought`, url }); return; } catch { /* cancelled */ } }
      copy(url);
    }
    // ---------- price / market-cap alert dialog (src/ui/alerts.js stores and checks them) ----------
    const dlg = root.querySelector('.tp-adlg'), aform = dlg.querySelector('form');
    const AL = { kind: LS.get('tp.alertKind', 'mc') === 'price' ? 'price' : 'mc', op: 'above', opSet: false, mod: null };
    const alertsMod = () => (AL.mod ? Promise.resolve(AL.mod) : import('../ui/alerts.js').then((m) => (AL.mod = m)));
    const curOf = (kind) => (kind === 'mc' ? curMc() : curPrice());
    const fmtA = (kind, v) => (v > 0 ? (kind === 'mc' ? usd(v) : '$' + plainNum(v)) : '—'); // plain decimals: what gets typed
    const kindName = (k) => (k === 'mc' ? 'market cap' : 'price');
    const symLabel = () => { const sym = tokens.get(mint)?.symbol || ctx.pair()?.baseToken?.symbol; return sym ? '$' + sym : short(mint); };
    const mineOf = (m) => m.listAlerts().filter((a) => a.mint === mint);
    function bellState() {
      const b = root.querySelector('.tp-bell'); if (!b || !AL.mod) return;
      const n = mineOf(AL.mod).filter((a) => !a.fired).length;
      b.classList.toggle('on', n > 0);
      b.title = n ? `${n} alert${n === 1 ? '' : 's'} armed on this coin. Click to add or remove.` : 'Set a price or market-cap alert';
    }
    function drawAlert() {
      const m = AL.mod; if (!m) return;
      const typed = aform.querySelector('input[name="v"]')?.value || '', cur = curOf(AL.kind);
      const seg = (key, opts, curV) => opts.map(([v, l]) => `<button type="button" data-${key}="${v}" class="${v === curV ? 'on' : ''}" aria-pressed="${v === curV}">${l}</button>`).join('');
      aform.innerHTML = `<div class="dlg-top"><h2 id="tp-adlg-h">Alert for ${esc(symLabel())}</h2><a class="dlg-link" href="#/settings/alerts" data-close>Alerts and sounds</a></div>
        <div class="tp-al-row"><span>Watch the</span><div class="seg sm" role="group" aria-label="What to watch">${seg('ak', [['mc', 'Market cap'], ['price', 'Price']], AL.kind)}</div></div>
        <div class="tp-al-row"><span>Alert when it goes</span><div class="seg sm" role="group" aria-label="Direction">${seg('aop', [['above', 'Above'], ['below', 'Below']], AL.op)}</div></div>
        <label>${AL.kind === 'mc' ? 'Market cap' : 'Price'} in USD <span class="hint">Now ${fmtA(AL.kind, cur)}</span>
          <input name="v" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="${AL.kind === 'mc' ? 'e.g. 250k or 1.5m' : 'e.g. 0.00042'}" value="${esc(typed)}"></label>
        <p class="tp-al-err" role="alert" hidden></p>
        <div class="tp-al-box"></div>
        <p class="hint">Checked every 10 s on Jupiter prices while Nought is open in a tab. When it fires you get a notice in the bell, a sound and, if you allowed them, a desktop notification.</p>
        <div class="row-end"><button type="button" class="btn btn-ghost" data-close>Close</button><button class="btn btn-accent" type="submit" value="set">Set alert</button></div>`;
      drawAlertList();
    }
    // this coin's alerts, redrawn on its own so a check every 10 s never disturbs what is being typed
    function drawAlertList() {
      const m = AL.mod, box = aform.querySelector('.tp-al-box'); if (!m || !box) return;
      const mine = mineOf(m);
      const html = mine.length ? `<div class="tp-al-list"><span>Alerts on this coin</span>${mine.map((a) => `<div class="tp-al-it${a.fired ? ' fired' : ''}"><b>${a.kind === 'mc' ? 'Market cap' : 'Price'} ${a.op === 'above' ? 'above' : 'below'} ${esc(m.fmtAlertValue(a.kind, a.value))}</b><em>${a.fired ? 'Fired' : 'Armed'}</em>${a.id ? `${a.fired ? `<button type="button" class="tp-ib" data-arearm="${esc(a.id)}" title="Arm it again">Re-arm</button>` : ''}<button type="button" class="tp-ib" data-arm-rm="${esc(a.id)}" title="Remove this alert" aria-label="Remove this alert">${ICON.close}</button>` : ''}</div>`).join('')}</div>` : '';
      if (box.innerHTML !== html) box.innerHTML = html;
    }
    async function openAlert() {
      try { await alertsMod(); } catch { toast('Alerts did not load. Reload the page to try again.', 'err'); return; }
      if (!S.alive || dlg.open) return;
      AL.opSet = false; aform.innerHTML = ''; drawAlert();
      try { dlg.showModal(); } catch { return; }
      aform.querySelector('input[name="v"]')?.focus();
      bellState();
    }
    function alertErr(text) { const e = aform.querySelector('.tp-al-err'); if (e) { e.textContent = text; e.hidden = !text; } }
    aform.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.ak) { AL.kind = b.dataset.ak === 'price' ? 'price' : 'mc'; LS.set('tp.alertKind', AL.kind); AL.opSet = false; const i = aform.querySelector('input[name="v"]'); if (i) i.value = ''; drawAlert(); aform.querySelector('input[name="v"]')?.focus(); }
      else if (b.dataset.aop) { AL.op = b.dataset.aop === 'below' ? 'below' : 'above'; AL.opSet = true; drawAlert(); }
      else if (b.dataset.armRm && AL.mod) { AL.mod.removeAlert(b.dataset.armRm); drawAlertList(); bellState(); aform.querySelector('input[name="v"]')?.focus(); }
      else if (b.dataset.arearm && AL.mod) { AL.mod.rearmAlert(b.dataset.arearm); drawAlertList(); bellState(); }
    });
    aform.addEventListener('input', (e) => {
      if (e.target.name !== 'v') return;
      alertErr('');
      const v = parseTarget(e.target.value), cur = curOf(AL.kind);
      if (AL.opSet || !(v > 0) || !(cur > 0)) return;
      const op = v >= cur ? 'above' : 'below'; // pick the direction from the value until it is chosen by hand
      if (op !== AL.op) { AL.op = op; aform.querySelectorAll('[data-aop]').forEach((x) => { x.classList.toggle('on', x.dataset.aop === op); x.setAttribute('aria-pressed', String(x.dataset.aop === op)); }); }
    });
    aform.addEventListener('submit', (e) => {
      if (e.submitter?.value === 'cancel') return; // Close: let the dialog shut
      e.preventDefault();
      const m = AL.mod; if (!m) return;
      const inp = aform.querySelector('input[name="v"]'), value = parseTarget(inp?.value);
      if (!(value > 0)) { alertErr(Number.isNaN(value) && String(inp?.value || '').trim() ? `Nought can't read "${String(inp.value).trim().slice(0, 24)}". ${AL.kind === 'mc' ? 'Type it like 250k, 1.5m or 250,000 (a lone "1,500" is unclear: write 1500 or 1.5k).' : 'Type it like 0.00042 or 0,00042.'}` : AL.kind === 'mc' ? 'Enter a market cap in USD, like 250k or 1.5m.' : 'Enter a price in USD, like 0.00042.'); inp?.focus(); return; }
      try { m.addAlert({ mint, kind: AL.kind, op: AL.op, value }); }
      catch (err) { alertErr(err?.message || 'That alert could not be saved.'); return; }
      const cur = curOf(AL.kind), past = cur > 0 && (AL.op === 'above' ? cur >= value : cur <= value);
      dlg.close();
      toast(`Alert set: ${esc(symLabel())} ${kindName(AL.kind)} ${AL.op} ${esc(fmtA(AL.kind, value))}.${past ? ' It is already past that, so it fires on the next check.' : ''}`, 'ok');
      bellState();
    });
    ctxOn('alerts-list', () => { bellState(); if (dlg.open) drawAlertList(); });
    ctxOn('watch', () => render());
    alertsMod().then(bellState).catch(() => {});

    const onKey = (e) => {
      if (e.key !== 'i' || e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
      toggleInstant(mint);
    };
    document.addEventListener('keydown', onKey);

    // ---------- sub-modules ----------
    function own(name, fn) { try { const c = fn(); if (typeof c === 'function') cleanups.push(c); } catch (e) { console.error(name, e); } }
    own('chart', () => mountChart(root.querySelector('.tp-chart'), ctx, bridge));
    own('panel', () => mountPanel(root.querySelector('.tp-trade'), ctx));
    // the token-tabs owner's modules load on their own, so a problem in one never takes the chart or trade panel down
    const other = (path, fn, el, onResult) => import(path).then((m) => {
      if (!S.alive) return;
      const r = m[fn](el, ctx);
      if (onResult) onResult(r); else if (typeof r === 'function') cleanups.push(r);
    }).catch((e) => { console.error(fn, e); if (S.alive) el.innerHTML = '<div class="tp-err">This section did not load. Reload to try again.</div>'; });
    other('./token/tabs.js', 'mountTabs', root.querySelector('.tp-tabs'));
    other('./token/audit.js', 'mountAudit', root.querySelector('.tp-audit'));
    other('./token/similar.js', 'mountSimilar', root.querySelector('.tp-similar'));
    other('./token/scan.js', 'mountScan', root.querySelector('.tp-scan'), (r) => {
      scan = typeof r === 'function' ? { cleanup: r } : r || null;
      if (scan?.cleanup) cleanups.push(() => scan.cleanup());
      if (pendingScan && scan?.open) { scan.open(pendingScan); pendingScan = null; }
    });
    if (LS.get('instant.open', false)) openInstant(mint);

    // ---------- timers and events ----------
    let rt = 0; // at most two header renders a second, always ending on the latest data
    ctxOn('tokens', () => { if (!rt) rt = setTimeout(() => { rt = 0; render(); }, 450); });
    ctxOn('sol', render);
    ctxOn('migrate', (t) => { if (t?.mint === mint) { S.curve = null; S.curveDone = false; refresh(); } });
    const timers = [
      setInterval(() => { if (!document.hidden) loadToken(); }, 10000),
      setInterval(() => { if (!document.hidden) loadPair(); }, 30000),
      setInterval(() => { if (!document.hidden && !tokens.get(mint)?.migrated) loadCurve(); }, 10000),
      setInterval(() => { if (!document.hidden) loadAth(); }, 300000),
    ];
    render();
    loadToken(); loadPair(); loadAth(); loadCurve();

    return () => {
      S.alive = false;
      try { if (dlg.open) dlg.close(); } catch { /* gone */ }
      timers.forEach(clearInterval); clearTimeout(rt);
      document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDocDown);
      for (const c of cleanups.splice(0)) { try { c(); } catch (e) { console.error(e); } }
      offs.forEach((f) => f());
      detachInstant();
    };
  },
});
