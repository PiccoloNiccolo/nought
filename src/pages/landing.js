// Landing (#/): what Nought is, with live proof pulled from the store and the launch stream: coins tracked, launches
// seen since the app loaded, the newest launches as mini cards, the SOL price, and what a 1% fee would have cost.
import { $, $$, esc, on, usd, isMint, safeUrl, parseTarget } from '../core/util.js';
import { tokens, all } from '../core/store.js';
import { solUsd } from '../core/price.js';
import { register } from '../core/router.js';
import { cardHtml } from '../ui/card.js';
import { UPKEEP } from './upkeep.js';

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
const perMin = () => { trim(Date.now()); return recent.length; };

const FEE_RATE = 0.01; // the comparison: a typical 1% terminal fee
const VOLUMES = [10, 100, 1000];
const fmtSol = (n) => (n >= 1 ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 }) : String(Number(n.toPrecision(3))));
const solUsdTxt = (s) => (solUsd() > 0 ? '≈ ' + usd(s * solUsd(), 1) : '');

const MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="3.2"/><path d="M6.2 17.8 17.8 6.2" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round"/></svg>';

const FEATURES = [
  { href: '#/pulse', name: 'Pulse', text: 'Three live columns: fresh launches, coins near the end of their bonding curve, and coins that just migrated. Buy from any card in one click.' },
  { href: '#/discover', name: 'Discover', text: 'What is trending, surging or trading most from the last 5 minutes to the last day, with organic-volume scores and Dexscreener boosts.' },
  { href: null, name: 'Token pages', text: 'Market-cap chart, live trades, holders and an audit grid beside a trade panel that lists every third-party fee before you sign.' },
  { href: '#/track', name: 'Trackers', text: 'Follow the wallets you care about and see their buys and sells as they land.' },
  { href: '#/portfolio', name: 'Portfolio', text: 'Holdings, cost basis and profit from your own trade log, kept in this browser.' },
  { href: '#/perps', name: 'Perps', text: 'Hyperliquid markets with a chart, order book and your positions on one screen.' },
];

// a coin worth opening as the "token pages" example: the busiest coin we know, else Pulse
function exampleCoin() {
  let best = null;
  for (const t of tokens.values()) if (isMint(t.mint) && t.symbol && (t.volume24h || 0) > (best?.volume24h || 0)) best = t;
  if (!best) return { href: '#/pulse', label: '#/t/…' };
  const sym = String(best.symbol).replace(/^\$/, '').slice(0, 12);
  return { href: '#/t/' + best.mint, label: '#/t/$' + sym };
}

register({
  id: 'landing', tab: 'landing', path: '#/', title: 'Nought · the zero-fee memecoin terminal',
  mount(view) {
    const ex = exampleCoin(), launched = isMint(UPKEEP.coinMint);
    view.innerHTML = `<div class="page ld">
      <section class="ld-hero">
        <div class="ld-grid" aria-hidden="true"></div>
        <div class="ld-mark" aria-hidden="true">${MARK}</div>
        <div class="ld-in ld-hero-in">
          <div class="ld-copy">
            <p class="ld-kicker"><span class="ld-dot"></span>Open source · MIT · Solana</p>
            <h1>The memecoin terminal that costs <em>nothing</em> to use.</h1>
            <p class="ld-lede">Watch pump.fun launches land, read the chart, buy in one click. Nought adds no fee to any trade, asks for no account, and all of its code is public.</p>
            <div class="ld-cta">
              <a class="btn btn-accent ld-go" href="#/pulse">Open the terminal <span aria-hidden="true">→</span></a>
              <a class="btn ld-ghost" href="#/upkeep">How it stays free</a>
            </div>
            <dl class="ld-proof">
              <div><dt>Coins tracked now</dt><dd class="mono" id="ld-coins">—</dd></div>
              <div><dt>New launches seen</dt><dd class="mono" id="ld-launches">0</dd></div>
              <div><dt>SOL price</dt><dd class="mono" id="ld-sol">—</dd></div>
              <div class="zero"><dt>Nought fee</dt><dd class="mono">0%</dd></div>
            </dl>
          </div>
          <aside class="ld-live" aria-label="Newest launches">
            <div class="ld-live-head"><span class="ld-dot live"></span><b>Newest launches</b><span class="mono dim" id="ld-rate"></span><span class="ld-paused" id="ld-paused" hidden>Paused</span></div>
            <div class="ld-live-list" id="ld-cards"></div>
            <a class="ld-live-foot" href="#/pulse"><span>Every launch, live, on Pulse</span><span class="mono">#/pulse →</span></a>
          </aside>
        </div>
      </section>

      <section class="ld-sec ld-in">
        <div class="ld-sec-head"><span class="ld-idx mono">01</span><h2>What a 1% fee would have cost you</h2></div>
        <p class="ld-sub">Popular terminals take up to about 1% of every trade. Nought takes nothing. Pool, launchpad, network and priority fees exist everywhere, Nought included, and every quote lists them.</p>
        <div class="ld-fees" role="table" aria-label="Fee comparison">
          <div class="ld-fr head" role="row"><span role="columnheader">Volume traded</span><span role="columnheader">Paid at 1%</span><span role="columnheader">Paid on Nought</span></div>
          ${VOLUMES.map((v) => `<div class="ld-fr" role="row"><span role="cell" class="mono">${fmtSol(v)} SOL</span><span role="cell" class="mono ld-cost"><b>${fmtSol(v * FEE_RATE)} SOL</b><i data-usd="${v * FEE_RATE}"></i></span><span role="cell" class="mono ld-zero">0 SOL</span></div>`).join('')}
          <div class="ld-fr you" role="row"><span role="cell"><label class="ld-vol"><input id="ld-vol" inputmode="decimal" placeholder="Yours" aria-label="Your trading volume in SOL"><em>SOL</em></label></span><span role="cell" class="mono ld-cost"><b id="ld-you">—</b><i id="ld-you-usd"></i></span><span role="cell" class="mono ld-zero">0 SOL</span></div>
        </div>
      </section>

      <section class="ld-sec ld-in">
        <div class="ld-sec-head"><span class="ld-idx mono">02</span><h2>Everything a terminal needs</h2></div>
        <div class="ld-feats">
          ${FEATURES.map((f, i) => `<a class="ld-feat" href="${esc(f.href || ex.href)}"${f.href ? '' : ' data-ex'}><span class="ld-fi mono">${String(i + 1).padStart(2, '0')}</span><b>${esc(f.name)}</b><span class="ld-ft">${esc(f.text)}</span><span class="ld-fp mono">${esc(f.href || ex.label)} →</span></a>`).join('')}
        </div>
      </section>

      <section class="ld-sec ld-in">
        <a class="ld-upkeep" href="#/upkeep">
          <div class="ld-uk-copy">
            <div class="ld-sec-head"><span class="ld-idx mono">03</span><h2>How Nought pays for itself</h2></div>
            <p>Nought is static files: no servers, no database, no keys. What little it costs to run is meant to come from creator rewards on Nought's own pump.fun coin, paid into a public treasury anyone can check. Your trades stay fee-free either way.</p>
            <span class="ld-uk-link">Read the upkeep plan →</span>
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
          <a class="btn btn-accent ld-go big" href="#/pulse">Open the terminal <span aria-hidden="true">→</span></a>
          <p class="ld-hint">Press <kbd>/</kbd> anywhere to search for a coin.</p>
        </div>
      </section>

      <footer class="ld-foot">
        <div class="ld-in ld-foot-in">
          <div class="ld-foot-brand">${MARK}<span>nought</span></div>
          <nav class="ld-foot-links" aria-label="Project">
            ${repoLink('GitHub')}
            <span>MIT License</span>
            <a href="#/upkeep">Upkeep and fees</a>
            <a href="#/yield">Yield</a>
          </nav>
          <p class="ld-risk">Memecoins are extremely risky and most go to zero. Nought is software, not a broker, exchange or adviser: your wallet signs every trade, you can lose everything you put in, and nothing here is financial advice.</p>
        </div>
      </footer>
    </div>`;

    const root = $('.ld', view), listEl = $('#ld-cards', root);
    let hovered = false, shown = [];

    // ---- live numbers ----
    function stats() {
      $('#ld-coins', root).textContent = tokens.size.toLocaleString('en-US');
      const n = $('#ld-launches', root), mins = Math.max(1, Math.round((Date.now() - bootAt) / 60e3));
      n.textContent = launches.toLocaleString('en-US');
      n.title = `${launches} new coins seen on the launch stream in about ${mins} minute${mins === 1 ? '' : 's'}`;
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
      const list = all().filter((t) => !t.migrated && t.created > 0).sort((a, b) => b.created - a.created).slice(0, 8);
      if (!list.length) { listEl.innerHTML = '<div class="empty"><span class="pulse-dot"></span><span>Waiting for the next launch…</span></div>'; shown = []; return; }
      const before = new Set(shown);
      listEl.innerHTML = list.map((t) => `<div class="ld-c${shown.length && !before.has(t.mint) ? ' in' : ''}">${cardHtml(t, { compact: true })}</div>`).join('');
      shown = list.map((t) => t.mint);
    }
    listEl.addEventListener('mouseenter', () => { hovered = true; $('#ld-paused', root).hidden = false; });
    listEl.addEventListener('mouseleave', () => { hovered = false; $('#ld-paused', root).hidden = true; cards(); });
    $('#ld-vol', root).addEventListener('input', you);

    // the "Token pages" example follows the busiest coin once the feed has filled the store
    function example() {
      const a = $('[data-ex]', root), e = exampleCoin(); if (!a || a.getAttribute('href') === e.href) return;
      a.setAttribute('href', e.href); $('.ld-fp', a).textContent = e.label + ' →';
    }

    // store updates arrive ~3 times a second: redraw the cards at most once a second (a new launch redraws at once)
    let soon = 0;
    const later = () => { if (!soon) soon = setTimeout(() => { soon = 0; stats(); cards(); example(); }, 1000); };

    stats(); prices(); cards();
    const tick = setInterval(stats, 5000); // the per-minute rate decays even when nothing new arrives
    const offs = [
      on('tokens', later),
      on('new-token', () => { stats(); cards(); }),
      on('sol', () => { stats(); prices(); }),
    ];
    return () => { clearInterval(tick); clearTimeout(soon); offs.forEach((f) => f()); };
  },
});
