// Token page trade panel: Buy / Sell with three modes.
//   Market  editable amount chips, the P1–P3 preset, a live quote (out amount, minimum received, price impact, route,
//           every third-party fee and "Nought fee 0%") with impact / thin-liquidity warnings, then one button.
//   Limit   a Jupiter Trigger order: target as market cap or price, expiry, a review of exactly what will be signed
//           (limit.build → summary → limit.submit), and this coin's open orders with Cancel.
//   Adv.    take-profit / stop-loss legs and buy / sell on migration (orders.js armed.*): they run in this browser
//           while a Nought tab is open.
// Below: the position row (bought, sold, holding, PnL) and the preset tabs. mountPanel(el, ctx) → cleanup.
// Nought adds no fee anywhere here: quotes and trades go through core trade.js / orders.js, which never pass one.
// Money safety: amounts go through core parseAmount ("0,5" = 0.5, anything unclear is refused) and targets through
// parseTarget; a market trade only runs from a fresh quote on screen and carries its minimum (minOutRaw) and an impact
// cap; armed orders are set up once per selected wallet.
import { esc, LS, usd, num, short, toast, ICON, parseAmount, parseTarget } from '../../core/util.js';
import { settings, set as setSettings, preset, PRIO } from '../../core/settings.js';
import { wallet, needWallet, tradeOwners, selectWallet, MAX_SELECTED } from '../../core/wallet.js';
import { rpc } from '../../core/rpc.js';
import * as V from '../../core/vault.js';
import { SOL_MINT, quoteFor, quoteDetails, impactWarning, holding, decimalsOf, DANGER_IMPACT, multiMode, perWalletSol } from '../../core/trade.js';
import { limit, armed, NEEDS_TAB, MIN_LIMIT_USD } from '../../core/orders.js';
import { ju } from '../../core/jup.js';
import { mcUsd } from '../../core/store.js';
import { solUsd } from '../../core/price.js';
import { fmtPrice, plainNum, supplyOf, openOrders } from './chart.js';
import { buyAcross, sellAcross, loadPosition, priceUsdOf, openInstant, quotedMin, maybeLanded } from '../../ui/instant.js';

const CHIPS = { buy: [0.01, 0.1, 1, 10], sell: [10, 25, 50, 100] };
const EXPIRY = [[0, 'Never'], [3600, '1h'], [86400, '1d'], [604800, '7d']];
const fmtSol = (v, d = 3) => (v == null || !isFinite(v) ? '—' : v === 0 ? '0' : Math.abs(v) >= 1000 ? num(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(d));
const feeSol = (v) => (v == null ? '' : v === 0 ? '0' : v < 0.0001 ? v.toFixed(6) : v < 0.01 ? v.toFixed(5) : v.toFixed(4));
const signed = (v, s) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : '') + s);
const QUOTE_TTL = 20000; // a quote older than this is not "on screen": the button gets a fresh one first
const KIND_SHORT = { tp: 'TP', sl: 'SL', 'migrate-buy': 'Buy · mig.', 'migrate-sell': 'Sell · mig.' };
// small line glyphs for the panel (drawn for Nought)
const svg = (d, w = 13, extra = '') => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" aria-hidden="true"${extra}>${d}</svg>`;
const G = {
  sol: svg('<path d="M7 5.5h13l-3 3H4zM4 10.5h13l3 3H7zM7 15.5h13l-3 3H4z" fill="currentColor"/>', 14, ' class="tp-solic"'),
  wallet: svg('<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="13.5" r="1.3" fill="currentColor"/>'),
  slip: svg('<path d="M4 18h16M6 14l4-4 3 3 5-6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>', 12),
  gas: svg('<path d="M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M4 20h11M5 10h9M14 8l3 2v6.5a1.5 1.5 0 0 0 3 0V9l-2-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>', 12),
  shield: svg('<path d="M12 3 5 6v5.5c0 4.2 3 7.8 7 9.5 4-1.7 7-5.3 7-9.5V6l-7-3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', 12),
  gear: svg('<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>', 14),
  pen: svg('<path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>', 13),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>', 13),
};
// a preset's tab label: the default names P1–P3 read as "Preset 1"–"Preset 3"; a renamed preset keeps its name
const preLabel = (p) => (/^P\d$/.test(p.name) ? `Preset ${p.name.slice(1)}` : p.name);

export function mountPanel(el, ctx) {
  const mint = ctx.mint;
  const chips = () => { const c = LS.get('tp.chips', CHIPS); return { buy: (c.buy || CHIPS.buy).slice(0, 4), sell: (c.sell || CHIPS.sell).slice(0, 4) }; };
  const P = {
    qOpen: LS.get('panel.quote.open', false) === true, // the quote's full breakdown (one line when closed)
    side: LS.get('tp.side', 'buy') === 'sell' ? 'sell' : 'buy',
    mode: ['market', 'limit', 'adv'].includes(LS.get('tp.mode', 'market')) ? LS.get('tp.mode', 'market') : 'market',
    amt: { buy: String(preset().buy), sell: String(preset().sellPct) }, editChips: false,
    qd: null, qErr: '', qNote: '', qBusy: false, qSeq: 0, qTimer: 0, q: null, confirmUntil: 0, confirmAt: 0, busy: false,
    bal: null, balOwner: null, pos: null, posBusy: false, tradedAt: 0,
    tkind: LS.get('tp.tkind', 'mc') === 'price' ? 'price' : 'mc',
    lim: { amt: { buy: String(preset().buy), sell: '100' }, target: '', exp: Number(LS.get('tp.exp', 0)) || 0 },
    built: null, builtAt: 0, building: false, buildErr: '', placing: false, bSeq: 0,
    adv: { pct: '100', tp: '', sl: '', mb: String(preset().buy), ms: '100' }, arming: false, advErr: '', advErrAt: '',
    orders: null, ordersErr: '', lastPreset: settings.preset, alive: true,
  };
  const q = (s) => el.querySelector(s);
  const t = () => ctx.token() || {};
  const sym = () => (t().symbol ? '$' + t().symbol : short(mint));
  const liq = () => t().liquidity ?? ctx.pair()?.liquidity?.usd ?? null;
  const mcNow = () => mcUsd(t()) || Number(ctx.pair()?.marketCap) || null;
  const priceNow = () => priceUsdOf(t()) || Number(ctx.pair()?.priceUsd) || null;
  const owners = () => tradeOwners();
  const dec = () => t().decimals ?? P.bal?.tok?.dec ?? decimalsOf(mint);

  // ---------- rendering ----------
  // layout (top to bottom): Buy / Sell, Market / Limit / Adv. with the wallet chip, the mode's body, the position row,
  // then the preset tabs
  function render() {
    const buy = P.side === 'buy', n = owners().length;
    el.innerHTML = `<div class="tp-tp ${P.side}">
      <div class="tp-bs" role="tablist" aria-label="Side"><button type="button" role="tab" data-side="buy" class="${buy ? 'on' : ''}" aria-selected="${buy}">Buy</button><button type="button" role="tab" data-side="sell" class="${buy ? '' : 'on'}" aria-selected="${!buy}">Sell</button></div>
      <div class="tp-modes">
        <div class="tp-mtabs" role="tablist" aria-label="Order type">${[['market', 'Market'], ['limit', 'Limit'], ['adv', 'Adv.']].map(([k, l]) => `<button type="button" role="tab" data-mode="${k}" class="${P.mode === k ? 'on' : ''}" aria-selected="${P.mode === k}">${l}</button>`).join('')}</div>
        ${P.mode === 'adv' ? `<span class="tp-wal" title="${n ? `${n} wallet${n === 1 ? '' : 's'} selected` : 'No wallet connected'}">${G.wallet}${n ? `<em>${n}</em>` : ''}<span class="tp-bal" data-bal>${balText()}</span></span>`
          : `<button type="button" class="tp-wal" data-act="wallets" aria-haspopup="dialog" aria-expanded="${!!P.wpop}" title="${!n ? 'Connect a wallet' : 'Pick the wallets this trade runs on'}">${G.wallet}${n ? `<em>${n}</em>` : ''}<span class="tp-bal" data-bal>${balText()}</span></button>`}
      </div>
      ${P.wpop ? wpopHtml() : ''}
      <div class="tp-body">${P.mode === 'market' ? marketHtml() : P.mode === 'limit' ? limitHtml() : advHtml()}</div>
      <div class="tp-posrow" data-pos>${posHtml()}</div>
      <div class="tp-pre" role="group" aria-label="Preset">${settings.presets.map((p, i) => `<button type="button" data-pre="${i}" class="${i === settings.preset ? 'on' : ''}" aria-pressed="${i === settings.preset}" title="${esc(p.name)}: buy ${esc(String(p.buy))} SOL · sell ${esc(String(p.sellPct))}% · ${esc(String(p.slippage))}% slippage · ${esc(PRIO[p.prio]?.label || '')} priority${p.mev === 'protected' ? ' · MEV-protected' : ''}">${esc(preLabel(p))}</button>`).join('')}<button type="button" class="tp-pgear" data-act="settings" title="Edit presets" aria-label="Edit presets">${G.gear}</button></div>
    </div>`;
    if (P.wpop) placeWpop();
    if (P.mode === 'market') requote(0);
    if (P.mode === 'limit') loadOrders();
  }
  // the picker floats over the page right under the wallet button (above it when the button sits low), so the
  // panel's own scrolling can never hide it
  function placeWpop() {
    const pop = el.querySelector('.tp-wpop'), btn = el.querySelector('[data-act="wallets"]'); if (!pop || !btn) return;
    const r = btn.getBoundingClientRect(), w = Math.min(340, innerWidth - 16), below = innerHeight - r.bottom - 14, above = r.top - 14;
    pop.style.width = w + 'px'; pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    if (below >= 320 || below >= above) { pop.style.maxHeight = below + 'px'; pop.style.top = r.bottom + 6 + 'px'; }
    else { pop.style.maxHeight = above + 'px'; pop.style.top = Math.max(8, r.top - 6 - pop.offsetHeight) + 'px'; }
  }
  // ---------- wallet picker on the balance chip: which wallets this trade runs on (Axiom-style) ----------
  async function loadWpop() {
    try {
      const list = await V.list(); P.wlist = list;
      const addrs = list.map((w) => w.address), bal = new Map();
      for (let i = 0; i < addrs.length; i += 10) {
        const r = await rpc('getMultipleAccounts', [addrs.slice(i, i + 10), { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
        (r?.value || []).forEach((v, j) => bal.set(addrs[i + j], (v?.lamports || 0) / 1e9));
      }
      P.wbal = bal;
      if (P.wpop) render();
      // how much of this coin each wallet holds (Jupiter balances, low priority, one call per wallet)
      const tok = new Map();
      await Promise.all(addrs.slice(0, 25).map(async (a) => { try { const b = await ju.balances(a, { prio: 'low' }); tok.set(a, Number(b.tokens?.[mint]?.ui) || 0); } catch { /* unknown */ } }));
      P.wtok = tok;
    } catch { /* balances are optional */ }
    if (P.wpop) render();
  }
  function wpopHtml() {
    const list = P.wlist || [], sel = new Set(wallet.selected), ext = wallet.kind === 'external' && wallet.owner;
    const bal = (a) => (P.wbal?.has(a) ? `${fmtSol(P.wbal.get(a))} SOL` : '…');
    const tok = (a) => (P.wtok?.has(a) ? (P.wtok.get(a) > 0 ? num(P.wtok.get(a)) : '0') : '…');
    const rows = list.map((w) => `<label class="tp-wp-row${sel.has(w.address) ? ' on' : ''}"><input type="checkbox" data-wpick="${esc(w.address)}" ${sel.has(w.address) ? 'checked' : ''}><span class="nm"><b>${esc(w.name || short(w.address))}${w.address === wallet.owner ? ' <i>active</i>' : ''}</b><span class="ad">${esc(short(w.address))}<button type="button" class="tp-wp-cp" data-copy="${esc(w.address)}" title="Copy address" aria-label="Copy address">${ICON.copy}</button></span></span><span class="bl" title="SOL">${bal(w.address)}</span><span class="tk" title="${esc(sym())} held">${tok(w.address)}</span></label>`).join('');
    return `<div class="tp-wpop" role="dialog" aria-label="Wallets for this trade">
      <div class="tp-wp-h"><b>Trade with</b><span>${sel.size ? `${sel.size} of ${list.length} picked` : 'the active wallet only'}</span>${list.length ? '<button type="button" data-act="wp-all">Select all</button><button type="button" data-act="wp-funded">Select all with balance</button><button type="button" data-act="wp-none">None</button>' : ''}</div>
      ${ext ? `<p class="tp-wp-note">${esc(wallet.name || 'Your extension')} signs its own trades. Multi-wallet trades use wallets kept in Nought${list.length ? ': tick them below.' : '.'}</p>` : ''}
      ${list.length ? `<div class="tp-wp-list">${rows}</div>` : '<p class="tp-wp-note">No wallets kept in Nought yet.</p>'}
      <div class="tp-wp-f"><button type="button" data-act="max">Use max balance</button><button type="button" data-act="wp-new">+ Add wallets</button><button type="button" data-act="wp-manage">Manage</button></div>
    </div>`;
  }
  const balText = () => {
    if (!owners().length) return 'No wallet';
    if (!P.bal) return '…';
    if (P.side === 'buy') return `${fmtSol(P.bal.sol)} SOL`;
    return P.bal.tok ? `${num(P.bal.tok.ui)} ${esc(sym())}` : '—';
  };
  // the quick amounts: one row of equal cells under the amount box, the last one edits them
  const chipsHtml = (kind, list) => (P.editChips
    ? list.map((v, i) => `<input class="tp-chipin mono" data-chip="${i}" inputmode="decimal" value="${esc(String(v))}" aria-label="Quick amount ${i + 1}${kind === 'sell' ? ' (percent)' : ' (SOL)'}">`).join('')
    : list.map((v) => `<button type="button" class="tp-chip" data-amt="${esc(String(v))}" title="${kind === 'sell' ? `Sell ${esc(String(v))}%` : `${esc(String(v))} SOL`}">${esc(String(v))}${kind === 'sell' ? '%' : ''}</button>`).join(''))
    + `<button type="button" class="tp-edit${P.editChips ? ' on' : ''}" data-act="chips" title="${P.editChips ? 'Done' : 'Edit these amounts'}" aria-label="${P.editChips ? 'Done editing amounts' : 'Edit amounts'}">${P.editChips ? G.check : G.pen}</button>`;
  // the active preset in one line (slippage, priority, MEV mode); a click opens the preset editor
  const presetLine = () => {
    const p = preset(), pr = PRIO[p.prio], prot = p.mev === 'protected';
    const tip = `${p.name}: ${prot ? 'Jupiter Ultra (MEV-protected): Jupiter sets slippage and fees' : `${p.slippage}% slippage · ${pr?.label || ''} priority (up to ${pr?.max ?? '?'} SOL) · MEV protection off`}. Click to edit presets.`;
    return `<button type="button" class="tp-pline" data-act="settings" title="${esc(tip)}">${prot
      ? `<span>${G.shield}MEV-protected</span><i></i><span>Jupiter Ultra</span>`
      : `<span title="Slippage">${G.slip}${esc(String(p.slippage))}%</span><i></i><span title="Priority fee">${G.gas}${esc(pr?.label || '')}</span><i></i><span title="MEV protection">${G.shield}Off</span>`}<b>${esc(p.name)}</b></button>`;
  };
  // the amount box: a filled well with its label inside and the unit at the right, the quick row attached below
  const amtBox = (key, label, value, unit, aria, chipsRow = '', ph = '', size = '') => `<div class="tp-amtbox${size ? ' ' + size : ''}">
      <label class="tp-amt"><span class="tp-alb">${label}</span><input data-in="${key}" inputmode="decimal" autocomplete="off" spellcheck="false"${ph ? ` placeholder="${esc(ph)}"` : ''} value="${esc(value)}" aria-label="${esc(aria)}"><em>${unit}</em></label>
      ${chipsRow ? `<div class="tp-chips">${chipsRow}</div>` : ''}</div>`;

  function marketHtml() {
    const buy = P.side === 'buy', n = owners().length;
    return `
      ${amtBox('amt', 'Amount', P.amt[P.side], buy ? G.sol : '%', buy ? 'SOL to spend' : 'Percent to sell', chipsHtml(P.side, chips()[P.side]), '0.0')}
      ${presetLine()}
      ${n > 1 ? `<div class="tp-split">${buy ? (multiMode() === 'split' ? `Split evenly over ${n} wallets, all at once.` : `Each of ${n} wallets buys this amount at once (${+(parseAmount(String(P.amt.buy ?? '')) * n || 0).toFixed(4)} SOL in total).`) : `Each of ${n} wallets sells this share of its own balance, all at once.`} The quote is for one wallet.</div>` : ''}
      <button type="button" class="tp-go ${P.side}" data-act="go" data-go>${goText()}</button>
      <div class="tp-q" data-q>${quoteHtml()}</div>
      <div class="tp-dest" data-dest>${destText()}</div>`;
  }
  function quoteHtml() {
    // Jupiter busy / no route: an amber notice with a Retry; a problem with what was typed stays a plain line
    if (P.qErr && P.qRetry) return `<div class="tp-qwarn" role="alert"><span>${esc(P.qErr)}</span><button type="button" class="tp-link" data-act="requote">Retry</button></div>`;
    if (P.qErr) return `<div class="tp-qmsg${P.qBad ? ' bad' : ''}" role="alert">${esc(P.qErr)}</div>`;
    const d = P.qd;
    if (!d) return `<div class="tp-qmsg">${P.qBusy ? 'Getting a quote…' : 'Enter an amount to see a quote.'}</div>`;
    const buy = P.side === 'buy', w = impactWarning(d, liq());
    const out = buy ? `${num(d.outUi)} ${esc(sym())}` : `${fmtSol(d.outUi, 4)} SOL`, min = buy ? `${num(d.minOutUi)} ${esc(sym())}` : `${fmtSol(d.minOutUi, 4)} SOL`;
    const fees = d.fees.map((f) => `<div><span>${esc(f.label)}${f.note ? `<i>${esc(f.note)}</i>` : ''}</span><b>${f.sol != null ? (f.who === 'priority' && d.mode === 'standard' ? '≤ ' : '') + feeSol(f.sol) + ' SOL' : f.bps != null ? (f.bps / 100).toFixed(2) + '%' : f.who === 'pool' ? 'in price' : '—'}</b></div>`).join('');
    const impact = `${d.impactPct < 0.01 ? '<0.01' : d.impactPct.toFixed(2)}%`, impCls = d.impactPct >= DANGER_IMPACT ? 'down' : d.impactPct >= 5 ? 'warn' : '';
    // one line by default (what you get, impact, Nought's 0% fee); the breakdown with every fee is one click away.
    // A price-impact or liquidity warning always shows, open or not.
    const line = `<button type="button" class="tp-qline${P.qBusy ? ' busy' : ''}" data-act="qtoggle" aria-expanded="${P.qOpen}" title="${P.qOpen ? 'Hide' : 'Show'} the full quote: minimum received, route, slippage and every fee"><span class="out">≈ ${out}</span><span class="${impCls}">${impact} impact</span><span class="up">0% fee</span><svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="${P.qOpen ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    if (!P.qOpen) return `${P.qNote ? `<div class="tp-qnote" role="status">${esc(P.qNote)}</div>` : ''}${line}${w ? `<div class="tp-warn ${w.level}">${esc(w.text)}</div>` : ''}`;
    return `${P.qNote ? `<div class="tp-qnote" role="status">${esc(P.qNote)}</div>` : ''}${line}<div class="tp-qrows${P.qBusy ? ' busy' : ''}">
        <div class="tp-qout"><span>You get about</span><b>${out}</b></div>
        ${d.usdValue ? `<div><span>Value</span><b>${usd(d.usdValue, 2)}</b></div>` : ''}
        <div><span>Minimum received</span><b>${min}</b></div>
        <div><span>Price impact</span><b class="${d.impactPct >= DANGER_IMPACT ? 'down' : d.impactPct >= 5 ? 'warn' : ''}">${d.impactPct < 0.01 ? '<0.01' : d.impactPct.toFixed(2)}%</b></div>
        <div><span>Route</span><b>${esc(d.routeLabel)}${d.mode === 'protected' ? ' <i>Ultra</i>' : ''}</b></div>
        <div><span>Slippage</span><b>${d.mode === 'protected' ? 'set by Jupiter' : (d.slippageBps / 100).toFixed(1) + '%'}</b></div>
      </div>
      <div class="tp-fees"><div class="tp-n0"><span>Nought fee</span><b>0%</b></div>${fees}</div>
      ${w ? `<div class="tp-warn ${w.level}">${esc(w.text)}</div>` : ''}`;
  }
  function goText() {
    if (!owners().length) return 'Connect a wallet to trade';
    if (P.busy) return 'Waiting for your wallet…';
    const v = parseAmount(P.amt[P.side]);
    if (P.confirmUntil > Date.now()) return `Impact ${P.qd?.impactPct.toFixed(1)}%. Tap again to confirm`;
    // "Buy DOTS" with the amount in a lighter weight after it
    const name = esc(t().symbol || short(mint));
    return P.side === 'buy' ? `Buy ${name}${v > 0 ? `<small>${esc(String(v))} SOL</small>` : ''}` : `Sell ${name}${v > 0 ? `<small>${esc(String(Math.min(100, v)))}%</small>` : ''}`;
  }
  function destText() {
    const o = owners();
    if (!o.length) return 'Nought never holds your funds. Your wallet signs every trade.';
    const v = parseAmount(P.amt[P.side]);
    if (o.length > 1) return P.side === 'buy' ? `From ${o.length} wallets${v > 0 ? `, ${fmtSol(v / o.length, 4)} SOL each` : ''}. Coins land in the same wallets.` : `From ${o.length} wallets. SOL lands in the same wallets.`;
    return P.side === 'buy' ? `Paid from and delivered to <span class="mono">${esc(short(o[0]))}</span>` : `SOL goes to <span class="mono">${esc(short(o[0]))}</span>`;
  }

  // ---------- limit ----------
  const nowText = () => `Now: MC <b>${usd(mcNow())}</b> · price <b>${fmtPrice(priceNow())}</b>`;
  function limitHtml() {
    const buy = P.side === 'buy', mc = P.tkind === 'mc';
    return `
      ${amtBox('lamt', buy ? 'Spend' : 'Sell', P.lim.amt[P.side], buy ? G.sol : '%', buy ? 'SOL to spend' : 'Percent to sell')}
      <div class="tp-lbl"><span>${buy ? 'Buy when' : 'Sell when'} ${mc ? 'market cap' : 'price'} ${buy ? 'drops to' : 'rises to'}</span>${kindSeg()}</div>
      ${amtBox('target', mc ? 'Mkt cap' : 'Price', P.lim.target, '$', `Target ${mc ? 'market cap' : 'price'} in USD`, (buy ? [-10, -25, -50, -75] : [25, 50, 100, 200]).map((p) => `<button type="button" class="tp-chip" data-tgt="${p}" data-for="target" title="${p > 0 ? '+' : ''}${p}% from now">${p > 0 ? '+' : ''}${p}%</button>`).join(''), mc ? 'e.g. 25k' : 'e.g. 0.00002')}
      <div class="tp-now" data-now>${nowText()}</div>
      <div class="tp-lbl"><span>Expires</span><div class="tp-seg" role="group" aria-label="Expires">${EXPIRY.map(([s, l]) => `<button type="button" data-exp="${s}" class="${P.lim.exp === s ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div data-built>${builtHtml()}</div>
      <div class="tp-ol" data-orders>${ordersHtml()}</div>
      <p class="tp-fine">A limit order is a Jupiter Trigger order: it sits on-chain under your wallet and fills while you are away. Minimum $${MIN_LIMIT_USD}. Buys must sit below the current price, sells above. Jupiter takes its own fee when it fills. Nought takes nothing.</p>`;
  }
  const kindSeg = () => `<div class="tp-seg sm" role="group" aria-label="Target in"><button type="button" data-tkind="mc" class="${P.tkind === 'mc' ? 'on' : ''}">MC</button><button type="button" data-tkind="price" class="${P.tkind === 'price' ? 'on' : ''}">Price</button></div>`;
  function builtHtml() {
    if (P.building) return '<div class="tp-qmsg">Building the order with Jupiter…</div>';
    const b = P.built;
    if (!b) return `${P.buildErr ? `<div class="tp-warn danger">${esc(P.buildErr)}</div>` : ''}<button type="button" class="tp-go ${P.side}" data-act="review">${owners().length ? `Review limit ${P.side}` : 'Connect a wallet to place orders'}</button>`;
    const s = b.summary, buy = s.side === 'buy', sup = supplyOf(t(), ctx.pair()), mcOf = (p) => (sup > 0 && p > 0 ? ` <i>MC ${usd(p * sup)}</i>` : '');
    return `<div class="tp-review">
      <div class="tp-rh">Check before you sign</div>
      <div><span>You pay</span><b>${buy ? `${fmtSol(s.payUi, 4)} SOL` : `${num(s.payUi)} ${esc(sym())}`}</b></div>
      <div><span>You receive</span><b>${buy ? `${num(s.receiveUi)} ${esc(sym())}` : `${fmtSol(s.receiveUi, 4)} SOL`}</b></div>
      <div><span>Fills at</span><b>${fmtPrice(s.priceUsd)}${mcOf(s.priceUsd)}</b></div>
      <div><span>Now</span><b>${fmtPrice(s.nowUsd)}${mcOf(s.nowUsd)}</b></div>
      <div><span>Order size</span><b>${usd(s.makingUsd, 2)}</b></div>
      <div><span>Expires</span><b>${s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'Never'}</b></div>
      <div><span>Wallet</span><b class="mono">${esc(short(s.owner))}</b></div>
      <div class="tp-n0"><span>Nought fee</span><b>0%</b></div>
      ${s.fees.map((f) => `<div><span>${esc(f.label)}${f.note ? `<i>${esc(f.note)}</i>` : ''}</span><b>${f.bps != null ? (f.bps / 100).toFixed(2) + '%' : f.sol != null ? feeSol(f.sol) + ' SOL' : '—'}</b></div>`).join('')}
      <p class="tp-fine">The target is fixed in SOL at today's SOL price, so a big SOL move shifts it in dollars.</p>
      <div class="tp-two-b"><button type="button" class="btn" data-act="unbuild">Edit</button><button type="button" class="tp-go ${s.side}" data-act="place" ${P.placing ? 'disabled' : ''}>${P.placing ? 'Waiting for your wallet…' : `Place limit ${s.side}`}</button></div>
    </div>`;
  }
  function ordersHtml() {
    if (!wallet.owner) return '';
    if (P.ordersErr && !P.orders) return `<div class="tp-oh">Open orders</div><div class="tp-qmsg">${esc(P.ordersErr)}</div>`;
    if (!P.orders) return '<div class="tp-oh">Open orders</div><div class="tp-qmsg">Loading your open orders…</div>';
    if (!P.orders.length) return '<div class="tp-oh">Open orders</div><div class="tp-qmsg">No open limit orders on this coin.</div>';
    const s = solUsd();
    return `<div class="tp-oh">Open orders <span class="mono">${P.orders.length}</span></div>${P.orders.map((o) => `<div class="tp-orow">
      <span class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Buy' : 'Sell'}</span>
      <span class="mono">${o.side === 'buy' ? `${fmtSol(o.solUi, 3)} SOL` : `${num(o.tokensUi)}`}</span>
      <span class="mono" title="Trigger price">${o.priceSol && s ? fmtPrice(o.priceSol * s) : '—'}</span>
      <span class="mono dim">${o.filledPct ? o.filledPct.toFixed(0) + '%' : ''}</span>
      <button type="button" class="tp-x" data-cancel="${esc(o.id)}" title="Cancel this order (your wallet signs)">Cancel</button></div>`).join('')}`;
  }

  // ---------- advanced ----------
  function advHtml() {
    const migrated = !!t().migrated, mc = P.tkind === 'mc', n = owners().length;
    return `
      <div class="tp-tabnote">${ICON.bolt}<span>Works while this tab is open. ${esc(NEEDS_TAB.replace(/^Runs only while a Nought tab is open\.\s*/, ''))}</span></div>
      ${n > 1 ? `<div class="tp-split">Arms one set per selected wallet (${n}): sells in each wallet that holds the coin; a migration buy ${multiMode() === 'split' ? 'split evenly' : 'of this amount from each wallet'}.</div>` : ''}
      <h4 class="tp-h">Take-profit and stop-loss</h4>
      <div class="tp-lbl"><span>Sell this share when a level hits</span>${kindSeg()}</div>
      ${amtBox('apct', 'Sell', P.adv.pct, '%', 'Percent to sell')}
      <div class="tp-two">
        <div><div class="tp-lbl"><span class="up">Take profit</span></div>${amtBox('tp', mc ? 'MC' : 'Price', P.adv.tp, '$', `Take-profit ${mc ? 'market cap' : 'price'}`, [50, 100, 200].map((p) => `<button type="button" class="tp-chip" data-tgt="${p}" data-for="tp">+${p}%</button>`).join(''), '', 'sm')}</div>
        <div><div class="tp-lbl"><span class="down">Stop loss</span></div>${amtBox('sl', mc ? 'MC' : 'Price', P.adv.sl, '$', `Stop-loss ${mc ? 'market cap' : 'price'}`, [-20, -35, -50].map((p) => `<button type="button" class="tp-chip" data-tgt="${p}" data-for="sl">${p}%</button>`).join(''), '', 'sm')}</div>
      </div>
      <div class="tp-now" data-now>${nowText()}</div>
      <div data-adverr="tpsl">${advErrHtml('tpsl')}</div>
      <button type="button" class="tp-go2" data-act="arm-tpsl" ${P.arming ? 'disabled' : ''}>Arm take-profit / stop-loss</button>
      <h4 class="tp-h">On migration</h4>
      ${migrated ? '<div class="tp-qmsg">This coin has already migrated.</div>' : `
        <div class="tp-mig"><span>Buy</span><div class="tp-amt sm"><input data-in="mb" inputmode="decimal" value="${esc(P.adv.mb)}" aria-label="SOL to buy on migration"><em>SOL</em></div><button type="button" class="btn" data-act="arm-mb" ${P.arming ? 'disabled' : ''}>Arm</button></div>
        <div class="tp-mig"><span>Sell</span><div class="tp-amt sm"><input data-in="ms" inputmode="decimal" value="${esc(P.adv.ms)}" aria-label="Percent to sell on migration"><em>%</em></div><button type="button" class="btn" data-act="arm-ms" ${P.arming ? 'disabled' : ''}>Arm</button></div>
        <div data-adverr="mig">${advErrHtml('mig')}</div>`}
      <div class="tp-armed" data-armed>${armedHtml()}</div>
      <p class="tp-fine">Armed orders live in this browser. Nought checks the price every 2 s and listens for the migration, then trades with the preset selected when you armed it (${esc(preset().name)}). If routing isn't ready at migration, it retries for 30 s.</p>`;
  }
  // an arming error shows next to the button that caused it
  const advErrHtml = (at) => (P.advErr && P.advErrAt === at ? `<div class="tp-warn danger" role="alert">${esc(P.advErr)}</div>` : '');
  function armedHtml() {
    const list = armed.list({ mint });
    if (!list.length) return '<div class="tp-oh">Armed on this coin</div><div class="tp-qmsg">Nothing armed yet.</div>';
    const sup = supplyOf(t(), ctx.pair());
    return `<div class="tp-oh">Armed on this coin <span class="mono">${list.length}</span>${list.some((a) => !['armed', 'held', 'firing'].includes(a.status)) ? '<button type="button" class="tp-link" data-act="clear-armed">Clear finished</button>' : ''}</div>${list.map((a) => {
      const what = a.kind === 'migrate-buy' ? `${+Number(a.sol).toFixed(4)} SOL` : `${Number(a.pct) || 0}%`;
      const at = a.triggerUsd ? (a.mc ? `MC ${usd(a.mc)}` : fmtPrice(a.triggerUsd)) : a.kind.startsWith('migrate') ? 'at migration' : '';
      const mcTip = a.triggerUsd && sup > 0 ? 'MC ' + usd(a.triggerUsd * sup) : '';
      return `<div class="tp-orow tp-arow"><span class="tp-ak" title="${esc(armed.KIND_LABEL[a.kind] || a.kind)} · wallet ${esc(a.owner || '')}"><b class="${a.kind === 'sl' || a.kind === 'migrate-sell' ? 'down' : 'up'}">${esc(KIND_SHORT[a.kind] || a.kind)}</b><i>${esc(short(a.owner || ''))}</i></span><span class="mono">${esc(what)}</span><span class="mono" title="${esc(mcTip)}">${esc(at)}</span><span class="tp-badge ${esc(a.status)}" title="${esc(a.note || '')}">${esc(a.status)}</span><button type="button" class="tp-x" data-disarm="${esc(a.id)}" title="${a.status === 'armed' || a.status === 'held' ? 'Disarm' : 'Remove'}" aria-label="${a.status === 'armed' || a.status === 'held' ? 'Disarm' : 'Remove'}">×</button></div>`;
    }).join('')}`;
  }

  // ---------- position ----------
  // Bought | Sold | Holding | PnL in one row with dividers (SOL amounts); without a wallet or a position read the cells
  // show a dash and the line under them says why
  function posHtml() {
    const p = P.pos, n = owners().length;
    const cell = (label, val, sub = '', c = '') => `<div><span>${label}</span><b class="${c}">${val}</b>${sub ? `<i class="${c === 'up' || c === 'down' ? c : ''}">${sub}</i>` : ''}</div>`;
    if (!n || !p) return `<div class="tp-pgrid">${['Bought', 'Sold', 'Holding', 'PnL'].map((l) => cell(l, '—', '', 'dim')).join('')}</div><div class="tp-punit">${!n ? 'Connect a wallet to see what you hold.' : P.posBusy ? 'Reading your position…' : 'Position unavailable right now.'}</div>`;
    const c = p.pnlSol > 0 ? 'up' : p.pnlSol < 0 ? 'down' : '', none = !p.buys && !p.sells && !(p.holdUi > 0);
    // SOL or dollars (at today's SOL price), flipped with the ⇄ button or by clicking the row
    const s = solUsd(), inUsd = P.posUsd && s > 0, v = (sol) => (inUsd ? usd(sol * s) : fmtSol(sol));
    return `<div class="tp-pgrid" data-act="posunit" title="Click to show ${inUsd ? 'SOL' : 'dollars'}">
      ${cell('Bought', v(p.boughtSol), `${p.buys} buy${p.buys === 1 ? '' : 's'}`, p.boughtSol > 0 ? 'up' : '')}
      ${cell('Sold', v(p.soldSol), `${p.sells} sell${p.sells === 1 ? '' : 's'}`, p.soldSol > 0 ? 'down' : '')}
      ${cell('Holding', p.holdSol != null ? v(p.holdSol) : '—', `${num(p.holdUi)}${p.holdKnown ? '' : '?'}`)}
      ${cell('PnL', signed(p.pnlSol, inUsd ? usd(Math.abs(p.pnlSol) * s) : fmtSol(p.pnlSol)), p.pnlPct != null ? signed(p.pnlPct, p.pnlPct.toFixed(1) + '%') : p.pnlUsd != null ? usd(p.pnlUsd) : '', c)}
    </div>${p.avgEntryMc || p.avgExitMc ? `<div class="tp-avg">${p.avgEntryMc ? `<span>Avg entry <b class="up">${usd(p.avgEntryMc)}</b> MC</span>` : ''}${p.avgExitMc ? `<span>Avg exit <b class="down">${usd(p.avgExitMc)}</b> MC</span>` : ''}</div>` : ''}<div class="tp-punit">${none ? 'No position yet · ' : ''}${n > 1 ? `${n} wallets · ` : ''}<button type="button" class="tp-link" data-act="posunit" title="Show amounts in ${inUsd ? 'SOL' : 'dollars'}">⇄ ${inUsd ? 'USD' : 'SOL'}</button>${!inUsd && p.pnlUsd != null ? ` · PnL ${usd(p.pnlUsd, 2)}` : ''}${p.buys > 0 ? `<button type="button" class="tp-link" data-act="share" title="Make a PnL card to share">${ICON.share || ''}Share PnL</button>` : ''}<button type="button" class="tp-link" data-act="instant" title="Open the floating Instant trade panel">${ICON.bolt}Instant</button></div>`;
  }

  // ---------- partial updates (inputs keep focus) ----------
  function upd() {
    if (!P.alive) return;
    const set = (sel, html) => { const n = q(sel); if (n && n.innerHTML !== html) n.innerHTML = html; };
    set('[data-q]', quoteHtml());
    const g = q('[data-go]'); if (g) { g.innerHTML = goText(); g.disabled = P.busy; g.classList.toggle('confirm', P.confirmUntil > Date.now()); }
    set('[data-dest]', destText());
    el.querySelectorAll('[data-bal]').forEach((b) => { if (b.innerHTML !== balText()) b.innerHTML = balText(); });
    set('[data-built]', builtHtml());
    set('[data-orders]', ordersHtml());
    set('[data-armed]', armedHtml());
    el.querySelectorAll('[data-adverr]').forEach((n) => { const h = advErrHtml(n.dataset.adverr); if (n.innerHTML !== h) n.innerHTML = h; });
    set('[data-now]', nowText());
    set('[data-pos]', posHtml());
  }

  // ---------- data ----------
  function requote(delay = 350) {
    clearTimeout(P.qTimer);
    if (P.mode !== 'market') return;
    P.qTimer = setTimeout(doQuote, delay);
  }
  // what the market box asks for right now: {raw (per wallet), key} | {err} | {empty} | {needBal}
  function ask() {
    const buy = P.side === 'buy', str = String(P.amt[P.side] ?? '').trim(), v = parseAmount(str), n = owners().length;
    if (!str) return { empty: true };
    if (!(v > 0)) return { err: Number.isNaN(v) ? (buy ? 'Not a SOL amount. Type it like 0.5 or 0,5: one "." or "," for decimals, no thousands separators.' : 'Not a share. Type a percent like 50 or 12,5.') : 'Enter an amount above 0.' };
    if (!buy && v > 100) return { err: 'Pick a share from 1 to 100%.' };
    if (buy && v > 100000) return { err: 'That is more SOL than Nought will send in one go.' };
    let raw;
    if (buy) raw = BigInt(Math.round(perWalletSol(v, Math.max(1, n)) * 1e9));
    else {
      if (!n) return { err: 'Connect a wallet to quote a sale.', soft: true };
      const tok = P.bal?.tok;
      if (!P.bal || P.balOwner !== owners()[0]) return { needBal: true };
      if (!tok) return { err: 'Could not read your balance. Try again in a moment.', soft: true };
      if (!(tok.raw > 0n)) return { err: 'You hold none of this coin.', soft: true };
      raw = v >= 100 ? tok.raw : (tok.raw * BigInt(Math.round(v * 100))) / 10000n;
    }
    if (raw <= 0n) return { err: 'That amount rounds to zero.', soft: true };
    const p = preset();
    return { v, raw, key: [P.side, raw, settings.preset, p.slippage, p.mev, p.prio, owners().join(','), multiMode()].join('|') };
  }
  // the quote on screen still matches the box, the preset and the wallets, and is recent
  const quoteFresh = () => { const a = ask(); return !!(P.qd && P.q && !P.qBusy && a.key && a.key === P.q.key && Date.now() - P.q.at < QUOTE_TTL); };
  async function doQuote() {
    const seq = ++P.qSeq, buy = P.side === 'buy';
    P.qErr = ''; P.qBad = false; P.qRetry = false; P.confirmUntil = 0;
    let a = ask();
    if (a.needBal) { P.qBusy = true; upd(); await loadBal(); if (seq !== P.qSeq || !P.alive) return; a = ask(); if (a.needBal) a = { err: 'Could not read your balance. Try again in a moment.', soft: true }; }
    if (a.empty || a.err) { P.qd = null; P.q = null; P.qBusy = false; P.qErr = a.err || ''; P.qBad = !!a.err && !a.soft; upd(); return; }
    P.qBusy = true; upd();
    try {
      const quote = await quoteFor(buy ? SOL_MINT : mint, buy ? mint : SOL_MINT, a.raw.toString(), { preset: settings.preset });
      if (seq !== P.qSeq || !P.alive) return;
      // the minimum shown is exactly the one the trade insists on (core's own figure when it gives one)
      const d = quoteDetails(quote, { inDec: buy ? 9 : dec(), outDec: buy ? dec() : 9, prio: preset().prio }), minOutRaw = d.minOutRaw || quotedMin(quote);
      if (!minOutRaw || !(BigInt(minOutRaw) > 0n)) throw new Error('Jupiter sent a quote without a minimum. Try again.');
      d.minOutUi = Number(minOutRaw) / 10 ** (buy ? dec() : 9);
      P.qd = d; P.q = { key: a.key, at: Date.now(), raw: a.raw, minOutRaw, impactPct: d.impactPct };
    } catch (e) {
      if (seq !== P.qSeq || !P.alive) return;
      const m = String(e?.message || '');
      P.qd = null; P.q = null; P.qRetry = true; P.qErr = /route|tradable|liquidity|COULD_NOT_FIND/i.test(m) ? 'No route for this coin yet. Fresh coins can take a few seconds to show up.' : /rate limit|too many|429/i.test(m) ? 'Jupiter is busy right now. Trying again in a few seconds.' : m || 'No quote right now.';
    }
    P.qBusy = false; upd();
  }
  async function loadBal() {
    if (!P.alive) return;
    const owner = owners()[0];
    if (!owner) { P.bal = null; upd(); return; }
    // one Jupiter balances call gives SOL and the coin; holding() (Jupiter, then the token accounts over RPC) only when
    // Jupiter didn't answer or a trade just landed (its index can trail a fresh fill by a few seconds)
    const b = await ju.balances(owner).catch(() => null), e = b?.tokens?.[mint], fresh = Date.now() - P.tradedAt < 60000;
    let h;
    if (b && !fresh) h = e && BigInt(e.raw || 0) > 0n ? { raw: BigInt(e.raw), dec: e.dec ?? dec(), ui: Number(e.ui) || 0, frozen: !!e.frozen } : { raw: 0n, dec: dec(), ui: 0, frozen: false };
    else h = await holding(mint, owner).catch(() => null);
    // Jupiter busy: read the SOL straight from the chain
    const sol = b?.sol ?? await rpc('getBalance', [owner, { commitment: 'confirmed' }]).then((r) => r.value / 1e9).catch(() => null);
    if (!P.alive || owners()[0] !== owner) return;
    P.bal = { sol: sol ?? P.bal?.sol ?? null, tok: h ?? P.bal?.tok ?? null }; P.balOwner = owner;
    upd();
  }
  async function loadPos(force = false) {
    if (!P.alive) return;
    if (!owners().length) { P.pos = null; upd(); return; }
    P.posBusy = true; if (!P.pos) upd();
    try { const p = await loadPosition(mint, { force }); if (P.alive) P.pos = p; } catch { /* keep the last one */ }
    P.posBusy = false; upd();
  }
  async function loadOrders(force = false) {
    if (!P.alive || !wallet.owner || P.mode !== 'limit') return;
    try { const r = await openOrders(mint, force); if (!P.alive) return; P.orders = r.orders; P.ordersErr = ''; }
    catch (e) { if (!P.alive) return; P.ordersErr = /rate|too many|429|busy/i.test(e?.message || '') ? 'Jupiter is busy. Your orders load in a moment.' : 'Could not load your open orders.'; }
    upd();
  }
  // re-derive the position's value from the latest price without another fetch
  function repricePos() {
    const p = P.pos, pUsd = priceNow(), s = solUsd();
    if (!p || !pUsd) return;
    p.holdUsd = p.holdUi * pUsd; p.holdSol = s > 0 ? p.holdUsd / s : null;
    p.pnlSol = p.holdSol != null ? p.soldSol + p.holdSol - p.boughtSol : null;
    p.pnlUsd = p.pnlSol != null && s > 0 ? p.pnlSol * s : null;
    p.pnlPct = p.pnlSol != null && p.boughtSol > 0 ? (p.pnlSol / p.boughtSol) * 100 : null;
  }

  // drop a built (or still building) limit order: its inputs changed, so it no longer matches what's on screen
  function unbuild() { P.built = null; P.bSeq++; P.building = false; P.buildErr = ''; }

  // ---------- actions ----------
  // trades only from the quote on screen: a missing or stale one is fetched and shown first, and the next press trades
  async function goMarket() {
    if (!needWallet() || P.busy) return;
    const buy = P.side === 'buy', a = ask();
    if (a.err || a.empty) { P.qErr = a.err || (buy ? 'Enter how much SOL to spend.' : 'Enter a share to sell.'); P.qBad = !a.soft; P.qRetry = false; P.qd = null; upd(); q('[data-in="amt"]')?.focus(); return; }
    // one press trades: a stale quote is refreshed first, and the trade still enforces that quote's minimum and impact cap
    if (!quoteFresh()) {
      clearTimeout(P.qTimer); P.busy = true; P.qNote = 'Getting a fresh quote…'; upd();
      try { await doQuote(); } finally { P.busy = false; P.qNote = ''; }
      if (!P.alive || !quoteFresh()) { upd(); return; }
    }
    const d = P.qd, w = impactWarning(d, liq()), now = Date.now();
    // a high-impact trade needs a second, deliberate press (not a double-click or a held Enter)
    if (w?.level === 'danger' && !(P.confirmUntil > now && now - P.confirmAt > 600)) { P.confirmUntil = now + 8000; P.confirmAt = now; upd(); setTimeout(upd, 8100); return; }
    // the trade re-quotes when it is built: it refuses if the impact jumps well past what you saw, and (minOutRaw) if
    // the new quote can't guarantee the minimum shown here
    const maxImpactPct = w?.level === 'danger' ? Math.min(99, d.impactPct + 10) : Math.max(DANGER_IMPACT, d.impactPct + 5);
    const quoted = { raw: P.q.raw, minOutRaw: P.q.minOutRaw, impactPct: P.q.impactPct };
    P.busy = true; P.confirmUntil = 0; P.qNote = ''; upd();
    try { if (buy) await buyAcross(mint, a.v, { maxImpactPct, quoted }); else await sellAcross(mint, Math.min(100, a.v), { maxImpactPct, quoted }); }
    catch (e) { if ((await maybeLanded(e)) == null) toast(esc(e.message || 'The trade did not go through.'), 'err'); }
    P.busy = false; if (!P.alive) return;
    // this quote is spent: the next press needs a new one
    P.qd = null; P.q = null; P.tradedAt = Date.now(); upd(); P.bal = null; loadBal().then(() => requote(0)); setTimeout(() => loadPos(true), 2500);
  }
  async function review() {
    if (!needWallet()) return;
    const buy = P.side === 'buy', v = parseAmount(P.lim.amt[P.side]), target = parseTarget(P.lim.target), kind = P.tkind === 'mc' ? 'market cap' : 'price';
    P.buildErr = '';
    if (Number.isNaN(v) && String(P.lim.amt[P.side]).trim()) { P.buildErr = buy ? 'Not a SOL amount. Type it like 0.5 or 0,5: one "." or "," for decimals, no thousands separators.' : 'Not a share. Type a percent like 50.'; upd(); return; }
    if (!(v > 0)) { P.buildErr = buy ? 'Enter how much SOL to spend.' : 'Enter a share to sell.'; upd(); return; }
    if (!buy && v > 100) { P.buildErr = 'Pick a share from 1 to 100%.'; upd(); return; }
    if (Number.isNaN(target) && String(P.lim.target).trim()) { P.buildErr = `Not a ${kind} Nought can read. Type it like ${P.tkind === 'mc' ? '25k, 1.5m or 25,000' : '0.00042'} (a lone "1,500" is unclear: write 1500 or 1.5k).`; upd(); return; }
    if (!(target > 0)) { P.buildErr = `Enter a target ${kind}.`; upd(); return; }
    const seq = ++P.bSeq;
    P.building = true; upd();
    try {
      let amountRaw, sellDec = null;
      if (buy) amountRaw = BigInt(Math.floor(v * 1e9));
      else {
        const h = await holding(mint, wallet.owner);
        if (!(h.raw > 0n)) throw new Error('You hold none of this coin.');
        const p = Math.min(100, v); amountRaw = p >= 100 ? h.raw : (h.raw * BigInt(Math.round(p * 100))) / 10000n; sellDec = h.dec;
      }
      const built = await limit.build({ side: P.side, mint, amountRaw, target, targetKind: P.tkind, expiresInSec: P.lim.exp || undefined, owner: wallet.owner, ...(sellDec != null && { decimals: sellDec }) });
      if (!P.alive || seq !== P.bSeq) return;
      P.built = built; P.builtAt = Date.now();
    } catch (e) { if (!P.alive || seq !== P.bSeq) return; P.buildErr = e.message || 'Jupiter could not build this order.'; }
    P.building = false; upd();
  }
  async function place() {
    const b = P.built; if (!b || P.placing) return;
    if (Date.now() - P.builtAt > 50000) { P.built = null; P.buildErr = 'That review is almost a minute old, so its transaction may expire. Review it again.'; upd(); return; }
    P.placing = true; upd();
    try { const r = await limit.submit(b); if (P.alive && r.status !== 'failed') { P.built = null; P.lim.target = ''; const i = q('[data-in="target"]'); if (i) i.value = ''; } }
    catch (e) { const r = await maybeLanded(e); if (r == null) toast(esc(e.message || 'The order was not placed.'), 'err'); else if (P.alive) P.built = null; }
    P.placing = false; if (P.alive) { upd(); loadOrders(true); }
  }
  // Armed orders follow the wallet selection like market trades do: one set of legs per selected wallet (tradeOwners()).
  // Sells (TP/SL, sell on migration) go to the wallets that hold the coin; a buy on migration splits its SOL evenly.
  async function sellers() {
    const list = owners(), held = await Promise.all(list.map((o) => holding(mint, o).then((h) => h.raw > 0n, () => null)));
    // a wallet whose balance didn't load is kept: a stop-loss that finds nothing to sell is better than a missing one
    const out = list.filter((o, i) => held[i] !== false);
    if (!out.length) throw new Error(list.length > 1 ? `None of your ${list.length} selected wallets holds ${sym()}.` : `This wallet holds no ${sym()}.`);
    return out;
  }
  const walletsText = (list) => (list.length === 1 ? `wallet ${short(list[0])}` : `${list.length} wallets (${list.slice(0, 3).map((o) => short(o)).join(', ')}${list.length > 3 ? ` +${list.length - 3}` : ''})`);
  async function arm(kind) {
    if (!needWallet() || P.arming) return;
    P.arming = true; P.advErr = ''; upd();
    const added = [];
    const add = async (spec) => { const a = await armed.add({ ...spec, mint, preset: settings.preset }); added.push(a.id); return a; };
    try {
      if (kind === 'tpsl') {
        const pct = parseAmount(P.adv.pct), tp = String(P.adv.tp).trim() ? parseTarget(P.adv.tp) : 0, sl = String(P.adv.sl).trim() ? parseTarget(P.adv.sl) : 0;
        const fmtHint = P.tkind === 'mc' ? '25k, 1.5m or 25,000' : '0.00042';
        if (!(pct > 0 && pct <= 100)) throw new Error(Number.isNaN(pct) ? 'Not a share. Type a percent like 50.' : 'Pick a share to sell, 1 to 100%.');
        if (Number.isNaN(tp) || Number.isNaN(sl)) throw new Error(`The ${Number.isNaN(tp) ? 'take-profit' : 'stop-loss'} is not a ${P.tkind === 'mc' ? 'market cap' : 'price'} Nought can read. Type it like ${fmtHint} (a lone "1,500" is unclear).`);
        if (!(tp > 0) && !(sl > 0)) throw new Error('Enter a take-profit, a stop-loss, or both.');
        // check both legs first, so a bad stop-loss never leaves a lone take-profit armed
        const now = P.tkind === 'mc' ? mcNow() : priceNow(), fmt = (v) => (P.tkind === 'mc' ? 'MC ' + usd(v) : fmtPrice(v));
        if (now > 0 && tp > 0 && tp <= now) throw new Error(`The take-profit must be above now (${fmt(now)}).`);
        if (now > 0 && sl > 0 && sl >= now) throw new Error(`The stop-loss must be below now (${fmt(now)}).`);
        const list = await sellers();
        // each wallet's take-profit and stop-loss cancel each other (armed.bracket checks both before saving either);
        // other wallets' legs are separate
        for (const owner of list) {
          const legs = await armed.bracket(mint, { pct, tp: tp > 0 ? tp : undefined, sl: sl > 0 ? sl : undefined, targetKind: P.tkind, preset: settings.preset, owner });
          added.push(...legs.map((a) => a.id));
        }
        const what = [tp > 0 && 'take-profit', sl > 0 && 'stop-loss'].filter(Boolean).join(' and ');
        toast(`Armed ${what} (sell ${esc(String(pct))}%) for ${esc(sym())} in ${esc(walletsText(list))}. Keep a Nought tab open.`, 'ok');
        P.adv.tp = ''; P.adv.sl = '';
      } else if (kind === 'mb') {
        const sol = parseAmount(P.adv.mb);
        if (!(sol > 0)) throw new Error(Number.isNaN(sol) ? 'Not a SOL amount. Type it like 0.5 or 0,5.' : 'Enter how much SOL to buy with.');
        if (sol > 100000) throw new Error('That is more SOL than Nought will send in one go.');
        const list = owners(), each = perWalletSol(sol, list.length);
        if (!(Math.floor(each * 1e9) > 0)) throw new Error('That amount is too small to split.');
        for (const owner of list) await add({ kind: 'migrate-buy', sol: each, owner });
        toast(`Armed: buy ${esc(String(+(each * list.length).toFixed(6)))} SOL of ${esc(sym())} when it migrates${list.length > 1 ? `, ${esc(String(+each.toFixed(6)))} SOL each from ${esc(walletsText(list))}` : ` from ${esc(walletsText(list))}`}. Keep a Nought tab open.`, 'ok');
      } else {
        const pct = parseAmount(P.adv.ms);
        if (!(pct > 0 && pct <= 100)) throw new Error(Number.isNaN(pct) ? 'Not a share. Type a percent like 50.' : 'Pick a share to sell, 1 to 100%.');
        const list = await sellers();
        for (const owner of list) await add({ kind: 'migrate-sell', pct, owner });
        toast(`Armed: sell ${esc(String(pct))}% of ${esc(sym())} when it migrates, in ${esc(walletsText(list))}. Keep a Nought tab open.`, 'ok');
      }
    } catch (e) {
      added.forEach((id) => armed.remove(id)); // all or nothing: never leave some wallets armed and others not
      P.advErr = e.message || 'Could not arm that order.'; P.advErrAt = kind === 'tpsl' ? 'tpsl' : 'mig';
    }
    P.arming = false; if (P.alive) render();
  }
  function fillTarget(pctMove, field) {
    const base = P.tkind === 'mc' ? mcNow() : priceNow();
    if (!(base > 0)) { toast('No live price yet. Enter a target by hand.', 'err'); return; }
    const v = base * (1 + pctMove / 100), s = P.tkind === 'mc' ? (v >= 1e6 ? (v / 1e6).toFixed(2) + 'm' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : v.toFixed(0)) : plainNum(v);
    if (field === 'target') { P.lim.target = s; unbuild(); } else P.adv[field] = s;
    const i = q(`[data-in="${field}"]`); if (i) i.value = s;
    upd();
  }

  el.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || !el.contains(b)) return;
    const d = b.dataset;
    if (d.side && d.side !== P.side) { P.side = d.side; LS.set('tp.side', P.side); P.qd = null; P.q = null; P.qNote = ''; unbuild(); render(); return; }
    if (d.mode && d.mode !== P.mode) { P.mode = d.mode; LS.set('tp.mode', P.mode); P.qNote = ''; P.advErr = ''; unbuild(); render(); return; }
    if (d.pre != null) { setSettings({ preset: Number(d.pre) }); return; }
    if (d.amt != null) { P.amt[P.side] = d.amt; const i = q('[data-in="amt"]'); if (i) i.value = d.amt; P.qd = null; P.q = null; P.qNote = ''; requote(0); upd(); return; }
    if (d.tgt != null) { fillTarget(Number(d.tgt), d.for); return; }
    if (d.tkind && d.tkind !== P.tkind) { P.tkind = d.tkind; LS.set('tp.tkind', P.tkind); P.lim.target = ''; P.adv.tp = ''; P.adv.sl = ''; unbuild(); render(); return; }
    if (d.exp != null) { P.lim.exp = Number(d.exp); LS.set('tp.exp', P.lim.exp); unbuild(); el.querySelectorAll('[data-exp]').forEach((x) => x.classList.toggle('on', x === b)); upd(); return; }
    if (d.cancel) { b.disabled = true; limit.cancel(d.cancel).catch(async (err) => { if ((await maybeLanded(err)) == null) toast(esc(err.message || 'Could not cancel.'), 'err'); }).finally(() => loadOrders(true)); return; }
    if (d.disarm) { armed.remove(d.disarm); upd(); return; }
    switch (d.act) {
      case 'go': goMarket(); break;
      case 'requote': requote(0); break;
      case 'qtoggle': P.qOpen = !P.qOpen; LS.set('panel.quote.open', P.qOpen); upd(); break;
      case 'chips': P.editChips = !P.editChips; render(); break;
      case 'max': {
        if (!owners().length) { needWallet(); break; }
        const buy = P.side === 'buy', key = P.mode === 'limit' ? 'lim' : 'amt';
        const v = buy ? (P.bal?.sol > 0.011 ? String(Math.floor((P.bal.sol - 0.01) * 1000) / 1000) : '') : '100';
        if (!v) break;
        if (key === 'lim') { P.lim.amt[P.side] = v; unbuild(); const i = q('[data-in="lamt"]'); if (i) i.value = v; upd(); }
        else { P.amt[P.side] = v; const i = q('[data-in="amt"]'); if (i) i.value = v; requote(0); }
        break;
      }
      case 'settings': import('../../ui/shell.js').then((m) => m.openSettings()).catch(() => {}); break;
      case 'review': review(); break;
      case 'unbuild': unbuild(); upd(); break;
      case 'place': place(); break;
      case 'arm-tpsl': arm('tpsl'); break;
      case 'arm-mb': arm('mb'); break;
      case 'arm-ms': arm('ms'); break;
      case 'clear-armed': armed.clearFinished(); upd(); break;
      case 'instant': openInstant(mint); break;
      case 'posunit': P.posUsd = !P.posUsd; LS.set('tp.posUsd', P.posUsd); { const r = q('[data-pos]'); if (r) r.innerHTML = posHtml(); } break;
      case 'wallets': if (!owners().length && !wallet.owner) { needWallet(); break; } P.wpop = !P.wpop; if (P.wpop) loadWpop(); render(); break;
      case 'wp-all': (async () => { for (const w of (await V.list()).slice(0, MAX_SELECTED)) if (!wallet.selected.includes(w.address)) selectWallet(w.address, true); })().catch((err) => toast(esc(err.message), 'err')); break;
      case 'wp-none': for (const a of [...wallet.selected]) selectWallet(a, false); break;
      case 'wp-funded': {
        // buying needs SOL; selling needs this coin
        const has = (a) => (P.side === 'sell' ? (P.wtok?.get(a) || 0) > 0 : (P.wbal?.get(a) || 0) > 0.002);
        for (const w of P.wlist || []) { const want = has(w.address); if (want !== wallet.selected.includes(w.address)) { try { selectWallet(w.address, want); } catch { /* the 25-wallet cap */ } } }
        break;
      }
      case 'wp-new': case 'wp-manage': P.wpop = false; render(); import('../../ui/wallets.js').then((m) => m.openWalletManager(d.act === 'wp-new' ? 'new' : 'home')).catch(() => {}); break;
      case 'share': {
        const p = P.pos; if (!p) break;
        import('../../ui/pnlcard.js').then((m) => m.openPnlCard({ mint, symbol: t().symbol || '', image: t().image || '', investedSol: p.boughtSol, soldSol: p.soldSol, pnlSol: p.pnlSol, pnlPct: p.pnlPct, pnlUsd: p.pnlUsd, avgEntryMc: p.avgEntryMc, avgExitMc: p.avgExitMc })).catch(() => toast('Could not open the PnL card.', 'err'));
        break;
      }
      default:
    }
  });
  el.addEventListener('change', (e) => {
    const c = e.target.closest?.('[data-wpick]'); if (!c) return;
    try { selectWallet(c.dataset.wpick, c.checked); } catch (err) { c.checked = !c.checked; toast(esc(err.message || 'Could not change the wallet selection.'), 'err'); }
  });
  const closeWpop = (e) => { if (P.wpop && !e.target.closest?.('.tp-wpop, [data-act="wallets"]')) { P.wpop = false; render(); } };
  const escWpop = (e) => { if (P.wpop && e.key === 'Escape') { P.wpop = false; render(); } };
  document.addEventListener('pointerdown', closeWpop, true); document.addEventListener('keydown', escWpop);
  const followWpop = () => { if (P.wpop) placeWpop(); };
  addEventListener('scroll', followWpop, true); addEventListener('resize', followWpop);
  if (!document.getElementById('tp-wpop-css')) {
    const st = document.createElement('style'); st.id = 'tp-wpop-css';
    st.textContent = `.tp-modes { position: relative; }
.tp-wpop { position: absolute; z-index: 30; right: 0; top: calc(100% + 6px); width: min(320px, calc(100vw - 24px)); display: grid; gap: 8px; padding: 10px; border: 1px solid var(--line-2); border-radius: 10px; background: var(--panel-2, var(--panel)); box-shadow: var(--shadow-lg, 0 18px 44px rgba(0,0,0,.55)); font-size: 12.5px; }
.tp-wp-h { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; } .tp-wp-h span { flex: 1 1 calc(100% - 100px); color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tp-wp-h button, .tp-wp-f button { padding: 5px 9px; border: 1px solid var(--line-2); border-radius: 999px; background: none; color: var(--fg); font: 500 11.5px/1 var(--sans); cursor: pointer; }
.tp-wp-h button:hover, .tp-wp-f button:hover { border-color: var(--accent); }
.tp-wp-list { display: grid; gap: 2px; max-height: 240px; overflow-y: auto; }
.tp-wp-row { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 10px; padding: 8px; border-radius: 7px; cursor: pointer; }
.tp-wp-row .nm { display: grid; gap: 2px; min-width: 0; } .tp-wp-row .nm b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tp-wp-row .bl, .tp-wp-row .tk { padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 11.5px; white-space: nowrap; }
.tp-wp-cp { all: unset; cursor: pointer; display: inline-grid; margin-left: 4px; vertical-align: -2px; color: var(--muted); } .tp-wp-cp svg { width: 11px; height: 11px; }
.tp-wpop { position: fixed; z-index: 80; right: auto; overflow-y: auto; }
.tp-wp-row:hover, .tp-wp-row.on { background: var(--fill-1, rgba(255,255,255,.04)); }
.tp-wp-row .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; } .tp-wp-row .nm i { font-style: normal; color: var(--accent); font-size: 11px; }
.tp-wp-row .ad { color: var(--muted); font-size: 11px; } .tp-wp-row .bl { font-variant-numeric: tabular-nums; }
.tp-wp-note { margin: 0; color: var(--muted); font-size: 11.5px; line-height: 1.4; }
.tp-wp-f { display: flex; flex-wrap: wrap; gap: 6px; }
.tp-avg { display: flex; justify-content: space-between; gap: 10px; padding: 6px 2px 0; color: var(--muted); font-size: 12px; }
.tp-avg b { font-weight: 600; font-variant-numeric: tabular-nums; } .tp-avg b.up { color: var(--up); } .tp-avg b.down { color: var(--down); }`;
    document.head.appendChild(st);
  }
  el.addEventListener('input', (e) => {
    const i = e.target, k = i.dataset?.in; if (!k) return;
    if (k === 'amt') { P.amt[P.side] = i.value; P.qd = null; P.q = null; P.qNote = ''; P.qBusy = parseAmount(i.value) > 0; upd(); requote(); }
    else if (k === 'lamt') { P.lim.amt[P.side] = i.value; if (P.built || P.building) { unbuild(); upd(); } }
    else if (k === 'target') { P.lim.target = i.value; if (P.built || P.building) { unbuild(); upd(); } }
    else if (k === 'apct' || k === 'tp' || k === 'sl' || k === 'mb' || k === 'ms') { P.adv[k === 'apct' ? 'pct' : k] = i.value; if (P.advErr) { P.advErr = ''; upd(); } }
  });
  el.addEventListener('change', (e) => {
    const i = e.target; if (!i.classList?.contains('tp-chipin')) return;
    const c = chips(), v = parseAmount(i.value), idx = Number(i.dataset.chip), max = P.side === 'buy' ? 1000 : 100;
    if (v > 0 && v <= max) { c[P.side][idx] = v; i.value = String(v); LS.set('tp.chips', c); }
    else { toast(P.side === 'buy' ? 'Enter a SOL amount from 0 to 1000, like 0.5 (use "." or "," for decimals).' : 'Enter a share from 1 to 100%.', 'err'); i.value = c[P.side][idx]; }
  });
  // Enter in the amount box trades, but only once the quote for that amount is on screen; a held key (auto-repeat)
  // never counts, so it can't also pass the high-impact "press again" step
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.dataset?.in !== 'amt') return;
    e.preventDefault();
    if (e.repeat || P.busy) return;
    if (quoteFresh()) goMarket(); else if (!P.qBusy) requote(0);
  });

  // ---------- wiring ----------
  ctx.on('settings', () => {
    if (settings.preset !== P.lastPreset) { P.lastPreset = settings.preset; P.amt = { buy: String(preset().buy), sell: String(preset().sellPct) }; }
    P.qd = null; render();
  });
  ctx.on('wallet', () => { P.bal = null; P.pos = null; P.orders = null; P.q = null; P.qd = null; P.advErr = ''; unbuild(); render(); loadBal(); loadPos(true); });
  ctx.on('traded', (d) => { if (d?.mint === mint) { P.tradedAt = Date.now(); P.bal = null; P.q = null; loadBal().then(() => requote(0)); setTimeout(() => loadPos(true), 2500); } });
  ctx.on('orders', () => { if (P.mode === 'limit') loadOrders(true); else upd(); });
  let tokT = 0; // reprice at most once a second, always ending on the latest data
  ctx.on('tokens', () => { if (!tokT) tokT = setTimeout(() => { tokT = 0; if (!P.alive) return; repricePos(); upd(); }, 1000); });
  const timers = [
    setInterval(() => { if (!document.hidden && P.mode === 'market' && !P.busy && !P.qBusy && parseAmount(P.amt[P.side]) > 0 && (P.side === 'buy' || P.bal?.tok?.raw > 0n)) requote(0); }, 10000),
    setInterval(() => { if (!document.hidden && owners().length) loadBal(); }, 20000),
    setInterval(() => { if (!document.hidden && owners().length) loadPos(false); }, 30000),
    setInterval(() => { if (!document.hidden && P.mode === 'adv') upd(); }, 4000), // armed statuses
    setInterval(() => { if (!document.hidden && P.mode === 'limit') loadOrders(); }, 30000),
  ];
  render(); loadBal(); loadPos(false);

  return () => { P.alive = false; clearTimeout(P.qTimer); clearTimeout(tokT); timers.forEach(clearInterval); document.removeEventListener('pointerdown', closeWpop, true); document.removeEventListener('keydown', escWpop); removeEventListener('scroll', followWpop, true); removeEventListener('resize', followWpop); };
}
