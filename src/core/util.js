// Small shared helpers: DOM, escaping, formatting, storage, toasts, fetch, an event bus and icons.
// Every string that comes from a token's metadata or any API is untrusted: always pass it through esc() before
// putting it in HTML, and through safeUrl() before using it as a link or image.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// http(s) only, with nothing left in the href that could end an HTML attribute or tag. The URL parser encodes most of
// these already, but keeps ' in paths and " ' ` in host names: odd hosts are refused, the rest is percent-encoded.
const HOST_OK = /^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?|\[[0-9a-f:.]+\])$/i;
const pctEnc = (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
export const safeUrl = (u) => {
  try {
    const x = new URL(String(u ?? '').trim());
    if ((x.protocol !== 'https:' && x.protocol !== 'http:') || !HOST_OK.test(x.hostname)) return '';
    return x.href.replace(/["'<>`\s\\]/g, pctEnc);
  } catch { return ''; }
};
export const isMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));
export const short = (a, n = 4) => (a ? String(a).slice(0, n) + '…' + String(a).slice(-n) : '');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// numbers
export function usd(n, d = 1) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(d) + 'B';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(d) + 'M';
  if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(d) + 'K';
  if (a >= 1) return s + '$' + a.toFixed(a >= 100 ? 0 : 2);
  if (a === 0) return '$0';
  return s + '$' + a.toPrecision(3);
}
export const num = (n) => (n == null || !isFinite(n) ? '—' : Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(Math.abs(n) >= 10 ? 0 : 2));
export const sol = (n, d = 3) => (n == null || !isFinite(n) ? '—' : n.toFixed(d));
export const pct = (n, d = 1) => (n == null || !isFinite(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(Math.abs(n) >= 100 ? 0 : d) + '%');
export const cls = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');

// Parsing what people type. Both return NaN for anything they can't read for sure, so callers can say "enter a number"
// instead of guessing an amount 1000× too big or too small.
// parseAmount: SOL, token and percent amounts that get traded or sent. One decimal separator, "." or "," (a phone
// keypad in a comma locale types "0,5"); no thousands separators, suffixes or signs. "0,5" → 0.5, "1.25" → 1.25,
// "1,000" → 1, "1,000.5" → NaN, "1.2.3" → NaN.
export function parseAmount(s) {
  const t = String(s ?? '').trim();
  if (!/^\d*[.,]?\d*$/.test(t) || !/\d/.test(t)) return NaN;
  return Number(t.replace(',', '.'));
}
// parseTarget: market caps and prices (alert, limit, TP/SL and filter targets). Allows "$", spaces, k/m/b suffixes and
// comma thousands groups next to a "." decimal ("1,250,000", "1,250.5"). A lone comma is a decimal point unless exactly
// three digits follow it ("2,5m" → 2.5M, "0,00042" → 0.00042); "1,500" alone is ambiguous → NaN (type 1500 or 1.5k).
export function parseTarget(s) {
  let t = String(s ?? '').trim().toLowerCase().replace(/[\s$]/g, '');
  const m = /^(.*?)(k|m|bn|b)?$/.exec(t), mult = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 }[m[2]] || 1;
  t = m[1];
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) && (t.includes('.') || (t.match(/,/g) || []).length > 1)) t = t.replace(/,/g, '');
  else if (/^\d*,\d+$/.test(t)) { if (/^\d{1,3},\d{3}$/.test(t)) return NaN; t = t.replace(',', '.'); }
  if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) return NaN;
  return Number(t) * mult;
}
export function ago(ms) { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; }

// storage (per browser; can be unavailable)
export const LS = {
  get(k, d) { try { const v = localStorage.getItem('nought.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem('nought.' + k, JSON.stringify(v)); return true; }
    catch (e) {
      // The board is disposable; orders, settings and the trade journal are not.
      if (k !== 'board' && (e?.name === 'QuotaExceededError' || e?.code === 22)) {
        try { localStorage.removeItem('nought.board'); localStorage.setItem('nought.' + k, JSON.stringify(v)); return true; } catch { /* report below */ }
      }
      if (k !== 'board') emit('storage-error', { key: k });
      return false;
    }
  },
};

// network
export async function getJson(url, opt = {}, ms = 10000) {
  const r = await fetch(url, { ...opt, signal: opt.signal || AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}
// a tiny per-host queue so free APIs with rate limits (GeckoTerminal ~30/min) aren't hammered
const lanes = new Map();
export function queued(host, gapMs, fn) {
  const lane = lanes.get(host) || Promise.resolve();
  const next = lane.then(() => fn()).finally(() => sleep(gapMs));
  lanes.set(host, next.catch(() => {}));
  return next;
}

// event bus (payloads: docs/BUILD.md): 'tokens' (store changed, throttled), 'new-token', 'migrate', 'trade' (polled trades
// of watched coins), 'stream', 'sol', 'settings', 'route', 'wallet', 'vault', 'traded' (after a Nought trade), 'orders'
const handlers = new Map();
export const on = (evt, fn) => { (handlers.get(evt) || handlers.set(evt, new Set()).get(evt)).add(fn); return () => handlers.get(evt)?.delete(fn); };
export const emit = (evt, data) => handlers.get(evt)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(evt, e); } });

// toasts. A modal dialog sits in the browser's top layer, above #toasts and its backdrop blurs them: while one is open,
// toasts go into a twin container inside it, and move back to #toasts when it closes.
function toastHost() {
  const isModal = (d) => { try { return !!d?.matches(':modal'); } catch { return false; } };
  const focused = document.activeElement?.closest?.('dialog[open]'); // the dialog in use is the top one
  const main = $('#toasts'), modal = isModal(focused) ? focused : $$('dialog[open]').reverse().find(isModal);
  if (!modal) return main;
  let h = modal.querySelector(':scope > .toasts');
  if (!h) {
    h = document.createElement('div'); h.className = 'toasts'; h.setAttribute('aria-live', 'polite'); modal.appendChild(h);
    modal.addEventListener('close', () => { for (const t of [...h.children]) main?.appendChild(t); h.remove(); }, { once: true });
  }
  return h;
}
export function toast(html, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.innerHTML = html;
  toastHost()?.appendChild(t); setTimeout(() => t.remove(), kind === 'err' ? 9000 : 6500);
}
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied <span class="mono">' + esc(short(text)) + '</span>', 'ok'); }
  catch { toast('Copy failed. Address: <span class="mono">' + esc(text) + '</span>', 'err'); }
}

export const ICON = {
  tweet: '<svg class="tweet-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M23.95 4.57a10 10 0 0 1-2.83.78 4.93 4.93 0 0 0 2.17-2.72 9.99 9.99 0 0 1-3.13 1.2 4.92 4.92 0 0 0-8.38 4.48A13.98 13.98 0 0 1 1.64 3.16a4.92 4.92 0 0 0 1.52 6.57 4.9 4.9 0 0 1-2.23-.62v.06a4.92 4.92 0 0 0 3.95 4.83 4.93 4.93 0 0 1-2.22.08 4.93 4.93 0 0 0 4.6 3.42A9.87 9.87 0 0 1 0 19.54a13.96 13.96 0 0 0 7.55 2.21c9.06 0 14.01-7.5 14.01-14.01 0-.21 0-.42-.02-.64a10 10 0 0 0 2.46-2.55Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.2h1.7L7.4 4.73H5.58L16.67 19.2Z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M21.9 4.3 18.7 19.6c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13.3l-4.8-1.5c-1-.3-1-1 .2-1.5L20.6 3c.9-.3 1.6.2 1.3 1.3Z"/></svg>',
  web: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  star: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9L12 3Z" fill="var(--f, none)" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m16 16 4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  filter: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 5h16l-6 7.5V19l-4 1.5v-8L4 5Z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Zm4 4a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
