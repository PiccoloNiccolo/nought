// Coin details: names, pictures and socials. pump.fun coins carry a metadata file (usually IPFS) that gives the
// picture seconds before Jupiter lists the coin; Dexscreener fills gaps (socials, dex paid, migrated pools) in
// batches of 30. Call wantMeta(token) or wantDex(mint). IPFS links go through gateways that allow browsers: the
// helpers live in jup.js (so adapters can use them) and are re-exported here.
import { getJson, safeUrl } from './util.js';
import { tokens, upsert, changed } from './store.js';
import { ds, cidPath, ipfs, img, imgFallback, GATEWAYS } from './jup.js';
export { cidPath, ipfs, img, imgFallback, GATEWAYS };

// Queue by metadata document, not mint: burst launches often reuse the same CID.
const metaQ = [], jobs = new Map(), metaSeen = new Map(), failures = new Map(), activeHosts = new Map(), documents = new Map();
let busy = 0, dexBusy = false, saveTimer = 0;
const hidden = () => typeof document !== 'undefined' && document.hidden;
const keyOf = uri => { const url = ipfs(uri); try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? url : ''; } catch { return ''; } };
const hostOf = uri => { try { return new URL(keyOf(uri)).host; } catch { return ''; } };
const publicUrl = value => { if (typeof value !== 'string' || value.length > 2048) return ''; const s = safeUrl(value) || ipfs(value); try { const u = new URL(s); return !u.username && !u.password && ['https:', 'http:'].includes(u.protocol) ? s : ''; } catch { return ''; } };
const fields = m => ({ image: publicUrl(m.image), twitter: publicUrl(m.twitter), telegram: publicUrl(m.telegram), website: publicUrl(m.website), description: typeof m.description === 'string' ? m.description.slice(0, 400) : '' });
const CACHE_KEY = 'nought.metadata.v1';
try {
  const raw = localStorage.getItem(CACHE_KEY);
  const saved = raw && raw.length <= 131072 ? JSON.parse(raw) : [];
  if (Array.isArray(saved)) for (const row of saved.slice(-128)) {
    if (typeof row?.key === 'string' && row.key.length <= 2048 && keyOf(row.key) === row.key && row.until > Date.now() && row.until <= Date.now() + 86400000 && row.value && typeof row.value === 'object') documents.set(row.key, { value: fields(row.value), until: row.until });
  }
} catch { /* artwork cache is optional and contains no wallet data */ }
function saveDocuments() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = 0; const rows = []; let bytes = 2;
    for (const [key, entry] of [...documents].reverse()) {
      if (entry.until <= Date.now()) continue;
      const row = { key, ...entry }, size = JSON.stringify(row).length + 1;
      if (bytes + size > 131072 || rows.length >= 128) break;
      rows.unshift(row); bytes += size;
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(rows)); } catch { /* fall back to memory */ }
  }, 500);
}
function applyMetadata(t, m, key) {
  const current = tokens.get(t.mint);
  // A completed old lookup must not overwrite a newer URI or resurrect a removed coin.
  if (!current || keyOf(current.uri) !== key) return;
  upsert(t.mint, {
    image: current.image ? undefined : img(m.image) || undefined,
    imageOriginal: current.imageOriginal ? undefined : m.image || undefined,
    imageAlt: m.image || undefined,
    twitter: current.twitter ? undefined : m.twitter || undefined,
    telegram: current.telegram ? undefined : m.telegram || undefined,
    website: current.website ? undefined : m.website || undefined,
    description: current.description ? undefined : m.description || undefined,
  });
}
export function wantMeta(t, { priority = false } = {}) {
  const key = t?.uri && keyOf(t.uri); if (!key) return;
  const cached = documents.get(key);
  if (cached?.until > Date.now()) { applyMetadata(t, cached.value, key); return; }
  if (cached) documents.delete(key);
  const existing = jobs.get(key);
  if (existing) {
    existing.tokens.set(t.mint, t);
    if (existing.tokens.size > 240) existing.tokens.delete(existing.tokens.keys().next().value);
    if (priority) {
      existing.priority = true; existing.load?.promote();
      const index = metaQ.indexOf(existing); if (index > 0) metaQ.unshift(...metaQ.splice(index, 1));
      run();
    }
    return;
  }
  if ((metaSeen.get(key) || 0) > Date.now()) return;
  if (metaSeen.size > 5000) { metaSeen.clear(); failures.clear(); }
  const job = { key, uri: t.uri, tokens: new Map([[t.mint, t]]), priority, load: null };
  jobs.set(key, job); metaSeen.set(key, Infinity); priority ? metaQ.unshift(job) : metaQ.push(job);
  if (metaQ.length > 240) { const dropped = priority ? metaQ.pop() : metaQ.shift(); jobs.delete(dropped.key); metaSeen.delete(dropped.key); }
  run();
}
// Race an alternate after 250ms. Missing individual CIDs must not suspend an
// entire gateway. Respect actual 429s while keeping fresh launches moving.
const skipUntil = new Map();
function fetchMeta(uri) {
  const ipfsy = !!cidPath(uri), urls = [...new Set((ipfsy ? [ipfs(uri, 0), safeUrl(uri), ipfs(uri, 1)] : [safeUrl(uri)]).filter(Boolean))];
  let promote;
  const result = new Promise((resolve, reject) => {
    const tried = new Set(), running = new Set(); let settled = false, hedge = false, timer, retry, deadline;
    let error = new Error('Metadata unavailable');
    const finish = (value) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(retry); clearTimeout(deadline);
      for (const attempt of [...running]) { attempt.release(); attempt.controller.abort(); }
      value ? resolve(value) : reject(error);
      Promise.resolve().then(run);
    };
    const pump = () => {
      if (settled || running.size >= (hedge ? 2 : 1)) return;
      const remaining = urls.filter(u => !tried.has(u) && (skipUntil.get(new URL(u).host) || 0) <= Date.now());
      const url = remaining.find(u => (activeHosts.get(new URL(u).host) || 0) < 6);
      if (!url) {
        if (!remaining.length && !running.size) finish();
        else if (remaining.length) { clearTimeout(retry); retry = setTimeout(pump, 50); }
        return;
      }
      tried.add(url); const host = new URL(url).host, controller = new AbortController();
      activeHosts.set(host, (activeHosts.get(host) || 0) + 1);
      const attempt = { controller, ended: false, release() {
        if (attempt.ended) return; attempt.ended = true; clearTimeout(attempt.timer); running.delete(attempt);
        activeHosts.set(host, Math.max(0, (activeHosts.get(host) || 1) - 1));
      } };
      running.add(attempt);
      const failed = e => {
        if (settled || attempt.ended) return; error = e; attempt.release(); controller.abort();
        if (/^429/.test(e?.message)) skipUntil.set(host, Date.now() + 5000);
        hedge = true; pump();
      };
      attempt.timer = setTimeout(() => failed(new Error('Metadata timeout')), 2500);
      Promise.resolve().then(() => getJson(url, { signal: controller.signal, credentials: 'omit' }, 2500)).then(value => {
        if (settled || attempt.ended) return;
        if (!value || typeof value !== 'object' || Array.isArray(value)) { failed(new Error('Invalid token metadata')); return; }
        finish(value);
      }, failed);
      if (hedge) pump();
    };
    promote = () => { clearTimeout(timer); hedge = true; pump(); };
    timer = setTimeout(promote, 250);
    deadline = setTimeout(() => finish(), 5000);
    pump();
  });
  result.promote = promote;
  return result;
}
function run() {
  if (hidden()) return;
  while (busy < 6 && metaQ.length) {
    const index = metaQ.findIndex(job => (busy < 4 || job.priority) && (activeHosts.get(hostOf(job.uri)) || 0) < (job.priority ? 6 : 4));
    if (index < 0) break;
    const [job] = metaQ.splice(index, 1); busy++;
    job.load = fetchMeta(job.uri);
    if (job.priority) job.load.promote(); // visible coins race now, background work hedges after 250ms
    job.load.then(m => {
      const value = fields(m), ttl = value.image ? (cidPath(job.uri) ? 86400000 : 300000) : 5000;
      failures.delete(job.key); metaSeen.set(job.key, Date.now() + ttl);
      documents.delete(job.key); documents.set(job.key, { value, until: Date.now() + ttl });
      if (documents.size > 256) documents.delete(documents.keys().next().value);
      saveDocuments();
      for (const t of job.tokens.values()) applyMetadata(t, value, job.key);
    }).catch(() => {
      const attempts = failures.get(job.key) || 0; failures.set(job.key, attempts + 1);
      metaSeen.set(job.key, Date.now() + Math.min(30000, 2000 * (2 ** Math.min(attempts, 4))));
    }).finally(() => { jobs.delete(job.key); busy--; run(); });
  }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', run);

const dexQ = new Set();
export function wantDex(mint) { if (mint) dexQ.add(mint); if (dexQ.size > 240) dexQ.delete(dexQ.values().next().value); }
// fill what a Dexscreener pair knows into a token (never overwrites names, pictures or socials it already has)
export function applyPair(t, p) {
  if (!t || !p) return;
  const soc = (type) => safeUrl((p.info?.socials || []).find((s) => s.type === type)?.url) || undefined;
  const s = (x, max) => (typeof x === 'string' && x ? x.slice(0, max) : undefined);
  t.name ||= s(p.baseToken?.name, 80); t.symbol ||= s(p.baseToken?.symbol, 24);
  const picture = img(p.info?.imageUrl), original = safeUrl(p.info?.imageUrl) || ipfs(p.info?.imageUrl);
  t.image ||= picture || undefined;
  if (original && original !== t.image) t.imageAlt = original;
  t.twitter ||= soc('twitter'); t.telegram ||= soc('telegram'); t.website ||= safeUrl(p.info?.websites?.[0]?.url) || undefined;
  // a fresh USD market cap, unless Jupiter gave one in the last 30 s
  const mc = Number(p.marketCap || p.fdv);
  if (mc > 0 && !(t.mcUsdAt > Date.now() - 30e3)) { t.mcUsd = mc; t.mcUsdAt = Date.now(); }
  if (t.liquidity == null && Number(p.liquidity?.usd) > 0) t.liquidity = Number(p.liquidity.usd);
  if (p.info || p.boosts?.active) t.dexPaid = true; // an info block or active boosts means someone paid Dexscreener
  if (p.dexId && p.dexId !== 'pumpfun' && /pump$/.test(t.mint) && !t.migrated) { t.migrated = true; t.migratedAt ||= Date.parse(p.pairCreatedAt) || Date.now(); t.progress = 1; }
}
setInterval(async () => {
  if (hidden() || dexBusy || !dexQ.size) return;
  dexBusy = true;
  const batch = [...dexQ].slice(0, 30); batch.forEach((m) => dexQ.delete(m));
  try {
    for (const [m, p] of await ds.tokens(batch, { prio: 'low' })) { const t = tokens.get(m); if (t) { applyPair(t, p); t.pair = p; } }
    changed();
  } catch { batch.forEach((m) => wantDex(m)); }
  finally { dexBusy = false; }
}, 2500);
