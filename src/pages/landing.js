// Landing (#/): what Nought is, with live proof pulled from the store and the launch stream. The hero is centred (mark,
// headline, one primary button) above a framed live preview of the terminal: the busiest coin we know with its
// market-cap chart (landing-chart.js) beside the newest launches as mini cards. Below the fold: what Nought promises
// (no fee, your wallet signs, open code), what a 1% fee would have cost, the pages, and how Nought pays for itself.
import { $, $$, esc, on, usd, isMint, safeUrl, parseTarget } from '../core/util.js';
import { tokens, all, mcUsd } from '../core/store.js';
import { solUsd } from '../core/price.js';
import { register } from '../core/router.js';
import { cardHtml, avatar, money, lpInfo } from '../ui/card.js';
import { UPKEEP } from './upkeep.js';
import { PREVIEW_IVS, mountPreviewChart } from './landing-chart.js';
import { blocked } from '../ui/blacklist.js';

// the repository link: index.html's <meta name="nought:repo">, or a placeholder until the code is published
const repoLink = (label, cls = '') => {
  const u = safeUrl(document.querySelector('meta[name="nought:repo"]')?.content || '');
  return u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : `<a class="${cls}" href="#" title="The repository link goes here once the code is published">${label}</a>`;
};

// Launches seen since the app loaded. Counted at module level (app lifetime) so the tally survives page changes.
const bootAt = Date.now();
let launches = 0;
const recent = []; // timestamps of the last minute's launches, for the per-minute rate
const trim = (now) => { while (recent.length && now - recent[0] > 60e3) recent.shift(); };
on('new-token', () => { launches++; const now = Date.now(); recent.push(now); trim(now); });
// the launch stream may be down while the Pulse feed still brings new coins: count those too (created since `since`)
const madeSince = (since) => { let n = 0; for (const t of tokens.values()) if (t.created >= since) n++; return n; };
const seen = () => Math.max(launches, madeSince(bootAt));
const perMin = () => { const now = Date.now(); trim(now); return Math.max(recent.length, madeSince(now - 60e3)); };

// the preview chart opens on 1-second candles: the busiest coin trades every second, so the chart moves while you look
const PREVIEW_IV = '1s';
const FEE_RATE = 0.01; // the comparison: a typical 1% terminal fee
const VOLUMES = [10, 100, 1000];
const fmtSol = (n) => (n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 }) : String(Number(n.toPrecision(3))));
const solUsdTxt = (s) => (solUsd() > 0 ? '≈ ' + usd(s * solUsd(), 1) : '');

// the Nought mark: an upright zero (as in 0% fees), the same as the header and favicon
const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="12" rx="6.4" ry="9.3" fill="none" stroke="currentColor" stroke-width="3.4"/></svg>';
const ARROW = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const line = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const PROMISES = [
  { icon: line('<path d="M18.5 5.5 5.5 18.5"/><circle cx="7.5" cy="7.5" r="2.6"/><circle cx="16.5" cy="16.5" r="2.6"/>'), name: '0% Nought fee', text: 'Nought adds no fee to any trade. Every quote lists the pool, launchpad, network and priority fees before you sign.' },
  { icon: line('<path d="M12 3 5 6v5.5c0 4.2 2.9 7.9 7 9 4.1-1.1 7-4.8 7-9V6l-7-3Z"/><path d="m9 12 2.2 2.2L15.5 10"/>'), name: 'Your wallet signs every trade', text: 'Connect an extension wallet or make one here. Imported or created wallets stay encrypted in this browser and never leave it.' },
  { icon: line('<path d="m8.5 8-4 4 4 4m7-8 4 4-4 4M13.5 5l-3 14"/>'), name: 'Open code, no account', text: 'Nought is static files under the MIT license: no sign-up, no database. Its one server, an optional relay that reads coin pictures and names, is open source too.' },
];

const FEATURES = [
  { href: '#/scope', name: 'Scope', text: 'Three live columns: fresh launches, coins near the end of their bonding curve, and coins that just migrated. Buy from any card in one click.' },
  { href: null, name: 'Token pages', text: 'Market-cap chart, live trades, holders and an audit grid beside a trade panel that lists every third-party fee before you sign.' },
  { href: '#/track', name: 'Trackers', text: 'Follow the wallets you care about and see their buys and sells as they land.' },
  { href: '#/portfolio', name: 'Portfolio', text: 'Holdings, cost basis and profit from your own trade log, kept in this browser.' },
];

// the busiest coin we know (24h volume), skipping any whose chart would not load. A launchpad coin (pump.fun and the
// like) comes first: under a memecoin headline a tokenized stock is the wrong example. A coin that has collapsed (under
// a $15K market cap, or down 75% in the hour or 90% in the day) only shows when nothing else qualifies: its 24h volume
// is mostly the crash, and its chart is a flat line after one cliff.
const live = (t) => !(mcUsd(t) < 15e3) && !(t.stats1h?.priceChange <= -75) && !(t.stats24h?.priceChange <= -90);
const padCoin = (t) => !!t.launchpad || /pump$/.test(t.mint);
// slurs stay off the public front page (Pulse shows every launch; the landing only shows a few)
const SLUR = /\b(fag+(ot)?s?|n[i1]gg(a|er|uh)s?|k[i1]kes?|retard(s|ed)?|trann(y|ies)|chinks?|spics?|wetbacks?)\b/i;
const shown = (t) => !blocked(t) && !SLUR.test(`${t.name || ''} ${t.symbol || ''}`);
function busiest(skip) {
  let best = null, rank = -1;
  for (const t of tokens.values()) {
    if (!isMint(t.mint) || !t.symbol || skip?.has(t.mint) || !(t.volume24h > 0) || !shown(t)) continue;
    const r = (padCoin(t) && live(t) ? 3 : live(t) ? 2 : padCoin(t) ? 1 : 0);
    if (r > rank || (r === rank && t.volume24h > best.volume24h)) { best = t; rank = r; }
  }
  return best;
}
const symOf = (t) => '$' + String(t.symbol || '').replace(/^\$/, '').slice(0, 12);
// a coin worth opening as the "token pages" example: the busiest coin we know, else Pulse
function exampleCoin() {
  const best = busiest();
  return best ? { href: '#/t/' + best.mint, label: '#/t/' + symOf(best) } : { href: '#/scope', label: '#/t/…' };
}

register({
  id: 'landing', tab: 'landing', path: '#/', title: 'Nought · the zero-fee memecoin terminal',
  mount(view) {
    const ex = exampleCoin(), launched = isMint(UPKEEP.coinMint);
    view.innerHTML = `<div class="page ld">
      <section class="ld-hero">
        <div class="ld-in ld-hero-in">
          <div class="ld-mark" aria-hidden="true">${MARK}</div>
          <h1>The zero-fee memecoin terminal</h1>
          <p class="ld-lede">Watch pump.fun launches land, read the chart, buy in one click. Nought adds no fee to any trade and asks for no account.</p>
          <div class="ld-cta">
            <a class="btn btn-accent ld-go" href="#/scope">Open the terminal</a>
            <a class="btn ld-ghost" href="#/upkeep">How it stays free</a>
          </div>
          <p class="ld-kicker">Open source · MIT · Solana</p>
          <dl class="ld-proof" aria-label="Live now">
            <div class="live"><dt>coins tracked</dt><dd class="mono" id="ld-coins">—</dd></div>
            <div hidden><dt>launches seen</dt><dd class="mono" id="ld-launches">0</dd></div>
            <div class="lead"><dt>SOL</dt><dd class="mono" id="ld-sol">—</dd></div>
            <div class="zero"><dt>Nought fee</dt><dd class="mono">0%</dd></div>
          </dl>
        </div>
        <div class="ld-stage">
          <div class="ld-steps" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
          <div class="ld-frame">
            <div class="ld-frame-in">
              <div class="ld-app" aria-label="Live preview of the terminal">
                <div class="ld-app-head">
                  <div class="ld-coin" id="ld-coin"><span class="skel ld-sk-av"></span><span class="skel ld-sk-t"></span></div>
                  <div class="ld-coin-data hfade" id="ld-coin-data"></div>
                  <a class="btn btn-accent sm ld-trade" id="ld-trade" href="#/scope" hidden>Trade</a>
                </div>
                <div class="ld-app-body">
                  <div class="ld-chart-col">
                    <div class="ld-ctools">
                      <div class="ld-ivs" role="group" aria-label="Candle interval">${PREVIEW_IVS.map(([k]) => `<button type="button" data-iv="${esc(k)}" aria-pressed="${k === PREVIEW_IV}">${esc(k)}</button>`).join('')}</div>
                      <span class="ld-ct-r">Market cap · USD</span>
                    </div>
                    <div class="ld-chart" id="ld-chart"><div class="lc-note">Waiting for market data…</div></div>
                  </div>
                  <aside class="ld-live" aria-label="Newest launches">
                    <div class="ld-live-head"><b>Newest launches</b><span class="mono dim" id="ld-rate"></span><span class="ld-paused" id="ld-paused" hidden>Paused</span></div>
                    <div class="ld-live-list" id="ld-cards"></div>
                    <a class="ld-live-foot" href="#/scope"><span>Every launch, live, on Scope</span><span class="ld-arrow">${ARROW}</span></a>
                  </aside>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="ld-sec ld-in ld-promise-sec">
        <div class="ld-promises">
          ${PROMISES.map((p) => `<div class="ld-pr"><span class="ld-pr-ic">${p.icon}</span><b>${esc(p.name)}</b><p>${esc(p.text)}</p></div>`).join('')}
        </div>
      </section>

      <section class="ld-sec ld-in">
        <div class="ld-sec-head"><h2>What a 1% fee would have cost you</h2><p class="ld-sub">Popular terminals take up to about 1% of every trade. Nought takes nothing. Pool, launchpad, network and priority fees exist everywhere, Nought included, and every quote lists them.</p></div>
        <div class="ld-fees" role="table" aria-label="Fee comparison">
          <div class="ld-fr head" role="row"><span role="columnheader">Volume traded</span><span role="columnheader">Paid at 1%</span><span role="columnheader">Paid on Nought</span></div>
          ${VOLUMES.map((v) => `<div class="ld-fr" role="row"><span role="cell" class="mono">${fmtSol(v)} SOL</span><span role="cell" class="mono ld-cost"><b>${fmtSol(v * FEE_RATE)} SOL</b><i data-usd="${v * FEE_RATE}"></i></span><span role="cell" class="mono ld-zero">0 SOL</span></div>`).join('')}
          <div class="ld-fr you" role="row"><span role="cell"><label class="ld-vol"><input id="ld-vol" inputmode="decimal" placeholder="Yours" aria-label="Your trading volume in SOL"><em>SOL</em></label></span><span role="cell" class="mono ld-cost"><b id="ld-you">—</b><i id="ld-you-usd"></i></span><span role="cell" class="mono ld-zero">0 SOL</span></div>
        </div>
      </section>

      <section class="ld-sec ld-in">
        <div class="ld-sec-head"><h2>Everything a terminal needs</h2><p class="ld-sub">Every page reads live data in your browser. Nothing to install, nothing to sign up for.</p></div>
        <div class="ld-feats">
          ${FEATURES.map((f) => `<a class="ld-feat" href="${esc(f.href || ex.href)}"${f.href ? '' : ' data-ex'}><b>${esc(f.name)}</b><span class="ld-ft">${esc(f.text)}</span><span class="ld-fp">${esc(f.href || ex.label)}<span class="ld-arrow">${ARROW}</span></span></a>`).join('')}
        </div>
      </section>

      <section class="ld-sec ld-in">
        <a class="ld-upkeep" href="#/upkeep">
          <div class="ld-uk-copy">
            <h2>How Nought pays for itself</h2>
            <p>Nought is static files: no accounts, no database, no keys, and one small relay that only reads coin pictures and names. What little it costs to run is meant to come from creator rewards on Nought's own pump.fun coin, paid into a public treasury anyone can check. Your trades stay fee-free either way.</p>
            <span class="ld-uk-link">Read the upkeep plan<span class="ld-arrow">${ARROW}</span></span>
          </div>
          <ol class="ld-flow" aria-label="Where the money comes from">
            <li><b>Nought's coin trades</b><span>on pump.fun, like any launch</span></li>
            <li><b>Creator rewards</b><span>pump.fun shares part of its trading fees with the coin's creator</span></li>
            <li><b>Public treasury</b><span>${launched ? 'balance and payments shown live' : 'coin not launched yet'}</span></li>
            <li><b>Hosting and data</b><span>paid from the treasury, never from your trades</span></li>
          </ol>
        </a>
      </section>

      <section class="ld-final">
        <div class="ld-in ld-final-in">
          <div class="ld-final-mark" aria-hidden="true">${MARK}</div>
          <h2>Zero is the whole idea.</h2>
          <p>No sign-up. Connect a wallet, or make one that lives in this browser, and you are trading.</p>
          <a class="btn btn-accent ld-go" href="#/scope">Open the terminal</a>
          <p class="ld-hint">Press <kbd>/</kbd> anywhere to search for a coin.</p>
        </div>
      </section>

      <footer class="ld-foot">
        <div class="ld-in ld-foot-in">
          <div class="ld-foot-brand">${MARK}<span>NOUGHT</span></div>
          <nav class="ld-foot-links" aria-label="Project">
            ${repoLink('GitHub')}
            <a href="https://x.com/Nought0Fees" target="_blank" rel="noopener">X @Nought0Fees</a>
            <span>MIT License</span>
            <a href="#/upkeep">Upkeep and fees</a>
          </nav>
          <p class="ld-risk">Memecoins are extremely risky and most go to zero. Nought is software, not a broker, exchange or adviser: your wallet signs every trade, you can lose everything you put in, and nothing here is financial advice.</p>
        </div>
      </footer>
    </div>`;

    const root = $('.ld', view), listEl = $('#ld-cards', root);
    let hovered = false, onList = [];

    // ---- live numbers ----
    function stats() {
      $('#ld-coins', root).textContent = tokens.size.toLocaleString('en-US');
      const n = $('#ld-launches', root), mins = Math.max(1, Math.round((Date.now() - bootAt) / 60e3)), k = seen();
      n.textContent = k.toLocaleString('en-US'); n.parentElement.hidden = !k;
      n.title = `${k} new coins seen in about ${mins} minute${mins === 1 ? '' : 's'}`;
      $('#ld-sol', root).textContent = solUsd() > 0 ? '$' + solUsd().toFixed(2) : '—';
      const r = perMin();
      $('#ld-rate', root).textContent = r ? `${r} in the last minute` : '';
    }
    function you() {
      const v = parseTarget($('#ld-vol', root).value); // "2,5" is 2.5 and "1.2k" is 1200, never 25; unclear text shows —
      const ok = v > 0 && v < 1e9;
      $('#ld-you', root).textContent = ok ? fmtSol(v * FEE_RATE) + ' SOL' : '—';
      $('#ld-you-usd', root).textContent = ok ? solUsdTxt(v * FEE_RATE) : '';
    }
    function prices() {
      $$('[data-usd]', root).forEach((el) => { el.textContent = solUsdTxt(Number(el.dataset.usd)); });
      you();
    }

    // ---- newest launches (held still while the pointer is on the list, so a card can be clicked) ----
    function cards() {
      if (hovered) return;
      const list = all().filter((t) => !t.migrated && t.created > 0 && shown(t)).sort((a, b) => b.created - a.created).slice(0, 8);
      if (!list.length) { listEl.innerHTML = '<div class="empty"><span class="pulse-dot"></span><span>Waiting for the next launch…</span></div>'; onList = []; return; }
      const before = new Set(onList);
      listEl.innerHTML = list.map((t) => `<div class="ld-c${onList.length && !before.has(t.mint) ? ' in' : ''}">${cardHtml(t, { compact: true })}</div>`).join('');
      onList = list.map((t) => t.mint);
    }
    listEl.addEventListener('mouseenter', () => { hovered = true; $('#ld-paused', root).hidden = false; });
    listEl.addEventListener('mouseleave', () => { hovered = false; $('#ld-paused', root).hidden = true; cards(); });
    $('#ld-vol', root).addEventListener('input', you);

    // ---- the preview's coin: the busiest coin we know once the feeds have filled the store (or after 4 s), kept for
    // this visit. A coin Jupiter has no chart for is skipped for the next one, at most 3 in a row (a chart that loads
    // resets the count); a busy data host keeps the same coin and the chart retries it ----
    const P = { mint: null, skip: new Set(), tries: 0, chart: null, iv: PREVIEW_IV, t0: Date.now() };
    const coinEl = $('#ld-coin', root), dataEl = $('#ld-coin-data', root), tradeEl = $('#ld-trade', root), chartEl = $('#ld-chart', root);
    function pickCoin(force = false) {
      if (P.mint && !force) return;
      const t = busiest(P.skip);
      if (!t || (!force && tokens.size < 40 && Date.now() - P.t0 < 4000)) return;
      P.mint = t.mint; P.chart?.destroy();
      P.chart = mountPreviewChart(chartEl, t.mint, { sym: symOf(t), iv: P.iv, onOk: () => { P.tries = 0; }, onFail: () => { P.skip.add(t.mint); if (++P.tries < 3 && busiest(P.skip)) pickCoin(true); } });
      const lp = lpInfo(t.launchpad);
      coinEl.innerHTML = `<a class="ld-coin-id" href="#/t/${esc(t.mint)}" title="Open ${esc(symOf(t))}${lp ? ' · ' + esc(lp.label) : ''}"${lp ? ` style="--lp:${esc(lp.color)}"` : ''}>${avatar(t, 'sm')}<span class="ld-coin-nm"><b>${esc(symOf(t))}</b><span>${esc(t.name || '')}</span></span></a>`;
      tradeEl.href = '#/t/' + t.mint; tradeEl.textContent = 'Trade ' + symOf(t); tradeEl.hidden = false;
      coinNums(); example();
    }
    // the header numbers: market cap (coloured by size, as on Pulse), liquidity, volume, holders, then price changes
    function coinNums() {
      const t = P.mint && tokens.get(P.mint); if (!t) return;
      const mc = mcUsd(t), tier = mc >= 1e5 ? 'hi' : mc >= 3e4 ? 'mid' : 'lo';
      const cells = [['Market cap', mc > 0 ? money(mc) : '', 'mc ' + tier], ['Liquidity', t.liquidity > 0 ? money(t.liquidity) : ''], ['24h volume', t.volume24h > 0 ? money(t.volume24h) : ''], ['Holders', t.holders > 0 ? Number(t.holders).toLocaleString('en-US') : '']].filter((c) => c[1]);
      // rounded before the colour is picked, so a change of -0.04% reads as a grey 0.0%, not a red -0.0%
      const ch = [['5m', t.stats5m?.priceChange], ['1h', t.stats1h?.priceChange], ['24h', t.stats24h?.priceChange]].filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, Number(v.toFixed(Math.abs(v) >= 99.5 ? 0 : 1)) || 0]);
      dataEl.innerHTML = cells.map(([k, v, c = '']) => `<div class="ld-cd ${esc(c)}"><b class="mono">${esc(v)}</b><span>${esc(k)}</span></div>`).join('')
        + (ch.length ? `<div class="ld-chg">${ch.map(([k, v]) => `<span class="stat-pill ${v > 0 ? 'up' : v < 0 ? 'down' : ''}"><em>${esc(k)}</em>${esc((v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 100 ? 0 : 1) + '%')}</span>`).join('')}</div>` : '');
    }
    $('.ld-ivs', root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-iv]'); if (!b) return;
      P.iv = b.dataset.iv; $$('[data-iv]', root).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      P.chart?.setIv(P.iv);
    });

    // the "Token pages" example is the preview's coin once one is picked (until then the busiest coin we know)
    function example() {
      const p = P.mint && tokens.get(P.mint), e = p ? { href: '#/t/' + p.mint, label: '#/t/' + symOf(p) } : exampleCoin();
      const a = $('[data-ex]', root); if (!a || a.getAttribute('href') === e.href) return;
      a.setAttribute('href', e.href); $('.ld-fp', a).firstChild.textContent = e.label;
    }

    // store updates arrive ~3 times a second: redraw the cards at most once a second (a new launch redraws at once)
    let soon = 0;
    const later = () => { if (!soon) soon = setTimeout(() => { soon = 0; stats(); cards(); example(); pickCoin(); coinNums(); }, 1000); };

    stats(); prices(); cards(); pickCoin();
    const tick = setInterval(stats, 5000); // the per-minute rate decays even when nothing new arrives
    const wait = setTimeout(pickCoin, 4200);
    const offs = [
      on('tokens', later),
      on('new-token', () => { stats(); cards(); }),
      on('sol', () => { stats(); prices(); coinNums(); }),
    ];
    return () => { clearInterval(tick); clearTimeout(soon); clearTimeout(wait); P.chart?.destroy(); offs.forEach((f) => f()); };
  },
});
