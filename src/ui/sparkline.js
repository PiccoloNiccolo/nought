// Sparklines: tiny price lines for table rows, loaded lazily for the rows on screen and cached for every page.
//   sparkSvg(closes, {w, h})  → an inline <svg> string (no data in it except numbers)
//   sparkCell(mint)           → a placeholder <span class="spark" data-spark="mint">, already filled when cached
//   sparkWatcher(root)        → {scan(), destroy()}: call scan() after each render; destroy() in the page cleanup
// Candles come from jc.chart (15-minute bars, 32 of them = the last 8 hours). One fetch per coin per few minutes,
// at most 3 at a time across the app; the datapi lane in jup.js adds its own gap on top.
import { esc, isMint } from '../core/util.js';
import { jc } from '../core/jup.js';

const TTL = 4 * 60e3, FAIL_TTL = 2 * 60e3, MAX = 600, PARALLEL = 3;
const cache = new Map(); // mint → {at, pts: number[] | null}
const queue = [], inflight = new Set(), waiters = new Set();

export function sparkSvg(pts, { w = 92, h = 26 } = {}) {
  if (!Array.isArray(pts) || pts.length < 2) return '<span class="spark-none">no data</span>';
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) { if (p < lo) lo = p; if (p > hi) hi = p; }
  const span = hi - lo || Math.abs(hi) || 1, step = (w - 2) / (pts.length - 1);
  const xy = pts.map((p, i) => [1 + i * step, 1 + (h - 2) * (1 - (p - lo) / span)]);
  const line = xy.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('');
  const up = pts[pts.length - 1] >= pts[0], c = up ? 'var(--up)' : 'var(--down)';
  const area = `${line}L${xy[xy.length - 1][0].toFixed(1)} ${h}L1 ${h}Z`;
  const last = xy[xy.length - 1];
  return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" preserveAspectRatio="none">`
    + `<path d="${area}" style="fill:${c};opacity:.12;stroke:none"/>`
    + `<path d="${line}" style="fill:none;stroke:${c};stroke-width:1.3;stroke-linejoin:round;stroke-linecap:round" vector-effect="non-scaling-stroke"/>`
    + `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="1.8" style="fill:${c}"/></svg>`;
}

const fresh = (e) => e && Date.now() - e.at < (e.pts ? TTL : FAIL_TTL);
export const sparkCached = (mint) => cache.get(mint)?.pts || null;
export function sparkCell(mint) {
  const e = cache.get(mint);
  return `<span class="spark" data-spark="${esc(mint)}"${e ? ' data-done="1"' : ''}>${e ? sparkSvg(e.pts) : '<i class="spark-wait skel"></i>'}</span>`;
}

function put(mint, pts) {
  cache.delete(mint); cache.set(mint, { at: Date.now(), pts });
  if (cache.size > MAX) for (const k of [...cache.keys()].slice(0, cache.size - MAX)) cache.delete(k);
}
function pump() {
  while (inflight.size < PARALLEL && queue.length) {
    const mint = queue.shift();
    if (inflight.has(mint) || fresh(cache.get(mint))) { notify(mint); continue; }
    inflight.add(mint);
    jc.chart(mint, { interval: '15_MINUTE', candles: 32, type: 'price', quote: 'usd' })
      .then((c) => put(mint, c.map((x) => x.close).filter((v) => Number.isFinite(v) && v > 0).slice(-32)))
      .catch(() => put(mint, null))
      .finally(() => { inflight.delete(mint); notify(mint); pump(); });
  }
}
function notify(mint) { for (const fn of waiters) fn(mint); }
function want(mint) { if (isMint(mint) && !inflight.has(mint) && !queue.includes(mint)) { queue.push(mint); pump(); } }

// Watches one page's placeholders; only rows scrolled into view (plus a margin) load.
export function sparkWatcher(root) {
  let alive = true;
  const fill = (mint) => {
    if (!alive) return;
    const e = cache.get(mint); if (!e) return;
    for (const el of root.querySelectorAll(`.spark[data-spark="${CSS.escape(mint)}"]`)) { el.innerHTML = sparkSvg(e.pts); el.dataset.done = '1'; }
  };
  waiters.add(fill);
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); want(en.target.dataset.spark); }
  }, { rootMargin: '160px 0px' }) : null;
  return {
    scan() {
      if (!alive) return;
      io?.disconnect(); // rows from the previous render are gone: drop them, observe the current ones
      for (const el of root.querySelectorAll('.spark[data-spark]')) {
        const e = cache.get(el.dataset.spark);
        if (e && !el.dataset.done) { el.innerHTML = sparkSvg(e.pts); el.dataset.done = '1'; }
        if (fresh(e)) continue; // stale or missing: refetch once it is on screen
        if (io) io.observe(el); else want(el.dataset.spark);
      }
    },
    destroy() { alive = false; waiters.delete(fill); io?.disconnect(); queue.length = 0; },
  };
}
