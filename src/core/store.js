// The token store: every coin the app knows about, keyed by mint, updated by the Pulse feed (seed.js), the live
// stream and lookups. Pages read tokens.get(mint) / all() and listen for the 'tokens' event (throttled) to re-render.
// Always write through upsert(): it stamps freshness, applies the migration rule and fires 'tokens'.
//
// Token fields (all optional except mint):
//   identity   mint, name, symbol, uri, image, description, decimals, tokenProgram, verified, tags[]
//   socials    twitter, telegram, website (safe URLs), xHandle, xFollowers
//   launch     created (ms), dev (creator wallet), launchpad (Jupiter id: 'pump.fun' | 'letsbonk.fun' |
//              'raydium-launchlab' | 'met-dbc' | 'bags.fun' | 'moonshot' | 'jup-studio' | 'stonkfun' | ...), metaLaunchpad
//   curve      progress (0..1 bonding curve), migrated (bool), migratedAt (ms), gradPool (migrated pool address)
//   price      mcSol (SOL, from the stream at launch) + mcSolAt, mcUsd (USD, from Jupiter/Dexscreener) + mcUsdAt:
//              read market cap with mcUsd(t), which takes whichever is fresher. price (USD) + priceAt, fdvUsd,
//              liquidity (USD), circSupply, totalSupply
//   activity   volume24h (USD), volSol (24h volume in SOL, derived from volume24h), buys, sells (24h counts),
//              lastTrade (ms), stats5m / stats1h / stats6h / stats24h ({priceChange %, vol, buyVol, sellVol,
//              organicVol, buys, sells, traders, netBuyers, organicBuyers, holderChange, liquidityChange, volumeChange})
//   holders    holders (count), top10Pct, devPct, devMints, devMigrations, sniperPct, insiderPct, botPct, sus
//   safety     mintAuthDisabled, freezeAuthDisabled, organicScore (0..100), organicLabel, dexPaid, fees (SOL), live, mayhem
//   pulse      pulseCol ('new' | 'stretch' | 'migrated': the Pulse list Jupiter last put it in), pulseAt (ms of that)
//   pool       pool (pool address from the Pulse feed), poolType, poolCreated (ms), pair (best Dexscreener pair)
//   session    traders (Set of wallets seen trading), devSold (bool), devBuySol, fresh (just arrived: flash once),
//              seenAt (ms of the last upsert)
import { LS, emit, isMint, safeUrl } from './util.js';
import { solUsd } from './price.js';

// pump.fun curves start at 30 virtual SOL x 1,073,000,000 virtual tokens; 793,100,000 tokens are sellable and the
// curve completes when they're gone. Progress from virtual token reserves, or from market cap in SOL (checked against
// Jupiter's bondingCurve: within about a point while the market cap is fresh).
export const curveProgress = (vTokens) => Math.max(0, Math.min(1, (1073000000 - vTokens) / 793100000));
export const progressFromMcSol = (mcSol) => (mcSol > 0 ? curveProgress(Math.sqrt((30 * 1073000000 * 1e9) / mcSol)) : 0);

export const tokens = new Map();
// the saved board is read back field by field: storage can hold anything (an imported settings file, an old version)
const URLS = new Set(['image', 'imageOriginal', 'imageAlt', 'twitter', 'telegram', 'website']), SKIP = new Set(['__proto__', 'constructor', 'prototype', 'traders', 'pair', 'fresh']);
function revive(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t) || !isMint(t.mint)) return null;
  const o = {};
  for (const [k, v] of Object.entries(t)) {
    if (SKIP.has(k)) continue;
    if (typeof v === 'string') { const s = URLS.has(k) ? safeUrl(v) : v.slice(0, 500); if (s) o[k] = s; }
    else if (typeof v === 'number') { if (Number.isFinite(v)) o[k] = v; }
    else if (typeof v === 'boolean') o[k] = v;
    else if (Array.isArray(v)) o[k] = v.filter((x) => typeof x === 'string').slice(0, 30).map((x) => x.slice(0, 60));
    else if (v && typeof v === 'object') { const n = {}; for (const [kk, vv] of Object.entries(v)) if (/^[\w-]{1,32}$/.test(kk) && kk !== '__proto__' && Number.isFinite(vv)) n[kk] = vv; o[k] = n; }
  }
  return o;
}
const saved = LS.get('board', []);
for (const t of (Array.isArray(saved) ? saved : []).map(revive)) if (t && Date.now() - (t.seenAt || t.created) < 6 * 3600e3) tokens.set(t.mint, { ...t, traders: new Set(), fresh: false, migrated: t.migrated || t.progress >= .999 });

export function upsert(mint, patch = {}) {
  let t = tokens.get(mint);
  if (!t) { t = { mint, created: Date.now(), volSol: 0, buys: 0, sells: 0, progress: 0, mcSol: 0, traders: new Set() }; tokens.set(mint, t); }
  const artworkChanged = ['image', 'imageOriginal', 'imageAlt', 'uri'].some(k => patch[k] !== undefined && patch[k] !== t[k]);
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) t[k] = v;
  const now = Date.now(); t.seenAt = now;
  if (patch.mcSol > 0) t.mcSolAt = patch.mcSolAt || now;
  if (patch.mcUsd > 0) t.mcUsdAt = patch.mcUsdAt || now;
  if (patch.price > 0) t.priceAt = patch.priceAt || now;
  if (patch.volume24h != null && solUsd() > 0) t.volSol = patch.volume24h / solUsd();
  if (t.progress >= .999 && !t.migrated) { t.migrated = true; t.migratedAt ||= now; }
  // Artwork can start immediately; price/row rendering keeps its 300ms batch.
  if (artworkChanged) emit('token-artwork', t);
  changed();
  return t;
}
export const all = () => [...tokens.values()];
// market cap in USD: the fresher of the stream's SOL figure and Jupiter's/Dexscreener's USD figure
export function mcUsd(t) {
  if (!t) return null;
  const fromSol = t.mcSol > 0 && solUsd() > 0 ? t.mcSol * solUsd() : null;
  if (t.mcUsd > 0 && (fromSol == null || (t.mcUsdAt || 0) >= (t.mcSolAt || 0))) return t.mcUsd;
  return fromSol ?? t.mcUsd ?? null;
}

// throttled change event so pages re-render at most ~3 times a second
let pending = false, dirty = false;
export function changed() { dirty = true; if (pending) return; pending = true; setTimeout(() => { pending = false; emit('tokens'); }, 300); }

// keep memory bounded (the feed brings ~2,000 new coins an hour): beyond 2,500, drop the least recently touched
setInterval(() => {
  if (tokens.size <= 2500) return;
  for (const t of all().sort((a, b) => (a.seenAt || 0) - (b.seenAt || 0)).slice(0, tokens.size - 2000)) tokens.delete(t.mint);
  changed();
}, 60000);

// keep the most recently seen coins across reloads
export function saveBoard() {
  if (!dirty) return;
  const keep = all().sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0)).slice(0, 240);
  if (LS.set('board', keep.map(({ traders, pair, fresh, ...rest }) => rest))) dirty = false;
}
setInterval(saveBoard, 10000);
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.hidden) saveBoard(); });
