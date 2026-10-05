// Visible rows get first access to the image budget; nearby rows warm the cache.
// Cached thumbnails bypass networking. A second host races a slow first one after 250ms.
import { esc, on } from '../core/util.js';
import { imageSources } from '../core/jup.js';
import { tokens } from '../core/store.js';
import { wantDex, wantMeta } from '../core/meta.js';
import { ImageQueue } from './image-queue.js';
import { imageCache, loadImage, fastImageHost } from './image-cache.js';

const states = new WeakMap(), enrichment = new Map(), hints = new Map(), elements = new Map(), incoming = new Map();
const TTL = 60000, HINT_KEY = 'nought.image-sources.v1'; let saveTimer = 0;
try {
  const saved = JSON.parse(localStorage.getItem(HINT_KEY) || '[]');
  if (Array.isArray(saved)) for (const entry of saved.slice(-250)) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1]?.url === 'string' && entry[1].at > Date.now() - 86400000) hints.set(entry[0], entry[1]);
} catch { /* optional image hints never block the page */ }
const remember = (map, key, value, max = 1200) => { map.set(key, value); if (map.size > max) map.delete(map.keys().next().value); };
function rememberSource(key, url) {
  remember(hints, key, { url, at: Date.now() }, 250);
  if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = 0; try { localStorage.setItem(HINT_KEY, JSON.stringify([...hints])); } catch { /* disposable hints */ } }, 1000);
}
const queue = new ImageQueue({ load: loadImage, limit: 16, hostLimit: host => fastImageHost(host) ? 8 : 4, backgroundPriority: 10000, reserve: 4, hostReserve: 2, hedge: 250 });
let restored = false;
function resumeImages() {
  restored = true;
  if (typeof document !== 'undefined') document.querySelectorAll('[data-token-image]').forEach(im => { if (states.get(im)?.near) start(im); });
}
Promise.race([imageCache.ready, new Promise(resolve => setTimeout(resolve, 30))]).then(resumeImages);
imageCache.ready.then(() => { if (restored) resumeImages(); });
const cachedSource = urls => { for (const url of urls) { const display = imageCache.get(url); if (display) return { url, display }; } return null; };
export const imageKey = (t) => JSON.stringify([t.imageOriginal, t.image, t.imageAlt]);
export function tokenImage(t, width = 128) {
  const urls = imageSources(t, width);
  // Assign saved rasters directly to the node in register(). Encoding them into
  // every price-update HTML string wastes parsing work and duplicates large data.
  return `<img class="token-image" alt="" decoding="async" referrerpolicy="no-referrer" data-token-image="${esc(t.mint || '')}" data-sources="${esc(JSON.stringify(urls))}" width="${width}" height="${width}">`;
}
function forgetIncoming(mint) {
  const entry = incoming.get(mint); if (!entry) return;
  clearTimeout(entry.timer); entry.request?.cancel(); incoming.delete(mint);
}
function warmIncoming(t) {
  const entry = incoming.get(t.mint); if (!entry || document.hidden) return;
  const urls = imageSources(t, 128), key = JSON.stringify(urls);
  if (!urls.length || entry.key === key) return;
  if (cachedSource(urls)) { forgetIncoming(t.mint); return; }
  entry.request?.cancel(); entry.key = key;
  entry.request = queue.request(key, urls, url => { rememberSource(key, url); forgetIncoming(t.mint); }, () => forgetIncoming(t.mint), 8000);
}
// Pulse calls this only for incoming coins that pass the visible column's filters.
// At most two speculative subscribers share the same bounded queue as displayed rows.
export function primeTokenImage(t) {
  if (!t?.mint || document.hidden || incoming.has(t.mint)) return;
  while (incoming.size >= 2) forgetIncoming(incoming.keys().next().value);
  incoming.set(t.mint, { request: null, key: '', timer: setTimeout(() => forgetIncoming(t.mint), 8000) });
  if (!imageSources(t, 128).length && t.uri) wantMeta(t, { priority: true });
  warmIncoming(t);
}
export function syncTokenImage(im, t) {
  if (!im) return;
  if (!states.has(im)) register(im);
  const s = states.get(im), urls = imageSources(t, Number(im.getAttribute?.('width')) || 128), key = JSON.stringify(urls);
  if (key === s.key) { if (!urls.length && s.near && t.uri) wantMeta(t, { priority: true }); return; }
  const previous = s.urls;
  s.urls = urls; s.key = key; im.dataset.sources = key; s.rounds = 0; s.metadataRounds = 0;
  if (im.dataset.loaded && urls.includes(im.dataset.imageSource)) return;
  // An added fallback must not restart a download already in progress.
  if (s.request && previous.length && previous.every(url => urls.includes(url))) return;
  s.request?.cancel(); s.request = null; delete im.dataset.loaded; delete im.dataset.failed;
  if (s.near) start(im);
}
function enrich(mint) {
  if (!mint || Date.now() - (enrichment.get(mint) || 0) < TTL) return;
  remember(enrichment, mint, Date.now()); wantDex(mint);
  const t = tokens.get(mint); if (t?.uri) wantMeta(t, { priority: true });
}
function priority(im) {
  if (im.closest?.('.hv-pop')) return -1000;
  const r = im.getBoundingClientRect();
  const list = im.closest?.('.pu-list')?.getBoundingClientRect();
  return (r.bottom <= Math.max(0, list?.top || 0) || r.top >= Math.min(innerHeight, list?.bottom || innerHeight) ? 10000 : 0) + Math.max(0, r.top);
}
function visible(im) {
  const r = im.getBoundingClientRect(), list = im.closest?.('.pu-list')?.getBoundingClientRect();
  return r.width > 0 && r.bottom > Math.max(0, list?.top || 0) && r.top < Math.min(innerHeight, list?.bottom || innerHeight);
}
function display(im, s, url, src, cached = false) {
  s.request?.cancel(); s.request = null; clearTimeout(s.enrichTimer);
  im.dataset.imageSource = url; im.dataset.imageCache = cached ? 'saved' : 'download'; im.src = src || url; im.dataset.loaded = 'true'; delete im.dataset.failed; observer?.unobserve(im);
}
function start(im) {
  const s = states.get(im); if (!s || im.dataset.loaded || !im.isConnected || document.hidden) return;
  const cached = cachedSource(s.urls);
  if (cached) { display(im, s, cached.url, cached.display, true); return; }
  if (s.request) { s.request.priority(priority(im)); return; }
  // Missing artwork should request metadata immediately, not sit in an image queue.
  if (!s.urls.length) { im.dataset.failed = 'true'; s.failedAt = Date.now(); s.rounds++; enrich(im.dataset.tokenImage); return; }
  if (!restored) return; // give the local thumbnail cache at most 30ms; storage never blocks networking
  const preferred = hints.get(s.key)?.url;
  const urls = preferred && s.urls.includes(preferred) ? [preferred, ...s.urls.filter(u => u !== preferred)] : s.urls;
  s.rounds++;
  const requestedKey = s.key;
  s.request = queue.request(requestedKey, urls, (url, src) => {
    s.request = null; if (!im.isConnected) return;
    rememberSource(s.key, url); display(im, s, url, src);
  }, () => {
    if (s.key !== requestedKey) { s.request = null; start(im); return; }
    s.request = null; im.dataset.failed = 'true'; s.failedAt = Date.now(); if (im.isConnected) enrich(im.dataset.tokenImage);
  }, priority(im));
  // Look up alternate metadata while a source is slow, in parallel with loading it.
  clearTimeout(s.enrichTimer); s.enrichTimer = setTimeout(() => { if (!im.dataset.loaded && im.isConnected) enrich(im.dataset.tokenImage); }, 800);
}
const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
  // Batch first, then the queue sorts across all columns by on-screen position.
  for (const e of entries) {
    const s = states.get(e.target); if (!s) continue; s.near = e.isIntersecting;
    if (e.isIntersecting) start(e.target);
    else { s.request?.cancel(); s.request = null; clearTimeout(s.enrichTimer); }
  }
}, { rootMargin: '180px' });
function register(im) {
  if (states.has(im)) return;
  let urls; try { urls = JSON.parse(im.dataset.sources); } catch { urls = []; }
  if (!Array.isArray(urls)) urls = [];
  const key = im.dataset.sources;
  const near = !observer || visible(im);
  states.set(im, { urls, key, rounds: 0, metadataRounds: 0, failedAt: 0, request: null, near, enrichTimer: 0 });
  const mint = im.dataset.tokenImage;
  if (!elements.has(mint)) elements.set(mint, new Set()); elements.get(mint).add(im);
  // A displayed source can still fail after its preload (e.g. a no-store origin).
  im.addEventListener('error', () => {
    delete im.dataset.loaded; hints.delete(key); const s = states.get(im), source = im.dataset.imageSource || im.src;
    imageCache.remove(source);
    // A corrupt local copy gets one fresh origin request; a failing origin moves to alternatives.
    if (!im.src.startsWith('data:')) s.urls = s.urls.filter(u => u !== source);
    start(im);
  });
  if (observer) observer.observe(im);
  if (near) start(im); // visible/cached artwork does not wait for the next observer frame
}
function scan(root) {
  if (root.matches?.('[data-token-image]')) register(root);
  root.querySelectorAll?.('[data-token-image]').forEach(register);
}
export function retryTokenImages(manual = true) {
  if (manual) { queue.clearFailures(); enrichment.clear(); }
  if (document.hidden) return;
  document.querySelectorAll('[data-token-image][data-failed]').forEach(im => {
    const s = states.get(im); if (!s || (!manual && (s.rounds >= 2 || Date.now() - s.failedAt < TTL))) return;
    const r = im.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight || !r.width) return;
    enrich(im.dataset.tokenImage); start(im);
  });
}
if (typeof document !== 'undefined') {
  on('token-artwork', t => {
    for (const im of elements.get(t.mint) || []) if (im.isConnected) syncTokenImage(im, t);
    warmIncoming(t);
  });
  on('route', () => { for (const mint of incoming.keys()) forgetIncoming(mint); });
  scan(document);
  new MutationObserver(records => {
    for (const record of records) {
      record.addedNodes.forEach(scan);
      for (const root of record.removedNodes) {
        const removed = [...(root.querySelectorAll?.('[data-token-image]') || [])];
        if (root.matches?.('[data-token-image]')) removed.push(root);
        for (const im of removed) if (!im.isConnected) {
          observer?.unobserve(im); const s = states.get(im); s?.request?.cancel(); if (s) { s.request = null; clearTimeout(s.enrichTimer); }
          const set = elements.get(im.dataset.tokenImage); set?.delete(im); if (!set?.size) elements.delete(im.dataset.tokenImage);
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const mint of incoming.keys()) forgetIncoming(mint);
    document.querySelectorAll('[data-token-image]').forEach(im => { const s = states.get(im); if (!s) return; if (document.hidden) { s.request?.cancel(); s.request = null; } else if (s.near) start(im); });
    if (!document.hidden) retryTokenImages(false);
  });
  // Entering the actual viewport doesn't always cross an overscan observer's
  // threshold. Promote newly visible requests once per scroll frame explicitly.
  let scrollFrame = 0;
  document.addEventListener('scroll', () => {
    if (scrollFrame || document.hidden) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      for (const set of elements.values()) for (const im of set) {
        const s = states.get(im); if (s?.request && im.isConnected) s.request.priority(priority(im));
      }
    });
  }, { capture: true, passive: true });
  setInterval(() => retryTokenImages(false), 15000);
  // Metadata often arrives just after the launch event. Give visible, imageless
  // coins a few early retries; the metadata queue enforces host limits/backoff.
  setInterval(() => {
    if (document.hidden) return;
    document.querySelectorAll('[data-token-image][data-failed]').forEach(im => {
      const s = states.get(im), token = tokens.get(im.dataset.tokenImage);
      if (!s || s.urls.length || s.metadataRounds >= 4 || !token?.uri) return;
      const r = im.getBoundingClientRect(); if (!r.width || r.bottom <= 0 || r.top >= innerHeight) return;
      s.metadataRounds++; wantMeta(token, { priority: true });
    });
  }, 2500);
}
