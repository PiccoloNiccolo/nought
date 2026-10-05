// Pulse column filters: one filter per column (New pairs, Final stretch, Migrated), saved in settings.filters.
// Applied in the browser on every render, and the parts Jupiter's gems endpoint understands also go into the feed
// body (buildBody) so each column's 30 pools are already the right kind of coin.
//   loadAll() → {new, stretch, migrated}   saveAll(all)   compile(f) → (token) => bool   activeCount(f)
//   buildBody(globalLaunchpads, all) → JG body for setFeedBody   encode(all) / decode(text)   openFilters(col, onApply)
import { esc, toast, parseTarget, ICON } from '../core/util.js';
import { settings, set } from '../core/settings.js';
import { all as allTokens, mcUsd } from '../core/store.js';
import { solUsd } from '../core/price.js';
import { LAUNCHPADS } from '../core/jup.js';
import { defaultBody } from '../core/seed.js';
import { lpInfo } from './card.js';
import { b64u, unb64u, download, pickFile } from './blacklist.js';

export const COL_IDS = ['new', 'stretch', 'migrated'];
export const COL_NAMES = { new: 'New pairs', stretch: 'Final stretch', migrated: 'Migrated' };
const JG_KEY = { new: 'recent', stretch: 'aboutToGraduate', migrated: 'graduated' };

// Jupiter leaves sniper/insider shares out when they are zero; a coin with an audit block (devPct set) has had them checked
const zeroIfAudited = (v, t) => v ?? (t.devPct != null ? 0 : null);
// range filters: key, label, unit, value(t), JG body stem (min<stem>/max<stem>), int (round for JG), money (accepts 10k)
export const RANGES = [
  { k: 'age', g: 'Market', label: 'Age', unit: 'minutes', jg: 'TokenAge', int: true, v: (t) => (t.created ? (Date.now() - t.created) / 60000 : null) },
  { k: 'mc', g: 'Market', label: 'Market cap', unit: '$', jg: 'Mcap', money: true, v: (t) => mcUsd(t) },
  { k: 'liq', g: 'Market', label: 'Liquidity', unit: '$', jg: 'Liquidity', money: true, v: (t) => t.liquidity },
  { k: 'vol', g: 'Market', label: 'Volume 24h', unit: '$', jg: 'Volume24h', money: true, v: (t) => t.volume24h ?? (t.volSol ? t.volSol * solUsd() : null) },
  { k: 'bonding', g: 'Market', label: 'Bonding curve', unit: '%', jg: 'BondingCurve', v: (t) => (t.migrated ? 100 : t.progress != null ? t.progress * 100 : null) },
  { k: 'holders', g: 'Activity', label: 'Holders', jg: 'HolderCount', int: true, v: (t) => t.holders },
  { k: 'txns', g: 'Activity', label: 'Transactions', unit: '24h', v: (t) => (Number(t.buys) || 0) + (Number(t.sells) || 0) },
  { k: 'buys', g: 'Activity', label: 'Buys', unit: '24h', v: (t) => t.buys },
  { k: 'sells', g: 'Activity', label: 'Sells', unit: '24h', v: (t) => t.sells },
  { k: 'organic', g: 'Activity', label: 'Organic score', unit: '/100', jg: 'OrganicScore', v: (t) => t.organicScore },
  { k: 'top10', g: 'Holders', label: 'Top 10 holders', unit: '%', jg: 'TopHoldersPercentage', v: (t) => t.top10Pct },
  { k: 'dev', g: 'Holders', label: 'Dev holding', unit: '%', jgMax: 'maxDevBalancePct', v: (t) => t.devPct },
  { k: 'snipers', g: 'Holders', label: 'Snipers', unit: '%', jg: 'SniperPct', v: (t) => zeroIfAudited(t.sniperPct, t) },
  { k: 'insiders', g: 'Holders', label: 'Insiders', unit: '%', jg: 'InsiderPct', v: (t) => zeroIfAudited(t.insiderPct, t) },
  { k: 'devMig', g: 'Holders', label: 'Dev migrations', jg: 'DevMigrations', int: true, v: (t) => t.devMigrations },
  { k: 'devMints', g: 'Holders', label: 'Dev launches', v: (t) => t.devMints },
];
const RBY = Object.fromEntries(RANGES.map((r) => [r.k, r]));
const SOCIALS = [['x', 'X'], ['web', 'Website'], ['tg', 'Telegram'], ['any', 'At least one']];

export const emptyFilter = () => ({ launchpads: [], include: '', exclude: '', pumpOnly: false, dexPaid: false, socials: { x: false, web: false, tg: false, any: false }, r: {} });
const numOrNull = (x) => (x === null || x === '' || x === undefined || !isFinite(Number(x)) ? null : Number(x));
// keep only known, well-typed fields (filters also arrive from share strings and files)
export function clean(f) {
  const e = emptyFilter(); if (!f || typeof f !== 'object') return e;
  e.launchpads = Array.isArray(f.launchpads) ? [...new Set(f.launchpads.filter((x) => LAUNCHPADS.includes(x)))] : [];
  e.include = typeof f.include === 'string' ? f.include.slice(0, 300) : '';
  e.exclude = typeof f.exclude === 'string' ? f.exclude.slice(0, 300) : '';
  e.pumpOnly = f.pumpOnly === true; e.dexPaid = f.dexPaid === true;
  for (const [s] of SOCIALS) e.socials[s] = f.socials?.[s] === true;
  for (const R of RANGES) {
    const v = f.r?.[R.k]; if (!Array.isArray(v)) continue;
    const lo = numOrNull(v[0]), hi = numOrNull(v[1]);
    if (lo != null || hi != null) e.r[R.k] = [lo, hi];
  }
  return e;
}
export function loadAll() { const s = settings.filters || {}; return Object.fromEntries(COL_IDS.map((c) => [c, clean(s[c])])); }
export function saveAll(a) { set({ filters: Object.fromEntries(COL_IDS.map((c) => [c, clean(a[c])])) }); }
export function activeCount(f) {
  return (f.launchpads.length ? 1 : 0) + (f.include.trim() ? 1 : 0) + (f.exclude.trim() ? 1 : 0) + (f.pumpOnly ? 1 : 0) + (f.dexPaid ? 1 : 0)
    + SOCIALS.filter(([s]) => f.socials[s]).length + Object.keys(f.r).length;
}
const words = (s) => String(s || '').toLowerCase().split(/[,\n]/).map((w) => w.trim()).filter(Boolean);

// one predicate per filter, built once per render
export function compile(f) {
  const inc = words(f.include), exc = words(f.exclude), lps = f.launchpads, so = f.socials;
  const ranges = Object.entries(f.r).map(([k, [lo, hi]]) => [RBY[k], lo, hi]).filter(([R]) => R);
  return (t) => {
    if (lps.length && !lps.includes(t.launchpad) && !lps.includes(t.metaLaunchpad)) return false;
    if (f.pumpOnly && !/pump$/.test(t.mint)) return false;
    if (f.dexPaid && !t.dexPaid) return false;
    if (so.x || so.web || so.tg || so.any) {
      const hx = !!(t.twitter || t.xHandle), hw = !!t.website, ht = !!t.telegram;
      if ((so.x && !hx) || (so.web && !hw) || (so.tg && !ht) || (so.any && !(hx || hw || ht))) return false;
    }
    if (inc.length || exc.length) {
      const hay = `${t.name || ''} ${t.symbol || ''}`.toLowerCase();
      if (inc.length && !inc.some((w) => hay.includes(w))) return false;
      if (exc.some((w) => hay.includes(w))) return false;
    }
    for (const [R, lo, hi] of ranges) {
      const v = R.v(t);
      if (v == null || !isFinite(v)) return false; // unknown yet: stay hidden until the data arrives
      if (lo != null && v < lo) return false;
      if (hi != null && v > hi) return false;
    }
    return true;
  };
}

// the parts of a filter Jupiter's gems endpoint understands (field names in src/core/jup.js)
export function jgFields(f, col) {
  const o = {};
  for (const R of RANGES) {
    const r = f.r[R.k]; if (!r || (R.k === 'bonding' && col === 'migrated')) continue;
    const [lo, hi] = r.map((x) => (x == null ? null : R.int ? Math.round(x) : x));
    if (R.jg) { if (lo != null) o['min' + R.jg] = lo; if (hi != null) o['max' + R.jg] = hi; }
    else if (R.jgMax && hi != null) o[R.jgMax] = hi;
  }
  if (SOCIALS.some(([s]) => f.socials[s])) o.hasSocials = true;
  return o;
}
export function buildBody(globalLps, a) {
  const body = defaultBody(globalLps?.length ? globalLps : LAUNCHPADS);
  for (const col of COL_IDS) {
    const key = JG_KEY[col], f = a[col] || emptyFilter();
    let lps = body[key].launchpads;
    if (f.launchpads.length) lps = lps.filter((x) => f.launchpads.includes(x));
    if (!lps.length) { delete body[key]; continue; } // nothing can match: skip the column
    body[key] = { ...body[key], launchpads: lps, ...jgFields(f, col) };
  }
  return body;
}

// ---- share string: base64url(JSON {v:1, columns:{new, stretch, migrated}}) ----
const payload = (a) => ({ v: 1, kind: 'nought-pulse-filters', columns: Object.fromEntries(COL_IDS.map((c) => [c, clean(a[c])])) });
export const encode = (a) => b64u(JSON.stringify(payload(a)));
export function decode(text) {
  const s = String(text || '').trim(); if (!s) throw new Error('Paste a filter string or open a file.');
  let j; try { j = JSON.parse(s.startsWith('{') ? s : unb64u(s)); } catch { throw new Error('That is not a Nought filter string.'); }
  if (!j || j.v !== 1 || !j.columns || typeof j.columns !== 'object' || !COL_IDS.some((c) => j.columns[c])) throw new Error('That is not a Nought filter string.');
  return Object.fromEntries(COL_IDS.map((c) => [c, clean(j.columns[c])]));
}

// numbers people type: 10k, 1.5m, 2,000,000, 0,5 (util's parseTarget); null when unclear, e.g. "1,500" (1.5 or 1500?)
export function parseNum(s) { const v = parseTarget(s); return Number.isFinite(v) ? v : null; }
const show = (n, R) => (n == null ? '' : R.money && n >= 1e6 && n % 1e5 === 0 ? n / 1e6 + 'm' : R.money && n >= 1e3 && n % 100 === 0 ? n / 1e3 + 'k' : String(n));

// ---- the filter dialog ----
const IO_IC = {
  imp: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  exp: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 19.5h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
export function openFilters(start = 'new', onApply = () => {}) {
  document.querySelector('dialog.pf-dlg')?.remove();
  const draft = loadAll();
  let tab = COL_IDS.includes(start) ? start : 'new', io = '';
  const d = document.createElement('dialog'); d.className = 'pf-dlg pu-dlg';
  d.innerHTML = `<div class="pd">
    <div class="pd-head"><h2>Filters</h2><span class="muted pf-match"></span><button type="button" class="pd-x" data-close title="Close">${ICON.close}</button></div>
    <div class="pd-tabs" role="tablist"></div>
    <div class="pf-body"></div>
    <div class="pd-io" hidden></div>
    <div class="pd-foot"><button type="button" class="btn btn-ghost pd-iob" data-io="import" title="Import filters" aria-label="Import filters">${IO_IC.imp}<span>Import</span></button><button type="button" class="btn btn-ghost pd-iob" data-io="export" title="Export filters" aria-label="Export filters">${IO_IC.exp}<span>Export</span></button><span class="sp"></span><button type="button" class="btn btn-ghost" data-reset>Reset</button><button type="button" class="btn btn-accent" data-apply>Apply</button></div>
  </div>`;
  document.body.appendChild(d);
  const $d = (s) => d.querySelector(s);

  const tabs = () => { $d('.pd-tabs').innerHTML = COL_IDS.map((c) => { const n = activeCount(draft[c]); return `<button type="button" role="tab" data-tab="${c}" class="${c === tab ? 'on' : ''}">${COL_NAMES[c]}${n ? `<b>${n}</b>` : ''}</button>`; }).join(''); };
  const match = () => {
    const p = compile(draft[tab]), list = allTokens().filter((t) => t.pulseCol === tab), n = list.filter(p).length;
    $d('.pf-match').textContent = `${n} of ${list.length} coins in ${COL_NAMES[tab]} match now`;
  };
  const body = () => {
    const f = draft[tab], groups = [...new Set(RANGES.map((R) => R.g))];
    $d('.pf-body').innerHTML = `
      <section><h3>Launchpads <span class="hint">none picked = all</span></h3><div class="pf-chips">${LAUNCHPADS.map((id) => `<button type="button" data-lp="${esc(id)}" class="${f.launchpads.includes(id) ? 'on' : ''}" style="--lp:${lpInfo(id).color}"><i></i>${esc(lpInfo(id).label)}</button>`).join('')}</div></section>
      <section class="pf-kw"><label>Name or ticker has any of<input data-f="include" value="${esc(f.include)}" placeholder="cat, dog, ai" spellcheck="false"></label><label>Hide if it has any of<input data-f="exclude" value="${esc(f.exclude)}" placeholder="test, scam" spellcheck="false"></label></section>
      <section class="pf-row"><label class="pf-check"><input type="checkbox" data-f="pumpOnly" ${f.pumpOnly ? 'checked' : ''}> Address ends in "pump"</label><label class="pf-check"><input type="checkbox" data-f="dexPaid" ${f.dexPaid ? 'checked' : ''}> Dexscreener paid</label></section>
      <section><h3>Socials required</h3><div class="pf-chips">${SOCIALS.map(([s, l]) => `<button type="button" data-so="${s}" class="${f.socials[s] ? 'on' : ''}">${l}</button>`).join('')}</div></section>
      ${groups.map((g) => `<section><h3>${g}</h3><div class="pf-grid">${RANGES.filter((R) => R.g === g).map((R) => { const r = f.r[R.k] || [null, null]; return `<div class="pf-r"><span>${R.label}${R.unit ? `<em>${R.unit}</em>` : ''}</span><input data-min="${R.k}" inputmode="decimal" placeholder="Min" value="${esc(show(r[0], R))}" aria-label="${R.label} minimum"><input data-max="${R.k}" inputmode="decimal" placeholder="Max" value="${esc(show(r[1], R))}" aria-label="${R.label} maximum"></div>`; }).join('')}</div></section>`).join('')}
      <p class="hint pf-note">Money fields take 10k or 1.5m (write 1500 or 1.5k, not 1,500: a lone comma reads as a decimal point). A field outlined in red is not understood and is ignored. Snipers, insiders and dev share count as 0 once Jupiter has audited a coin and reports none. Coins missing a value you filter on stay hidden until it arrives.</p>`;
  };
  const ioDraw = () => {
    const el = $d('.pd-io'); el.hidden = !io;
    if (io === 'export') el.innerHTML = `<label class="pf-lbl">Share string for all three columns<input readonly class="mono" value="${esc(encode(draft))}"></label><div class="row-end"><button type="button" class="btn btn-ghost" data-dl>Download .json</button><button type="button" class="btn btn-accent" data-cp>Copy</button></div>`;
    else if (io === 'import') el.innerHTML = `<textarea rows="3" spellcheck="false" placeholder="Paste a filter string or JSON"></textarea><div class="row-end"><button type="button" class="btn btn-ghost" data-file>Open .json file</button><button type="button" class="btn btn-accent" data-load>Load into the form</button></div>`;
  };
  const redraw = () => { tabs(); body(); match(); };
  redraw();

  d.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) { if (e.target === d) d.close(); return; }
    const f = draft[tab];
    if (b.hasAttribute('data-close')) d.close();
    else if (b.dataset.tab) { tab = b.dataset.tab; redraw(); }
    else if (b.dataset.lp) { const id = b.dataset.lp; f.launchpads = f.launchpads.includes(id) ? f.launchpads.filter((x) => x !== id) : [...f.launchpads, id]; b.classList.toggle('on'); tabs(); match(); }
    else if (b.dataset.so) { f.socials[b.dataset.so] = !f.socials[b.dataset.so]; b.classList.toggle('on'); tabs(); match(); }
    else if (b.hasAttribute('data-reset')) { draft[tab] = emptyFilter(); redraw(); }
    else if (b.dataset.io) { io = io === b.dataset.io ? '' : b.dataset.io; ioDraw(); }
    else if (b.hasAttribute('data-cp')) { try { await navigator.clipboard.writeText(encode(draft)); toast('Filter string copied.', 'ok'); } catch { toast('Copy failed. Select the text and copy it, or download the file.', 'err'); } }
    else if (b.hasAttribute('data-dl')) download('nought-pulse-filters.json', payload(draft));
    else if (b.hasAttribute('data-file')) { try { $d('.pd-io textarea').value = await pickFile(); } catch (er) { toast(esc(er.message), 'err'); } }
    else if (b.hasAttribute('data-load')) {
      try { const got = decode($d('.pd-io textarea').value); COL_IDS.forEach((c) => { draft[c] = got[c]; }); io = ''; ioDraw(); redraw(); toast('Loaded. Press Apply to use these filters.', 'ok'); }
      catch (er) { toast(esc(er.message), 'err'); }
    } else if (b.hasAttribute('data-apply')) { saveAll(draft); onApply(loadAll()); d.close(); }
  });
  d.addEventListener('input', (e) => {
    const el = e.target, f = draft[tab];
    if (el.dataset.f === 'include' || el.dataset.f === 'exclude') f[el.dataset.f] = el.value.slice(0, 300);
    else if (el.dataset.f === 'pumpOnly' || el.dataset.f === 'dexPaid') f[el.dataset.f] = el.checked;
    else if (el.dataset.min || el.dataset.max) {
      const k = el.dataset.min || el.dataset.max, i = el.dataset.min ? 0 : 1, raw = el.value.trim(), v = raw ? parseNum(raw) : null;
      el.classList.toggle('bad', !!raw && v == null);
      const r = [...(f.r[k] || [null, null])]; r[i] = v;
      if (r[0] == null && r[1] == null) delete f.r[k]; else f.r[k] = r;
    } else return;
    tabs(); match();
  });
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}
