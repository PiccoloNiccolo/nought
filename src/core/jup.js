// Jupiter + Dexscreener adapters. Every call goes through a per-host queue, checks the shape of what came back and
// returns small plain objects, so an upstream change breaks one feature instead of the whole app. Adapters throw on
// network/HTTP/shape errors (callers fall back) and return empty lists/maps when there is simply nothing.
// All endpoints below were checked live (CORS open, keyless) on 2026-10-03; see docs/feature-matrix.md §0.
//
//   jt.search(q | mints[])  JT tokens/v2/search (text, a mint, or many mints: batched 50 per call)  → [Token]
//   jt.recent()             JT tokens/v2/recent (the newest ~30 tokens on any launchpad)            → [Token]
//   jt.top(kind, iv, n)     JT tokens/v2/{toptrending|toporganicscore|toptraded}/{5m|1h|6h|24h}      → [Token]
//   jt.tag(tag)             JT tokens/v2/tag?query=lst|verified (every token with that tag, cached 1 h) → [Token]
//   jp.prices(mints)        JP price/v3 (chunks of 50)    → Map(mint → {price, change24h, liquidity, decimals, launchpad, created})
//   ju.balances(w)          JU ultra/v1/balances (non-zero only)  → {sol, lamports, tokens: {mint: {raw, ui, dec, frozen}}}
//   ju.holdings(w)          JU ultra/v1/holdings (incl. empty accounts = mints traded before)
//                                                        → {sol, lamports, tokens: {mint: {raw, ui, dec, frozen, program, accounts}}}
//   ju.shield(mints)        JU ultra/v1/shield            → {mint: [{type, message, severity}]}
//   jg.gems(body)           JG POST datapi pools/gems     → {recent: [Token], aboutToGraduate: [Token], graduated: [Token]}
//   jx.txs(mint, {trader, offset})  JX datapi txs, 30 per page, newest first → {txs: [Tx], next} (pass next as offset)
//   jh.holders(mint)        JH datapi holders (top 100)   → {count, holders: [Holder]}
//   jc.chart(mint, {interval, to, candles, type, quote})  JC datapi v2 charts → [{time (s), open, high, low, close, volume}]
//   ds.tokens(mints) → Map(mint → best pair) · ds.pairs(mint) → [pair] · ds.search(q) → [pair] (Solana only)
//   ds.boosts('top'|'latest') · ds.profiles() · ds.ctos() → [Promo] · ds.orders(mint) → {paid, orders, boosts} (cached 10 min)
// Every adapter takes an optional last argument {prio: 'high' | 'normal' (default) | 'low'} (jx.txs and jc.chart: a
// prio field in their options); jt.recent and jg.gems default to 'low'. See the transport notes below for what it does.
// Also: queueState() (per-host queue snapshot), coolLeft(host) (ms), jupRaw(url, opt, {prio, timeout, queue, failover,
// maxWait}) for trade.js/orders.js, QUEUE_MS, QUEUE_CAP, HIGH_WAIT.
//
// Token (from toToken: plain store patch, ready for upsert(t.mint, t); missing values stay undefined so a patch never
// clobbers better data):
//   mint, name, symbol, image (safe URL), decimals, tokenProgram, verified, tags[]
//   twitter, telegram, website (safe URLs), xHandle, xFollowers
//   dev (creator wallet), launchpad ('pump.fun' | 'letsbonk.fun' | 'raydium-launchlab' | 'met-dbc' | 'bags.fun' | ...),
//   metaLaunchpad, created (ms), progress (bonding curve 0..1, when known), migrated, migratedAt (ms), gradPool
//   price (USD), mcUsd, fdvUsd, liquidity (USD), circSupply, totalSupply, holders, volume24h (USD), buys, sells (24h)
//   top10Pct, devPct (0 when Jupiter omits it), devMints, devMigrations, sniperPct, insiderPct, botPct, sus,
//   mintAuthDisabled, freezeAuthDisabled, organicScore (0..100), organicLabel ('low' | 'medium' | 'high')
//   fees (SOL paid in fees, JG only), dexPaid (bool), live (pump.fun livestream on), mayhem, apy ({source: %/yr}, LSTs)
//   stats5m / stats1h / stats6h / stats24h: {priceChange (%), vol, buyVol, sellVol, organicVol (USD), buys, sells,
//     traders, netBuyers, organicBuyers, holderChange, liquidityChange, volumeChange}
//   pool fields (JG only): pool (pool address), poolType, poolCreated (ms)
// Tx:     {id, sig, mint, side: 'buy'|'sell', wallet, tokens (UI amount), sol, usd, priceUsd, at (ms), pool, mev, tags[]}
// Holder: {wallet, amount (UI), sol, tags[] (holderTags: 'insider' | 'sniper' | 'bundler' ...), labels[] ({id, name},
//          e.g. id 'Pool' for the LP), funding: {from, amount (SOL), tx, at (ms), slot} | null}
// Promo:  {mint, url, icon, header, description, links: [{type, label, url}], amount, total}
// pair:   raw Dexscreener pair (baseToken, quoteToken, dexId, pairAddress, priceUsd, marketCap, fdv, liquidity.usd,
//         volume.{m5,h1,h6,h24}, txns, priceChange, pairCreatedAt, info.{imageUrl, websites, socials}, boosts.active)
import { safeUrl, isMint } from './util.js';
import { assertZeroFeeRequest } from './fee-policy.js';
import { retryDelay } from './retry-policy.js';

export const LAUNCHPADS = ['pump.fun', 'letsbonk.fun', 'raydium-launchlab', 'met-dbc', 'bags.fun', 'moonshot', 'jup-studio', 'stonkfun', 'forge'];
export const INTERVALS = ['5m', '1h', '6h', '24h'];
export const CHART_INTERVALS = ['1_SECOND', '15_SECOND', '30_SECOND', '1_MINUTE', '3_MINUTE', '5_MINUTE', '15_MINUTE', '30_MINUTE', '1_HOUR', '2_HOUR', '4_HOUR', '8_HOUR', '12_HOUR', '1_DAY', '1_WEEK', '1_MONTH'];
const LITE = 'https://lite-api.jup.ag', KEYLESS = 'https://api.jup.ag', DATA = 'https://datapi.jup.ag', DS = 'https://api.dexscreener.com';

// ---- transport: one priority queue per host ----
// A host has `n` slots; a slot takes its next request `gap` ms after its last one finished. Waiting requests go out by
// priority, oldest first within one:
//   'high'    a trade waits on it: quotes, the balance check before a sell, building a transaction (trade.js, orders.js)
//   'normal'  what the user just opened (the default)
//   'low'     background polling (the Pulse feed, enrichment, trade polling)
// Nothing piles up behind a rate limit: a request that has waited QUEUE_MS (10 s) is dropped with a "busy" error
// ({busy: true}), each host holds at most QUEUE_CAP waiting requests (the lowest-priority, oldest one is dropped
// first), and while a host cools down after a 429 every request that can't start within its wait budget fails at once
// ({status: 429, cooling: true}). Identical GETs share one request (a later, higher priority caller lifts it).
// A 'high' call that has another host to try (lite-api → api.jup.ag) waits at most HIGH_WAIT (4 s) for a slot first.
// api.jup.ag (keyless, about 5 requests per 10 s) reports its budget in x-ratelimit-remaining/-reset: the queue spends
// it in short bursts, keeps the last request of each window for 'high' calls and the last two away from 'low' ones,
// so background polling never uses up what a trade needs.
const PRIO = { high: 0, normal: 1, low: 2 };
export const QUEUE_MS = 10000, QUEUE_CAP = 30, HIGH_WAIT = 4000;
const LITE_H = 'lite-api.jup.ag', KEY_H = 'api.jup.ag';
const HOSTS = {
  [LITE_H]: { n: 3, gap: 100, label: 'Jupiter' },
  [KEY_H]: { n: 1, gap: 2100, label: 'Jupiter (keyless API)', budget: true },
  'datapi.jup.ag': { n: 4, gap: 80, label: 'Jupiter data' },
  'api.dexscreener.com': { n: 2, gap: 300, label: 'Dexscreener' },
  'ds-orders': { n: 1, gap: 1000, label: 'Dexscreener' },
};
const hosts = new Map();
function hostOf(key) {
  let h = hosts.get(key);
  if (!h) {
    const c = HOSTS[key] || { n: 2, gap: 250, label: key };
    h = { ...c, key, free: Array(c.n).fill(0), q: [], same: new Map(), cool: 0, failures: 0, remaining: null, resetAt: 0, seenAt: 0, timer: 0 };
    hosts.set(key, h);
  }
  return h;
}
const cool = (key, ms) => { const h = hostOf(key); h.cool = Math.max(h.cool, Date.now() + ms); };
// ms until a host takes requests again (0 = ready)
export const coolLeft = (key) => Math.max(0, (hosts.get(key)?.cool || 0) - Date.now());
const errOf = (h, msg, extra) => Object.assign(new Error(msg), { host: h.key }, extra);
const coolErr = (h) => errOf(h, `${h.label} is rate limiting right now. Try again in ${Math.max(1, Math.ceil(coolLeft(h.key) / 1000))} s.`, { status: 429, cooling: true });
const busyErr = (h, why) => errOf(h, `${h.label} is busy (${why}), so this request was dropped. Try again in a moment.`, { busy: true });
// the keyless budget: 'high' may spend the last request of a window, 'normal' all but the last, 'low' all but the last
// two; whatever can't go waits for the next window
const budgetKnown = (h) => h.budget && h.remaining != null && Date.now() - h.seenAt < 15000;
const budgetOk = (h, e, now) => !budgetKnown(h) || now >= h.resetAt || h.remaining > e.prio;
function noteBudget(h, r) {
  const rem = r.headers.get('x-ratelimit-remaining');
  if (!h.budget || rem == null || rem === '' || !isFinite(Number(rem))) return;
  const now = Date.now(), reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
  h.remaining = Number(rem); h.seenAt = now; h.resetAt = reset > now && reset - now < 60000 ? reset : now + 10000;
  if (h.remaining <= 0) cool(h.key, Math.max(1000, h.resetAt - now));
}
function drop(h, e, err) {
  const i = h.q.indexOf(e); if (i >= 0) h.q.splice(i, 1);
  if (e.same) h.same.delete(e.same);
  e.rej(err);
}
function pump(h) {
  clearTimeout(h.timer); h.timer = 0;
  let now = Date.now();
  for (const e of [...h.q]) {
    const deadline = e.at + e.maxWait;
    if (now >= deadline) drop(h, e, busyErr(h, `waited over ${Math.round(e.maxWait / 1000)} s`));
    else if (h.cool > deadline || (e.failover && h.cool > now)) drop(h, e, coolErr(h)); // (failover: try the other host now)
  }
  while (h.q.length && now >= h.cool) {
    const slot = h.free.findIndex((t) => t <= now); if (slot < 0) break;
    let best = h.q[0]; for (const e of h.q) if (e.prio < best.prio) best = e; // the first of the best priority = oldest
    if (!budgetOk(h, best, now)) break;
    h.q.splice(h.q.indexOf(best), 1);
    run(h, slot, best);
    now = Date.now();
  }
  if (!h.q.length) return;
  // wake for the next slot, the end of a cool-down or budget window, or the next deadline
  const times = [...h.free.filter((t) => t > now && t < Infinity), h.cool, h.budget ? h.resetAt : 0, ...h.q.map((e) => e.at + e.maxWait)].filter((t) => t > now);
  const at = times.length ? Math.min(...times) : now + 250;
  h.timer = setTimeout(() => pump(h), Math.max(15, at - now));
}
function run(h, slot, e) {
  h.free[slot] = Infinity;
  if (budgetKnown(h) && Date.now() < h.resetAt && h.remaining > 0) h.remaining--; // spent (the answer corrects it)
  let p; try { p = Promise.resolve(e.fn()); } catch (err) { p = Promise.reject(err); }
  p.then(e.res, e.rej).finally(() => {
    if (e.same && h.same.get(e.same) === e) h.same.delete(e.same);
    h.free[slot] = Date.now() + (budgetKnown(h) && h.remaining > 0 ? 250 : h.gap);
    pump(h);
  });
}
// queue fn on a host. opts: {prio: 'high'|'normal'|'low', same (key for identical requests), maxWait (ms),
// failover (another host can serve it: fail at once while this one cools down)}
function enqueue(key, fn, { prio = 'normal', same = null, maxWait = QUEUE_MS, failover = false } = {}) {
  const h = hostOf(key), p = PRIO[prio] ?? 1, t = Date.now();
  if (same) {
    const hit = h.same.get(same);
    if (hit) { if (p < hit.prio && h.q.includes(hit)) { hit.prio = p; pump(h); } return hit.promise; }
  }
  if (h.cool - t > (failover ? 0 : maxWait)) return Promise.reject(coolErr(h));
  const e = { fn, prio: p, at: t, maxWait, same, failover };
  e.promise = new Promise((res, rej) => { e.res = res; e.rej = rej; });
  h.q.push(e); if (same) h.same.set(same, e);
  if (h.q.length > QUEUE_CAP) {
    let worst = h.q[0]; for (const x of h.q) if (x.prio > worst.prio) worst = x; // the oldest of the worst priority
    drop(h, worst, busyErr(h, 'too many requests waiting'));
  }
  pump(h);
  return e.promise;
}
// what each host's queue is doing (status bar, debugging): {host: {queued, running, coolMs, remaining}}
export function queueState() {
  const out = {};
  for (const [k, h] of hosts) out[k] = { queued: h.q.length, running: h.free.filter((x) => x === Infinity).length, coolMs: coolLeft(k), remaining: budgetKnown(h) ? h.remaining : null };
  return out;
}

// one request → {status, ok, j (parsed JSON or null), headers}. A TypeError is a network/CORS failure (a 429 without
// CORS headers looks exactly like that), so it cools the host; so does a 429 or an exhausted keyless budget.
async function send(url, opt = {}, timeout = 10000, key = new URL(url).host) {
  const h = hostOf(key);
  let r;
  try { r = await fetch(url, { ...opt, signal: opt.signal || AbortSignal.timeout(timeout) }); }
  catch (e) {
    if (e?.name !== 'AbortError') cool(key, retryDelay(++h.failures));
    throw Object.assign(new Error(`No answer from ${h.label}`), { net: true, host: key });
  }
  noteBudget(h, r);
  if (r.status === 429 || r.status >= 500) cool(key, retryDelay(++h.failures, r.headers.get('retry-after')));
  else if (r.ok) h.failures = 0;
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, ok: r.ok, j, headers: r.headers };
}
async function fetchJson(url, opt = {}, timeout = 10000, key = new URL(url).host) {
  const { status, ok, j } = await send(url, opt, timeout, key), label = hostOf(key).label;
  if (status === 429) throw errOf(hostOf(key), `${label} is rate limiting right now. Try again in a few seconds.`, { status: 429 });
  // Jupiter sometimes reports errors inside an HTTP 200 body: {status: 400, message}
  if (!ok || (j && !Array.isArray(j) && typeof j === 'object' && Number(j.status) >= 400)) throw Object.assign(new Error(j?.message || j?.error || `${status} from ${label}`), { status: Number(j?.status) || status });
  if (j === null) throw new Error(`Unreadable answer from ${label}`);
  return j;
}
const call = (key, url, opt = {}, { prio, timeout = 10000, maxWait, failover } = {}) =>
  enqueue(key, () => fetchJson(url, opt, timeout, key), { prio, maxWait, failover, same: !opt.method || opt.method === 'GET' ? url : null });
// For trade.js / orders.js, which read Jupiter's own error bodies: one request through the host's queue (queue: false
// sends at once: only for handing over an already signed transaction) → {status, ok, j, headers}. Throws on network
// errors and queue drops only. failover: another host can serve it (fail at once while this one cools down, and a
// 'high' call waits at most HIGH_WAIT for a slot); maxWait overrides the queue wait (default QUEUE_MS).
export function jupRaw(url, opt = {}, { prio = 'normal', timeout = 15000, queue = true, failover = false, maxWait } = {}) {
  assertZeroFeeRequest(url, opt);
  const key = new URL(url).host, go = () => send(url, opt, timeout, key);
  return queue ? enqueue(key, go, { prio, failover, maxWait: maxWait ?? (failover && prio === 'high' ? HIGH_WAIT : QUEUE_MS) }) : go();
}
// lite-api first (or straight to api.jup.ag while lite-api cools down); on a network error, 429 or 5xx one more try on
// the keyless api.jup.ag, whose small budget the queue shares out by priority
const failover = (e, prio) => e.net || e.status === 429 || e.status >= 500 || (e.busy && prio === 'high');
async function jup(path, { prio = 'normal', timeout = 10000 } = {}) {
  const lc = coolLeft(LITE_H);
  if (!(lc > 0 && lc >= coolLeft(KEY_H))) {
    // a 'high' call waits at most HIGH_WAIT for a lite-api slot, then tries api.jup.ag (both cooling: wait for lite-api)
    try { return await call(LITE_H, LITE + path, {}, { prio, timeout: Math.min(timeout, 3500), failover: lc === 0, maxWait: prio === 'high' && lc === 0 ? HIGH_WAIT : QUEUE_MS }); }
    catch (e) { if (!failover(e, prio)) throw e; }
  }
  return call(KEY_H, KEYLESS + path, {}, { prio, timeout });
}
const data = (path, opt = {}, { prio, timeout } = {}) => call('datapi.jup.ag', DATA + path, opt, { prio, timeout });
const dsGet = (path, { prio, key = 'api.dexscreener.com' } = {}) => call(key, DS + path, {}, { prio });

// shape guards
const arr = (x, what) => { if (!Array.isArray(x)) throw new Error(`Unexpected answer from ${what}`); return x; };
const obj = (x, what) => { if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`Unexpected answer from ${what}`); return x; };

// IPFS: ipfs.io and dweb.link refuse browsers (403/429). pump.mypinata.cloud serves whatever pump.fun (and most
// launchpads) pinned, fast and with resizing (?img-width); gateway.pinata.cloud serves any CID but rate-limits bursts.
export const GATEWAYS = ['https://pump.mypinata.cloud/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];
// "<cid>[/path]" from ipfs://<cid>/path, https://host/[any/]ipfs/<cid>/path or https://<cid>.ipfs.host/path; null unless the
// CID is a real CIDv0 (Qm…) or base32 CIDv1 (b…). Path segments are decoded and re-encoded (no quotes, brackets or
// dot segments survive), so the result is safe to append to a gateway.
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;
const encSeg = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function cleanCid(cid, path) {
  if (!CID_RE.test(cid)) return null;
  const out = [cid];
  for (const raw of String(path || '').split('/')) {
    if (!raw) continue;
    let s; try { s = decodeURIComponent(raw); } catch { return null; }
    if (s === '.' || s === '..' || s.length > 200 || /[\u0000-\u001f\u007f]/.test(s)) return null;
    out.push(encSeg(s));
  }
  return out.length > 9 ? null : out.join('/');
}
export function cidPath(u) {
  const s = String(u ?? '').trim();
  const m = s.match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)\/?([^?#]*)/i) || s.match(/^https?:\/\/[^/?#]+\/(?:[^?#]*\/)?ipfs\/([^/?#]+)\/?([^?#]*)/i)
    || s.match(/^https?:\/\/([a-z0-9]+)\.ipfs\.[^/?#]+\/?([^?#]*)/i); // <cid>.ipfs.host/path
  return m ? cleanCid(m[1], m[2]) : null;
}
export const ipfs = (u, g = 0) => { const c = cidPath(u); return c ? safeUrl((GATEWAYS[g] || GATEWAYS[0]) + c) : safeUrl(u); };
// an image URL a browser can load: IPFS through the first gateway (resized to w px), anything else over https (an
// http picture is blocked as mixed content on an https page, so ask for its https twin), except hosts that refuse other
// sites (gmgn.ai: 403 + Cross-Origin-Resource-Policy: same-origin)
const NO_HOTLINK = /(^|\.)gmgn\.ai$/i;
export function img(u, w = 128) {
  const c = cidPath(u); if (c) return safeUrl(GATEWAYS[0] + c + (w > 0 ? '?img-width=' + Math.min(2048, Math.round(w)) : ''));
  const s = safeUrl(u).replace(/^http:/, 'https:'); if (!s) return '';
  const url = new URL(s); if (NO_HOTLINK.test(url.host)) return '';
  if (w > 0 && url.hostname === 'cdn.dexscreener.com' && url.pathname.startsWith('/cms/images/')) {
    url.searchParams.set('width', String(Math.min(2048, Math.round(w)))); url.searchParams.set('height', String(Math.min(2048, Math.round(w))));
    url.searchParams.set('fit', 'crop'); url.searchParams.set('quality', '80'); url.searchParams.set('format', 'auto');
    return url.href;
  }
  return s;
}
export const imgFallback = (u) => { const c = cidPath(u); return c ? safeUrl(GATEWAYS[1] + c) : ''; };

// Keep the provider's original URL as well as resized IPFS variants. Some CIDs
// exist only on their publisher's gateway; a resize failure must not erase them.
export function imageSources(t, width = 160) {
  const sources = [];
  const add = (u) => { const s = safeUrl(u).replace(/^http:/, 'https:'); if (!s) return; const url = new URL(s); if (!url.username && !url.password && !NO_HOTLINK.test(url.hostname) && !sources.includes(s)) sources.push(s); };
  // A second provider's image is more useful than repeatedly resizing a failed
  // first provider. Try each primary variant before the slower raw gateways.
  for (const u of [t.imageOriginal, t.image, t.imageAlt]) if (u) add(img(u, width));
  for (const u of [t.imageOriginal, t.imageAlt, t.image]) {
    if (!u) continue;
    const c = cidPath(u);
    if (c) { add(u); add(GATEWAYS[0] + c); add(imgFallback(u)); }
    else add(u);
  }
  return sources;
}

const n = (x) => (x == null || x === '' || !isFinite(Number(x)) ? undefined : Number(x));
const str = (x, max) => (typeof x === 'string' && x ? x.slice(0, max) : undefined);
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
// LST yields as Jupiter lists them ({jupEarn: 3.9, ...} in % a year); undefined when there are none
const apyOf = (x) => { if (!x || typeof x !== 'object' || Array.isArray(x)) return undefined; const o = {}; for (const [k, v] of Object.entries(x)) if (/^[\w-]{1,32}$/.test(k) && n(v) != null) o[k] = n(v); return Object.keys(o).length ? o : undefined; };
const ms = (x) => { const t = Date.parse(x); return isFinite(t) ? t : undefined; };
const chunks = (a, size) => { const out = []; for (let i = 0; i < a.length; i += size) out.push(a.slice(i, i + size)); return out; };
const uniqMints = (a) => [...new Set((a || []).filter(isMint))];
// every adapter takes an optional last argument {prio: 'high'|'normal'|'low'} (see the transport notes above)
const prioOf = (o, d = 'normal') => (o && typeof o === 'object' && PRIO[o.prio] != null ? o.prio : d);
const tagCache = new Map();
const copies = (list) => list.map((t) => ({ ...t }));

// ---- Jupiter asset → store patch ----
function stats(s) {
  const z = (k) => n(s?.[k]) || 0;
  return { priceChange: z('priceChange'), buyVol: z('buyVolume'), sellVol: z('sellVolume'), vol: z('buyVolume') + z('sellVolume'), organicVol: z('buyOrganicVolume') + z('sellOrganicVolume'), buys: z('numBuys'), sells: z('numSells'), traders: z('numTraders'), netBuyers: z('numNetBuyers'), organicBuyers: z('numOrganicBuyers'), holderChange: z('holderChange'), liquidityChange: z('liquidityChange'), volumeChange: z('volumeChange') };
}
export function toToken(a, pool = null) {
  if (!a || !isMint(a.id)) return null;
  const au = a.audit || {}, s24 = stats(a.stats24h), grad = ms(a.graduatedAt);
  const t = {
    mint: a.id, name: typeof a.name === 'string' ? a.name.slice(0, 80) : undefined, symbol: typeof a.symbol === 'string' ? a.symbol.slice(0, 24) : undefined,
    image: img(a.icon) || undefined, imageOriginal: safeUrl(a.icon) || ipfs(a.icon) || undefined, decimals: n(a.decimals), tokenProgram: isMint(a.tokenProgram) ? a.tokenProgram : undefined, verified: a.isVerified === true, tags: Array.isArray(a.tags) ? a.tags.filter((x) => typeof x === 'string').slice(0, 30).map((x) => x.slice(0, 40)) : undefined,
    twitter: safeUrl(a.twitter) || undefined, telegram: safeUrl(a.telegram) || undefined, website: safeUrl(a.website) || undefined,
    xHandle: typeof a.primaryTwitter?.handle === 'string' ? a.primaryTwitter.handle.slice(0, 40) : undefined, xFollowers: n(a.primaryTwitter?.followerCount),
    dev: isMint(a.dev) ? a.dev : undefined, launchpad: str(a.launchpad, 40), metaLaunchpad: str(a.metaLaunchpad, 40),
    created: ms(a.firstPool?.createdAt) ?? ms(a.createdAt),
    price: n(a.usdPrice), mcUsd: n(a.mcap), fdvUsd: n(a.fdv), liquidity: n(a.liquidity) ?? n(pool?.liquidity), circSupply: n(a.circSupply), totalSupply: n(a.totalSupply), holders: n(a.holderCount),
    volume24h: a.stats24h ? s24.vol : n(pool?.volume24h), buys: a.stats24h ? s24.buys : undefined, sells: a.stats24h ? s24.sells : undefined,
    top10Pct: n(au.topHoldersPercentage), devPct: a.audit ? n(au.devBalancePercentage) || 0 : undefined, devMints: n(au.devMints), devMigrations: a.audit ? n(au.devMigrations) || 0 : undefined,
    sniperPct: n(au.sniperPct), insiderPct: n(au.insiderPct), botPct: n(au.botHoldersPercentage), sus: au.isSus === true || undefined,
    mintAuthDisabled: typeof au.mintAuthorityDisabled === 'boolean' ? au.mintAuthorityDisabled : undefined, freezeAuthDisabled: typeof au.freezeAuthorityDisabled === 'boolean' ? au.freezeAuthorityDisabled : undefined,
    organicScore: n(a.organicScore), organicLabel: str(a.organicScoreLabel, 16),
    fees: n(a.fees), dexPaid: a.dexPaidAt ? true : undefined, live: a.pumpLive ? true : undefined, mayhem: a.isMayhem === true || undefined, apy: apyOf(a.apy),
    stats5m: a.stats5m ? stats(a.stats5m) : undefined, stats1h: a.stats1h ? stats(a.stats1h) : undefined, stats6h: a.stats6h ? stats(a.stats6h) : undefined, stats24h: a.stats24h ? s24 : undefined,
  };
  if (grad) Object.assign(t, { migrated: true, migratedAt: grad, progress: 1, gradPool: isMint(a.graduatedPool) ? a.graduatedPool : undefined });
  if (pool) {
    Object.assign(t, { pool: isMint(pool.id) ? pool.id : undefined, poolType: str(pool.type, 40), poolCreated: ms(pool.createdAt) });
    if (!grad && n(pool.bondingCurve) != null) t.progress = Math.max(0, Math.min(1, n(pool.bondingCurve) / 100));
  }
  return t;
}
const tokensOf = (list, what) => arr(list, what).map((a) => toToken(a)).filter(Boolean);

// ---- JT: tokens ----
export const jt = {
  // text search (≤20 results), or exact lookups for many mints at once (comma lists of 50 per call)
  async search(q, opts) {
    const prio = prioOf(opts);
    if (Array.isArray(q)) {
      const out = [];
      for (const c of chunks(uniqMints(q), 50)) out.push(...tokensOf(await jup('/tokens/v2/search?query=' + c.join(','), { prio }), 'token search'));
      return out;
    }
    q = String(q || '').trim(); if (!q) return [];
    return tokensOf(await jup('/tokens/v2/search?query=' + encodeURIComponent(q), { prio }), 'token search');
  },
  recent: async (opts) => tokensOf(await jup('/tokens/v2/recent', { prio: prioOf(opts, 'low') }), 'recent tokens'),
  async top(kind = 'toptrending', iv = '1h', limit = 100, opts) {
    if (!['toptrending', 'toporganicscore', 'toptraded'].includes(kind) || !INTERVALS.includes(iv)) throw new Error('Unknown list or interval');
    return tokensOf(await jup(`/tokens/v2/${kind}/${iv}?limit=${Math.min(100, Math.max(1, limit | 0))}`, { prio: prioOf(opts) }), kind);
  },
  // every token with a Jupiter tag: 'lst' (liquid staking tokens, ~165) or 'verified' (~3,900). Cached 1 hour per tag.
  // LSTs can carry apy ({source: % per year}, often empty).
  tag(tag = 'lst', opts) {
    tag = String(tag || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{1,32}$/.test(tag)) return Promise.reject(new Error('Unknown token tag'));
    const hit = tagCache.get(tag);
    if (!hit || Date.now() - hit.at > 3600e3) {
      const p = jup('/tokens/v2/tag?query=' + tag, { prio: prioOf(opts), timeout: 20000 }).then((j) => tokensOf(j, 'tag ' + tag));
      tagCache.set(tag, { at: Date.now(), p }); p.catch(() => { if (tagCache.get(tag)?.p === p) tagCache.delete(tag); });
      return p.then(copies);
    }
    return hit.p.then(copies);
  },
};

// ---- JP: prices ----
export const jp = {
  async prices(mints, opts) {
    const out = new Map(), prio = prioOf(opts);
    for (const c of chunks(uniqMints(mints), 50)) {
      const j = obj(await jup('/price/v3?ids=' + c.join(','), { prio }), 'prices');
      for (const [m, p] of Object.entries(j)) if (n(p?.usdPrice) > 0) out.set(m, { price: n(p.usdPrice), change24h: n(p.priceChange24h), liquidity: n(p.liquidity), decimals: n(p.decimals), launchpad: str(p.launchpad, 40), created: ms(p.createdAt) });
    }
    return out;
  },
};

// ---- JU: wallet balances, holdings, warnings ----
const decOf = (raw, ui) => (Number(raw) > 0 && ui > 0 ? Math.round(Math.log10(Number(raw) / ui)) : undefined);
export const ju = {
  async balances(w, opts) {
    if (!isMint(w)) throw new Error('Not a wallet address');
    const j = obj(await jup('/ultra/v1/balances/' + w, { prio: prioOf(opts) }), 'balances'), tokens = {};
    for (const [m, b] of Object.entries(j)) if (m !== 'SOL' && isMint(m) && b?.amount != null) tokens[m] = { raw: String(b.amount), ui: n(b.uiAmount) || 0, dec: decOf(b.amount, n(b.uiAmount)), frozen: !!b.isFrozen };
    return { sol: n(j.SOL?.uiAmount) || 0, lamports: String(j.SOL?.amount ?? '0'), tokens };
  },
  async holdings(w, opts) {
    if (!isMint(w)) throw new Error('Not a wallet address');
    const j = obj(await jup('/ultra/v1/holdings/' + w, { prio: prioOf(opts) }), 'holdings'), tokens = {};
    for (const [m, accs] of Object.entries(obj(j.tokens || {}, 'holdings'))) {
      if (!isMint(m) || !Array.isArray(accs)) continue;
      let raw = 0n; for (const a of accs) { try { raw += BigInt(a.amount || 0); } catch { /* skip */ } }
      const d0 = n(accs[0]?.decimals), dec = Number.isInteger(d0) && d0 >= 0 && d0 <= 19 ? d0 : 0, prog = accs[0]?.programId;
      tokens[m] = { raw: raw.toString(), ui: Number(raw) / 10 ** dec, dec, frozen: accs.some((a) => a.isFrozen), program: TOKEN_PROGRAMS.includes(prog) ? prog : undefined, accounts: accs.length,
        tokenAccounts: accs.filter((a) => isMint(a.account) && TOKEN_PROGRAMS.includes(a.programId) && /^\d+$/.test(String(a.amount))).map((a) => ({ account: a.account, programId: a.programId, amount: String(a.amount), isFrozen: !!a.isFrozen })) };
    }
    return { sol: n(j.uiAmount) || 0, lamports: String(j.amount ?? '0'), tokens };
  },
  async shield(mints, opts) {
    const out = {}, prio = prioOf(opts);
    for (const c of chunks(uniqMints(mints), 50)) {
      const w = obj(obj(await jup('/ultra/v1/shield?mints=' + c.join(','), { prio }), 'shield').warnings || {}, 'shield');
      for (const [m, list] of Object.entries(w)) out[m] = (Array.isArray(list) ? list : []).map((x) => ({ type: String(x?.type || ''), message: String(x?.message || ''), severity: String(x?.severity || 'info') }));
    }
    return out;
  },
};

// ---- JG: the three Pulse lists. Each column body is optional; fields JG understands (all verified):
//   timeframe ('24h'), launchpads [..LAUNCHPADS], min|max: Mcap, Liquidity, Volume24h, Volume5m, Volume1h, Volume6h,
//   HolderCount, OrganicScore, TopHoldersPercentage, BondingCurve (%), TokenAge (minutes), Fees, SniperPct,
//   BotHoldersPercentage, BotHoldersCount; maxDevBalancePct, minDevMigrations, maxDevMigrations, minInsiderPct,
//   maxInsiderPct, maxBundlerPct; booleans hasSocials, mintAuthorityDisabled, freezeAuthorityDisabled, isMayhem.
//   Each column returns at most 30 pools. An unknown launchpad returns an empty column (no error).
export const jg = {
  async gems(body = { recent: {}, aboutToGraduate: {}, graduated: {} }, opts) {
    const j = obj(await data('/v1/pools/gems', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { prio: prioOf(opts, 'low'), timeout: 12000 }), 'gems');
    const col = (k) => (body[k] ? arr(obj(j[k], 'gems ' + k).pools, 'gems ' + k).map((p) => toToken(p?.baseAsset, p)).filter(Boolean) : []);
    return { recent: col('recent'), aboutToGraduate: col('aboutToGraduate'), graduated: col('graduated') };
  },
};

// ---- JX: trades (complete history, newest first, 30 a page) ----
export const jx = {
  async txs(mint, opts) {
    if (!isMint(mint)) throw new Error('Not a token address');
    const { trader, offset } = opts && typeof opts === 'object' ? opts : {};
    const q = new URLSearchParams(); if (isMint(trader)) q.set('traderAddress', trader); if (offset) q.set('offset', String(offset));
    const j = obj(await data(`/v1/txs/${mint}${String(q) ? '?' + q : ''}`, {}, { prio: prioOf(opts) }), 'trades');
    const txs = arr(j.txs, 'trades').filter((x) => x && SIG_RE.test(x.txHash) && isMint(x.traderAddress) && (!x.asset || x.asset === mint)).map((x) => ({
      id: String(x.actionId || x.txHash).slice(0, 120), sig: x.txHash, mint, side: x.type === 'sell' ? 'sell' : 'buy', wallet: x.traderAddress,
      tokens: n(x.amount) || 0, sol: n(x.nativeVolume) || 0, usd: n(x.usdVolume) || 0, priceUsd: n(x.usdPrice) || 0, at: ms(x.timestamp) || 0,
      pool: isMint(x.poolId) ? x.poolId : undefined, mev: !!x.isMev, tags: Array.isArray(x.holderTags) ? x.holderTags.filter((s) => typeof s === 'string').slice(0, 10) : [],
    }));
    return { txs, next: j.next ? String(j.next) : null };
  },
};

// ---- JH: top 100 holders with owners resolved ----
export const jh = {
  async holders(mint, opts) {
    if (!isMint(mint)) throw new Error('Not a token address');
    const j = obj(await data('/v1/holders/' + mint, {}, { prio: prioOf(opts) }), 'holders');
    return {
      count: n(j.count) || 0,
      holders: arr(j.holders, 'holders').filter((h) => isMint(h?.address)).map((h) => ({
        wallet: h.address, amount: n(h.amount) || 0, sol: n(h.solBalanceDisplay) ?? (n(h.solBalance) || 0) / 1e9,
        tags: Array.isArray(h.holderTags) ? h.holderTags.filter((s) => typeof s === 'string') : [],
        labels: Array.isArray(h.tags) ? h.tags.map((x) => ({ id: String(x?.id || ''), name: String(x?.name || '') })) : [],
        funding: isMint(h.addressInfo?.fundingAddress) ? { from: h.addressInfo.fundingAddress, amount: n(h.addressInfo.fundingAmount) || 0, tx: SIG_RE.test(h.addressInfo.fundingTx) ? h.addressInfo.fundingTx : undefined, at: ms(h.addressInfo.fundingBlockTime), slot: n(h.addressInfo.fundingSlot) } : null,
      })),
    };
  },
};

// ---- JC: candles by mint (bonding curve and migrated pool in one series). `to` is ms and exclusive: page back with
// to = oldest.time * 1000. type 'price' | 'mcap', quote 'usd' | 'native' (SOL). At most 7000 candles.
export const jc = {
  async chart(mint, { interval = '1_MINUTE', to = Date.now(), candles = 300, type = 'mcap', quote = 'usd', prio } = {}) {
    if (!isMint(mint)) throw new Error('Not a token address');
    if (!CHART_INTERVALS.includes(interval) || !['price', 'mcap'].includes(type) || !['usd', 'native'].includes(quote)) throw new Error('Unknown chart option');
    const q = new URLSearchParams({ interval, to: String(Math.round(to)), candles: String(Math.min(7000, Math.max(1, candles | 0))), type, quote });
    const j = obj(await data(`/v2/charts/${mint}?${q}`, {}, { prio: prioOf({ prio }) }), 'chart');
    return arr(j.candles, 'chart').filter((c) => n(c?.time) && n(c.close) != null).map((c) => ({ time: n(c.time), open: n(c.open), high: n(c.high), low: n(c.low), close: n(c.close), volume: n(c.volume) || 0 }));
  },
};

// ---- DS: Dexscreener ----
const best = (pairs, mint) => pairs.filter((p) => p?.baseToken?.address === mint).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
const promo = (list) => arr(list, 'Dexscreener').filter((x) => x?.chainId === 'solana' && isMint(x.tokenAddress)).map((x) => ({
  mint: x.tokenAddress, url: safeUrl(x.url), header: img(x.header, 0), description: typeof x.description === 'string' ? x.description.slice(0, 400) : '',
  // boosts send an image id, profiles a full URL
  icon: img(x.icon, 0) || (/^[\w-]{6,40}$/.test(x.icon || '') ? `https://cdn.dexscreener.com/cms/images/${x.icon}?width=64&height=64&fit=crop&quality=95&format=auto` : ''),
  links: Array.isArray(x.links) ? x.links.map((l) => ({ type: String(l?.type || ''), label: String(l?.label || ''), url: safeUrl(l?.url) })).filter((l) => l.url) : [],
  amount: n(x.amount), total: n(x.totalAmount),
}));
const orderCache = new Map();
export const ds = {
  // best pair (most liquidity) per mint, 30 mints per call
  async tokens(mints, opts) {
    const out = new Map(), prio = prioOf(opts);
    for (const c of chunks(uniqMints(mints), 30)) {
      const pairs = arr(await dsGet('/tokens/v1/solana/' + c.join(','), { prio }), 'Dexscreener tokens');
      for (const m of c) { const p = best(pairs, m); if (p) out.set(m, p); }
    }
    return out;
  },
  pairs: async (mint, opts) => arr(await dsGet('/token-pairs/v1/solana/' + mint, { prio: prioOf(opts) }), 'Dexscreener pairs').filter((p) => p?.baseToken?.address),
  search: async (q, opts) => arr(obj(await dsGet('/latest/dex/search?q=' + encodeURIComponent(String(q || '').trim()), { prio: prioOf(opts) }), 'Dexscreener search').pairs || [], 'Dexscreener search').filter((p) => p?.chainId === 'solana' && isMint(p.baseToken?.address)),
  boosts: async (kind = 'top', opts) => promo(await dsGet(`/token-boosts/${kind === 'latest' ? 'latest' : 'top'}/v1`, { prio: prioOf(opts) })),
  profiles: async (opts) => promo(await dsGet('/token-profiles/latest/v1', { prio: prioOf(opts) })),
  ctos: async (opts) => promo(await dsGet('/community-takeovers/latest/v1', { prio: prioOf(opts) })),
  // "Dex paid": any approved order (profile, ad, ...). Cached 10 minutes, at most one call a second.
  async orders(mint, opts) {
    if (!isMint(mint)) throw new Error('Not a token address');
    const hit = orderCache.get(mint); if (hit && Date.now() - hit.at < 600e3) return hit.v;
    const j = await dsGet('/orders/v1/solana/' + mint, { prio: prioOf(opts), key: 'ds-orders' });
    const list = Array.isArray(j) ? j : arr(obj(j, 'Dexscreener orders').orders || [], 'Dexscreener orders');
    const orders = list.map((o) => ({ type: String(o?.type || ''), status: String(o?.status || ''), at: n(o?.paymentTimestamp) }));
    const v = { paid: orders.some((o) => o.status === 'approved'), orders, boosts: Array.isArray(j?.boosts) ? j.boosts : [] };
    orderCache.set(mint, { at: Date.now(), v });
    return v;
  },
};
