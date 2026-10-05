// Trackers + Vision: #/track[/wallets|live|monitor|vision]
//   Wallets  tracked wallets (localStorage 'tracked': [{address, name, emoji, group, alert, sound, feed}]), groups,
//            search, import/export, lazy balance (ju.balances, 60 s cache) and last activity (RPC, limit 1)
//   Live     trades of in-feed wallets, decoded by src/core/logs.js ('tracker-trade' events), with filters
//   Monitor  coins held by 2+ tracked wallets (ju.holdings, one wallet every 2 s, 5 min cache)
//   Vision   the community wallet list (data/kol-wallets.json) and wallets discovered this session from the top
//            traders of trending coins
// Copy trading (opt-in per wallet, off by default) buys through trade.js with a local vault wallet while a Trackers
// page is open, in ONE tab only (a Web Lock), after a second RPC confirms the copied trade. Limits, claimed
// signatures and copy-bought amounts are shared by every tab through localStorage under another Web Lock. Alerts and
// sounds for tracked wallets work on every page (the live feed starts at boot when at least one wallet is in the feed).
//
// ---- Vision's community list: data/kol-wallets.json ----
// The file ships as an empty array on purpose: Nought never guesses who owns a wallet. To add one, open a pull request
// that appends an object like
//     {"address": "<base58 wallet address>", "name": "<display name>", "x": "<X handle, no @>", "tags": ["trader"]}
// and link, in the pull request, a PUBLIC source where that person or project shows the address as their own (a post
// from their own account, their website, a name record they control). Reviewers check the source before merging:
// no source, no merge. Addresses are removed on request of the owner, or when the source disappears. Keep tags short
// and factual. Entries are validated when loaded (address must be base58, handle must look like an X handle).
import { $, $$, esc, isMint, short, sleep, usd, ago, LS, on, emit, toast as toastRaw, ICON, parseAmount, parseTarget } from '../core/util.js';
import { register } from '../core/router.js';
import { tokens, upsert, mcUsd } from '../core/store.js';
import { jt, jp, ju, jx, coolLeft } from '../core/jup.js';
import { rpc, signaturesFor } from '../core/rpc.js';
import { solUsd } from '../core/price.js';
import { preset } from '../core/settings.js';
import { trade, holding, confirm, tradeLog, SOL_MINT } from '../core/trade.js';
import * as V from '../core/vault.js';
import * as logs from '../core/logs.js';
import { avatar, qbButton } from '../ui/card.js';

const KEY = 'tracked', COPY_KEY = 'tracked.copy', SPENT_KEY = 'tracked.copy.spent', CLOG_KEY = 'tracked.copy.log';
const GUARD_KEY = 'tracked.copy.guard', HELD_KEY = 'tracked.copy.held';
const liveStatus = () => logs.status();
// a toast is a grid: one wrapper keeps "Copying <b>name</b>: …" on one line instead of a row per element
const toast = (html, kind) => toastRaw(`<span>${html}</span>`, kind);
const MAX_TRACKED = 10000, MONITOR_MAX = 200;
const TABS = [['wallets', 'Wallets'], ['live', 'Live'], ['monitor', 'Monitor'], ['vision', 'Vision']];
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SKIP = new Set([SOL_MINT, USDC, USDT]);
const TOG = { feed: 'Show this wallet\'s trades in Live', alert: 'Pop a notice on any page when it trades', sound: 'Play a sound when it trades' };

// ---- small helpers ----
const str = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
function emo(s) {
  const t = str(s, 16); if (!t) return '';
  try { if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter().segment(t)].slice(0, 2).map((x) => x.segment).join(''); } catch { /* old browser */ }
  return [...t].slice(0, 2).join('');
}
const solTxt = (n) => (n == null || !isFinite(n) ? '—' : Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(3));
// signed SOL for PnL; anything that rounds to zero reads as a plain, uncoloured 0
const pnlTxt = (n) => (Math.abs(n) < 5e-4 ? ['0.000', 'dim'] : [(n > 0 ? '+' : '−') + solTxt(Math.abs(n)), n > 0 ? 'up' : 'down']);
const isSig = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
const sym = (t, mint) => (t?.symbol ? t.symbol : short(mint, 3));
const who = (w, addr) => esc(w?.name || short(addr));
function throttle(fn, ms) { let t = 0; const f = () => { if (!t) t = setTimeout(() => { t = 0; fn(); }, ms); }; f.cancel = () => { clearTimeout(t); t = 0; }; return f; }
const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD: caps reset at local midnight

// ---- empty and loading states: the shared .empty-state (style.css), and a faded preview of the table to come ----
function svg(p, s = 22) { return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`; }
const IC = {
  radar: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="m12 12 6.3-6.3"/><circle cx="12" cy="12" r="1" fill="currentColor"/>'),
  live: svg('<path d="M3 12h3.5l2.5-6 5 12 2.5-6H21"/>'),
  overlap: svg('<circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/>'),
  scan: svg('<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M12 8.5v4M12 15.5v.01"/>'),
  chev: svg('<path d="m7 10 5 5 5-5"/>', 13),
};
// every argument is our own copy (numbers at most); callers esc() anything else first
function emptyHtml({ ic = '', title, body = '', steps = [], acts = '', cls = '' }) {
  return `<div class="empty-state trk-es ${cls}">${ic ? `<span class="es-ic">${IC[ic]}</span>` : ''}<h3>${title}</h3>${body ? `<p>${body}</p>` : ''}${steps.length ? `<ol class="es-steps">${steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}${acts ? `<div class="es-acts">${acts}</div>` : ''}</div>`;
}
// the real header of each table, so its preview (and its loading rows) line up with what will come
const HEAD = {
  tw: `<th>Wallet</th><th>Group</th><th class="r">Balance</th><th class="r">Last active</th><th class="c" title="${TOG.feed}">Feed</th><th class="c" title="${TOG.alert}">Alert</th><th class="c" title="${TOG.sound}">Sound</th><th class="c" title="Copy trading (off by default)">Copy</th><th></th>`,
  tl: '<th>Time</th><th>Wallet</th><th>Side</th><th>Token</th><th class="r">SOL</th><th class="r">MC at fill</th><th class="c">Tx</th><th class="c">Buy</th>',
  tm: '<th>Token</th><th class="r">Wallets</th><th>Held by</th><th class="r">Total value</th><th class="r">MC</th><th class="c">Buy</th>',
  tv: '<th class="r">#</th><th>Wallet</th><th class="r">Realized PnL</th><th class="r">Volume</th><th class="r">Trades</th><th class="r">Coins</th><th class="r">Win rate</th><th class="c"></th>',
};
const sk = (c) => `<i class="skel ${c}"></i>`;
const SKROW = {
  tw: `<td class="tw-who">${sk('sk-av')}<span class="sk-2">${sk('sk-a')}${sk('sk-s')}</span></td><td>${sk('sk-c')}</td><td class="num">${sk('sk-d')}</td><td class="num">${sk('sk-d')}</td>${['feed', 'alert', 'sound'].map((k) => `<td class="c" data-l="${k}">${sk('sk-sw')}</td>`).join('')}<td class="c" data-l="copy">${sk('sk-cp')}</td><td class="tw-act">${sk('sk-e')}</td>`,
  tl: `<td>${sk('sk-t')}</td><td>${sk('sk-av sm')}${sk('sk-a')}</td><td>${sk('sk-side')}</td><td>${sk('sk-av sm')}${sk('sk-b')}</td><td class="num">${sk('sk-d')}</td><td class="num">${sk('sk-d')}</td><td class="c">${sk('sk-dot')}</td><td class="c">${sk('sk-qb')}</td>`,
  tm: `<td>${sk('sk-av sm')}${sk('sk-b')}</td><td class="num">${sk('sk-t')}</td><td>${sk('sk-c')} ${sk('sk-c')}</td><td class="num">${sk('sk-d')}</td><td class="num">${sk('sk-d')}</td><td class="c">${sk('sk-qb')}</td>`,
  tv: `<td class="num">${sk('sk-t')}</td><td>${sk('sk-a')}</td><td class="num">${sk('sk-d')}</td><td class="num">${sk('sk-d')}</td><td class="num">${sk('sk-t')}</td><td class="num">${sk('sk-t')}</td><td class="num">${sk('sk-d')}</td><td class="c">${sk('sk-cp')}</td>`,
};
// ghost: a static, faded preview under an empty state; otherwise shimmering rows while something loads
const skelTable = (k, n, ghost) => `<table class="trk-t ${k}-t trk-sk${ghost ? ' trk-ghost' : ''}" aria-hidden="true"><thead><tr>${HEAD[k]}</tr></thead><tbody>${`<tr>${SKROW[k]}</tr>`.repeat(n)}</tbody></table>`;
const emptyWithGhost = (k, opts) => `<div class="trk-es-wrap">${emptyHtml(opts)}${skelTable(k, 3, true)}</div>`;
let addNext = false; // an "Add wallet" button on another tab opens the add form once the Wallets tab mounts

// ---- tracked wallets (localStorage 'tracked') ----
const clean = (w) => ({ address: String(w.address).trim(), name: str(w.name, 40), emoji: emo(w.emoji), group: str(w.group, 24), alert: !!w.alert, sound: !!w.sound, feed: w.feed !== false });
function load() {
  const l = LS.get(KEY, []), seen = new Set();
  return (Array.isArray(l) ? l : []).filter((w) => { const a = String(w?.address || '').trim(); if (!isMint(a) || seen.has(a)) return false; seen.add(a); return true; }).map(clean);
}
let list = load();
let index = new Map(list.map((w) => [w.address, w]));
export const trackedWallets = () => list.slice();
export const isTracked = (a) => index.has(a);
function save() {
  LS.set(KEY, list);
  index = new Map(list.map((w) => [w.address, w]));
  syncLive();
  saving = true;
  try { emit('tracked', list.slice()); } finally { saving = false; }
}
function addWallets(items) {
  let added = 0;
  for (const it of items) {
    if (list.length >= MAX_TRACKED) break;
    const w = clean(it);
    if (!isMint(w.address) || index.has(w.address)) continue;
    list.push(w); index.set(w.address, w); added++;
  }
  if (added) save();
  return added;
}

// ---- copy-trading settings (kept apart from the wallet list, so exports never carry them) ----
const copyCfg = () => { const c = LS.get(COPY_KEY, {}); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; };
function setCopy(addr, v) { const c = copyCfg(); if (v) c[addr] = v; else delete c[addr]; LS.set(COPY_KEY, c); syncLive(); emit('tracked-copy'); }
const copyOn = () => Object.entries(copyCfg()).filter(([a, c]) => c?.on && index.has(a));
// Hard limits. The dialog checks them and the engine checks them again before every copy: storage is never trusted.
// allDaily caps the day's copy spend across every copied wallet together.
const LIM = { min: 0.001, max: 50, daily: 500, allDaily: 500, minSrc: 1000, rate: 3, coolMs: 120e3, maxAgeMs: 90e3, buyImpact: 15, sellImpact: 30 };
function cfgError(c) {
  const n = (v) => typeof v === 'number' && isFinite(v);
  if (!c || typeof c !== 'object' || !isMint(c.owner)) return 'Pick a local wallet.';
  if (c.mode !== 'fixed' && c.mode !== 'pct') return 'Pick how much to buy.';
  if (c.mode === 'fixed' && !(n(c.amount) && c.amount >= LIM.min && c.amount <= LIM.max)) return `Amount per buy must be between ${LIM.min} and ${LIM.max} SOL.`;
  if (c.mode === 'pct' && !(n(c.pct) && c.pct >= 1 && c.pct <= 100)) return 'The share must be between 1% and 100%.';
  if (!(n(c.cap) && c.cap >= LIM.min && c.cap <= LIM.max)) return `Most per trade must be between ${LIM.min} and ${LIM.max} SOL.`;
  if (!(n(c.daily) && c.daily >= c.cap && c.daily <= LIM.daily)) return `Most per day must be at least the per-trade limit, and at most ${LIM.daily} SOL.`;
  if (!(n(c.minSrc) && c.minSrc >= 0 && c.minSrc <= LIM.minSrc)) return 'Check the minimum.';
  return '';
}

// ---- engine state shared by every tab: claimed source signatures, per-coin cooldowns and the per-minute rate
// (GUARD_KEY), the day's spend (SPENT_KEY) and raw tokens bought by copying (HELD_KEY). Read-modify-write happens
// only inside the 'nought-copy-state' Web Lock, so two tabs can never both pass a check before either writes. ----
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
function locked(fn) {
  const L = globalThis.navigator?.locks;
  return L?.request ? L.request('nought-copy-state', () => fn()) : Promise.reject(new Error('This browser cannot share copy limits between tabs.'));
}
// a write that must land: limits are never kept in storage that silently drops writes
function put(k, v) { LS.set(k, v); if (JSON.stringify(LS.get(k, null)) !== JSON.stringify(v)) throw new Error('This browser is not saving site data, so copying is paused.'); }
function spent() { const s = obj(LS.get(SPENT_KEY, null)); return s.day === today() ? { day: s.day, by: obj(s.by) } : { day: today(), by: {} }; }
const spentOf = (s, a) => Math.max(0, Number(s.by[a]) || 0);
const spentToday = (a) => spentOf(spent(), a);
const spentAll = (s) => Object.keys(s.by).reduce((t, a) => t + spentOf(s, a), 0);
function guard() {
  const g = obj(LS.get(GUARD_KEY, null));
  return { sigs: Array.isArray(g.sigs) ? g.sigs.filter((x) => typeof x === 'string') : [], last: obj(g.last), recent: Array.isArray(g.recent) ? g.recent.filter((t) => typeof t === 'number') : [] };
}
// true once per source signature across every tab (the newest 500 are kept)
const claim = (sig) => locked(() => { const g = guard(); if (g.sigs.includes(sig)) return false; g.sigs = [...g.sigs, sig].slice(-500); put(GUARD_KEY, g); return true; });
// checks cooldown, rate and daily limits, and books the buy: {x (SOL)} or {skip: reason}
const reserve = (ev, c) => locked(() => {
  const now = Date.now(), g = guard(), s = spent(), k = ev.wallet + ':' + ev.mint;
  if (now - (Number(g.last[k]) || 0) < LIM.coolMs) return { skip: 'Already copied this coin from this wallet in the last 2 minutes.' };
  g.recent = g.recent.filter((t) => now - t < 60e3);
  if (g.recent.length >= LIM.rate) return { skip: 'Three copies in the last minute: held back for safety.' };
  const mine = spentOf(s, ev.wallet), left = Math.min(c.daily - mine, LIM.allDaily - spentAll(s));
  const x = Math.floor(Math.min(c.mode === 'pct' ? (ev.sol * c.pct) / 100 : c.amount, c.cap, LIM.max, left) * 1e4 + 1e-6) / 1e4; // (+1e-6: 0.3 − 0.28 is 0.01999…)
  if (!(x >= LIM.min)) return { skip: left < LIM.min ? 'Daily limit reached.' : 'Amount rounds below 0.001 SOL.' };
  for (const [kk, t] of Object.entries(g.last)) if (!(now - t < LIM.coolMs)) delete g.last[kk];
  g.last[k] = now; g.recent.push(now); s.by[ev.wallet] = Math.round((mine + x) * 1e9) / 1e9;
  put(GUARD_KEY, g); put(SPENT_KEY, s);
  return { x };
});
const refund = (a, x) => locked(() => { const s = spent(); s.by[a] = Math.max(0, Math.round((spentOf(s, a) - x) * 1e9) / 1e9); put(SPENT_KEY, s); });
// copy-bought tokens per (paying wallet, coin, copied wallet), raw base units as strings; the newest 300 are kept
const heldKey = (owner, mint, src) => `${owner}:${mint}:${src}`;
function held() { const h = obj(LS.get(HELD_KEY, null)), out = {}; for (const [k, v] of Object.entries(h)) if (/^\d{1,30}$/.test(String(v?.raw)) && typeof v.at === 'number') out[k] = v; return out; }
function setHeld(h, k, raw) { if (raw > 0n) h[k] = { raw: raw.toString(), at: Date.now() }; else delete h[k]; put(HELD_KEY, Object.fromEntries(Object.entries(h).sort((a, b) => b[1].at - a[1].at).slice(0, 300))); }
const addHeld = (k, d) => locked(() => { const h = held(); setHeld(h, k, BigInt(h[k]?.raw || '0') + d); });
// takes the share to sell off the tally, never more than the wallet still holds
const takeHeld = (k, have, pct) => locked(() => {
  const h = held(), cur = BigInt(h[k]?.raw || '0'), max = cur < have ? cur : have;
  const take = pct >= 99.5 ? max : (max * BigInt(Math.round(pct * 100))) / 10000n;
  setHeld(h, k, max - take);
  return take;
});

// ---- consent stamp: a setup only copies when this browser's copy dialog wrote it. The stamp is an HMAC under a
// non-extractable key in this browser's IndexedDB (never in localStorage, so no settings file can carry or forge it).
const stampText = (a, c) => JSON.stringify([a, c.owner, c.mode, c.amount, c.pct, c.cap, c.daily, c.minSrc, !!c.sells, c.since]);
function keyDb(mode, op) {
  return new Promise((res, rej) => {
    const o = indexedDB.open('nought-track', 1);
    o.onupgradeneeded = () => o.result.createObjectStore('k');
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const db = o.result;
      try { const tx = db.transaction('k', mode), r = op(tx.objectStore('k')); tx.oncomplete = () => { db.close(); res(r?.result); }; tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); }; } catch (e) { db.close(); rej(e); }
    };
  });
}
async function stampKey(create) {
  const get = () => keyDb('readonly', (s) => s.get('copy'));
  const k = await get();
  if (k || !create) return k || null;
  return navigator.locks.request('nought-copy-key', async () => {
    let x = await get();
    if (!x) { x = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); await keyDb('readwrite', (s) => s.put(x, 'copy')); }
    return x;
  });
}
async function makeStamp(a, c) {
  const mac = await crypto.subtle.sign('HMAC', await stampKey(true), new TextEncoder().encode(stampText(a, c)));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
// 'ok' | 'bad' (no stamp, or not one this browser wrote) | 'error' (could not check; never copies either)
async function stampState(a, c) {
  let mac;
  try { mac = Uint8Array.from(atob(String(c?.stamp || '')), (ch) => ch.charCodeAt(0)); } catch { return 'bad'; }
  if (mac.length !== 32) return 'bad';
  try { const k = await stampKey(false); return k && (await crypto.subtle.verify('HMAC', k, mac, new TextEncoder().encode(stampText(a, c)))) ? 'ok' : 'bad'; } catch { return 'error'; }
}
// setups this browser's dialog did not write are switched off (older setups from before stamps, or planted ones)
async function dropUnstamped() {
  for (const [a, c] of Object.entries(copyCfg())) {
    if ((await stampState(a, c)) !== 'bad' || JSON.stringify(copyCfg()[a]) !== JSON.stringify(c)) continue; // (or changed meanwhile)
    setCopy(a, null);
    toast(`Copy trading for <b>${who(index.get(a), a)}</b> is off: that setup was not made in this browser. Set it up again from the Wallets tab.`, 'err');
  }
}
const copyLog = () => { const l = LS.get(CLOG_KEY, []); return Array.isArray(l) ? l : []; };
function logCopy(ev, result, note, sol) {
  const l = copyLog();
  l.unshift({ at: Date.now(), wallet: ev.wallet, mint: ev.mint, side: ev.side, sol: sol ?? null, srcSol: ev.sol, result, note: String(note || '').slice(0, 160), sig: ev.sig });
  LS.set(CLOG_KEY, l.slice(0, 60));
  emit('tracked-copylog');
}

// ---- the live feed follows every in-feed wallet; copy and alert wallets get live sockets first ----
function syncLive() {
  const cfg = copyCfg(), rank = (w) => (cfg[w.address]?.on ? 0 : w.alert ? 1 : 2);
  logs.watch(list.filter((w) => w.feed).map((w, i) => [w, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([w]) => w));
}

// ---- alerts and sounds: the shell's alerts.js turns each 'tracker-trade' into a bell entry, and a toast unless the
// event is silent (logs.js sets silent when the wallet's Alert switch is off). The Sound switch is carried on the
// event as `sound`. ----
const previewSound = () => import('../ui/alerts.js').then((m) => m.playSound?.('tracker', { force: true })).catch(() => {});
// another module (the token page's Track button) or another tab may change the list: re-read it then
let saving = false;
function reload() { if (saving) return; list = load(); index = new Map(list.map((w) => [w.address, w])); syncLive(); }
on('tracked', reload);
try {
  window.addEventListener('storage', (e) => {
    if (e.key === 'nought.' + KEY || e.key === 'nought.' + COPY_KEY) { reload(); emit('tracked-copy'); }
    else if (e.key === 'nought.' + CLOG_KEY) emit('tracked-copylog'); // the copying tab's log, shown in this one too
  });
} catch { /* no window */ }
syncLive();

// ---- lazy per-row data: SOL balance (ju.balances, RPC getBalance if Jupiter fails) and last activity (RPC), both
// cached 60 s. Two rows load at a time; each row's two lookups run side by side and paint as they land.
const balCache = new Map(), actCache = new Map(), lazyQ = [];
let lazyBusy = 0;
const fresh = (c, ms = 60e3) => c && Date.now() - c.at < ms;
function wantRow(addr, done) {
  if (fresh(balCache.get(addr)) && fresh(actCache.get(addr))) { done(); return; }
  if (lazyQ.some((j) => j.addr === addr)) return;
  lazyQ.push({ addr, done });
  if (lazyQ.length > 40) lazyQ.splice(0, lazyQ.length - 40); // rows scrolled past long ago
  rowWork();
}
async function loadBal(addr) {
  if (fresh(balCache.get(addr))) return;
  try { const b = await ju.balances(addr); balCache.set(addr, { at: Date.now(), sol: b.sol, n: Object.keys(b.tokens).length }); }
  catch { try { const r = await rpc('getBalance', [addr, { commitment: 'confirmed' }], 1); balCache.set(addr, { at: Date.now(), sol: (Number(r?.value) || 0) / 1e9 }); } catch { balCache.set(addr, { at: Date.now(), err: true }); } }
}
async function loadAct(addr) {
  if (fresh(actCache.get(addr))) return;
  try { const s = await signaturesFor(addr, 1); actCache.set(addr, { at: Date.now(), ms: s?.[0]?.blockTime ? s[0].blockTime * 1000 : null }); } catch { actCache.set(addr, { at: Date.now(), err: true }); }
}
async function rowWork() {
  if (lazyBusy >= 2) return;
  lazyBusy++;
  while (lazyQ.length) {
    const { addr, done } = lazyQ.shift(), paint = () => { try { done(); } catch { /* row gone */ } };
    await Promise.allSettled([loadBal(addr).then(paint), loadAct(addr).then(paint)]);
    await sleep(150);
  }
  lazyBusy--;
}
const balHtml = (b) => (!b ? '<span class="skel trk-ld"></span>' : b.err ? '<span class="dim" title="Could not load">—</span>' : `${solTxt(b.sol)} <span class="dim">SOL</span>${b.n ? `<span class="dim trk-n" title="Coins held"> · ${b.n}</span>` : ''}`);
const actHtml = (a) => (!a ? '<span class="skel trk-ld"></span>' : a.err ? '<span class="dim" title="Could not load">—</span>' : a.ms ? `<span data-age="${a.ms}">${ago(a.ms)}</span> <span class="dim">ago</span>` : '<span class="dim"><span class="tw-long">no recent tx</span><span class="tw-short">no tx</span></span>');

// ---- import / export ----
function csvLine(l, d) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < l.length; i++) {
    const ch = l[i];
    if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === d) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
// JSON array (objects or plain addresses), CSV/TSV (header optional: address,name,emoji,group) or one address per line
export function parseImport(text) {
  text = String(text || '').trim();
  if (!text) return [];
  if (/^[[{]/.test(text)) {
    let j; try { j = JSON.parse(text); } catch { throw new Error('That looks like JSON but it does not parse.'); }
    if (!Array.isArray(j)) j = Array.isArray(j?.wallets) ? j.wallets : [j];
    return j.map((x) => (typeof x === 'string' ? { address: x } : { address: x?.address ?? x?.wallet ?? x?.trackedWalletAddress, name: x?.name, emoji: x?.emoji, group: x?.group ?? (Array.isArray(x?.groups) ? x.groups[0] : undefined), alert: x?.alert, sound: x?.sound, feed: x?.feed }));
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const first = lines[0], d = first.includes('\t') ? '\t' : first.includes(',') ? ',' : first.includes(';') ? ';' : null;
  if (!d) return lines.flatMap((l) => l.split(/\s+/)).map((address) => ({ address }));
  let cols = ['address', 'name', 'emoji', 'group'];
  const head = csvLine(first, d).map((h) => h.toLowerCase());
  if (head.includes('address') || head.includes('wallet')) { cols = head.map((h) => (h === 'wallet' ? 'address' : h)); lines.shift(); }
  return lines.map((l) => { const c = csvLine(l, d), o = {}; cols.forEach((k, i) => { o[k] = c[i]; }); return o; });
}
function checkImport(rows, defGroup) {
  const ok = [], seen = new Set(index.keys()); let bad = 0, dup = 0;
  for (const r of rows) {
    const a = String(r?.address ?? '').trim();
    if (!isMint(a)) { bad++; continue; }
    if (seen.has(a)) { dup++; continue; }
    seen.add(a);
    ok.push({ ...r, address: a, group: str(r.group, 24) || defGroup, alert: r.alert === true || r.alert === 'true', sound: r.sound === true || r.sound === 'true', feed: r.feed !== false && r.feed !== 'false' });
  }
  return { ok, bad, dup };
}
const csvCell = (s) => { let v = String(s ?? ''); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function exportAs(kind, items) {
  const body = kind === 'json' ? JSON.stringify(items.map(({ address, name, emoji, group, alert, sound, feed }) => ({ address, name, emoji, group, alert, sound, feed })), null, 2)
    : kind === 'csv' ? ['address,name,emoji,group', ...items.map((w) => [w.address, w.name, w.emoji, w.group].map(csvCell).join(','))].join('\n')
      : items.map((w) => w.address).join('\n');
  const blob = new Blob([body + '\n'], { type: kind === 'json' ? 'application/json' : kind === 'csv' ? 'text/csv' : 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `nought-wallets-${today()}.${kind === 'json' ? 'json' : kind === 'csv' ? 'csv' : 'txt'}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- dialogs (live inside the page root, so a route change removes them) ----
function dialog(root, html, cls = '') {
  const d = document.createElement('dialog');
  d.className = ('trk-dlg ' + cls).trim(); d.innerHTML = html;
  root.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

// ---- monitor + vision caches (kept for the session) ----
const holdCache = new Map(); // address → {at, tokens: Map(mint → ui)}
let kolCache = null;
const disc = { at: 0, busy: false, rows: [], coins: [], iv: '1h', n: 6, err: '', sort: 'pnl' };
const DSORT = {
  pnl: (a, b) => (b.closed ? b.pnl : -1e9) - (a.closed ? a.pnl : -1e9) || b.vol - a.vol,
  vol: (a, b) => b.vol - a.vol,
  trades: (a, b) => b.trades - a.trades || b.vol - a.vol,
  win: (a, b) => (b.closed ? b.wins / b.closed : -1) - (a.closed ? a.wins / a.closed : -1) || b.closed - a.closed || b.pnl - a.pnl,
};

register({
  id: 'track', tab: 'track', match: /^#\/track(?:\/([a-z]+))?$/,
  title: ([sub]) => `${sub === 'vision' ? 'Vision' : 'Trackers'} · Nought`,
  mount(view, [sub]) {
    const tab = TABS.some(([id]) => id === sub) ? sub : 'wallets';
    const offs = [], timers = [], stops = [];
    reload(); // pick up changes other modules made while this page was closed
    let alive = true;
    view.innerHTML = `<div class="trk" data-tab="${tab}">
      <div class="trk-top">
        <nav class="subtabs trk-tabs" aria-label="Tracker views">${TABS.map(([id, label]) => `<a href="#/track/${id}" class="${id === tab ? 'on' : ''}"${id === tab ? ' aria-current="page"' : ''}>${label}${id === 'wallets' ? ` <b>${list.length}</b>` : ''}</a>`).join('')}</nav>
        <div class="trk-state" id="trk-state" role="status"></div>
      </div>
      <div class="trk-copybar" id="trk-copybar" hidden></div>
      <div class="trk-body" id="trk-body"></div>
    </div>`;
    const root = $('.trk', view), body = $('#trk-body', view);
    const ctx = {
      root, body, alive: () => alive,
      on: (e, f) => offs.push(on(e, f)),
      every: (fn, ms) => timers.push(setInterval(fn, ms)),
      throttle: (fn, ms) => { const f = throttle(fn, ms); stops.push(f.cancel); return f; },
    };

    // live state in the top bar
    function state() {
      const s = liveStatus(), el = $('#trk-state', view); if (!el) return;
      const feedN = list.filter((w) => w.feed).length;
      // a phone shows the dot and the live count only; the full line is the title
      if (!feedN) { el.title = 'Not following any wallet'; el.innerHTML = '<span class="dot"></span><span class="ts-long">Not following any wallet</span>'; return; }
      const hosts = s.hosts.filter((h) => h.subs).map((h) => `${h.host}: ${h.subs}`).join(' · ');
      const polled = Math.max(0, s.watching - s.live - s.pending), line = `${s.live} live${s.pending ? ` · ${s.pending} connecting` : ''}${polled ? ` · ${polled} checked every minute` : ''}`;
      el.title = line;
      el.innerHTML = `<span class="dot ${s.live ? 'live' : s.pending ? '' : 'bad'}"></span><span class="ts-long" title="${esc(hosts || 'No live socket yet')}">${line}</span><span class="ts-short">${s.live} live</span>`;
    }
    ctx.on('tracker-status', state); state();

    // copy-trading bar + engine (copies only run while a Trackers page is mounted, in the one tab holding the lock)
    const WHERE = { lead: 'Copies run in this tab while a Trackers page is open.', wait: 'Copies run in another Nought tab with Trackers open, so nothing is bought twice.', none: 'Paused: this browser cannot keep copying to one tab.' };
    function copyBar() {
      const el = $('#trk-copybar', view); if (!el) return;
      const n = copyOn().length, m = copyState.mode, note = copyState.note && Date.now() - copyState.note.at < 600e3 ? copyState.note.text : '';
      el.hidden = !n;
      if (!n) return;
      el.dataset.mode = m;
      el.innerHTML = `<span class="trk-pulse"></span><span class="trk-cbtxt"><b>Copy trading is on</b> for ${n} wallet${n > 1 ? 's' : ''}. ${WHERE[m] || ''}</span>${note ? `<span class="trk-cbnote" title="${esc(note)}">${esc(note)}</span>` : ''}<button type="button" class="btn trk-danger" id="trk-stopall">Stop all copying</button>`;
      $('#trk-stopall', el).addEventListener('click', () => { for (const [a] of copyOn()) setCopy(a, null); toast('Copy trading is off for every wallet.', 'ok'); });
    }
    ctx.on('tracked-copy', copyBar); ctx.on('tracked-copylog', copyBar);
    stops.push(leadCopy((m) => { copyState.mode = m; if (alive) copyBar(); }));
    copyBar();
    ctx.on('tracker-trade', copyEngine());
    dropUnstamped();

    const pane = { wallets: mountWallets, live: mountLive, monitor: mountMonitor, vision: mountVision }[tab];
    try { const stop = pane(ctx); if (typeof stop === 'function') stops.push(stop); } catch (e) { console.error(e); body.innerHTML = '<div class="empty">This view failed to load.</div>'; }

    return () => {
      alive = false; copyState.mode = 'off';
      offs.forEach((f) => f()); timers.forEach((t) => clearInterval(t)); stops.forEach((f) => { try { f(); } catch { /* fine */ } });
      lazyQ.length = 0;
    };
  },
});

// ================= Wallets =================
function mountWallets(ctx) {
  const { body, root } = ctx;
  let group = LS.get('track.group', ''), noGroup = false, q = '', shown = 200, io = null, qt = 0;
  if (typeof group !== 'string' || (group && !list.some((w) => w.group === group))) group = '';
  body.innerHTML = `<div class="trk-w">
    <aside class="trk-groups" id="tw-groups" aria-label="Groups"></aside>
    <section class="trk-wmain">
      <div class="trk-tools">
        <label class="trk-search">${ICON.search}<input id="tw-q" placeholder="Search name, address or group" spellcheck="false" autocomplete="off"></label>
        <button type="button" class="btn btn-accent" id="tw-add-btn">Add wallet</button>
        <button type="button" class="btn" id="tw-imp">Import</button>
        <div class="trk-menu" id="tw-exp">
          <button type="button" class="btn" id="tw-exp-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="tw-exp-m" title="Export the wallets shown">Export ${IC.chev}</button>
          <div class="trk-mlist" id="tw-exp-m" role="menu" aria-label="Export format" hidden>
            <button type="button" role="menuitem" data-exp="json">JSON<small>names, groups and switches</small></button>
            <button type="button" role="menuitem" data-exp="csv">CSV<small>address, name, emoji, group</small></button>
            <button type="button" role="menuitem" data-exp="txt">Plain list<small>one address per line</small></button>
          </div>
        </div>
      </div>
      <form class="trk-add" id="tw-add" hidden autocomplete="off">
        <input name="address" placeholder="Wallet address" spellcheck="false" class="mono" aria-label="Wallet address">
        <input name="name" placeholder="Name" maxlength="40" aria-label="Name">
        <input name="emoji" placeholder="Emoji" maxlength="16" class="trk-emo-in" aria-label="Emoji">
        <input name="group" placeholder="Group" maxlength="24" list="tw-glist" aria-label="Group">
        <datalist id="tw-glist"></datalist>
        <button class="btn btn-accent">Track</button>
        <span class="trk-err" id="tw-add-err" role="alert"></span>
      </form>
      <div class="trk-scroll" id="tw-scroll"></div>
    </section>
  </div>`;
  const scroll = $('#tw-scroll', body), wrap = $('.trk-w', body);
  const groups = () => [...new Set(list.map((w) => w.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  function drawGroups() {
    const counts = new Map(); let none = 0;
    for (const w of list) w.group ? counts.set(w.group, (counts.get(w.group) || 0) + 1) : none++;
    $('#tw-groups', body).innerHTML = `<div class="tg-h">Groups</div>
      <button type="button" data-g="" class="${!group && !noGroup ? 'on' : ''}"><span>All wallets</span><b>${list.length}</b></button>
      ${groups().map((g) => `<button type="button" data-g="${esc(g)}" class="${group === g ? 'on' : ''}"><span>${esc(g)}</span><b>${counts.get(g)}</b></button>`).join('')}
      ${none && counts.size ? `<button type="button" data-none class="${noGroup ? 'on' : ''}"><span>No group</span><b>${none}</b></button>` : ''}
      ${counts.size ? '' : '<p class="tg-hint">Give a wallet a group when you add or edit it, and the group shows up here.</p>'}`;
    // no wallets: no sidebar and no toolbar, the empty state carries the actions; no groups: no phone group row
    wrap.classList.toggle('is-empty', !list.length); wrap.classList.toggle('no-grp', !counts.size);
    $('#tw-glist', body).innerHTML = groups().map((g) => `<option value="${esc(g)}">`).join('');
    const tabCount = $('.trk-tabs a b', root); if (tabCount) tabCount.textContent = list.length;
  }
  const visible = () => {
    const s = q.toLowerCase();
    return list.filter((w) => (noGroup ? !w.group : !group || w.group === group) && (!s || w.address.toLowerCase().includes(s) || w.name.toLowerCase().includes(s) || w.group.toLowerCase().includes(s)));
  };
  function rowHtml(w, cfg) {
    const c = cfg[w.address], a = esc(w.address);
    return `<tr data-addr="${a}">
      <td class="tw-who"><span class="trk-emo">${w.emoji ? esc(w.emoji) : '<i></i>'}</span><span class="tw-id"><b>${esc(w.name || short(w.address))}</b><span class="mono dim">${esc(short(w.address, 5))}<button type="button" class="copy" data-copy="${a}" title="Copy address">${ICON.copy}</button><a href="https://solscan.io/account/${a}" target="_blank" rel="noopener" title="Open on Solscan" class="trk-ext">↗</a></span></span></td>
      <td>${w.group ? `<span class="trk-grp">${esc(w.group)}</span>` : '<span class="dim">—</span>'}</td>
      <td class="num" data-bal>${balHtml(balCache.get(w.address))}</td>
      <td class="num" data-act>${actHtml(actCache.get(w.address))}</td>
      ${['feed', 'alert', 'sound'].map((k) => `<td class="c" data-l="${k}"><button type="button" class="trk-sw${w[k] ? ' on' : ''}" data-tog="${k}" aria-pressed="${w[k]}" aria-label="${k}" title="${TOG[k]}"><i></i></button></td>`).join('')}
      <td class="c" data-l="copy"><button type="button" class="trk-cp${c?.on ? ' on' : ''}" data-copycfg title="${c?.on ? 'Copy trading is on: review or turn off' : 'Copy trading is off: set it up'}">${c?.on ? 'On' : 'Off'}</button></td>
      <td class="tw-act"><button type="button" class="trk-lnk" data-edit>Edit</button><button type="button" class="trk-lnk down" data-del>Remove</button></td>
    </tr>`;
  }
  function drawRows() {
    io?.disconnect();
    if (!list.length) {
      scroll.innerHTML = emptyWithGhost('tw', {
        ic: 'radar', title: 'Follow wallets you trust', body: 'The list stays in this browser.',
        steps: ['Add a wallet address, or import a list you already keep.', 'Get a notice on any page when one of them buys or sells.', 'Monitor shows the coins that two or more of them hold.'],
        acts: '<button type="button" class="btn btn-accent" data-es="add">Add wallet</button><button type="button" class="btn" data-es="import">Import list</button><a class="btn btn-ghost" href="#/track/vision">Browse Vision →</a>',
      });
      return;
    }
    const rows = visible(), cfg = copyCfg();
    if (!rows.length) {
      scroll.innerHTML = emptyHtml({ cls: 'sm', title: 'No wallet matches', body: q ? `Nothing here matches “${esc(q)}”.` : 'This group is empty.', acts: q ? '<button type="button" class="btn" data-es="clear">Clear search</button>' : '' });
      return;
    }
    scroll.innerHTML = `<table class="trk-t tw-t"><thead><tr>${HEAD.tw}</tr></thead>
      <tbody>${rows.slice(0, shown).map((w) => rowHtml(w, cfg)).join('')}</tbody></table>
      ${rows.length > shown ? `<div class="trk-more"><button type="button" class="btn" id="tw-more">Show ${Math.min(200, rows.length - shown)} more of ${rows.length - shown}</button></div>` : ''}`;
    $('#tw-more', scroll)?.addEventListener('click', () => { shown += 200; drawRows(); });
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const addr = e.target.dataset.addr;
        wantRow(addr, () => {
          if (!ctx.alive()) return;
          const tr = scroll.querySelector(`tr[data-addr="${addr}"]`); if (!tr) return;
          tr.querySelector('[data-bal]').innerHTML = balHtml(balCache.get(addr));
          tr.querySelector('[data-act]').innerHTML = actHtml(actCache.get(addr));
        });
      }
    }, { root: scroll, rootMargin: '120px 0px' });
    $$('tbody tr', scroll).forEach((tr) => io.observe(tr));
  }
  const draw = () => { drawGroups(); drawRows(); };
  draw();

  $('#tw-groups', body).addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    noGroup = b.hasAttribute('data-none'); group = noGroup ? '' : b.dataset.g || ''; shown = 200;
    LS.set('track.group', group); draw();
  });
  $('#tw-q', body).addEventListener('input', (e) => { clearTimeout(qt); qt = setTimeout(() => { q = e.target.value.trim(); shown = 200; drawRows(); }, 120); });
  const form = $('#tw-add', body), err = $('#tw-add-err', body);
  const showForm = (open) => { form.hidden = !open; if (open) { if (group && !form.group.value) form.group.value = group; form.address.focus(); } };
  $('#tw-add-btn', body).addEventListener('click', () => showForm(form.hidden));
  if (addNext) { addNext = false; showForm(true); }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const a = form.address.value.trim();
    err.textContent = '';
    if (!isMint(a)) { err.textContent = 'That is not a Solana address (base58, 32 to 44 characters).'; return; }
    if (index.has(a)) { err.textContent = `Already tracked as ${index.get(a).name || short(a)}.`; return; }
    if (list.length >= MAX_TRACKED) { err.textContent = `You can track up to ${MAX_TRACKED} wallets.`; return; }
    addWallets([{ address: a, name: form.name.value, emoji: form.emoji.value, group: form.group.value, feed: true }]);
    toast(`Tracking <b>${esc(str(form.name.value, 40) || short(a))}</b>`, 'ok');
    form.address.value = ''; form.name.value = ''; form.emoji.value = '';
    draw();
  });
  // Export ▾: a small menu (arrow keys move, Escape or a click elsewhere closes it)
  const expBtn = $('#tw-exp-btn', body), expM = $('#tw-exp-m', body), opts = () => $$('[data-exp]', expM);
  const menu = (open) => { expM.hidden = !open; expBtn.setAttribute('aria-expanded', String(open)); if (open) opts()[0]?.focus(); };
  expBtn.addEventListener('click', () => menu(expM.hidden));
  expM.addEventListener('click', (e) => {
    const b = e.target.closest('[data-exp]'); if (!b) return;
    menu(false); expBtn.focus();
    const items = visible();
    if (!items.length) { toast('Nothing to export yet.', 'err'); return; }
    exportAs(b.dataset.exp, items);
  });
  $('#tw-exp', body).addEventListener('keydown', (e) => {
    if (expM.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menu(false); expBtn.focus(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const l = opts(), i = l.indexOf(document.activeElement);
    l[(i + (e.key === 'ArrowDown' ? 1 : -1) + l.length) % l.length].focus();
  });
  const outside = (e) => { if (!expM.hidden && !e.target.closest?.('#tw-exp')) menu(false); };
  document.addEventListener('pointerdown', outside, true);
  $('#tw-imp', body).addEventListener('click', () => openImport(root, () => { if (ctx.alive()) draw(); }));
  scroll.addEventListener('click', (e) => {
    const es = e.target.closest('[data-es]');
    if (es) {
      const k = es.dataset.es;
      if (k === 'add') showForm(true);
      else if (k === 'import') openImport(root, () => { if (ctx.alive()) draw(); });
      else if (k === 'clear') { const qi = $('#tw-q', body); qi.value = ''; q = ''; shown = 200; drawRows(); qi.focus(); }
      return;
    }
    const tr = e.target.closest('tr[data-addr]'); if (!tr) return;
    const w = index.get(tr.dataset.addr); if (!w) return;
    const tog = e.target.closest('[data-tog]');
    if (tog) {
      const k = tog.dataset.tog; w[k] = !w[k]; save();
      tog.classList.toggle('on', w[k]); tog.setAttribute('aria-pressed', String(w[k]));
      if (k === 'sound' && w.sound) previewSound(); // a preview, and it unlocks audio for later
      return;
    }
    if (e.target.closest('[data-copycfg]')) { openCopy(root, w, () => { if (ctx.alive()) drawRows(); }); return; }
    if (e.target.closest('[data-edit]')) { openEdit(root, w, groups(), () => { if (ctx.alive()) draw(); }); return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!del.dataset.sure) { del.dataset.sure = '1'; del.textContent = 'Confirm'; del.classList.add('sure'); setTimeout(() => { if (del.isConnected) { delete del.dataset.sure; del.textContent = 'Remove'; del.classList.remove('sure'); } }, 3000); return; }
      list = list.filter((x) => x.address !== w.address);
      save(); if (copyCfg()[w.address]) setCopy(w.address, null);
      draw();
      toast(`Stopped tracking <b>${esc(w.name || short(w.address))}</b>`);
    }
  });
  ctx.on('tracked-copy', drawRows);
  return () => { io?.disconnect(); clearTimeout(qt); document.removeEventListener('pointerdown', outside, true); };
}

function openEdit(root, w, groups, done) {
  const d = dialog(root, `<form method="dialog" class="dlg" autocomplete="off">
    <h2>Edit wallet</h2>
    <p class="hint mono trk-addr">${esc(w.address)}</p>
    <label>Name<input name="name" maxlength="40" value="${esc(w.name)}"></label>
    <div class="trk-2"><label>Emoji<input name="emoji" maxlength="16" value="${esc(w.emoji)}"></label><label>Group<input name="group" maxlength="24" list="te-glist" value="${esc(w.group)}"></label></div>
    <datalist id="te-glist">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
    <div class="row-end"><button type="button" class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-accent" value="ok" data-save>Save</button></div>
  </form>`);
  const f = $('form', d);
  $('[data-save]', d).addEventListener('click', () => { w.name = str(f.name.value, 40); w.emoji = emo(f.emoji.value); w.group = str(f.group.value, 24); save(); done(); });
}

function openImport(root, done) {
  const d = dialog(root, `<form method="dialog" class="dlg trk-imp">
    <h2>Import wallets</h2>
    <p class="hint">Paste a JSON array, CSV with columns address,name,emoji,group (header optional), or one address per line. Wallets you already track are skipped.</p>
    <textarea id="ti-text" rows="7" spellcheck="false" placeholder="[{&quot;address&quot;: &quot;…&quot;, &quot;name&quot;: &quot;…&quot;, &quot;emoji&quot;: &quot;…&quot;, &quot;group&quot;: &quot;…&quot;}]"></textarea>
    <div class="trk-2"><label>Or open a file<input type="file" id="ti-file" accept=".json,.csv,.txt,text/plain,text/csv,application/json"></label><label>Group for rows without one<input id="ti-group" maxlength="24" placeholder="optional"></label></div>
    <div class="trk-prev" id="ti-prev">Nothing to import yet.</div>
    <div class="row-end"><button class="btn btn-ghost" value="cancel">Cancel</button><button type="button" class="btn btn-accent" id="ti-go" disabled>Import</button></div>
  </form>`);
  const ta = $('#ti-text', d), prev = $('#ti-prev', d), go = $('#ti-go', d);
  let res = { ok: [] };
  const check = () => {
    try {
      res = checkImport(parseImport(ta.value), str($('#ti-group', d).value, 24));
      const room = MAX_TRACKED - list.length;
      prev.innerHTML = ta.value.trim() ? `<b class="up">${res.ok.length} new</b> · ${res.dup} already tracked · <span class="${res.bad ? 'down' : ''}">${res.bad} not valid</span>${res.ok.length > room ? ` · only ${room} fit` : ''}` : 'Nothing to import yet.';
    } catch (e) { res = { ok: [] }; prev.innerHTML = `<span class="down">${esc(e.message)}</span>`; }
    go.disabled = !res.ok.length;
    go.textContent = res.ok.length ? `Import ${res.ok.length}` : 'Import';
  };
  ta.addEventListener('input', check);
  $('#ti-group', d).addEventListener('input', check);
  $('#ti-file', d).addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (f.size > 2e6) { prev.innerHTML = '<span class="down">That file is over 2 MB.</span>'; return; }
    try { ta.value = await f.text(); } catch { prev.innerHTML = '<span class="down">That file could not be read.</span>'; return; }
    check();
  });
  go.addEventListener('click', () => { const n = addWallets(res.ok); toast(`Imported ${n} wallet${n === 1 ? '' : 's'}.`, 'ok'); d.close(); done(); });
}

// ---- copy trading: setup dialog (hard to switch on, one click to switch off) ----
const copySummary = (c) => `${c.mode === 'pct' ? `${Number(c.pct)}% of their SOL per buy` : `${Number(c.amount)} SOL per buy`}, never more than ${Number(c.cap)} SOL a trade or ${Number(c.daily)} SOL a day, paid from ${esc(short(String(c.owner)))}. ${c.sells ? 'Sells are copied too, only out of what copying them bought.' : 'Buys only.'}${Number(c.minSrc) > 0 ? ` Their buys under ${Number(c.minSrc)} SOL are ignored.` : ''}`;
async function openCopy(root, w, done) {
  const name = who(w, w.address), cur = copyCfg()[w.address];
  if (cur?.on) {
    const bad = cfgError(cur) || ((await stampState(w.address, cur)) === 'ok' ? '' : 'This setup was not made in this browser, so it never copies.');
    const d = dialog(root, `<form method="dialog" class="dlg">
      <h2>Copying ${w.emoji ? esc(w.emoji) + ' ' : ''}${name}</h2>
      ${bad ? `<p class="hint trk-bad">${esc(bad)} Turn it off and set it up again.</p>` : ''}
      <p class="hint">${copySummary(cur)}</p>
      <p class="hint">Spent today: <b class="mono">${solTxt(spentToday(w.address))}</b> of ${Number(cur.daily)} SOL.</p>
      <div class="row-end"><button class="btn btn-ghost" value="cancel">Close</button><button type="button" class="btn trk-danger" data-off>Turn off copy trading</button></div>
    </form>`);
    $('[data-off]', d).addEventListener('click', () => { setCopy(w.address, null); toast(`Copy trading is off for <b>${name}</b>.`, 'ok'); d.close(); done(); });
    return;
  }
  const info = (title, text, btn) => {
    const d = dialog(root, `<form method="dialog" class="dlg"><h2>${title}</h2><p class="hint">${text}</p><div class="row-end"><button class="btn btn-ghost" value="cancel">Close</button>${btn ? `<button type="button" class="btn btn-accent" data-go>${btn}</button>` : ''}</div></form>`);
    $('[data-go]', d)?.addEventListener('click', () => { d.close(); import('../ui/wallets.js').then((m) => m.openWalletManager('new')).catch(() => toast('The wallet manager did not load.', 'err')); });
  };
  if (!V.supported()) { info('Copy trading needs a local wallet', 'Copies are signed in this tab by a local wallet, and local wallets need a secure (https) page. Open Nought over https to use them.'); return; }
  if (!globalThis.navigator?.locks?.request) { info('Copy trading needs a newer browser', 'Nought keeps copy trading to one tab and shares its limits between tabs with Web Locks, which this browser does not have. Update it to use copy trading.'); return; }
  let locals = [];
  try { locals = await V.list(); } catch { /* none */ }
  if (!locals.length) { info('Copy trading needs a local wallet', 'Copies are signed in this tab without a pop-up, so they need a local wallet that lives in this browser. Create one, fund it with only what you are ready to lose, then come back.', 'Create a local wallet'); return; }
  const p = preset();
  const d = dialog(root, `<form method="dialog" class="dlg trk-copy" autocomplete="off">
    <h2>Copy ${w.emoji ? esc(w.emoji) + ' ' : ''}${name}</h2>
    <div class="trk-risk">
      <b>Read this first</b>
      <ul>
        <li>When this wallet buys, Nought buys the same coin from your local wallet <b>without asking you each time</b>.</li>
        <li>You can lose everything you put in. Copies fill after theirs, at a worse price, and the wallet you copy may sell into you.</li>
        <li>Tracked wallets can be bots, insiders, or set up to bait copiers.</li>
        <li>It only runs while a Trackers page is open (in one tab) and your local wallets are unlocked.</li>
        <li>Nought fee 0%. Each copy still pays network and priority fees and the pool's own fees.</li>
      </ul>
    </div>
    <label>Pay from (local wallet)<select name="owner">${locals.map((l) => `<option value="${esc(l.address)}">${esc(l.name || 'Wallet')} · ${esc(short(l.address))}</option>`).join('')}</select></label>
    <div class="trk-2">
      <div class="trk-fld"><span>Amount per buy</span><span class="trk-mode"><label class="check"><input type="radio" name="mode" value="fixed" checked> Fixed SOL</label><label class="check"><input type="radio" name="mode" value="pct"> % of theirs</label></span></div>
      <label><span data-amt-l>SOL per buy</span><input name="amount" inputmode="decimal" value="0.05"></label>
    </div>
    <div class="trk-2">
      <label>Most per trade (SOL)<input name="cap" inputmode="decimal" value="0.1"></label>
      <label>Most per day (SOL)<input name="daily" inputmode="decimal" value="0.5"></label>
    </div>
    <label>Skip their buys under (SOL)<input name="minSrc" inputmode="decimal" value="0.05"></label>
    <label class="check"><input type="checkbox" name="sells"> Also copy sells (sells the same share of what copying this wallet bought; coins you bought yourself are never sold)</label>
    <p class="hint">Slippage ${esc(String(p.slippage))}% and priority from preset ${esc(p.name)}${p.mev === 'protected' ? ' (MEV-protected through Jupiter Ultra, which charges its own fee)' : ''}. A copy waits until a second RPC confirms their trade, is refused above ${LIM.buyImpact}% price impact, at most ${LIM.rate} run a minute, and all copying together stops at ${LIM.allDaily} SOL a day.</p>
    <div class="trk-sum" id="tc-sum"></div>
    <label class="check"><input type="checkbox" name="ack"> I understand Nought will spend from this wallet automatically.</label>
    <label>Type COPY to switch it on<input name="confirm" placeholder="COPY" spellcheck="false" class="mono" autocomplete="off"></label>
    <span class="trk-err" id="tc-err" role="alert"></span>
    <div class="row-end"><button class="btn btn-ghost" value="cancel">Cancel</button><button type="button" class="btn trk-warn" id="tc-go" disabled>Turn on copy trading</button></div>
  </form>`, 'trk-dlg-wide');
  const f = $('form', d), go = $('#tc-go', d), err = $('#tc-err', d), sum = $('#tc-sum', d);
  const read = () => {
    const mode = f.mode.value === 'pct' ? 'pct' : 'fixed', a = parseAmount(f.amount.value);
    const c = { on: true, owner: f.owner.value, mode, amount: mode === 'fixed' ? a : 0, pct: mode === 'pct' ? a : 0, cap: parseAmount(f.cap.value), daily: parseAmount(f.daily.value), minSrc: f.minSrc.value.trim() ? parseAmount(f.minSrc.value) : 0, sells: f.sells.checked, since: Date.now() };
    const unread = [[a, mode === 'pct' ? 'the share' : 'the amount per buy'], [c.cap, 'most per trade'], [c.daily, 'most per day'], [c.minSrc, 'the minimum']].find(([v]) => Number.isNaN(v));
    const bad = !locals.some((l) => l.address === c.owner) ? 'Pick a local wallet.' : unread ? `Type ${unread[1]} as a plain number, like 0.05 or 0,05.` : cfgError(c);
    return { c, bad };
  };
  const check = () => {
    $('[data-amt-l]', d).textContent = f.mode.value === 'pct' ? '% of their SOL' : 'SOL per buy';
    const { c, bad } = read();
    err.textContent = bad;
    sum.innerHTML = bad ? '' : `<b>You are setting:</b> ${copySummary(c)}${w.feed ? '' : ' This also turns on Feed for this wallet.'}`;
    go.disabled = !!bad || !f.ack.checked || f.confirm.value.trim() !== 'COPY';
  };
  f.addEventListener('input', check); f.addEventListener('change', check); check();
  go.addEventListener('click', async () => {
    const { c, bad } = read();
    if (bad || !f.ack.checked || f.confirm.value.trim() !== 'COPY') return;
    go.disabled = true;
    try { c.stamp = await makeStamp(w.address, c); } catch { err.textContent = 'This browser could not save the setup (site data may be blocked). Copy trading stays off.'; return; }
    if (!d.open) return;
    if (!w.feed) { w.feed = true; save(); }
    setCopy(w.address, c);
    toast(`Copy trading is on for <b>${name}</b>. It stops when you leave Trackers.`, 'ok');
    d.close(); done();
  });
}

// ---- copy trading: the engine. One copy at a time, in the one tab that holds the 'nought-copy-engine' Web Lock
// while its Trackers page is mounted; other tabs queue for the lock and take over when that page closes. ----
const copyState = { seen: new Set(), lockedNote: 0, chain: Promise.resolve(), mode: 'off', note: null };
// onState('lead' | 'wait' | 'none'); returns the release
function leadCopy(onState) {
  const L = globalThis.navigator?.locks;
  if (!L?.request) { onState('none'); return () => {}; }
  const ac = new AbortController();
  let release = null, gone = false;
  const t = setTimeout(() => { if (!release && !gone) onState('wait'); }, 300);
  L.request('nought-copy-engine', { signal: ac.signal }, () => new Promise((res) => { if (gone) { res(); return; } release = res; onState('lead'); })).catch(() => { /* aborted while queued */ });
  return () => { gone = true; clearTimeout(t); ac.abort(); release?.(); };
}
function copyNote(text) { copyState.note = { at: Date.now(), text }; emit('tracked-copylog'); }
// trade() with detail → {status, sig?, err?, before}. status 'ok' | 'failed' (also: expired unlanded) | 'unknown' |
// 'aborted' (stopped before signing) | 'error' (threw). before: provably nothing was signed (trade.js marks every
// error from signing onwards with e.signing). A send that may still land is followed, never retried.
async function send(side, ev, c, raw, label, maxImpactPct) {
  try {
    const r = await trade(side, ev.mint, raw, { owner: c.owner, maxImpactPct, label, detail: true });
    const x = r && typeof r === 'object' ? r : { status: r ? 'ok' : 'unknown' };
    return { status: x.status, sig: x.sig, before: x.status === 'aborted' };
  } catch (e) {
    if (e?.maybeSent && isSig(e.sig)) return { status: await confirm(e.sig), sig: e.sig, before: false };
    return { status: 'error', err: e, before: !e?.signing && !e?.maybeSent && !e?.sig };
  }
}
// raw tokens a confirmed buy put in owner's accounts, read from the transaction; else the logged quote less slippage
// (no more than the swap guaranteed); else 0, and copied sells then leave that buy alone
async function boughtRaw(sig, owner, mint) {
  if (!isSig(sig)) return 0n;
  const sum = (l) => (Array.isArray(l) ? l : []).filter((b) => b?.owner === owner && b?.mint === mint && /^\d{1,30}$/.test(b.uiTokenAmount?.amount)).reduce((t, b) => t + BigInt(b.uiTokenAmount.amount), 0n);
  for (let i = 0; i < 4; i++) {
    try {
      const m = (await rpc('getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]))?.meta;
      if (m) { const d = m.err ? 0n : sum(m.postTokenBalances) - sum(m.preTokenBalances); return d > 0n ? d : 0n; }
    } catch { /* not served yet */ }
    await sleep(1500);
  }
  const q = Number(tradeLog().find((t) => t?.sig === sig)?.tokensRaw), slip = Math.min(50, Math.max(0, Number(preset().slippage) || 0));
  return q > 0 && isFinite(q) ? BigInt(Math.floor(q * (1 - slip / 100))) : 0n;
}
const OUTCOME = { failed: ['fail', 'Did not land (failed or expired, often slippage).'], unknown: ['fail', 'Sent, but not confirmed yet. Check your wallet.'], aborted: ['skip', 'Stopped before signing.'] };
async function copyBuy(ev, c, label, name) {
  let r;
  try { r = await reserve(ev, c); } catch (e) { logCopy(ev, 'skip', e?.message || 'Could not book the copy.'); return; }
  if (r.skip) { logCopy(ev, 'skip', r.skip); return; }
  const x = r.x, lamports = BigInt(Math.round(x * 1e9));
  toast(`Copying <b>${name}</b>: buying ${esc(label)} for <b class="mono">${x} SOL</b> from ${esc(short(c.owner))}`);
  const s = await send('buy', ev, c, lamports, label, LIM.buyImpact);
  // the day's spend is only given back when provably nothing was signed; a trade that may have landed keeps it
  if (s.before) await refund(ev.wallet, x).catch(() => {});
  if (s.status === 'ok') {
    const got = await boughtRaw(s.sig, c.owner, ev.mint);
    if (got > 0n) await addHeld(heldKey(c.owner, ev.mint, ev.wallet), got).catch(() => {});
    logCopy(ev, 'ok', got > 0n ? 'Bought.' : 'Bought. The amount could not be read, so copied sells leave it alone.', x);
  } else if (s.status === 'error') {
    logCopy(ev, s.before ? 'skip' : 'fail', s.err?.message || 'The trade did not go through.', x);
    if (!s.before) toast(`Copy failed: ${esc(s.err?.message || 'the trade did not go through.')}`, 'err');
  } else logCopy(ev, ...(OUTCOME[s.status] || OUTCOME.unknown), x);
}
// sells the copied wallet's share (pctSold) of what copying it bought, never coins bought by hand
async function copySell(ev, c, label) {
  const k = heldKey(c.owner, ev.mint, ev.wallet);
  if (!(BigInt(held()[k]?.raw || '0') > 0n)) { logCopy(ev, 'skip', 'Nothing bought by copying this wallet to sell.'); return; }
  let h;
  try { h = await holding(ev.mint, c.owner); } catch (e) { logCopy(ev, 'skip', e?.message || 'Could not read your balance.'); return; }
  if (h.frozen) { logCopy(ev, 'skip', 'This coin is frozen in your wallet.'); return; }
  const pct = Math.min(100, Math.max(1, Number(ev.pctSold) || 100));
  let raw;
  try { raw = await takeHeld(k, h.raw, pct); } catch (e) { logCopy(ev, 'skip', e?.message || 'Could not book the sale.'); return; }
  if (!(raw > 0n)) { logCopy(ev, 'skip', 'What copying bought here is already sold.'); return; }
  const s = await send('sell', ev, c, raw, label, LIM.sellImpact);
  // the tally comes back only when the tokens provably did not move: nothing signed, or the sale did not land
  if (s.before || s.status === 'failed') await addHeld(k, raw).catch(() => {});
  if (s.status === 'ok') logCopy(ev, 'ok', `Sold ${Math.round(pct)}% of what copying bought.`);
  else if (s.status === 'error') logCopy(ev, s.before ? 'skip' : 'fail', s.err?.message || 'Could not sell.');
  else logCopy(ev, ...(OUTCOME[s.status] || OUTCOME.unknown));
}
async function run(ev) {
  const wanted = () => { const x = copyCfg()[ev.wallet]; return x?.on && copyState.mode === 'lead' && index.has(ev.wallet) && (ev.side === 'buy' || (ev.side === 'sell' && x.sells)) ? x : null; };
  // re-read: it may have been switched off (or this tab may have stopped copying) while this copy waited its turn
  if (!wanted() || !isMint(ev.mint) || SKIP.has(ev.mint)) return;
  try { if (!(await claim(ev.sig))) return; } catch (e) { copyNote(e?.message || 'Copy trading is paused.'); return; } // false: another tab took it
  const c = wanted(); if (!c) return;
  const label = '$' + sym(tokens.get(ev.mint), ev.mint), name = who(index.get(ev.wallet), ev.wallet);
  const bad = cfgError(c);
  if (bad) { logCopy(ev, 'skip', `Setup outside Nought's limits (${bad}) Set it up again.`); return; }
  const st = await stampState(ev.wallet, c);
  if (st !== 'ok') { logCopy(ev, 'skip', st === 'bad' ? 'This setup was not made in this browser.' : 'Could not check this setup in this browser.'); return; }
  const old = () => !(Date.now() - ev.at <= LIM.maxAgeMs);
  if (old()) { logCopy(ev, 'skip', 'Their trade was over 90 s old.'); return; }
  if (!V.isUnlocked()) {
    logCopy(ev, 'skip', 'Local wallets were locked.');
    if (Date.now() - copyState.lockedNote > 300e3) { copyState.lockedNote = Date.now(); toast(`Copy skipped for <b>${name}</b>: unlock your local wallets to copy.`, 'err'); }
    return;
  }
  let owners = []; try { owners = (await V.list()).map((x) => x.address); } catch { /* none */ }
  if (!owners.includes(c.owner)) { logCopy(ev, 'skip', 'The paying wallet is no longer in this browser.'); return; }
  if (ev.side === 'buy' && !(typeof ev.sol === 'number' && ev.sol > 0)) { logCopy(ev, 'skip', 'Their buy amount was unreadable.'); return; }
  if (ev.side === 'buy' && ev.sol < c.minSrc) { logCopy(ev, 'skip', `Their buy (${solTxt(ev.sol)} SOL) was under your minimum.`); return; }
  // a second RPC host must see the same trade before anything is spent (fail closed)
  let real = false;
  try { real = typeof logs.verifyTrade === 'function' && (await logs.verifyTrade(ev)) === true; } catch { /* doubt = no */ }
  if (!real) {
    logCopy(ev, 'skip', 'A second RPC did not confirm their trade.');
    copyNote(`Skipped ${index.get(ev.wallet)?.name || short(ev.wallet)}'s ${ev.side} of ${label}: a second RPC did not confirm it.`);
    return;
  }
  if (old()) { logCopy(ev, 'skip', 'Their trade was over 90 s old.'); return; }
  if (wanted()?.stamp !== c.stamp) return; // switched off or changed during the checks
  if (ev.side === 'buy') await copyBuy(ev, c, label, name); else await copySell(ev, c, label);
}
function copyEngine() {
  return (ev) => {
    if (copyState.mode !== 'lead' || !ev || ev.backfill || !isSig(ev.sig) || copyState.seen.has(ev.sig)) return;
    const c = copyCfg()[ev.wallet];
    if (!c?.on || !index.has(ev.wallet) || (ev.side === 'sell' && !c.sells)) return;
    copyState.seen.add(ev.sig);
    if (copyState.seen.size > 2000) copyState.seen.delete(copyState.seen.values().next().value);
    copyState.chain = copyState.chain.then(() => run(ev)).catch(() => {});
  };
}

// ================= Live =================
function mountLive(ctx) {
  const { body } = ctx;
  const saved = LS.get('track.filters', {}), f = { side: 'all', minSol: '', maxSol: '', minMc: '', maxMc: '' };
  for (const k of Object.keys(f)) if (typeof saved?.[k] === 'string') f[k] = saved[k].slice(0, 12);
  if (!['all', 'buy', 'sell'].includes(f.side)) f.side = 'all';
  body.innerHTML = `<div class="trk-live">
    <div class="trk-tools">
      <div class="trk-seg" id="tl-side" role="group" aria-label="Side">${[['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']].map(([v, l]) => `<button type="button" data-side="${v}" class="${f.side === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${[['minSol', 'Min SOL', 'Minimum SOL'], ['maxSol', 'Max SOL', 'Maximum SOL'], ['minMc', 'Min MC $', 'Minimum market cap (USD)'], ['maxMc', 'Max MC $', 'Maximum market cap (USD)']].map(([k, l, a]) => `<label class="trk-fx"><span>${l}</span><input data-f="${k}" placeholder="any"${/Sol$/.test(k) ? ' inputmode="decimal"' : ''} value="${esc(f[k])}" aria-label="${a}"></label>`).join('')}
      <button type="button" class="btn" id="tl-back" title="Decode the last few transactions of your feed wallets">Load recent</button>
      <span class="trk-note" id="tl-note"></span>
    </div>
    <div class="trk-copylog" id="tl-copy" hidden></div>
    <div class="trk-scroll" id="tl-scroll"></div>
  </div>`;
  const scroll = $('#tl-scroll', body), pane = $('.trk-live', body);
  const mcOf = (x) => { if (x.mcUsd > 0) return x.mcUsd; const t = tokens.get(x.mint), s = t?.circSupply || t?.totalSupply; return s && x.priceSol > 0 && solUsd() > 0 ? x.priceSol * solUsd() * s : null; };
  const pass = (x) => {
    if (f.side !== 'all' && x.side !== f.side) return false;
    const a = parseAmount(f.minSol), b = parseAmount(f.maxSol), c = parseTarget(f.minMc), d = parseTarget(f.maxMc);
    if (a > 0 && x.sol < a) return false;
    if (b > 0 && x.sol > b) return false;
    if (c > 0 || d > 0) { const mc = mcOf(x); if (!(mc > 0) || (c > 0 && mc < c) || (d > 0 && mc > d)) return false; }
    return true;
  };
  let shownSigs = null, waiting = false; // waiting: a visible row still lacks its token name or market cap
  function draw() {
    waiting = false;
    const feedN = list.filter((w) => w.feed).length;
    pane.classList.toggle('is-empty', !feedN); // nothing to filter yet: the toolbar steps aside
    if (!list.length) {
      scroll.innerHTML = emptyWithGhost('tl', {
        ic: 'live', title: 'Watch their trades land', body: 'Every swap of the wallets you follow, the moment it confirms.',
        steps: ['Track a wallet, or pick traders from Vision.', 'Keep Feed on for the wallets you want here.', 'Buys and sells show up with the market cap at fill.'],
        acts: '<a class="btn btn-accent" href="#/track/wallets" data-es="add">Add wallet</a><a class="btn btn-ghost" href="#/track/vision">Browse Vision →</a>',
      });
      return;
    }
    if (!feedN) {
      scroll.innerHTML = emptyWithGhost('tl', { ic: 'live', title: 'No wallet is in the feed', body: 'Switch on Feed for a wallet on the Wallets tab, and its swaps show up here.', acts: '<a class="btn" href="#/track/wallets">Open Wallets</a>' });
      return;
    }
    const all = logs.recentTrades(), rows = all.filter(pass).slice(0, 200);
    if (!rows.length) {
      scroll.innerHTML = all.length
        ? emptyHtml({ cls: 'sm', title: 'No trade matches these filters', body: `${all.length} trade${all.length > 1 ? 's' : ''} hidden. Loosen the filters to see more.`, acts: '<button type="button" class="btn" data-es="clear">Clear filters</button>' })
        : emptyWithGhost('tl', { ic: 'live', cls: 'trk-es-live', title: `Listening to ${feedN} wallet${feedN > 1 ? 's' : ''}`, body: 'Swaps show up here the moment they confirm. Load recent decodes their last few transactions.', acts: '<button type="button" class="btn" data-es="back">Load recent</button>' });
      return;
    }
    const prev = shownSigs; shownSigs = new Set(rows.map((x) => x.sig));
    scroll.innerHTML = `<table class="trk-t tl-t"><thead><tr>${HEAD.tl}</tr></thead><tbody>${rows.map((x) => {
      // the mint string comes from a decoded transaction: only a real address gets a link or a buy button
      const okMint = isMint(x.mint), m = String(x.mint ?? ''), side = x.side === 'sell' ? 'sell' : 'buy', at = Number(x.at) || 0;
      const w = index.get(x.wallet), t = (okMint && tokens.get(m)) || { mint: m, symbol: x.symbol, image: x.image }, mc = mcOf(x), e = w?.emoji || x.emoji;
      if (!t.symbol || !mc) waiting = true;
      return `<tr class="${side}${prev && !prev.has(x.sig) ? ' new' : ''}">
        <td class="mono"><span data-age="${at}">${ago(at)}</span></td>
        <td class="tl-who"><span class="trk-emo sm">${e ? esc(e) : '<i></i>'}</span><span class="nm">${esc(w?.name || x.name || short(x.wallet))}</span></td>
        <td><span class="trk-side ${side}">${side === 'buy' ? 'Buy' : 'Sell'}</span>${x.backfill ? '<span class="trk-bf" title="Loaded from history, not live">past</span>' : ''}</td>
        <td><span class="tl-tok"${okMint ? ` data-mint="${esc(m)}" title="Open ${esc(t.name || sym(t, m))}"` : ''}>${avatar({ ...t, mint: m, symbol: t.symbol || short(m, 2) }, 'xs')}<b>${esc(sym(t, m))}</b></span></td>
        <td class="num ${side === 'buy' ? 'up' : 'down'}">${x.quote && x.quote !== 'SOL' ? `<span class="trk-bf" title="Paid in ${esc(x.quote)}; shown in SOL at the current price">${esc(x.quote)}</span> ≈` : ''}${solTxt(x.sol)}</td>
        <td class="num">${mc ? usd(mc) : '<span class="dim">—</span>'}</td>
        <td class="c">${isSig(x.sig) ? `<a class="trk-ext" href="https://solscan.io/tx/${esc(x.sig)}" target="_blank" rel="noopener" title="Open the transaction on Solscan">↗</a>` : ''}</td>
        <td class="c">${okMint && !SKIP.has(m) ? qbButton(m) : ''}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
  }
  function note() {
    const s = liveStatus(), el = $('#tl-note', body); if (!el) return;
    el.textContent = s.watching ? `${s.swaps} swap${s.swaps === 1 ? '' : 's'} decoded this session${s.queue ? ` · decoding ${s.queue}` : ''}${s.dropped ? ` · ${s.dropped} skipped from very busy wallets` : ''}` : '';
  }
  function copyPanel() {
    const el = $('#tl-copy', body); if (!el) return;
    const l = copyLog().slice(0, 4);
    el.hidden = !copyOn().length && !l.length;
    if (el.hidden) return;
    const row = (x) => {
      const side = x.side === 'sell' ? 'sell' : 'buy', res = ['ok', 'fail'].includes(x.result) ? x.result : 'skip', at = Number(x.at) || 0;
      return `<li class="${res}" title="${esc(x.note)}"><i></i><span class="mono dim tcl-t" data-age="${at}">${ago(at)}</span><span class="tcl-w">${esc(index.get(x.wallet)?.name || short(String(x.wallet ?? '')))}</span><span class="trk-side ${side}">${side}</span><span class="mono tcl-s">${esc(sym(tokens.get(x.mint), String(x.mint ?? '')))}</span>${Number(x.sol) > 0 ? `<span class="mono">${solTxt(Number(x.sol))} SOL</span>` : ''}<span class="tcl-n">${esc(x.note)}</span></li>`;
    };
    el.innerHTML = `<div class="tcl-h"><b>Copy log</b><span class="dim">${l.length ? `latest ${l.length}` : ''}</span></div>${l.length ? `<ul class="tcl">${l.map(row).join('')}</ul>` : '<span class="dim">Nothing copied yet.</span>'}`;
  }
  draw(); note(); copyPanel();
  ctx.on('tracker-trade', ctx.throttle(draw, 300));
  const lateDraw = ctx.throttle(() => { if (waiting) draw(); }, 2000);
  ctx.on('tokens', lateDraw);
  ctx.on('tracker-status', note);
  ctx.on('tracked-copylog', copyPanel); ctx.on('tracked-copy', copyPanel);

  $('#tl-side', body).addEventListener('click', (e) => { const b = e.target.closest('[data-side]'); if (!b) return; f.side = b.dataset.side; $$('[data-side]', body).forEach((x) => x.classList.toggle('on', x === b)); LS.set('track.filters', f); draw(); });
  let ft = 0;
  // a filter that does not read as a number is ignored, and says so
  const mark = (el) => {
    const mc = /Mc$/.test(el.dataset.f), v = el.value.trim(), bad = !!v && Number.isNaN((mc ? parseTarget : parseAmount)(v));
    el.classList.toggle('bad', bad);
    el.title = bad ? (mc ? 'Not read as a market cap (try 50k, 1.2m or 250000), so it is ignored.' : 'Not read as SOL (try 0.5), so it is ignored.') : '';
  };
  $$('[data-f]', body).forEach(mark);
  body.querySelector('.trk-tools').addEventListener('input', (e) => {
    const k = e.target.dataset.f; if (!k) return;
    mark(e.target);
    f[k] = e.target.value.trim().slice(0, 12);
    clearTimeout(ft); ft = setTimeout(() => { LS.set('track.filters', f); draw(); }, 200);
  });
  scroll.addEventListener('click', (e) => {
    const es = e.target.closest('[data-es]'); if (!es) return;
    if (es.dataset.es === 'add') addNext = true; // the link goes to Wallets, which opens its add form
    else if (es.dataset.es === 'back') $('#tl-back', body).click();
    else if (es.dataset.es === 'clear') {
      f.side = 'all'; f.minSol = f.maxSol = f.minMc = f.maxMc = '';
      $$('[data-side]', body).forEach((x) => x.classList.toggle('on', x.dataset.side === 'all'));
      $$('[data-f]', body).forEach((el) => { el.value = ''; mark(el); });
      LS.set('track.filters', f); draw();
    }
  });
  $('#tl-back', body).addEventListener('click', async (e) => {
    const b = e.currentTarget, feed = list.filter((w) => w.feed).slice(0, 15);
    if (!feed.length) { toast('Switch on Feed for at least one wallet first.', 'err'); return; }
    b.disabled = true; b.textContent = 'Loading…';
    toast(`Decoding the last few transactions of ${feed.length} wallet${feed.length > 1 ? 's' : ''}. Swaps appear as they decode.`);
    try { await logs.backfill(feed.map((w) => w.address), 3); } catch { toast('Could not load recent trades. Try again in a minute.', 'err'); }
    if (!ctx.alive()) return;
    b.disabled = false; b.textContent = 'Load recent';
  });
  return () => clearTimeout(ft);
}

// ================= Monitor =================
function mountMonitor(ctx) {
  const { body } = ctx;
  const savedMin = LS.get('track.mon.min', 2), groups = [...new Set(list.map((w) => w.group).filter(Boolean))].sort();
  let min = [2, 3, 5].includes(savedMin) ? savedMin : 2, group = LS.get('track.mon.group', ''), priceAt = 0, busy = false;
  if (typeof group !== 'string' || !groups.includes(group)) group = '';
  const prices = new Map(), named = new Map(); // mint → last lookup time
  const scope = () => list.filter((w) => !group || w.group === group).slice(0, MONITOR_MAX);
  body.innerHTML = `<div class="trk-mon">
    <div class="trk-tools">
      <div class="trk-seg" id="tm-min" role="group" aria-label="Held by at least">${[2, 3, 5].map((n) => `<button type="button" data-min="${n}" class="${min === n ? 'on' : ''}">${n}+ wallets</button>`).join('')}</div>
      <label class="trk-sel"><span>Group</span><select id="tm-group"><option value="">All wallets</option>${groups.map((g) => `<option value="${esc(g)}" ${g === group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select></label>
      <button type="button" class="btn" id="tm-rescan" title="Check every wallet again">Rescan</button>
      <span class="trk-note" id="tm-note"></span>
    </div>
    <div class="trk-scroll" id="tm-scroll"></div>
  </div>`;
  const scroll = $('#tm-scroll', body), pane = $('.trk-mon', body);
  function aggregate() {
    const by = new Map();
    for (const w of scope()) {
      const h = holdCache.get(w.address); if (!h?.tokens) continue;
      for (const [mint, ui] of h.tokens) {
        if (SKIP.has(mint) || !isMint(mint) || !(ui > 0)) continue;
        const e = by.get(mint) || { mint, holders: [], ui: 0 };
        e.holders.push({ w, ui }); e.ui += ui; by.set(mint, e);
      }
    }
    return [...by.values()].filter((e) => e.holders.length >= min);
  }
  const valueOf = (e) => { const p = prices.get(e.mint) ?? tokens.get(e.mint)?.price; return p > 0 ? e.ui * p : null; };
  let waiting = false, lastProg = '';
  function draw() {
    waiting = false;
    const sc = scope(), checked = sc.filter((w) => holdCache.get(w.address)).length, n = $('#tm-note', body);
    if (n) n.textContent = sc.length ? (checked < sc.length ? `Checked ${checked} of ${sc.length} wallets · one every 2 s` : `All ${sc.length} wallets checked · refreshed every 5 min`) + (list.length > MONITOR_MAX && !group ? ` · first ${MONITOR_MAX} only` : '') : '';
    pane.classList.toggle('is-empty', list.length < 2); // a group picker is kept while there is anything to pick
    if (list.length < 2) {
      scroll.innerHTML = emptyWithGhost('tm', {
        ic: 'overlap', title: 'See what your wallets agree on', body: 'The coins your tracked wallets hold in common, most shared first.',
        steps: [list.length ? 'Track at least one more wallet.' : 'Track two or more wallets.', 'Nought checks what each one holds, one wallet every 2 s.', 'Coins they share show up here with a quick buy.'],
        acts: '<a class="btn btn-accent" href="#/track/wallets" data-es="add">Add wallet</a><a class="btn btn-ghost" href="#/track/vision">Browse Vision →</a>',
      });
      return;
    }
    if (sc.length < 2) { scroll.innerHTML = emptyHtml({ cls: 'sm', title: 'This group has fewer than two wallets', body: 'Pick another group, or show every wallet.', acts: '<button type="button" class="btn" data-es="all">Show all wallets</button>' }); return; }
    const rows = aggregate().sort((a, b) => b.holders.length - a.holders.length || (valueOf(b) || 0) - (valueOf(a) || 0)).slice(0, 150);
    if (!rows.length) {
      const busy = checked < sc.length, prog = busy && `<div class="trk-prog" role="status"><span class="pulse-dot"></span><b>Checking wallets…</b><span>Coins held by ${min} or more of them appear as each wallet is checked.</span></div>`;
      if (busy && lastProg === prog && $('.trk-prog', scroll)) return; // same loading rows: keep them (and their shimmer) as they are
      lastProg = prog;
      scroll.innerHTML = busy
        ? prog + skelTable('tm', 6)
        : emptyHtml({ ic: 'overlap', cls: 'sm', title: 'No overlap right now', body: `No coin is held by ${min} or more of these wallets.${min > 2 ? '' : ' Coins show up here as soon as two of them buy the same one.'}`, acts: min > 2 ? '<button type="button" class="btn" data-es="min2">Show 2+ wallets</button>' : '' });
      return;
    }
    scroll.innerHTML = `<table class="trk-t tm-t"><thead><tr>${HEAD.tm}</tr></thead><tbody>${rows.map((e) => {
      const t = tokens.get(e.mint) || { mint: e.mint }, v = valueOf(e), mint = esc(e.mint), mc = mcUsd(t);
      if (!t.symbol) waiting = true;
      const hs = e.holders.slice().sort((a, b) => b.ui - a.ui), names = hs.map((h) => `${h.w.emoji ? h.w.emoji + ' ' : ''}${h.w.name || short(h.w.address)}`);
      return `<tr>
        <td><span class="tl-tok" data-mint="${mint}">${avatar({ ...t, symbol: t.symbol || short(e.mint, 2) }, 'xs')}<b>${esc(sym(t, e.mint))}</b><span class="dim tm-nm">${esc(t.name || '')}</span></span></td>
        <td class="num"><b>${e.holders.length}</b></td>
        <td class="tm-who" title="${esc(names.join(', '))}">${hs.slice(0, 4).map((h) => `<span class="trk-chip">${h.w.emoji ? esc(h.w.emoji) + ' ' : ''}${esc(h.w.name || short(h.w.address, 3))}</span>`).join('')}${hs.length > 4 ? `<span class="dim">+${hs.length - 4}</span>` : ''}</td>
        <td class="num">${v != null ? usd(v) : '<span class="dim">—</span>'}</td>
        <td class="num">${mc ? usd(mc) : '<span class="dim">—</span>'}</td>
        <td class="c">${qbButton(e.mint)}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
  }
  const redraw = ctx.throttle(draw, 400);
  // prices and names for the coins on screen (JP at most every 10 s, names once per coin)
  async function refreshPrices() {
    if (Date.now() - priceAt < 10e3) return;
    priceAt = Date.now();
    const mints = aggregate().map((e) => e.mint).slice(0, 150);
    if (!mints.length) return;
    try { for (const [k, v] of await jp.prices(mints)) prices.set(k, v.price); } catch { /* keep the old ones */ }
    const need = mints.filter((m) => !tokens.get(m)?.symbol && !(Date.now() - (named.get(m) || 0) < 60e3));
    if (need.length) { need.forEach((m) => named.set(m, Date.now())); try { for (const t of await jt.search(need)) upsert(t.mint, t); } catch { /* retried in a minute */ } }
    if (ctx.alive()) redraw();
  }
  // one wallet every 2 s; each wallet's holdings are reused for 5 minutes
  async function step() {
    if (busy || document.hidden || !ctx.alive()) return;
    const w = scope().find((x) => !fresh(holdCache.get(x.address), 300e3));
    if (!w) { refreshPrices(); return; }
    busy = true;
    try {
      const h = await ju.holdings(w.address), m = new Map();
      for (const [mint, b] of Object.entries(h.tokens)) if (b.raw !== '0' && b.ui > 0) m.set(mint, b.ui);
      holdCache.set(w.address, { at: Date.now(), tokens: m });
    } catch { holdCache.set(w.address, { at: Date.now() - 240e3, tokens: holdCache.get(w.address)?.tokens || new Map(), err: true }); } // retry in about a minute
    busy = false;
    if (!ctx.alive()) return;
    redraw();
    refreshPrices();
  }
  draw(); step();
  ctx.every(step, 2000);
  ctx.on('tokens', ctx.throttle(() => { if (waiting) draw(); }, 1500));
  $('#tm-min', body).addEventListener('click', (e) => { const b = e.target.closest('[data-min]'); if (!b) return; min = Number(b.dataset.min); LS.set('track.mon.min', min); $$('[data-min]', body).forEach((x) => x.classList.toggle('on', x === b)); priceAt = 0; draw(); refreshPrices(); });
  $('#tm-group', body).addEventListener('change', (e) => { group = e.target.value; LS.set('track.mon.group', group); priceAt = 0; draw(); });
  scroll.addEventListener('click', (e) => {
    const es = e.target.closest('[data-es]'); if (!es) return;
    if (es.dataset.es === 'add') addNext = true;
    else if (es.dataset.es === 'all') { const sel = $('#tm-group', body); sel.value = ''; sel.dispatchEvent(new Event('change')); }
    else if (es.dataset.es === 'min2') $('[data-min="2"]', body)?.click();
  });
  $('#tm-rescan', body).addEventListener('click', () => { for (const w of scope()) { const h = holdCache.get(w.address); if (h && Date.now() - h.at > 30e3) h.at = 0; } draw(); });
}

// ================= Vision =================
const cleanKol = (k) => {
  const a = String(k?.address || '').trim();
  if (!isMint(a)) return null;
  const x = String(k.x || '').trim().replace(/^@/, '');
  return { address: a, name: str(k.name, 40) || short(a), x: /^[A-Za-z0-9_]{1,15}$/.test(x) ? x : '', tags: Array.isArray(k.tags) ? k.tags.map((t) => str(t, 20)).filter(Boolean).slice(0, 5) : [] };
};
async function loadKols() {
  if (kolCache && Date.now() - kolCache.at < 300e3) return kolCache;
  try {
    const r = await fetch('data/kol-wallets.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json(), seen = new Set();
    kolCache = { at: Date.now(), list: (Array.isArray(j) ? j : []).map(cleanKol).filter((k) => k && !seen.has(k.address) && seen.add(k.address)).slice(0, 2000) };
  } catch { kolCache = { at: Date.now(), list: [], err: true }; }
  return kolCache;
}
// Top traders across a few trending coins, from each coin's latest trades (jx, up to 3 pages ≈ 90 trades per coin).
// Realized PnL only counts sells matched against buys seen in the same window.
async function scanDiscovered(progress) {
  disc.busy = true; disc.err = '';
  try {
    const top = (await jt.top('toptrending', disc.iv, 30)).filter((t) => isMint(t.mint) && !SKIP.has(t.mint) && !t.verified);
    top.forEach((t) => upsert(t.mint, t));
    const coins = top.slice(0, disc.n);
    if (!coins.length) throw new Error('Jupiter returned no trending coins right now.');
    const per = new Map(); let done = 0;
    progress?.(`Reading trades of ${coins.length} coins…`);
    const res = await Promise.allSettled(coins.map(async (c) => {
      let next = null;
      for (let p = 0; p < 3; p++) {
        const page = await jx.txs(c.mint, next ? { offset: next } : {});
        for (const x of page.txs) {
          if (x.mev || !isMint(x.wallet) || !(x.sol > 0)) continue;
          const w = per.get(x.wallet) || { address: x.wallet, coins: new Map(), trades: 0, bot: false };
          const e = w.coins.get(c.mint) || { buySol: 0, sellSol: 0, buyTok: 0, sellTok: 0 };
          if (x.side === 'buy') { e.buySol += x.sol; e.buyTok += x.tokens; } else { e.sellSol += x.sol; e.sellTok += x.tokens; }
          w.bot ||= x.tags.includes('bot');
          w.coins.set(c.mint, e); w.trades++; per.set(x.wallet, w);
        }
        if (!page.next || page.txs.length < 30) break;
        next = page.next;
      }
      done++; progress?.(`Read ${done} of ${coins.length} coins…`);
    }));
    if (res.every((r) => r.status === 'rejected')) throw new Error('Jupiter\'s trade history did not answer. Try again in a minute.');
    const rows = [];
    for (const w of per.values()) {
      let vol = 0, pnl = 0, closed = 0, wins = 0;
      for (const e of w.coins.values()) {
        vol += e.buySol + e.sellSol;
        const matched = Math.min(e.buyTok, e.sellTok);
        if (matched > 0) { const r = e.sellSol * (matched / e.sellTok) - e.buySol * (matched / e.buyTok); pnl += r; closed++; if (r > 0) wins++; }
      }
      if (w.trades >= 2 && vol >= 0.1) rows.push({ address: w.address, vol, pnl, closed, wins, trades: w.trades, coins: w.coins.size, bot: w.bot });
    }
    disc.rows = rows.sort(DSORT.vol).slice(0, 80).sort(DSORT[disc.sort] || DSORT.pnl);
    disc.coins = coins.map((c) => c.mint);
  } catch (e) { disc.err = e?.message || 'The scan failed.'; }
  disc.busy = false; disc.at = Date.now();
}
function mountVision(ctx) {
  const { body } = ctx;
  body.innerHTML = `<div class="trk-vis">
    <section class="tv-sec">
      <div class="tv-h"><h2>Community list</h2><span class="trk-note">Public wallets added by pull request, each with a source</span></div>
      <div id="tv-kols"><p class="tv-kol-empty"><span class="pulse-dot"></span><span>Loading the community list…</span></p></div>
    </section>
    <section class="tv-sec">
      <div class="tv-h"><h2>Discovered</h2><span class="trk-badge">computed this session</span>
        <div class="tv-ctl"><div class="trk-seg" id="tv-iv" role="group" aria-label="Trending window">${['5m', '1h', '6h'].map((v) => `<button type="button" data-iv="${v}" class="${disc.iv === v ? 'on' : ''}">${v}</button>`).join('')}</div>
        <div class="trk-seg" id="tv-n" role="group" aria-label="Coins to scan">${[4, 6, 10].map((v) => `<button type="button" data-n="${v}" class="${disc.n === v ? 'on' : ''}">${v} coins</button>`).join('')}</div>
        </div><button type="button" class="btn tv-scan" id="tv-scan">Scan</button>
      </div>
      <p class="tv-p">Ranked in your browser from the latest ~90 trades of each of the top trending coins on Jupiter. Realized PnL only counts sells matched to buys in that window: a lead to check, not a track record.</p>
      <div id="tv-coins" class="tv-coins"></div>
      <div class="trk-scroll tv-scroll" id="tv-disc"></div>
    </section>
  </div>`;
  const trackBtn = (a, label) => (index.has(a) ? '<button type="button" class="btn tv-tr" disabled>Tracked</button>' : `<button type="button" class="btn tv-tr tv-go" data-track="${esc(a)}"${label ? ` data-name="${esc(label)}"` : ''}>Track</button>`);
  async function drawKols() {
    const k = await loadKols();
    if (!ctx.alive()) return;
    const el = $('#tv-kols', body);
    if (k.err) { el.innerHTML = '<p class="tv-kol-empty"><span>The community list did not load. Try again later.</span></p>'; return; }
    if (!k.list.length) {
      el.innerHTML = '<p class="tv-kol-empty"><span>No entries yet: Nought never guesses who owns a wallet, so each one needs a public source.</span><a href="data/kol-wallets.json" target="_blank" rel="noopener">data/kol-wallets.json ↗</a></p>';
      return;
    }
    const trades = logs.recentTrades();
    el.innerHTML = `<div class="tv-grid">${k.list.map((x) => {
      const last = trades.find((t) => t.wallet === x.address);
      return `<div class="tv-card">
        <div class="tv-c1"><b>${esc(x.name)}</b>${x.x ? `<a href="https://x.com/${esc(x.x)}" target="_blank" rel="noopener nofollow" class="dim">@${esc(x.x)}</a>` : ''}</div>
        <div class="tv-c2 mono dim">${esc(short(x.address, 5))}<button type="button" class="copy" data-copy="${esc(x.address)}" title="Copy address">${ICON.copy}</button></div>
        ${x.tags.length ? `<div class="tv-tags">${x.tags.map((t) => `<span class="trk-chip">${esc(t)}</span>`).join('')}</div>` : ''}
        <div class="tv-c3">${last ? `<span class="trk-side ${last.side === 'sell' ? 'sell' : 'buy'}">${last.side === 'sell' ? 'Sell' : 'Buy'}</span> <span class="mono">${solTxt(last.sol)} SOL</span> <span class="dim" data-age="${Number(last.at) || 0}">${ago(Number(last.at) || 0)}</span>` : `<span class="dim">${index.has(x.address) ? 'No trade seen this session' : 'Track to see live trades'}</span>`}${trackBtn(x.address, x.name)}</div>
      </div>`;
    }).join('')}</div>`;
  }
  function drawDisc(progress) {
    const el = $('#tv-disc', body), coins = $('#tv-coins', body);
    coins.innerHTML = disc.coins.length && !disc.busy ? `<span class="dim">Scanned</span>${disc.coins.filter(isMint).map((m) => { const t = tokens.get(m) || { mint: m }; return `<span class="tl-tok trk-chip" data-mint="${esc(m)}">${avatar({ ...t, symbol: t.symbol || short(m, 2) }, 'xs')}${esc(sym(t, m))}</span>`; }).join('')}<span class="dim"><span data-age="${disc.at}">${ago(disc.at)}</span> ago</span>` : '';
    const sb = $('#tv-scan', body); sb.disabled = disc.busy; sb.textContent = disc.busy ? 'Scanning…' : 'Scan';
    if (disc.busy) {
      const msg = esc(progress || 'Fetching the trending list.'), p = $('.trk-prog > span:last-child', el);
      if (p) { p.innerHTML = msg; return; } // keep the loading rows (and their shimmer) in place
      el.innerHTML = `<div class="trk-prog" role="status"><span class="pulse-dot"></span><b>Scanning trending coins…</b><span>${msg}</span></div>${skelTable('tv', 6)}`;
      return;
    }
    if (disc.err) {
      el.innerHTML = emptyHtml({ ic: 'scan', cls: 'trk-es-err', title: 'The scan did not finish', body: esc(disc.err), acts: '<button type="button" class="btn" id="tv-again">Scan again</button>' });
      retryTick();
      return;
    }
    if (!disc.at) { el.innerHTML = emptyHtml({ ic: 'scan', cls: 'sm', title: 'Find active traders', body: 'Scan ranks the top traders of the coins trending on Jupiter right now.', acts: '<button type="button" class="btn btn-accent" id="tv-again">Scan</button>' }); return; }
    if (!disc.rows.length) { el.innerHTML = emptyHtml({ ic: 'scan', cls: 'sm', title: 'No wallet traded enough in this window', body: 'Try a longer window or more coins, then scan again.' }); return; }
    const sh = (k, label, tip = '') => `<th class="r"><button type="button" class="tv-sort${disc.sort === k ? ' on' : ''}" data-sort="${k}"${tip ? ` title="${tip}"` : ''}>${label}${disc.sort === k ? ' ↓' : ''}</button></th>`;
    el.innerHTML = `<table class="trk-t tv-t"><thead><tr><th class="r">#</th><th>Wallet</th>${sh('pnl', 'Realized PnL', 'Sells matched to buys in the scanned window')}${sh('vol', 'Volume')}${sh('trades', 'Trades')}<th class="r">Coins</th>${sh('win', 'Win rate', 'Share of coins closed in profit, among coins it both bought and sold in the window')}<th class="c"></th></tr></thead><tbody>${disc.rows.map((r, i) => `<tr>
      <td class="num dim">${i + 1}</td>
      <td class="mono tv-w"><a href="https://solscan.io/account/${esc(r.address)}" target="_blank" rel="noopener" title="Open on Solscan">${esc(short(r.address, 5))}</a><button type="button" class="copy" data-copy="${esc(r.address)}" title="Copy address">${ICON.copy}</button>${r.bot ? '<span class="trk-chip warn" title="Tagged as a bot by Jupiter">bot</span>' : ''}${r.trades >= 40 ? '<span class="trk-chip" title="Very active in a short window: may be automated">busy</span>' : ''}</td>
      ${r.closed ? (([v, k]) => `<td class="num ${k}">${v} <span class="dim">SOL</span></td>`)(pnlTxt(r.pnl)) : '<td class="num dim">still holding</td>'}
      <td class="num">${solTxt(r.vol)} <span class="dim">SOL</span></td>
      <td class="num">${r.trades}</td>
      <td class="num">${r.coins}</td>
      <td class="num">${r.closed ? `${Math.round((r.wins / r.closed) * 100)}% <span class="dim">of ${r.closed}</span>` : '<span class="dim">—</span>'}</td>
      <td class="c">${trackBtn(r.address)}</td>
    </tr>`).join('')}</tbody></table>`;
  }
  // after a failed scan, a short pause (longer while Jupiter cools down after a rate limit) before the next try
  const retryLeft = () => Math.max(0, disc.at + 8e3 - Date.now(), Math.min(coolLeft('lite-api.jup.ag'), coolLeft('api.jup.ag')), coolLeft('datapi.jup.ag'));
  function retryTick() {
    const b = disc.err && $('#tv-again', body); if (!b) return;
    const s = Math.ceil(retryLeft() / 1000);
    b.disabled = s > 0; b.classList.toggle('btn-accent', !(s > 0)); b.textContent = s > 0 ? `Scan again in ${s} s` : 'Scan again';
  }
  ctx.every(retryTick, 1000);
  function tryScan() {
    if (disc.busy) return;
    if (!disc.err && Date.now() - disc.at < 15e3) { toast('Give it a few seconds between scans.'); return; }
    if (disc.err && retryLeft() > 0) { toast(`Jupiter needs a short pause. Try again in ${Math.ceil(retryLeft() / 1000)} s.`); return; }
    scan();
  }
  async function scan() {
    if (disc.busy) return;
    const p = scanDiscovered((msg) => { if (ctx.alive()) drawDisc(msg); });
    drawDisc();
    await p;
    if (ctx.alive()) drawDisc();
  }
  drawKols(); drawDisc();
  if (!disc.at && !disc.busy) scan();
  else if (disc.busy) ctx.every(() => { if (!disc.busy && !$('#tv-disc table', body) && disc.at) drawDisc(); }, 1000);
  ctx.on('tracker-trade', ctx.throttle(drawKols, 1000));
  body.addEventListener('click', (e) => {
    const iv = e.target.closest('[data-iv]'), n = e.target.closest('[data-n]');
    if (iv) { disc.iv = iv.dataset.iv; $$('[data-iv]', body).forEach((x) => x.classList.toggle('on', x === iv)); return; }
    if (n) { disc.n = Number(n.dataset.n); $$('[data-n]', body).forEach((x) => x.classList.toggle('on', x === n)); return; }
    const so = e.target.closest('[data-sort]');
    if (so) { disc.sort = DSORT[so.dataset.sort] ? so.dataset.sort : 'pnl'; disc.rows.sort(DSORT[disc.sort]); drawDisc(); return; }
    if (e.target.closest('#tv-scan, #tv-again')) { tryScan(); return; }
    const tr = e.target.closest('[data-track]');
    if (tr) {
      const a = tr.dataset.track;
      if (!isMint(a) || index.has(a)) return;
      if (list.length >= MAX_TRACKED) { toast(`You can track up to ${MAX_TRACKED} wallets.`, 'err'); return; }
      addWallets([{ address: a, name: tr.dataset.name || '', group: tr.dataset.name ? 'Vision' : 'Discovered', feed: true }]);
      tr.outerHTML = '<button type="button" class="btn tv-tr" disabled>Tracked</button>';
      toast(`Tracking <span class="mono">${esc(short(a))}</span>. Rename it on the Wallets tab.`, 'ok');
    }
  });
}
