// The Pulse feed: keeps the store filled with the coins the three Pulse columns show.
//   JG (Jupiter pools/gems) every 4 s: recent → pulseCol 'new', aboutToGraduate → 'stretch', graduated → 'migrated'
//   JT recent every 5 s: the newest coins on the launchpads the feed covers, even before JG lists them
// Both pause while the tab is hidden. seed() does the first load and starts the feed as soon as the first JG answer is
// in (JT recent can take 12–17 s while lite-api fails over, so it finishes on its own); stopFeed()/startFeed() toggle it.
// Polls go into jup.js's queues at 'low' priority (the first load and filter changes at 'normal'), so a trade's quotes
// and balance checks never wait behind them.
// Pulse can narrow what JG returns with setFeedBody({recent, aboutToGraduate, graduated}) (filter fields: see jup.js).
// If JG fails, GeckoTerminal fills the board instead: a throttled FALLBACK only, never the main path.
import { getJson, isMint, queued, on, emit } from './util.js';
import { tokens, upsert, progressFromMcSol, changed } from './store.js';
import { solUsd } from './price.js';
import { settings } from './settings.js';
import { jg, jt, LAUNCHPADS, img } from './jup.js';

// feed status for the status bar: source 'jupiter' | 'geckoterminal', last good polls (ms), consecutive JG failures
export const feed = { on: false, source: '', lastGems: 0, lastRecent: 0, fails: 0, error: '' };

const column = (launchpads) => ({ timeframe: '24h', launchpads });
// graduated: minMcap 1 drops the many price-less instant graduations (mostly generic Meteora DBC test coins)
export const defaultBody = (launchpads = LAUNCHPADS) => ({ recent: column(launchpads), aboutToGraduate: column(launchpads), graduated: { ...column(launchpads), minMcap: 1 } });
let body = defaultBody();
export const feedBody = () => body;
export function setFeedBody(b) { body = b || defaultBody(); if (feed.on || gemsBusy) pollGems(false, 'normal'); }

const COLS = { recent: 'new', aboutToGraduate: 'stretch', graduated: 'migrated' };
const hidden = () => typeof document !== 'undefined' && document.hidden;

// write one Jupiter token patch into the store with its Pulse column (quiet: the first load doesn't flash)
function put(t, pulseCol, quiet, now = Date.now()) {
  const cur = tokens.get(t.mint);
  if (pulseCol && pulseCol !== 'migrated' && (cur?.migrated || t.migrated)) pulseCol = 'migrated'; // never back onto a curve
  const patch = { ...t, pulseCol, pulseAt: pulseCol ? now : undefined, fresh: !cur && !quiet ? true : undefined };
  // JT has no bonding-curve figure: estimate pump.fun progress from market cap (same curve constants as the stream)
  if (patch.progress == null && !patch.migrated && patch.launchpad === 'pump.fun' && patch.mcUsd > 0 && solUsd() > 0) patch.progress = progressFromMcSol(patch.mcUsd / solUsd());
  upsert(t.mint, patch);
}

let gemsBusy = false, gemsAgain = false, recentBusy = false;
async function pollGems(quiet = false, prio = 'low') {
  if (gemsBusy) { if (prio !== 'low') gemsAgain = true; return; } // a new body while a poll is out: ask again after it
  gemsBusy = true;
  try {
    const g = await jg.gems(body, { prio }), now = Date.now();
    for (const [k, c] of Object.entries(COLS)) for (const t of g[k]) put(t, c, quiet, now);
    Object.assign(feed, { source: 'jupiter', lastGems: now, fails: 0, error: '' });
  } catch (e) {
    feed.fails++; feed.error = e.message || 'Jupiter did not answer';
    if (feed.fails >= (feed.lastGems ? 2 : 1)) geckoFallback().catch(() => {}); // not awaited: the 4 s polls keep trying Jupiter
  } finally {
    gemsBusy = false; emit('feed', feed);
    if (gemsAgain) { gemsAgain = false; setTimeout(() => feed.on && pollGems(false, 'normal'), 0); }
  }
}
async function pollRecent(quiet = false, prio = 'low') {
  if (recentBusy) return; // a slow answer (lite-api failing over) must not stack up behind the 5 s timer
  recentBusy = true;
  try {
    const list = await jt.recent({ prio }), lps = body.recent?.launchpads, now = Date.now();
    for (const t of list) {
      if (Array.isArray(lps) && !lps.includes(t.launchpad) && !lps.includes(t.metaLaunchpad)) continue;
      put(t, t.migrated ? 'migrated' : tokens.get(t.mint)?.pulseCol ? undefined : 'new', quiet, now);
    }
    feed.lastRecent = now;
  } catch { /* JG covers it */ } finally { recentBusy = false; }
}

let timers = [], lastGemsAttempt = 0, lastRecentAttempt = 0, offRoute;
export const feedCadence = (page = typeof document !== 'undefined' ? document.body?.dataset.page : '') => page === 'pulse' ? [4000, 10000] : [30000, 60000];
function tick(force = false) {
  if (hidden() || !feed.on) return;
  const now = Date.now(), [gemsMs, recentMs] = feedCadence();
  if (force || now - lastGemsAttempt >= gemsMs) { lastGemsAttempt = now; pollGems(); }
  if (force || now - lastRecentAttempt >= recentMs) { lastRecentAttempt = now; pollRecent(); }
}
const onVis = () => tick(true);
export function startFeed() {
  if (feed.on) return; feed.on = true;
  lastGemsAttempt = lastRecentAttempt = Date.now();
  timers = [setInterval(tick, 1000)];
  offRoute = on('route', (r) => { if (r.id === 'pulse') tick(true); });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
}
export function stopFeed() {
  feed.on = false; timers.forEach(clearInterval); timers = [];
  offRoute?.(); offRoute = null;
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
}
// first load: JG fills all three columns in one round trip and the 4 s feed starts right after it; the first JT recent
// runs alongside and lands whenever it does (it is not waited for)
export async function seed() {
  pollRecent(true, 'normal');
  await pollGems(true, 'normal');
  startFeed();
}

// ---- GeckoTerminal: FALLBACK ONLY (2–5 calls a minute in practice). One serial lane, a 60 s cache, and a 45 s
// back-off after a 429, which arrives without CORS headers so the browser reports a TypeError.
export const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const gtCache = new Map(); let gtCool = 0;
export function gecko(path) {
  const hit = gtCache.get(path); if (hit && Date.now() - hit.at < 60e3) return hit.p;
  const p = queued('gecko', 3000, async () => {
    if (Date.now() < gtCool) throw new Error('GeckoTerminal is rate limiting. Try again in a minute.');
    try { return await getJson(GT + path, {}, 12000); }
    catch (e) { if (e instanceof TypeError || /^429/.test(e.message)) gtCool = Date.now() + 45e3; throw e; }
  });
  gtCache.set(path, { at: Date.now(), p }); p.catch(() => gtCache.delete(path));
  if (gtCache.size > 100) gtCache.delete(gtCache.keys().next().value);
  return p;
}
// Walk a GeckoTerminal pools response: fn(attributes, mint, baseTokenAttributes, dexId, pool)
export function eachPool(j, fn) {
  const inc = new Map((j?.included || []).map((x) => [x.id, x.attributes]));
  for (const p of j?.data || []) {
    const id = p.relationships?.base_token?.data?.id || '', mint = id.replace(/^solana_/, '');
    if (isMint(mint)) fn(p.attributes || {}, mint, inc.get(id) || {}, p.relationships?.dex?.data?.id, p);
  }
}
// identity from GeckoTerminal only for coins we know nothing about yet
const str = (x, max) => (typeof x === 'string' && x ? x.slice(0, max) : undefined);
const ident = (mint, a, b) => {
  if (tokens.get(mint)?.symbol) return {};
  const pair = str(a.name, 200)?.split(' / ')[0], pic = str(b.image_url, 500);
  return { name: str(b.name, 80) || str(pair, 80), symbol: str(b.symbol, 24) || str(pair, 24), image: img(pic && !/missing/.test(pic) ? pic : '') || undefined };
};
let lastGt = 0;
async function geckoFallback() {
  if (Date.now() - lastGt < 60e3) return; lastGt = Date.now();
  feed.source = 'geckoterminal';
  const usd = solUsd(), at = (a) => Date.parse(a.pool_created_at) || undefined;
  const take = async (path, fn) => { try { eachPool(await gecko(path), fn); } catch { /* next time */ } };
  const curve = (mint, a, b, col) => {
    const mcUsd = Number(a.fdv_usd) || undefined, progress = mcUsd && usd > 0 ? progressFromMcSol(mcUsd / usd) : undefined;
    put({ mint, ...ident(mint, a, b), created: tokens.has(mint) ? undefined : at(a), launchpad: 'pump.fun', mcUsd, progress, volume24h: Number(a.volume_usd?.h24) || undefined }, col || (progress * 100 >= settings.stretch ? 'stretch' : 'new'));
  };
  const grad = (mint, a, b) => { if (/pump$/.test(mint)) put({ mint, ...ident(mint, a, b), launchpad: 'pump.fun', migrated: true, migratedAt: tokens.get(mint)?.migratedAt || at(a), progress: 1, mcUsd: Number(a.fdv_usd) || undefined }, 'migrated'); };
  // most useful first (JT recent and the stream already cover New); GT often refuses the third call in a minute
  await take('/dexes/pump-fun/pools?page=1&sort=h24_volume_usd_desc&include=base_token', (a, mint, b) => curve(mint, a, b));
  await take('/dexes/pumpswap/pools?page=1&sort=h24_tx_count_desc&include=base_token', (a, mint, b) => grad(mint, a, b));
  await take('/new_pools?page=1&include=base_token,dex', (a, mint, b, dex) => { if (dex === 'pump-fun') curve(mint, a, b, 'new'); if (dex === 'pumpswap') grad(mint, a, b); });
  changed();
}
