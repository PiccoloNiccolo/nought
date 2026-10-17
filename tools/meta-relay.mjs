// Optional metadata relay. Many launch tools host token metadata on servers that refuse browsers (no CORS header:
// metadata.j7tracker.io, used by coins launched with J7Tracker), and IPFS files that pump.fun's gateway has not pinned take
// 4-7 s through the one public gateway that allows browsers. A server has neither problem. This relay reads one
// metadata document and returns only the display fields Nought uses, so it is not a general-purpose proxy:
//   GET /meta?url=<https or ipfs URL>  →  {image, name, symbol, description, twitter, telegram, website}
//   GET /who?w=<wallet>,…              →  pump.fun profiles people set up themselves: {<wallet>: {name, x, pfp}}
// It also watches PumpPortal launches and reads each coin's metadata as it appears, so a browser's request is
// usually answered from memory. No keys or accounts. Run locally with `node tools/meta-relay.mjs [port]` and
// enter http://127.0.0.1:port in Settings → Metadata relay; on a host, PORT is read from the environment
// (WATCH_LAUNCHES=0 turns the watcher off). Any Node 22+ host can serve it.
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const MAX_BYTES = 64 * 1024, TIMEOUT = 4000, TTL = 10 * 60 * 1000, CACHE_MAX = 2000;
const FIELDS = ['image', 'name', 'symbol', 'description', 'twitter', 'telegram', 'website'];
const CID_RE = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120})$/;
const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/', 'https://pump.mypinata.cloud/ipfs/'];
const cache = new Map();

// "<cid>/path" for ipfs:// and gateway URLs, else null
function cidPath(u) {
  const m = u.match(/^ipfs:\/\/(?:ipfs\/)?([^/?#]+)\/?([^?#]*)/i) || u.match(/^https:\/\/[^/?#]+\/(?:[^?#]*\/)?ipfs\/([^/?#]+)\/?([^?#]*)/i);
  if (!m || !CID_RE.test(m[1]) || /(^|\/)\.\.?(\/|$)/.test(m[2])) return null;
  return m[2] ? `${m[1]}/${m[2]}` : m[1];
}
// Only public https hosts on the default port: no internal addresses, credentials or odd ports.
const PRIVATE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:/i];
async function publicHttps(u) {
  let url; try { url = new URL(u); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(host)) return false;
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  return addrs.length > 0 && !addrs.some((a) => PRIVATE.some((re) => re.test(a)));
}
async function getJson(u, signal) {
  if (!(await publicHttps(u))) throw new Error('blocked');
  const r = await fetch(u, { signal, redirect: 'error', headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(String(r.status));
  if (Number(r.headers.get('content-length')) > MAX_BYTES) throw new Error('too large');
  const reader = r.body.getReader(), parts = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error('too large'); } parts.push(value); }
  const j = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not an object');
  return j;
}
const pick = (j) => Object.fromEntries(FIELDS.filter((k) => typeof j[k] === 'string').map((k) => [k, j[k].slice(0, k === 'description' ? 400 : 2048)]));

// One document: IPFS races every gateway, anything else is fetched directly. Resolves the picked fields or throws.
// Lookups of the same document share one request (the launch watcher and browsers usually ask at the same moment).
const inflight = new Map();
export function readMeta(raw) {
  const u = String(raw || '').trim();
  if (!u || u.length > 1000) return Promise.reject(new Error('bad url'));
  const hit = cache.get(u); if (hit && hit.until > Date.now()) return Promise.resolve(hit.value);
  let p = inflight.get(u);
  if (!p) { p = fetchMeta(u).finally(() => inflight.delete(u)); inflight.set(u, p); }
  return p;
}
async function fetchMeta(u) {
  const cid = cidPath(u), urls = cid ? GATEWAYS.map((g) => g + cid) : [u];
  if (!cid && !(await publicHttps(u))) throw new Error('blocked');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const value = pick(await Promise.any(urls.map((x) => getJson(x, controller.signal))));
    cache.set(u, { value, until: Date.now() + TTL });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  } finally { clearTimeout(timer); controller.abort(); }
}
export async function handleMeta(reqUrl) {
  const q = new URL(reqUrl, 'http://relay').searchParams.get('url');
  try { return { status: 200, body: await readMeta(q) }; }
  catch (e) { return { status: /bad url|blocked/.test(e?.message) ? 400 : 502, body: { error: 'unavailable' } }; }
}

// ---- pump.fun profiles: GET /who?w=<address>,<address>… (up to 20) → {<address>: {name, x, pfp}} ----
// pump.fun's profile API refuses other sites' browsers but answers servers. Only profiles a person set up themselves
// count (an X account, a picture or a chosen username); pump.fun's automatic names ("fineotter16558") are left out.
const WALLET = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, who = new Map(), WHO_TTL = 24 * 3600 * 1000, WHO_MAX = 20000;
const PFP_HOSTS = /^https:\/\/(?:[a-z0-9-]+\.)*(?:pump\.fun|pinata\.cloud|ipfs\.io|cloudfront\.net|twimg\.com)\//i;
export function pickProfile(j) {
  if (!j || typeof j !== 'object' || j.is_banned) return null;
  const x = typeof j.x_username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(j.x_username) ? j.x_username : '';
  const pfp = typeof j.profile_image === 'string' && PFP_HOSTS.test(j.profile_image) && j.profile_image.length < 400 ? j.profile_image : '';
  const chosen = j.last_username_update_timestamp != null && typeof j.username === 'string' ? j.username.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 30) : '';
  return x || pfp || chosen ? { name: chosen || x, x, pfp } : null;
}
// → the profile, null when pump.fun has none, undefined when pump.fun could not be asked (not cached, not reported)
async function profileOf(w, fetchImpl = fetch) {
  const hit = who.get(w); if (hit && hit.until > Date.now()) return hit.value;
  let value = null;
  try {
    const r = await fetchImpl(`https://frontend-api-v3.pump.fun/users/${w}`, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json' } });
    if (r.ok) value = pickProfile(await r.json());
    else if (r.status !== 404) return undefined;
  } catch { return undefined; }
  who.set(w, { value, until: Date.now() + WHO_TTL });
  if (who.size > WHO_MAX) who.delete(who.keys().next().value);
  return value;
}
export async function handleWho(reqUrl, fetchImpl) {
  const ws = [...new Set(String(new URL(reqUrl, 'http://relay').searchParams.get('w') || '').split(','))].filter((w) => WALLET.test(w)).slice(0, 20);
  if (!ws.length) return { status: 400, body: { error: 'bad wallets' } };
  // wallet → profile, or null when pump.fun has none; wallets pump.fun could not answer are left out, so callers ask again
  const out = {}, queue = [...ws];
  await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) { const w = queue.shift(); const p = await profileOf(w, fetchImpl); if (p !== undefined) out[w] = p; } }));
  return { status: 200, body: out };
}

// ---- pump.fun app callouts: GET /callouts?mint=<mint> → {callouts: [{id, wallet, at, mc, multiple, max, likes, note,
// name, x, pfp}]} — the coin's top callouts from pump.fun's app (which refuses other sites' browsers), each with the
// caller's pump.fun profile when they set one up. Cached 30 s per coin.
const calloutCache = new Map();
export async function handleCallouts(reqUrl, fetchImpl = fetch) {
  const mint = String(new URL(reqUrl, 'http://relay').searchParams.get('mint') || '');
  if (!WALLET.test(mint)) return { status: 400, body: { error: 'bad mint' } };
  const hit = calloutCache.get(mint); if (hit && hit.until > Date.now()) return { status: 200, body: hit.body };
  let list;
  try {
    const r = await fetchImpl(`https://frontend-api-v3.pump.fun/callout/coin/${mint}`, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json' } });
    if (!r.ok) return { status: 502, body: { error: 'unavailable' } };
    list = (await r.json())?.callouts;
  } catch { return { status: 502, body: { error: 'unavailable' } }; }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const rows = (Array.isArray(list) ? list : []).filter((c) => c && c.coinMint === mint && WALLET.test(c.userId || '') && num(c.createdAt)).slice(0, 50).map((c) => ({
    id: String(c.calloutId || '').slice(0, 64), wallet: c.userId, at: c.createdAt, mc: num(c.marketCap), multiple: num(c.multiple), max: num(c.maxMultiplier), likes: num(c.likes) || 0,
    note: typeof c.thesis === 'string' ? c.thesis.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 280) : '',
  }));
  const queue = [...new Set(rows.map((c) => c.wallet))], prof = new Map();
  await Promise.all(Array.from({ length: 5 }, async () => { while (queue.length) { const w = queue.shift(); const p = await profileOf(w, fetchImpl); if (p) prof.set(w, p); } }));
  const body = { callouts: rows.map((c) => ({ ...c, ...(prof.get(c.wallet) || {}) })) };
  calloutCache.set(mint, { body, until: Date.now() + 30000 });
  if (calloutCache.size > 2000) calloutCache.delete(calloutCache.keys().next().value);
  return { status: 200, body };
}

// ---- a creator's coins: GET /created?w=<wallet> → {count, coins: [{mint, name, symbol, at, done}]} — the 50 newest coins
// the wallet launched on pump.fun, from pump.fun's app (which refuses other sites' browsers). Cached 60 s per wallet.
const createdCache = new Map();
export async function handleCreated(reqUrl, fetchImpl = fetch) {
  const w = String(new URL(reqUrl, 'http://relay').searchParams.get('w') || '');
  if (!WALLET.test(w)) return { status: 400, body: { error: 'bad wallet' } };
  const hit = createdCache.get(w); if (hit && hit.until > Date.now()) return { status: 200, body: hit.body };
  let j;
  try {
    const r = await fetchImpl(`https://frontend-api-v3.pump.fun/coins-v2/user-created-coins/${w}?limit=50&offset=0`, { signal: AbortSignal.timeout(TIMEOUT), headers: { accept: 'application/json' } });
    if (!r.ok) return { status: 502, body: { error: 'unavailable' } };
    j = await r.json();
  } catch { return { status: 502, body: { error: 'unavailable' } }; }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const txt = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
  const coins = (Array.isArray(j?.coins) ? j.coins : []).filter((c) => c && WALLET.test(c.mint || '') && c.creator === w && !c.hidden).slice(0, 50)
    .map((c) => ({ mint: c.mint, name: txt(c.name, 60), symbol: txt(c.symbol, 24), at: num(c.created_timestamp), done: c.complete === true }));
  const body = { count: num(j?.count) ?? coins.length, coins };
  createdCache.set(w, { body, until: Date.now() + 60000 });
  if (createdCache.size > 2000) createdCache.delete(createdCache.keys().next().value);
  return { status: 200, body };
}

// ---- launch watcher: read each new coin's metadata the moment PumpPortal announces it ----
let stats = { launches: 0, warmed: 0, since: Date.now() };
export function watchLaunches(url = 'wss://pumpportal.fun/api/data') {
  let ws, backoff = 1000;
  const connect = () => {
    try { ws = new WebSocket(url); } catch { setTimeout(connect, backoff); return; }
    ws.onopen = () => { backoff = 1000; ws.send(JSON.stringify({ method: 'subscribeNewToken' })); };
    ws.onmessage = (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (d?.txType !== 'create' || typeof d.uri !== 'string' || !d.uri) return;
      stats.launches++;
      readMeta(d.uri).then(() => { stats.warmed++; }, () => {});
    };
    ws.onclose = () => { setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2); };
    ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };
  };
  connect();
}

// ---- per-visitor limit: 40 lookups in any 10 s window (a busy Pulse board asks ~2-4 a second) ----
const visits = new Map();
function allowed(ip, now = Date.now()) {
  const v = (visits.get(ip) || []).filter((t) => now - t < 10000);
  if (v.length >= 40) { visits.set(ip, v); return false; }
  v.push(now); visits.set(ip, v);
  if (visits.size > 20000) visits.delete(visits.keys().next().value);
  return true;
}
// /who has its own budget (a token page asks a few batches at once), separate from metadata lookups
const whoVisits = new Map();
function allowedWho(ip, now = Date.now()) {
  const v = (whoVisits.get(ip) || []).filter((t) => now - t < 10000);
  if (v.length >= 20) { whoVisits.set(ip, v); return false; }
  v.push(now); whoVisits.set(ip, v);
  if (whoVisits.size > 20000) whoVisits.delete(whoVisits.keys().next().value);
  return true;
}
export function createRelay() {
  return createServer(async (req, res) => {
    const base = { 'access-control-allow-origin': '*', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...base, 'access-control-allow-methods': 'GET' }).end(); return; }
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) { res.writeHead(200, { ...base, 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, cached: cache.size, ...stats })); return; }
    if (req.method !== 'GET' || !(req.url.startsWith('/meta?') || req.url.startsWith('/who?') || req.url.startsWith('/callouts?') || req.url.startsWith('/created?'))) { res.writeHead(404, base).end('{"error":"not found"}'); return; }
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!(req.url.startsWith('/who?') || req.url.startsWith('/callouts?') || req.url.startsWith('/created?') ? allowedWho(ip) : allowed(ip))) { res.writeHead(429, { ...base, 'retry-after': '5', 'cache-control': 'no-store' }).end('{"error":"slow down"}'); return; }
    const { status, body } = req.url.startsWith('/who?') ? await handleWho(req.url) : req.url.startsWith('/callouts?') ? await handleCallouts(req.url) : req.url.startsWith('/created?') ? await handleCreated(req.url) : await handleMeta(req.url);
    // only real answers are cacheable: "not available yet" must be asked again
    res.writeHead(status, { ...base, 'cache-control': status !== 200 ? 'no-store' : req.url.startsWith('/created?') ? 'public, max-age=60' : 'public, max-age=600' }).end(JSON.stringify(body));
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Railway (or any host) sets PORT; locally `node tools/meta-relay.mjs 3320` listens on this computer only
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 3320, host = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
  createRelay().listen(port, host, () => console.log(`Metadata relay on http://${host}:${port}/meta?url=`));
  if (process.env.WATCH_LAUNCHES !== '0') watchLaunches();
}
