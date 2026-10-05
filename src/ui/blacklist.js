// Pulse blacklist: coins, creator wallets, keywords and X handles you never want to see. Kept in this browser
// (localStorage 'nought.pulse.blacklist'), shared across columns. Import/export as a share string or a .json file.
//   blocked(t, {ignoreMint}) → {k, v, label} | null    add(k, v, note) · remove(k, v) · entries() · onChange(fn) → off
//   openBlacklist()  the manage dialog                  KINDS
import { esc, short, isMint, LS, toast, ICON } from '../core/util.js';

export const KINDS = { mint: 'Coins', dev: 'Dev wallets', word: 'Keywords', x: 'X handles' };
const ONE = { mint: 'coin', dev: 'dev wallet', word: 'keyword', x: 'X handle' };
const MAX = 20000;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

// normalise what a person types: '@Name' or an x.com/twitter.com link → 'name'; keywords are lower-case
export function norm(k, v) {
  let s = String(v ?? '').trim();
  if (k === 'mint' || k === 'dev') return isMint(s) ? s : '';
  if (k === 'word') return s.toLowerCase().slice(0, 40);
  if (k === 'x') {
    const m = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?!i\/|search|home|intent)([A-Za-z0-9_]{1,15})/i);
    s = (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
    return HANDLE.test(s) ? s : '';
  }
  return '';
}
// the X handle a coin points to (its primary handle, or the account in its X link)
export function handleOf(t) {
  if (HANDLE.test(t?.xHandle || '')) return t.xHandle.toLowerCase();
  return t?.twitter ? norm('x', t.twitter) : '';
}

let items = [];       // [{k, v, at, note}]
let sets = {};        // k → Set(v)
let words = [];
function index() {
  sets = { mint: new Set(), dev: new Set(), x: new Set() }; words = [];
  for (const it of items) (it.k === 'word' ? words.push(it.v) : sets[it.k]?.add(it.v));
}
function load() {
  const raw = LS.get('pulse.blacklist', []);
  items = (Array.isArray(raw) ? raw : []).map((it) => ({ k: it?.k, v: norm(it?.k, it?.v), at: Number(it?.at) || Date.now(), note: typeof it?.note === 'string' ? it.note.slice(0, 40) : '' })).filter((it) => KINDS[it.k] && it.v).slice(-MAX);
  index();
}
load();
const subs = new Set();
export const onChange = (fn) => { subs.add(fn); return () => subs.delete(fn); };
function save() { if (items.length > MAX) items = items.slice(-MAX); LS.set('pulse.blacklist', items); index(); subs.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }

export const entries = (k) => (k ? items.filter((it) => it.k === k) : [...items]);
export const size = () => items.length;
export function has(k, v) { const n = norm(k, v); return k === 'word' ? words.includes(n) : !!sets[k]?.has(n); }
export function add(k, v, note = '') {
  const n = norm(k, v); if (!KINDS[k] || !n) return false;
  if (has(k, n)) return false;
  items.push({ k, v: n, at: Date.now(), note: String(note || '').slice(0, 40) }); save();
  return true;
}
export function remove(k, v) { const n = norm(k, v), before = items.length; items = items.filter((it) => !(it.k === k && it.v === n)); if (items.length !== before) save(); }
export function clear(k) { items = k ? items.filter((it) => it.k !== k) : []; save(); }

// why a coin is hidden, or null. ignoreMint: Display's "unhide on migrate" lets hidden coins back into Migrated.
export function blocked(t, { ignoreMint = false } = {}) {
  if (!t) return null;
  if (!ignoreMint && sets.mint.has(t.mint)) return { k: 'mint', v: t.mint, label: 'coin' };
  if (t.dev && sets.dev.has(t.dev)) return { k: 'dev', v: t.dev, label: 'dev ' + short(t.dev) };
  if (sets.x.size) { const h = handleOf(t); if (h && sets.x.has(h)) return { k: 'x', v: h, label: '@' + h }; }
  if (words.length) {
    const hay = `${t.name || ''} ${t.symbol || ''}`.toLowerCase();
    for (const w of words) if (hay.includes(w)) return { k: 'word', v: w, label: `"${w}"` };
  }
  return null;
}

// ---- share string: base64url(JSON {v:1, kind:'nought-blacklist', items:[[k, v, at, note]]}) ----
export const b64u = (s) => { let bin = ''; for (const c of new TextEncoder().encode(s)) bin += String.fromCharCode(c); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const unb64u = (s) => new TextDecoder().decode(Uint8Array.from(atob(String(s).trim().replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
const payload = () => ({ v: 1, kind: 'nought-blacklist', items: items.map((it) => [it.k, it.v, it.at, it.note]) });
export const exportString = () => b64u(JSON.stringify(payload()));
// accepts a share string or the JSON text of an exported file; returns how many new entries were added
export function importText(text) {
  const s = String(text || '').trim(); if (!s) throw new Error('Paste a blacklist string or pick a file.');
  let j; try { j = JSON.parse(s.startsWith('{') ? s : unb64u(s)); } catch { throw new Error('That is not a Nought blacklist.'); }
  if (!j || j.v !== 1 || j.kind !== 'nought-blacklist' || !Array.isArray(j.items)) throw new Error('That is not a Nought blacklist.');
  let n = 0;
  for (const row of j.items.slice(0, MAX)) {
    if (!Array.isArray(row)) continue;
    const [k, v, at, note] = row, nv = norm(k, v);
    if (!KINDS[k] || !nv || has(k, nv)) continue;
    items.push({ k, v: nv, at: Number(at) || Date.now(), note: typeof note === 'string' ? note.slice(0, 40) : '' }); n++;
  }
  save();
  return n;
}
export function download(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// read a small text file the person picks (≤ 2 MB)
export function pickFile() {
  return new Promise((resolve, reject) => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json,.txt';
    inp.onchange = () => { const f = inp.files?.[0]; if (!f) return reject(new Error('No file picked.')); if (f.size > 2e6) return reject(new Error('That file is too big.')); f.text().then(resolve, reject); };
    inp.click();
  });
}

// ---- manage dialog ----
const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 3600 ? Math.max(1, Math.floor(s / 60)) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const PH = { mint: 'Token address', dev: 'Creator wallet address', word: 'Word in a name or ticker', x: '@handle or x.com link' };
export function openBlacklist(start = 'mint') {
  document.querySelector('dialog.bl-dlg')?.remove();
  const d = document.createElement('dialog'); d.className = 'bl-dlg pu-dlg';
  let tab = KINDS[start] ? start : 'mint', q = '';
  d.innerHTML = `<div class="pd">
    <div class="pd-head"><h2>Blacklist</h2><span class="muted">Hidden on Pulse in this browser</span><button type="button" class="pd-x" data-close title="Close">${ICON.close}</button></div>
    <div class="pd-tabs" role="tablist"></div>
    <form class="bl-add" autocomplete="off"><input name="v" spellcheck="false" aria-label="Value to blacklist"><button class="btn btn-accent" type="submit">Add</button></form>
    <input class="bl-q" type="search" placeholder="Filter this list" aria-label="Filter the list">
    <div class="bl-list"></div>
    <div class="pd-io" hidden><textarea rows="3" spellcheck="false" placeholder="Paste a blacklist string or JSON"></textarea><div class="row-end"><button type="button" class="btn btn-ghost" data-file>Open .json file</button><button type="button" class="btn btn-accent" data-load>Import</button></div></div>
    <div class="pd-foot"><button type="button" class="btn btn-ghost" data-imp>Import</button><button type="button" class="btn btn-ghost" data-copyout>Copy share string</button><button type="button" class="btn btn-ghost" data-dl>Download .json</button><span class="sp"></span><button type="button" class="btn btn-ghost danger" data-clear>Clear tab</button><button type="button" class="btn" data-close>Done</button></div>
  </div>`;
  document.body.appendChild(d);
  const $d = (s) => d.querySelector(s);
  const draw = () => {
    $d('.pd-tabs').innerHTML = Object.entries(KINDS).map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}<b>${entries(k).length}</b></button>`).join('');
    $d('.bl-add input').placeholder = PH[tab];
    const list = entries(tab).filter((it) => !q || it.v.toLowerCase().includes(q) || it.note.toLowerCase().includes(q)).reverse();
    $d('.bl-list').innerHTML = list.length ? list.slice(0, 400).map((it) => `<div class="bl-row"><span class="mono v" title="${esc(it.v)}">${esc(tab === 'x' ? '@' + it.v : tab === 'word' ? it.v : short(it.v, 6))}</span><span class="n">${esc(it.note)}</span><span class="dim mono">${ago(it.at)}</span>${tab === 'mint' ? `<a href="#/t/${esc(it.v)}" title="Open">Open</a>` : tab === 'dev' ? `<a href="https://solscan.io/account/${esc(it.v)}" target="_blank" rel="noopener">Solscan</a>` : ''}<button type="button" data-rm="${esc(it.v)}" title="Remove">${ICON.close}</button></div>`).join('') + (list.length > 400 ? `<div class="dim bl-more">${list.length - 400} more. Filter to find them.</div>` : '')
      : `<div class="bl-empty">${q ? 'Nothing matches.' : `No ${esc(KINDS[tab].toLowerCase())} yet. ${tab === 'mint' ? 'Hover a card on Pulse and use the eye button, or press H.' : tab === 'dev' ? 'Hover a card on Pulse and use the person button.' : 'Add one above.'}`}</div>`;
  };
  draw();
  const off = onChange(draw);
  d.addEventListener('close', () => { off(); d.remove(); });
  d.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) { if (e.target === d) d.close(); return; }
    if (b.hasAttribute('data-close')) d.close();
    else if (b.dataset.tab) { tab = b.dataset.tab; draw(); }
    else if (b.dataset.rm) remove(tab, b.dataset.rm);
    else if (b.hasAttribute('data-imp')) { const io = $d('.pd-io'); io.hidden = !io.hidden; if (!io.hidden) io.querySelector('textarea').focus(); }
    else if (b.hasAttribute('data-load')) { try { const n = importText($d('.pd-io textarea').value); toast(`Imported ${n} new entr${n === 1 ? 'y' : 'ies'}.`, 'ok'); $d('.pd-io').hidden = true; } catch (er) { toast(esc(er.message), 'err'); } }
    else if (b.hasAttribute('data-file')) { try { $d('.pd-io textarea').value = await pickFile(); } catch (er) { toast(esc(er.message), 'err'); } }
    else if (b.hasAttribute('data-copyout')) { try { await navigator.clipboard.writeText(exportString()); toast(`Copied a share string with ${items.length} entr${items.length === 1 ? 'y' : 'ies'}.`, 'ok'); } catch { toast('Copy failed. Use Download .json instead.', 'err'); } }
    else if (b.hasAttribute('data-dl')) download('nought-blacklist.json', payload());
    else if (b.hasAttribute('data-clear')) { const n = entries(tab).length; if (n && confirm(`Remove all ${n} ${KINDS[tab].toLowerCase()} from the blacklist?`)) clear(tab); }
  });
  $d('.bl-add').addEventListener('submit', (e) => {
    e.preventDefault(); const inp = $d('.bl-add input'), v = inp.value;
    if (!norm(tab, v)) { toast(`That is not a valid ${ONE[tab]}.`, 'err'); return; }
    if (!add(tab, v)) toast('Already on the list.'); inp.value = '';
  });
  $d('.bl-q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
  d.showModal();
  return d;
}
