// The app frame. Pages render into #view; everything around it lives here:
//   top bar      nav (a menu button below 1240 px; Vision has its own link into #/track/vision), search pill, the 0%
//                fee badge, presets P1–P3, strip star, live PnL widget, notifications bell, settings, then Connect, or
//                Deposit + the wallet pill with a menu (manage, deposit, withdraw, convert SOL⇄USDC, fees saved, disconnect)
//   strip        the coin strip under the top bar (src/ui/ticker.js): watchlist, recently viewed or trending coins
//   status bar   preset chip (pick P1–P3), wallet chip (opens the wallet menu), settings, shortcuts (wallet manager,
//                Discover, Pulse, Trackers, Watchlist, PnL widget), fees saved, BTC/ETH/SOL, one connection pill whose
//                panel lists the pump.fun stream, the Jupiter feed and the RPC, links
//   keys         rebindable hotkeys (Settings > Hotkeys), theme (Settings > Display), the quick preset dialog
//   clicks       [data-copy] copies, [data-qb] quick-buys, [data-qs][data-pct] quick-sells, [data-mint] opens a coin,
//                [data-close] closes its dialog
// Events this module emits (util on/emit):
//   'theme'    {name, accent, colors} after every theme or accent change (setTheme, or another tab changing it);
//              colors are the resolved tokens {bg, panel, panel2, line, line2, fg, muted, dim, accent, up, down, warn}
//              for canvas code (charts) that can't read CSS variables. Subscribe with on('theme', fn) and call the
//              returned unsubscribe in your page cleanup.
//   'ticker'   bool: the strip was switched on (true) or off (false) (sent by src/ui/ticker.js)
//   'pnlwidget' bool: the live PnL widget opened (true) or closed (false), from any of its switches
//   'hotkeys'  the full binding map after a change
// The order engine is started by app.js once the saved wallet is back.
import { $, $$, esc, on, emit, toast, copy, isMint, LS, short, usd, ICON, parseAmount } from '../core/util.js';
import { savedVs } from '../core/fee-compare.js';
import { settings, set, setPreset, PRIO, preset, rpcUrl } from '../core/settings.js';
import { wallet, openWalletPicker, disconnectWallet, toRaw, selectWallet, tradeOwners, MAX_SELECTED } from '../core/wallet.js';
import * as V from '../core/vault.js';
import { solUsd } from '../core/price.js';
import { quickBuy, quickSell, quoteFor, quoteDetails, impactWarning, trade, feesSaved, SOL_MINT, multiMode, setMultiMode } from '../core/trade.js';
import * as tradeX from '../core/trade.js'; // optional exports (minOutOf): a namespace lookup can't break module linking
import { solBalance } from '../core/rpc.js';
import { ju } from '../core/jup.js';
import { state as stream } from '../core/stream.js';
import { feed } from '../core/seed.js';
import { tokens } from '../core/store.js';
import { openSearch } from './search.js';
import { initAlerts, popover, openBell, USDC_MINT } from './alerts.js';
import { initTicker, toggleTicker, tickerHidden } from './ticker.js';
import { initRecent } from './recent.js';

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
  { id: 'goPulse', label: 'Go to Scope', def: 'g p' },
  { id: 'goTrack', label: 'Go to Trackers', def: 'g t' },
  { id: 'goPortfolio', label: 'Go to Portfolio', def: 'g f' },
  { id: 'goWatch', label: 'Go to Watchlist', def: 'g w' },
  { id: 'goHome', label: 'Go to the home page', def: 'g h' },
  { id: 'goSettings', label: 'Open settings', def: 'g s' },
  { id: 'wallet', label: 'Open the wallet menu', def: 'w' },
  { id: 'convert', label: 'Convert SOL ⇄ USDC', def: 'c' },
  { id: 'alerts', label: 'Open notifications', def: 'n' },
  { id: 'ticker', label: 'Show or hide the coin strip', def: 't' },
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
const GO = { goPulse: '#/scope', goDiscover: '#/discover', goTrack: '#/track', goVision: '#/track/explore', goPortfolio: '#/portfolio', goWatch: '#/watch', goPerps: '#/perps', goHome: '#/', goSettings: '#/settings' };
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
  { id: 'dark', name: 'Nought Dark', sw: ['#06070b', '#101114', '#526fff'] },
  { id: 'grey', name: 'Grey', sw: ['#131418', '#1a1b20', '#526fff'] },
  { id: 'oled', name: 'OLED black', sw: ['#000000', '#060608', '#526fff'] },
  { id: 'light', name: 'Light', sw: ['#f4f5f8', '#ffffff', '#3d5af1'] },
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

// ---------------------------------------------------------------- coin strip (src/ui/ticker.js)
export { toggleTicker, tickerHidden };

// ---------------------------------------------------------------- live PnL widget (src/ui/pnlwidget.js, loaded on use)
const pnlMod = () => import('./pnlwidget.js');
export const pnlShown = () => !!document.querySelector('body > .pnlw');
let pnlWas = null;
function syncPnl(open = pnlShown()) {
  $('#pnl-toggle')?.setAttribute('aria-pressed', String(open));
  $('#st-pnl')?.setAttribute('aria-pressed', String(open));
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
  $('#ticker-toggle').title = with$('Show or hide the coin strip', 'ticker');
  $('#pnl-toggle').title = with$('Show or hide the live PnL widget', 'pnl');
  if (presetMenu?.isOpen()) renderPresetMenu();
}

// ---------------------------------------------------------------- icons used by the frame
const svg = (d, w = 15, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} viewBox="0 0 24 24" width="${w}" height="${w}" aria-hidden="true">${d}</svg>`;
const IC = {
  wallet: '<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="13.5" r="1.3" fill="currentColor"/>',
  caret: '<path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  manage: '<rect x="4" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="13" y="4" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="13" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16.5 13.5v6M13.5 16.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  key: '<circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  deposit: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  withdraw: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  swap: '<path d="M7 4v15m0 0-3.5-3.5M7 19l3.5-3.5M17 20V5m0 0-3.5 3.5M17 5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  out: '<path d="M14 5h4a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 18 19h-4M10 16.5 5.5 12 10 7.5M5.5 12H15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="15" cy="7" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="17" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
};
// the Solana mark next to SOL amounts (its gradient is defined once in index.html)
export const solIcon = (w = 12) => `<svg class="sol-ic" viewBox="0 0 24 24" width="${w}" height="${w}" aria-hidden="true"><path d="M6.8 4.5h14l-3.6 3.8h-14z"/><path d="M3.2 10.1h14l3.6 3.8h-14z"/><path d="M6.8 15.7h14l-3.6 3.8h-14z"/></svg>`;

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
// the top pill, Deposit next to it, and the status bar's wallet chip
function walletUi() {
  const wb = $('#wallet-btn'), dep = $('#deposit-btn'), sw = $('#st-wallet');
  if (!wallet.owner) {
    walletMenu?.close(false);
    wb.className = 'wpill connect'; wb.textContent = 'Connect'; wb.title = 'Connect a wallet';
    wb.setAttribute('aria-haspopup', 'dialog'); wb.setAttribute('aria-label', 'Connect a wallet');
    if (dep) dep.hidden = true;
    if (sw) sw.hidden = true;
    return;
  }
  const b = bal.owner === wallet.owner ? fmtSol(bal.sol) : '—', local = wallet.kind === 'local', many = tradeOwners().length;
  wb.className = 'wpill'; wb.setAttribute('aria-haspopup', 'menu');
  wb.innerHTML = `${svg(IC.wallet, 15, 'wp-ic')}${many > 1 ? `<span class="wp-n">${many}</span>` : ''}${local ? '<i class="wp-kind" aria-hidden="true"></i>' : ''}${solIcon(13)}<span class="wp-bal">${b}</span>${svg(IC.caret, 12, 'wp-car')}`;
  wb.title = `${wallet.name || 'Wallet'} (${local ? 'local wallet in this browser' : 'browser extension'}) ${wallet.owner}${many > 1 ? ` · ${many} wallets trade together` : ''}`;
  wb.setAttribute('aria-label', `${wallet.name || 'Wallet'}, ${b} SOL${many > 1 ? `, ${many} wallets trade together` : ''}: open the wallet menu`);
  if (dep) dep.hidden = false;
  if (sw) {
    sw.hidden = false;
    sw.innerHTML = `${svg(IC.wallet, 13)}<span>${many}</span>${solIcon(11)}<span class="bal-u">${b}</span>${svg(IC.caret, 10, 'car')}`;
    sw.title = `${many > 1 ? `${many} wallets trade together · ` : ''}${wallet.name || 'Wallet'}: ${b} SOL`;
    sw.setAttribute('aria-label', `${many} wallet${many === 1 ? '' : 's'} trading, active wallet ${b} SOL: open the wallet menu`);
  }
}
function renderWalletMenu() {
  const m = $('#wallet-menu'), local = wallet.kind === 'local', fs = savedFees(), owner = wallet.owner;
  if (!owner) { m.innerHTML = ''; return; }
  const item = (a, icon, label, hint = '', extra = '') => `<button type="button" role="menuitem" data-wa="${a}"${extra}>${svg(icon, 15)}<span>${label}</span>${hint ? `<small>${hint}</small>` : ''}</button>`;
  m.innerHTML = `<div class="wm-headbox">
      <div class="l"><span class="wm-av" aria-hidden="true">${svg(IC.wallet, 15)}</span><div class="wm-who"><b>${esc(wallet.name || 'Wallet')}</b><div class="addr"><span>${esc(short(owner, 5))}</span><button type="button" data-copy="${esc(owner)}" aria-label="Copy address" title="Copy address">${ICON.copy}</button></div></div><span class="wm-kindtag ${local ? 'local' : ''}">${local ? 'Local' : 'Extension'}</span></div>
      <div class="wm-bals"><span>SOL<b>${solIcon(13)}<span id="wmb-sol">${bal.owner === owner && bal.sol != null ? fmtSol(bal.sol) : '…'}</span></b></span><span>USDC<b><i class="usdc-ic" aria-hidden="true"></i><span id="wmb-usdc">…</span></b></span></div>
    </div>
    <div class="wm-multibox" id="wm-multi" aria-live="polite"></div>
    ${item('deposit', IC.deposit, 'Deposit', 'address · QR')}
    ${item('withdraw', IC.withdraw, 'Withdraw', 'SOL or tokens')}
    ${item('convert', IC.swap, 'Convert SOL ⇄ USDC', 'via Jupiter')}
    ${item('manage', IC.manage, 'Manage wallets', 'switch · add · lock')}
    ${item('import', IC.key, 'Import wallet', 'private key')}
    ${fs.trades > 0 ? `<div class="wm-saved" role="note"><b>Fees saved: ${fmtSol(fs.sol)} SOL${fs.usd > 0 ? ' · ' + usd(fs.usd, 2) : ''}</b><span>Compared with a typical ${(fs.rate * 100).toFixed(0)}% terminal fee, on ${fs.trades} trade${fs.trades === 1 ? '' : 's'} made in this browser. Nought charges 0%.</span></div>` : ''}
    <div class="wm-sep" role="separator"></div>
    ${item('disconnect', IC.out, local ? 'Stop using this wallet' : 'Disconnect', '', ` class="danger"${local ? ' title="The keys stay in this browser; pick it again any time from Manage wallets."' : ''}`)}`;
  renderMultiList();
  ju.balances(owner).then((b) => {
    if (wallet.owner !== owner) return;
    const s = $('#wmb-sol'), u = $('#wmb-usdc');
    if (s) s.textContent = fmtSol(Number(b.sol));
    if (u) { const n = Number(b.tokens?.[USDC_MINT]?.ui) || 0; u.textContent = n === 0 ? '0' : n.toFixed(2); }
  }).catch(() => { const u = $('#wmb-usdc'); if (u) u.textContent = '—'; });
}
// the status bar's wallet chip opens the same menu, rising from the chip
let footWas = false;
function openWalletFromFoot(e) {
  const sw = $('#st-wallet'), m = $('#wallet-menu');
  if (!wallet.owner || !walletMenu) return;
  if (footWas) { footWas = false; return; } // this click closed it (the outside-press handler already did)
  if (walletMenu.isOpen() && m.classList.contains('at-foot')) { walletMenu.close(); return; }
  const r = sw.getBoundingClientRect();
  m.classList.add('at-foot'); m.style.left = Math.max(8, Math.min(innerWidth - 308, r.left)) + 'px';
  // the chip is the opener: it gets aria-expanded, and focus comes back to it on Escape or after an action
  walletMenu.open(e.detail === 0, sw);
}
// Multi-wallet: tick local wallets here and every buy and sell (Pulse, token page, hotkeys) runs on all of them at once.
const multiBal = new Map(); // address → {sol, at}
async function renderMultiList() {
  const box = $('#wm-multi'); if (!box) return;
  const list = await V.list().catch(() => []);
  // no wallets kept in Nought yet: say how multi-wallet works and offer to make some (an extension signs for one
  // account at a time, so trades from several wallets use wallets kept in this browser)
  if (!list.length) { box.innerHTML = `<div class="wm-mh"><b>Multi-wallet</b><span class="dim">trade from several wallets at once</span></div><p class="hint">${wallet.kind === 'external' ? 'Your extension signs for one account at a time, so multi-wallet trades use wallets kept in Nought: made or imported here, encrypted and sealed in this browser.' : 'Make or import wallets here; every trade then runs on the ones you tick.'}</p><div class="wm-madd"><button type="button" data-wa="new">Create wallets</button><button type="button" data-wa="import">Import</button></div>`; return; }
  const sel = new Set(wallet.selected), n = tradeOwners().length, split = multiMode() === 'split';
  const balOf = (a) => { const b = multiBal.get(a); return b && b.sol != null ? fmtSol(b.sol) : '…'; };
  box.innerHTML = `<div class="wm-mh"><b>Trade with</b><span class="dim">${sel.size ? `${sel.size} of ${list.length} picked` : 'the active wallet only'}</span><span class="wm-grow"></span><button type="button" data-pickall>All</button><button type="button" data-picknone>None</button></div>
    <div class="wm-mlist" role="group" aria-label="Wallets that trade together">${list.map((w) => `<label class="wm-mrow${sel.has(w.address) ? ' on' : ''}"><input type="checkbox" data-pick="${esc(w.address)}" ${sel.has(w.address) ? 'checked' : ''}><span class="nm">${esc(w.name || short(w.address))}</span><span class="mono dim">${esc(short(w.address))}</span><span class="mono">${balOf(w.address)} <span class="dim">SOL</span></span></label>`).join('')}</div>
    <div class="wm-madd"><button type="button" data-wa="new">+ Add wallets</button><button type="button" data-wa="import">Import</button></div>
    ${n > 1 ? `<div class="wm-mmode" role="group" aria-label="Buy amount with several wallets"><button type="button" data-mm="each" class="${split ? '' : 'on'}">Each wallet buys the amount</button><button type="button" data-mm="split" class="${split ? 'on' : ''}">Split the amount</button></div><p class="hint">Buys and sells go out from all ${n} wallets at the same moment.${split ? '' : ` A ${fmtSol(preset().buy)} SOL click spends ${fmtSol(preset().buy * n)} SOL in total.`}</p>` : ''}`;
  for (const w of list) {
    const b = multiBal.get(w.address); if (b && Date.now() - b.at < 30000) continue;
    multiBal.set(w.address, { sol: b?.sol, at: Date.now() });
    ju.balances(w.address).then((r) => { multiBal.set(w.address, { sol: Number(r.sol), at: Date.now() }); if (walletMenu?.isOpen()) renderMultiList(); }).catch(() => {});
  }
}
async function onMultiClick(e) {
  const t = e.target, pick = t.closest('[data-pick]'), mm = t.closest('[data-mm]');
  try {
    if (pick) selectWallet(pick.dataset.pick, pick.checked);
    else if (mm) setMultiMode(mm.dataset.mm);
    else if (t.closest('[data-picknone]')) for (const a of [...wallet.selected]) selectWallet(a, false);
    else if (t.closest('[data-pickall]')) { for (const w of (await V.list()).slice(0, MAX_SELECTED)) if (!wallet.selected.includes(w.address)) selectWallet(w.address, true); }
    else return false;
  } catch (err) { toast(esc(err?.message || 'Could not change the wallet selection.'), 'err'); }
  renderMultiList();
  return true;
}
function onWalletMenu(e) {
  if (e.target.closest('#wm-multi') && !e.target.closest('[data-wa]')) { if (e.target.closest('[data-pick], [data-mm], [data-pickall], [data-picknone]')) onMultiClick(e); return; }
  const b = e.target.closest('[data-wa]'); if (!b) return;
  const a = b.dataset.wa, owner = wallet.owner;
  walletMenu.close(true); // focus goes back to the pill, so a dialog opened next returns focus there
  const fail = (err) => toast(esc(err?.message || 'Could not open the wallet manager.'), 'err');
  if (a === 'manage') wui().then((w) => w.openWalletManager()).catch(fail);
  else if (a === 'import') wui().then((w) => w.openWalletManager('import')).catch(fail);
  else if (a === 'new') wui().then((w) => w.openWalletManager('new')).catch(fail);
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
// Connections: the pump.fun stream, the Jupiter Pulse feed and the RPC each get a state ('live' | 'wait' | 'bad', ''
// before the first check) and a line of text, shown in the connection panel; the pill sums them up.
// A connection that has not been healthy yet counts as "Connecting" for its first 15 s (the stream reports "down" and
// Jupiter "slow" while they start); after that, or once it was healthy and then dropped, it counts as it is.
const conn = { pp: { s: '', t: '' }, jup: { s: '', t: '' }, rpc: { s: '', t: '' } }, BOOT_GRACE = 15000;
const CONN = [['pp', 'Stream', '#feed-dot'], ['jup', 'Jupiter', '#dot-jup'], ['rpc', 'RPC', '#dot-rpc']];
let connAt = 0;
const connOk = (k) => conn[k].s === 'live' || (k === 'pp' && conn[k].s === 'wait');
function setConn(k, state, text) {
  connAt ||= Date.now();
  conn[k] = { s: state, t: text, ever: conn[k].ever || state === 'live' || (k === 'pp' && state === 'wait') };
  const [, , d] = CONN.find(([id]) => id === k), dl = $(d), tl = $(`#st-${k}-t`);
  if (dl) dl.className = 'dot ' + state;
  if (tl) tl.textContent = text;
  connPill();
}
function connPill() {
  const el = $('#st-conn'); if (!el) return;
  // a connected but quiet launch stream still counts as healthy (the old bar called that "Live" too)
  const boot = Date.now() - connAt < BOOT_GRACE, starting = (k) => !conn[k].s || (boot && !conn[k].ever && !connOk(k));
  const ok = CONN.filter(([k]) => connOk(k)).length, rest = CONN.filter(([k]) => !connOk(k) && !starting(k)).map(([k]) => conn[k].s), bad = rest.filter((x) => x === 'bad').length;
  const [state, label] = ok === CONN.length ? ['live', 'Live'] : bad === CONN.length ? ['bad', 'Offline'] : rest.length ? ['wait', 'Degraded'] : ['', 'Connecting'];
  el.className = 'st-conn ' + state;
  $('#st-conn-dot').className = 'dot ' + state;
  $('#st-conn-l').textContent = label;
  const sum = CONN.map(([k, name]) => `${name}: ${conn[k].s === 'live' ? 'live' : conn[k].s === 'bad' ? 'down' : conn[k].s === 'wait' ? 'slow or partial' : 'checking'}`).join(' · ');
  el.title = sum; el.setAttribute('aria-label', `Connections ${label}. ${sum}. Open the details`);
}
function statusTick() {
  const now = Date.now(), sock = stream.ok && now - stream.lastMsg < 30000, rate = (stream.rate / 5).toFixed(1);
  setConn('pp', sock ? 'live' : stream.ok ? 'wait' : 'bad', sock ? `pump.fun launch stream: live, ${rate} events/s` : stream.ok ? 'pump.fun launch stream: connected, quiet for 30 s' : 'pump.fun launch stream: reconnecting');
  const jLast = Math.max(feed.lastGems || 0, feed.lastRecent || 0), jOk = now - jLast < 20000, gecko = feed.source === 'geckoterminal';
  setConn('jup', jOk ? (gecko ? 'wait' : 'live') : feed.fails ? 'bad' : 'wait', jOk ? (gecko ? 'Scope feed: Jupiter is not answering, GeckoTerminal is filling in' : `Scope feed: Jupiter, updated ${Math.round((now - jLast) / 1000)} s ago`) : feed.fails ? `Scope feed: ${feed.error || 'Jupiter is not answering'}` : 'Scope feed: starting');
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
  setConn('rpc', r.ok ? (r.ms > 1500 ? 'wait' : 'live') : 'bad', r.ok ? `${host}: ${r.ms} ms${settings.rpc ? '' : ' (default, with fallbacks)'}` : `${host}: ${r.error}. Nought falls back to the other public RPCs; pick one in Settings > Network.`);
}
// the preset chip ("Preset 1", or the preset's own name once renamed) and its menu: pick P1–P3 or edit them
let presetMenu = null;
const presetLabel = (p, i) => (/^P[123]$/i.test(p.name) ? `Preset ${i + 1}` : p.name);
function presetChip() {
  const p = preset(), el = $('#st-preset');
  el.innerHTML = `${svg(IC.sliders, 13)}<span>${esc(presetLabel(p, settings.preset))}</span>`;
  el.title = `${p.name}: buy ${p.buy} SOL · ${p.slippage}% slippage · ${PRIO[p.prio]?.label || p.prio}${p.mev === 'protected' ? ' · MEV-protected' : ''}`;
  el.setAttribute('aria-label', `Active preset ${p.name}: buy ${p.buy} SOL, slippage ${p.slippage}%, ${PRIO[p.prio]?.label || p.prio} priority${p.mev === 'protected' ? ', MEV-protected' : ''}. Pick a preset`);
  if (presetMenu?.isOpen()) renderPresetMenu();
}
function renderPresetMenu() {
  const k = hotkeys();
  $('#st-pre-menu').innerHTML = '<div class="st-ph">Trade preset</div>' + settings.presets.map((p, i) => {
    const on = i === settings.preset, key = k['preset' + (i + 1)];
    const named = !/^P[123]$/i.test(p.name);
    return `<button type="button" role="menuitemradio" aria-checked="${on}" data-pick-preset="${i}"><span class="pn">P${i + 1}</span><span class="pd"><b>${named ? `<span class="pnm">${esc(p.name)}</span>` : ''}${esc(fmtSol(p.buy))} SOL</b><span>${esc(String(p.slippage))}% slippage · ${esc(PRIO[p.prio]?.label || p.prio)}${p.mev === 'protected' ? ' · MEV' : ''}</span></span>${on ? svg(IC.check, 14, 'ck') : key ? `<kbd>${esc(comboLabel(key))}</kbd>` : '<span></span>'}</button>`;
  }).join('') + `<hr><button type="button" role="menuitem" class="pe" data-pedit-foot>${svg(IC.edit, 14)}<span>Edit presets</span></button>`;
}
// shown once there is something to show: "Saved 0 SOL" next to the 0% chip says nothing
// fees saved: the trades made in this browser, priced at each terminal's published fee (src/core/fee-compare.js)
function savedChip() {
  const fs = savedFees(), el = $('#st-saved'); el.hidden = !(fs.trades > 0); if (el.hidden) return;
  const vol = fs.rate > 0 ? fs.sol / fs.rate : 0, list = savedVs(vol), ax = list[0];
  // in dollars at today's SOL price (SOL until the price is known)
  const px = solUsd() > 0 ? solUsd() : 0;
  // the lowest published fee among them (Axiom's), so the figure never overstates
  el.textContent = `Saved ${px ? usd(ax.sol * px, 2) : fmtSol(ax.sol) + ' SOL'} vs other terminals`;
  el.title = `Fees these ${fs.trades} trade${fs.trades === 1 ? '' : 's'} (${fmtSol(vol)} SOL traded) would have cost elsewhere:\n` + list.map((t) => `${t.name} (${(t.rate * 100).toFixed(2).replace(/0$/, '')}%): ${px ? usd(t.sol * px, 2) + ' (' + fmtSol(t.sol) + ' SOL)' : fmtSol(t.sol) + ' SOL'}`).join('\n') + '\nNought: 0';
}
// BTC, ETH and SOL with a coin mark each: SOL from price.js (util 'sol'), BTC and ETH from Hyperliquid
// (src/core/hl.js, when present: allMids() → {COIN: mid}) every 15 s while visible
const mkts = { sol: 0, btc: 0, eth: 0 };
function paintMarkets() {
  const el = $('#st-mkts');
  const parts = [mkts.btc > 0 && `<span class="m-btc" title="Bitcoin, Hyperliquid mid price"><i class="cn btc" aria-hidden="true">₿</i><span class="sr-only">BTC </span>${usd(mkts.btc)}</span>`,
    mkts.eth > 0 && `<span class="m-eth" title="Ether, Hyperliquid mid price"><i class="cn eth" aria-hidden="true">Ξ</i><span class="sr-only">ETH </span>$${Math.round(mkts.eth).toLocaleString('en-US')}</span>`,
    mkts.sol > 0 && `<span class="m-sol" title="SOL, Jupiter price">${solIcon(13)}<span class="sr-only">SOL </span>$${mkts.sol.toFixed(2)}</span>`].filter(Boolean);
  el.innerHTML = parts.join(''); el.hidden = !parts.length;
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
  if (vision && $('#nav [data-tab="vision"]')) { $('#nav [data-tab="track"]')?.classList.remove('on'); $('#nav [data-tab="vision"]')?.classList.add('on'); }
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
    const wm = $('#wallet-menu'), sw = $('#st-wallet');
    walletMenu = popover(wb, wm, { menu: true, onOpen: renderWalletMenu, onClose: () => { wm.classList.remove('at-foot'); wm.style.removeProperty('left'); } });
    // the pill opens it under itself; the status bar chip opens it above the chip
    window.addEventListener('pointerdown', (e) => { footWas = walletMenu.isOpen() && wm.classList.contains('at-foot') && sw.contains(e.target); }, true);
    sw.addEventListener('click', openWalletFromFoot);
    sw.addEventListener('keydown', (e) => { if (e.key === 'Escape' && walletMenu.isOpen()) { e.preventDefault(); walletMenu.close(); } });
    wm.addEventListener('click', onWalletMenu);
    $('#deposit-btn').addEventListener('click', () => wui().then((w) => w.openDeposit(wallet.owner)).catch((err) => toast(esc(err?.message || 'Could not open the wallet manager.'), 'err')));
    on('wallet', () => { walletUi(); refreshBalance(); if (walletMenu.isOpen()) renderWalletMenu(); });
    on('traded', () => { refreshBalance(); setTimeout(refreshBalance, 5000); savedChip(); });
    walletUi(); refreshBalance();
    setInterval(() => { if (!hidden() && wallet.owner) refreshBalance(); }, 15000);
  });

  part('SOL price', () => {
    const sp = () => { const p = Number(solUsd()); mkts.sol = p > 0 && isFinite(p) ? p : 0; paintMarkets(); try { savedChip(); } catch { /* the chip is optional */ } };
    on('sol', sp); sp();
  });

  // presets P1/P2/P3 (+ the quick-buy amount, which opens the preset editor)
  part('presets', () => {
    const pr = $('#presets');
    const prUi = () => {
      pr.innerHTML = settings.presets.map((p, i) => `<button type="button" data-preset="${i}" aria-pressed="${i === settings.preset}" class="${i === settings.preset ? 'on' : ''}" title="${esc(p.name)}: buy ${esc(String(p.buy))} SOL · ${esc(String(p.slippage))}% slippage · ${esc(PRIO[p.prio]?.label || '')}${p.mev === 'protected' ? ' · MEV-protected' : ''}">${esc(p.name)}</button>`).join('')
        + `<button type="button" class="pr-amt" data-pedit title="Quick-buy amount: click to edit presets" aria-label="Quick-buy amount ${esc(String(preset().buy))} SOL: edit presets">${ICON.bolt}${esc(String(preset().buy))}<small>SOL</small></button>`;
      presetChip();
    };
    pr.addEventListener('click', (e) => { const b = e.target.closest('[data-preset]'); if (b) set({ preset: Number(b.dataset.preset) }); else if (e.target.closest('[data-pedit]')) openSettings(); });
    let lastRpc = settings.rpc;
    on('settings', () => { prUi(); if (settings.rpc !== lastRpc) { lastRpc = settings.rpc; rpcTick(true); } }); // re-check the RPC dot only when the RPC changed
    prUi();
    // the status bar's preset chip: a menu to pick P1–P3, or open the editor
    const pm = $('#st-pre-menu');
    presetMenu = popover($('#st-preset'), pm, { menu: true, onOpen: renderPresetMenu });
    pm.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick-preset]');
      if (b) { const n = Number(b.dataset.pickPreset); presetMenu.close(); if (n >= 0 && n <= 2) set({ preset: n }); return; }
      if (e.target.closest('[data-pedit-foot]')) { presetMenu.close(); openSettings(); }
    });
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
  part('search', () => {
    const sb = $('#search-open'), tr = sb.parentElement;
    sb.addEventListener('click', () => openSearch());
    // Once the room the other top-bar items leave can't hold "Search" and the key (about 117 px), the pill becomes a
    // round icon button (.icon-only) instead of an empty stretched pill. The room doesn't depend on the pill itself.
    const fit = () => {
      const kids = [...tr.children].filter((e) => e !== sb && e.offsetWidth > 0), gap = parseFloat(getComputedStyle(tr).columnGap) || 0;
      sb.classList.toggle('icon-only', tr.clientWidth - kids.reduce((a, e) => a + e.offsetWidth, 0) - gap * kids.length < 117);
    };
    if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(fit); ro.observe(tr); for (const e of tr.children) if (e !== sb) ro.observe(e); }
    fit();
  });
  part('notifications', initAlerts);
  part('convert', () => {
    const cd = $('#convert-dlg');
    cd.addEventListener('click', onConvertClick);
    cd.addEventListener('input', (e) => { if (e.target.id === 'cv-amt') { cv.amt = e.target.value.slice(0, 40); requote(350); } }); // read with parseAmount in requote
    cd.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'cv-amt') { e.preventDefault(); $('#cv-review')?.click(); } });
    cd.addEventListener('close', () => { clearTimeout(cv.timer); cv.seq++; });
  });

  // the coin strip, and the recently viewed list it (and search) shows
  part('recent coins', initRecent);
  part('coin strip', () => {
    initTicker();
    document.addEventListener('visibilitychange', () => { if (!hidden()) rpcTick(); });
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
    const connPop = popover($('#st-conn'), $('#st-conn-pop'));
    $('#st-conn-pop').addEventListener('click', (e) => { if (e.target.closest('a[href^="#"]')) connPop.close(false); });
    $('.st-links').addEventListener('click', (e) => {
      const b = e.target.closest('[data-st]'); if (!b) return;
      if (b.dataset.st === 'pnl') togglePnl();
      else if (b.dataset.st === 'trackers') import('./trackpanel.js').then((m) => m.toggleTrackPanel()).catch(() => { location.hash = '#/track'; });
      else if (b.dataset.st === 'wallets') wui().then((w) => w.openWalletManager()).catch((err) => toast(esc(err?.message || 'Could not open the wallet manager.'), 'err'));
    });
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
