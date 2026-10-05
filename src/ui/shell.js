// The app frame. Pages render into #view; everything around it lives here:
//   top bar      nav (a menu button below 1100 px; Vision has its own link into #/track/vision), search, presets
//                P1–P3, watchlist-strip star, live PnL widget, notifications bell, settings, wallet pill with a menu
//                (manage, deposit, withdraw, convert SOL⇄USDC, fees saved, disconnect)
//   ticker       the watchlist strip under the top bar: LS 'watch' (kept by src/core/watchlist.js), Jupiter prices
//                every 10 s, redrawn at once on util 'watch'. It takes no space at all while the watchlist is empty
//                and can be switched off (star button, key T, Settings > Display).
//   status bar   connection dots (pump.fun stream, Jupiter feed, RPC), BTC/ETH, active preset, fees saved, links
//   keys         rebindable hotkeys (Settings > Hotkeys), theme (Settings > Display), the quick preset dialog
//   clicks       [data-copy] copies, [data-qb] quick-buys, [data-qs][data-pct] quick-sells, [data-mint] opens a coin,
//                [data-close] closes its dialog
// Events this module emits (util on/emit):
//   'theme'    {name, accent, colors} after every theme or accent change (setTheme, or another tab changing it);
//              colors are the resolved tokens {bg, panel, panel2, line, line2, fg, muted, dim, accent, up, down, warn}
//              for canvas code (charts) that can't read CSS variables. Subscribe with on('theme', fn) and call the
//              returned unsubscribe in your page cleanup.
//   'ticker'   bool: the watchlist strip was switched on (true) or off (false)
//   'pnlwidget' bool: the live PnL widget opened (true) or closed (false), from any of its switches
//   'hotkeys'  the full binding map after a change
// The order engine is started by app.js once the saved wallet is back.
import { $, $$, esc, safeUrl, on, emit, toast, copy, isMint, LS, short, usd, ICON, parseAmount } from '../core/util.js';
import { settings, set, setPreset, PRIO, preset, rpcUrl } from '../core/settings.js';
import { wallet, openWalletPicker, disconnectWallet, toRaw } from '../core/wallet.js';
import { solUsd, pricesFor } from '../core/price.js';
import { img } from '../core/meta.js';
import { quickBuy, quickSell, quoteFor, quoteDetails, impactWarning, trade, feesSaved, SOL_MINT } from '../core/trade.js';
import * as tradeX from '../core/trade.js'; // optional exports (minOutOf): a namespace lookup can't break module linking
import { solBalance } from '../core/rpc.js';
import { jt, ju, ds } from '../core/jup.js';
import { state as stream } from '../core/stream.js';
import { feed } from '../core/seed.js';
import { tokens } from '../core/store.js';
import { openSearch } from './search.js';
import { initAlerts, popover, openBell, fmtPrice, USDC_MINT } from './alerts.js';

const wui = () => import('./wallets.js'); // the wallet manager loads on first use
const hidden = () => document.hidden;
// SOL amounts, one rule everywhere in the frame: 0 → "0", under 0.0001 → "<0.0001", otherwise at most 4 decimals with
// trailing zeros dropped (2 from 100, none from 1,000). Not a number (null, '', a damaged value) → "—".
export function solAmt(n) {
  const x = typeof n === 'number' ? n : typeof n === 'string' && n.trim() ? Number(n) : NaN;
  if (!isFinite(x)) return '—';
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a < 0.0001) return (x < 0 ? '-' : '') + '<0.0001';
  return String(Number(x.toFixed(a >= 1000 ? 0 : a >= 100 ? 2 : 4)));
}
const fmtSol = solAmt;

// ---------------------------------------------------------------- preset rules
// One set of rules for every place a preset gets written: both preset editors, Settings > Data import and the boot
// check below, so a value Nought's own controls can't produce (50 SOL at 100% slippage from a shared file) never
// reaches a trade.
export const SLIPPAGES = [1, 5, 10, 15, 20, 30, 50], SELL_PCTS = [10, 25, 50, 75, 100], MAX_BUY = 1000;
export const PRESET_DEFAULTS = [
  { name: 'P1', buy: 0.1, sellPct: 50, slippage: 15, prio: 'fast', mev: 'off' },
  { name: 'P2', buy: 0.5, sellPct: 100, slippage: 20, prio: 'turbo', mev: 'off' },
  { name: 'P3', buy: 1, sellPct: 25, slippage: 10, prio: 'normal', mev: 'off' },
];
const isNum = (v) => typeof v === 'number' && isFinite(v);
export const PRESET_RULES = {
  name: (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 6,
  buy: (v) => isNum(v) && v > 0 && v <= MAX_BUY,
  sellPct: (v) => isNum(v) && v >= 1 && v <= 100,
  slippage: (v) => isNum(v) && v >= SLIPPAGES[0] && v <= SLIPPAGES[SLIPPAGES.length - 1], // the editors' range
  prio: (v) => typeof v === 'string' && Object.hasOwn(PRIO, v),
  mev: (v) => v === 'off' || v === 'protected',
};
// {value, bad[]}: every field checked; a missing or bad field takes fallback's value (a missing mev means 'off')
export function checkPreset(p, fallback) {
  const value = {}, bad = [];
  for (const [k, ok] of Object.entries(PRESET_RULES)) {
    let v = p && typeof p === 'object' ? p[k] : undefined;
    if (k === 'name' && typeof v === 'string') v = v.trim();
    if (k === 'mev' && v == null) v = 'off';
    if (ok(v)) value[k] = v; else { value[k] = fallback[k]; bad.push(k); }
  }
  return { value, bad };
}
// an RPC the Network page would accept: https, and not Solana's own public one (it refuses browsers)
export function okRpc(u) {
  try { const x = new URL(String(u)); return String(u).length <= 300 && x.protocol === 'https:' && !/api\.mainnet(-beta)?\.solana\.com$/i.test(x.host); } catch { return false; }
}
// Presets or an RPC outside those rules (an old import, hand-edited storage) are put back to safe values at boot,
// before anything can trade with them.
function repairSettings() {
  const fixed = [];
  if (!Number.isInteger(settings.preset) || settings.preset < 0 || settings.preset > 2) set({ preset: 0 });
  settings.presets.forEach((p, i) => { const { value, bad } = checkPreset(p, PRESET_DEFAULTS[i]); if (bad.length) { setPreset(i, value); fixed.push(`${value.name} ${bad.join(', ')}`); } });
  if (settings.rpc && !okRpc(settings.rpc)) { set({ rpc: '' }); fixed.push('RPC'); }
  if (fixed.length) toast(`<span class="t-title">Some saved trade settings were reset</span><span class="t-sub">They were outside what Nought allows (${esc(fixed.join('; '))}). Check them in <a href="#/settings/presets">Settings &gt; Presets</a>.</span>`, 'err');
}
// fees saved, never throwing on a damaged trade journal (Settings > Wallets uses it too)
export function savedFees() {
  try { const f = feesSaved(), n = (v) => (isNum(Number(v)) ? Number(v) : 0); return { sol: n(f?.sol), usd: n(f?.usd), trades: n(f?.trades), rate: n(f?.rate) || 0.01 }; }
  catch { return { sol: 0, usd: 0, trades: 0, rate: 0.01 }; }
}

// ---------------------------------------------------------------- hotkeys
// A binding is one key combo ("/", "1", "Shift+p", "Ctrl+Alt+k") or two in a row ("g p"). Saved in LS 'hotkeys'.
export const HOTKEYS = [
  { id: 'search', label: 'Open search', def: '/' },
  { id: 'preset1', label: 'Use preset 1', def: '1' },
  { id: 'preset2', label: 'Use preset 2', def: '2' },
  { id: 'preset3', label: 'Use preset 3', def: '3' },
  { id: 'goPulse', label: 'Go to Pulse', def: 'g p' },
  { id: 'goDiscover', label: 'Go to Discover', def: 'g d' },
  { id: 'goTrack', label: 'Go to Trackers', def: 'g t' },
  { id: 'goVision', label: 'Go to Vision', def: 'g v' },
  { id: 'goPortfolio', label: 'Go to Portfolio', def: 'g f' },
  { id: 'goWatch', label: 'Go to Watchlist', def: 'g w' },
  { id: 'goPerps', label: 'Go to Perps', def: 'g x' },
  { id: 'goHome', label: 'Go to the home page', def: 'g h' },
  { id: 'goSettings', label: 'Open settings', def: 'g s' },
  { id: 'wallet', label: 'Open the wallet menu', def: 'w' },
  { id: 'convert', label: 'Convert SOL ⇄ USDC', def: 'c' },
  { id: 'alerts', label: 'Open notifications', def: 'n' },
  { id: 'ticker', label: 'Show or hide the watchlist strip', def: 't' },
  { id: 'pnl', label: 'Show or hide the live PnL widget', def: 'p' },
  { id: 'help', label: 'Show these hotkeys', def: '?' },
];
export const keyState = { capturing: false }; // the settings page sets this while it records a new binding
// two bindings clash when they are the same keys, or one is the first step of the other
const clash = (a, b) => !!a && !!b && (a === b || a.startsWith(b + ' ') || b.startsWith(a + ' '));
export function hotkeys() {
  const saved = LS.get('hotkeys', {}) || {}, out = {}, mine = (id) => typeof saved[id] === 'string';
  for (const h of HOTKEYS) out[h.id] = mine(h.id) ? saved[h.id] : h.def;
  // a default (say, of an action added later) that collides with keys the user picked for something else stays unset
  for (const h of HOTKEYS) if (!mine(h.id) && HOTKEYS.some((x) => x.id !== h.id && mine(x.id) && clash(saved[x.id], out[h.id]))) out[h.id] = '';
  return out;
}
// set one binding; any other action that would clash is cleared. Returns the ids that were cleared.
export function setHotkey(id, combo) {
  const cur = hotkeys(), cleared = [];
  combo = String(combo || '').trim();
  if (combo) for (const [k, v] of Object.entries(cur)) if (k !== id && clash(v, combo)) { cur[k] = ''; cleared.push(k); }
  cur[id] = combo;
  LS.set('hotkeys', cur); emit('hotkeys', cur);
  return cleared;
}
export function resetHotkeys() { LS.set('hotkeys', {}); emit('hotkeys', hotkeys()); }
const MODS = ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super', 'Dead', 'Unidentified', 'Process'];
export function comboOf(e) {
  if (!e.key || MODS.includes(e.key) || e.isComposing) return '';
  let k = e.key;
  const chord = e.altKey || e.ctrlKey || e.metaKey;
  if (chord && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();       // Alt+P types "π" on a Mac
  else if (chord && /^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toLowerCase();
  const shift = e.shiftKey && (k.length > 1 || /[a-z]/.test(k)); // "?" already carries its Shift
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.metaKey && 'Meta', shift && 'Shift', k].filter(Boolean).join('+');
}
const KEY_NAMES = { Meta: navigator.platform?.startsWith('Mac') ? '⌘' : 'Win', Space: 'Space', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc' };
export const comboLabel = (c) => (c ? c.split(' ').map((step) => step.split('+').map((k) => KEY_NAMES[k] || (k.length === 1 ? k.toUpperCase() : k)).join('+')).join(' then ') : '');
const GO = { goPulse: '#/pulse', goDiscover: '#/discover', goTrack: '#/track', goVision: '#/track/vision', goPortfolio: '#/portfolio', goWatch: '#/watch', goPerps: '#/perps', goHome: '#/', goSettings: '#/settings' };
function runHotkey(id) {
  if (id === 'search') openSearch();
  else if (/^preset[123]$/.test(id)) { set({ preset: Number(id.slice(-1)) - 1 }); toast(`Preset ${esc(preset().name)}: buy ${esc(String(preset().buy))} SOL`); }
  else if (GO[id]) location.hash = GO[id];
  else if (id === 'wallet') { if (wallet.owner) walletMenu?.open(true); else openWalletPicker(); }
  else if (id === 'convert') openConvert();
  else if (id === 'alerts') openBell();
  else if (id === 'ticker') toggleTicker();
  else if (id === 'pnl') togglePnl();
  else if (id === 'help') location.hash = '#/settings/hotkeys';
}
let pending = '', pendingAt = 0;
function onKey(e) {
  if (keyState.capturing || e.defaultPrevented || e.repeat) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key?.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; } // always on
  const c = comboOf(e); if (!c) return;
  const binds = Object.entries(hotkeys()).filter(([, v]) => v);
  if (pending && Date.now() - pendingAt < 1000) {
    const hit = binds.find(([, v]) => v === pending + ' ' + c); pending = '';
    if (hit) { e.preventDefault(); runHotkey(hit[0]); return; }
  }
  pending = '';
  const hit = binds.find(([, v]) => v === c);
  if (hit) { e.preventDefault(); runHotkey(hit[0]); return; }
  if (binds.some(([, v]) => v.startsWith(c + ' '))) { pending = c; pendingAt = Date.now(); }
}

// ---------------------------------------------------------------- themes
// LS 'theme' = {name: 'dark'|'grey'|'oled'|'light', accent: '#rrggbb' | ''} (index.html applies it before first paint).
// Change it only through setTheme(patch): that saves it, applies it, then emits util 'theme' {name, accent, colors}.
// A change made in another tab is applied here and emits the same event (see initShell).
export const THEMES = [
  { id: 'dark', name: 'Nought Dark', sw: ['#101114', '#1b1d23', '#8c9dff'] },
  { id: 'grey', name: 'Grey', sw: ['#15171c', '#22262e', '#38d6f5'] },
  { id: 'oled', name: 'OLED black', sw: ['#000000', '#0a0b0e', '#38d6f5'] },
  { id: 'light', name: 'Light', sw: ['#f3f4f7', '#ffffff', '#087893'] },
];
export const ACCENTS = ['#8c9dff', '#38d6f5', '#7c8cff', '#2fd38b', '#ffc24b', '#ff7ab6', '#ff8a3d', '#c3f53b'];
const HEX = /^#[0-9a-f]{6}$/i;
export function theme() {
  const t = LS.get('theme', {}) || {};
  return { name: THEMES.some((x) => x.id === t.name) ? t.name : 'dark', accent: HEX.test(t.accent || '') ? t.accent.toLowerCase() : '' };
}
const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lumOf = (hex) => { const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }, [r, g, b] = rgbOf(hex); return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b); };
const toBlack = (hex, k) => '#' + rgbOf(hex).map((v) => Math.round(v * (1 - k)).toString(16).padStart(2, '0')).join('');
// readable text on an accent: dark ink on light accents, white on dark ones
export function inkFor(hex) { return lumOf(hex) > 0.3 ? '#05131a' : '#ffffff'; }
// The accent as it is shown in a theme. On Light a bright pick (#ffc24b, #c3f53b) would make 1.5:1 links and tabs on
// white, so it is mixed toward black in 5% steps until it reaches 4.5:1 against white. index.html's pre-paint script
// does the same. Other themes use the pick as is.
export function accentFor(hex, name = theme().name) {
  if (name !== 'light' || !HEX.test(hex || '')) return hex;
  for (let i = 0; i <= 20; i++) { const c = toBlack(hex, i / 20); if (1.05 / (lumOf(c) + 0.05) >= 4.5) return c; }
  return '#000000';
}
export function applyTheme(t = theme()) {
  const r = document.documentElement;
  if (t.name !== 'dark') r.dataset.theme = t.name; else delete r.dataset.theme;
  if (t.accent) {
    const a = accentFor(t.accent, t.name);
    r.style.setProperty('--accent', a);
    r.style.setProperty('--accent-2', t.name === 'light' ? toBlack(a, 0.15) : `color-mix(in srgb, ${a} 78%, #000)`);
    r.style.setProperty('--accent-ink', inkFor(a));
  } else for (const p of ['--accent', '--accent-2', '--accent-ink']) r.style.removeProperty(p);
  $('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(r).getPropertyValue('--panel').trim() || '#0c0e13');
}
// the theme's colours as plain strings (hex), read from the CSS tokens now in force
export function themeColors() {
  const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
  return { bg: v('--bg'), panel: v('--panel'), panel2: v('--panel-2'), line: v('--line'), line2: v('--line-2'), fg: v('--fg'), muted: v('--muted'), dim: v('--dim'), accent: v('--accent'), up: v('--up'), down: v('--down'), warn: v('--warn') };
}
// emits util 'theme' {name, accent, colors}: the one place it is sent from
const announceTheme = () => emit('theme', { ...theme(), colors: themeColors() });
export function setTheme(patch) { const t = { ...theme(), ...patch }; LS.set('theme', t); applyTheme(theme()); announceTheme(); }

// ---------------------------------------------------------------- RPC health
// one getSlot against a single endpoint (no failover): {ok, ms, slot?, error?}
export async function probeRpc(url = rpcUrl()) {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }), signal: AbortSignal.timeout(7000) });
    const j = await r.json().catch(() => null), ms = Math.round(performance.now() - t0);
    if (!r.ok || !(j?.result > 0)) return { ok: false, ms, error: j?.error?.message || `HTTP ${r.status}` };
    return { ok: true, ms, slot: j.result };
  } catch (e) { return { ok: false, ms: Math.round(performance.now() - t0), error: e?.name === 'TimeoutError' ? 'No answer in 7 s' : 'Blocked or offline (CORS or network)' }; }
}

// ---------------------------------------------------------------- watchlist strip
// Visible only while it is switched on (tick.hidden false) AND the watchlist has coins: an empty watchlist takes no
// space at all. The data is LS 'watch' (starred order; the 40 most recent are shown); util 'watch' redraws at once.
const TICK_MAX = 40;
const tick = { hidden: !!LS.get('ticker.hidden', false), key: '', renders: 0, meta: new Map(), px: new Map(), asked: new Set(), err: false, busy: false, again: false };
const watchList = () => { const l = LS.get('watch', []); return Array.isArray(l) ? [...new Set(l.filter(isMint))].slice(-TICK_MAX) : []; };
export const tickerHidden = () => tick.hidden; // the user's switch, not whether it is on screen right now
export function toggleTicker(force) {
  tick.hidden = typeof force === 'boolean' ? !force : !tick.hidden;
  LS.set('ticker.hidden', tick.hidden);
  emit('ticker', !tick.hidden);
  if (!tick.hidden && !watchList().length) toast('The watchlist strip is on. It appears under the top bar once you star a coin.');
  syncTicker();
  if (!tick.hidden) pollTicker();
}
// show or hide the strip (and keep its switches in step); the layout only changes when its visibility does
function syncTicker() {
  const el = $('#ticker'), show = !tick.hidden && watchList().length > 0;
  $('#ticker-toggle').setAttribute('aria-pressed', String(!tick.hidden));
  $('#nav-ticker').textContent = tick.hidden ? 'Show watchlist strip' : 'Hide watchlist strip';
  if (el.hidden !== show) return;
  el.hidden = !show;
  window.dispatchEvent(new Event('resize')); // charts size to their box
}
const tkSym = (m) => tokens.get(m)?.symbol || tick.meta.get(m)?.symbol || short(m, 3);
const tkImg = (m) => safeUrl(tokens.get(m)?.image || tick.meta.get(m)?.image || '');
// $1.23, $0.0123, $0.0₅288 (the subscript counts the zeros, as on the token page)
function tkPrice(p) { return p == null ? '—' : p >= 1 ? '$' + p.toFixed(p >= 1000 ? 0 : 2) : fmtPrice(Number(p.toPrecision(3))); }
function tkItem(m, copy) {
  const s = String(tkSym(m)), i = tkImg(m), q = tick.px.get(m), ch = q?.change24h;
  return `<a class="tk-i" href="#/t/${esc(m)}"${copy ? ' tabindex="-1" aria-hidden="true"' : ''} data-tk="${esc(m)}">${i ? `<img src="${esc(i)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="tk-av">${esc(s.slice(0, 2).toUpperCase())}</span>`}<b>${esc(s)}</b><span class="px">${tkPrice(q?.price)}</span><span class="ch ${ch > 0 ? 'up' : ch < 0 ? 'down' : 'muted'}">${ch == null ? '' : (ch > 0 ? '+' : '') + ch.toFixed(Math.abs(ch) >= 100 ? 0 : 1) + '%'}</span></a>`;
}
function renderTicker(force = false) {
  syncTicker();
  if (tick.hidden) return;
  const list = watchList(), track = $('#tk-track'), key = list.join(',') + '|' + list.map(tkSym).join(',');
  if (!list.length) { tick.key = ''; tick.renders++; track.className = 'tk-track'; track.style.removeProperty('--tk-dur'); track.innerHTML = ''; return; }
  if (key === tick.key && !force) { // same coins: update numbers in place so the scroll doesn't jump
    for (const el of $$('[data-tk]', track)) { const q = tick.px.get(el.dataset.tk), ch = q?.change24h, c = el.querySelector('.ch'); el.querySelector('.px').textContent = tkPrice(q?.price); c.className = 'ch ' + (ch > 0 ? 'up' : ch < 0 ? 'down' : 'muted'); c.textContent = ch == null ? '' : (ch > 0 ? '+' : '') + ch.toFixed(Math.abs(ch) >= 100 ? 0 : 1) + '%'; }
    return;
  }
  tick.key = key;
  const n = ++tick.renders;
  track.className = 'tk-track'; track.style.removeProperty('--tk-dur');
  track.innerHTML = list.map((m) => tkItem(m, false)).join('');
  // scroll only when it doesn't fit: a second copy makes the loop seamless
  requestAnimationFrame(() => {
    if (n !== tick.renders) return; // a newer render replaced this one
    const vp = $('#tk-viewport'), w = track.scrollWidth;
    if (w > vp.clientWidth + 4) { track.insertAdjacentHTML('beforeend', list.map((m) => tkItem(m, true)).join('')); track.style.setProperty('--tk-dur', Math.max(20, Math.round(w / 45)) + 's'); track.classList.add('run'); }
  });
}
// names for coins the store doesn't know: Dexscreener first (its queue is quick), then Jupiter search
function tickerNames(list) {
  const missing = list.filter((m) => !tokens.get(m)?.symbol && !tick.meta.get(m)?.symbol && !tick.asked.has(m));
  if (!missing.length) return;
  missing.forEach((m) => tick.asked.add(m));
  ds.tokens(missing).then((map) => { for (const [m, p] of map) if (p?.baseToken?.symbol) tick.meta.set(m, { symbol: String(p.baseToken.symbol).slice(0, 24), image: img(p.info?.imageUrl) }); }).catch(() => {})
    .then(() => { const rest = missing.filter((m) => !tick.meta.get(m)?.symbol); renderTicker(); return rest.length ? jt.search(rest) : []; })
    .then((l) => { for (const t of l) if (t.symbol) tick.meta.set(t.mint, { symbol: t.symbol, image: t.image }); if (l.length) renderTicker(); })
    .catch(() => {})
    .finally(() => missing.forEach((m) => { if (!tick.meta.get(m)?.symbol) tick.asked.delete(m); }));
}
async function pollTicker() {
  if (tick.hidden || hidden()) { syncTicker(); return; }
  renderTicker(); // the coins show at once; prices fill in when they arrive
  const list = watchList();
  if (!list.length) return;
  if (tick.busy) { tick.again = true; return; } // a coin starred mid-fetch gets its price right after
  tick.busy = true;
  tickerNames(list);
  try {
    // prices: Jupiter, then Dexscreener for whatever it misses (pricesFor)
    const px = await pricesFor(list), next = new Map(tick.px);
    const nn = (v) => (v == null || !isFinite(Number(v)) ? null : Number(v));
    for (const [m, p] of px) next.set(m, { price: nn(p?.priceUsd), change24h: nn(p?.change24h) });
    tick.px = next; tick.err = false;
  } catch { tick.err = true; } finally { tick.busy = false; }
  renderTicker();
  if (tick.again) { tick.again = false; pollTicker(); }
}

// ---------------------------------------------------------------- live PnL widget (src/ui/pnlwidget.js, loaded on use)
const pnlMod = () => import('./pnlwidget.js');
export const pnlShown = () => !!document.querySelector('body > .pnlw');
let pnlWas = null;
function syncPnl(open = pnlShown()) {
  $('#pnl-toggle')?.setAttribute('aria-pressed', String(open));
  const n = $('#nav-pnl'); if (n) n.textContent = open ? 'Hide live PnL widget' : 'Show live PnL widget';
  if (pnlWas !== null && pnlWas !== open) emit('pnlwidget', open);
  pnlWas = open;
}
// force: true opens, false closes, nothing toggles. Resolves to whether it is open now.
export function togglePnl(force) {
  return pnlMod().then((m) => { const open = m.togglePnlWidget(force); syncPnl(open); return open; })
    .catch((e) => { toast(esc(e?.message || 'The live PnL widget did not load.'), 'err'); return false; });
}
// the header buttons' tooltips name the current keys
function keyTitles() {
  const k = hotkeys(), with$ = (label, id) => label + (k[id] ? ` (${comboLabel(k[id])})` : '');
  $('#ticker-toggle').title = with$('Show or hide the watchlist strip', 'ticker');
  $('#pnl-toggle').title = with$('Show or hide the live PnL widget', 'pnl');
}

// ---------------------------------------------------------------- wallet pill + menu
let walletMenu = null;
const bal = { owner: null, sol: null }; let balSeq = 0;
async function refreshBalance() {
  const owner = wallet.owner, my = ++balSeq;
  if (!owner) { bal.owner = null; bal.sol = null; walletUi(); return; }
  if (bal.owner !== owner) { bal.owner = owner; bal.sol = null; walletUi(); }
  try { const s = await solBalance(owner); if (my === balSeq && owner === wallet.owner) bal.sol = s; } catch { /* keep the last one */ }
  walletUi();
}
function walletUi() {
  const wb = $('#wallet-btn');
  if (!wallet.owner) {
    walletMenu?.close(false);
    wb.className = 'wpill connect'; wb.textContent = 'Connect'; wb.title = 'Connect a wallet';
    wb.setAttribute('aria-haspopup', 'dialog'); wb.setAttribute('aria-label', 'Connect a wallet');
    return;
  }
  const b = bal.owner === wallet.owner ? fmtSol(bal.sol) : '—', local = wallet.kind === 'local';
  wb.className = 'wpill'; wb.setAttribute('aria-haspopup', 'menu');
  wb.innerHTML = `<i class="wp-kind ${local ? 'local' : ''}" aria-hidden="true"></i><span class="wp-name">${esc(wallet.name || short(wallet.owner))}</span><span class="wp-bal">${b}<span class="dim"> SOL</span></span><svg class="wp-car" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  wb.title = `${wallet.name || 'Wallet'} (${local ? 'local wallet in this browser' : 'browser extension'}) ${wallet.owner}`;
  wb.setAttribute('aria-label', `${wallet.name || 'Wallet'}, ${b} SOL: open the wallet menu`);
}
function renderWalletMenu() {
  const m = $('#wallet-menu'), local = wallet.kind === 'local', fs = savedFees(), owner = wallet.owner;
  if (!owner) { m.innerHTML = ''; return; }
  const picked = Array.isArray(wallet.selected) ? wallet.selected.length : 0;
  m.innerHTML = `<div class="wm-headbox">
      <div class="l"><b>${esc(wallet.name || 'Wallet')}</b><span class="wm-kindtag ${local ? 'local' : ''}">${local ? 'Local' : 'Extension'}</span></div>
      <div class="addr"><span>${esc(short(owner, 6))}</span><button type="button" data-copy="${esc(owner)}" aria-label="Copy address" title="Copy address">${ICON.copy}</button></div>
      <div class="wm-bals"><span>SOL <b id="wmb-sol">${bal.owner === owner && bal.sol != null ? fmtSol(bal.sol) : '…'}</b></span><span>USDC <b id="wmb-usdc">…</b></span></div>
      ${picked > 1 ? `<span class="wm-multi">${picked} local wallets picked for multi-wallet trades</span>` : ''}
    </div>
    <button type="button" role="menuitem" data-wa="manage">Manage wallets<small>switch · add · lock</small></button>
    <button type="button" role="menuitem" data-wa="deposit">Deposit<small>address · QR</small></button>
    <button type="button" role="menuitem" data-wa="withdraw">Withdraw<small>SOL or tokens</small></button>
    <button type="button" role="menuitem" data-wa="convert">Convert SOL ⇄ USDC<small>via Jupiter</small></button>
    ${fs.trades > 0 ? `<div class="wm-saved" role="note"><b>Fees saved: ${fmtSol(fs.sol)} SOL${fs.usd > 0 ? ' · ' + usd(fs.usd, 2) : ''}</b><span>Compared with a typical ${(fs.rate * 100).toFixed(0)}% terminal fee, on ${fs.trades} trade${fs.trades === 1 ? '' : 's'} made in this browser. Nought charges 0%.</span></div>` : ''}
    <div class="wm-sep" role="separator"></div>
    <button type="button" role="menuitem" data-wa="disconnect" class="danger"${local ? ' title="The keys stay in this browser; pick it again any time from Manage wallets."' : ''}>${local ? 'Stop using this wallet' : 'Disconnect'}</button>`;
  ju.balances(owner).then((b) => {
    if (wallet.owner !== owner) return;
    const s = $('#wmb-sol'), u = $('#wmb-usdc');
    if (s) s.textContent = fmtSol(Number(b.sol));
    if (u) { const n = Number(b.tokens?.[USDC_MINT]?.ui) || 0; u.textContent = n === 0 ? '0' : n.toFixed(2); }
  }).catch(() => { const u = $('#wmb-usdc'); if (u) u.textContent = '—'; });
}
function onWalletMenu(e) {
  const b = e.target.closest('[data-wa]'); if (!b) return;
  const a = b.dataset.wa, owner = wallet.owner;
  walletMenu.close(true); // focus goes back to the pill, so a dialog opened next returns focus there
  const fail = (err) => toast(esc(err?.message || 'Could not open the wallet manager.'), 'err');
  if (a === 'manage') wui().then((w) => w.openWalletManager()).catch(fail);
  else if (a === 'deposit') wui().then((w) => w.openDeposit(owner)).catch(fail);
  else if (a === 'withdraw') wui().then((w) => w.openWithdraw(owner)).catch(fail);
  else if (a === 'convert') openConvert();
  else if (a === 'disconnect') disconnectWallet();
}

// ---------------------------------------------------------------- convert SOL ⇄ USDC
const TOK = { sol: { mint: SOL_MINT, sym: 'SOL', dec: 9, cls: '' }, usdc: { mint: USDC_MINT, sym: 'USDC', dec: 6, cls: 'usdc' } };
const SOL_RESERVE = 0.01; // left behind on "Max" for network fees and account rent
const cv = { dir: 'sol', amt: '', slip: 0.5, mev: 'off', step: 'form', q: null, d: null, minRaw: null, ok: false, qAt: 0, raw: 0n, err: '', loading: false, seq: 0, timer: 0, bal: null, owner: null, done: '' };
const cvIn = () => TOK[cv.dir], cvOut = () => (cv.dir === 'sol' ? TOK.usdc : TOK.sol);
const fmtUi = (n, dec) => (n == null || !isFinite(n) ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: dec === 6 ? 2 : 6 }));
// The least a quote guarantees, as a raw-unit string of what comes back (contract C2: trade() re-quotes and refuses to
// sign when the fresh minimum is below this). trade.js's own minOutOf when it has one, so the review shows exactly
// what trade() compares; else swap/v1 otherAmountThreshold, Ultra outAmount less its slippageBps.
function minOutOf(q) {
  try {
    if (typeof tradeX.minOutOf === 'function') return BigInt(tradeX.minOutOf(q)).toString();
    if (q.mode === 'ultra' || q.requestId) { const bps = BigInt(Math.min(10000, Math.max(0, Math.round(Number(q.slippageBps) || 0)))); return ((BigInt(q.outAmount) * (10000n - bps)) / 10000n).toString(); }
    return BigInt(q.otherAmountThreshold).toString();
  } catch { return null; }
}
const minUi = () => (cv.minRaw == null ? null : Number(cv.minRaw) / 10 ** cvOut().dec);
// the quote on screen is for exactly this direction and amount (never sign a quote left over from a flip or an edit)
const cvQuoteMatches = () => !!(cv.d && cv.q && cv.minRaw != null && cv.raw > 0n && cv.q.inputMint === cvIn().mint && cv.q.outputMint === cvOut().mint && String(cv.q.inAmount) === cv.raw.toString());
// what was typed, as a string toRaw() reads ("0,5" → "0.5", ".5" → "0.5"), or null when parseAmount can't read it
function cvAmount() {
  const s = String(cv.amt || '').trim();
  if (!s) return '';
  if (!(parseAmount(s) >= 0)) return null;
  return s.replace(',', '.').replace(/^\./, '0.').replace(/\.$/, '');
}
export function openConvert(dir) {
  if (!wallet.owner) { openWalletPicker(); return; }
  const d = $('#convert-dlg');
  Object.assign(cv, { step: 'form', q: null, d: null, minRaw: null, err: '', loading: false, done: '', owner: wallet.owner, mev: preset().mev === 'protected' ? 'protected' : 'off' });
  if (dir === 'sol' || dir === 'usdc') cv.dir = dir;
  if (cv.owner !== cv.bal?.owner) cv.bal = null;
  renderConvert();
  if (!d.open) d.showModal();
  $('#cv-amt')?.focus();
  loadCvBalances();
  if (cv.amt) requote();
}
async function loadCvBalances() {
  const owner = cv.owner;
  try {
    const b = await ju.balances(owner);
    if (owner !== cv.owner) return;
    cv.bal = { owner, sol: Number(b.sol), lamports: BigInt(b.lamports || '0'), usdc: Number(b.tokens?.[USDC_MINT]?.ui) || 0, usdcRaw: BigInt(b.tokens?.[USDC_MINT]?.raw || '0') };
  } catch { cv.bal = { owner, error: true }; }
  if (cv.step === 'form') paintCvBal();
}
const cvBalRaw = () => (!cv.bal || cv.bal.error ? null : cv.dir === 'sol' ? cv.bal.lamports : cv.bal.usdcRaw);
function paintCvBal() {
  const el = $('#cv-bal'); if (!el) return;
  const b = cv.bal;
  el.textContent = !b ? 'Balance …' : b.error ? 'Balance unavailable' : `Balance ${cv.dir === 'sol' ? fmtUi(b.sol, 9) + ' SOL' : fmtUi(b.usdc, 6) + ' USDC'}`;
}
function feeRows(d) {
  return d.fees.map((f) => `<div class="${f.who === 'pool' ? 'muted-row' : ''}"><span>${esc(f.label)}</span><b>${f.sol != null ? (f.sol > 0 && f.sol < 0.000001 ? '<0.000001' : Number(f.sol).toFixed(6)) + ' SOL' : ''}${f.bps != null ? `${f.sol != null ? ' · ' : ''}${(f.bps / 100).toFixed(2)}%` : ''}${f.note ? `${f.sol != null || f.bps != null ? ' · ' : ''}<span class="muted">${esc(f.note)}</span>` : ''}</b></div>`).join('')
    + '<div class="n0"><span>Nought fee</span><b>0%</b></div>';
}
function renderConvert() {
  const body = $('#cv-body'), iT = cvIn(), oT = cvOut();
  if (cv.step === 'form') {
    body.innerHTML = `<div class="cv-box"><div class="cv-lbl"><label for="cv-amt">You pay</label><span><span id="cv-bal">Balance …</span> <button type="button" data-cv="half">Half</button> <button type="button" data-cv="max">Max</button></span></div>
        <div class="cv-row"><input id="cv-amt" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.00" value="${esc(cv.amt)}" aria-describedby="cv-qbox"><span class="cv-tok"><i class="${iT.cls}"></i>${iT.sym}</span></div></div>
      <button type="button" class="cv-flip" data-cv="flip" aria-label="Swap direction: pay ${oT.sym} instead"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 4v16m0 0-4-4m4 4 4-4M16 20V4m0 0-4 4m4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="cv-box"><div class="cv-lbl"><span>You get about</span><span id="cv-rate"></span></div><div class="cv-row"><span class="cv-out dim" id="cv-out">0.00</span><span class="cv-tok"><i class="${oT.cls}"></i>${oT.sym}</span></div></div>
      <div class="cv-opt"><span>Route</span><div class="seg sm" role="group" aria-label="Route">${[['off', 'Standard'], ['protected', 'MEV-protected']].map(([v, l]) => `<button type="button" data-cv-mev="${v}" aria-pressed="${cv.mev === v}">${l}</button>`).join('')}</div></div>
      <div class="cv-opt" ${cv.mev === 'protected' ? 'hidden' : ''}><span>Slippage</span><div class="seg sm" role="group" aria-label="Slippage">${[0.1, 0.5, 1].map((v) => `<button type="button" data-cv-slip="${v}" aria-pressed="${cv.slip === v}">${v}%</button>`).join('')}</div></div>
      <div id="cv-qbox" aria-live="polite"></div>
      <div class="go-row"><button type="button" class="btn btn-ghost" data-cv="close">Cancel</button><button type="button" class="btn btn-accent" data-cv="review" id="cv-review" disabled>Review</button></div>
      <p class="hint cv-hint">Swaps run through Jupiter from your wallet back to the same wallet. ${cv.mev === 'protected' ? 'MEV-protected trades go through Jupiter Ultra, which charges its own small fee and sets slippage itself.' : 'Your wallet signs and sends the trade.'} Nought adds no fee.</p>`;
    paintCvBal(); paintQuote();
  } else if (cv.step === 'review') {
    const d = cv.d, w = wallet.name || 'Your wallet';
    body.innerHTML = `<div class="cv-sum">
        <div><span>You pay</span><b class="cv-big">${fmtUi(d.inUi, iT.dec)} ${iT.sym}</b></div>
        <div><span>You get about</span><b class="cv-big">${fmtUi(d.outUi, oT.dec)} ${oT.sym}</b></div>
        <div><span>At least</span><b>${fmtUi(minUi(), oT.dec)} ${oT.sym}</b></div>
        <div><span>From and to</span><b>${esc(w)} · ${esc(short(cv.owner, 5))} (this wallet)</b></div>
        <div><span>Route</span><b>${d.mode === 'protected' ? 'Jupiter Ultra (MEV-protected)' : esc(d.routeLabel)}</b></div>
      </div>
      <div class="cv-q">${feeRows(d)}</div>
      ${cv.err ? `<div class="cv-err" role="alert">${esc(cv.err)}</div>` : ''}
      <p class="hint cv-hint">${d.mode === 'protected' ? 'Your wallet signs, then Jupiter sends it.' : 'Your wallet shows the transaction to approve.'} The ${oT.sym} comes back to the same address. Nothing goes anywhere else. If the price moves below the minimum before you sign, Nought stops and asks you to review again.</p>
      <div class="go-row"><button type="button" class="btn btn-ghost" data-cv="back">Back</button><button type="button" class="btn btn-accent" data-cv="confirm" autofocus>Confirm and sign</button></div>`;
    $('[data-cv="confirm"]', body)?.focus();
  } else if (cv.step === 'sending') {
    body.innerHTML = `<div class="cv-state"><span class="pulse-dot" aria-hidden="true"></span><b>Waiting for your wallet and the network…</b><span class="hint">You can close this window; progress shows in the corner.</span></div><div class="go-row"><span></span><button type="button" class="btn" data-cv="close">Close</button></div>`;
  } else {
    body.innerHTML = `<div class="cv-state ${cv.ok ? 'ok' : 'warn'}"><b>${esc(cv.done)}</b></div><div class="go-row"><button type="button" class="btn btn-ghost" data-cv="again">${cv.ok ? 'Convert more' : 'Back to the form'}</button><button type="button" class="btn btn-accent" data-cv="close">Done</button></div>`;
    $('[data-cv="close"]', body)?.focus();
  }
}
function paintQuote() {
  const box = $('#cv-qbox'), out = $('#cv-out'), rev = $('#cv-review'), rate = $('#cv-rate'); if (!box) return;
  const d = cv.d, iT = cvIn(), oT = cvOut(), braw = cvBalRaw();
  const over = d && braw != null && cv.raw > braw - (cv.dir === 'sol' ? BigInt(Math.round(SOL_RESERVE * 1e9)) : 0n);
  out.textContent = d ? fmtUi(d.outUi, oT.dec) : cv.loading ? '…' : '0.00'; out.classList.toggle('dim', !d);
  rate.textContent = d && d.inUi > 0 ? `1 SOL ≈ ${(cv.dir === 'sol' ? d.outUi / d.inUi : d.inUi / d.outUi).toFixed(2)} USDC` : '';
  rev.disabled = !d || cv.loading || over;
  if (cv.err) { box.innerHTML = `<div class="cv-err" role="alert">${esc(cv.err)}${cv.raw > 0n ? ' <button type="button" class="btn btn-ghost sm" data-cv="retry">Try again</button>' : ''}</div>`; return; }
  if (cv.loading && !d) { box.innerHTML = '<div class="cv-q"><div><span>Getting a quote from Jupiter…</span><b></b></div></div>'; return; }
  if (!d) { box.innerHTML = ''; return; }
  const warn = impactWarning(d, null);
  box.innerHTML = `${over ? `<div class="cv-warn danger" role="alert">That is more than this wallet holds${cv.dir === 'sol' ? ` (keep about ${SOL_RESERVE} SOL for fees)` : ''}.</div>` : ''}${warn ? `<div class="cv-warn ${warn.level === 'danger' ? 'danger' : ''}">${esc(warn.text)}</div>` : ''}
    <div class="cv-q"><div><span>Minimum received</span><b>${fmtUi(minUi(), oT.dec)} ${oT.sym}</b></div><div><span>Price impact</span><b>${d.impactPct < 0.01 ? '<0.01' : d.impactPct.toFixed(2)}%</b></div>${d.mode === 'standard' ? `<div><span>Slippage</span><b>${(d.slippageBps / 100).toFixed(2)}%</b></div>` : ''}<div><span>Route</span><b>${d.mode === 'protected' ? 'Jupiter Ultra' : esc(d.routeLabel)}</b></div>${feeRows(d)}</div>`;
}
// a rate-limited quote is retried twice (3 s apart) before the error shows; only quotes are retried, never a trade
function requote(delay = 0, attempt = 0) {
  clearTimeout(cv.timer);
  const my = ++cv.seq;
  cv.d = null; cv.q = null; cv.minRaw = null; cv.err = '';
  let raw = 0n;
  const amt = cvAmount();
  if (amt === null) cv.err = `Enter an amount like 0.5 (numbers and one decimal point only).`;
  else try { raw = amt ? toRaw(amt, cvIn().dec) : 0n; } catch (e) { cv.err = e.message; }
  cv.raw = raw; cv.loading = raw > 0n && !cv.err;
  paintQuote();
  if (!cv.loading) return Promise.resolve(false);
  return new Promise((res) => {
    cv.timer = setTimeout(async () => {
      try {
        const q = await quoteFor(cvIn().mint, cvOut().mint, raw.toString(), { mev: cv.mev, slippage: cv.slip });
        if (my !== cv.seq) return res(false);
        const min = minOutOf(q);
        if (min == null || !(BigInt(min) > 0n)) throw new Error('Jupiter sent a quote without a minimum amount. Try again in a moment.');
        cv.q = q; cv.d = quoteDetails(q, { inDec: cvIn().dec, outDec: cvOut().dec, prio: preset().prio }); cv.minRaw = min;
        cv.qAt = Date.now();
      } catch (e) {
        if (my !== cv.seq) return res(false);
        const limited = /too many|rate limit|429/i.test(e.message || '');
        if (limited && attempt < 2) return res(requote(3000, attempt + 1));
        cv.err = limited ? 'Jupiter is busy right now (rate limit). Try again in a few seconds.' : e.message || 'No quote right now. Try again in a moment.';
      }
      cv.loading = false; paintQuote(); res(!!cv.d);
    }, delay);
  });
}
function setAmountRaw(raw) {
  const dec = cvIn().dec, s = raw.toString().padStart(dec + 1, '0');
  cv.amt = (s.slice(0, s.length - dec) + '.' + s.slice(s.length - dec)).replace(/\.?0+$/, '') || '0';
  $('#cv-amt').value = cv.amt; requote();
}
async function onConvertClick(e) {
  const b = e.target.closest('button'); if (!b) return;
  const a = b.dataset.cv;
  if (a === 'close') { $('#convert-dlg').close(); return; }
  if (a === 'flip') { clearTimeout(cv.timer); cv.seq++; Object.assign(cv, { dir: cv.dir === 'sol' ? 'usdc' : 'sol', amt: '', d: null, q: null, minRaw: null, raw: 0n, err: '', loading: false }); renderConvert(); $('#cv-amt').focus(); return; } // seq++: a quote still on its way is for the other direction
  if (a === 'max' || a === 'half') {
    const braw = cvBalRaw(); if (braw == null) return;
    let raw = cv.dir === 'sol' ? braw - BigInt(Math.round(SOL_RESERVE * 1e9)) : braw;
    if (a === 'half') raw = braw / 2n;
    setAmountRaw(raw > 0n ? raw : 0n); return;
  }
  if (b.dataset.cvMev) { cv.mev = b.dataset.cvMev === 'protected' ? 'protected' : 'off'; renderConvert(); requote(); return; }
  if (b.dataset.cvSlip) { cv.slip = Number(b.dataset.cvSlip); renderConvert(); requote(); return; }
  if (a === 'retry') { requote(); return; }
  if (a === 'review') { // a quote from the last 15 s is shown as is; an older one is refreshed first
    if (cvQuoteMatches() && Date.now() - (cv.qAt || 0) < 15000) { cv.step = 'review'; renderConvert(); return; }
    b.disabled = true; b.textContent = 'Checking…'; if (await requote() && cvQuoteMatches()) { cv.step = 'review'; renderConvert(); } else { b.textContent = 'Review'; } return;
  }
  if (a === 'back') { cv.step = 'form'; cv.err = ''; renderConvert(); paintQuote(); $('#cv-amt').focus(); return; }
  if (a === 'again') { cv.step = 'form'; if (cv.ok) cv.amt = ''; cv.d = null; cv.minRaw = null; renderConvert(); loadCvBalances(); $('#cv-amt').focus(); if (cv.amt) requote(); return; }
  if (a === 'confirm') {
    if (wallet.owner !== cv.owner) { cv.err = 'The active wallet changed. Go back and review again.'; renderConvert(); return; }
    if (!cvQuoteMatches()) { cv.err = 'This review no longer matches the form. Go back and review again.'; renderConvert(); return; }
    // minOutRaw: the minimum shown on this review; trade() re-quotes and stops before signing if the new one is lower
    const side = cv.dir === 'sol' ? 'buy' : 'sell', raw = cv.raw, d = cv.d, minOutRaw = cv.minRaw;
    cv.step = 'sending'; renderConvert();
    try {
      const ok = await trade(side, USDC_MINT, raw, { slippage: cv.slip, mev: cv.mev, label: 'USDC', owner: cv.owner, maxImpactPct: 3, minOutRaw });
      cv.done = ok ? `Converted ${fmtUi(d.inUi, cvIn().dec)} ${cvIn().sym} to about ${fmtUi(d.outUi, cvOut().dec)} ${cvOut().sym}.` : 'The swap did not complete. The notice in the corner says why: the price may have moved since your review, or it is still confirming.';
      cv.step = 'done'; cv.ok = ok; if (ok) cv.amt = '';
    } catch (err) {
      // after the wallet step started, never offer a one-click "Confirm and sign" again: a fresh review is needed
      if (err?.signing || err?.maybeSent) { cv.done = `${err.message || 'The wallet step did not finish.'} Check your wallet's activity before converting again.`; cv.ok = false; cv.step = 'done'; }
      else { cv.err = err?.message || 'The swap did not go through.'; cv.step = 'review'; }
    }
    if ($('#convert-dlg').open) renderConvert();
    loadCvBalances(); refreshBalance();
  }
}

// ---------------------------------------------------------------- quick preset dialog
function seg(opts, cur, attr, label) { return `<div class="seg" role="group" aria-label="${esc(label)}">${opts.map(([v, l]) => `<button type="button" data-${attr}="${v}" aria-pressed="${String(v) === String(cur)}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`; }
// the small presets editor (top bar amount, status bar chip); everything else is on #/settings
export function openSettings() {
  const d = $('#settings');
  const draw = () => {
    d.querySelector('.dlg-body').innerHTML = `
      <div class="pre-tabs" role="group" aria-label="Preset">${settings.presets.map((p, i) => `<button type="button" data-ptab="${i}" aria-pressed="${i === settings.preset}" class="${i === settings.preset ? 'on' : ''}">${esc(p.name)}</button>`).join('')}</div>
      <label>Buy amount <span class="hint">SOL spent by quick buys and the default in the trade panel</span><input data-pf="buy" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(String(preset().buy))}" aria-describedby="pf-buy-msg"><span class="hint pf-msg" id="pf-buy-msg" role="status"></span></label>
      <div class="pf-row"><span class="pf-l">Default sell <span class="hint">% of your holding</span></span><div class="seg-fill c5">${seg(SELL_PCTS.map((v) => [v, v + '%']), preset().sellPct, 'sellpct', 'Default sell')}</div></div>
      <div class="pf-row"><span class="pf-l">Slippage <span class="hint">standard route only</span></span><div class="seg-fill c7">${seg(SLIPPAGES.map((v) => [v, v + '%']), preset().slippage, 'slip', 'Slippage')}</div></div>
      <div class="pf-row"><span class="pf-l">Priority fee <span class="hint">at most, paid to Solana validators, never to Nought</span></span><div class="seg-fill c3 two">${seg(Object.entries(PRIO).map(([k, p]) => [k, `${esc(p.label)} <small>≤${esc(String(p.max))} SOL</small>`]), preset().prio, 'prio', 'Priority fee')}</div></div>
      <div class="pf-row"><span class="pf-l">MEV protection <span class="hint">Protected sends trades through Jupiter Ultra, which charges its own fee (about 0.1%) and picks slippage and priority itself. Nought's fee stays 0%.</span></span><div class="seg-fill c2">${seg([['off', 'Off'], ['protected', 'Protected']], preset().mev || 'off', 'mev', 'MEV protection')}</div></div>`;
  };
  draw();
  d.onclick = (e) => {
    const b = e.target.closest('button[type="button"]'); if (!b) return;
    const i = settings.preset, focus = [...b.attributes].find((a) => a.name.startsWith('data-'))?.name;
    const put = (k, v) => { if (PRESET_RULES[k](v)) setPreset(i, { [k]: v }); };
    if (b.dataset.ptab) { const n = Number(b.dataset.ptab); if (n >= 0 && n <= 2) set({ preset: n }); }
    else if (b.dataset.sellpct) put('sellPct', Number(b.dataset.sellpct));
    else if (b.dataset.slip) put('slippage', Number(b.dataset.slip));
    else if (b.dataset.prio) put('prio', b.dataset.prio);
    else if (b.dataset.mev) put('mev', b.dataset.mev === 'protected' ? 'protected' : 'off');
    else return;
    const val = b.getAttribute(focus); draw(); d.querySelector(`[${focus}="${CSS.escape(val)}"]`)?.focus(); // keep keyboard focus
  };
  d.oninput = (e) => {
    const t = e.target;
    if (t.dataset.pf !== 'buy') return;
    const v = parseAmount(t.value), ok = PRESET_RULES.buy(v), msg = d.querySelector('.pf-msg');
    t.setAttribute('aria-invalid', String(!ok));
    if (msg) msg.textContent = ok ? '' : t.value.trim() ? `Enter an amount above 0 and at most ${MAX_BUY} SOL, like 0.25.` : '';
    if (ok) setPreset(settings.preset, { buy: v });
  };
  d.onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('input')) e.preventDefault(); }; // Enter in the field shouldn't close
  if (!d.open) d.showModal();
}

// ---------------------------------------------------------------- status bar
function dot(sel, state) { const el = $(sel); if (el) el.className = 'dot ' + state; }
function statusTick() {
  const now = Date.now(), sock = stream.ok && now - stream.lastMsg < 30000, rate = (stream.rate / 5).toFixed(1);
  dot('#feed-dot', sock ? 'live' : stream.ok ? 'wait' : 'bad');
  $('#st-pp').title = sock ? `pump.fun launch stream: live, ${rate} events/s` : stream.ok ? 'pump.fun launch stream: connected, quiet for 30 s' : 'pump.fun launch stream: reconnecting';
  const jLast = Math.max(feed.lastGems || 0, feed.lastRecent || 0), jOk = now - jLast < 20000, gecko = feed.source === 'geckoterminal';
  dot('#dot-jup', jOk ? (gecko ? 'wait' : 'live') : feed.fails ? 'bad' : 'wait');
  $('#st-jup').title = jOk ? (gecko ? 'Pulse feed: Jupiter is not answering, GeckoTerminal is filling in' : `Pulse feed: Jupiter, updated ${Math.round((now - jLast) / 1000)} s ago`) : feed.fails ? `Pulse feed: ${feed.error || 'Jupiter is not answering'}` : 'Pulse feed: starting';
  const live = sock || jOk;
  $('#feed-text').textContent = live ? `Live · pump.fun · ${tokens.size} coins${sock ? ` · ${rate} events/s` : ''}${gecko ? ' · GeckoTerminal fallback' : ''}` : stream.ok ? 'Connected, waiting for pump.fun…' : 'Reconnecting to pump.fun…';
  stream.rate = 0;
}
let rpcBusy = false;
async function rpcTick(force = false) {
  if ((hidden() && !force) || rpcBusy) return;
  rpcBusy = true;
  const url = rpcUrl(), r = await probeRpc(url);
  rpcBusy = false;
  let host = url; try { host = new URL(url).host; } catch { /* keep */ }
  dot('#dot-rpc', r.ok ? (r.ms > 1500 ? 'wait' : 'live') : 'bad');
  $('#st-rpc').title = r.ok ? `RPC ${host}: ${r.ms} ms${settings.rpc ? '' : ' (default, with fallbacks)'}` : `RPC ${host}: ${r.error}. Nought falls back to the other public RPCs; pick one in Settings > Network.`;
}
function presetChip() {
  const p = preset(), el = $('#st-preset');
  el.innerHTML = `<em>${esc(p.name)}</em> ${esc(String(p.buy))} SOL · ${esc(String(p.slippage))}% · ${esc(PRIO[p.prio]?.label || p.prio)}${p.mev === 'protected' ? ' · MEV' : ''}`;
  el.setAttribute('aria-label', `Active preset ${p.name}: buy ${p.buy} SOL, slippage ${p.slippage}%, ${PRIO[p.prio]?.label || p.prio} priority${p.mev === 'protected' ? ', MEV-protected' : ''}. Edit presets`);
}
// shown once there is something to show: "Saved 0 SOL" next to the 0% chip says nothing
function savedChip() { const fs = savedFees(), el = $('#st-saved'); el.hidden = !(fs.trades > 0); el.textContent = `Saved ${fmtSol(fs.sol)} SOL in fees`; }
// "SOL $120.13 · BTC $84,795 · ETH $2,694": SOL from price.js (util 'sol'), BTC and ETH from Hyperliquid (src/core/hl.js,
// when present: allMids() → {COIN: mid}) every 15 s while visible
const mkts = { sol: 0, btc: 0, eth: 0 };
function paintMarkets() {
  const el = $('#st-mkts'), f = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const parts = [mkts.sol > 0 && `SOL <b>$${mkts.sol.toFixed(2)}</b>`, mkts.btc > 0 && `BTC <b>${f(mkts.btc)}</b>`, mkts.eth > 0 && `ETH <b>${f(mkts.eth)}</b>`].filter(Boolean);
  el.innerHTML = parts.join('<i aria-hidden="true">·</i>'); el.hidden = !parts.length;
  el.title = mkts.btc > 0 || mkts.eth > 0 ? 'SOL from Jupiter; BTC and ETH are Hyperliquid mid prices' : 'SOL price from Jupiter';
}
async function startMarkets() {
  let hl; try { hl = await import('../core/hl.js'); } catch { return; }
  if (typeof hl?.allMids !== 'function') return;
  const poll = async () => {
    if (hidden()) return;
    try {
      let r = await hl.allMids();
      if (r instanceof Map) r = Object.fromEntries(r);
      r = r?.mids || r;
      const btc = Number(r?.BTC), eth = Number(r?.ETH);
      if (btc > 0 || eth > 0) { mkts.btc = btc > 0 ? btc : 0; mkts.eth = eth > 0 ? eth : 0; paintMarkets(); }
    } catch { /* keep the last */ }
  };
  poll(); setInterval(poll, 15000);
}

// ---------------------------------------------------------------- init
let started = false;
// The router marks nav links by the route's tab, so on #/track/vision it lights Trackers. Vision has its own link:
// light that one instead there. aria-current follows the lit link.
function markNav() {
  const vision = /^#\/track\/vision(?:$|[/?])/.test(location.hash);
  if (vision) { $('#nav [data-tab="track"]')?.classList.remove('on'); $('#nav [data-tab="vision"]')?.classList.add('on'); }
  for (const a of $$('#nav a[data-tab]')) { if (a.classList.contains('on')) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
}

export function initShell() {
  if (started) return; started = true;
  // Each part starts on its own: one damaged stored value logs an error, and the rest of the frame and every route
  // (Settings > Data with export and wipe included) still work.
  const part = (name, fn) => { try { fn(); } catch (e) { console.error(`Nought shell: ${name} did not start`, e); } };
  part('settings check', repairSettings);
  part('theme', () => {
    applyTheme();
    // a theme picked in another tab: apply it here too, and tell listeners like any other change
    window.addEventListener('storage', (e) => { if (e.key === 'nought.theme' || e.key === null) { applyTheme(); announceTheme(); } });
  });

  // global clicks: copy, quick buy, quick sell, close a dialog, open a coin card
  part('clicks', () => {
    document.addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]'); if (c) { e.preventDefault(); e.stopPropagation(); copy(c.dataset.copy); return; }
      // [data-qb] buys the amount printed on the button (data-sol, from card.js qbButton), not whatever preset is
      // active by the time of the click; a button without a sane data-sol falls back to the preset
      const q = e.target.closest('[data-qb]');
      if (q) { e.preventDefault(); e.stopPropagation(); if (!isMint(q.dataset.qb)) return; const sol = Number(q.dataset.sol); quickBuy(q.dataset.qb, q, sol > 0 && sol <= MAX_BUY ? sol : preset().buy); return; }
      const s = e.target.closest('[data-qs]'); if (s && isMint(s.dataset.qs)) { e.preventDefault(); e.stopPropagation(); quickSell(s.dataset.qs, s, Number(s.dataset.pct) || preset().sellPct); return; }
      const x = e.target.closest('[data-close]'); if (x) { x.closest('dialog')?.close(); return; }
      if (e.target.closest('a, button, input, select, textarea, label')) return;
      const card = e.target.closest('[data-mint]'); if (card && isMint(card.dataset.mint)) location.hash = '#/t/' + card.dataset.mint;
    });
    document.addEventListener('keydown', onKey);
  });

  // nav: a menu button below 1100 px
  part('nav', () => {
    const top = $('#top'), nb = $('#nav-menu'), nav = $('#nav');
    const navOpen = (o, focus = false) => { top.classList.toggle('nav-open', o); nb.setAttribute('aria-expanded', String(o)); nb.setAttribute('aria-label', o ? 'Close menu' : 'Open menu'); if (o && focus) (nav.querySelector('a.on') || nav.querySelector('a'))?.focus(); };
    nb.addEventListener('click', (e) => navOpen(!top.classList.contains('nav-open'), e.detail === 0));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && top.classList.contains('nav-open') && !document.querySelector('dialog[open]')) { navOpen(false); nb.focus(); } });
    nav.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && top.classList.contains('nav-open')) { const l = $$('a, button', nav), i = l.indexOf(document.activeElement); e.preventDefault(); l[(i + (e.key === 'ArrowDown' ? 1 : -1) + l.length) % l.length]?.focus(); }
    });
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) navOpen(false); });
    document.addEventListener('pointerdown', (e) => { if (top.classList.contains('nav-open') && !nav.contains(e.target) && !nb.contains(e.target)) navOpen(false); }, true);
    document.addEventListener('focusin', (e) => { if (top.classList.contains('nav-open') && !nav.contains(e.target) && e.target !== nb) navOpen(false); });
    on('route', () => { navOpen(false); markNav(); });
    $('#nav-ticker').addEventListener('click', () => { toggleTicker(); navOpen(false); });
    $('#nav-pnl').addEventListener('click', () => { togglePnl(); navOpen(false); });
  });

  // wallet pill: Connect when there is no wallet, else the wallet menu
  part('wallet pill', () => {
    const wb = $('#wallet-btn');
    wb.addEventListener('click', (e) => { if (!wallet.owner) { e.stopImmediatePropagation(); openWalletPicker(); } }); // runs before the menu's own handler
    walletMenu = popover(wb, $('#wallet-menu'), { menu: true, onOpen: renderWalletMenu });
    $('#wallet-menu').addEventListener('click', onWalletMenu);
    on('wallet', () => { walletUi(); refreshBalance(); if (walletMenu.isOpen()) renderWalletMenu(); });
    on('traded', () => { refreshBalance(); setTimeout(refreshBalance, 5000); savedChip(); });
    walletUi(); refreshBalance();
    setInterval(() => { if (!hidden() && wallet.owner) refreshBalance(); }, 60000);
  });

  part('SOL price', () => {
    const sp = () => { const p = Number(solUsd()); mkts.sol = p > 0 && isFinite(p) ? p : 0; paintMarkets(); };
    on('sol', sp); sp();
  });

  // presets P1/P2/P3 (+ the quick-buy amount, which opens the preset editor)
  part('presets', () => {
    const pr = $('#presets');
    const prUi = () => {
      pr.innerHTML = settings.presets.map((p, i) => `<button type="button" data-preset="${i}" aria-pressed="${i === settings.preset}" class="${i === settings.preset ? 'on' : ''}" title="${esc(p.name)}: buy ${esc(String(p.buy))} SOL · ${esc(String(p.slippage))}% slippage · ${esc(PRIO[p.prio]?.label || '')}${p.mev === 'protected' ? ' · MEV-protected' : ''}">${esc(p.name)}</button>`).join('')
        + `<button type="button" class="pr-amt" data-pedit title="Quick-buy amount: click to edit presets">${esc(String(preset().buy))} SOL</button>`;
      presetChip();
    };
    pr.addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) set({ preset: Number(b.dataset.preset) }); else if (e.target.closest('[data-pedit]')) openSettings(); });
    let lastRpc = settings.rpc;
    on('settings', () => { prUi(); if (settings.rpc !== lastRpc) { lastRpc = settings.rpc; rpcTick(true); } }); // re-check the RPC dot only when the RPC changed
    prUi();
    $('#st-preset').addEventListener('click', openSettings);
  });

  // wallet picker (#wallets, filled by core wallet.js): an initial tile per row, and "Install ↗" as a link chip
  part('wallet picker', () => {
    const list = $('#wallet-list');
    const deco = () => {
      for (const b of list.querySelectorAll('button')) {
        if (b.querySelector('.wl-ic')) continue;
        const name = [...b.childNodes].find((n) => n.nodeType === 3)?.textContent.trim() || '?', ic = document.createElement('span');
        ic.className = 'wl-ic' + (b.hasAttribute('data-local') ? ' local' : ''); ic.setAttribute('aria-hidden', 'true'); ic.textContent = name.charAt(0).toUpperCase();
        b.prepend(ic);
        const sm = b.querySelector('small'), t = sm?.textContent.trim();
        if (t === 'Install') { sm.classList.add('wl-install'); sm.textContent = 'Install ↗'; b.title = `Opens the ${name} site in a new tab`; }
        else if (t === 'Detected') sm.classList.add('wl-ok');
      }
    };
    new MutationObserver(deco).observe(list, { childList: true }); deco();
  });
  part('search', () => $('#search-open').addEventListener('click', () => openSearch()));
  part('notifications', initAlerts);
  part('convert', () => {
    const cd = $('#convert-dlg');
    cd.addEventListener('click', onConvertClick);
    cd.addEventListener('input', (e) => { if (e.target.id === 'cv-amt') { cv.amt = e.target.value.slice(0, 40); requote(350); } }); // read with parseAmount in requote
    cd.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'cv-amt') { e.preventDefault(); $('#cv-review')?.click(); } });
    cd.addEventListener('close', () => { clearTimeout(cv.timer); cv.seq++; });
  });

  // watchlist strip: drawn now, prices every 10 s, and at once whenever the watchlist changes (util 'watch' from
  // src/core/watchlist.js, which also reports changes made in other tabs)
  part('watchlist strip', () => {
    syncTicker();
    $('#ticker-toggle').addEventListener('click', () => toggleTicker());
    $('#tk-hide').addEventListener('click', () => { toggleTicker(false); $('#ticker-toggle').focus(); });
    on('watch', () => pollTicker());
    pollTicker();
    setInterval(pollTicker, 10000);
    // backstop for code that writes LS 'watch' without the event: a cheap local comparison, no network
    setInterval(() => { if (!tick.hidden && !hidden() && watchList().join(',') !== tick.key.split('|')[0]) pollTicker(); }, 3000);
    let rs = 0; window.addEventListener('resize', () => { clearTimeout(rs); rs = setTimeout(() => renderTicker(true), 250); });
    document.addEventListener('visibilitychange', () => { if (!hidden()) { pollTicker(); rpcTick(); } });
  });

  // live PnL widget: header button, menu item and key P. It reopens by itself after a reload when it was left open.
  part('PnL widget', () => {
    $('#pnl-toggle').addEventListener('click', () => togglePnl());
    new MutationObserver(() => syncPnl()).observe(document.body, { childList: true }); // its own close button
    if (LS.get('pnlw.on', false) === true) pnlMod().catch(() => {});
    syncPnl();
  });
  part('hotkey titles', () => { keyTitles(); on('hotkeys', keyTitles); });

  part('status bar', () => {
    const repo = safeRepo();
    if (repo) { const a = $('#st-source'); a.href = repo; a.textContent = 'GitHub'; }
    statusTick(); setInterval(statusTick, 5000);
    setTimeout(() => rpcTick(true), 1500); setInterval(rpcTick, 60000);
    setTimeout(startMarkets, 2500);
  });
  part('fees saved', savedChip);

  // age counters everywhere
  let lastStorageNotice = 0;
  on('storage-error', () => { if (Date.now() - lastStorageNotice > 30000) { lastStorageNotice = Date.now(); toast('Browser storage is full or unavailable. Your latest change could not be saved. Export a backup from Settings.', 'err'); } });
  part('age counters', () => setInterval(() => { if (hidden()) return; $$('[data-age]').forEach((el) => {
    const at = Number(el.dataset.age); if (!isFinite(at)) return;
    const s = Math.max(0, Math.floor((Date.now() - at) / 1000)), text = s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd';
    if (el.textContent !== text) el.textContent = text;
  }); }, 1000));
}
function safeRepo() { const v = $('meta[name="nought:repo"]')?.content || ''; try { const u = new URL(v); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } }
