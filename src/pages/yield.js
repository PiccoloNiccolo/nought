// Yield (#/yield): liquid staking through Jupiter swaps (stake = SOL → LST, unstake = LST → SOL), with each LST's
// price in SOL, an APY where a free public source exists, and link-out cards for lending sites.
// Trades go through trade.js (Nought fee 0%); the quote, every third-party fee and the destination (your own wallet)
// are shown before the button that asks your wallet to sign.
import { $, $$, esc, on, usd, short, isMint, safeUrl, LS, toast, getJson, queued, parseAmount } from '../core/util.js';
import { preset, PRIO } from '../core/settings.js';
import { jt, jp, ju } from '../core/jup.js';
import { SOL_MINT, quoteFor, quoteDetails, impactWarning, trade, jfetch, confirm, txLink } from '../core/trade.js';
import { wallet, needWallet, toRaw } from '../core/wallet.js';
import { solUsd } from '../core/price.js';
import { register } from '../core/router.js';

// Well-known liquid staking tokens. Every mint was checked against Jupiter's 'lst' tag on 2026-10-04 and is checked
// again on each visit: a row only appears if Jupiter's token search still returns that mint tagged 'lst'.
// These stay on top and are the fallback; when core's jt.tag('lst') is available, every other LST Jupiter tags
// is listed underneath, largest first (TAG_FIRST at once, the rest behind a "Show more" button).
const CANDIDATES = [
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', // JupSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', // INF
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  'BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85', // BNSOL
  'Dso1bDeDjCQxTrWHqUUi63oBvV7Mdm6WaobLbQ7gnPQ', // dSOL
  'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', // hSOL
  'pSo1f9nQXWgXibFtKf7NWYxb5enAM4qfP6UJSiXRQfL', // PSOL
  'vSoLxydx6akxyMD9XEcPvGYNGq6Nn66oqVb3UkGkei7', // vSOL
  'BonK1YhkXEGLZzwtcvRTip3gAL9nCeQD7ppZBLXhtTs', // bonkSOL
  '7Q2afV64in6N6SeZsAAB81TJzwDoD6zpqmHkzi9Dcavn', // JSOL
];
const isLst = (t) => Array.isArray(t?.tags) && t.tags.includes('lst');
const TAG_FIRST = 20;

// APY: only issuers that publish it through a free, CORS-open API (checked 2026-10-04). Everything else shows "—".
// Jupiter's and Sanctum's public APY endpoints answered 0 for every LST, so they are not used.
const APY_SOURCES = {
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { by: 'Jito', url: 'https://kobe.mainnet.jito.network/api/v1/stake_pool_stats', pick: (j) => (Array.isArray(j?.apy) ? j.apy[j.apy.length - 1]?.data : null) },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { by: 'Marinade (30-day)', url: 'https://api.marinade.finance/msol/apy/30d', pick: (j) => j?.value },
};
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KAMINO_MAIN = '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'; // Kamino's main market
const PRIO_KEY = 'normal'; // staking is not a race: the lowest priority tier
const SLIPS = [0.1, 0.3, 0.5, 1];
const FEE_RESERVE = 0.01; // SOL kept back by "Max" for network, priority and token-account rent

// one fetch per host at a time, cached for 15 minutes (rates move slowly). Jupiter paths go through trade.js's jfetch
// (lite-api, then the keyless api.jup.ag on a 429 or outage); other hosts are plain keyless CORS GETs.
const cache = new Map();
function cachedJson(url, ms = 15 * 60e3) {
  const hit = cache.get(url); if (hit && Date.now() - hit.at < ms) return hit.p;
  const p = url.startsWith('/') ? queued('yield:jup', 400, () => jfetch(url, {}, 10000)) : queued('yield:' + new URL(url).host, 400, () => getJson(url, {}, 10000));
  cache.set(url, { at: Date.now(), p }); p.catch(() => cache.delete(url));
  return p;
}
const okRate = (x) => { const n = Number(x); return isFinite(n) && n >= 0 && n < 1 ? n : null; };

async function apyFor(mint) {
  const src = APY_SOURCES[mint]; if (!src) return null;
  const v = okRate(src.pick(await cachedJson(src.url)));
  return v == null ? null : { v, by: src.by };
}
async function kaminoRates() {
  const list = await cachedJson(`https://api.kamino.finance/kamino-market/${KAMINO_MAIN}/reserves/metrics`);
  if (!Array.isArray(list)) throw new Error('Unexpected answer from Kamino');
  const best = (mint) => list.filter((r) => r?.liquidityTokenMint === mint).sort((a, b) => Number(b.totalSupplyUsd || 0) - Number(a.totalSupplyUsd || 0))[0];
  return [['SOL', best(SOL_MINT)], ['USDC', best(USDC)]].map(([k, r]) => [k, okRate(r?.supplyApy)]);
}
async function jupLendRates() {
  const list = await cachedJson('/lend/v1/earn/tokens');
  if (!Array.isArray(list)) throw new Error('Unexpected answer from Jupiter Lend');
  const rate = (mint) => { const r = list.find((x) => x?.asset?.address === mint || x?.assetAddress === mint); return r ? okRate(Number(r.totalRate ?? r.supplyRate) / 1e4) : null; };
  return [['SOL', rate(SOL_MINT)], ['USDC', rate(USDC)]];
}
const LEND = [
  { name: 'Kamino', url: 'https://kamino.com/', host: 'kamino.com', text: 'Lend SOL, stablecoins or LSTs, or borrow against them.', rates: kaminoRates, src: 'Kamino API, main market' },
  { name: 'Jupiter Lend', url: 'https://jup.ag/lend/earn', host: 'jup.ag/lend', text: 'Deposit to earn a variable rate; withdraw when liquidity allows.', rates: jupLendRates, src: 'Jupiter Lend API' },
  { name: 'marginfi', url: 'https://app.marginfi.com/', host: 'app.marginfi.com', text: 'Pooled lending and borrowing across major Solana assets.', rates: null, src: '' },
];

// a token picture with initials underneath (a broken image is removed by the row list's error listener)
function lstAvatar(t) {
  const src = safeUrl(t.image), sym = String(t.symbol || t.mint || '?').replace(/^\$/, '').slice(0, 3);
  return `<span class="yd-av"><span>${esc(sym)}</span>${src ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>`;
}

// Jupiter's rate-limit errors read better in plain words
const errText = (e, fallback) => (/too many|rate limit|429/i.test(e?.message || '') ? 'Jupiter is busy (rate limit).' : e?.message || fallback);

// numbers
const pctTxt = (r) => (r == null ? '—' : (r * 100).toFixed(2) + '%');
const solTxt = (n, d = 4) => (n == null || !isFinite(n) ? '—' : n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n.toFixed(d));
const amtTxt = (n) => (n == null || !isFinite(n) ? '—' : n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
// exact decimal string for a raw amount (so "Max" round-trips to the same raw)
function fromRaw(raw, dec) {
  const s = String(raw).replace(/^0+/, '').padStart(dec + 1, '0');
  const i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}
// what was typed → exact raw units, or {error}. util's parseAmount decides what is a number ("0,5" = 0.5, "1,000" and
// "1e3" are not), then the same text goes to toRaw so no digit is lost to floating point.
export function readAmount(str, dec) {
  const t = String(str ?? '').trim();
  if (!t) return { empty: true };
  if (!Number.isInteger(dec) || dec < 0 || dec > 18) return { error: 'This token\'s decimals are unknown, so the amount can\'t be worked out. Try again in a moment.' };
  if (Number.isNaN(parseAmount(t))) return { error: 'Enter an amount like 0.25 (one decimal point, no other symbols).' };
  let s = t.replace(',', '.'); if (s.startsWith('.')) s = '0' + s; if (s.endsWith('.')) s = s.slice(0, -1);
  try { const raw = toRaw(s, dec); return raw > 0n ? { raw, ui: Number(s) } : { error: 'Enter an amount above zero.' }; }
  catch (e) { return { error: e.message }; }
}
// The least a quote promises, in raw units of what you receive: swap/v1's otherAmountThreshold, or an Ultra order's
// outAmount less its slippage. Fallback for quoteDetails().minOutRaw (core's figure, used when present). Shown as
// "At least" and handed to trade() as minOutRaw: trade() stops before signing when a fresh quote can't pay it.
export function minOutRaw(q) {
  try {
    if (q?.requestId || q?.mode === 'ultra') { const bps = BigInt(Math.max(0, Math.min(10000, Math.round(Number(q.slippageBps) || 0)))); return ((BigInt(q.outAmount) * (10000n - bps)) / 10000n).toString(); }
    const m = BigInt(q?.otherAmountThreshold); return m > 0n ? m.toString() : null;
  } catch { return null; }
}

register({
  id: 'yield', tab: 'yield', match: /^#\/yield$/, title: 'Yield · Nought',
  mount(view) {
    const S = { lsts: [], more: [], listSeq: 0, rows: new Map(), prices: new Map(), apy: new Map(), bal: null, balErr: false, slip: LS.get('yield.slip', 0.5), alive: true, loading: false, tries: 0, retry: 0, solSearch: 0 };
    if (!SLIPS.includes(S.slip)) S.slip = 0.5;
    const extra = () => LS.get('yield.extra', []).filter(isMint).slice(0, 10);

    view.innerHTML = `<div class="page yd"><div class="yd-in">
      <header class="yd-head">
        <div class="yd-title">
          <h1>Yield</h1>
          <p>Stake SOL by swapping it for a liquid staking token (LST). The LST keeps collecting staking rewards, so each one is worth a little more SOL over time. Unstake by swapping back. Swaps route through Jupiter and Nought adds no fee.</p>
        </div>
        <div class="yd-bar">
          <div class="yd-wallet" id="yd-wallet"></div>
          <div class="yd-ctl"><span>Slippage</span><div class="yd-seg" id="yd-slip">${SLIPS.map((v) => `<button type="button" data-slip="${v}" class="${v === S.slip ? 'on' : ''}">${v}%</button>`).join('')}</div></div>
          <div class="yd-ctl"><span>Route</span><b id="yd-mode" class="mono"></b></div>
          <span class="yd-zero">Nought fee 0%</span>
        </div>
      </header>

      <section class="yd-panel">
        <div class="yd-ph"><h2>Liquid staking</h2><span class="dim" id="yd-count"></span>
          <form class="yd-find" id="yd-find"><input id="yd-q" placeholder="Add another LST by name or address" spellcheck="false" autocomplete="off" aria-label="Find a liquid staking token"><button class="btn" type="submit">Add</button></form>
        </div>
        <div class="yd-table" id="yd-table">
          <div class="yd-hrow"><span>Token</span><span title="How much SOL one token is worth, from Jupiter's prices">Price in SOL</span><span title="Shown only where the issuer publishes it through a free public API">APY</span><span title="Total value of this LST">Staked</span><span>You hold</span><span>Stake or unstake</span></div>
          <div id="yd-rows"><div class="yd-state"><span class="pulse-dot"></span>Checking liquid staking tokens with Jupiter…</div></div>
          <div id="yd-more" class="yd-more" hidden></div>
        </div>
        <p class="yd-foot">APY appears only where the issuer publishes it through a free public API (Jito for JitoSOL, Marinade for mSOL); everything else shows —. The price in SOL comes from Jupiter and drifts up as rewards accrue. LSTs carry smart-contract and depeg risk, and a swap can return slightly less than the stake rate.</p>
      </section>

      <section class="yd-panel">
        <div class="yd-ph"><h2>Lending</h2><span class="yd-ext">External sites</span></div>
        <p class="yd-note">Nought does not route or touch these deposits. Each card opens the lender's own site, where you deposit with your own wallet under their terms.</p>
        <div class="yd-lend" id="yd-lend">${LEND.map((l, i) => `<a class="yd-lc" href="${esc(l.url)}" target="_blank" rel="noopener nofollow">
            <div class="yd-lc-h"><b>${esc(l.name)}</b><span class="yd-ext">${esc(l.host)} ↗</span></div>
            <p>${esc(l.text)}</p>
            <div class="yd-lc-r" id="yd-lr-${i}">${l.rates ? '<span class="dim">Loading rates…</span>' : '<span class="dim">No public rate feed checked. See the site.</span>'}</div>
            ${l.src ? `<span class="yd-lc-s">Variable supply rate · ${esc(l.src)}</span>` : ''}
          </a>`).join('')}</div>
      </section>
    </div></div>`;

    const root = $('.yd', view), rowsEl = $('#yd-rows', root);

    // ---- top bar: wallet, route mode ----
    function bar() {
      const mev = preset().mev === 'protected';
      $('#yd-mode', root).textContent = mev ? 'Jupiter Ultra' : 'Standard';
      $('#yd-mode', root).title = mev ? `Preset ${preset().name} uses MEV protection: Jupiter lands the swap, sets slippage itself and may charge its own fee (shown on the quote).` : `Preset ${preset().name}: Jupiter's standard route, signed and sent by your wallet. Priority ${PRIO[PRIO_KEY].label} (at most ${PRIO[PRIO_KEY].max} SOL).`;
      const w = $('#yd-wallet', root);
      if (!wallet.owner) { w.innerHTML = '<button type="button" class="btn btn-accent" id="yd-connect">Connect wallet</button><span class="dim">to see balances and stake</span>'; $('#yd-connect', w).onclick = () => needWallet(); return; }
      w.innerHTML = `<span class="yd-wl">Wallet</span><b class="mono">${esc(short(wallet.owner))}</b><span class="mono ${S.balErr ? 'down' : ''}">${S.bal ? solTxt(S.bal.sol, 3) + ' SOL' : S.balErr ? 'balance unavailable' : '…'}</span>`;
    }

    // ---- rows ----
    function rowHtml(t) {
      const sym = esc(t.symbol || short(t.mint));
      return `<div class="yd-row" data-mint="${esc(t.mint)}">
        <a class="yd-tok" href="#/t/${esc(t.mint)}" title="${esc(t.name || '')}">${lstAvatar(t)}<span><b>${sym}${t.verified === false ? ' <i class="flag" title="Jupiter has not verified this token: check the issuer before staking">Unverified</i>' : ''}</b><small>${esc(t.name || '')}</small></span></a>
        <span class="yd-c mono" data-k="rate" data-label="Price in SOL">—</span>
        <span class="yd-c mono dim" data-k="apy" data-label="APY">–</span>
        <span class="yd-c mono" data-k="tvl" data-label="Staked">${usd(t.mcUsd)}</span>
        <span class="yd-c mono" data-k="held" data-label="You hold">—</span>
        <div class="yd-act"><button type="button" class="yd-pick" data-mode="stake" aria-expanded="false">Stake</button><button type="button" class="yd-pick" data-mode="unstake" aria-expanded="false">Unstake</button></div>
        <div class="yd-ex" hidden>
          <label class="yd-amt"><input inputmode="decimal" autocomplete="off" placeholder="0.0" aria-label="Amount"><em data-k="unit">SOL</em><button type="button" class="yd-max" title="Use your balance">Max</button></label>
          <button type="button" class="yd-go" disabled>Stake</button>
        </div>
        <div class="yd-q" hidden></div>
      </div>`;
    }
    const rowEl = (mint) => rowsEl.querySelector(`.yd-row[data-mint="${mint}"]`);
    const stateOf = (mint) => { let r = S.rows.get(mint); if (!r) { r = { mode: 'stake', seq: 0, timer: 0, q: null, d: null, raw: null, at: 0, busy: false }; S.rows.set(mint, r); } return r; };

    function renderRows() {
      for (const r of S.rows.values()) clearTimeout(r.timer);
      S.rows.clear();
      $('#yd-count', root).textContent = S.lsts.length ? `${S.lsts.length} tokens` : '';
      if (!S.lsts.length) return;
      rowsEl.innerHTML = S.lsts.map(rowHtml).join('');
      S.lsts.forEach((t) => cells(t.mint));
    }
    function addRows(list) {
      S.lsts.push(...list);
      rowsEl.insertAdjacentHTML('beforeend', list.map(rowHtml).join(''));
      list.forEach((t) => cells(t.mint));
      $('#yd-count', root).textContent = `${S.lsts.length} tokens`;
      if (S.more.length) { const shown = new Set(list.map((t) => t.mint)); S.more = S.more.filter((t) => !shown.has(t.mint)); }
      moreBtn();
    }
    // the rest of Jupiter's 'lst' list waits behind a button (hundreds of small LSTs exist)
    function moreBtn() {
      const el = $('#yd-more', root); if (!el) return;
      el.hidden = !S.more.length;
      el.innerHTML = S.more.length ? `<button type="button" class="btn" data-more>Show ${S.more.length} more liquid staking token${S.more.length === 1 ? '' : 's'}</button><span class="dim">Smaller ones Jupiter tags as LSTs, largest first. Check the issuer before staking.</span>` : '';
    }
    function cells(mint) {
      const el = rowEl(mint); if (!el) return;
      // Jupiter's price API first; until it answers, the price that came with the token search and the app's SOL price
      const t = S.lsts.find((x) => x.mint === mint), lstUsd = S.prices.get(mint)?.price ?? t?.price, solPx = S.prices.get(SOL_MINT)?.price || solUsd() || S.solSearch;
      const rate = lstUsd > 0 && solPx > 0 ? lstUsd / solPx : null;
      $('[data-k="rate"]', el).textContent = rate ? rate.toFixed(4) : '—';
      const a = S.apy.get(mint);
      const ap = $('[data-k="apy"]', el); ap.textContent = a ? pctTxt(a.v) : '–'; ap.title = a ? `From ${a.by}` : 'No free public source for this APY';
      ap.classList.toggle('up', !!a); ap.classList.toggle('dim', !a);
      const h = S.bal?.tokens?.[mint], ui = h ? Number(h.ui) : 0;
      $('[data-k="held"]', el).textContent = !wallet.owner ? '—' : !S.bal ? (S.balErr ? '?' : '…') : ui > 0 ? `${amtTxt(ui)}${rate ? ` (${solTxt(ui * rate, 3)} SOL)` : ''}` : '0';
      if (t) $('[data-k="tvl"]', el).textContent = usd(t.mcUsd);
    }
    const allCells = () => S.lsts.forEach((t) => cells(t.mint));

    // ---- data ----
    async function loadList() {
      if (S.loading) return; S.loading = true;
      rowsEl.innerHTML = '<div class="yd-state"><span class="pulse-dot"></span>Checking liquid staking tokens with Jupiter…</div>';
      try {
        // SOL rides along so its search price can stand in until the price API answers
        const base = new Set(CANDIDATES), res = await jt.search([...CANDIDATES, ...extra(), SOL_MINT]), found = res.filter(isLst);
        if (!S.alive) return;
        S.solSearch = res.find((t) => t.mint === SOL_MINT)?.price;
        // curated ones by size first, then the ones this viewer added
        S.lsts = [...found.filter((t) => base.has(t.mint)).sort((a, b) => (b.mcUsd || 0) - (a.mcUsd || 0)), ...found.filter((t) => !base.has(t.mint))];
        S.more = []; moreBtn();
        if (!S.lsts.length) { rowsEl.innerHTML = '<div class="yd-state">Jupiter returned no liquid staking tokens. <button type="button" class="btn" data-retry>Retry</button></div>'; return; }
        renderRows();
        loadPrices(); loadApy(); loadBalances(); loadTagged();
        S.tries = 0;
      } catch (e) {
        if (!S.alive) return;
        // Jupiter's free tier rate-limits bursts: try again by itself a few times, slower each time
        const auto = S.tries < 4; S.tries++;
        if (auto) { clearTimeout(S.retry); S.retry = setTimeout(loadList, 8e3 * S.tries); }
        rowsEl.innerHTML = `<div class="yd-state down">${esc(/rate limit/.test(errText(e, '')) ? errText(e, '') : `Could not reach Jupiter (${errText(e, 'network error')}).`)}${auto ? ` Trying again in ${8 * S.tries} s.` : ''} <button type="button" class="btn" data-retry>Retry now</button></div>`;
      } finally { S.loading = false; }
    }
    // every LST Jupiter tags, when core has jt.tag (the curated list above is the fallback and stays on top)
    async function loadTagged() {
      if (typeof jt.tag !== 'function') return;
      const seq = ++S.listSeq;
      try {
        const list = await jt.tag('lst');
        if (!S.alive || seq !== S.listSeq || !Array.isArray(list)) return;
        const have = new Set(S.lsts.map((t) => t.mint)), seen = new Set();
        const rest = list.filter((t) => t && isMint(t.mint) && t.mint !== SOL_MINT && !have.has(t.mint) && (!Array.isArray(t.tags) || isLst(t)) && !seen.has(t.mint) && seen.add(t.mint))
          .sort((a, b) => (b.mcUsd || 0) - (a.mcUsd || 0));
        if (!rest.length) return;
        S.more = rest.slice(TAG_FIRST);
        addRows(rest.slice(0, TAG_FIRST));
        loadPrices();
      } catch { /* the curated list is already showing */ }
    }
    async function loadPrices() {
      if (!S.lsts.length || document.hidden) return;
      try { const m = await jp.prices([SOL_MINT, ...S.lsts.map((t) => t.mint)]); if (!S.alive) return; for (const [k, v] of m) S.prices.set(k, v); allCells(); } catch { /* keep the last prices */ }
    }
    async function loadApy() {
      await Promise.all(S.lsts.filter((t) => APY_SOURCES[t.mint]).map(async (t) => {
        try { const a = await apyFor(t.mint); if (a && S.alive) { S.apy.set(t.mint, a); cells(t.mint); } } catch { /* "—" stays */ }
      }));
    }
    async function loadBalances() {
      if (!wallet.owner) { S.bal = null; S.balErr = false; bar(); allCells(); return; }
      const owner = wallet.owner;
      try { const b = await ju.balances(owner); if (!S.alive || owner !== wallet.owner) return; S.bal = b; S.balErr = false; }
      catch { if (S.alive) S.balErr = true; }
      if (!S.alive) return;
      bar(); allCells();
      for (const mint of S.rows.keys()) if (rowEl(mint)?.querySelector('input').value) paintQuote(mint); // balance warnings
    }
    let lendRetry = 0;
    async function loadLend(retry = false) {
      let failed = false;
      await Promise.all(LEND.map(async (l, i) => {
        const el = $('#yd-lr-' + i, root);
        if (!l.rates || (retry && !el.dataset.failed)) return;
        try {
          const r = await l.rates(); if (!S.alive) return;
          el.innerHTML = r.map(([k, v]) => `<span><em>${esc(k)}</em><b class="mono ${v != null ? 'up' : ''}">${pctTxt(v)}</b></span>`).join('');
          delete el.dataset.failed;
        } catch { if (S.alive) { failed = true; el.dataset.failed = '1'; el.innerHTML = '<span class="dim">Rates unavailable right now. See the site.</span>'; } }
      }));
      if (failed && !retry && S.alive) lendRetry = setTimeout(() => loadLend(true), 45e3); // one more try (rate limits pass)
    }

    // ---- quoting ----
    const tokenOf = (mint) => S.lsts.find((t) => t.mint === mint);
    // the LST's decimals: Jupiter's token search, else the wallet balance's; never a guess (a wrong guess moves the decimal point)
    const decOf = (mint) => {
      const d = tokenOf(mint)?.decimals, b = S.bal?.tokens?.[mint]?.dec, okD = Number.isInteger(d), okB = Number.isInteger(b);
      return okD && okB && d !== b ? null : okD ? d : okB ? b : null; // two sources that disagree: refuse rather than pick one
    };
    // quiet: a background refresh of the same amount, which keeps showing the last quote until the new one lands
    function requote(mint, delay = 400, quiet = false) {
      const r = stateOf(mint), el = rowEl(mint); if (!el) return;
      clearTimeout(r.timer); const seq = ++r.seq;
      const parsed = readAmount($('input', el).value, r.mode === 'stake' ? 9 : decOf(mint));
      if (!quiet || !r.d) { r.q = null; r.d = null; r.min = null; r.raw = null; r.err = parsed.error || null; }
      if (parsed.empty || parsed.error) { r.q = null; r.d = null; r.min = null; r.raw = null; r.err = parsed.error || null; paintQuote(mint); return; }
      r.raw = parsed.raw;
      if (!quiet || !r.d) { r.loading = true; paintQuote(mint); }
      r.timer = setTimeout(async () => {
        const [inM, outM] = r.mode === 'stake' ? [SOL_MINT, mint] : [mint, SOL_MINT];
        try {
          const q = await quoteFor(inM, outM, r.raw.toString(), { slippage: S.slip });
          if (!S.alive || seq !== r.seq) return;
          const dec = decOf(mint);
          if (!Number.isInteger(dec)) throw new Error('This token\'s decimals are unknown. Try again in a moment.');
          const d = quoteDetails(q, { inDec: r.mode === 'stake' ? 9 : dec, outDec: r.mode === 'stake' ? dec : 9, prio: PRIO_KEY });
          // the minimum shown is exactly the one trade() holds the swap to: core's figure, else the same rule here
          const min = /^\d+$/.test(String(d.minOutRaw ?? '')) && BigInt(d.minOutRaw) > 0n ? String(d.minOutRaw) : minOutRaw(q);
          if (!min) throw new Error('Jupiter\'s quote did not say the least you would get. Try again.');
          r.q = q; r.min = min; r.outDec = r.mode === 'stake' ? dec : 9; r.d = d; r.err = null;
        } catch (e) { if (!S.alive || seq !== r.seq) return; if (!quiet || !r.d) { r.err = errText(e, 'No route right now.'); if (/rate limit/.test(r.err)) r.err += ' Trying again shortly.'; } }
        r.at = Date.now(); r.loading = false; paintQuote(mint);
      }, delay);
    }
    function paintQuote(mint) {
      const r = stateOf(mint), el = rowEl(mint); if (!el) return;
      const t = tokenOf(mint), sym = esc(t?.symbol || short(mint)), stake = r.mode === 'stake', box = $('.yd-q', el), go = $('.yd-go', el);
      const val = $('input', el).value.trim();
      go.textContent = !wallet.owner ? 'Connect wallet' : r.busy ? 'Confirm in wallet…' : stake ? 'Stake' : 'Unstake';
      go.disabled = r.busy || (!!wallet.owner && !(r.d && r.raw));
      if (!val) { box.hidden = true; box.innerHTML = ''; return; }
      box.hidden = false;
      if (r.err) { box.innerHTML = `<div class="yd-qmsg down">${esc(r.err)}</div>`; return; }
      if (r.loading || !r.d) { box.innerHTML = '<div class="yd-qmsg dim">Getting a quote from Jupiter…</div>'; return; }
      const d = r.d, inSym = stake ? 'SOL' : sym, outSym = stake ? sym : 'SOL';
      const per = stake ? d.inUi / d.outUi : d.outUi / d.inUi; // SOL per LST
      const warns = [];
      const iw = impactWarning(d, null); if (iw) warns.push(`<div class="yd-qmsg ${iw.level === 'danger' ? 'down' : 'warn'}">${esc(iw.text)}</div>`);
      if (S.bal && wallet.owner) {
        if (stake && d.inUi + FEE_RESERVE > S.bal.sol) warns.push(`<div class="yd-qmsg warn">You have ${solTxt(S.bal.sol, 4)} SOL. Keep about ${FEE_RESERVE} SOL for network fees and the token account.</div>`);
        const held = Number(S.bal.tokens?.[mint]?.ui || 0);
        if (!stake && d.inUi > held + 1e-12) warns.push(`<div class="yd-qmsg warn">You hold ${amtTxt(held)} ${sym}.</div>`);
      }
      const fee = (f) => `<span class="yd-fee">${esc(f.label)}${f.sol != null ? ` <b class="mono">${String(Number(Number(f.sol).toFixed(6)))} SOL</b>` : ''}${f.bps ? ` <b class="mono">${(f.bps / 100).toFixed(2)}%</b>` : ''}${f.note ? ` <i>${esc(f.note)}</i>` : ''}</span>`;
      box.innerHTML = `<div class="yd-qgrid">
          <div><span>You pay</span><b class="mono">${amtTxt(d.inUi)} ${inSym}</b></div>
          <div><span>You get about</span><b class="mono">${amtTxt(d.outUi)} ${outSym}</b></div>
          <div><span>At least</span><b class="mono" title="${d.mode === 'protected' ? 'The quote less the order\'s slippage' : `The quote less your ${esc(String(S.slip))}% slippage`}. If a fresh quote can't pay this much when you press ${stake ? 'Stake' : 'Unstake'}, Nought stops before your wallet signs.">${amtTxt(Number(r.min) / 10 ** r.outDec)} ${outSym}</b></div>
          <div><span>Swap rate</span><b class="mono">1 ${sym} = ${per > 0 ? per.toFixed(4) : '—'} SOL</b></div>
          <div><span>Price impact</span><b class="mono ${d.impactPct >= 1 ? 'warn' : ''}">${d.impactPct.toFixed(2)}%</b></div>
          <div><span>Route</span><b>${esc(d.routeLabel)}${d.mode === 'protected' ? ' · Ultra' : ''}</b></div>
          <div class="wide"><span>Goes to</span><b class="mono">${wallet.owner ? `your wallet ${esc(short(wallet.owner, 6))}` : '<span class="warn">connect a wallet first</span>'}</b></div>
        </div>
        <div class="yd-fees"><span class="yd-fee us">Nought fee <b class="mono">0%</b></span>${d.fees.map(fee).join('')}</div>
        ${warns.join('')}`;
    }
    async function go(mint) {
      if (!needWallet()) return;
      const r = stateOf(mint), t = tokenOf(mint), el = rowEl(mint);
      if (!r.d || !r.raw || !r.min || r.busy) return;
      const stake = r.mode === 'stake', sym = t?.symbol || short(mint), raw = r.raw, min = r.min;
      if (S.bal) {
        if (stake && r.d.inUi + 0.003 > S.bal.sol) return toast(`Not enough SOL: you have ${esc(solTxt(S.bal.sol, 4))} SOL and need a little extra for fees.`, 'err');
        const h = S.bal.tokens?.[mint]; if (!stake && (!h || BigInt(h.raw) < raw)) return toast(`You hold ${esc(amtTxt(Number(h?.ui || 0)))} ${esc(sym)}, less than that.`, 'err');
      }
      r.busy = true; paintQuote(mint);
      // sent = a transaction may be on its way: then the amount is cleared so a second press can't send it again
      let sent = false;
      const off = on('traded', (x) => { if (x?.mint === mint) sent = true; });
      try {
        // minOutRaw: the "At least" this row showed; trade() stops before signing if a fresh quote promises less
        if (await trade(stake ? 'buy' : 'sell', mint, raw, { slippage: S.slip, prio: PRIO_KEY, mev: preset().mev || 'off', label: sym, maxImpactPct: 3, minOutRaw: min })) sent = true;
      } catch (e) {
        if (e?.maybeSent && e.sig) { // the send errored but the transaction may still land: report what the chain says, never retry
          sent = true;
          toast(`The wallet reported an error, but the ${stake ? 'stake' : 'unstake'} may still land. Checking… ${txLink(e.sig)}`);
          const st = await confirm(e.sig);
          toast(st === 'ok' ? `The ${stake ? 'stake' : 'unstake'} of ${esc(sym)} went through. ${txLink(e.sig)}` : st === 'failed' ? `The ${stake ? 'stake' : 'unstake'} failed on-chain. ${txLink(e.sig)}` : `Still not confirmed. Check it before trying again. ${txLink(e.sig)}`, st === 'ok' ? 'ok' : st === 'failed' ? 'err' : '');
        } else toast(esc(e?.message || 'The swap did not go through.'), 'err');
      } finally { off(); }
      r.busy = false;
      if (!S.alive) return;
      // nothing went out (price moved, impact too high, wallet declined): keep the amount and show a fresh quote
      if (el?.isConnected) { if (sent) $('input', el).value = ''; requote(mint, 0); }
      loadBalances();
    }

    // ---- events (delegated) ----
    rowsEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-retry]')) { clearTimeout(S.retry); loadList(); return; }
      const row = e.target.closest('.yd-row'); if (!row) return;
      const mint = row.dataset.mint; if (!isMint(mint)) return;
      // Stake / Unstake open this row's amount field (one row at a time looks like a form, not a wall of inputs);
      // pressing the open side again folds it away. Switching side clears the amount, as before.
      const m = e.target.closest('[data-mode]');
      if (m) {
        const r = stateOf(mint), ex = $('.yd-ex', row), inp = $('input', row); if (r.busy) return;
        const mode = m.dataset.mode === 'unstake' ? 'unstake' : 'stake', open = !ex.hidden;
        if (open && r.mode === mode) { ex.hidden = true; m.classList.remove('on'); m.setAttribute('aria-expanded', 'false'); inp.value = ''; requote(mint, 0); return; }
        r.mode = mode;
        $$('[data-mode]', row).forEach((b) => { b.classList.toggle('on', b === m); b.setAttribute('aria-expanded', String(b === m)); });
        $('[data-k="unit"]', row).textContent = r.mode === 'stake' ? 'SOL' : (tokenOf(mint)?.symbol || 'LST').slice(0, 10);
        ex.hidden = false; inp.value = ''; requote(mint, 0); inp.focus(); return;
      }
      if (e.target.closest('.yd-max')) {
        if (!needWallet()) return;
        const r = stateOf(mint), inp = $('input', row);
        if (!S.bal) { toast('Balances are still loading.', ''); return; }
        if (r.mode === 'stake') { const v = Math.max(0, S.bal.sol - FEE_RESERVE); inp.value = v > 0 ? String(Math.floor(v * 1e6) / 1e6) : ''; if (!(v > 0)) toast(`Keep about ${FEE_RESERVE} SOL for fees: there is nothing left to stake.`, 'err'); }
        else {
          const h = S.bal.tokens?.[mint], dec = decOf(mint);
          if (!h || !(BigInt(h.raw) > 0n)) { inp.value = ''; toast('You hold none of this token.', 'err'); }
          else if (!Number.isInteger(dec)) { inp.value = ''; toast('This token\'s decimals are unknown, so Max can\'t be worked out yet.', 'err'); }
          else inp.value = fromRaw(h.raw, dec);
        }
        requote(mint, 0); return;
      }
      if (e.target.closest('.yd-go')) go(mint);
    });
    rowsEl.addEventListener('error', (e) => { if (e.target instanceof HTMLImageElement) e.target.remove(); }, true);
    $('#yd-more', root).addEventListener('click', (e) => { if (!e.target.closest('[data-more]')) return; const next = S.more.slice(); S.more = []; addRows(next); loadPrices(); });
    rowsEl.addEventListener('input', (e) => { const row = e.target.closest('.yd-row'); if (row && e.target.matches('input')) requote(row.dataset.mint); });
    rowsEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.yd-amt input')) { e.preventDefault(); const row = e.target.closest('.yd-row'); if (row) go(row.dataset.mint); } });
    $('#yd-slip', root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-slip]'); if (!b) return;
      S.slip = Number(b.dataset.slip); LS.set('yield.slip', S.slip);
      $$('[data-slip]', root).forEach((x) => x.classList.toggle('on', x === b));
      for (const mint of S.rows.keys()) if (rowEl(mint)?.querySelector('input').value) requote(mint, 0);
    });
    $('#yd-find', root).addEventListener('submit', async (e) => {
      e.preventDefault();
      const q = $('#yd-q', root).value.trim(), btn = $('#yd-find button', root); if (!q) return;
      btn.disabled = true;
      try {
        // one token per search: an exact ticker match first, verified and larger ones ahead of the rest
        const hits = (await jt.search(isMint(q) ? [q] : q)).filter(isLst).filter((t) => !S.lsts.some((x) => x.mint === t.mint));
        const exact = hits.filter((t) => isMint(q) ? t.mint === q : String(t.symbol || '').toLowerCase() === q.toLowerCase());
        const rank = (a, b) => (b.verified === true) - (a.verified === true) || (b.mcUsd || 0) - (a.mcUsd || 0);
        const found = (exact.length ? exact : hits).sort(rank).slice(0, 1);
        if (!S.alive) return;
        if (!found.length) toast(`No other liquid staking token matches “${esc(q.slice(0, 40))}”.`, 'err');
        else {
          LS.set('yield.extra', [...new Set([...extra(), ...found.map((t) => t.mint)])].slice(0, 10));
          addRows(found); loadPrices(); loadApy();
          $('#yd-q', root).value = '';
          toast(`Added ${esc(found[0].symbol || short(found[0].mint))}${found[0].verified ? '' : ' (not verified by Jupiter: check the issuer first)'}.`, found[0].verified ? 'ok' : '');
        }
      } catch (err) { toast(`Search failed: ${esc(err.message || 'network error')}`, 'err'); }
      if (btn.isConnected) btn.disabled = false;
    });

    // keep quotes fresh while an amount is typed (only rows with an amount, only while the tab is visible)
    function refreshQuotes() { if (document.hidden) return; for (const [mint, r] of S.rows) if (!r.busy && !r.loading && rowEl(mint)?.querySelector('input').value && Date.now() - r.at > 20e3) requote(mint, 0, true); }

    bar(); loadList(); loadLend();
    const timers = [
      setInterval(() => { if (!document.hidden) loadPrices(); }, 30e3), // JP cadence is 10 s at most; 30 s is plenty here
      setInterval(() => { if (!document.hidden) loadBalances(); }, 60e3),
      setInterval(refreshQuotes, 5e3),
    ];
    const onVis = () => { if (!document.hidden) { loadPrices(); refreshQuotes(); } };
    document.addEventListener('visibilitychange', onVis);
    const offs = [
      on('wallet', () => { S.bal = null; S.balErr = false; bar(); loadBalances(); for (const mint of S.rows.keys()) paintQuote(mint); }),
      on('settings', () => { bar(); for (const mint of S.rows.keys()) if (rowEl(mint)?.querySelector('input').value) requote(mint, 0); }),
      on('traded', (x) => { if (S.lsts.some((t) => t.mint === x?.mint)) loadBalances(); }),
    ];
    return () => {
      S.alive = false; timers.forEach(clearInterval); clearTimeout(lendRetry); clearTimeout(S.retry); for (const r of S.rows.values()) clearTimeout(r.timer);
      document.removeEventListener('visibilitychange', onVis); offs.forEach((f) => f());
    };
  },
});
