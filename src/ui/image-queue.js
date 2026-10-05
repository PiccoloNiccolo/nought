// Shared, bounded image races. One slow origin must not block the whole board.
export class ImageQueue {
  constructor({ load, limit = 12, perHost = 4, hostLimit = () => perHost, backgroundPriority = Infinity, reserve = 0, hostReserve = 0, hedge = 500, timeout = 3500, now = Date.now, later = (fn, ms) => setTimeout(fn, ms), cancelTimer = id => clearTimeout(id), defer = fn => queueMicrotask(fn) } = {}) {
    Object.assign(this, { load, limit, perHost, hostLimit, backgroundPriority, reserve, hostReserve, hedge, timeout, now, later, cancelTimer, defer });
    this.jobs = new Map(); this.hosts = new Map(); this.failed = new Map(); this.active = 0; this.scheduled = false;
  }
  request(key, urls, onLoad, onError, priority = 0) {
    let job = this.jobs.get(key);
    if (!job) { job = { key, urls: [...new Set(urls)], clients: new Set(), tried: new Set(), active: new Set(), hedgeReady: false, timer: 0 }; this.jobs.set(key, job); }
    const client = { onLoad, onError, priority }; job.clients.add(client); this.schedule();
    return {
      cancel: () => { job.clients.delete(client); if (!job.clients.size) this.finish(job); },
      priority: (value) => { client.priority = value; this.schedule(); },
    };
  }
  clearFailures() { this.failed.clear(); }
  schedule() { if (this.scheduled) return; this.scheduled = true; this.defer(() => { this.scheduled = false; this.drain(); }); }
  host(url) { try { return new URL(url).host; } catch { return ''; } }
  priority(job) { return Math.min(...[...job.clients].map(c => c.priority)); }
  candidate(job) {
    const running = new Set([...job.active].map(a => a.host));
    const reserved = this.priority(job) >= this.backgroundPriority ? this.hostReserve : 0;
    return job.urls.filter(u => !job.tried.has(u) && (!this.failed.has(u) || this.now() - this.failed.get(u) >= 60000))
      .sort((a, b) => Number(running.has(this.host(a))) - Number(running.has(this.host(b))))
      .find(u => (this.hosts.get(this.host(u)) || 0) < Math.max(1, this.hostLimit(this.host(u)) - reserved));
  }
  drain() {
    const jobs = [...this.jobs.values()].sort((a, b) => this.priority(a) - this.priority(b) || a.active.size - b.active.size);
    for (const job of jobs) {
      const budget = this.limit - (this.priority(job) >= this.backgroundPriority ? this.reserve : 0);
      if (job.closed || this.active >= budget) continue;
      if (job.active.size >= 2 || (job.active.size && !job.hedgeReady)) continue;
      const url = this.candidate(job);
      if (!url) {
        const untried = job.urls.some(u => !job.tried.has(u) && (!this.failed.has(u) || this.now() - this.failed.get(u) >= 60000));
        if (!job.active.size && !untried) this.finish(job, null);
        continue;
      }
      this.start(job, url);
    }
  }
  start(job, url) {
    const attempt = { url, host: this.host(url), timer: 0, cancel: null, ended: false };
    job.tried.add(url); job.active.add(attempt); this.active++; this.hosts.set(attempt.host, (this.hosts.get(attempt.host) || 0) + 1);
    if (!job.timer && !job.hedgeReady) job.timer = this.later(() => { job.timer = 0; job.hedgeReady = true; this.schedule(); }, this.hedge);
    const success = display => { if (!attempt.ended && !job.closed) this.finish(job, url, display); };
    const failure = () => {
      if (attempt.ended || job.closed) return;
      this.failed.set(url, this.now()); if (this.failed.size > 1500) this.failed.delete(this.failed.keys().next().value);
      this.release(job, attempt); job.hedgeReady = true; this.schedule();
    };
    attempt.timer = this.later(failure, this.timeout);
    try { const cancel = this.load(url, success, failure); if (attempt.ended) cancel?.(); else attempt.cancel = cancel; } catch { failure(); }
    // Fill spare slots without waiting for another DOM event.
    this.schedule();
  }
  release(job, attempt) {
    if (attempt.ended) return; attempt.ended = true;
    this.cancelTimer(attempt.timer); attempt.cancel?.(); job.active.delete(attempt); this.active--;
    this.hosts.set(attempt.host, Math.max(0, (this.hosts.get(attempt.host) || 1) - 1));
  }
  finish(job, result, display) {
    if (job.closed) return; job.closed = true; this.cancelTimer(job.timer);
    for (const attempt of [...job.active]) this.release(job, attempt);
    this.jobs.delete(job.key);
    for (const client of job.clients) { if (result) client.onLoad(result, display); else if (result === null) client.onError(); }
    job.clients.clear(); this.schedule();
  }
}
