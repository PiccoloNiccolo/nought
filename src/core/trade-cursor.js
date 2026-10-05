// Keep paging until an already-seen trade is reached. A bounded pass can resume next tick;
// committing a head page early would silently skip everything between it and the old head.
export class TradeCursor {
  constructor({ pageBudget = 4, capacity = 6000 } = {}) {
    this.pageBudget = pageBudget; this.capacity = capacity;
    this.seen = new Set(); this.started = false; this.pending = null; this.busy = null;
  }
  poll(fetchPage, active = () => true) {
    if (this.busy) return this.busy;
    this.busy = this.read(fetchPage, active).finally(() => { this.busy = null; });
    return this.busy;
  }
  async read(fetchPage, active) {
    this.pending ||= { next: undefined, rows: new Map(), cursors: new Set() };
    const p = this.pending;
    for (let i = 0; i < this.pageBudget && active(); i++) {
      const page = await fetchPage(p.next);
      if (!active()) return { txs: [], backfill: false, catchingUp: false };
      const overlap = page.txs.some((x) => this.seen.has(x.id));
      for (const x of page.txs) if (!this.seen.has(x.id)) p.rows.set(x.id, x);
      if (p.rows.size > this.capacity) {
        this.pending = null;
        throw new Error('Trade history exceeds the catch-up window. Reload this coin to refresh history.');
      }
      if (!this.started || overlap || !page.next) {
        // API pages are newest first. Preserve their order for equal timestamps;
        // action IDs are opaque and lexical order can put an older price last.
        const txs = [...p.rows.values()].reverse().sort((a, b) => a.at - b.at);
        for (const x of txs) this.seen.add(x.id);
        while (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value);
        const backfill = !this.started;
        this.started = true; this.pending = null;
        return { txs, backfill, catchingUp: false };
      }
      if (p.cursors.has(page.next)) { this.pending = null; throw new Error('Trade provider repeated its pagination cursor. Retrying the history.'); }
      p.cursors.add(page.next); p.next = page.next;
    }
    return { txs: [], backfill: false, catchingUp: !!this.pending };
  }
}
