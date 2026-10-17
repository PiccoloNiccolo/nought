// Recently viewed coins: the last 20 token pages opened in this browser, newest first, in LS 'recent' as
// [{mint, symbol, name, image}] (search wrote this list before; it keeps the same shape, so nothing saved is lost).
// Search shows it under "Recent" and the strip under the top bar has it as a source.
//   recentCoins()        → [{mint, symbol?, name?, image?}] (re-checked on every read: the list comes back from storage)
//   rememberCoin(row)    put a coin first (fields it lacks keep what was stored)
//   fillRecent(list)     add missing names/pictures from token objects, order unchanged
//   clearRecent()
//   initRecent()         records every #/t/<mint> visit (called once by the shell)
// Every change emits util 'recent' with the new list.
import { LS, safeUrl, isMint, on, emit } from '../core/util.js';
import { tokens } from '../core/store.js';

const MAX = 20;
const str = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
const tidy = (r) => ({ mint: r.mint, symbol: str(r.symbol, 24), name: str(r.name, 60), image: safeUrl(r.image) || undefined });
export const recentCoins = () => { const l = LS.get('recent', []); return (Array.isArray(l) ? l : []).map((r) => (typeof r === 'string' ? { mint: r } : r)).filter((r) => r && isMint(r.mint)).slice(0, MAX).map(tidy); };
function save(list) { LS.set('recent', list.slice(0, MAX)); emit('recent', recentCoins()); }

export function rememberCoin(row) {
  if (!isMint(row?.mint)) return;
  const l = recentCoins(), old = l.find((r) => r.mint === row.mint) || {}, s = tokens.get(row.mint) || {};
  const keep = tidy({ mint: row.mint, symbol: row.symbol || s.symbol || old.symbol, name: row.name || s.name || old.name, image: row.image || s.image || old.image });
  if (l[0]?.mint === keep.mint && l[0].symbol === keep.symbol && l[0].name === keep.name && l[0].image === keep.image) return;
  save([keep, ...l.filter((r) => r.mint !== row.mint)]);
}
export function fillRecent(list) {
  const by = new Map((list || []).filter((t) => isMint(t?.mint)).map((t) => [t.mint, t]));
  let n = 0;
  const next = recentCoins().map((r) => {
    const t = by.get(r.mint); if (!t || (r.symbol && r.image)) return r;
    n++; return tidy({ mint: r.mint, symbol: r.symbol || t.symbol, name: r.name || t.name, image: r.image || t.image });
  });
  if (n) save(next);
}
export function clearRecent() { save([]); }

let started = false;
export function initRecent() {
  if (started) return; started = true;
  const seen = () => { const m = /^#\/t\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?])/.exec(location.hash)?.[1]; if (isMint(m)) rememberCoin({ mint: m }); };
  on('route', seen); seen();
  // the token page fills the store a moment after it opens: pick up the name and picture then
  on('route', () => setTimeout(seen, 4000));
}
