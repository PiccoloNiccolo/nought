// Live PnL widget: a small floating box with how much the active wallet's value moved since a snapshot taken when you
// started this session (or last pressed Reset). Value = SOL + every token Jupiter lists in the wallet × its USD price,
// counted in SOL. Deposits and withdrawals move it too, and the box says so. Draggable by its header; position,
// colours, unit and on/off are kept in this browser, and so is one snapshot per wallet. Polls Jupiter every 15 s while
// the tab is visible. togglePnlWidget(force?) → bool (open or not). Styles: css/shell.css (.pnlw). It follows the theme
// until colours are picked in its own settings; on a phone (≤760 px) CSS docks it above the bottom edge and it can't
// be dragged.
import { esc, short, usd, ago, LS, on, ICON } from '../core/util.js';
import { wallet } from '../core/wallet.js';
import { ju } from '../core/jup.js';
import { pricesFor, solUsd } from '../core/price.js';

const EVERY = 15000, MAX_PRICED = 150, HEX = /^#[0-9a-f]{6}$/i;
const DEF_STYLE = { bg: '#0c0e13', fg: '#e7e9ef', alpha: 0.94 };
const phone = () => matchMedia('(max-width: 760px)').matches;
let el = null, timer = 0, later = 0, offs = [], busy = false, last = null, err = '';
const lastPx = new Map(); // mint → last good USD price, so a missing quote doesn't look like a crash

const snaps = () => { const s = LS.get('pnlw.snaps', {}); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; };
// one wallet's snapshot as {at, sol} numbers, or null: a damaged one is treated as missing (a fresh one is taken)
const snapOf = (owner) => { const x = owner ? snaps()[owner] : null, at = Number(x?.at), sol = Number(x?.sol); return x && at > 0 && at < 8.64e15 && isFinite(sol) && sol >= 0 ? { at, sol } : null; };
function setSnap(owner, v) { const s = snaps(); s[owner] = { at: Date.now(), sol: v.sol }; const keys = Object.keys(s); if (keys.length > 20) delete s[keys[0]]; LS.set('pnlw.snaps', s); }
// colours picked in the widget's settings, or null: no pick yet (or Default pressed), so it follows the theme
const custom = () => { const v = LS.get('pnlw.style', null); return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? v : null; };
const themed = () => { const cs = getComputedStyle(document.documentElement), hex = (n, d) => { const v = cs.getPropertyValue(n).trim(); return HEX.test(v) ? v : d; }; return { bg: hex('--panel', DEF_STYLE.bg), fg: hex('--fg', DEF_STYLE.fg), alpha: DEF_STYLE.alpha }; };
const style = () => { const s = { ...themed(), ...(custom() || {}) }; if (!HEX.test(s.bg)) s.bg = DEF_STYLE.bg; if (!HEX.test(s.fg)) s.fg = DEF_STYLE.fg; s.alpha = Math.min(1, Math.max(0.4, Number(s.alpha) || DEF_STYLE.alpha)); return s; };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
const fSol = (n) => { const a = Math.abs(n), d = a >= 100 ? 1 : a >= 1 ? 2 : a >= 0.01 ? 3 : 4; return (n > 0 ? '+' : n < 0 ? '-' : '') + a.toFixed(d); };

export const pnlWidgetOpen = () => !!el;
export function togglePnlWidget(force) {
  const want = typeof force === 'boolean' ? force : !el;
  if (want && !el) open(); else if (!want && el) close();
  LS.set('pnlw.on', want);
  return want;
}

// wallet value now, in SOL and USD
async function valueOf(owner) {
  const b = await ju.balances(owner), su = Number(solUsd()) || 0, solBal = Number(b?.sol) || 0;
  const ents = Object.entries(b?.tokens || {}).slice(0, MAX_PRICED);
  const px = ents.length ? await pricesFor(ents.map(([m]) => m)) : new Map();
  let tokUsd = 0, unpriced = 0;
  for (const [m, t] of ents) {
    const p = px.get(m)?.priceUsd ?? lastPx.get(m);
    if (p > 0) { lastPx.set(m, p); tokUsd += (Number(t?.ui) || 0) * p; } else unpriced++;
  }
  if (lastPx.size > 3000) lastPx.clear();
  return { owner, sol: solBal + (su > 0 ? tokUsd / su : 0), usd: solBal * su + tokUsd, su, unpriced, more: Math.max(0, Object.keys(b?.tokens || {}).length - MAX_PRICED), at: Date.now() };
}

async function tick() {
  if (!el || busy || document.hidden) return;
  const owner = wallet.owner;
  if (!owner) { last = null; render(); return; }
  busy = true;
  try {
    const v = await valueOf(owner);
    if (!el || owner !== wallet.owner) return;
    last = v; err = '';
    if (!snapOf(owner)) setSnap(owner, v);
  } catch { err = 'Could not read balances. Retrying…'; }
  finally { busy = false; render(); }
}

function render() {
  if (!el) return;
  const v = el.querySelector('[data-v]'), s = el.querySelector('[data-s]');
  const unit = LS.get('pnlw.unit', 'sol') === 'usd' ? 'usd' : 'sol';
  const snap = snapOf(wallet.owner);
  const msg = (t) => { s.innerHTML = `<span class="pnlw-msg">${esc(t)}</span>`; };
  if (!wallet.owner) { v.textContent = '—'; v.className = ''; msg('Connect a wallet to track this session.'); onResize(); return; }
  if (!last || last.owner !== wallet.owner || !snap) { v.textContent = '…'; v.className = ''; msg(err || 'Taking a snapshot…'); onResize(); return; }
  let dSol = last.sol - snap.sol; if (Math.abs(dSol) < 5e-5) dSol = 0; // ignore price jitter below 0.00005 SOL
  const su = solUsd() || last.su, dUsd = dSol * su, p = snap.sol > 0 ? (dSol / snap.sol) * 100 : 0, c = dSol > 0 ? 'up' : dSol < 0 ? 'down' : '';
  v.textContent = unit === 'usd' ? (dUsd > 0 ? '+' : '') + usd(dUsd, 2) : `${fSol(dSol)} SOL`;
  v.className = c;
  s.innerHTML = `<span class="${c}">${p > 0 ? '+' : ''}${p.toFixed(2)}%</span><span>${unit === 'usd' ? `${fSol(dSol)} SOL` : (dUsd > 0 ? '+' : '') + usd(dUsd, 2)}</span><span>since <b data-age="${Number(snap.at)}">${esc(ago(snap.at))}</b></span>`
    + `<span class="pnlw-n">${esc(short(wallet.owner))} · now ${last.sol.toFixed(3)} SOL · start ${snap.sol.toFixed(3)}${last.unpriced || last.more ? ` · ${last.unpriced + last.more} coins unpriced` : ''}${err ? ' · ' + esc(err) : ''}</span>`;
  if (!el.classList.contains('drag')) onResize(); // the box can grow with its text: keep it inside the window
}

function applyStyle() {
  const s = style();
  if (custom()) { el.style.setProperty('--pw-bg', rgba(s.bg, s.alpha)); el.style.setProperty('--pw-fg', s.fg); }
  else { el.style.removeProperty('--pw-bg'); el.style.removeProperty('--pw-fg'); } // the theme's own panel and text
  for (const i of el.querySelectorAll('[data-k]')) i.value = s[i.dataset.k];
}
function place(p) {
  if (!el) return;
  if (phone()) { el.style.left = el.style.top = ''; return; } // docked by CSS
  const w = el.offsetWidth || 240, h = el.offsetHeight || 120, vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
  const x = p && isFinite(p.x) ? p.x : 12, y = p && isFinite(p.y) ? p.y : vh - h - 38; // default bottom-left, 10 px above the status bar: toasts live bottom-right
  el.style.left = Math.round(Math.min(Math.max(4, x), Math.max(4, vw - w - 4))) + 'px';
  el.style.top = Math.round(Math.min(Math.max(4, y), Math.max(4, vh - h - 38))) + 'px'; // never over the 28 px status bar
}
const onResize = () => { if (el) { const r = el.getBoundingClientRect(); place({ x: r.left, y: r.top }); } };
const onVis = () => { if (!document.hidden) tick(); };

function onClick(e) {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const a = b.dataset.a;
  if (a === 'close') togglePnlWidget(false);
  else if (a === 'reset') { if (last && last.owner === wallet.owner) setSnap(wallet.owner, last); else { const s = snaps(); delete s[wallet.owner]; LS.set('pnlw.snaps', s); } render(); tick(); }
  else if (a === 'unit') { LS.set('pnlw.unit', LS.get('pnlw.unit', 'sol') === 'usd' ? 'sol' : 'usd'); render(); }
  else if (a === 'style') { const c = el.querySelector('[data-cfg]'); c.hidden = !c.hidden; onResize(); }
  else if (a === 'restyle') { LS.set('pnlw.style', null); applyStyle(); } // back to the theme's colours
}
function onInput(e) {
  const k = e.target.dataset?.k; if (!k) return;
  const s = style();
  if (k === 'alpha') s.alpha = Number(e.target.value); else if (HEX.test(e.target.value)) s[k] = e.target.value;
  LS.set('pnlw.style', s); applyStyle();
}
function drag(h) {
  let sx = 0, sy = 0, ox = 0, oy = 0, id = null;
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input') || phone()) return;
    id = e.pointerId; h.setPointerCapture(id);
    const r = el.getBoundingClientRect(); sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    el.classList.add('drag'); e.preventDefault();
  });
  h.addEventListener('pointermove', (e) => { if (e.pointerId === id) place({ x: ox + e.clientX - sx, y: oy + e.clientY - sy }); });
  const end = (e) => { if (e.pointerId !== id) return; id = null; el.classList.remove('drag'); const r = el.getBoundingClientRect(); LS.set('pnlw.pos', { x: Math.round(r.left), y: Math.round(r.top) }); };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
}

function open() {
  el = document.createElement('div');
  el.className = 'pnlw'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'Live PnL');
  el.innerHTML = `<div class="pnlw-h" title="Drag to move"><span class="pnlw-t">Session PnL</span>
      <button type="button" data-a="style" title="Colours" aria-label="Colours"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/></svg></button>
      <button type="button" data-a="reset" title="Start a new session from the current value">Reset</button>
      <button type="button" data-a="close" aria-label="Close">${ICON.close}</button></div>
    <button type="button" class="pnlw-v" data-a="unit" title="Switch between SOL and USD"><b data-v>…</b></button>
    <div class="pnlw-s" data-s aria-live="polite" title="Change in wallet value (SOL plus priced tokens) since the snapshot. Deposits and withdrawals count as well."></div>
    <div class="pnlw-cfg" data-cfg hidden><label>Background<input type="color" data-k="bg"></label><label>Text<input type="color" data-k="fg"></label><label>Opacity<input type="range" min="0.4" max="1" step="0.02" data-k="alpha"></label><button type="button" data-a="restyle">Default</button></div>`;
  document.body.appendChild(el);
  applyStyle(); place(LS.get('pnlw.pos', null));
  el.addEventListener('click', onClick); el.addEventListener('input', onInput); drag(el.querySelector('.pnlw-h'));
  offs = [
    on('wallet', () => { last = null; err = ''; render(); tick(); }),
    on('sol', render),
    on('theme', applyStyle), // the colour inputs show the new theme's colours
    on('traded', () => { clearTimeout(later); later = setTimeout(tick, 4000); }),
  ];
  document.addEventListener('visibilitychange', onVis); window.addEventListener('resize', onResize);
  timer = setInterval(tick, EVERY);
  render(); tick();
}
function close() {
  clearInterval(timer); clearTimeout(later); timer = later = 0;
  offs.forEach((f) => f()); offs = [];
  document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', onResize);
  el?.remove(); el = null; last = null; busy = false;
}

// reopen after a reload if it was open (this module loads at boot through the Portfolio page)
if (LS.get('pnlw.on', false) === true) setTimeout(() => { if (!el && document.body) open(); }, 0);
