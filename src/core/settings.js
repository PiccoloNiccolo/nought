// User settings, kept in this browser. Change them with set() so every page hears about it ('settings' event).
// Whatever is read back (localStorage, an imported settings file, a patch) goes through clean(): a value of the wrong
// type or out of range falls back to the previous value (the default on load), so junk can't break boot or a trade.
import { LS, emit } from './util.js';

// Three buy/sell presets, like a terminal's P1/P2/P3: amount, slippage, priority and MEV mode each.
// mev 'off' = standard Jupiter route signed and sent by the wallet; 'protected' = Jupiter Ultra (Jupiter's own fee).
const DEFAULTS = {
  preset: 0,
  presets: [
    { name: 'P1', buy: 0.1, sellPct: 50, slippage: 15, prio: 'fast', mev: 'off' },
    { name: 'P2', buy: 0.5, sellPct: 100, slippage: 20, prio: 'turbo', mev: 'off' },
    { name: 'P3', buy: 1, sellPct: 25, slippage: 10, prio: 'normal', mev: 'off' },
  ],
  rpc: '',          // empty: the public RPCs in RPCS
  stretch: 45,      // bonding-curve % where a coin moves into "Final stretch"
  sounds: false,    // a soft tick when a new pair lands
  compact: false,   // denser Pulse rows
  filters: {},      // per Pulse column, see pages/pulse.js
};
export const PRIO = {
  normal: { label: 'Normal', max: 0.0005, level: 'medium' },
  fast: { label: 'Fast', max: 0.002, level: 'veryHigh' },
  turbo: { label: 'Turbo', max: 0.006, level: 'veryHigh' },
};
// the ranges the preset editors offer: buy 0 < x ≤ MAX_BUY SOL, sell 1–100 %, slippage SLIPPAGE.min–max %
export const MAX_BUY = 1000, SLIPPAGE = { min: 1, max: 50 };

const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function validRpc(u) {
  if (typeof u !== 'string' || u.length > 200 || !/^https:\/\/[^\s"'<>`\\]+$/.test(u)) return false;
  try { return !!new URL(u).hostname; } catch { return false; }
}
function cleanPreset(p, base) {
  if (!plain(p)) return { ...base };
  const name = typeof p.name === 'string' ? p.name.trim().slice(0, 12) : '', buy = num(p.buy), sell = num(p.sellPct), slip = num(p.slippage);
  return {
    name: name || base.name,
    buy: buy > 0 && buy <= MAX_BUY ? buy : base.buy,
    sellPct: sell >= 1 && sell <= 100 ? sell : base.sellPct,
    slippage: Number.isFinite(slip) ? Math.min(SLIPPAGE.max, Math.max(SLIPPAGE.min, slip)) : base.slippage,
    prio: typeof p.prio === 'string' && own(PRIO, p.prio) ? p.prio : base.prio,
    mev: p.mev === 'protected' ? 'protected' : p.mev === 'off' || p.mev == null ? 'off' : base.mev,
  };
}
// Pulse filters are checked field by field in ui/pulse-filters.js; here only the shape (column → object) and size
function cleanFilters(f, base) {
  if (!plain(f)) return { ...base };
  const out = {};
  for (const [k, v] of Object.entries(f).slice(0, 10)) if (/^[a-z][\w-]{0,19}$/i.test(k) && k !== '__proto__' && plain(v)) out[k] = v;
  try { return JSON.stringify(out).length <= 50000 ? out : { ...base }; } catch { return { ...base }; }
}
// a full, well-typed settings object from anything; base supplies the fallback for each bad field
function clean(s, base = DEFAULTS) {
  const o = plain(s) ? s : {}, list = Array.isArray(o.presets) ? o.presets : [], pi = num(o.preset), st = num(o.stretch);
  return {
    preset: Number.isInteger(pi) && pi >= 0 && pi < 3 ? pi : base.preset,
    presets: DEFAULTS.presets.map((d, i) => cleanPreset(list[i], base.presets?.[i] || d)),
    rpc: o.rpc === '' || o.rpc == null ? '' : validRpc(o.rpc) ? o.rpc : base.rpc,
    stretch: st >= 1 && st <= 99 ? st : base.stretch,
    sounds: typeof o.sounds === 'boolean' ? o.sounds : base.sounds,
    compact: typeof o.compact === 'boolean' ? o.compact : base.compact,
    filters: cleanFilters(o.filters, base.filters),
  };
}
export const settings = clean(LS.get('settings', {}));

export const preset = () => settings.presets[settings.preset] || settings.presets[0];
// api.mainnet-beta.solana.com refuses browser requests; publicnode, then solanatracker and vibestation as fallbacks
export const RPCS = ['https://solana-rpc.publicnode.com', 'https://rpc.solanatracker.io/public', 'https://public.rpc.solanavibestation.com'];
export const rpcUrl = () => settings.rpc || RPCS[0];
// update in place (pages hold the settings object and its presets array); a preset object is replaced only if it changed
function apply(next) {
  for (const k of Object.keys(next)) if (k !== 'presets') settings[k] = next[k];
  next.presets.forEach((p, i) => { if (JSON.stringify(p) !== JSON.stringify(settings.presets[i])) settings.presets[i] = p; });
  LS.set('settings', settings); emit('settings', settings);
}
export function set(patch) { apply(clean({ ...settings, ...(plain(patch) ? patch : {}) }, settings)); }
export function setPreset(i, patch) {
  if (!(Number.isInteger(i) && i >= 0 && i < 3) || !plain(patch)) return;
  apply(clean({ ...settings, presets: settings.presets.map((p, j) => (j === i ? { ...p, ...patch } : p)) }, settings));
}
