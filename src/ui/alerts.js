// Alerts: the notification bell (a log kept in this browser, with an unread badge), toasts for events nothing else
// announces, sounds per feature with a master volume (WebAudio, unlocked by the first click or key press), opt-in
// desktop notifications, and price / market-cap alerts checked every 10 s on Jupiter prices (Dexscreener fills gaps).
//   initAlerts()                      wires the bell and the event listeners (called once by initShell)
//   notify({kind, level, title, body, mint, sig, toast, sound, desktop})  log (+ toast, sound, desktop notification)
//   playSound(kind, {force})          kind: 'fills' | 'fail' | 'orders' | 'tracker' | 'alerts' | 'pulse'
//   prefs(), setPrefs(patch), SOUNDS, enableDesktop()
//   listAlerts(), addAlert({mint, kind: 'mc'|'price', op: 'above'|'below', value}), removeAlert(id), rearmAlert(id),
//   alertQuote(mint) → {price, mc} (last checked)
//   popover(button, panel, {menu, onOpen}) small accessible popover/menu helper (shell uses it for the wallet menu)
// Core already toasts trade fills and order states, so for those this module only logs, plays a sound and (when the
// tab is in the background) raises a desktop notification; after a fill it adds a position toast with Sell actions.
// Other modules can announce things with emit('tracker-trade', {wallet, name, emoji, mint, symbol, side, sol, sig,
// backfill, silent, sound}): it is always logged to the bell; silent: true skips the toast, sound: false skips the
// sound (the per-wallet Sound switch on the Trackers page), backfill: true (history) is ignored.
import { $, esc, on, emit, toast, LS, short, usd, num, cls, ago, isMint, sleep, ICON } from '../core/util.js';
import { jt } from '../core/jup.js';
import { tokens } from '../core/store.js';
import { settings, set as setSettings } from '../core/settings.js';
import { solUsd, pricesFor } from '../core/price.js';
import { wallet } from '../core/wallet.js';
import { holding, tradeLog, txLink } from '../core/trade.js';
import { armed } from '../core/orders.js';
import { qbButton } from './card.js';

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const tick$ = (sym) => (String(sym).startsWith('$') ? String(sym) : '$' + sym); // some tickers already start with $
const labelOf = (mint) => (tokens.get(mint)?.symbol ? tick$(tokens.get(mint).symbol) : mint === USDC_MINT ? 'USDC' : short(mint));
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

// ---- preferences ----
export const SOUNDS = { fills: 'Trade fills', orders: 'Order triggers and fills', tracker: 'Tracked wallet trades', alerts: 'Price and market-cap alerts', pulse: 'New pairs on Pulse' };
const DEF = { desktop: false, volume: 0.5, positionToasts: true, sounds: { fills: true, orders: true, tracker: true, alerts: true } };
// read field by field: the stored object may come from an old version or a hand-edited file
export function prefs() {
  const raw = LS.get('alerts.prefs', {}), p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, ps = p.sounds && typeof p.sounds === 'object' ? p.sounds : {};
  const bool = (v, d) => (typeof v === 'boolean' ? v : d), vol = Number(p.volume);
  return {
    desktop: bool(p.desktop, DEF.desktop), volume: isFinite(vol) && p.volume !== null && p.volume !== '' ? Math.max(0, Math.min(1, vol)) : DEF.volume, positionToasts: bool(p.positionToasts, DEF.positionToasts),
    sounds: { ...Object.fromEntries(Object.entries(DEF.sounds).map(([k, d]) => [k, bool(ps[k], d)])), pulse: !!settings.sounds },
  };
}
// the Pulse sound is core's settings.sounds, so the Pulse page and this module agree on one switch
export function setPrefs(patch = {}) {
  const cur = prefs(), next = { ...cur, ...patch, sounds: { ...cur.sounds, ...(patch.sounds || {}) } };
  if (patch.sounds && 'pulse' in patch.sounds) setSettings({ sounds: !!patch.sounds.pulse });
  delete next.sounds.pulse;
  next.volume = Math.max(0, Math.min(1, Number(next.volume) || 0));
  LS.set('alerts.prefs', next);
  emit('alert-prefs', prefs());
}

// ---- sounds: short synthesized tones, nothing to download ----
let ctx = null;
function audio() {
  if (!ctx) { const A = window.AudioContext || window.webkitAudioContext; if (!A) return null; try { ctx = new A(); } catch { return null; } }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
const TONES = {
  fills: [[660, 0.07], [990, 0.12]], fail: [[330, 0.12], [247, 0.2]], orders: [[523, 0.07], [659, 0.07], [784, 0.12]],
  tracker: [[740, 0.05], [0, 0.04], [740, 0.06]], alerts: [[880, 0.09], [660, 0.09], [880, 0.14]], pulse: [[1320, 0.04]],
};
// force: play even if this sound is switched off (the settings "Test" buttons, which are a user gesture)
export function playSound(kind, { force = false } = {}) {
  const p = prefs(), base = kind === 'fail' ? 'fills' : kind, tones = TONES[kind];
  if (!tones || (!force && !p.sounds[base])) return false;
  const vol = p.volume; if (!(vol > 0)) return false;
  const a = force ? audio() : ctx?.state === 'running' ? ctx : null; // browsers only allow audio after a gesture
  if (!a) return false;
  let t = a.currentTime + 0.01;
  for (const [f, d] of tones) {
    if (f > 0) {
      const o = a.createOscillator(), g = a.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2 * vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + d + 0.02);
    }
    t += d + 0.025;
  }
  return true;
}

// ---- desktop notifications (only while the tab is in the background; the bell and toasts cover the rest) ----
export const desktopState = () => (typeof Notification === 'undefined' || !globalThis.isSecureContext ? 'unsupported' : Notification.permission);
export async function enableDesktop() {
  if (typeof Notification === 'undefined') throw new Error('This browser has no desktop notifications.');
  const r = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  setPrefs({ desktop: r === 'granted' });
  return r;
}
function desktop(n) {
  if (!prefs().desktop || desktopState() !== 'granted' || !document.hidden) return;
  try {
    const d = new Notification(n.title, { body: n.body || '', tag: n.id, icon: 'favicon.svg' });
    d.onclick = () => { window.focus(); if (n.mint) location.hash = '#/t/' + n.mint; d.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}

// ---- the log ----
const MAX_NOTES = 150;
const LEVELS = ['ok', 'err', 'warn', 'info'];
const MAX_TIME = 8.64e15; // the largest time a Date can hold
// One shape for every note, applied when a note is written AND when the log is read back: the stored log can come from
// anywhere (an old version, another tab, a hand-edited file), so nothing in it reaches HTML unchecked.
function cleanNote(n) {
  if (!n || typeof n !== 'object' || typeof n.title !== 'string' || !n.title.trim()) return null;
  const at = Number(n.at), str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: str(n.id, 40) || rid(), at: at > 0 && at < MAX_TIME ? at : 0, kind: str(n.kind, 20) || 'info', level: LEVELS.includes(n.level) ? n.level : 'info',
    title: n.title.slice(0, 160), body: str(n.body, 400), mint: isMint(n.mint) ? n.mint : '', sig: SIG.test(n.sig || '') ? n.sig : '', read: n.read === true,
  };
}
export const notes = () => { const l = LS.get('notes', []); return Array.isArray(l) ? l.slice(0, MAX_NOTES).map(cleanNote).filter(Boolean) : []; };
function saveNotes(l) { LS.set('notes', l.slice(0, MAX_NOTES)); emit('notes', null); }
export function notify({ kind = 'info', level = 'info', title, body = '', mint = '', sig = '', toast: show = false, sound = null, desktop: desk = true, actions = '' } = {}) {
  if (!title) return null;
  const n = cleanNote({ id: rid(), at: Date.now(), kind: String(kind), level, title: String(title), body: String(body || ''), mint, sig, read: false });
  if (!n) return null;
  saveNotes([n, ...notes()]);
  if (show) toast(`<span class="t-title">${esc(n.title)}</span>${n.body ? `<span class="t-sub">${esc(n.body)}</span>` : ''}${actions || n.mint ? `<div class="t-acts">${actions}${n.mint ? `<a class="btn btn-ghost" href="#/t/${esc(n.mint)}">Open</a>` : ''}</div>` : ''}`, n.level === 'ok' ? 'ok' : n.level === 'err' ? 'err' : '');
  if (sound) playSound(sound);
  if (desk) desktop(n);
  return n;
}

// ---- price / market-cap alerts: LS 'alerts' = [{id, mint, kind: 'mc'|'price', op: 'above'|'below', value, fired, firedAt?, created?}]
// (other pages may write items without an id; they are given one on the next check)
const rawAlerts = () => { const l = LS.get('alerts', []); return Array.isArray(l) ? l : []; };
const validAlert = (a) => !!a && typeof a === 'object' && isMint(a.mint) && (a.kind === 'mc' || a.kind === 'price') && (a.op === 'above' || a.op === 'below') && Number(a.value) > 0 && isFinite(Number(a.value)) && (a.id == null || typeof a.id === 'string');
export const listAlerts = () => rawAlerts().filter(validAlert);
function saveAlerts(l) { LS.set('alerts', l); emit('alerts-list', null); }
export function addAlert({ mint, kind = 'price', op = 'above', value }) {
  const a = { id: rid(), mint: String(mint || '').trim(), kind, op, value: Number(value), fired: false, created: Date.now() };
  if (!isMint(a.mint)) throw new Error('Paste a token address.');
  if (!(a.value > 0) || !isFinite(a.value)) throw new Error(kind === 'mc' ? 'Enter a market cap in USD, like 250k or 1.5m.' : 'Enter a price in USD, like 0.0012.');
  if (!['mc', 'price'].includes(kind) || !['above', 'below'].includes(op)) throw new Error('Unknown alert type.');
  const sym = tokens.get(a.mint)?.symbol;
  if (sym) a.symbol = String(sym).slice(0, 24);
  saveAlerts([...rawAlerts(), a]);
  if (!sym) jt.search([a.mint]).then(([t]) => { if (t?.symbol) saveAlerts(rawAlerts().map((x) => (x?.id === a.id ? { ...x, symbol: String(t.symbol).slice(0, 24) } : x))); }).catch(() => {});
  setTimeout(checkAlerts, 300);
  return a;
}
export const alertLabel = (a) => (tokens.get(a.mint)?.symbol ? tick$(tokens.get(a.mint).symbol) : typeof a.symbol === 'string' && a.symbol ? tick$(a.symbol.slice(0, 24)) : short(a.mint));
const sameAlert = (x, a) => (a.id ? x.id === a.id : x.mint === a.mint && x.kind === a.kind && x.op === a.op && Number(x.value) === Number(a.value));
export function removeAlert(id) { saveAlerts(rawAlerts().filter((x) => x?.id !== id)); }
export function rearmAlert(id) { saveAlerts(rawAlerts().map((x) => (x?.id === id ? { ...x, fired: false, firedAt: undefined } : x))); setTimeout(checkAlerts, 300); }

const supply = new Map(); // mint → {s, at} from Jupiter search
const last = new Map();   // mint → {price, mc, at} from the last check
export const alertQuote = (mint) => last.get(mint) || null;
function supplyOf(mint) {
  const t = tokens.get(mint);
  const s = t?.circSupply || t?.totalSupply || supply.get(mint)?.s || (t?.mcUsd > 0 && t?.price > 0 ? t.mcUsd / t.price : 0);
  return s > 0 ? s : /pump$/.test(mint) ? 1e9 : 0; // pump.fun coins have a fixed 1B supply
}
async function fillSupply(mints) {
  const want = mints.filter((m) => !(Date.now() - (supply.get(m)?.at || 0) < 600e3));
  if (!want.length) return;
  try { for (const t of await jt.search(want)) { const s = t.circSupply || t.totalSupply; if (s > 0) supply.set(t.mint, { s, at: Date.now() }); } } catch { /* try next time */ }
}
// Four significant digits, never an exponent. Tiny prices take the token page's form: $0.0₅3840 for 0.000003840, the
// subscript counting the zeros after "0.0" (up to three zeros stay written out: $0.000288).
const SUB = '₀₁₂₃₄₅₆₇₈₉';
export function fmtPrice(v) {
  v = Number(v);
  if (!(v > 0) || !isFinite(v)) return '—';
  if (v >= 1) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: v >= 100 ? 2 : 4 });
  if (v >= 0.001) return '$' + Number(v.toPrecision(4)).toString();
  let e = Math.floor(Math.log10(v)), digits = Math.round(v / 10 ** (e - 3));
  if (digits >= 1e4) { digits = Math.round(digits / 10); e += 1; }
  const zeros = -e - 1, body = String(digits).replace(/0+$/, '') || '0';
  return zeros < 4 ? '$0.' + '0'.repeat(zeros) + body : '$0.0' + String(zeros).replace(/\d/g, (d) => SUB[d]) + body;
}
export const fmtAlertValue = (kind, v) => (v == null ? '—' : kind === 'mc' ? usd(Number(v)) : fmtPrice(v));
const fmtVal = fmtAlertValue;
let checking = false;
export async function checkAlerts() {
  if (checking) return;
  let list = rawAlerts();
  if (list.some((a) => validAlert(a) && !a.id)) { list = list.map((a) => (validAlert(a) && !a.id ? { ...a, id: rid() } : a)); saveAlerts(list); }
  const act = list.filter((a) => validAlert(a) && !a.fired);
  if (!act.length) return;
  checking = true;
  try {
    const mints = [...new Set(act.map((a) => a.mint))];
    const px = new Map([...(await pricesFor(mints))].map(([m, p]) => [m, { price: p.priceUsd }])); // Jupiter, then Dexscreener
    const needSupply = mints.filter((m) => act.some((a) => a.mint === m && a.kind === 'mc') && !(tokens.get(m)?.circSupply || tokens.get(m)?.totalSupply));
    if (needSupply.length) await fillSupply(needSupply);
    const hits = [];
    let quotesChanged = false;
    for (const m of mints) { const p = px.get(m)?.price; if (p > 0) { const s = supplyOf(m), mc = s ? p * s : null, before = last.get(m); if (before?.price !== p || before?.mc !== mc) quotesChanged = true; last.set(m, { price: p, mc, at: Date.now() }); } }
    for (const a of act) {
      const q = last.get(a.mint); if (!q || Date.now() - q.at > 30000) continue;
      const v = a.kind === 'mc' ? q.mc : q.price; if (!(v > 0)) continue;
      if (a.op === 'above' ? v >= Number(a.value) : v <= Number(a.value)) hits.push([a, v]);
    }
    if (hits.length) {
      const now = Date.now();
      saveAlerts(rawAlerts().map((x) => (hits.some(([a]) => sameAlert(x, a)) ? { ...x, fired: true, firedAt: now } : x)));
      for (const [a, v] of hits) {
        notify({ kind: 'alert', level: 'warn', title: `${alertLabel(a)} ${a.kind === 'mc' ? 'market cap' : 'price'} ${a.op} ${fmtVal(a.kind, Number(a.value))}`, body: `Now ${fmtVal(a.kind, v)}.`, mint: a.mint, toast: true, sound: 'alerts', actions: qbButton(a.mint) });
      }
    }
    if (quotesChanged) emit('alerts-quotes', null);
  } catch { /* prices unavailable: next tick */ } finally { checking = false; }
}

// ---- event handlers ----
async function positionToast(e) {
  await sleep(2500); // Jupiter's balance index trails a fresh fill by a moment
  try {
    const [h, px] = await Promise.all([holding(e.mint, e.owner), pricesFor([e.mint]).catch(() => new Map())]);
    const p = px.get(e.mint)?.priceUsd, label = labelOf(e.mint), su = solUsd(), open = h.raw > 0n;
    const valUsd = p > 0 ? h.ui * p : null, valSol = valUsd != null && su > 0 ? valUsd / su : open ? null : 0;
    const log = tradeLog().filter((t) => t.mint === e.mint && t.owner === e.owner);
    const spent = log.filter((t) => t.side === 'buy').reduce((s, t) => s + (t.sol || 0), 0), got = log.filter((t) => t.side === 'sell').reduce((s, t) => s + (t.sol || 0), 0);
    const pnl = spent > 0 && valSol != null ? valSol + got - spent : null;
    const sells = open && e.owner === wallet.owner ? `<button type="button" class="btn" data-qs="${esc(e.mint)}" data-pct="50">Sell 50%</button><button type="button" class="btn" data-qs="${esc(e.mint)}" data-pct="100">Sell all</button>` : '';
    const line = [open ? `${num(h.ui)} tokens${valUsd != null ? ' ≈ ' + usd(valUsd) : ''}` : 'No tokens left', pnl != null ? `PnL <b class="${cls(pnl)}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL</b>` : ''].filter(Boolean).join(' · ');
    toast(`<span class="t-title">${open ? 'Position' : 'Position closed'} · ${esc(label)}</span><span class="t-sub mono">${line}</span>${pnl != null ? '<span class="t-sub" style="font-size:11px">PnL counts trades made in this browser.</span>' : ''}<div class="t-acts">${sells}<a class="btn btn-ghost" href="#/t/${esc(e.mint)}">Open</a></div>`);
  } catch { /* balance unavailable: the fill toast already went out */ }
}
function onTraded(e) {
  if (!e?.mint) return;
  const label = labelOf(e.mint), ok = e.status === 'ok', failed = e.status === 'failed';
  notify({
    kind: 'fill', level: ok ? 'ok' : failed ? 'err' : 'warn', mint: e.mint === USDC_MINT ? '' : e.mint, sig: e.sig,
    title: ok ? `${e.side === 'buy' ? 'Bought' : 'Sold'} ${label}` : failed ? `${cap(e.side)} of ${label} failed` : `${cap(e.side)} of ${label} still confirming`,
    body: e.owner ? `Wallet ${short(e.owner)}` : '', sound: ok ? 'fills' : failed ? 'fail' : null,
  });
  if (ok && e.mint !== USDC_MINT && prefs().positionToasts) positionToast(e);
}
let armedSnap = new Map();
const snapArmed = () => { try { return new Map(armed.list().map((a) => [a.id, a])); } catch { return new Map(); } };
function onOrders(e) {
  if (!e) return;
  if (e.type === 'limit') {
    if (e.action === 'create') notify({ kind: 'order', level: e.status === 'ok' ? 'ok' : e.status === 'failed' ? 'err' : 'warn', title: e.status === 'ok' ? 'Limit order placed' : e.status === 'failed' ? 'Limit order failed on-chain' : 'Limit order still confirming', sig: e.sig, sound: e.status === 'failed' ? 'fail' : 'orders' });
    else if (e.action === 'cancel') notify({ kind: 'order', level: e.ok ? 'info' : 'err', title: e.ok ? 'Limit order cancelled' : 'Limit order cancel did not go through', desktop: false });
    else if (e.action === 'closed') notify({ kind: 'order', level: 'info', title: 'A limit order closed', body: 'Filled, cancelled elsewhere or expired.', sound: 'orders' });
    return;
  }
  if (e.type !== 'armed') return;
  const now = snapArmed();
  for (const [id, a] of now) {
    const was = armedSnap.get(id), kind = armed.KIND_LABEL?.[a.kind] || 'Order', label = labelOf(a.mint);
    if (!was) { if (a.status === 'armed') notify({ kind: 'order', level: 'info', title: `${kind} armed for ${label}`, mint: a.mint, desktop: false }); continue; }
    if (was.status === a.status) continue;
    if (a.status === 'firing') notify({ kind: 'order', level: 'warn', title: `${kind} triggered: ${label}`, mint: a.mint, sound: 'orders' });
    else if (a.status === 'done') notify({ kind: 'order', level: 'ok', title: `${kind} filled: ${label}`, mint: a.mint });
    else if (a.status === 'failed') notify({ kind: 'order', level: 'err', title: `${kind} failed: ${label}`, body: a.note || '', mint: a.mint, sound: 'fail' });
    else if (a.status === 'cancelled') notify({ kind: 'order', level: 'info', title: `${kind} cancelled: ${label}`, body: a.note || '', mint: a.mint, desktop: false });
  }
  armedSnap = now;
}
let lastTrackerToast = 0;
function onTracker(t) {
  if (!t || !isMint(t.mint) || t.backfill) return; // backfilled history is not news
  const who = [t.emoji, t.name || t.label || (t.wallet ? short(t.wallet) : 'A tracked wallet')].filter(Boolean).join(' ').slice(0, 40);
  const solAmt = Number(t.sol), sym = t.symbol ? tick$(String(t.symbol).slice(0, 20)) : labelOf(t.mint);
  const show = !t.silent && Date.now() - lastTrackerToast > 1500; // a busy wallet list shouldn't bury the screen
  if (show) lastTrackerToast = Date.now();
  const sound = t.sound === false ? null : 'tracker'; // the wallet's own Sound switch is off (the global one is checked in playSound)
  notify({ kind: 'tracker', level: t.side === 'sell' ? 'err' : 'ok', title: `${who} ${t.side === 'sell' ? 'sold' : 'bought'}${solAmt > 0 ? ' ' + solAmt.toFixed(solAmt >= 10 ? 1 : 3) + ' SOL of' : ''} ${sym}`, mint: t.mint, sig: t.sig, toast: show, sound, actions: qbButton(t.mint) });
}

// ---- popover / menu helper: toggle, aria-expanded, outside click, Escape (focus back to the button), arrow keys ----
const pops = new Set();
export function popover(btn, panel, { menu = false, onOpen, onClose } = {}) {
  const wrap = btn.parentElement;
  const items = () => [...panel.querySelectorAll(menu ? '[role="menuitem"]:not([disabled])' : 'a[href], button:not([disabled]), [tabindex="0"]')];
  const isOpen = () => !panel.hidden;
  function open(focusFirst = false) {
    pops.forEach((p) => p !== api && p.close(false));
    onOpen?.(); panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
    if (focusFirst) (items()[0] || panel).focus?.();
  }
  function close(refocus = true) {
    if (panel.hidden) return;
    panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); onClose?.();
    if (refocus) btn.focus();
  }
  btn.addEventListener('click', (e) => { if (isOpen()) close(false); else open(e.detail === 0); }); // detail 0 = keyboard
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); if (!isOpen()) open(true); else items()[0]?.focus(); }
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const l = items(); if (!l.length) return;
    const i = l.indexOf(document.activeElement);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? l.length - 1 : e.key === 'ArrowDown' ? (i + 1) % l.length : (i - 1 + l.length) % l.length;
    e.preventDefault(); l[j].focus();
  });
  document.addEventListener('pointerdown', (e) => { if (isOpen() && !wrap.contains(e.target)) close(false); }, true);
  document.addEventListener('focusin', (e) => { if (isOpen() && !wrap.contains(e.target)) close(false); });
  const api = { open, close, isOpen, btn, panel };
  pops.add(api);
  return api;
}

// ---- the bell ----
let bell = null;
function badge() {
  const n = notes().filter((x) => !x.read).length, b = $('#bell-badge');
  if (!b) return;
  b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n);
  $('#bell-btn')?.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
}
// n comes from notes(), already cleaned; the level (a class name, which escaping can't make safe) and the time are
// checked again here so this template never depends on that
function itemHtml(n) {
  const level = LEVELS.includes(n.level) ? n.level : 'info', at = Number(n.at), when = at > 0 && at < MAX_TIME ? new Date(at) : null;
  const attrs = isMint(n.mint) ? ` data-bp-mint="${esc(n.mint)}" tabindex="0" role="link" aria-label="${esc(n.title)}: open the coin"` : '';
  return `<div class="bp-item ${level}${n.read ? '' : ' unread'}${attrs ? ' link' : ''}"${attrs}><i aria-hidden="true"></i><b>${esc(n.title)}</b>${when ? `<time datetime="${esc(when.toISOString())}" title="${esc(when.toLocaleString())}">${esc(ago(at))}</time>` : '<time></time>'}${n.body || n.sig ? `<p>${esc(n.body)}${SIG.test(n.sig || '') ? ` ${txLink(n.sig)}` : ''}</p>` : ''}</div>`;
}
function renderBell() {
  const l = notes(), unread = l.some((n) => !n.read), pop = $('#bell-pop');
  // Mark read and Clear only show when there is something to act on
  pop.innerHTML = `<div class="bp-head"><h3>Notifications</h3>${unread ? '<button type="button" class="btn btn-ghost sm" data-bp="read">Mark read</button>' : ''}${l.length ? '<button type="button" class="btn btn-ghost sm" data-bp="clear">Clear</button>' : ''}</div>
    <div class="bp-list">${l.length ? l.slice(0, 80).map(itemHtml).join('') : `<div class="empty-state"><span class="es-ic">${ICON.bell}</span><h3>No notifications yet</h3><p>Fills, order triggers, tracked wallets and your price alerts land here.</p></div>`}</div>
    <div class="bp-foot"><a href="#/settings/alerts" data-bp="settings">Alerts and sounds</a><span>Kept in this browser</span></div>`;
}
export function initAlerts() {
  if (bell) return;
  const btn = $('#bell-btn'), pop = $('#bell-pop');
  if (btn && pop) {
    bell = popover(btn, pop, {
      onOpen() { renderBell(); const l = notes(); if (l.some((n) => !n.read)) { LS.set('notes', l.map((n) => ({ ...n, read: true }))); badge(); } },
    });
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-bp]');
      if (b?.dataset.bp === 'clear') { saveNotes([]); renderBell(); $('[data-bp="settings"]', pop)?.focus(); return; }
      if (b?.dataset.bp === 'read') { saveNotes(notes().map((n) => ({ ...n, read: true }))); renderBell(); $('[data-bp="clear"]', pop)?.focus(); return; } // its button is gone now
      if (b?.dataset.bp === 'settings') { bell.close(false); return; }
      if (e.target.closest('a, button')) return;
      const it = e.target.closest('[data-bp-mint]');
      if (it && isMint(it.dataset.bpMint)) { bell.close(false); location.hash = '#/t/' + it.dataset.bpMint; }
    });
    pop.addEventListener('keydown', (e) => { const it = e.target.closest?.('[data-bp-mint]'); if (it && (e.key === 'Enter' || e.key === ' ') && e.target === it) { e.preventDefault(); it.click(); } });
  }
  badge();
  on('notes', () => { badge(); if (bell?.isOpen()) renderBell(); });
  window.addEventListener('storage', (e) => { if (e.key === 'nought.notes') badge(); });

  // audio unlocks on the first gesture
  const arm = () => { if (Object.values(prefs().sounds).some(Boolean)) audio(); window.removeEventListener('pointerdown', arm, true); window.removeEventListener('keydown', arm, true); };
  window.addEventListener('pointerdown', arm, true); window.addEventListener('keydown', arm, true);

  armedSnap = snapArmed();
  on('traded', onTraded);
  on('orders', onOrders);
  on('tracker-trade', onTracker);
  // price alerts keep running in a background tab (browsers slow timers there to about once a minute)
  setInterval(checkAlerts, 10000);
  setTimeout(checkAlerts, 4000);
}
export const openBell = () => bell?.open(true);
