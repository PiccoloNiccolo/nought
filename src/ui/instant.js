// Instant trade: a small floating panel for one-click buys and sells of the coin on screen. Draggable (its spot is
// kept in this browser), 4 buy amounts in SOL and 4 sell shares in % (all editable), a P1–P3 preset switch and a live
// position line. Opened from the token page (button or the "i" key); it hides when you leave the token page and
// comes back on the next one if you left it open.
//   openInstant(mint) · closeInstant() · toggleInstant(mint) · detachInstant() · instantOpen()
// Shared with the token page's trade panel:
//   buyAcross(mint, totalSol, opts)   splits the amount evenly over tradeOwners() (selected local wallets, else the
//                                     active wallet) and buys from each in turn → number of fills that confirmed
//   sellAcross(mint, pct, opts)       each wallet sells pct% of its own balance → number of fills that confirmed
//                                     Both take opts.quoted = {raw, minOutRaw, impactPct}: the quote shown for one leg.
//                                     Every leg then carries a minimum (legMin) and an impact cap (25% by default).
//   quotedMin(q)                      the guaranteed minimum (raw string) of a swap/v1 quote or an Ultra order
//   maybeLanded(e, who)               after a send error that may still land (err.maybeSent): confirm and report
//   fillsFor(mint, owner, force?)     a wallet's fills on a coin: Jupiter's trade history merged with Nought's own log
//   loadPosition(mint, {force})       bought / sold / holding / PnL across tradeOwners()
//   supplyOf(t, pair?)                the coin's known supply, or null (never a guessed 1B outside 1B launchpads)
// Nought adds no fee: these call core trade(), which never passes a platform fee or referral.
import { esc, LS, on, usd, num, short, toast, parseAmount } from '../core/util.js';
import { settings, set as setSettings, preset, PRIO } from '../core/settings.js';
import { wallet, needWallet, tradeOwners } from '../core/wallet.js';
import { trade, holding, tradeLog, decimalsOf, confirm, txLink } from '../core/trade.js';
import { jx } from '../core/jup.js';
import { tokens, mcUsd } from '../core/store.js';
import { solUsd } from '../core/price.js';

// ---- shared helpers ----
const fillCache = new Map(); // `${mint}|${owner}` → {at, p}
export function fillsFor(mint, owner, force = false) {
  const key = `${mint}|${owner}`, hit = fillCache.get(key);
  if (!force && hit && Date.now() - hit.at < 20000) return hit.p;
  const p = (async () => {
    const out = new Map();
    let offset, pages = 0;
    try {
      do {
        const r = await jx.txs(mint, { trader: owner, offset });
        for (const x of r.txs) if (x.wallet === owner) out.set(x.sig, { sig: x.sig, side: x.side, sol: x.sol, tokens: x.tokens, at: x.at, owner, src: 'jx' });
        offset = r.next; pages++;
      } while (offset && pages < 3);
    } catch { /* Nought's own log below still counts */ }
    const dec = decimalsOf(mint);
    for (const t of tradeLog()) {
      if (t.mint !== mint || t.owner !== owner || out.has(t.sig)) continue;
      out.set(t.sig, { sig: t.sig, side: t.side, sol: Number(t.sol) || 0, tokens: (Number(t.tokensRaw) || 0) / 10 ** dec, at: t.at, owner, src: 'log' });
    }
    return [...out.values()].sort((a, b) => a.at - b.at);
  })();
  fillCache.set(key, { at: Date.now(), p });
  if (fillCache.size > 200) fillCache.delete(fillCache.keys().next().value);
  return p;
}
// A coin's supply when it is known: Jupiter's circulating or total figure, else Dexscreener's fdv / price, else the 1B
// every pump.fun / Bonk / LaunchLab coin has. null when unknown, so no market-cap maths runs on a guessed supply.
const ONE_B = ['pump.fun', 'letsbonk.fun', 'raydium-launchlab'];
export function supplyOf(t, pair = t?.pair) {
  if (t?.circSupply > 0) return t.circSupply;
  if (t?.totalSupply > 0) return t.totalSupply;
  const fdv = Number(pair?.fdv), p = Number(pair?.priceUsd);
  if (fdv > 0 && p > 0) return fdv / p;
  return /(pump|bonk)$/.test(t?.mint || '') || ONE_B.includes(t?.launchpad) ? 1e9 : null;
}
// USD price per token: Jupiter's price, else market cap over a known supply
export function priceUsdOf(t) {
  if (!t) return null;
  if (t.price > 0) return t.price;
  const mc = mcUsd(t), sup = supplyOf(t);
  return mc > 0 && sup > 0 ? mc / sup : null;
}
export async function loadPosition(mint, { force = false } = {}) {
  const owners = tradeOwners().slice(0, 8);
  if (!owners.length) return null;
  const [fills, holds] = await Promise.all([
    Promise.all(owners.map((o) => fillsFor(mint, o, force).catch(() => []))),
    Promise.all(owners.map((o) => holding(mint, o).catch(() => null))),
  ]);
  let boughtSol = 0, soldSol = 0, buys = 0, sells = 0, holdUi = 0, holdKnown = true;
  for (const f of fills.flat()) { if (f.side === 'buy') { boughtSol += f.sol; buys++; } else { soldSol += f.sol; sells++; } }
  for (const h of holds) { if (h) holdUi += h.ui; else holdKnown = false; }
  const pUsd = priceUsdOf(tokens.get(mint)), s = solUsd();
  const holdUsd = pUsd ? holdUi * pUsd : null, holdSol = holdUsd != null && s > 0 ? holdUsd / s : null;
  const pnlSol = holdSol != null ? soldSol + holdSol - boughtSol : null;
  return { owners: owners.length, more: tradeOwners().length - owners.length, boughtSol, soldSol, buys, sells, holdUi, holdKnown, holdUsd, holdSol, pnlSol, pnlUsd: pnlSol != null && s > 0 ? pnlSol * s : null, pnlPct: pnlSol != null && boughtSol > 0 ? (pnlSol / boughtSol) * 100 : null, raws: holds };
}
const labelOf = (mint) => (tokens.get(mint)?.symbol ? '$' + tokens.get(mint).symbol : short(mint));
// The guaranteed minimum of a quote in raw output units, as trade() measures a fresh one (contract C2): swap/v1's
// otherAmountThreshold; an Ultra order's outAmount less its slippageBps (less 1 ppm + 1 unit, so a rounding difference
// in that arithmetic can never refuse an unchanged quote).
export function quotedMin(q) {
  try {
    if (q?.mode === 'ultra' || q?.requestId) {
      const m = (BigInt(q.outAmount) * BigInt(10000 - Math.min(10000, Math.max(0, Number(q.slippageBps) || 0)))) / 10000n, c = m - m / 1000000n - 1n;
      return (c > 0n ? c : 0n).toString();
    }
    return BigInt(q.otherAmountThreshold).toString();
  } catch { return undefined; }
}
// The minimum one wallet's leg of a multi-wallet trade may return, from the quote shown for one leg (q: {raw,
// minOutRaw, impactPct}): pro rata to the leg's size (never more per coin than the quote), less the extra impact of a
// bigger leg and the drift (%) that this order's earlier legs caused. A first leg of the quoted size gets exactly the
// minimum shown. Never below half the pro-rata minimum: past that the leg is refused, not sent.
export function legMin(q, raw, drift = 0) {
  let base, min;
  try { base = BigInt(q?.raw ?? 0); min = BigInt(q?.minOutRaw ?? 0); raw = BigInt(raw); } catch { return undefined; }
  if (!(base > 0n) || !(min > 0n) || !(raw > 0n)) return undefined;
  if (raw === base && !(drift > 0)) return min.toString();
  const r = Number(raw) / Number(base), imp = Math.min(0.9, Math.max(0, Number(q.impactPct) || 0) / 100);
  const f = Math.max(0.5, Math.min(1, (1 - Math.min(0.95, imp * r)) / (1 - imp)) * (1 - Math.max(0, drift) / 100));
  return ((min * BigInt(Math.floor(r * f * 1e6))) / 1000000n).toString();
}
// how far (%) one filled leg moved the price for the next one: about twice its own impact
const legDrift = (q, raw) => { try { return 2 * (Number(q?.impactPct) || 0) * (Number(BigInt(raw)) / Number(BigInt(q?.raw || 0) || 1n)); } catch { return 0; } };
// A send that failed in a way that may still land (contract C4: err.maybeSent + err.sig): never retried or refunded,
// only confirmed and reported. → 'ok' | 'failed' | 'unknown', or null for any other error.
export async function maybeLanded(e, who = '') {
  if (!e?.maybeSent || !e.sig) return null;
  const pre = who ? esc(who) + ': ' : '';
  toast(`${pre}The network did not answer cleanly, so the transaction may still land. Checking… ${txLink(e.sig)}`);
  const r = await confirm(e.sig, e.blockhash ? { blockhash: e.blockhash } : undefined);
  toast(r === 'ok' ? `${pre}It landed. ${txLink(e.sig)}` : r === 'failed' ? `${pre}It failed on-chain, so nothing changed. ${txLink(e.sig)}` : `${pre}Still unknown. Check your wallet before trying again. ${txLink(e.sig)}`, r === 'ok' ? 'ok' : r === 'failed' ? 'err' : '');
  return r;
}
// one leg through core trade() → 'ok' | 'failed' | 'unknown' | 'aborted' (refused before signing: price moved)
const leg = async (side, mint, raw, o) => { const r = await trade(side, mint, raw, { ...o, detail: true }); return typeof r === 'object' && r ? r.status : r ? 'ok' : 'failed'; };
const legErr = async (e, owners, owner, what) => {
  const who = owners.length > 1 ? short(owner) : '';
  const r = await maybeLanded(e, who);
  if (r == null) toast(`${who ? esc(who) + ': ' : ''}${esc(e?.message || `The ${what} did not go through.`)}`, 'err');
  return r === 'ok';
};
export async function buyAcross(mint, totalSol, opts = {}) {
  const owners = tradeOwners();
  if (!owners.length) { needWallet(); return 0; }
  if (!(totalSol > 0) || !isFinite(totalSol)) throw new Error('Enter an amount of SOL.');
  const each = BigInt(Math.floor((totalSol / owners.length) * 1e9));
  if (each <= 0n) throw new Error('That amount is too small to split.');
  const { quoted, ...o } = opts;
  if (o.maxImpactPct == null) o.maxImpactPct = 25;
  let ok = 0, drift = 0;
  for (const owner of owners) {
    const minOutRaw = legMin(quoted, each, drift);
    let st = 'failed';
    try { st = await leg('buy', mint, each, { ...o, owner, ...(minOutRaw && { minOutRaw }) }); }
    catch (e) { st = (await legErr(e, owners, owner, 'buy')) ? 'ok' : 'failed'; }
    if (st === 'ok') { ok++; drift += legDrift(quoted, each); }
    if (st === 'aborted') break; // the price moved past the quote: the other wallets would be refused the same way
  }
  return ok;
}
// each wallet sells pct% (0–100] of its own balance (the same checks as core sellPct, which this replaces so each leg
// can carry its own minimum)
export async function sellAcross(mint, pct, opts = {}) {
  const owners = tradeOwners();
  if (!owners.length) { needWallet(); return 0; }
  const p = Math.min(100, Number(pct));
  if (!(p > 0)) throw new Error('Pick how much to sell.');
  const { quoted, ...o } = opts;
  if (o.maxImpactPct == null) o.maxImpactPct = 25;
  let ok = 0, drift = 0;
  for (const owner of owners) {
    let st = 'failed', raw = 0n;
    try {
      const h = await holding(mint, owner);
      if (h.frozen) throw new Error('This coin is frozen in your wallet, so it cannot be sold.');
      if (!(h.raw > 0n)) throw new Error('You hold none of this coin.');
      raw = p >= 100 ? h.raw : (h.raw * BigInt(Math.round(p * 100))) / 10000n;
      if (raw <= 0n) throw new Error('That share of your balance rounds to zero.');
      const minOutRaw = legMin(quoted, raw, drift);
      st = await leg('sell', mint, raw, { ...o, owner, ...(minOutRaw && { minOutRaw }) });
    } catch (e) { st = (await legErr(e, owners, owner, 'sale')) ? 'ok' : 'failed'; }
    if (st === 'ok') { ok++; drift += legDrift(quoted, raw); }
    if (st === 'aborted' && quoted) break; // the price moved past the quote: the other wallets would be refused too
  }
  return ok;
}

// ---- the floating panel ----
const DEF = { buy: [0.05, 0.1, 0.25, 0.5], sell: [25, 50, 75, 100] };
const st = { el: null, mint: null, editing: false, busy: false, timer: 0, offs: [], pos: null, posAt: 0, seq: 0 };
const chips = () => { const c = LS.get('instant.chips', DEF); return { buy: (c.buy || DEF.buy).slice(0, 4), sell: (c.sell || DEF.sell).slice(0, 4) }; };
const fmtSol = (v, d = 3) => (v == null || !isFinite(v) ? '—' : (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(d)));

export const instantOpen = () => !!st.el;
export function toggleInstant(mint) { if (st.el && st.mint === mint) closeInstant(); else openInstant(mint); }
export function closeInstant() { LS.set('instant.open', false); detachInstant(); }
// hide without forgetting that it was open (the token page calls this when you leave it)
export function detachInstant() {
  clearInterval(st.timer); st.offs.forEach((f) => f()); st.offs = [];
  st.el?.remove(); st.el = null; st.mint = null; st.pos = null; st.seq++;
}
export function openInstant(mint) {
  if (!mint) return;
  if (st.el && st.mint === mint) return;
  detachInstant();
  LS.set('instant.open', true);
  st.mint = mint; st.editing = false;
  const el = document.createElement('div');
  el.className = 'it-panel'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Instant trade');
  document.body.appendChild(el); st.el = el;
  draw(); place(LS.get('instant.pos', null));
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('pointerdown', onDown);
  const onResize = () => place(currentPos());
  window.addEventListener('resize', onResize);
  st.offs = [() => window.removeEventListener('resize', onResize), on('settings', draw), on('wallet', () => { draw(); refreshPos(true); }),
    on('traded', (d) => { if (d?.mint === st.mint) setTimeout(() => refreshPos(true), 2000); }), on('tokens', posLine)];
  st.timer = setInterval(() => { if (!document.hidden) refreshPos(false); }, 20000);
  refreshPos(false);
}

function draw() {
  if (!st.el) return;
  const c = chips(), t = tokens.get(st.mint) || {}, p = preset(), owners = tradeOwners().length;
  const sym = t.symbol ? '$' + t.symbol : short(st.mint);
  st.el.innerHTML = `
    <div class="it-bar" title="Drag to move">
      <span class="it-grip" aria-hidden="true">⋮⋮</span><b class="it-sym">${esc(sym)}</b>
      <div class="it-pre">${settings.presets.map((x, i) => `<button type="button" data-pre="${i}" class="${i === settings.preset ? 'on' : ''}" title="${esc(x.name)}: ${esc(String(x.slippage))}% slippage · ${esc(PRIO[x.prio]?.label || '')}">${esc(x.name)}</button>`).join('')}</div>
      <button type="button" class="it-ic${st.editing ? ' on' : ''}" data-act="edit" title="${st.editing ? 'Done editing' : 'Edit amounts'}" aria-label="Edit amounts">✎</button>
      <button type="button" class="it-ic" data-act="close" title="Close (i)" aria-label="Close">×</button>
    </div>
    <div class="it-row"><span class="it-k up">Buy</span>${c.buy.map((v, i) => (st.editing ? `<input class="it-in" data-buy="${i}" inputmode="decimal" value="${esc(String(v))}" aria-label="Buy amount ${i + 1} in SOL">` : `<button type="button" class="it-b buy" data-buy="${i}" ${st.busy ? 'disabled' : ''} title="Buy ${esc(String(v))} SOL of ${esc(sym)}${owners > 1 ? `, split over ${owners} wallets` : ''}">${esc(String(v))}</button>`)).join('')}<span class="it-u">SOL</span></div>
    <div class="it-row"><span class="it-k down">Sell</span>${c.sell.map((v, i) => (st.editing ? `<input class="it-in" data-sell="${i}" inputmode="decimal" value="${esc(String(v))}" aria-label="Sell share ${i + 1} in percent">` : `<button type="button" class="it-b sell" data-sell="${i}" ${st.busy ? 'disabled' : ''} title="Sell ${esc(String(v))}% of your ${esc(sym)}${owners > 1 ? ` in each of ${owners} wallets` : ''}">${esc(String(v))}%</button>`)).join('')}<span class="it-u">&nbsp;</span></div>
    <div class="it-pos mono" data-pos>${posHtml()}</div>
    <div class="it-foot"><span class="up">Nought fee 0%</span><span>${esc(String(p.slippage))}% slip · ${esc(PRIO[p.prio]?.label || '')}${p.mev === 'protected' ? ' · Ultra' : ''}</span><span>${wallet.owner ? (owners > 1 ? `${owners} wallets` : esc(short(tradeOwners()[0] || wallet.owner))) : 'No wallet'}</span></div>`;
}
function posHtml() {
  if (!wallet.owner && !tradeOwners().length) return '<span class="it-msg">Connect a wallet to trade.</span>';
  const p = st.pos;
  if (!p) return '<span class="it-msg">Reading your position…</span>';
  if (!p.buys && !p.sells && !(p.holdUi > 0)) return '<span class="it-msg">No position yet.</span>';
  const c = p.pnlSol > 0 ? 'up' : p.pnlSol < 0 ? 'down' : '';
  return `<span>Hold <b>${num(p.holdUi)}</b>${p.holdUsd != null ? ` <i class="muted">${usd(p.holdUsd)}</i>` : ''}</span><span>PnL <b class="${c}">${p.pnlSol != null ? (p.pnlSol >= 0 ? '+' : '') + fmtSol(p.pnlSol) + ' SOL' : '—'}</b>${p.pnlPct != null ? ` <i class="${c}">${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%</i>` : ''}</span>`;
}
function posLine() { const el = st.el?.querySelector('[data-pos]'); if (!el) return; if (st.pos) { const t = tokens.get(st.mint), pUsd = priceUsdOf(t), s = solUsd(); if (pUsd) { const p = st.pos; p.holdUsd = p.holdUi * pUsd; p.holdSol = s > 0 ? p.holdUsd / s : null; p.pnlSol = p.holdSol != null ? p.soldSol + p.holdSol - p.boughtSol : null; p.pnlPct = p.pnlSol != null && p.boughtSol > 0 ? (p.pnlSol / p.boughtSol) * 100 : null; } } el.innerHTML = posHtml(); }
async function refreshPos(force) {
  if (!st.el || !tradeOwners().length) { posLine(); return; }
  const seq = st.seq, mint = st.mint;
  try { const p = await loadPosition(mint, { force }); if (seq === st.seq && st.el) { st.pos = p; posLine(); } } catch { /* keep the last line */ }
}

async function onClick(e) {
  const b = e.target.closest('button'); if (!b || !st.el?.contains(b)) return;
  if (b.dataset.act === 'close') { closeInstant(); return; }
  if (b.dataset.act === 'edit') { st.editing = !st.editing; draw(); return; }
  if (b.dataset.pre != null) { setSettings({ preset: Number(b.dataset.pre) }); return; }
  if (st.busy) return;
  const c = chips(), mint = st.mint;
  if (b.dataset.buy != null || b.dataset.sell != null) {
    if (!needWallet()) return;
    st.busy = true; draw();
    try {
      // one-click trades never see a quote: the 25% impact cap guards them
      const v = parseAmount(String(b.dataset.buy != null ? c.buy[Number(b.dataset.buy)] : c.sell[Number(b.dataset.sell)]));
      if (!(v > 0) || (b.dataset.sell != null && v > 100)) throw new Error('That amount is not a number Nought can trade. Edit the buttons (✎) and set it again.');
      if (b.dataset.buy != null) await buyAcross(mint, v, { maxImpactPct: 25 });
      else await sellAcross(mint, v, { maxImpactPct: 25 });
    } catch (err) { toast(esc(err.message || 'The trade did not go through.'), 'err'); }
    st.busy = false; if (st.mint === mint) { draw(); refreshPos(true); }
  }
}
function onChange(e) {
  const i = e.target; if (!i.classList?.contains('it-in')) return;
  // one "." or "," as the decimal point ("0,5" = 0.5); anything unclear is refused, never read as a bigger number
  const c = chips(), v = parseAmount(i.value), buy = i.dataset.buy != null, k = buy ? 'buy' : 'sell', idx = Number(buy ? i.dataset.buy : i.dataset.sell);
  if (v > 0 && v <= (buy ? 1000 : 100)) { c[k][idx] = v; i.value = String(v); LS.set('instant.chips', c); }
  else { toast(buy ? 'Enter a SOL amount from 0 to 1000, like 0.5 (use "." or "," for decimals).' : 'Enter a share from 1 to 100%.', 'err'); i.value = c[k][idx]; }
}

// ---- dragging ----
const currentPos = () => (st.el ? { x: st.el.offsetLeft, y: st.el.offsetTop } : null);
function place(pos) {
  if (!st.el) return;
  const w = st.el.offsetWidth || 300, h = st.el.offsetHeight || 170, vw = window.innerWidth, vh = window.innerHeight;
  const x = pos && isFinite(pos.x) ? pos.x : vw - w - 360, y = pos && isFinite(pos.y) ? pos.y : vh - h - 60;
  st.el.style.left = Math.max(4, Math.min(vw - w - 4, x)) + 'px';
  st.el.style.top = Math.max(4, Math.min(vh - h - 4, y)) + 'px';
}
function onDown(e) {
  if (!e.target.closest('.it-bar') || e.target.closest('button, input') || e.button !== 0) return;
  const el = st.el, sx = e.clientX - el.offsetLeft, sy = e.clientY - el.offsetTop;
  el.setPointerCapture?.(e.pointerId); el.classList.add('drag');
  const move = (ev) => place({ x: ev.clientX - sx, y: ev.clientY - sy });
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); el.classList.remove('drag'); LS.set('instant.pos', currentPos()); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  e.preventDefault();
}
