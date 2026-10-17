// The public KOL list (data/kol-wallets.json, refreshed from kolscan.io by tools/kols.mjs): wallet → name, X account and
// profile picture. Nought never guesses who owns a wallet; only listed wallets get a name and picture.
import { isMint, short, LS } from './util.js';
import { settings } from './settings.js';

const PFP = /^https:\/\/kolscan-images\.pump\.fun\/profiles\/[1-9A-HJ-NP-Za-km-z]{32,44}\/[\w.-]{1,80}$/;
const str = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
export const cleanKol = (k) => {
  const a = String(k?.address || '').trim();
  if (!isMint(a)) return null;
  const x = String(k.x || '').trim().replace(/^@/, ''), pfp = String(k.pfp || '');
  return { address: a, name: str(k.name, 40) || short(a), x: /^[A-Za-z0-9_]{1,15}$/.test(x) ? x : '', pfp: PFP.test(pfp) ? pfp : '', tags: Array.isArray(k.tags) ? k.tags.map((t) => str(t, 20)).filter(Boolean).slice(0, 5) : [] };
};
let cache = null, pending = null;
export function loadKols() {
  if (cache && Date.now() - cache.at < 300e3) return Promise.resolve(cache);
  return (pending ||= (async () => {
    try {
      const r = await fetch('data/kol-wallets.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json(), seen = new Set();
      const list = (Array.isArray(j) ? j : []).map(cleanKol).filter((k) => k && !seen.has(k.address) && seen.add(k.address)).slice(0, 2000);
      cache = { at: Date.now(), list, by: new Map(list.map((k) => [k.address, k])) };
    } catch { cache = { at: Date.now(), list: [], by: new Map(), err: true }; }
    pending = null;
    return cache;
  })());
}
// a picture's https URL, or '' (falls back to an X avatar service by handle when the list has none)
export const kolPic = (k) => k?.pfp || (k?.x ? `https://unavatar.io/x/${k.x}` : '');

// Wallets not on the list: pump.fun profiles their owners set up (X account, picture or chosen name), read through the
// metadata relay because pump.fun refuses other sites' browsers. → Map(wallet → {name, x, pfp, source: 'pump.fun'})
const WHO_PFP = /^https:\/\/(?:[a-z0-9-]+\.)*(?:pump\.fun|pinata\.cloud|ipfs\.io|cloudfront\.net|twimg\.com)\/\S{1,380}$/i;
const WHO_KEY = 'who2', WHO_TTL = 24 * 3600e3, WHO_NONE = 6 * 3600e3;
const whoEntry = (w, p) => {
  const x = typeof p?.x === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(p.x) ? p.x : '', pfp = typeof p?.pfp === 'string' && WHO_PFP.test(p.pfp) ? p.pfp : '';
  const name = str(p?.name, 30) || x;
  return name || pfp ? { address: w, name: name || short(w), x, pfp, tags: ['pump.fun'] } : null;
};
// wallet → {v: entry or null, until}; answers persist in localStorage so pictures show at once on the next visit
const whoSeen = new Map(Object.entries(LS.get(WHO_KEY, {}) || {}).filter(([w, e]) => isMint(w) && e && e.until > Date.now()).map(([w, e]) => [w, { v: e.p ? whoEntry(w, e.p) : null, until: e.until }]));
let whoSave = 0;
function rememberWho() {
  clearTimeout(whoSave);
  whoSave = setTimeout(() => {
    const keep = [...whoSeen].filter(([, e]) => e.until > Date.now()).slice(-3000);
    LS.set(WHO_KEY, Object.fromEntries(keep.map(([w, e]) => [w, { until: e.until, p: e.v ? { name: e.v.name, x: e.v.x, pfp: e.v.pfp } : null }])));
  }, 1500);
}
// true once the relay answered for this wallet (profile or none) within the cache window
export const whoAnswered = (w) => (whoSeen.get(w)?.until || 0) > Date.now();
// Calls posted on the pump.fun app for one coin (who called it, at what market cap, their note), read through the
// relay. → [{id, wallet, at, mc, multiple, max, note, kol}] where kol is the caller's profile, shaped like a list entry
export async function callouts(mint) {
  const relay = settings.metaRelay; if (!relay || !isMint(mint)) return [];
  const r = await fetch(`${relay}/callouts?mint=${mint}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const j = await r.json(), n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return (Array.isArray(j?.callouts) ? j.callouts : []).filter((c) => isMint(c?.wallet) && n(c.at)).slice(0, 50).map((c) => ({
    id: str(c.id, 64) || c.wallet + c.at, wallet: c.wallet, at: c.at, mc: n(c.mc), multiple: n(c.multiple), max: n(c.max), note: str(c.note, 280),
    kol: whoEntry(c.wallet, c) || { address: c.wallet, name: short(c.wallet), x: '', pfp: '', tags: ['pump.fun'] },
  }));
}

// The newest 50 coins a wallet launched on pump.fun, read through the relay → {count, coins: [{mint, name, symbol, at, done}]}
export async function createdBy(wallet) {
  const relay = settings.metaRelay; if (!relay || !isMint(wallet)) return null;
  const r = await fetch(`${relay}/created?w=${wallet}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const j = await r.json(), n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const coins = (Array.isArray(j?.coins) ? j.coins : []).filter((c) => isMint(c?.mint)).slice(0, 50).map((c) => ({ mint: c.mint, name: str(c.name, 60), symbol: str(c.symbol, 24), at: n(c.at), done: c.done === true }));
  return { count: n(j?.count) ?? coins.length, coins };
}

export async function whoIs(wallets) {
  const relay = settings.metaRelay, out = new Map(), ask = [];
  for (const w of new Set(wallets)) { if (!isMint(w)) continue; const e = whoSeen.get(w); if (e && e.until > Date.now()) { if (e.v) out.set(w, e.v); } else ask.push(w); }
  if (!relay || !ask.length) return out;
  for (let i = 0; i < ask.length && i < 100; i += 20) {
    const part = ask.slice(i, i + 20);
    try {
      const r = await fetch(`${relay}/who?w=${part.join(',')}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      // a wallet the relay left out was not answered (pump.fun busy): not remembered, asked again later
      for (const w of part) {
        if (!j || typeof j !== 'object' || !(w in j)) continue;
        const v = whoEntry(w, j[w]);
        whoSeen.set(w, { v, until: Date.now() + (v ? WHO_TTL : WHO_NONE) }); if (v) out.set(w, v);
      }
      rememberWho();
    } catch { /* the relay is optional */ }
  }
  return out;
}
