// The watchlist: the coins the user starred. The single source of truth for every page (token star, Watchlist page,
// Discover, the watchlist strip). Stored in localStorage 'watch' (LS key, so 'nought.watch') as an array of mints in
// the order they were starred: the same format pages used before this module, so nothing saved is lost.
//   watchlist           Set of mints (live: kept in step with storage; read it, change it only through the calls below)
//   isWatched(mint)     → bool
//   toggleWatch(mint)   → bool (watched after the toggle)
//   setWatched(mint, yes) → bool (watched now; false for a non-mint)
//   watchMints()        → string[] in starred order
// Every change emits util 'watch' {mint, watched, list (string[])}; a change made in another tab (or by code that
// still writes LS 'watch' directly) emits {mint: null, watched: null, list, external: true}.
import { LS, emit, isMint } from './util.js';

const KEY = 'watch', MAX = 500;
const clean = (l) => (Array.isArray(l) ? [...new Set(l.filter(isMint))].slice(-MAX) : []);
const rawNow = () => { try { return localStorage.getItem('nought.' + KEY); } catch { return null; } };

export const watchlist = new Set(clean(LS.get(KEY, [])));
let raw = rawNow();

// pick up writes made elsewhere (another tab, or a page that still writes LS 'watch' itself). The 'watch' event for
// such a change goes out after the current task, so a page reading isWatched() mid-render is never re-entered.
let externalQueued = false;
function sync() {
  const now = rawNow();
  if (now === raw) return false;
  raw = now;
  const next = clean(LS.get(KEY, [])), cur = [...watchlist];
  if (next.length === cur.length && next.every((m, i) => cur[i] === m)) return false;
  watchlist.clear(); for (const m of next) watchlist.add(m);
  if (!externalQueued) {
    externalQueued = true;
    setTimeout(() => { externalQueued = false; emit('watch', { mint: null, watched: null, list: [...watchlist], external: true }); }, 0);
  }
  return true;
}
function save(mint, watched) {
  LS.set(KEY, [...watchlist]);
  raw = rawNow();
  emit('watch', { mint, watched, list: [...watchlist] });
}

export const watchMints = () => { sync(); return [...watchlist]; };
export const isWatched = (mint) => { sync(); return watchlist.has(mint); };

export function setWatched(mint, yes) {
  if (!isMint(mint)) return false;
  sync();
  const want = !!yes;
  if (watchlist.has(mint) === want) return want; // nothing to change, no event
  if (want) { watchlist.add(mint); if (watchlist.size > MAX) watchlist.delete(watchlist.values().next().value); }
  else watchlist.delete(mint);
  save(mint, want);
  return want;
}
export const toggleWatch = (mint) => (isMint(mint) ? setWatched(mint, !isWatched(mint)) : false);

// other tabs: the storage event fires there for every write here (and here for writes there)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === null || e.key === 'nought.' + KEY) sync();
  });
}
