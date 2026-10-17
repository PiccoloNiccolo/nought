// pump.fun's image CDN has a launch's picture 1-3.5 s after the coin appears on the stream (pump and Bonk launches,
// whatever host the metadata uses; measured 2026-10-17). Until then it redirects to a generic placeholder that an <img>
// cannot tell apart, so readiness is checked with fetch: a real picture is a CORS 200, the placeholder an opaque
// redirect. New coins are polled every 150 ms for 20 s; coins already older than two minutes get one probe. A ready
// picture's bytes go straight into the image cache, so showing it needs no second download.
export const PUMP_CDN = 'https://d39w9554j5ohjb.cloudfront.net/coin-image/';
export const pumpCdnUrl = (mint, size = 128) => `${PUMP_CDN}${mint}?variant=${size > 128 ? '256x256' : '128x128'}`;
const MAX_BYTES = 400 * 1024, IMAGE = /^image\/(?:png|jpeg|webp|gif|avif)(?:;|$)/i;

export class PumpImages {
  constructor({ fetch, cache, onReady, readData, now = Date.now, later = (fn, ms) => setTimeout(fn, ms), every = 150, window = 20000, oldAfter = 120000, limit = 6, max = 40 }) {
    Object.assign(this, { fetch, cache, onReady, readData, now, later, every, window, oldAfter, limit, max });
    this.pending = new Map(); this.done = new Map(); this.active = 0; this.timer = 0;
  }
  // created: the coin's launch time (ms) when known
  watch(mint, created) {
    if (!mint || this.pending.has(mint) || (this.done.get(mint) || 0) > this.now()) return;
    const now = this.now(), fresh = !(created > 0) || now - created < this.oldAfter;
    this.pending.set(mint, { url: pumpCdnUrl(mint), until: fresh ? now + this.window : now, next: now, busy: false });
    // Newest first: drop the oldest watch when a launch burst exceeds the bound.
    if (this.pending.size > this.max) { const old = this.pending.keys().next().value; this.pending.delete(old); }
    this.tick();
  }
  tick() {
    const now = this.now();
    for (const [mint, job] of [...this.pending].reverse()) {
      if (this.active >= this.limit) break;
      if (job.busy || job.next > now) continue;
      this.probe(mint, job).catch(() => { /* a listener's error must not stop polling */ });
    }
    if (this.pending.size && !this.timer) this.timer = this.later(() => { this.timer = 0; this.tick(); }, Math.max(25, this.every / 2));
  }
  async probe(mint, job) {
    job.busy = true; this.active++;
    let data = '';
    try {
      const r = await this.fetch(job.url, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (r?.type !== 'opaqueredirect' && r?.ok && IMAGE.test(r.headers.get('content-type') || '')) {
        const blob = await r.blob();
        data = blob.size <= MAX_BYTES ? await this.readData(blob) : job.url;
      }
    } catch { /* network trouble: same as not ready yet */ }
    this.active--; job.busy = false;
    if (this.pending.get(mint) !== job) return;
    if (data) {
      this.pending.delete(mint); this.done.set(mint, Infinity);
      if (data !== job.url) this.cache.put(job.url, data);
      this.onReady(mint, job.url);
    } else if (this.now() >= job.until) {
      this.pending.delete(mint); this.done.set(mint, this.now() + 600000); // not a pump.fun picture: ask again in 10 min
    } else job.next = this.now() + this.every;
    if (this.done.size > 3000) this.done.delete(this.done.keys().next().value);
    this.tick();
  }
}
