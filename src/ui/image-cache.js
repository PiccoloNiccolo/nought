// Small raster thumbnails only. This cache is disposable and separate from wallets/settings.
const MAX_ITEM = 512 * 1024, MAX_BYTES = 8 * 1024 * 1024, MAX_ITEMS = 240, TTL = 86400000;
const raster = value => typeof value === 'string' && value.length <= MAX_ITEM && /^data:image\/(?:png|jpeg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/.test(value);
export class ImageCache {
  constructor({ storage = null, now = Date.now } = {}) {
    this.storage = storage; this.now = now; this.entries = new Map(); this.bytes = 0;
    this.ready = Promise.resolve().then(() => storage?.read()).then(rows => {
      for (const row of (Array.isArray(rows) ? rows : []).slice(-MAX_ITEMS).sort((a,b) => a.at - b.at)) {
        if (Number.isFinite(row?.at) && row.at <= this.now() && row.at > this.now() - TTL && raster(row.data) && !this.entries.has(row.url)) this.put(row.url, row.data, row.at, false);
      }
    }).catch(() => {});
  }
  get(url) {
    const entry = this.entries.get(url); if (!entry) return '';
    if (entry.at <= this.now() - TTL) { this.remove(url); return ''; }
    this.entries.delete(url); this.entries.set(url, entry); return entry.data;
  }
  put(url, data = url, at = this.now(), persist = true) {
    let source; try { source = new URL(url); } catch { return false; }
    if (source.protocol !== 'https:' || source.username || source.password || (data !== url && !raster(data))) return false;
    this.remove(url);
    const entry = { url, data, at, bytes: data.length * 2 }; this.entries.set(url, entry); this.bytes += entry.bytes;
    while (this.entries.size > MAX_ITEMS || this.bytes > MAX_BYTES) this.remove(this.entries.keys().next().value);
    if (persist && data !== url) this.save();
    return true;
  }
  remove(url) { const old = this.entries.get(url); if (old) { this.bytes -= old.bytes; this.entries.delete(url); } }
  save() {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = 0;
      const rows = [...this.entries.values()].filter(e => e.data !== e.url).map(({ url, data, at }) => ({ url, data, at }));
      Promise.resolve().then(() => this.storage.write(rows)).catch(() => {});
    }, 500);
  }
}

function disk() {
  if (typeof indexedDB === 'undefined') return null;
  let db;
  const ready = new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 100);
    let request; try { request = indexedDB.open('nought-thumbnails', 1); } catch { clearTimeout(timer); resolve(null); return; }
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'url' });
    request.onsuccess = () => { clearTimeout(timer); db = request.result; db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = request.onblocked = () => { clearTimeout(timer); resolve(null); };
  });
  return {
    async read() {
      const database = await ready; if (!database) return [];
      return new Promise(resolve => {
        const req = database.transaction('images').objectStore('images').getAll(undefined, MAX_ITEMS);
        req.onsuccess = () => resolve(req.result); req.onerror = () => resolve([]);
      });
    },
    async write(rows) {
      const database = db || await ready; if (!database) return;
      return new Promise(resolve => {
        const tx = database.transaction('images', 'readwrite'), store = tx.objectStore('images');
        // Merge with other Nought tabs before pruning this disposable cache.
        const current = store.getAll(undefined, MAX_ITEMS);
        current.onsuccess = () => {
          const combined = new Map(current.result.map(row => [row.url, row]));
          for (const row of rows) if (!combined.has(row.url) || combined.get(row.url).at < row.at) combined.set(row.url, row);
          const kept = [...combined.values()].filter(row => row.at > Date.now() - TTL && raster(row.data)).sort((a,b) => b.at - a.at);
          store.clear(); let bytes = 0, count = 0;
          for (const row of kept) { bytes += row.data.length * 2; if (++count > MAX_ITEMS || bytes > MAX_BYTES) break; store.put(row); }
        };
        tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
      });
    },
  };
}
export const imageCache = new ImageCache({ storage: disk() });

// These public thumbnail hosts allow CORS. Other publishers retain native image loading.
const CACHE_HOSTS = new Set(['pump.mypinata.cloud', 'images.pump.fun', 'cdn.dexscreener.com']);
export const fastImageHost = host => CACHE_HOSTS.has(host);
export function loadImage(url, success, failure) {
  let stopped = false, probe, controller;
  const native = (src = url, data = null) => {
    if (stopped) return;
    probe = new Image(); probe.decoding = 'async'; probe.referrerPolicy = 'no-referrer';
    probe.onload = () => {
      if (stopped) return;
      if (!probe.naturalWidth) { failure(); return; }
      imageCache.put(url, data || url); success(data || url);
    };
    probe.onerror = () => { if (!stopped) failure(); }; probe.src = src;
  };
  if (fastImageHost(new URL(url).hostname) && typeof FileReader !== 'undefined') {
    controller = new AbortController();
    (async () => {
      const response = await fetch(url, { signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) { if (!stopped) failure(); return; }
      if (!/^image\/(?:png|jpeg|webp|gif|avif)(?:;|$)/i.test(response.headers.get('content-type') || '') || Number(response.headers.get('content-length')) > MAX_ITEM / 1.4) { controller.abort(); native(); return; }
      // Bound streamed bodies too: an absent Content-Length must not make the cache unbounded.
      const reader = response.body.getReader(), parts = []; let bytes = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_ITEM / 1.4) { await reader.cancel(); native(); return; } parts.push(value); }
      if (stopped) return;
      const file = new FileReader(); file.onload = () => native(file.result, file.result); file.onerror = () => native();
      file.readAsDataURL(new Blob(parts, { type: response.headers.get('content-type').split(';')[0].toLowerCase() }));
    })().catch(() => { if (!stopped) native(); });
  } else native();
  return () => { stopped = true; controller?.abort(); if (probe) { probe.onload = null; probe.onerror = null; probe.removeAttribute('src'); } };
}
