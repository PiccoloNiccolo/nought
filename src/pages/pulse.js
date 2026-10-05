// Pulse: three live columns (New pairs, Final stretch, Migrated) fed by core/seed.js (Jupiter gems + recent) and the
// PumpPortal launch socket. Columns come from the store's pulseCol and list the newest first, ~100 each. A column
// holds still while the mouse is on it. Each column has its own filters (ui/pulse-filters.js), quick-buy amount and
// sound switch; the bar on top has launchpad chips (sent to Jupiter), feed health, Rapid mode, sound, hotkeys,
// the blacklist (ui/blacklist.js) and the Display menu. Hovering a picture shows a preview (ui/hover.js).
// Keys: J/K move, Enter opens, H hides, B buys and S sells (Rapid mode only), Esc clears the selection.
import { $, $$, esc, on, LS, toast, short, isMint, parseAmount, ICON } from '../core/util.js';
import { all, tokens, mcUsd } from '../core/store.js';
import { settings, set, preset } from '../core/settings.js';
import { register } from '../core/router.js';
import { feed, setFeedBody, feedBody, defaultBody } from '../core/seed.js';
import { state as stream } from '../core/stream.js';
import { LAUNCHPADS } from '../core/jup.js';
import { quickBuy, quickSell } from '../core/trade.js';
import { wallet, needWallet } from '../core/wallet.js';
import { cardHtml, cardKey, lpInfo } from '../ui/card.js';
import { COL_IDS, loadAll, compile, activeCount, buildBody, openFilters, emptyFilter, saveAll } from '../ui/pulse-filters.js';
import * as BL from '../ui/blacklist.js';
import { attachHover } from '../ui/hover.js';
import { imageKey, syncTokenImage, primeTokenImage, retryTokenImages } from '../ui/token-image.js';
import { watchMints, toggleWatch } from '../core/watchlist.js';

const by = (k) => (a, b) => (b[k] || 0) - (a[k] || 0);
export const COLS = [
  // New: launch time. Final stretch: the latest Jupiter listing first (pulseAt), newest coin within it. Migrated: migration time.
  { id: 'new', title: 'New pairs', sort: (a, b) => by('created')(a, b) || by('pulseAt')(a, b), empty: 'Waiting for new coins…' },
  { id: 'stretch', title: 'Final stretch', sort: (a, b) => by('pulseAt')(a, b) || by('created')(a, b), empty: 'Coins close to finishing their bonding curve land here.' },
  { id: 'migrated', title: 'Migrated', sort: (a, b) => (b.migratedAt || b.pulseAt || 0) - (a.migratedAt || a.pulseAt || 0), empty: 'Coins that finished their bonding curve land here.' },
];
const MAX = 100, MAX_QB = 100, QB_CAP = 1000; // cards per column; largest per-column amount you can type; largest click (as card.js and the shell)
const TONE = { new: [880, 1175], stretch: [660, 880], migrated: [988, 1319] };
const DISPLAY = { ms: 'm', qbSize: 'm', circle: false, ring: true, grey: false, nodec: false, detail: false, search: true, showHidden: false, unhideMigrate: true, vol: 0.5 };
const SORTS = { newest: 'Newest', volume: 'Volume · 5m', change: 'Gainers · 5m', liquidity: 'Liquidity', cap: 'Market cap' };
const sortValue = (t, mode) => mode === 'volume' ? t.stats5m?.vol : mode === 'change' ? t.stats5m?.priceChange : mode === 'liquidity' ? t.liquidity : mcUsd(t);
const loadSorts = () => { const saved = LS.get('pulse.sorts', {}); return Object.fromEntries(COL_IDS.map((c) => [c, Object.hasOwn(SORTS, saved?.[c]) ? saved[c] : 'newest'])); };
const OPT = { ms: ['s', 'm', 'l'], qbSize: ['s', 'l', 'm', 'u'] };
function loadDisplay() {
  const d = { ...DISPLAY, ...LS.get('pulse.display', {}) };
  for (const [k, v] of Object.entries(DISPLAY)) if (typeof d[k] !== typeof v || (OPT[k] && !OPT[k].includes(d[k]))) d[k] = v;
  d.vol = Math.max(0, Math.min(1, d.vol));
  return d;
}
const IC = {
  bell: (off) => `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Zm4 4a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>${off ? '<path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' : ''}</svg>`,
  keys: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  ban: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M6.5 17.5 17.5 6.5" stroke="currentColor" stroke-width="2"/></svg>',
  disp: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};
const solTxt = (v) => String(Math.round(Number(v) * 1e4) / 1e4);
const AGE_RE = /(data-age="\d+"[^>]*>)[^<]*/;
const SKELETON = '<span class="sr-only">Loading coins…</span>' + '<div class="pu-skc" aria-hidden="true"><i class="skel sk-av"></i><span class="sk-m"><i class="skel"></i><i class="skel"></i><i class="skel"></i></span><span class="sk-s"><i class="skel"></i><i class="skel"></i><i class="skel pill"></i></span></div>'.repeat(6);

register({
  id: 'pulse', tab: 'pulse', path: '#/pulse', title: 'Pulse · Nought',
  mount(view) {
    const S = {
      hovered: new Set(), lastCol: '', popHold: false, socialHold: false, mobile: COL_IDS.includes(LS.get('pulse.mobile', 'new')) ? LS.get('pulse.mobile', 'new') : 'new',
      sel: null, hoverMint: '', hoverCol: '', rapid: false, q: '', quiet: true, force: false, gAt: 0,
      filters: loadAll(), lps: (LS.get('pulse.lps', []) || []).filter((x) => LAUNCHPADS.includes(x)), disp: loadDisplay(),
      amounts: LS.get('pulse.qb', {}) || {}, mute: LS.get('pulse.mute', {}) || {}, sorts: loadSorts(), paused: new Set(), onlyWatched: false,
    };
    const cache = Object.fromEntries(COL_IDS.map((c) => [c, new Map()]));   // mint → {sig, el, img}
    const seen = Object.fromEntries(COL_IDS.map((c) => [c, new Set()]));    // ever shown in that column (sound/flash once)
    const shown = Object.fromEntries(COL_IDS.map((c) => [c, []]));          // mints on screen, in order (J/K)
    const primed = new Set(), lastBeep = {};
    const colAmt = (c) => { const v = Number(S.amounts[c]); return v > 0 && v <= MAX_QB ? v : 0; };
    const amountFor = (c) => colAmt(c) || preset().buy;

    view.innerHTML = `<div class="pu">
      <div class="pu-top">
        <div class="pu-title"><h1>Pulse</h1><span class="pu-chain"><i></i>Solana</span><span class="pu-zero" title="Nought adds no trading fee. Network and pool fees still apply.">0% house fee</span></div>
        <input class="pu-q" type="search" placeholder="Filter tokens…" aria-label="Filter coins on the board by name, ticker or address" spellcheck="false">
        <span class="pu-sp"></span>
        <details class="pu-sources"><summary class="pu-btn" title="Filter by launchpad">${ICON.filter}<span>Sources</span></summary><div class="pu-source-pop"><strong>Launchpads</strong><div class="pu-lps hfade" role="group" aria-label="Launchpads"><button type="button" data-lpall>All</button>${LAUNCHPADS.map((id) => `<button type="button" data-glp="${esc(id)}" style="--lp:${lpInfo(id).color}" title="${esc(id)}"><i></i>${esc(lpInfo(id).label)}</button>`).join('')}</div></div></details>
        <span class="pu-health" id="pu-health"><i></i><span>Starting…</span></span>
        <button type="button" class="pu-btn" data-watchonly aria-pressed="false" aria-label="Show saved coins" title="Show only coins in your watchlist">☆ <span>Saved</span></button>
        <button type="button" class="pu-btn pu-ic" data-retryimages title="Retry missing token images" aria-label="Retry missing token images">↻</button>
        <button type="button" class="pu-btn pu-rapid" data-rapid title="Rapid mode: hover a card for instant Buy and Sell buttons; B and S trade the card under the pointer">${ICON.bolt}<span>Rapid</span></button>
        <button type="button" class="pu-btn pu-ic" data-sound></button>
        <button type="button" class="pu-btn pu-ic" data-keys title="Keyboard shortcuts">${IC.keys}</button>
        <button type="button" class="pu-btn" data-bl title="Hidden coins, dev wallets, keywords and X handles">${IC.ban}<span>Blacklist</span><b id="pu-bln"></b></button>
        <button type="button" class="pu-btn" data-display title="How cards look">${IC.disp}<span>Display</span></button>
      </div>
      <div class="pu-switch" role="tablist">${COLS.map((c) => `<button type="button" role="tab" data-mcol="${c.id}">${c.title}<b id="pu-mn-${c.id}"></b></button>`).join('')}</div>
      <div class="pu-cols">${COLS.map((c) => `<section class="pu-col" data-colid="${c.id}" aria-label="${c.title}">
        <header class="pu-ch"><i class="pu-stage" aria-hidden="true"></i><h2>${c.title}</h2><span class="pu-n" id="pu-n-${c.id}">0</span><span class="pu-paused" id="pu-p-${c.id}" hidden>Paused</span><span class="pu-sp"></span>
          <label class="pu-amt" title="Quick-buy amount for this column (empty = preset)">${ICON.bolt}<input data-amt="${c.id}" inputmode="decimal" autocomplete="off" aria-label="${c.title} quick-buy SOL"><em>SOL</em></label>
          <button type="button" class="pu-ib" data-mute="${c.id}"></button>
          <div class="pu-sortbar"><label title="Sort ${c.title}">⇅<select data-sort="${c.id}" aria-label="Sort ${c.title}">${Object.entries(SORTS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label><button type="button" data-pause="${c.id}" aria-label="Pause ${c.title}" aria-pressed="false" title="Pause this column">Ⅱ</button></div>
          <button type="button" class="pu-ib pu-fb" data-filter="${c.id}" title="Filters for ${c.title}">${ICON.filter}<b id="pu-fc-${c.id}"></b></button>
        </header>
        <div class="pu-list" id="pu-l-${c.id}"></div>
      </section>`).join('')}</div>
    </div>`;
    const root = $('.pu', view), q = $('.pu-q', view);

    // ---- feed body: launchpad chips + column filters go to Jupiter (only when they changed) ----
    const applyBody = () => { const b = buildBody(S.lps, S.filters); if (JSON.stringify(b) !== JSON.stringify(feedBody())) setFeedBody(b); };
    applyBody();

    // ---- header state ----
    function chrome() {
      $$('[data-glp]', root).forEach((b) => b.classList.toggle('on', S.lps.includes(b.dataset.glp)));
      $('[data-lpall]', root).classList.toggle('on', !S.lps.length);
      $('[data-sound]', root).innerHTML = IC.bell(!settings.sounds); $('[data-sound]', root).classList.toggle('on', settings.sounds);
      $('[data-sound]', root).title = settings.sounds ? 'Sound on for new coins that pass your filters. Click to mute.' : 'Sound off. Click to hear new coins that pass your filters.';
      const rb = $('[data-rapid]', root); rb.classList.toggle('on', S.rapid); $('span', rb).textContent = S.rapid ? `Rapid · ${preset().name}` : 'Rapid';
      root.classList.toggle('rapid', S.rapid);
      $('#pu-bln').textContent = BL.size() || '';
      q.hidden = !S.disp.search;
      const saved = $('[data-watchonly]', root); saved.classList.toggle('on', S.onlyWatched); saved.setAttribute('aria-pressed', String(S.onlyWatched));
      for (const c of COL_IDS) {
        const sort = $(`[data-sort="${c}"]`, root); sort.value = SORTS[S.sorts[c]] ? S.sorts[c] : 'newest';
        const pause = $(`[data-pause="${c}"]`, root), held = S.paused.has(c);
        pause.textContent = held ? '▶' : 'Ⅱ'; pause.setAttribute('aria-pressed', String(held)); pause.setAttribute('aria-label', `${held ? 'Resume' : 'Pause'} ${COLS.find((x) => x.id === c).title}`);
        const n = activeCount(S.filters[c]); $('#pu-fc-' + c).textContent = n || ''; $(`[data-filter="${c}"]`, root).classList.toggle('on', n > 0);
        const m = $(`[data-mute="${c}"]`, root); m.innerHTML = IC.bell(S.mute[c]); m.title = S.mute[c] ? 'This column is muted' : 'Sound for this column';
        m.classList.toggle('off', !!S.mute[c]); m.hidden = !settings.sounds;
        const inp = $(`[data-amt="${c}"]`, root); if (document.activeElement !== inp) { inp.value = colAmt(c) ? solTxt(colAmt(c)) : ''; inp.placeholder = solTxt(preset().buy); }
        $(`[data-colid="${c}"]`, root).classList.toggle('on', S.mobile === c); $(`[data-mcol="${c}"]`, root).classList.toggle('on', S.mobile === c); $(`[data-mcol="${c}"]`, root).setAttribute('aria-selected', String(S.mobile === c));
      }
    }

    // ---- rendering: keyed, so unchanged cards (and their loaded pictures) stay put ----
    const tpl = document.createElement('template');
    const toEl = (html) => { tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };
    const cardOpts = (col) => ({ col, qb: amountFor(col), qbSize: S.disp.qbSize, ms: S.disp.ms, compact: settings.compact, circle: S.disp.circle, ring: S.disp.ring, grey: S.disp.grey, nodec: S.disp.nodec, detail: S.disp.detail, actions: true, rapid: S.rapid, star: true });
    function emptyHtml(col, bucketSize) {
      const f = S.filters[col], n = activeCount(f);
      if (S.onlyWatched) return '<div class="pu-empty"><b>No saved coins in this column</b><span>Star a coin to keep it on your watchlist.</span><button type="button" class="btn btn-ghost" data-watchonly>Show all coins</button></div>';
      if (bucketSize && (n || S.lps.length || S.q || BL.size())) return `<div class="pu-empty"><span>No coins here match ${n ? 'this column\'s filters' : S.q ? 'your search' : 'your launchpads or blacklist'} right now.</span>${n ? `<span class="pu-ea"><button type="button" class="btn btn-ghost" data-filter="${col}">Edit filters</button><button type="button" class="btn btn-ghost" data-freset="${col}">Reset</button></span>` : ''}</div>`;
      if (feed.error && !feed.lastGems) return `<div class="pu-empty"><span class="pu-err">The feed is not answering: ${esc(feed.error)}</span><span>Retrying every few seconds.</span></div>`;
      if (!feed.lastGems && !feed.lastRecent) return SKELETON; // first load: the board's shape, not a black column
      return `<div class="pu-empty"><span class="pulse-dot"></span><span>${esc(COLS.find((c) => c.id === col).empty)}</span></div>`;
    }
    function patch(col, rows, bucketSize) {
      const list = $('#pu-l-' + col), old = cache[col], next = new Map(), o = cardOpts(col), quiet = S.quiet || !primed.has(col);
      let fresh = 0;
      if (!rows.length) {
        old.clear(); shown[col] = [];
        const html = emptyHtml(col, bucketSize); if (list.dataset.empty !== html) { list.innerHTML = html; list.dataset.empty = html; }
        return 0;
      }
      if (list.dataset.empty) { list.innerHTML = ''; delete list.dataset.empty; }
      const watched = new Set(watchMints());
      for (const [t, blk] of rows) {
        const opts = { ...o, watched: watched.has(t.mint), ...(blk ? { blocked: blk } : {}) }, key = cardKey(t, opts);
        let c = old.get(t.mint);
        if (!c || c.key !== key) {
          const html = cardHtml(t, opts), sig = html.replace(AGE_RE, '$1');
          if (c?.sig === sig) { c.key = key; next.set(t.mint, c); continue; }
          const el = toEl(html);
          if (c) {
            const a = $('.nc-img', c.el), b = $('.nc-img', el);
            if (a && b) { syncTokenImage($('[data-token-image]', a), t); b.replaceWith(a); }
          } // keep the picture and active download through metadata and price changes
          c = { key, sig, el, img: imageKey(t) };
        }
        if (!old.has(t.mint) && !seen[col].has(t.mint)) { seen[col].add(t.mint); if (!quiet) { c.el.classList.add('fresh'); fresh++; } }
        next.set(t.mint, c);
      }
      for (const [m, c] of old) if (next.get(m)?.el !== c.el) c.el.remove();
      let ref = list.firstElementChild;
      for (const c of next.values()) { if (c.el === ref) ref = ref.nextElementSibling; else list.insertBefore(c.el, ref); }
      while (ref) { const n = ref.nextElementSibling; ref.remove(); ref = n; }
      cache[col] = next; shown[col] = [...next.keys()];
      if (seen[col].size > 4000) seen[col] = new Set(shown[col]);
      primed.add(col);
      return fresh;
    }
    function render() {
      if (!root.isConnected || document.hidden) return;
      const qq = S.q.trim().toLowerCase(), glp = S.lps, watched = new Set(watchMints()), buckets = Object.fromEntries(COL_IDS.map((c) => [c, []]));
      for (const t of all()) buckets[t.pulseCol]?.push(t);
      for (const c of COLS) {
        const mode = SORTS[S.sorts[c.id]] ? S.sorts[c.id] : 'newest';
        const pass = compile(S.filters[c.id]), rows = [], b = buckets[c.id].sort(mode === 'newest' ? c.sort : (a, b) => (sortValue(b, mode) ?? -Infinity) - (sortValue(a, mode) ?? -Infinity) || c.sort(a, b));
        for (const t of b) {
          if (S.onlyWatched && !watched.has(t.mint)) continue;
          if (glp.length && !glp.includes(t.launchpad) && !glp.includes(t.metaLaunchpad)) continue;
          if (qq && !`${t.name || ''} ${t.symbol || ''} ${t.mint}`.toLowerCase().includes(qq)) continue;
          if (!pass(t)) continue;
          const blk = BL.blocked(t, { ignoreMint: c.id === 'migrated' && S.disp.unhideMigrate });
          if (blk && !S.disp.showHidden) continue;
          rows.push([t, blk]); if (rows.length >= MAX) break;
        }
        $('#pu-n-' + c.id).textContent = rows.length >= MAX ? MAX + '+' : rows.length;
        $('#pu-mn-' + c.id).textContent = rows.length || '';
        const paused = !S.force && cache[c.id].size > 0 && (S.paused.has(c.id) || S.hovered.has(c.id) || ((S.popHold || S.socialHold) && S.lastCol === c.id)), pe = $('#pu-p-' + c.id);
        if (paused) {
          // Holding the list must not freeze artwork that arrived after a launch.
          // Replace only the image: row order, metrics and trade buttons stay put.
          for (const [mint, cached] of cache[c.id]) {
            const token = tokens.get(mint), key = token && imageKey(token);
            if (!token || key === cached.img) continue;
            const picture = $('[data-token-image]', cached.el);
            if (picture) syncTokenImage(picture, token);
            cached.img = key;
          }
          const waiting = rows.filter(([t]) => !cache[c.id].has(t.mint)).length;
          pe.hidden = false; pe.textContent = waiting ? `Paused · ${waiting} new` : 'Paused';
          continue;
        }
        pe.hidden = true;
        if (patch(c.id, rows, b.length)) beep(c.id);
      }
      markSel();
      S.quiet = false; S.force = false;
    }
    // after a change the person made (filters, chips, display): redraw quietly, even a column the mouse is holding
    const rerender = () => { S.quiet = true; S.force = true; render(); };

    // ---- selection (J/K) and the card under the pointer ----
    function markSel() {
      $$('.card.nc.sel', root).forEach((el) => el.classList.remove('sel'));
      if (S.sel) cache[S.sel.col]?.get(S.sel.mint)?.el.classList.add('sel');
    }
    function move(dir) {
      const narrow = innerWidth <= 760, col = S.sel?.col && (!narrow || S.sel.col === S.mobile) ? S.sel.col : S.hoverCol || (narrow ? S.mobile : 'new'), ids = shown[col];
      if (!ids.length) return;
      let i = S.sel?.col === col ? ids.indexOf(S.sel.mint) : -1;
      i = i < 0 ? (dir > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, i + dir));
      S.sel = { col, mint: ids[i] }; markSel();
      cache[col].get(ids[i])?.el.scrollIntoView({ block: 'nearest' });
    }
    const target = (prefer = 'hover') => (prefer === 'hover' ? S.hoverMint || S.sel?.mint : S.sel?.mint || S.hoverMint) || '';
    const colOf = (mint) => (S.hoverMint === mint && S.hoverCol) || (S.sel?.mint === mint && S.sel.col) || tokens.get(mint)?.pulseCol || 'new';

    // ---- actions ----
    const label = (mint) => { const t = tokens.get(mint); return t?.symbol ? '$' + t.symbol : short(mint); };
    function hideCoin(mint) {
      if (!isMint(mint) || !BL.add('mint', mint, tokens.get(mint)?.symbol || '')) return;
      toast(`Hid ${esc(label(mint))}. <button type="button" class="pu-undo" data-pu-undo="${esc(mint)}">Undo</button>`);
    }
    function blDev(dev, mint) {
      if (!isMint(dev)) return;
      if (BL.add('dev', dev, tokens.get(mint)?.symbol ? 'made $' + tokens.get(mint).symbol : '')) toast(`Blacklisted creator <span class="mono">${esc(short(dev))}</span>. All their coins are hidden. Manage it under Blacklist.`, 'ok');
    }
    function blX(h) { if (BL.add('x', h)) toast(`Blacklisted @${esc(h)}. Coins linking to it are hidden.`, 'ok'); }
    // every trade path checks the address first: data-* values are only as good as the card that rendered them
    const okSol = (v) => (v > 0 && v <= QB_CAP ? v : 0);
    function buy(mint, btn) {
      if (!isMint(mint)) return;
      const col = btn?.closest('[data-col]')?.dataset.col || colOf(mint), sol = okSol(Number(btn?.dataset.sol)) || okSol(amountFor(col));
      if (!sol) { toast('Set a quick-buy amount for this column or your preset.', 'err'); return; }
      quickBuy(mint, btn, sol); // the amount the button shows; core/trade: no platform fee; refuses >25% price impact; the wallet signs
    }
    function sell(mint, btn, pct) {
      const p = Number(pct);
      if (!isMint(mint) || !(p > 0 && p <= 100)) return;
      quickSell(mint, btn, p);
    }
    function toggleRapid() {
      if (S.rapid) { S.rapid = false; toast('Rapid mode off.'); }
      else {
        if (!needWallet()) return;
        S.rapid = true;
        const p = preset();
        toast(`<b>Rapid mode on.</b> Hover a card: Buy spends that column's amount, 25/50/100% sells that share of your holding. B buys and S sells ${esc(String(p.sellPct))}% of the card under the pointer. Preset ${esc(p.name)} (${esc(String(p.slippage))}% slippage) · wallet <span class="mono">${esc(short(wallet.owner))}</span>${wallet.kind === 'local' ? ' · no confirmation' : ' · your wallet still asks you to approve each trade'}. Nought fee 0%.`, 'ok');
      }
      chrome(); rerender();
    }

    // ---- sound, only after the first click or key press: the alerts module's 'pulse' sound (so its master volume
    // applies) once it has loaded, else a short local tone per column ----
    let actx = null, armed = !!navigator.userActivation?.hasBeenActive, alerts = null;
    import('../ui/alerts.js').then((m) => { if (typeof m.playSound === 'function') { alerts = m; if (pop?.dataset.for === 'display') { pop.innerHTML = displayHtml(); bindVol(); } } }).catch(() => { /* keep the local tone */ });
    const arm = () => { armed = true; };
    // force: the volume slider's preview (a user gesture), played even with sounds switched off
    function beep(col, force = false) {
      if (!force && (!settings.sounds || S.mute[col] || !armed || document.hidden)) return;
      const now = performance.now(); if (!force && now - (lastBeep[col] || 0) < 500) return; lastBeep[col] = now;
      if (alerts) { try { alerts.playSound('pulse', { force }); } catch { /* audio unavailable */ } return; }
      try {
        actx ||= new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
        const t0 = actx.currentTime, v = Math.max(0.0002, S.disp.vol * 0.22);
        TONE[col].forEach((f, i) => {
          const o = actx.createOscillator(), g = actx.createGain(), s = t0 + i * 0.07;
          o.type = 'sine'; o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, s); g.gain.exponentialRampToValueAtTime(v, s + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, s + 0.14);
          o.connect(g).connect(actx.destination); o.start(s); o.stop(s + 0.16);
        });
      } catch { /* audio unavailable */ }
    }

    // ---- popovers: Display menu and hotkeys ----
    let pop = null;
    const closePop = () => { pop?.remove(); pop = null; };
    function openPop(btn, html, onClick) {
      const was = pop?.dataset.for; closePop(); if (was === btn.dataset.for) return null;
      pop = document.createElement('div'); pop.className = 'pu-pop'; pop.dataset.for = btn.dataset.for; pop.innerHTML = html;
      document.body.appendChild(pop);
      const r = btn.getBoundingClientRect(), w = pop.offsetWidth;
      pop.style.top = Math.round(r.bottom + 6) + 'px'; pop.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.right - w))) + 'px';
      if (onClick) pop.addEventListener('click', onClick);
      return pop;
    }
    const seg = (key, opts, cur) => `<div class="seg2">${opts.map(([v, l]) => `<button type="button" data-dk="${key}" data-dv="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    function displayHtml() {
      const d = S.disp;
      return `<h3>Display</h3>
        <div class="row"><span>Rows</span>${seg('compact', [['false', 'Standard'], ['true', 'Compact']], settings.compact)}</div>
        <div class="row"><span>Metric size</span>${seg('ms', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], d.ms)}</div>
        <div class="row"><span>Quick buy</span>${seg('qbSize', [['s', 'Small'], ['l', 'Medium'], ['m', 'Large'], ['u', 'XL']], d.qbSize)}</div>
        <div class="row"><span>Pictures</span>${seg('circle', [['false', 'Square'], ['true', 'Circle']], d.circle)}</div>
        <div class="row"><span>Bonding ring</span>${seg('ring', [['true', 'On'], ['false', 'Off']], d.ring)}</div>
        <div class="row"><span>Extra metrics</span>${seg('detail', [['false', 'Off'], ['true', 'On']], d.detail)}</div>
        <div class="row"><span>Risk indicators</span>${seg('grey', [['false', 'Colored'], ['true', 'Grey']], d.grey)}</div>
        <div class="row"><span>Decimals</span>${seg('nodec', [['false', 'Show'], ['true', 'Hide']], d.nodec)}</div>
        <div class="row"><span>Search bar</span>${seg('search', [['false', 'Off'], ['true', 'On']], d.search)}</div>
        <div class="row"><span>Hidden coins</span>${seg('showHidden', [['false', 'Hide'], ['true', 'Show dimmed']], d.showHidden)}</div>
        <div class="row"><span>On migration</span>${seg('unhideMigrate', [['true', 'Unhide'], ['false', 'Keep hidden']], d.unhideMigrate)}</div>
        <div class="row"><span>Volume</span><input type="range" min="0" max="100" step="5" value="${Math.round((alerts ? alerts.prefs().volume : d.vol) * 100)}" data-vol aria-label="${alerts ? 'Master volume for all Nought sounds' : 'Sound volume'}"></div>
        <p class="hint">${alerts ? 'Volume is the master volume every Nought sound shares (Settings, Alerts). ' : ''}Saved in this browser.</p>`;
    }
    function onDisplayClick(e) {
      const b = e.target.closest('[data-dk]'); if (!b) return;
      const k = b.dataset.dk, raw = b.dataset.dv, v = raw === 'true' ? true : raw === 'false' ? false : raw;
      if (k === 'compact') set({ compact: v }); else { S.disp[k] = v; LS.set('pulse.display', S.disp); }
      pop.innerHTML = displayHtml(); bindVol(); chrome(); rerender();
      if (k === 'search' && v) q.focus();
    }
    function bindVol() {
      const r = pop?.querySelector('[data-vol]'); if (!r) return;
      r.addEventListener('input', () => { const v = Number(r.value) / 100; if (alerts) alerts.setPrefs({ volume: v }); else { S.disp.vol = v; LS.set('pulse.display', S.disp); } });
      r.addEventListener('change', () => { armed = true; beep('new', true); });
    }
    const KEYS = [['J / K', 'Move down / up a column'], ['Enter', 'Open the selected coin'], ['H', 'Hide the coin under the pointer'], ['B', 'Buy it (Rapid mode)'], ['S', 'Sell your preset share of it (Rapid mode)'], ['Esc', 'Clear the selection'], ['1 2 3', 'Switch preset'], ['/', 'Search']];
    const keysHtml = () => `<h3>Keyboard</h3>${KEYS.map(([k, l]) => `<div class="row kb"><kbd>${k}</kbd><span>${l}</span></div>`).join('')}<p class="hint">B and S work only with Rapid mode on, and trade at once with preset ${esc(preset().name)}.</p>`;

    // ---- events ----
    root.addEventListener('click', (e) => {
      const t = e.target;
      const star = t.closest('[data-pu-star]'); if (star) { e.preventDefault(); e.stopPropagation(); toggleWatch(star.dataset.puStar); return; }
      if (t.closest('[data-watchonly]')) { S.onlyWatched = !S.onlyWatched; chrome(); rerender(); return; }
      if (t.closest('[data-retryimages]')) { retryTokenImages(); toast('Retrying visible pictures and checking alternate sources.'); return; }
      const pause = t.closest('[data-pause]'); if (pause) { const c = pause.dataset.pause; if (S.paused.has(c)) S.paused.delete(c); else S.paused.add(c); chrome(); render(); return; }
      // trade buttons: handled here (per-column amount), never passed on to the shell or the card's link; buy()/sell() check isMint
      const qb = t.closest('[data-qb]'); if (qb) { e.preventDefault(); e.stopPropagation(); buy(qb.dataset.qb, qb); return; }
      const rb = t.closest('[data-rb]'); if (rb) { e.preventDefault(); e.stopPropagation(); buy(rb.dataset.rb, rb); return; }
      const rs = t.closest('[data-rs]'); if (rs) { e.preventDefault(); e.stopPropagation(); sell(rs.dataset.rs, rs, rs.dataset.pct); return; }
      const hb = t.closest('[data-hide]'); if (hb) { hideCoin(hb.dataset.hide); return; }
      const bd = t.closest('[data-bldev]'); if (bd) { blDev(bd.dataset.bldev, bd.closest('[data-mint]')?.dataset.mint); return; }
      const bx = t.closest('[data-blx]'); if (bx) { blX(bx.dataset.blx); return; }
      const ub = t.closest('[data-unhide]'); if (ub) { BL.remove(ub.dataset.unhide, ub.dataset.v); return; }
      const gl = t.closest('[data-glp]'); if (gl) { const id = gl.dataset.glp; S.lps = S.lps.includes(id) ? S.lps.filter((x) => x !== id) : [...S.lps, id]; if (S.lps.length === LAUNCHPADS.length) S.lps = []; LS.set('pulse.lps', S.lps); applyBody(); chrome(); rerender(); return; }
      if (t.closest('[data-lpall]')) { S.lps = []; LS.set('pulse.lps', S.lps); applyBody(); chrome(); rerender(); return; }
      const fb = t.closest('[data-filter]'); if (fb) { openFilters(fb.dataset.filter, (a) => { S.filters = a; applyBody(); chrome(); rerender(); }); return; }
      const fr = t.closest('[data-freset]'); if (fr) { S.filters[fr.dataset.freset] = emptyFilter(); saveAll(S.filters); applyBody(); chrome(); rerender(); return; }
      const mb = t.closest('[data-mute]'); if (mb) { const c = mb.dataset.mute; S.mute[c] = !S.mute[c]; LS.set('pulse.mute', S.mute); chrome(); return; }
      const mc = t.closest('[data-mcol]'); if (mc) { S.mobile = mc.dataset.mcol; LS.set('pulse.mobile', S.mobile); if (S.sel && S.sel.col !== S.mobile) S.sel = null; chrome(); markSel(); return; }
      if (t.closest('[data-rapid]')) { toggleRapid(); return; }
      if (t.closest('[data-sound]')) { armed = true; set({ sounds: !settings.sounds }); return; }
      if (t.closest('[data-bl]')) { closePop(); BL.openBlacklist(); return; }
      const db = t.closest('[data-display]'); if (db) { db.dataset.for = 'display'; if (openPop(db, displayHtml(), onDisplayClick)) bindVol(); return; }
      const kb = t.closest('[data-keys]'); if (kb) { kb.dataset.for = 'keys'; openPop(kb, keysHtml()); return; }
    });
    root.addEventListener('change', (e) => {
      const sort = e.target.closest('[data-sort]'); if (sort) { if (SORTS[sort.value]) { S.sorts[sort.dataset.sort] = sort.value; LS.set('pulse.sorts', S.sorts); rerender(); } return; }
      const inp = e.target.closest('[data-amt]'); if (!inp) return;
      const c = inp.dataset.amt, raw = inp.value.trim(), v = parseAmount(raw); // "0,5" is 0.5 SOL, never 5
      if (!COL_IDS.includes(c)) return;
      if (!raw) delete S.amounts[c];
      else if (v > 0 && v <= MAX_QB) S.amounts[c] = Math.round(v * 1e4) / 1e4;
      else toast(Number.isNaN(v) ? 'Enter a SOL amount like 0.25 (one decimal point, no other symbols).' : `Enter an amount above 0 and up to ${MAX_QB} SOL.`, 'err');
      LS.set('pulse.qb', S.amounts); inp.blur(); chrome(); rerender();
    });
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest('[data-amt]')) e.target.blur(); });
    q.addEventListener('input', () => { S.q = q.value; rerender(); });
    // fresh-row flash plays once: drop the class so a later reorder does not replay it
    root.addEventListener('animationend', (e) => e.target.classList?.remove('fresh'));
    // a column holds still while the mouse is on it (pointer type check: taps on phones must not freeze a column)
    $$('.pu-list', root).forEach((l) => {
      const id = l.id.slice(5);
      l.addEventListener('pointerenter', (e) => { if (e.pointerType !== 'mouse') return; S.hovered.add(id); S.lastCol = id; render(); });
      l.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'mouse') return; S.hovered.delete(id); S.hoverMint = ''; S.hoverCol = ''; setTimeout(render, 0); });
    });
    root.addEventListener('pointerover', (e) => { const c = e.target.closest?.('.card.nc'); S.hoverMint = c?.dataset.mint || ''; S.hoverCol = c?.dataset.col || ''; });

    const onDocClick = (e) => {
      const u = e.target.closest?.('[data-pu-undo]'); if (u) { BL.remove('mint', u.dataset.puUndo); u.closest('.toast')?.remove(); return; }
      const sources = $('.pu-sources', root); if (sources?.open && !e.composedPath().includes(sources)) sources.open = false;
      if (pop && !e.composedPath().includes(pop) && !e.target.closest?.('[data-display], [data-keys]')) closePop(); // composedPath: the menu re-renders under the click
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && pop) { closePop(); return; }
      const sources = $('.pu-sources', root);
      if (e.key === 'Escape' && sources?.open) { sources.open = false; $('summary', sources).focus(); e.preventDefault(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'g') { S.gAt = Date.now(); return; }
      if (Date.now() - S.gAt < 900) return; // the shell's g + key page jumps
      if (k === 'j' || k === 'k') { e.preventDefault(); move(k === 'j' ? 1 : -1); }
      else if (k === 'Escape') { S.sel = null; markSel(); }
      else if (k === 'Enter') { if (e.target.closest?.('a, button')) return; const m = target('sel'); if (isMint(m)) location.hash = '#/t/' + m; }
      else if (k === 'h') { const m = target(); if (m) { hideCoin(m); if (S.sel?.mint === m) S.sel = null; } }
      else if (k === 'b' || k === 's') {
        if (e.repeat) return;
        const m = target(); if (!isMint(m)) return;
        if (!S.rapid) { toast('Turn on Rapid mode to buy with B and sell with S.'); return; }
        const el = cache[colOf(m)]?.get(m)?.el;
        if (k === 'b') buy(m, el?.querySelector('[data-rb]') || null); else sell(m, el?.querySelector('[data-rs]') || null, preset().sellPct);
      }
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', arm, { once: true, capture: true });
    document.addEventListener('keydown', arm, { once: true, capture: true });

    // ---- feed health (seed.js feed + the launch socket) ----
    const health = $('#pu-health');
    function tickHealth() {
      if (document.hidden) return;
      const now = Date.now(), s = (ms) => (ms ? Math.round((now - ms) / 1000) + 's ago' : 'not yet');
      const age = feed.lastGems ? (now - feed.lastGems) / 1000 : null;
      let cls = 'ok', txt;
      if (feed.source === 'geckoterminal') { cls = 'warn'; txt = 'Backup feed'; }
      else if (feed.fails) { cls = feed.fails > 3 ? 'bad' : 'warn'; txt = `Retrying · ${feed.fails}`; }
      else if (age == null) { cls = 'wait'; txt = feed.lastRecent ? 'Partial' : 'Starting…'; }
      else if (age < 15) txt = `Live · ${Math.max(0, Math.round(age))}s`;
      else { cls = 'warn'; txt = `Stale · ${Math.round(age)}s`; }
      health.className = 'pu-health ' + cls; $('span', health).textContent = txt;
      health.title = [`Source: ${feed.source === 'geckoterminal' ? 'GeckoTerminal (backup while Jupiter is down)' : 'Jupiter'}`, `Pools (every 4 s): ${s(feed.lastGems)}`, `Newest coins (every 10 s): ${s(feed.lastRecent)}`, `Launch socket: ${stream.ok ? 'connected' : 'reconnecting'}${stream.lastMsg ? ', last event ' + s(stream.lastMsg) : ''}`, feed.error ? `Last error: ${feed.error}` : '', feed.on ? '' : 'Feed paused (tab hidden)'].filter(Boolean).join('\n');
    }
    tickHealth();
    const timer = setInterval(tickHealth, 1000);

    const onVisible = () => { if (!document.hidden) render(); };
    document.addEventListener('visibilitychange', onVisible);
    const socialHold = (e) => { S.socialHold = !!e.detail?.held; if (e.detail?.col) S.lastCol = e.detail.col; if (!S.socialHold) setTimeout(render, 0); };
    document.addEventListener('nought-social-hover', socialHold);
    const detachHover = attachHover(root, { hold: (h) => { S.popHold = h; if (!h) setTimeout(render, 0); } });
    chrome(); render();
    const offs = [
      on('tokens', render), on('feed', render), on('sol', render),
      on('new-token', t => {
        if (document.hidden || !root.isConnected || (innerWidth <= 760 && S.mobile !== 'new') || $('#pu-l-new').scrollTop > 100) return;
        if (S.paused.has('new') || S.hovered.has('new') || ((S.popHold || S.socialHold) && S.lastCol === 'new')) return;
        if (S.lps.length && !S.lps.includes(t.launchpad) && !S.lps.includes(t.metaLaunchpad)) return;
        if (S.onlyWatched && !watchMints().includes(t.mint)) return;
        if (S.q && !`${t.name || ''} ${t.symbol || ''} ${t.mint}`.toLowerCase().includes(S.q.trim().toLowerCase())) return;
        if (!compile(S.filters.new)(t) || (BL.blocked(t) && !S.disp.showHidden)) return;
        primeTokenImage(t);
      }),
      on('watch', rerender),
      on('settings', () => { const f = loadAll(); if (JSON.stringify(f) !== JSON.stringify(S.filters)) { S.filters = f; applyBody(); } chrome(); rerender(); if (pop?.dataset.for === 'display') { pop.innerHTML = displayHtml(); bindVol(); } }),
      on('wallet', () => { if (S.rapid && !wallet.owner) { S.rapid = false; chrome(); rerender(); } }),
      BL.onChange(() => { chrome(); rerender(); }),
    ];
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer); offs.forEach((f) => f()); detachHover(); document.removeEventListener('nought-social-hover', socialHold); closePop();
      document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', arm, { capture: true }); document.removeEventListener('keydown', arm, { capture: true });
      try { actx?.close(); } catch { /* closed */ }
      if (JSON.stringify(feedBody()) !== JSON.stringify(defaultBody())) setFeedBody(defaultBody()); // other pages get the full feed back
    };
  },
});
