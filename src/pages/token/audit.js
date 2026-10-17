// Token info (the audit): two wide tiles (mint and freeze authority) over a 3×3 grid of safety tiles (green / amber /
// red, thresholds editable), Jupiter Shield warnings, copy rows for the coin and its creator, and a bundle checker.
// mountAudit(el, ctx) → cleanup.
// Sources: the store token (Jupiter audit fields), jh holders (shared 15 s cache), ds.orders (Dex paid, cached 10 min,
// ≤1/s), ju.shield, GeckoTerminal pool info for locked liquidity (throttled fallback lane, cached 10 min here), and jx
// trade history (shared with the Trades/Top traders tabs) for the bundle heuristic.
import { esc, isMint, short, LS, ICON, pct } from '../../core/util.js';
import { ds, ju } from '../../core/jup.js';
import { gecko } from '../../core/seed.js';
import {
  EXT, solscanAcct, fmtSol, int, tokOf, supplyOf, isPool, hist, scanHistory, holdersOf, holdersState, hidden, subscribe,
} from './tabs.js';

// thresholds: [amber from, red from]; dir 'high' = higher is worse, 'low' = lower is worse
const DEFAULTS = {
  top10: { label: 'Top 10', amber: 20, red: 35, dir: 'high', unit: '%' },
  dev: { label: 'Dev holds', amber: 3, red: 10, dir: 'high', unit: '%' },
  snipers: { label: 'Snipers', amber: 5, red: 15, dir: 'high', unit: '%' },
  insiders: { label: 'Insiders', amber: 5, red: 15, dir: 'high', unit: '%' },
  clusters: { label: 'Clusters', amber: 5, red: 15, dir: 'high', unit: '%' },
  holders: { label: 'Holders', amber: 300, red: 100, dir: 'low', unit: '' },
  organic: { label: 'Organic', amber: 50, red: 25, dir: 'low', unit: '' },
};
function thresholds() {
  const saved = LS.get('audit.thresholds', {}) || {}, out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const s = saved[k] || {}, amber = Number(s.amber), red = Number(s.red);
    out[k] = { ...d, amber: isFinite(amber) && s.amber !== '' && s.amber != null ? amber : d.amber, red: isFinite(red) && s.red !== '' && s.red != null ? red : d.red };
  }
  return out;
}
const grade = (th, v) => (v == null || !isFinite(v) ? 'na' : th.dir === 'high' ? (v >= th.red ? 'bad' : v >= th.amber ? 'warn' : 'good') : v <= th.red ? 'bad' : v <= th.amber ? 'warn' : 'good');
// tile labels (the threshold editor keeps the longer DEFAULTS labels) and a small line icon per tile, drawn for Nought
const SHORT = { top10: 'Top 10 H.', dev: 'Dev H.', snipers: 'Snipers H.', insiders: 'Insiders H.', clusters: 'Clusters', lp: 'LP locked', holders: 'Holders', organic: 'Organic', dexpaid: 'Dex paid', mint: 'Mint authority', freeze: 'Freeze authority' };
// Dexscreener order types in words (the Dex paid caption)
const ORDER_T = { tokenProfile: 'profile', communityTakeover: 'community takeover', tokenAd: 'ad', trendingBarAd: 'trending bar ad' };
const ic = (d) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const TIC = {
  top10: ic('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.9-3.2 3-4.9 5.5-4.9s4.6 1.7 5.5 4.9M15.5 4.6a3.2 3.2 0 0 1 0 6.3M17.4 14.4c1.6.6 2.7 2.1 3.1 4.6"/>'),
  dev: ic('<circle cx="12" cy="8" r="3.6"/><path d="M5 20c1-3.6 3.7-5.5 7-5.5s6 1.9 7 5.5"/>'),
  snipers: ic('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),
  insiders: ic('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
  clusters: ic('<circle cx="7" cy="7.5" r="3"/><circle cx="17" cy="7.5" r="3"/><circle cx="12" cy="17" r="3"/><path d="M9.6 9.3l1.2 5M14.4 9.3l-1.2 5M10 7.5h4"/>'),
  lp: ic('<path d="M12 3.5s6 6.4 6 10.6a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5Z"/>'),
  holders: ic('<circle cx="12" cy="7.5" r="3.4"/><path d="M5 20c.9-3.7 3.6-5.6 7-5.6s6.1 1.9 7 5.6"/>'),
  organic: ic('<path d="M5 19c0-8 5-13 14-14 0 9-5 14-13 14"/><path d="M5 19c3-4 6-6.5 9-8"/>'),
  dexpaid: ic('<path d="M12 3 4.5 6v5.5c0 4.2 3 7.8 7.5 9.5 4.5-1.7 7.5-5.3 7.5-9.5V6L12 3Z"/><path d="m8.8 12 2.3 2.3 4.2-4.6"/>'),
  mint: ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 8v8M8 12h8"/>'),
  freeze: ic('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 6.5l2.5-2M9.5 19.5 12 17.5l2.5 2"/>'),
};

// locked liquidity per pool (GeckoTerminal is slow and strict: one look per pool every 10 minutes)
const LP = new Map();
function lockedLp(pool) {
  const c = LP.get(pool);
  if (c && Date.now() - c.at < 600e3) return c.p;
  const p = gecko('/pools/' + pool).then((j) => { const v = j?.data?.attributes?.locked_liquidity_percentage; return v == null || v === '' ? null : Number(v); });
  LP.set(pool, { at: Date.now(), p }); p.catch(() => LP.set(pool, { at: Date.now() - 540e3, p: Promise.resolve(undefined) }));
  return p;
}

// clusters: top holders that share a funding wallet (heuristic). Returns {groups: [{from, wallets[], pct}], pct, wallets}
function clustersOf(holders, supply) {
  const by = new Map();
  for (const h of holders) { if (isPool(h) || !h.funding?.from) continue; let g = by.get(h.funding.from); if (!g) by.set(h.funding.from, g = []); g.push(h); }
  const holderSet = new Map(holders.map((h) => [h.wallet, h]));
  // a holder funded by another top holder joins that holder's group too
  for (const h of holders) { if (isPool(h) || !h.funding?.from) continue; const parent = holderSet.get(h.funding.from); if (parent && !isPool(parent)) { const g = by.get(h.funding.from); if (g && !g.includes(parent)) g.push(parent); } }
  const groups = [...by.entries()].filter(([, l]) => l.length >= 2).map(([from, l]) => ({ from, wallets: l.map((h) => h.wallet), pct: (l.reduce((a, h) => a + h.amount, 0) / supply) * 100 })).sort((a, b) => b.pct - a.pct);
  const inGroup = new Set(groups.flatMap((g) => g.wallets));
  const pctAll = [...inGroup].reduce((a, w) => a + (holderSet.get(w)?.amount || 0), 0) / supply * 100;
  return { groups, pct: pctAll, wallets: inGroup.size };
}
// bundles: ≥4 buys from different wallets in the same second (heuristic). txs newest first.
function bundlesOf(txs) {
  const bySec = new Map();
  for (const x of txs) { if (x.side !== 'buy') continue; const s = Math.floor(x.at / 1000); let g = bySec.get(s); if (!g) bySec.set(s, g = []); g.push(x); }
  const groups = [];
  for (const [sec, l] of bySec) { const ws = new Set(l.map((x) => x.wallet)); if (ws.size >= 4) groups.push({ sec, wallets: [...ws], sol: l.reduce((a, x) => a + x.sol, 0), buys: l.length }); }
  return groups.sort((a, b) => a.sec - b.sec);
}

export function mountAudit(el, ctx) {
  const mint = ctx.mint, offs = [], timers = [];
  const S = { alive: true, dex: null, dexErr: false, shield: null, shieldErr: false, lp: undefined, lpPool: '', edit: false, bundle: { running: false, stopped: false } };
  el.innerHTML = `<div class="tt tt-audit"><div class="tt-ah"><h3>Token info</h3><button class="tt-x tt-thr-b" data-thr title="Thresholds: when tiles turn amber or red" aria-label="Edit thresholds">${ic('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>')}</button></div><div class="tt-aud-in"></div></div>`;
  const root = el.querySelector('.tt-audit'), box = root.querySelector('.tt-aud-in');

  function tiles() {
    const t = tokOf(ctx), th = thresholds(), supply = supplyOf(ctx), hs = holdersState(mint), hd = hs?.data;
    const cl = hd ? clustersOf(hd.holders, supply) : null;
    const pool = poolOf(t);
    const f = (v, d = 1) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(d) + '%');
    // sub: the one-line caption under the value; tip: the longer explanation in its tooltip
    const lp = onCurve(t) ? { v: 'In curve', g: 'good', lab: 'Liquidity', sub: 'launchpad curve', tip: 'Liquidity sits in the launchpad curve' }
      : S.lp === undefined ? { v: '—', g: 'na', sub: freshPool(t) ? 'checking soon' : pool ? 'checking…' : 'pool unknown', tip: freshPool(t) ? 'The pool just opened; checking soon' : '' }
      : S.lp === null ? { v: '—', g: 'na', sub: 'not reported' }
      : { v: f(S.lp, 0), g: S.lp >= 95 ? 'good' : S.lp >= 50 ? 'warn' : 'bad', sub: 'locked or burned', tip: 'Share of pool liquidity locked or burned (GeckoTerminal)' };
    const dexPaid = S.dex ? S.dex.paid : t.dexPaid;
    // Jupiter's holderChange is a percentage change over the window, not a count
    const holders = t.holders ?? hd?.count, hc = Number(t.stats1h?.holderChange) || 0;
    const list = [
      { k: 'top10', v: t.top10Pct, txt: f(t.top10Pct), sub: 'of supply', tip: 'Share of supply in the 10 largest wallets' },
      { k: 'dev', v: t.devPct, txt: f(t.devPct, 2), sub: t.dev ? short(t.dev) : 'creator unknown', tip: t.dev ? 'Held by the creator ' + t.dev : '' },
      { k: 'snipers', v: t.sniperPct, txt: f(t.sniperPct), sub: 'early snipers', tip: 'Share of supply held by early snipers' },
      { k: 'insiders', v: t.insiderPct, txt: f(t.insiderPct), sub: 'insiders', tip: 'Share of supply held by insiders' },
      { k: 'clusters', v: cl?.pct, txt: cl ? f(cl.pct) : hs?.err ? '—' : '…', sub: cl ? (cl.groups.length ? `${cl.groups.length} funder${cl.groups.length > 1 ? 's' : ''} · ${cl.wallets} wallets` : 'none found') : 'shared funders', tip: cl ? (cl.groups.length ? `${cl.wallets} top holders share ${cl.groups.length} funding wallet${cl.groups.length > 1 ? 's' : ''} (heuristic)` : 'No top holders share a funding wallet (heuristic)') : 'Top holders that share a funding wallet (heuristic)' },
      { k: 'lp', label: 'Liquidity', lab: lp.lab, txt: lp.v, g: lp.g, sub: lp.sub, tip: lp.tip },
      { k: 'holders', v: holders, txt: int(holders), sub: hc ? `${pct(hc)} in 1h` : '', tip: 'Wallets holding the coin' },
      { k: 'organic', v: t.organicScore, txt: t.organicScore != null ? Math.round(t.organicScore) + '' : '—', sub: t.organicLabel ? String(t.organicLabel) : 'Jupiter score', tip: 'Real-trader activity score from Jupiter (0 to 100)' },
      { k: 'dexpaid', label: 'Dex paid', txt: dexPaid == null ? (S.dexErr ? '—' : '…') : dexPaid ? 'Paid' : 'No', g: dexPaid == null ? 'na' : dexPaid ? 'good' : 'warn', sub: S.dex?.orders?.length ? S.dex.orders.filter((o) => o.status === 'approved').map((o) => ORDER_T[o.type] || o.type).slice(0, 2).join(', ') || 'Dexscreener' : 'profile or ads', tip: 'Whether the coin paid for a Dexscreener profile or ads' },
    ];
    // value (with its icon, coloured by grade) on top, the short label under it; the caption and the thresholds sit in
    // the tooltip, and the caption also shows as a third line on touch screens (no hover there to open a tooltip)
    return list.map((x) => {
      const def = th[x.k], g = x.g || grade(def, x.v);
      const tip = [x.tip || '', x.sub && x.sub !== x.tip ? x.sub : '', def ? `amber ${def.dir === 'high' ? '≥' : '≤'} ${def.amber}${def.unit}, red ${def.dir === 'high' ? '≥' : '≤'} ${def.red}${def.unit}` : ''].filter(Boolean).join(' · ');
      return `<div class="tt-tile g-${g}" title="${esc(`${x.label || def.label}: ${tip}`)}"><b>${TIC[x.k] || ''}<em>${esc(x.txt)}</em></b><span>${esc(x.lab || SHORT[x.k] || x.label || def.label)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</div>`;
    }).join('');
  }
  // the two wide tiles on top: mint and freeze authority
  function authTiles() {
    const t = tokOf(ctx);
    const tile = (k, v, what) => {
      const g = v === true ? 'good' : v === false ? 'bad' : 'na', txt = v === true ? 'Revoked' : v === false ? 'Active' : 'Unknown';
      const tip = v === true ? `${SHORT[k]} revoked: the creator cannot ${what}` : v === false ? `${SHORT[k]} active: the creator can still ${what}` : `${SHORT[k]} not known yet`;
      return `<div class="tt-tile wide g-${g}" title="${esc(tip)}"><b>${TIC[k]}<em>${txt}</em></b><span>${SHORT[k]}</span></div>`;
    };
    return tile('mint', t.mintAuthDisabled, 'mint more') + tile('freeze', t.freezeAuthDisabled, 'freeze wallets');
  }
  function rows() {
    const t = tokOf(ctx), warns = S.shield || [];
    const sev = (s) => (/crit|high|danger|warn/i.test(s) ? 'down' : /med/i.test(s) ? 'warn' : 'muted');
    const xq = (q) => 'https://x.com/search?q=' + encodeURIComponent(q) + '&f=live';
    return `<div class="tt-arow"><span>Coin</span><b class="mono">${esc(short(mint, 5))}</b><span class="tt-acts"><button class="copy" data-copy="${esc(mint)}" title="Copy address" aria-label="Copy coin address">${ICON.copy}</button><a href="https://solscan.io/token/${esc(mint)}" target="_blank" rel="noopener" title="Solscan" aria-label="Coin on Solscan">${EXT}</a><a href="${esc(xq(mint))}" target="_blank" rel="noopener" title="Search X for this address" aria-label="Search X">${ICON.x}</a></span></div>
      ${isMint(t.dev) ? `<div class="tt-arow"><span>Creator</span><button class="tt-w mono" data-scan="${esc(t.dev)}" title="Scan the creator">${esc(short(t.dev, 5))}</button><span class="tt-acts"><button class="copy" data-copy="${esc(t.dev)}" title="Copy address" aria-label="Copy creator address">${ICON.copy}</button><a href="${esc(solscanAcct(t.dev))}" target="_blank" rel="noopener" title="Solscan" aria-label="Creator on Solscan">${EXT}</a><a href="${esc(xq(t.dev))}" target="_blank" rel="noopener" title="Search X for this address" aria-label="Search X">${ICON.x}</a></span></div>` : ''}
      <div class="tt-shield"><span class="tt-sh-h">Jupiter Shield</span>${S.shield == null ? (S.shieldErr ? '<span class="dim">Warnings did not load.</span>' : '<span class="dim">Checking…</span>') : warns.length ? warns.map((w) => `<span class="tt-warn ${sev(w.severity)}" title="${esc(w.message)}">${esc(w.message || w.type)}</span>`).join('') : '<span class="up">No warnings.</span>'}</div>`;
  }
  function bundleBox() {
    const h = hist(mint), B = S.bundle, groups = bundlesOf(h.txs), hd = holdersState(mint)?.data, supply = supplyOf(ctx);
    const wallets = new Set(groups.flatMap((g) => g.wallets));
    const held = hd ? hd.holders.filter((x) => wallets.has(x.wallet)).reduce((a, x) => a + x.amount, 0) : null;
    const tagged = hd ? hd.holders.filter((x) => x.tags.some((g) => /bundl/i.test(g))).length : null;
    const span = h.txs.length ? `${int(h.txs.length)} trades${h.done ? ', back to the first one' : ' (the latest ones; older trades not read yet)'}` : '';
    const status = B.running ? `<span class="tt-spin"></span>Reading trades… ${int(h.txs.length)} <button class="tt-link" data-bstop>Stop</button>`
      : h.done ? '' : `<button class="tt-link" data-bgo>${h.txs.length ? 'Read further back' : 'Run check'}</button>`;
    const verdict = !h.txs.length ? '<span class="dim">Not run yet.</span>'
      : groups.length ? `<b class="${groups.length >= 3 ? 'down' : 'warn'}">${groups.length} same-second buy group${groups.length > 1 ? 's' : ''}</b> · ${wallets.size} wallets · ${fmtSol(groups.reduce((a, g) => a + g.sol, 0))} SOL${held == null ? '' : held > 0 ? ` · those wallets hold ${((held / supply) * 100).toFixed(2)}% now (counting top-100 holders)` : ' · none of them is a top-100 holder now'}`
      : '<b class="up">No same-second buy groups</b>';
    return `<div class="tt-bundle">
      <div class="tt-bh"><span>Bundle check <em>heuristic</em></span><span class="dim">${status}</span></div>
      <div class="tt-bv">${verdict}</div>
      ${groups.length ? `<div class="tt-bg">${groups.slice(0, 6).map((g) => `<div><span class="mono">${esc(new Date(g.sec * 1000).toLocaleTimeString())}</span> ${g.wallets.length} wallets · ${fmtSol(g.sol)} SOL <span class="tt-bw">${g.wallets.slice(0, 4).map((w) => `<button class="tt-w" data-scan="${esc(w)}">${esc(short(w, 3))}</button>`).join('')}</span></div>`).join('')}</div>` : ''}
      <p class="dim">Flags 4 or more buys from different wallets in the same second${span ? ', across ' + span : ''}.${tagged ? ` Jupiter also tags ${tagged} top holder${tagged > 1 ? 's' : ''} as bundlers.` : ''} Same-second buys can be coordinated, or just busy moments: treat this as a hint.</p>
    </div>`;
  }
  function thrEditor() {
    const th = thresholds();
    return `<div class="tt-thr"><p class="dim">Tiles turn amber and red at these values.</p>${Object.entries(th).map(([k, d]) => `<label><span>${esc(d.label)} <em>${d.dir === 'high' ? 'higher is worse' : 'lower is worse'}</em></span><input data-tk="${k}" data-tw="amber" inputmode="decimal" value="${esc(String(d.amber))}" aria-label="${esc(d.label)} amber"><input data-tk="${k}" data-tw="red" inputmode="decimal" value="${esc(String(d.red))}" aria-label="${esc(d.label)} red"></label>`).join('')}
      <div class="tt-acts"><button class="btn tt-sm" data-thrreset>Reset</button><button class="btn btn-accent tt-sm" data-thr>Done</button></div></div>`;
  }
  function render() {
    if (!S.alive) return;
    if (S.edit && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    box.innerHTML = S.edit ? thrEditor() : `<div class="tt-grid">${authTiles()}${tiles()}</div>${rows()}${bundleBox()}`;
    root.querySelector('[data-thr]')?.classList.toggle('on', S.edit);
  }
  let soon = 0;
  const renderSoon = () => { if (!soon) soon = setTimeout(() => { soon = 0; render(); }, 200); };

  // data
  async function loadOnce() {
    // Dex paid and Shield: one look each, with two slower retries if the host is busy
    const retry = (fn, ok, fail, n = 0) => fn().then(ok).catch(() => { if (n < 2 && S.alive) timers.push(setTimeout(() => S.alive && retry(fn, ok, fail, n + 1), 6000 * (n + 1))); else fail(); }).finally(renderSoon);
    retry(() => ds.orders(mint), (d) => { S.dex = d; S.dexErr = false; }, () => { S.dexErr = true; });
    retry(() => ju.shield([mint]), (m) => { S.shield = m[mint] || []; S.shieldErr = false; }, () => { S.shieldErr = true; });
    holdersOf(mint).catch(() => null).finally(renderSoon);
    checkLp();
    // the bundle check reads up to 10 pages by itself when the coin is young (cheap, and that's when bundles matter)
    const t = tokOf(ctx), young = t.created && Date.now() - t.created < 6 * 3600e3;
    if (young || !t.created) runBundle(10); else { const h = hist(mint); if (h.next === undefined) runBundle(1); }
  }
  // still on a launchpad curve: there is no LP to lock yet. Otherwise the migrated pool, or the best Dexscreener pair.
  const onCurve = (t) => !t.migrated && (!!t.launchpad || t.progress > 0);
  const poolOf = (t) => (onCurve(t) ? '' : t.gradPool || ctx.pair?.()?.pairAddress || t.pool || '');
  // GeckoTerminal indexes a new pool a few minutes after migration: until then, don't ask (it answers 404)
  const freshPool = (t) => t.migratedAt > 0 && Date.now() - t.migratedAt < 300e3;
  function checkLp() {
    const t = tokOf(ctx), pool = poolOf(t);
    if (!pool || !isMint(pool) || pool === S.lpPool || freshPool(t)) return;
    S.lpPool = pool; S.lp = undefined;
    lockedLp(pool).then((v) => { if (S.lpPool === pool) S.lp = v === undefined ? null : v; }).catch(() => { if (S.lpPool === pool) S.lp = null; }).finally(renderSoon);
  }
  function runBundle(maxPages = 150) {
    const B = S.bundle, h = hist(mint);
    if (B.running || h.done) return;
    B.running = true; B.stopped = false; render();
    scanHistory(h, { maxPages: Math.max(maxPages, h.pages + 1), rps: 3, stop: () => !S.alive || B.stopped, progress: renderSoon })
      .finally(() => { B.running = false; renderSoon(); });
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if ('thr' in d) { S.edit = !S.edit; if (!S.edit && document.activeElement) document.activeElement.blur?.(); box.innerHTML = ''; return render(); }
    if ('thrreset' in d) { LS.set('audit.thresholds', {}); box.innerHTML = ''; return render(); }
    if ('bgo' in d) return runBundle(150);
    if ('bstop' in d) { S.bundle.stopped = true; return; }
    if (d.scan && isMint(d.scan)) ctx.openScan?.(d.scan);
  });
  root.addEventListener('change', (e) => {
    const t = e.target; if (!t.matches('[data-tk]')) return;
    const v = Number(String(t.value).replace(',', '.')), saved = LS.get('audit.thresholds', {}) || {};
    if (!isFinite(v) || t.value.trim() === '') { t.value = thresholds()[t.dataset.tk][t.dataset.tw]; return; }
    saved[t.dataset.tk] = { ...(saved[t.dataset.tk] || {}), [t.dataset.tw]: v };
    LS.set('audit.thresholds', saved);
  });

  offs.push(subscribe(ctx, 'tokens', () => { checkLp(); renderSoon(); }));
  offs.push(subscribe(ctx, 'trade', (d) => { if (d?.mint === mint && !S.edit) renderSoon(); }));
  // holders refresh with the Holders tab's cadence (shared cache): re-read every 15 s while visible
  timers.push(setInterval(() => { if (!hidden() && S.alive) { holdersOf(mint).then(renderSoon).catch(() => {}); checkLp(); } }, 15000));

  render(); loadOnce();
  return () => {
    S.alive = false; S.bundle.stopped = true;
    timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); clearTimeout(soon);
    offs.forEach((f) => { try { f(); } catch { /* gone */ } });
    el.innerHTML = '';
  };
}
