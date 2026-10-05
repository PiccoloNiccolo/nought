// Upkeep (#/upkeep): the zero-fee policy, how creator rewards from Nought's own coin are meant to pay for hosting and
// data, your personal "fees saved", where the data comes from, how to self-host, and the risk notice.
//
// UPKEEP: fill these in when Nought's coin launches. Both are plain Solana addresses (base58).
//   coinMint  the coin's mint: the page shows its market cap (Jupiter tokens search) and links to its token page
//   treasury  the wallet that receives the creator rewards: the page shows its SOL balance and recent transactions
// While they are empty the page says "not launched yet" and makes no treasury requests.
export const UPKEEP = { coinMint: '', treasury: '' };

import { $, $$, esc, on, usd, ago, short, isMint, safeUrl, ICON } from '../core/util.js';
import { PRIO } from '../core/settings.js';
import { solUsd } from '../core/price.js';
import { jt, ju } from '../core/jup.js';
import { signaturesFor, solBalance, endpoints } from '../core/rpc.js';
import { feesSaved, FEE_REF } from '../core/trade.js';
import { wallet } from '../core/wallet.js';
import { state as stream } from '../core/stream.js';
import { feed } from '../core/seed.js';
import { register } from '../core/router.js';

// the repository link: index.html's <meta name="nought:repo">, or a placeholder until the code is published
const repoLink = (label, cls = '') => {
  const u = safeUrl(document.querySelector('meta[name="nought:repo"]')?.content || '');
  return u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener">${label}</a>` : `<a class="${cls}" href="#" title="The repository link goes here once the code is published">${label}</a>`;
};

const isSig = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
const solscan = (kind, id) => `https://solscan.io/${kind}/${encodeURIComponent(id)}`;
// SOL figures: exactly 0 is "0", dust is "<0.0001", the rest keeps up to 4 decimals without trailing zeros
const sol4 = (n) => (n == null || !isFinite(n) ? '—' : n === 0 ? '0' : Math.abs(n) < 1e-4 ? '<0.0001' : n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(Number(n.toFixed(n >= 1 ? 3 : 4))));
const prioText = Object.values(PRIO).map((p) => `${p.label} ≤${p.max}`).join(' · ');

// third-party costs, in the order a trade meets them
const COSTS = [
  ['Nought', 'Platform fee on any trade, order or transfer', 'Nobody', '<b class="up">0%</b>', 'us'],
  ['Launchpad and pool', 'The trading fee of the bonding curve or pool your trade goes through (pump.fun, PumpSwap, Raydium, Meteora…)', 'The launchpad, liquidity providers and the coin\'s creator', 'Inside the quoted price'],
  ['Solana network', 'Base fee for each signature on the transaction', 'Validators', '0.000005 SOL'],
  ['Priority fee', 'Optional fee for faster inclusion, set in each preset', 'Validators', `at most ${esc(prioText)} SOL`],
  ['Jupiter Ultra', 'Only when a preset turns on MEV protection: Jupiter lands the trade and charges its own fee', 'Jupiter', 'Set per trade by Jupiter, shown on the quote (0.1% on memecoins when last checked)'],
  ['Token account rent', 'A deposit the first time your wallet holds a coin', 'Refundable deposit', 'About 0.002 SOL, returned when the account is closed'],
];

// where the data comes from, and what each source powers
const SOURCES = [
  ['pp', 'PumpPortal', 'pumpportal.fun (websocket)', 'New pump.fun and LaunchLab launches and migrations the moment they happen'],
  ['jg', 'Jupiter data', 'datapi.jup.ag', 'The Pulse columns, live trades, holders and charts'],
  ['', 'Jupiter tokens and prices', 'lite-api.jup.ag', 'Search, coin facts and audits, prices, wallet balances, safety warnings'],
  ['', 'Jupiter swap and Ultra', 'lite-api.jup.ag · api.jup.ag', 'Quotes and the trade transactions your wallet signs'],
  ['', 'Jupiter Trigger', 'api.jup.ag', 'Limit orders'],
  ['', 'Dexscreener', 'api.dexscreener.com', 'Pairs and liquidity, boosts, paid profiles'],
  ['rpc', 'Solana RPC', 'publicnode · solanatracker · vibestation, or yours', 'Balance fallback, sending local-wallet trades, confirmations, the treasury feed'],
  ['', 'GeckoTerminal', 'api.geckoterminal.com', 'A slow fallback board if Jupiter stops answering'],
  ['', 'Hyperliquid', 'api.hyperliquid.xyz', 'Perps markets, order book and positions'],
  ['', 'Jito · Marinade · Kamino · Jupiter Lend', 'their public APIs', 'Staking and lending rates on the Yield page'],
  ['', 'IPFS gateways', 'pump.mypinata.cloud · gateway.pinata.cloud', 'Coin images and metadata'],
];

register({
  id: 'upkeep', tab: 'upkeep', path: '#/upkeep', title: 'Upkeep · Nought',
  mount(view) {
    const hasCoin = isMint(UPKEEP.coinMint), hasTreasury = isMint(UPKEEP.treasury), configured = hasCoin || hasTreasury;
    const badConfig = (UPKEEP.coinMint && !hasCoin) || (UPKEEP.treasury && !hasTreasury);
    view.innerHTML = `<div class="page uk"><div class="uk-in">
      <header class="uk-head">
        <p class="uk-kicker mono">#/upkeep</p>
        <h1>Nought charges <em>0%</em>. This is how it keeps running.</h1>
        <p class="uk-lede">No platform fee, no referral cut, no hidden spread. The app is static files that run in your browser, so there is almost nothing to pay for, and what there is should come from Nought's own coin, not from your trades.</p>
        <nav class="uk-toc" aria-label="On this page">
          <button data-go="uk-policy">Fee policy</button><button data-go="uk-saved">Fees you kept</button><button data-go="uk-rewards">Creator rewards</button><button data-go="uk-sources">Data sources</button><button data-go="uk-oss">Self-host</button><button data-go="uk-risk">Risk</button>
        </nav>
      </header>

      <div class="uk-row">
        <section class="uk-panel" id="uk-policy">
          <div class="uk-ph"><h2>The zero-fee policy</h2><span class="uk-pill ok">Nought fee 0%</span></div>
          <p class="uk-p">Nought never adds a platform fee, fee account, referral or builder code to a Jupiter, Trigger or Hyperliquid request. What you still pay goes to other parties, and every quote lists it before you sign:</p>
          <div class="uk-scroll"><table class="uk-table">
            <thead><tr><th>Who</th><th>What for</th><th>Paid to</th><th>How much</th></tr></thead>
            <tbody>${COSTS.map(([who, what, to, amt, us]) => `<tr class="${us || ''}"><td data-label="Who"><b>${who}</b></td><td data-label="What for">${what}</td><td data-label="Paid to">${to}</td><td class="uk-amt" data-label="How much">${amt}</td></tr>`).join('')}</tbody>
          </table></div>
        </section>

        <section class="uk-panel uk-saved" id="uk-saved">
          <div class="uk-ph"><h2>Fees you kept</h2><span class="uk-pill mono" id="uk-saved-who">this browser</span></div>
          <div id="uk-saved-body"></div>
        </section>
      </div>

      <section class="uk-panel" id="uk-rewards">
        <div class="uk-ph"><h2>Creator rewards pay the bills</h2><span class="uk-pill ${configured && !badConfig ? 'ok' : 'warn'}">${badConfig ? 'Config error' : configured ? 'Live' : 'Not launched yet'}</span></div>
        <div class="uk-rw">
          <div class="uk-rw-copy">
            <p class="uk-p">Nought will launch one coin on pump.fun. pump.fun shares part of the fees on a coin's trades with that coin's creator. Nought's creator wallet is its treasury, and the treasury pays the running costs. Nobody has to buy the coin: the terminal is free whether it exists or not.</p>
            <ol class="uk-flow">
              <li><b>The coin trades</b><span>on pump.fun, like any launch</span></li>
              <li><b>Creator rewards accrue</b><span>a share of those trading fees</span></li>
              <li><b>Public treasury</b><span>anyone can check its balance and history</span></li>
              <li><b>Running costs</b><span>domain, static hosting, a private RPC if public ones cannot keep up</span></li>
            </ol>
          </div>
          <div class="uk-live" id="uk-live" aria-live="polite"></div>
        </div>
      </section>

      <section class="uk-panel" id="uk-sources">
        <div class="uk-ph"><h2>Data sources</h2><span class="uk-pill">all free, keyless, called from your browser</span></div>
        <div class="uk-scroll"><table class="uk-table uk-src">
          <thead><tr><th>Source</th><th>Host</th><th>Powers</th><th>Status</th></tr></thead>
          <tbody>${SOURCES.map(([k, name, host, what]) => `<tr><td data-label="Source"><b>${esc(name)}</b></td><td class="mono dim" data-label="Host">${esc(host)}</td><td data-label="Powers">${esc(what)}</td><td class="uk-st" data-src="${k}" data-label="Status"><span class="muted">on demand</span></td></tr>`).join('')}</tbody>
        </table></div>
      </section>

      <div class="uk-row even">
        <section class="uk-panel" id="uk-oss">
          <div class="uk-ph"><h2>Open source, MIT</h2>${repoLink('GitHub ↗', 'uk-pill link')}</div>
          <p class="uk-p">Read it, fork it, run your own copy. There is no build step, no server, no environment variable and no API key.</p>
          <ol class="uk-steps">
            <li><b>Get the code</b><span>Download or clone the repository.</span></li>
            <li><b>Serve the folder</b><span>Any static host works: Netlify, Cloudflare Pages, GitHub Pages, Vercel, an S3 bucket. Locally:</span><code class="mono">python3 -m http.server 8080</code></li>
            <li><b>Use https</b><span>Local wallets encrypt keys with the browser's WebCrypto, which needs https or localhost.</span></li>
            <li><b>Bring your own RPC (optional)</b><span>Settings → RPC address. It stays in your browser.</span></li>
          </ol>
        </section>

        <section class="uk-panel uk-risk" id="uk-risk">
          <div class="uk-ph"><h2>Risk notice</h2><span class="uk-pill warn">read this</span></div>
          <ul class="uk-list">
            <li>Memecoins are extremely risky. Most lose almost all of their value, often within hours.</li>
            <li>Nought is software, not a broker, exchange or adviser. It never holds your funds and nothing on it is financial advice.</li>
            <li>Your wallet signs every trade. Local wallets keep keys encrypted in this browser: if you lose the passphrase or clear site data without a backup, the funds are gone.</li>
            <li>Data comes from third parties and can be late, wrong or missing. Check before you trade.</li>
            <li>Nought's own coin, if launched, is a memecoin too. Buying it does not buy a share of anything.</li>
          </ul>
        </section>
      </div>
    </div></div>`;

    const root = $('.uk', view);
    let alive = true;

    // section jump buttons (the hash is the route, so no #anchors)
    $$('[data-go]', root).forEach((b) => b.addEventListener('click', () => $('#' + b.dataset.go, root)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));

    // ---- fees you kept (trade log in this browser, filtered to the active wallet) ----
    function saved() {
      const owner = wallet.owner || null, s = feesSaved(owner || undefined), su = solUsd();
      $('#uk-saved-who', root).textContent = owner ? short(owner) : 'this browser';
      const usdNow = s.usd > 0 ? s.usd : su > 0 ? s.sol * su : 0;
      $('#uk-saved-body', root).innerHTML = `
        <div class="uk-big${s.sol > 0 ? '' : ' uk-nil'}"><b class="mono">${sol4(s.sol)}</b><span>SOL</span></div>
        <p class="uk-big-sub ${s.sol > 0 ? 'mono' : 'uk-zero'}">${s.sol > 0 ? `≈ ${usd(usdNow, 2)} not paid in fees` : `Make a trade, and what a ${(FEE_REF * 100).toFixed(0)}% fee would have cost shows here.`}</p>
        <dl class="uk-kv">
          <div><dt>Trades counted</dt><dd class="mono">${s.trades}</dd></div>
          <div><dt>Compared with</dt><dd class="mono">${(s.rate * 100).toFixed(0)}% of each trade</dd></div>
          <div><dt>Wallet</dt><dd class="mono">${owner ? esc(short(owner)) : 'all in this browser'}</dd></div>
        </dl>
        ${s.trades ? `<p class="uk-note">What a ${(FEE_REF * 100).toFixed(0)}% terminal fee would have taken from the SOL side of every trade you made through Nought${owner ? ' with this wallet' : ''}. It is worked out from the trade log kept in this browser.</p>` : `<p class="uk-note">Counted from the trade log kept in this browser${owner ? ', for this wallet' : ''}.</p>`}`;
    }

    // ---- creator rewards: the coin and the treasury, once configured ----
    function liveShell() {
      const el = $('#uk-live', root);
      if (badConfig) { el.innerHTML = '<div class="uk-empty"><b>The upkeep config has an invalid address.</b><span>Check UPKEEP.coinMint and UPKEEP.treasury in src/pages/upkeep.js.</span></div>'; return; }
      if (!configured) {
        el.innerHTML = `<div class="uk-empty"><span class="uk-ring" aria-hidden="true"></span><b>Not launched yet</b><span>When the coin launches, its address and the treasury address go into this page's config. This panel then shows the treasury balance and every transaction, live.</span></div>`;
        return;
      }
      el.innerHTML = `<div class="uk-cells">
          <div class="uk-cell" id="uk-coin"><span class="uk-cl">Nought's coin</span>${hasCoin ? '<b class="mono muted">Loading…</b>' : '<b class="muted">Not launched yet</b>'}</div>
          <div class="uk-cell" id="uk-bal"><span class="uk-cl">Treasury balance</span>${hasTreasury ? '<b class="mono muted">Loading…</b>' : '<b class="muted">No treasury yet</b>'}</div>
        </div>
        ${hasTreasury ? `<div class="uk-addr"><span class="uk-cl">Treasury</span><a class="mono" href="${esc(solscan('account', UPKEEP.treasury))}" target="_blank" rel="noopener">${esc(short(UPKEEP.treasury, 6))} ↗</a><button class="copy" data-copy="${esc(UPKEEP.treasury)}" title="Copy address">${ICON.copy}</button></div>
        <div class="uk-sigs"><div class="uk-sigs-h"><span>Recent treasury transactions</span><span class="dim mono" id="uk-sigs-at"></span></div><div id="uk-sigs"><div class="uk-loading">Loading…</div></div></div>` : ''}`;
    }
    // a failed refresh keeps the last good figures on screen and only marks them as stale
    let loading = false, lastLoad = 0;
    const got = { coin: false, bal: false, sigs: false };
    const stale = (el) => { if (el && !el.querySelector('.uk-stale')) el.insertAdjacentHTML('beforeend', '<small class="uk-stale">Refresh failed. Retrying in a minute.</small>'); };
    async function loadLive() {
      if (!configured || badConfig || loading || document.hidden) return;
      loading = true; lastLoad = Date.now();
      const [coin, bal, sigs] = await Promise.allSettled([
        hasCoin ? jt.search([UPKEEP.coinMint]).then((l) => l.find((t) => t.mint === UPKEEP.coinMint) || null) : null,
        hasTreasury ? ju.balances(UPKEEP.treasury).then((b) => b.sol).catch(() => solBalance(UPKEEP.treasury)) : null,
        hasTreasury ? signaturesFor(UPKEEP.treasury, 12) : null,
      ]);
      loading = false;
      if (!alive) return;
      if (hasCoin && coin.status === 'rejected' && got.coin) stale($('#uk-coin', root));
      else if (hasCoin) {
        const c = $('#uk-coin', root), t = coin.value; got.coin ||= coin.status === 'fulfilled' && !!t;
        c.innerHTML = '<span class="uk-cl">Nought\'s coin</span>' + (coin.status === 'rejected' ? '<b class="down">Could not load</b><small>Jupiter did not answer. Retrying in a minute.</small>'
          : !t ? '<b class="muted">Not indexed yet</b><small>Jupiter does not list this mint yet.</small>'
          : `<b class="mono">${usd(t.mcUsd)}</b><small><a href="#/t/${esc(t.mint)}">${esc(t.symbol ? '$' + String(t.symbol).replace(/^\$/, '') : short(t.mint))}</a> market cap${t.holders ? ` · ${Number(t.holders).toLocaleString('en-US')} holders` : ''}</small>`);
      }
      if (hasTreasury) {
        const b = $('#uk-bal', root), s = bal.value, balOk = bal.status === 'fulfilled' && s != null;
        if (!balOk && got.bal) stale(b);
        else b.innerHTML = '<span class="uk-cl">Treasury balance</span>' + (!balOk ? '<b class="down">Could not load</b><small>Balance lookups failed. Retrying in a minute.</small>'
          : `<b class="mono">${sol4(s)} SOL</b><small>${solUsd() > 0 ? '≈ ' + usd(s * solUsd(), 2) : ''}</small>`);
        got.bal ||= balOk;
        const list = $('#uk-sigs', root);
        if (sigs.status === 'rejected' && got.sigs) $('#uk-sigs-at', root).textContent = 'refresh failed, retrying';
        else if (sigs.status === 'rejected') list.innerHTML = `<div class="uk-loading down">Could not load transactions (${esc(sigs.reason?.message || 'RPC error')}). Retrying in a minute.</div>`;
        else {
          const rows = (Array.isArray(sigs.value) ? sigs.value : []).filter((x) => isSig(x?.signature)); got.sigs = true;
          list.innerHTML = rows.length ? rows.map((x) => `<a class="uk-sig" href="${esc(solscan('tx', x.signature))}" target="_blank" rel="noopener"><span class="mono">${esc(short(x.signature, 6))}</span><span class="${x.err ? 'down' : 'up'}">${x.err ? 'failed' : 'ok'}</span><span class="dim mono">${x.blockTime ? ago(x.blockTime * 1000) + ' ago' : '—'}</span><span class="dim">↗</span></a>`).join('')
            : '<div class="uk-loading">No transactions yet.</div>';
          $('#uk-sigs-at', root).textContent = 'updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
      }
    }

    // ---- live status of the sources Nought holds open ----
    function sources() {
      const now = Date.now(), set = (k, html) => { const el = $(`[data-src="${k}"]`, root); if (el) el.innerHTML = html; };
      const sock = stream.ok && now - stream.lastMsg < 60e3;
      set('pp', sock ? '<span class="uk-on">live</span>' : stream.ok ? '<span class="muted">connected</span>' : '<span class="down">reconnecting</span>');
      const g = feed.lastGems && now - feed.lastGems < 20e3;
      set('jg', g ? '<span class="uk-on">live</span>' : feed.fails ? `<span class="down">${feed.source === 'geckoterminal' ? 'fallback' : 'retrying'}</span>` : '<span class="muted">idle</span>');
      const custom = endpoints()[0] && !/publicnode|solanatracker|solanavibestation/.test(endpoints()[0]);
      set('rpc', `<span class="muted">${custom ? 'your RPC first' : 'public RPCs'}</span>`);
    }

    saved(); liveShell(); sources(); loadLive();
    const timers = [setInterval(() => { if (!document.hidden) loadLive(); }, 60e3), setInterval(() => { if (!document.hidden) sources(); }, 5000)];
    const onVis = () => { if (!document.hidden) { sources(); if (Date.now() - lastLoad > 30e3) loadLive(); } };
    document.addEventListener('visibilitychange', onVis);
    const offs = [on('wallet', saved), on('traded', saved), on('sol', saved)];
    return () => { alive = false; timers.forEach(clearInterval); document.removeEventListener('visibilitychange', onVis); offs.forEach((f) => f()); };
  },
});
