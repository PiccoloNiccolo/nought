// Discover (#/discover[/tab]): ranked coin tables and a sampled market overview.
//   trending  Jupiter toptrending/{tf}          surge     Nought's own pick from toptrending + toporganicscore 5m
//   organic   Jupiter toporganicscore/{tf}      traded    Jupiter toptraded/{tf}
//   boosted   Dexscreener boosts, profiles and community takeovers (Solana), with Dexscreener + Jupiter details
//   overview  launches and migrations counted from the live stream since Nought opened, plus sums of the top lists
// Lists refresh every 10 s (boosted and overview every 30 s) while the tab is visible. Sorting and filters run here,
// on what the APIs returned. Sparklines load for rows on screen only (src/ui/sparkline.js).
import { $, esc, on, usd, num, pct, cls, short, LS, toast, ICON } from '../core/util.js';
import { register } from '../core/router.js';
import { jt, ds, img, LAUNCHPADS, INTERVALS } from '../core/jup.js';
import { tokens, upsert, all } from '../core/store.js';
import { gecko, eachPool } from '../core/seed.js';
import { avatar, socials, qbButton, lpInfo, LP } from '../ui/card.js';
import { sparkCell, sparkWatcher } from '../ui/sparkline.js';
import { watchlist, watchMints, toggleWatch } from '../core/watchlist.js';
import { parseAmt, pairToken, nn } from './watch.js';

const TABS = [
  { id: 'trending', label: 'Trending', kind: 'toptrending', every: 10e3, note: 'What Jupiter ranks as trending over the window you pick.' },
  { id: 'surge', label: 'Surge', every: 10e3 },
  { id: 'organic', label: 'Organic', kind: 'toporganicscore', every: 10e3, note: 'Ranked by organic activity: volume and buyers that look like people, not bots.' },
  { id: 'traded', label: 'Top traded', kind: 'toptraded', every: 10e3, note: 'The most traded coins over the window you pick.' },
  { id: 'boosted', label: 'Boosted', every: 30e3 },
  { id: 'overview', label: 'Overview', every: 30e3 },
];
const SK = { '5m': 'stats5m', '1h': 'stats1h', '6h': 'stats6h', '24h': 'stats24h' };
const LP_SHORT = { 'pump.fun': 'pump', 'letsbonk.fun': 'bonk', 'raydium-launchlab': 'launchlab', 'met-dbc': 'dbc', 'bags.fun': 'bags', 'jup-studio': 'studio' };
const lpName = (lp) => LP_SHORT[lp] || String(lp || '').slice(0, 16);
// full launchpad names where there is room ("pump.fun", "Meteora DBC"); ids Nought doesn't know get a capital letter
const lpLabel = (lp) => { if (!lp || lp === 'unknown' || lp === 'none') return 'Other'; const l = lpInfo(lp).label.slice(0, 24); return LP[lp] ? l : l.charAt(0).toUpperCase() + l.slice(1); };
const PROMO = { top: 'Top boost', latest: 'New boost', profile: 'Profile', cto: 'Takeover' };
const SURGE_COOL = 10 * 60e3; // a surge stays listed (dimmed) this long after it stops qualifying

// ---- preferences (this browser only) ----
const P = Object.assign({ tf: '1h', majors: false, sort: null, f: {}, sound: false, ratio: 3, minPc: 5, minVol: 1000, promo: 'all' }, LS.get('discover', {}));
if (!INTERVALS.includes(P.tf)) P.tf = '1h';
if (!P.f || typeof P.f !== 'object') P.f = {};
if (!Array.isArray(P.f.lps)) P.f.lps = [];
if (P.promo !== 'all' && !(P.promo in PROMO)) P.promo = 'all';
const save = () => LS.set('discover', P);
let query = '';

// ---- sampled market counters: since Nought opened in this tab (one listener each for the app's lifetime) ----
const OPENED = Date.now();
const sample = { launch: { recent: [], total: new Map() }, migrate: { recent: [], total: new Map() } };
function count(kind, t) {
  const s = sample[kind], lp = t?.launchpad || 'unknown', now = Date.now();
  s.recent.push({ at: now, lp }); s.total.set(lp, (s.total.get(lp) || 0) + 1);
  while (s.recent.length && now - s.recent[0].at > 3600e3) s.recent.shift();
}
on('new-token', (t) => count('launch', t));
on('migrate', (t) => count('migrate', t));

// ---- caches shared by every visit ----
const lists = new Map();  // `${kind}:${tf}` → {at, rows: Token[]}
const surges = new Map(); // mint → {first, last, n, peak, t}
let boosted = null;       // {at, rows}

async function fetchList(kind, tf) {
  const k = kind + ':' + tf, hit = lists.get(k);
  if (hit && Date.now() - hit.at < 8000) return hit.rows;
  const rows = await jt.top(kind, tf, 100);
  lists.set(k, { at: Date.now(), rows });
  return rows;
}

// Surge (Nought's rule): the last 5 minutes traded at least `ratio` times the hour's average 5-minute pace,
// more wallets bought than sold, the price is up more than `minPc` percent, and at least `minVol` USD traded in those
// 5 minutes (so a $400 blip on a sleepy coin doesn't count). Returns N (the ×N badge) or null.
function surgeScore(t) {
  const s5 = t.stats5m, s1 = t.stats1h; if (!s5 || !s1) return null;
  const pace = s1.vol / 12; if (!(pace > 0) || !(s5.vol > 0) || s5.vol < (Number(P.minVol) || 0)) return null;
  const n = s5.vol / pace;
  return n >= P.ratio && s5.netBuyers > 0 && s5.priceChange > P.minPc ? n : null;
}


// Trending fallback while Jupiter refuses (rate limit, outage) and nothing is cached: GeckoTerminal's Solana trending
// pools, one page of 20, through core's throttled gecko() lane (60 s cache, back-off after a 429).
const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : undefined);
async function geckoTrending(tf) {
  const out = [], seen = new Set();
  eachPool(await gecko(`/trending_pools?duration=${tf}&include=base_token,dex&page=1`), (a, mint, b, dex) => {
    if (seen.has(mint)) return; seen.add(mint);
    const st = (w) => ({ priceChange: nn(a.price_change_percentage?.[w]) ?? 0, vol: nn(a.volume_usd?.[w]) ?? 0, buys: nn(a.transactions?.[w]?.buys) ?? 0, sells: nn(a.transactions?.[w]?.sells) ?? 0 });
    const lp = dex === 'pump-fun' || dex === 'pumpswap' || /pump$/.test(mint) ? 'pump.fun' : /bonk$/.test(mint) ? 'letsbonk.fun' : undefined;
    out.push({ mint, symbol: str(b.symbol, 24), name: str(b.name, 80), image: b.image_url && !/missing/.test(b.image_url) ? img(b.image_url) || undefined : undefined,
      created: Date.parse(a.pool_created_at) || undefined, price: nn(a.base_token_price_usd), mcUsd: nn(a.market_cap_usd) || nn(a.fdv_usd), liquidity: nn(a.reserve_in_usd), launchpad: lp,
      stats5m: st('m5'), stats1h: st('h1'), stats6h: st('h6'), stats24h: st('h24') });
  });
  return out;
}

async function loadBoosted() {
  if (boosted && Date.now() - boosted.at < 25e3) return boosted.rows;
  const srcs = ['top', 'latest', 'profile', 'cto'];
  const res = await Promise.allSettled([ds.boosts('top'), ds.boosts('latest'), ds.profiles(), ds.ctos()]);
  if (res.every((r) => r.status === 'rejected')) throw res[0].reason;
  const promos = new Map();
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const p of r.value) {
      let e = promos.get(p.mint);
      if (!e) promos.set(p.mint, (e = { mint: p.mint, src: [], total: 0, icon: '', links: [], url: '' }));
      if (!e.src.includes(srcs[i])) e.src.push(srcs[i]);
      e.total = Math.max(e.total, p.total || 0, srcs[i] === 'profile' || srcs[i] === 'cto' ? 0 : p.amount || 0);
      e.icon ||= p.icon; e.url ||= p.url; if (!e.links.length) e.links = p.links;
    }
  });
  const mints = [...promos.keys()].slice(0, 120);
  const [pr, jr] = await Promise.allSettled([ds.tokens(mints), jt.search(mints)]);
  const pairs = pr.status === 'fulfilled' ? pr.value : new Map(), jts = new Map(jr.status === 'fulfilled' ? jr.value.map((t) => [t.mint, t]) : []);
  if (!pairs.size && !jts.size) throw pr.reason || jr.reason || new Error('No details for the promoted coins');
  const rows = [];
  mints.forEach((m, i) => {
    const e = promos.get(m), base = pairToken(pairs.get(m), m), j = jts.get(m);
    if (!base && !j) return;
    const t = { ...(base || { mint: m }) };
    if (j) for (const [k, v] of Object.entries(j)) if (v !== undefined) t[k] = v;
    for (const l of e.links) {
      const kind = (l.type || l.label || '').toLowerCase();
      if (kind === 'twitter' || kind === 'x') t.twitter ||= l.url; else if (kind === 'telegram') t.telegram ||= l.url; else if (kind.includes('web')) t.website ||= l.url;
    }
    t.image ||= e.icon || undefined; t.dexPaid = true;
    rows.push({ t, promo: e, rank: i });
  });
  boosted = { at: Date.now(), rows };
  return rows;
}

// ---- table pieces ----
const statOf = (t, tf) => t[SK[tf]] || null;
const M = {
  age: (r) => r.t.created ?? null,
  mc: (r) => r.t.mcUsd ?? null,
  chg: (r, tf) => statOf(r.t, tf)?.priceChange ?? null,
  liq: (r) => r.t.liquidity ?? null,
  vol: (r, tf) => statOf(r.t, tf)?.vol ?? null,
  txns: (r, tf) => { const s = statOf(r.t, tf); return s ? (s.buys || 0) + (s.sells || 0) : null; },
  top10: (r) => r.t.top10Pct ?? null,
  dev: (r) => r.t.devPct ?? null,
  organic: (r) => r.t.organicScore ?? null,
  surge: (r) => r.surge?.n ?? null,
  promo: (r) => r.promo?.total ?? null,
};
const FKEYS = ['mcMin', 'mcMax', 'liqMin', 'liqMax', 'volMin', 'volMax', 'txMin', 'orgMin', 't10Max'];
const activeFilters = () => FKEYS.filter((k) => parseAmt(P.f[k]) != null).length + (P.f.lps.length ? 1 : 0) + (P.f.paid ? 1 : 0) + (P.f.auth ? 1 : 0);

function applyFilters(rows, tab, tf) {
  const f = P.f, q = query.trim().toLowerCase(), v = {};
  for (const k of FKEYS) v[k] = parseAmt(f[k]);
  const rng = (x, lo, hi) => (lo == null && hi == null) || (x != null && (lo == null || x >= lo) && (hi == null || x <= hi));
  return rows.filter((r) => {
    const t = r.t;
    if ((tab.kind || tab.id === 'surge') && !P.majors && !t.launchpad && !r.gt) return false; // GeckoTerminal rows don't say
    if (q && !(t.symbol || '').toLowerCase().includes(q) && !(t.name || '').toLowerCase().includes(q) && !t.mint.toLowerCase().startsWith(q)) return false;
    if (f.lps.length && !f.lps.includes(t.launchpad || '')) return false;
    if (!rng(t.mcUsd, v.mcMin, v.mcMax) || !rng(t.liquidity, v.liqMin, v.liqMax) || !rng(M.vol(r, tf), v.volMin, v.volMax)) return false;
    if (v.txMin != null && !((M.txns(r, tf) ?? -1) >= v.txMin)) return false;
    if (v.orgMin != null && !((t.organicScore ?? -1) >= v.orgMin)) return false;
    if (v.t10Max != null && !(t.top10Pct != null && t.top10Pct <= v.t10Max)) return false;
    if (f.paid && !t.dexPaid) return false;
    if (f.auth && !(t.mintAuthDisabled === true && t.freezeAuthDisabled === true)) return false;
    if (tab.id === 'boosted' && P.promo !== 'all' && !r.promo?.src.includes(P.promo)) return false;
    return true;
  });
}
function sortRows(rows, tab, tf) {
  const s = P.sort && M[P.sort.key] && (P.sort.key !== 'surge' || tab.id === 'surge') && (P.sort.key !== 'promo' || tab.id === 'boosted') ? P.sort : null;
  if (!s) {
    if (tab.id === 'surge') return rows.sort((a, b) => (b.surge.live - a.surge.live) || (b.surge.n - a.surge.n));
    return rows.sort((a, b) => a.rank - b.rank);
  }
  const dir = s.dir === 'asc' ? 1 : -1, get = M[s.key];
  return rows.sort((a, b) => { const x = get(a, tf), y = get(b, tf); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x - y) * dir; });
}

const fx = (n) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n >= 0.01 ? n.toFixed(2) : '0');
function pills(t) {
  const out = [], p = (txt, k, title) => out.push(`<span class="pl ${k}" title="${esc(title)}">${txt}</span>`);
  if (t.top10Pct != null) p(`T10 ${fx(t.top10Pct)}%`, t.top10Pct > 35 ? 'bad' : t.top10Pct > 20 ? 'mid' : 'ok', `The top 10 holders own ${t.top10Pct.toFixed(1)}% of the supply`);
  if (t.devPct != null) p(`Dev ${fx(t.devPct)}%`, t.devPct > 10 ? 'bad' : t.devPct > 3 ? 'mid' : 'ok', `The creator holds ${t.devPct.toFixed(2)}% of the supply`);
  if (t.organicScore != null) p(`Org ${Math.round(t.organicScore)}`, t.organicScore >= 60 ? 'ok' : t.organicScore >= 30 ? 'mid' : 'bad', 'Jupiter organic score (0 to 100): how much activity looks like real people');
  if (t.mintAuthDisabled === true && t.freezeAuthDisabled === true) p('Auth ✓', 'ok', 'Mint and freeze authority are revoked');
  else {
    if (t.mintAuthDisabled === false) p('Mint', 'bad', 'Mint authority is on: more coins can be created');
    if (t.freezeAuthDisabled === false) p('Freeze', 'bad', 'Freeze authority is on: holders can be frozen');
  }
  if (t.dexPaid) p('DEX', 'acc', 'Someone paid Dexscreener for a profile, ad or boost');
  return out.join('') || '<span class="dim">—</span>';
}
const starBtn = (mint, on, ph = false) => `<button class="dsc-star${ph ? ' ph' : ''}${on ? ' on' : ''}" data-star="${esc(mint)}" aria-pressed="${on}" title="${on ? 'Remove from' : 'Add to'} watchlist" style="--f:${on ? 'var(--warn)' : 'none'}">${ICON.star}</button>`;
const clockTxt = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

function rowHtml(r, tab, tf, watched, flash) {
  const t = r.t, st = statOf(t, tf), soc = socials(t), chg = st?.priceChange;
  // how long it has surged: a second line only once it is a minute or more (a fresh "for 3s" on every row is noise)
  const sgFor = r.surge && Date.now() - r.surge.first >= 60e3;
  const extra = tab.id === 'surge'
    ? `<td class="c-sg" title="${r.surge.live ? `Surging since ${esc(clockTxt(r.surge.first))}` : 'Stopped qualifying: listed, dimmed, for up to 10 minutes'}"><span class="sg-x${r.surge.n >= 6 ? ' hot' : ''}${r.surge.live ? '' : ' cool'}">×${r.surge.n.toFixed(1)}</span>${r.surge.live ? (sgFor ? `<small>for <span data-age="${r.surge.first}">${agoTxt(r.surge.first)}</span></small>` : '') : '<small>cooling</small>'}</td>`
    : tab.id === 'boosted' ? `<td class="c-pr">${r.promo.src.map((s) => `<span class="pr pr-${s}">${PROMO[s]}</span>`).join('')}${r.promo.total ? `<small title="Active boost units on Dexscreener">${int(r.promo.total)} boosts</small>` : ''}</td>` : '';
  return `<tr data-mint="${esc(t.mint)}" class="${flash ? 'fresh' : ''}${tab.id === 'surge' && !r.surge.live ? ' cool' : ''}">
    <td class="c-pair"><div class="pc">${avatar(t, 'sm')}<div class="pc-t">
      <div class="pc-1"><b class="pc-sym">${esc(t.symbol || short(t.mint))}</b><span class="pc-nm">${esc(t.name || '')}</span><button class="copy" data-copy="${esc(t.mint)}" title="Copy address">${ICON.copy}</button>${starBtn(t.mint, watched.has(t.mint), true)}</div>
      <div class="pc-2">${t.created ? `<span class="age" data-age="${t.created}">${agoTxt(t.created)}</span>` : ''}${t.launchpad ? `<span class="pc-lp">${esc(lpName(t.launchpad))}</span>` : ''}${soc ? `<span class="soc">${soc}</span>` : ''}</div>
    </div></div></td>
    ${extra}
    <td class="c-spark">${sparkCell(t.mint)}</td>
    <td class="n c-mc"><b>${usd(t.mcUsd)}</b><small class="${cls(chg)}">${pct(chg)}</small></td>
    <td class="n c-liq">${usd(t.liquidity)}</td>
    <td class="n c-vol">${usd(st?.vol)}</td>
    <td class="n c-tx">${st ? `<b>${int((st.buys || 0) + (st.sells || 0))}</b><small><span class="up">${int(st.buys || 0)}</span>/<span class="down">${int(st.sells || 0)}</span></small>` : '—'}</td>
    <td class="c-info"><div class="pls">${pills(t)}</div></td>
    <td class="c-act"><div class="acts">${starBtn(t.mint, watched.has(t.mint))}${qbButton(t.mint)}</div></td>
  </tr>`;
}
// a loading row in the table's own columns: picture and two lines, the 8h block, number blocks, badges, the buttons
const skelRow = (tab) => `<tr class="sk" aria-hidden="true"><td class="c-pair"><div class="pc"><i class="skel sk-av"></i><div class="pc-t"><i class="skel sk-a"></i><i class="skel sk-b"></i></div></div></td>${tab.id === 'surge' || tab.id === 'boosted' ? `<td class="${tab.id === 'surge' ? 'c-sg' : 'c-pr'}"><i class="skel sk-n"></i></td>` : ''}<td class="c-spark"><i class="skel sk-sp"></i></td><td class="n c-mc"><i class="skel sk-n"></i><i class="skel sk-s"></i></td><td class="n c-liq"><i class="skel sk-n"></i></td><td class="n c-vol"><i class="skel sk-n"></i></td><td class="n c-tx"><i class="skel sk-n"></i><i class="skel sk-s"></i></td><td class="c-info"><i class="skel sk-pl"></i></td><td class="c-act"><div class="acts"><i class="skel sk-st"></i><i class="skel sk-qb"></i></div></td></tr>`;
function int(n) { n = Number(n) || 0; return Math.abs(n) < 1000 ? String(Math.round(n)) : num(n); }
function agoTxt(ms) { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; }

function headHtml(tab, tf) {
  const b = (key, label, title = '') => {
    const on = P.sort?.key === key;
    return `<button class="srt${on ? ' on' : ''}" data-sort="${key}"${title ? ` title="${esc(title)}"` : ''}>${label}<i>${on ? (P.sort.dir === 'asc' ? '↑' : '↓') : ''}</i></button>`;
  };
  const extra = tab.id === 'surge' ? `<th class="c-sg">${b('surge', 'Surge', 'Last 5 minutes of volume against the hourly pace')}</th>` : tab.id === 'boosted' ? `<th class="c-pr">${b('promo', 'Promotion', 'Paid Dexscreener promotion')}</th>` : '';
  return `<thead><tr>
    <th class="c-pair">${b('age', 'Pair', 'Sort by age')}</th>${extra}
    <th class="c-spark" title="Price over the last 8 hours (15-minute bars)">8h</th>
    <th class="n c-mc">${b('mc', 'MC')}<span class="sl">/</span>${b('chg', tf, `Price change, ${tf}`)}</th>
    <th class="n c-liq">${b('liq', 'Liquidity')}</th>
    <th class="n c-vol">${b('vol', 'Vol ' + tf)}</th>
    <th class="n c-tx">${b('txns', 'Txns ' + tf)}</th>
    <th class="c-info">${b('top10', 'T10')}${b('dev', 'Dev')}${b('organic', 'Organic')}</th>
    <th class="c-act"></th>
  </tr></thead>`;
}

// ---- sound for new surges (made only after you turn it on, so the browser allows it) ----
let actx = null;
function blip() {
  try {
    actx ||= new AudioContext();
    const t0 = actx.currentTime;
    for (const [f, d] of [[740, 0], [1180, 0.09]]) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.09, t0 + d + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.16);
      o.connect(g).connect(actx.destination); o.start(t0 + d); o.stop(t0 + d + 0.18);
    }
  } catch { /* no audio */ }
}

register({
  id: 'discover', tab: 'discover', match: /^#\/discover(?:\/([a-z]+))?$/,
  title: ([sub]) => { const t = TABS.find((x) => x.id === sub); return t && t.id !== 'trending' ? `${t.label} · Discover · Nought` : 'Discover · Nought'; },
  mount(view, [sub]) {
    const tab = TABS.find((x) => x.id === sub) || TABS[0];
    const st = { alive: true, busy: false, err: '', at: 0, seq: 0, rows: [], primed: false, flash: new Set(), filters: false };
    const isTable = tab.id !== 'overview';
    view.innerHTML = `<div class="dsc" data-tab="${tab.id}">
      <div class="dsc-bar">
        <nav class="dsc-tabs hfade" aria-label="Discover lists">${TABS.map((x) => `<a href="#/discover/${x.id}" class="${x.id === tab.id ? 'on' : ''}"${x.id === tab.id ? ' aria-current="page"' : ''}>${x.label}</a>`).join('')}</nav>
        <div class="dsc-tools" id="dsc-tools"></div>
      </div>
      <div class="dsc-filters" id="dsc-filters" hidden></div>
      <div class="dsc-note" id="dsc-note"></div>
      <div class="dsc-tw" id="dsc-tw"></div>
    </div>`;
    const tw = $('#dsc-tw', view), sparks = sparkWatcher(tw);
    { const nav = $('.dsc-tabs', view), on = $('.dsc-tabs a.on', view); if (on && on.offsetLeft + on.offsetWidth > nav.clientWidth) nav.scrollLeft = on.offsetLeft - 8; } // phones: show the open tab

    // toolbar
    function tools() {
      const tf = tab.id === 'surge' ? `<span class="dsc-fixed" title="Surge always looks at the last 5 minutes">5m window</span>`
        : `<div class="dsc-tf" role="group" aria-label="Time window">${INTERVALS.map((x) => `<button data-tf="${x}" class="${x === P.tf ? 'on' : ''}">${x}</button>`).join('')}</div>`;
      const n = activeFilters();
      $('#dsc-tools', view).innerHTML = `${tf}
        ${isTable ? `<label class="dsc-q">${ICON.search}<input id="dsc-q" placeholder="Name, ticker or address" value="${esc(query)}" spellcheck="false" autocomplete="off" aria-label="Filter coins"></label>
        <button class="dsc-btn${st.filters ? ' on' : ''}" id="dsc-fbtn" aria-expanded="${st.filters}">${ICON.filter}Filters${n ? `<b>${n}</b>` : ''}</button>` : ''}
        ${tab.kind || tab.id === 'surge' ? `<button class="dsc-btn tog${P.majors ? ' on' : ''}" id="dsc-majors" aria-pressed="${P.majors}" title="Also list coins that did not start on a launchpad (SOL, stablecoins, majors)">Majors</button>` : ''}
        ${tab.id === 'surge' ? `<span class="dsc-sg-cfg" role="group" aria-label="Surge rules"><em>Rules</em><label title="How many times the hourly pace the last 5 minutes must trade">Vol ×<input id="sg-ratio" inputmode="decimal" value="${esc(String(P.ratio))}" aria-label="Volume multiple"></label><label title="Minimum 5-minute price change">Price +<input id="sg-pc" inputmode="decimal" value="${esc(String(P.minPc))}" aria-label="Minimum price change, percent">%</label><label title="Minimum USD traded in the last 5 minutes">Vol $<input id="sg-vol" inputmode="decimal" value="${esc(String(P.minVol))}" aria-label="Minimum 5-minute volume, USD"></label></span><button class="dsc-btn tog${P.sound ? ' on' : ''}" id="sg-sound" aria-pressed="${P.sound}">Sound</button>` : ''}
        ${tab.id === 'boosted' ? `<div class="dsc-tf dsc-promo" role="group" aria-label="Promotion type">${[['all', 'All'], ...Object.entries(PROMO)].map(([k, l]) => `<button data-promo="${k}" class="${P.promo === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
        <span class="dsc-upd" id="dsc-upd"></span>`;
      upd();
    }
    function upd() {
      const el = $('#dsc-upd', view); if (!el) return;
      el.innerHTML = st.err && st.at ? `<span class="down" title="${esc(st.err)}">Refresh failed · data from <span data-age="${st.at}">${agoTxt(st.at)}</span> ago</span>`
        : st.at ? `<span class="dsc-live"></span>${st.gt ? '<span title="Jupiter is not answering: showing GeckoTerminal\'s trending pools until it does">GeckoTerminal fallback</span> · ' : ''}Updated <span data-age="${st.at}">${agoTxt(st.at)}</span> ago` : st.busy ? (st.err ? 'Retrying…' : 'Loading…') : st.err ? '<span class="down">Not loaded</span>' : '';
    }
    function note() {
      const el = $('#dsc-note', view), tf = P.tf;
      el.innerHTML = tab.id === 'surge'
        ? `<b>Surge</b> lists a coin when its last 5 minutes traded at least ×${esc(String(P.ratio))} its hourly pace, more wallets bought than sold, the price rose more than ${esc(String(P.minPc))}% and at least ${esc(usd(Number(P.minVol) || 0))} traded. Checked every 10 s on Jupiter's 5-minute trending and organic lists.`
        : tab.id === 'boosted' ? '<b class="warn">Boosted = paid promotion.</b> These coins paid Dexscreener for boosts, a profile or a takeover listing. Payment says nothing about safety. Solana only.'
          : tab.id === 'overview' ? `<b>Sampled</b>, not market-wide: launches and migrations are counted from the live stream since you opened Nought (<span data-age="${OPENED}">${agoTxt(OPENED)}</span> ago); list sums add up Jupiter's top-100 trending, organic and most-traded coins for ${esc(tf)}.`
            : st.gt ? 'Jupiter is not answering right now, so this is GeckoTerminal\'s trending list (20 pools, no holder data) until it does.' : esc(tab.note);
    }
    function filtersPanel() {
      const el = $('#dsc-filters', view);
      el.hidden = !st.filters || !isTable;
      if (el.hidden) { el.innerHTML = ''; return; }
      const f = P.f, seen = new Set([...LAUNCHPADS, ...st.rows.map((r) => r.t.launchpad).filter(Boolean), ...f.lps]);
      const inp = (k, ph) => `<input data-f="${k}" placeholder="${ph}" value="${esc(f[k] ?? '')}" inputmode="decimal" autocomplete="off">`;
      const tf = tab.id === 'surge' ? '5m' : P.tf;
      el.innerHTML = `<div class="fg wide"><span>Launchpads</span><div class="lps">${[...seen].map((lp) => `<button data-lp="${esc(lp)}" class="${f.lps.includes(lp) ? 'on' : ''}">${esc(lpLabel(lp))}</button>`).join('')}</div></div>
        <div class="fg"><span>Market cap</span><div class="mm">${inp('mcMin', 'min')}${inp('mcMax', 'max')}</div></div>
        <div class="fg"><span>Liquidity</span><div class="mm">${inp('liqMin', 'min')}${inp('liqMax', 'max')}</div></div>
        <div class="fg"><span>Volume ${esc(tf)}</span><div class="mm">${inp('volMin', 'min')}${inp('volMax', 'max')}</div></div>
        <div class="fg"><span>Txns ${esc(tf)}</span><div class="mm">${inp('txMin', 'min')}</div></div>
        <div class="fg"><span>Organic score</span><div class="mm">${inp('orgMin', 'min 0–100')}</div></div>
        <div class="fg"><span>Top 10 holders</span><div class="mm">${inp('t10Max', 'max %')}</div></div>
        <div class="fg checks"><label><input type="checkbox" data-fc="paid"${f.paid ? ' checked' : ''}> Dex paid</label><label><input type="checkbox" data-fc="auth"${f.auth ? ' checked' : ''}> Mint and freeze revoked</label></div>
        <div class="fg end"><span class="dim">Amounts take k, m, b (250k, 1.5m).</span><button class="dsc-btn" data-freset>Clear filters</button></div>`;
    }

    // body
    function render() {
      if (!st.alive) return;
      upd();
      if (tab.id === 'overview') return renderOverview();
      const tf = tab.id === 'surge' ? '5m' : P.tf;
      if (!st.rows.length) {
        if (st.busy || (!st.at && !st.err)) tw.innerHTML = `<table class="dsc-t" aria-busy="true">${headHtml(tab, tf)}<tbody>${skelRow(tab).repeat(10)}</tbody></table>`;
        else if (st.err) tw.innerHTML = `<div class="dsc-empty"><b>Could not load this list</b><span class="dim">${esc(st.err)}. Nought retries every ${tab.every / 1000} s.</span><button class="dsc-btn" data-retry>Try now</button></div>`;
        else tw.innerHTML = tab.id === 'surge' ? `<div class="dsc-empty"><span class="pulse-dot"></span><b>Nothing is surging right now</b><span class="dim">Checking every 10 s. Lower the thresholds above to see more.</span></div>`
          : '<div class="dsc-empty"><b>The list came back empty</b><span class="dim">Trying again shortly.</span></div>';
        return;
      }
      const rows = sortRows(applyFilters(st.rows, tab, tf), tab, tf);
      if (!rows.length) {
        tw.innerHTML = `<div class="dsc-empty"><b>No coins match your filters</b><span class="dim">${st.rows.length} coin${st.rows.length === 1 ? '' : 's'} hidden${!P.majors && (tab.kind || tab.id === 'surge') ? ' (majors are off)' : ''}.</span><button class="dsc-btn" data-freset>Clear filters</button></div>`;
        return;
      }
      const watched = new Set(watchMints()); // core/watchlist.js: the one shared starred list
      tw.innerHTML = `<table class="dsc-t">${headHtml(tab, tf)}<tbody>${rows.map((r) => rowHtml(r, tab, tf, watched, st.flash.has(r.t.mint))).join('')}</tbody></table>`;
      st.flash.clear();
      sparks.scan();
    }

    function renderOverview() {
      const now = Date.now(), tf = P.tf;
      const counted = (s) => {
        const m = new Map(), row = (lp) => m.get(lp) || m.set(lp, { m5: 0, h1: 0, all: 0, feed: 0 }).get(lp);
        for (const e of s.recent) { const x = row(e.lp); if (now - e.at < 300e3) x.m5++; x.h1++; }
        for (const [lp, n] of s.total) row(lp).all = n;
        return m;
      };
      const L = counted(sample.launch), G = counted(sample.migrate);
      // what the Pulse feed has seen in the last hour (covers launchpads the stream doesn't)
      for (const t of all()) {
        if (t.created && now - t.created < 3600e3) { const lp = t.launchpad || 'unknown'; (L.get(lp) || L.set(lp, { m5: 0, h1: 0, all: 0, feed: 0 }).get(lp)).feed++; }
        if (t.migratedAt && now - t.migratedAt < 3600e3) { const lp = t.launchpad || 'unknown'; (G.get(lp) || G.set(lp, { m5: 0, h1: 0, all: 0, feed: 0 }).get(lp)).feed++; }
      }
      const tbl = (m, what) => {
        const rows = [...m].sort((a, b) => b[1].all - a[1].all || b[1].feed - a[1].feed);
        if (!rows.length) return `<div class="dsc-empty sm"><span class="pulse-dot"></span><span class="dim">No ${what} seen yet. They show up here as the stream reports them.</span></div>`;
        const max = Math.max(1, ...rows.map(([, x]) => Math.max(x.h1, x.feed)));
        return `<table class="ov-t"><thead><tr><th>Launchpad</th><th class="n">5m</th><th class="n">1h</th><th class="n" title="Since you opened Nought">Since open</th><th class="n" title="Coins the Pulse feed saw in the last hour">Feed 1h</th><th class="bar"></th></tr></thead><tbody>${rows.map(([lp, x]) => `<tr><td${lp === 'unknown' ? ' class="dim"' : ''}>${esc(lpLabel(lp))}</td><td class="n">${x.m5}</td><td class="n">${x.h1}</td><td class="n"><b>${x.all}</b></td><td class="n dim">${x.feed}</td><td class="bar"><i style="width:${((Math.max(x.h1, x.feed) / max) * 100).toFixed(1)}%"></i></td></tr>`).join('')}</tbody></table>`;
      };
      // sums from the current top lists
      const seen = new Map();
      for (const k of ['toptrending', 'toporganicscore', 'toptraded']) for (const t of lists.get(k + ':' + tf)?.rows || []) if (!seen.has(t.mint)) seen.set(t.mint, t);
      const by = new Map();
      for (const t of seen.values()) {
        const lp = t.launchpad || 'none', s = statOf(t, tf) || {}, x = by.get(lp) || by.set(lp, { n: 0, vol: 0, org: 0, buys: 0, sells: 0, traders: 0, net: 0, mc: 0 }).get(lp);
        x.n++; x.vol += s.vol || 0; x.org += s.organicVol || 0; x.buys += s.buys || 0; x.sells += s.sells || 0; x.traders += s.traders || 0; x.net += s.netBuyers || 0; x.mc += t.mcUsd || 0;
      }
      const sums = [...by].sort((a, b) => b[1].vol - a[1].vol), tot = sums.reduce((a, [, x]) => { for (const k in x) a[k] = (a[k] || 0) + x[k]; return a; }, {});
      const launches = [...sample.launch.total.values()].reduce((a, b) => a + b, 0), migs = [...sample.migrate.total.values()].reduce((a, b) => a + b, 0);
      const kpi = (label, val, sub = '') => `<div class="kpi"><span>${label}</span><b>${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
      const lt = seen.size ? `<table class="ov-t wide"><thead><tr><th>Launchpad</th><th class="n">Coins</th><th class="n">Volume ${esc(tf)}</th><th class="n">Organic vol</th><th class="n">Buys</th><th class="n">Sells</th><th class="n">Traders</th><th class="n">Net buyers</th><th class="n">Total MC</th><th class="bar">Share of volume</th></tr></thead><tbody>${sums.map(([lp, x]) => `<tr><td${lp === 'none' ? ' class="dim" title="Coins that did not start on a launchpad"' : ''}>${esc(lpLabel(lp))}</td><td class="n">${x.n}</td><td class="n"><b>${usd(x.vol)}</b></td><td class="n">${usd(x.org)}</td><td class="n up">${int(x.buys)}</td><td class="n down">${int(x.sells)}</td><td class="n">${int(x.traders)}</td><td class="n ${cls(x.net)}">${int(x.net)}</td><td class="n">${usd(x.mc)}</td><td class="bar"><i style="width:${(tot.vol ? (x.vol / tot.vol) * 100 : 0).toFixed(1)}%"></i></td></tr>`).join('')}</tbody></table>`
        : st.err ? `<div class="dsc-empty sm"><b>Could not load the lists</b><span class="dim">${esc(st.err)}</span><button class="dsc-btn" data-retry>Try again</button></div>`
          : '<div class="dsc-empty sm"><span class="pulse-dot"></span><span class="dim">Loading the top lists…</span></div>';
      tw.innerHTML = `<div class="ov">
        <div class="kpis">
          ${kpi('Launches seen', int(launches), `since open · ${sample.launch.recent.filter((e) => now - e.at < 300e3).length} in 5m`)}
          ${kpi('Migrations seen', int(migs), launches ? `${((migs / launches) * 100).toFixed(1)}% of launches seen` : 'since open')}
          ${kpi('Coins in top lists', int(seen.size), `trending, organic, traded · ${esc(tf)}`)}
          ${kpi('List volume ' + esc(tf), usd(tot.vol || 0), `organic ${usd(tot.org || 0)}`)}
          ${kpi('Buys / sells', tot.buys || tot.sells ? `${(((tot.buys || 0) / ((tot.buys || 0) + (tot.sells || 0))) * 100).toFixed(0)}% buys` : '—', `${int(tot.buys || 0)} / ${int(tot.sells || 0)}`)}
          ${kpi('Net buyers', int(tot.net || 0), 'summed over the lists')}
        </div>
        <div class="ov-grid">
          <section class="ov-card"><h3>Launches by launchpad</h3>${tbl(L, 'launches')}</section>
          <section class="ov-card"><h3>Migrations by launchpad</h3>${tbl(G, 'migrations')}</section>
          <section class="ov-card span"><h3>Top lists by launchpad · ${esc(tf)}</h3><div class="ov-scroll hfade">${lt}</div></section>
        </div>
        <p class="ov-foot dim">The live stream reports pump.fun and LaunchLab launches; "Feed 1h" counts coins Nought's Pulse feed saw on every launchpad it covers. Counts reset when you reload.</p>
      </div>`;
    }

    // data
    async function load(force = false) {
      if (!st.alive || (st.busy && !force) || (document.hidden && !force)) return;
      st.busy = true; const my = ++st.seq, tf = P.tf;
      if (!st.at) upd();
      try {
        if (tab.kind) {
          let list, gt = false;
          try { list = await fetchList(tab.kind, tf); }
          catch (e) { if (tab.id !== 'trending' || (st.rows.length && !st.gt)) throw e; list = await geckoTrending(tf); gt = true; }
          if (my !== st.seq) return;
          st.rows = list.map((t, i) => ({ t, rank: i, gt })); st.gt = gt;
        }
        else if (tab.id === 'surge') { await loadSurge(my); if (my !== st.seq) return; }
        else if (tab.id === 'boosted') { const rows = await loadBoosted(); if (my !== st.seq) return; st.rows = rows; }
        else {
          const res = await Promise.allSettled(['toptrending', 'toporganicscore', 'toptraded'].map((k) => fetchList(k, tf)));
          if (my !== st.seq) return;
          if (res.every((r) => r.status === 'rejected')) throw res[0].reason;
        }
        st.err = ''; st.at = Date.now();
      } catch (e) { if (my === st.seq) st.err = e?.message || 'No answer'; }
      finally { if (my === st.seq) { st.busy = false; if (st.alive) { render(); if (tab.id === 'trending') note(); if (st.filters) refreshLps(); } } }
    }
    async function loadSurge(my) {
      const [a, b] = await Promise.allSettled([fetchList('toptrending', '5m'), fetchList('toporganicscore', '5m')]);
      if (a.status === 'rejected' && b.status === 'rejected') throw a.reason;
      if (my !== st.seq) return;
      const seen = new Map(), now = Date.now(), fresh = [];
      for (const r of [a, b]) if (r.status === 'fulfilled') for (const t of r.value) if (!seen.has(t.mint)) seen.set(t.mint, t);
      for (const t of seen.values()) {
        const n = surgeScore(t); if (n == null) continue;
        let s = surges.get(t.mint);
        if (!s || now - s.last > SURGE_COOL) { surges.set(t.mint, (s = { first: now, last: now, n, peak: n, t })); fresh.push(s); }
        else Object.assign(s, { last: now, n, peak: Math.max(s.peak, n), t });
      }
      for (const [m, s] of surges) {
        if (s.last === now) continue;
        if (now - s.last > SURGE_COOL) surges.delete(m); else if (seen.has(m)) s.t = seen.get(m);
      }
      st.rows = [...surges.values()].map((s) => ({ t: s.t, rank: 0, surge: { first: s.first, n: s.n, live: s.last === now } }));
      if (st.primed && fresh.length) {
        const shown = applyFilters(fresh.map((s) => ({ t: s.t, surge: s })), tab, '5m');
        for (const r of shown) st.flash.add(r.t.mint);
        if (shown.length && P.sound) blip();
      }
      st.primed = true;
    }
    function refreshLps() {
      const box = $('.lps', view); if (!box) return;
      const have = new Set([...box.querySelectorAll('[data-lp]')].map((b) => b.dataset.lp));
      if (st.rows.some((r) => r.t.launchpad && !have.has(r.t.launchpad))) filtersPanel();
    }

    // events
    let qTimer = 0, fTimer = 0;
    const root = $('.dsc', view);
    root.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-mint]');
      if (tr) { // the token page, quick buy and toasts read the store: hand it what this row knows
        const r = st.rows.find((x) => x.t.mint === tr.dataset.mint);
        if (r && (!tokens.has(r.t.mint) || !tokens.get(r.t.mint).symbol)) upsert(r.t.mint, r.t);
      }
      const b = e.target.closest('button'); if (!b || !root.contains(b)) return;
      const d = b.dataset;
      if (d.tf && d.tf !== P.tf) { P.tf = d.tf; save(); if (tab.kind) { st.rows = []; st.at = 0; st.err = ''; } tools(); note(); if (st.filters) filtersPanel(); render(); load(true); }
      else if (d.sort) {
        const s = P.sort; P.sort = s?.key !== d.sort ? { key: d.sort, dir: 'desc' } : s.dir === 'desc' ? { key: d.sort, dir: 'asc' } : null;
        save(); render();
      } else if (d.star) {
        const on = toggleWatch(d.star); // its 'watch' event (below) redraws every star for this coin, this one included
        if (b.isConnected) b.outerHTML = starBtn(d.star, on, b.classList.contains('ph'));
        const t = st.rows.find((x) => x.t.mint === d.star)?.t;
        toast(on ? `Watching ${esc(t?.symbol ? '$' + t.symbol : short(d.star))}. <a href="#/watch">Open watchlist</a>` : `Removed ${esc(t?.symbol ? '$' + t.symbol : short(d.star))} from your watchlist.`, on ? 'ok' : '');
      } else if (b.id === 'dsc-fbtn') { st.filters = !st.filters; tools(); filtersPanel(); }
      else if (b.id === 'dsc-majors') { P.majors = !P.majors; save(); tools(); render(); }
      else if (b.id === 'sg-sound') { P.sound = !P.sound; save(); tools(); if (P.sound) blip(); }
      else if (d.promo) { P.promo = d.promo in PROMO || d.promo === 'all' ? d.promo : 'all'; save(); tools(); render(); }
      else if (d.lp != null) { const i = P.f.lps.indexOf(d.lp); if (i >= 0) P.f.lps.splice(i, 1); else P.f.lps.push(d.lp); b.classList.toggle('on', i < 0); save(); tools(); render(); }
      else if (b.hasAttribute('data-freset')) { P.f = { lps: [] }; query = ''; save(); tools(); filtersPanel(); render(); }
      else if (b.hasAttribute('data-retry')) { st.err = ''; render(); load(true); }
    });
    root.addEventListener('input', (e) => {
      const el = e.target;
      if (el.id === 'dsc-q') { clearTimeout(qTimer); qTimer = setTimeout(() => { query = el.value; render(); }, 150); }
      else if (el.dataset.f) { clearTimeout(fTimer); fTimer = setTimeout(() => { P.f[el.dataset.f] = el.value.trim(); save(); tools(); render(); }, 250); }
    });
    root.addEventListener('change', (e) => {
      const el = e.target;
      if (el.dataset.fc) { P.f[el.dataset.fc] = el.checked; save(); tools(); render(); }
      else if (el.id === 'sg-ratio' || el.id === 'sg-pc' || el.id === 'sg-vol') {
        const v = parseAmt(el.value); // util's parseTarget: "2,5" is 2.5, "10k" is 10000, anything unclear resets to the default
        const ok = v != null && Number.isFinite(v) && v >= 0, clamp = (lo, hi) => Math.min(hi, Math.max(lo, v));
        if (el.id === 'sg-ratio') P.ratio = ok ? clamp(1, 12) : 3; // 12 = the whole hour traded in the last 5 minutes
        else if (el.id === 'sg-pc') P.minPc = ok ? clamp(0, 1000) : 5;
        else P.minVol = ok ? clamp(0, 1e9) : 1000;
        el.value = el.id === 'sg-ratio' ? P.ratio : el.id === 'sg-pc' ? P.minPc : P.minVol;
        surges.clear(); st.primed = false; st.rows = []; st.at = 0; // re-judge everything under the new rule, quietly
        save(); note(); render(); load(true);
      }
    });

    tools(); note(); render();
    // paint what's cached right away, then fetch
    if (tab.kind) { const hit = lists.get(tab.kind + ':' + P.tf); if (hit) { st.rows = hit.rows.map((t, i) => ({ t, rank: i })); st.at = hit.at; render(); } }
    if (tab.id === 'boosted' && boosted) { st.rows = boosted.rows; st.at = boosted.at; render(); }
    load(true);

    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    // a star changed somewhere else (token page, watchlist, the ticker strip, another tab): keep these in step
    const offWatch = on('watch', () => {
      root.querySelectorAll('[data-star]').forEach((b) => { const yes = watchlist.has(b.dataset.star); if (b.classList.contains('on') !== yes) b.outerHTML = starBtn(b.dataset.star, yes, b.classList.contains('ph')); });
    });
    const timers = [setInterval(() => load(), tab.every)];
    if (tab.id === 'overview') timers.push(setInterval(() => { if (!document.hidden) render(); }, 5000));
    return () => {
      st.alive = false; st.seq++;
      timers.forEach(clearInterval); clearTimeout(qTimer); clearTimeout(fTimer);
      document.removeEventListener('visibilitychange', onVis);
      offWatch();
      sparks.destroy();
    };
  },
});
