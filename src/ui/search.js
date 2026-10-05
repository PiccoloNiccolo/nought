// Search: a dialog opened with / or the top bar. Jupiter's token search is the main source (200 ms debounce), with
// Dexscreener as the fallback; a pasted address also pulls the token's Dexscreener pools. Rows: picture, ticker, name,
// age, market cap, 24h volume, liquidity, socials, quick buy. Sort by relevance, market cap, volume or age.
// Arrow keys move, Enter opens, Esc closes. The last 20 opened coins are kept in this browser (LS 'recent'). With
// nothing typed it shows them, plus "Trending now": the five busiest coins Nought has seen this session (store).
import { $, $$, esc, safeUrl, isMint, usd, short, ago, LS, ICON, sleep } from '../core/util.js';
import { tokens, upsert, mcUsd } from '../core/store.js';
import { jt, ds } from '../core/jup.js';
import { applyPair } from '../core/meta.js';
import { avatar, socials, qbButton } from './card.js';

const SORTS = [['rel', 'Relevance'], ['mc', 'MC'], ['vol', 'Volume'], ['age', 'Newest']];
const S = { q: '', rows: [], src: '', sort: LS.get('search.sort', 'rel'), active: -1, seq: 0, timer: 0, wired: false, mode: 'recent', error: '' };
if (!SORTS.some(([k]) => k === S.sort)) S.sort = 'rel';

// ---- recent ----
// kept as {mint, symbol, name, image} and re-checked on every read (the list comes back from storage)
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const recent = () => { const l = LS.get('recent', []); return (Array.isArray(l) ? l : []).map((r) => (typeof r === 'string' ? { mint: r } : r)).filter((r) => r && isMint(r.mint)).slice(0, 20).map((r) => ({ mint: r.mint, symbol: str(r.symbol, 24), name: str(r.name, 60), image: safeUrl(r.image) || undefined })); };
function remember(row) {
  const keep = { mint: row.mint, symbol: row.symbol, name: row.name, image: row.image };
  LS.set('recent', [keep, ...recent().filter((r) => r.mint !== row.mint)].slice(0, 20));
}

// ---- both sources normalised to one row shape ----
// {mint, symbol, name, image, created, mc, vol, liq, twitter, telegram, website, verified, launchpad, progress, migrated, dex, rank}
function fromToken(t, rank) {
  const s = tokens.get(t.mint);
  return { mint: t.mint, symbol: t.symbol || s?.symbol, name: t.name || s?.name, image: t.image || s?.image, created: t.created || s?.created, mc: t.mcUsd ?? (s ? mcUsd(s) : null), vol: t.volume24h ?? s?.volume24h, liq: t.liquidity ?? s?.liquidity, twitter: t.twitter ?? s?.twitter, telegram: t.telegram ?? s?.telegram, website: t.website ?? s?.website, verified: t.verified, launchpad: t.launchpad ?? s?.launchpad, progress: t.progress ?? s?.progress, migrated: t.migrated ?? s?.migrated, rank };
}
function fromPair(p, rank) {
  const t = { mint: p.baseToken.address };
  applyPair(t, p); // name, symbol, picture, socials, market cap, liquidity (safe URLs)
  return { mint: t.mint, symbol: t.symbol, name: t.name, image: t.image, created: Number(p.pairCreatedAt) || undefined, mc: t.mcUsd, vol: Number(p.volume?.h24) || 0, liq: Number(p.liquidity?.usd) || 0, twitter: t.twitter, telegram: t.telegram, website: t.website, dex: typeof p.dexId === 'string' ? p.dexId : '', rank };
}
function bestPairs(pairs) {
  const best = new Map();
  for (const p of pairs) { const m = p.baseToken?.address; if (!isMint(m)) continue; const b = best.get(m); if (!b || (Number(p.liquidity?.usd) || 0) > (Number(b.liquidity?.usd) || 0)) best.set(m, p); }
  return [...best.values()];
}
function fromStore(q) {
  const ql = q.toLowerCase();
  return [...tokens.values()].filter((t) => (t.symbol || '').toLowerCase().startsWith(ql) || (t.name || '').toLowerCase().includes(ql)).sort((a, b) => (mcUsd(b) || 0) - (mcUsd(a) || 0)).slice(0, 6).map((t, i) => fromToken(t, i));
}

// ---- rendering ----
const sorted = () => {
  const r = [...S.rows], k = S.sort;
  if (k === 'mc') r.sort((a, b) => (b.mc || 0) - (a.mc || 0));
  else if (k === 'vol') r.sort((a, b) => (b.vol || 0) - (a.vol || 0));
  else if (k === 'age') r.sort((a, b) => (b.created || 0) - (a.created || 0));
  else r.sort((a, b) => a.rank - b.rank);
  return r;
};
const VERIFIED = '<svg viewBox="0 0 24 24" width="12" height="12" role="img" aria-label="Verified on Jupiter"><path fill="currentColor" d="m12 2 2.4 2.1 3.2-.3.9 3.1 2.8 1.6-1 3 1 3-2.8 1.6-.9 3.1-3.2-.3L12 22l-2.4-2.1-3.2.3-.9-3.1-2.8-1.6 1-3-1-3 2.8-1.6.9-3.1 3.2.3L12 2Zm-1.2 13.6 5.6-5.6-1.4-1.4-4.2 4.2-2-2-1.4 1.4 3.4 3.4Z"/></svg>';
function rowHtml(r, i) {
  const sym = r.symbol || short(r.mint, 4), soc = socials(r);
  const where = r.dex || (r.launchpad ? (r.migrated ? `${r.launchpad} · migrated` : r.progress > 0 ? `${r.launchpad} · ${(r.progress * 100).toFixed(0)}%` : r.launchpad) : '');
  return `<div class="sr" role="option" id="sr-${i}" data-go="${esc(r.mint)}" aria-selected="${i === S.active}">
    ${avatar({ ...r, symbol: sym }, 'sm')}
    <div class="sr-t"><div class="l1"><span class="sym">${esc(sym)}</span>${r.verified ? `<span class="sr-v">${VERIFIED}</span>` : ''}<span class="nm">${esc(r.name || '')}</span></div>
      <div class="l2"><span>${esc(short(r.mint, 4))}</span><button type="button" class="copy" data-copy="${esc(r.mint)}" title="Copy address" aria-label="Copy address">${ICON.copy}</button>${where ? `<span>${esc(where)}</span>` : ''}${soc ? `<span class="soc">${soc}</span>` : ''}</div></div>
    <div class="sr-nums"><span class="age">${r.created ? ago(r.created) : '—'}</span><span><i>MC </i>${usd(r.mc)}</span><span><i>V </i>${usd(r.vol)}</span><span><i>L </i>${usd(r.liq)}</span></div>
    ${qbButton(r.mint)}
  </div>`;
}
// the busiest coins in the store over the last hour (5-minute or 24-hour volume when that is all there is)
const NOT_MEMES = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);
function trending(skip, n = 5) {
  const vol = (t) => Number(t.stats1h?.vol) || Number(t.stats5m?.vol) * 12 || Number(t.volume24h) / 24 || 0;
  return [...tokens.values()].filter((t) => t.symbol && isMint(t.mint) && !skip.has(t.mint) && !NOT_MEMES.has(t.mint)).map((t) => [t, vol(t)]).filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}
const KEYS = `<div class="sr-keys" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span><span>Paste a token address to open it directly</span></div>`;
const COLS = '<div class="sr-cols" aria-hidden="true"><span></span><span>Token</span><span class="sr-nums"><span>Age</span><span>MC</span><span>Vol 24h</span><span>Liq</span></span><span class="qbw"></span></div>';
function paint() {
  const out = $('#search-out');
  $('#search-src').textContent = S.src;
  // the sort bar only while there are results to sort (no empty band under the input)
  const bar = S.mode === 'results' && S.rows.length > 0;
  $('#search-sort').hidden = !bar; $('#search-sort').parentElement.hidden = !bar;
  if (S.mode === 'recent') {
    const rec = recent().map((x, i) => fromToken({ ...x }, i)), hot = trending(new Set(rec.map((r) => r.mint))).map((t, i) => fromToken(t, rec.length + i));
    S.rows = [...rec, ...hot];
    out.innerHTML = S.rows.length
      ? (rec.length ? `<div class="sr-head"><span>Recent</span><button type="button" data-clear-recent>Clear</button></div>${COLS}${rec.map(rowHtml).join('')}` : '')
        + (hot.length ? `<div class="sr-head"><span>Trending now</span><small>busiest on Nought this hour</small></div>${rec.length ? '' : COLS}${hot.map((r, i) => rowHtml(r, rec.length + i)).join('')}` : '') + KEYS
      : '<div class="sr-note">Type a name or ticker, or paste a token address. Keys: <kbd>/</kbd> or <kbd>⌘K</kbd> opens search, <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Enter</kbd> opens a coin.</div>';
  } else if (S.mode === 'loading') {
    out.innerHTML = (S.rows.length ? `<div class="sr-head"><span>Seen on Nought</span><span>Searching…</span></div>${S.rows.map(rowHtml).join('')}` : '') + '<div class="sr-skel skel"></div><div class="sr-skel skel"></div><div class="sr-skel skel"></div>';
  } else if (S.mode === 'error') {
    out.innerHTML = `<div class="sr-note err" role="alert">Search is not answering right now (${esc(S.error)}). Paste a token address to open it directly.</div>`;
  } else {
    const rows = sorted();
    const direct = isMint(S.q) && !rows.some((r) => r.mint === S.q) ? `<div class="sr-open" role="option" id="sr-open" data-go="${esc(S.q)}"><span class="mono">${esc(S.q)}</span><span class="muted">Open this address</span></div>` : '';
    S.rows = rows;
    out.innerHTML = rows.length ? COLS + rows.map(rowHtml).join('') + direct : direct || `<div class="sr-note">No Solana tokens match “${esc(S.q)}”.</div>`;
  }
  $$('#search-sort button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sort === S.sort)));
  highlight(S.active, false);
}
const options = () => $$('#search-out [role="option"]');
function highlight(i, scroll = true) {
  const l = options();
  S.active = l.length ? Math.max(-1, Math.min(i, l.length - 1)) : -1;
  l.forEach((el, j) => { el.classList.toggle('on', j === S.active); el.setAttribute('aria-selected', String(j === S.active)); });
  const el = l[S.active];
  $('#search-q').setAttribute('aria-activedescendant', el?.id || '');
  if (el && scroll) el.scrollIntoView({ block: 'nearest' });
}

// ---- searching ----
function run() {
  const q = $('#search-q').value.trim(), my = ++S.seq;
  clearTimeout(S.timer);
  S.q = q; S.active = -1;
  if (!q || (q.length < 2 && !isMint(q))) { S.mode = 'recent'; S.src = ''; paint(); return; }
  S.rows = isMint(q) ? [] : fromStore(q); S.mode = 'loading'; S.src = ''; paint();
  S.timer = setTimeout(async () => {
    let rows = [], src = 'Jupiter', err = '';
    try {
      if (isMint(q)) {
        const jup = jt.search(q).then((l) => l.filter((t) => t.mint === q).map(fromToken)).catch(() => []);
        const pool = ds.pairs(q).then((p) => bestPairs(p)[0] || null).catch(() => null);
        let found = await Promise.race([jup, sleep(JUP_WAIT).then(() => null)]);
        const best = await pool;
        if (!found?.length && !best) found = await jup; // nothing on Dexscreener: wait for Jupiter after all
        if (found?.length) { rows = found.map((r) => ({ ...r, dex: typeof best?.dexId === 'string' ? best.dexId : '' })); if (best) src += ' · pools from Dexscreener'; }
        else if (best) { rows = [fromPair(best, 0)]; src = 'Dexscreener'; }
      } else {
        // Jupiter first; if it is slow (its queue is shared with the live feeds) or empty, Dexscreener answers instead
        const jup = jt.search(q).then((l) => l.map(fromToken));
        const quick = await Promise.race([jup.catch(() => []), sleep(JUP_WAIT).then(() => null)]);
        if (quick?.length) rows = quick;
        else {
          const dex = ds.search(q).then((p) => bestPairs(p).slice(0, 20).map(fromPair));
          const first = await firstFull([jup.then((r) => [r, 'Jupiter']), dex.then((r) => [r, 'Dexscreener'])]);
          if (first) [rows, src] = first;
          else err = (await jup.then(() => '', (e) => e.message)) || (await dex.then(() => '', (e) => e.message));
        }
      }
    } catch (e) { err = e.message || 'network error'; }
    if (my !== S.seq) return;
    if (!rows.length && err) { S.mode = 'error'; S.error = err; S.src = ''; paint(); return; }
    S.rows = rows; S.mode = 'results';
    S.src = rows.length ? `${rows.length} result${rows.length === 1 ? '' : 's'} · ${src}` : '';
    S.active = rows.length || isMint(q) ? 0 : -1;
    paint();
  }, 200);
}

const JUP_WAIT = 1800;
// the first promise to resolve with a non-empty list ([list, label]), or null when none does
function firstFull(ps) {
  return new Promise((res) => {
    let left = ps.length;
    for (const p of ps) p.then((v) => { if (v?.[0]?.length) res(v); else if (!--left) res(null); }, () => { if (!--left) res(null); });
  });
}

function go(mint) {
  if (!isMint(mint)) return;
  const row = S.rows.find((r) => r.mint === mint) || { mint };
  remember(row);
  // give the token page a head start with what search already knows (upsert skips undefined fields)
  if (!tokens.has(mint) && row.symbol) upsert(mint, { symbol: row.symbol, name: row.name, image: row.image, created: row.created, mcUsd: row.mc > 0 ? row.mc : undefined, liquidity: row.liq || undefined, twitter: row.twitter, telegram: row.telegram, website: row.website });
  $('#search-dlg').close();
  location.hash = '#/t/' + mint;
}

function note(html) {
  $('#search-out').querySelector('.sr-flash')?.remove();
  $('#search-out').insertAdjacentHTML('afterbegin', `<div class="sr-note sr-flash" role="status">${html}</div>`);
}
async function pasteCa() {
  const input = $('#search-q');
  try {
    const text = String((await navigator.clipboard.readText()) || '').trim();
    const m = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0];
    if (!m || !isMint(m)) { note('The clipboard does not hold a token address.'); input.focus(); return; }
    input.value = m; input.focus(); run();
  } catch {
    note(`This browser did not let Nought read the clipboard. Paste with ${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl'}+V instead.`);
    input.focus();
  }
}

function wire() {
  if (S.wired) return; S.wired = true;
  const d = $('#search-dlg'), input = $('#search-q'), out = $('#search-out');
  $('#search-sort').innerHTML = SORTS.map(([k, l]) => `<button type="button" data-sort="${k}" aria-pressed="${k === S.sort}">${l}</button>`).join('');
  $('#search-sort').addEventListener('click', (e) => { const b = e.target.closest('[data-sort]'); if (!b) return; S.sort = b.dataset.sort; LS.set('search.sort', S.sort); S.active = 0; paint(); });
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(S.active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(S.active - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const el = options()[S.active] || options()[0];
      if (el) go(el.dataset.go); else if (isMint(input.value.trim())) go(input.value.trim());
    }
  });
  out.addEventListener('click', (e) => {
    if (e.target.closest('[data-clear-recent]')) { LS.set('recent', []); paint(); input.focus(); return; }
    if (e.target.closest('a, button')) return; // socials, copy, quick buy
    const r = e.target.closest('[data-go]'); if (r) go(r.dataset.go);
  });
  out.addEventListener('mousemove', (e) => { const r = e.target.closest('[role="option"]'); if (r) { const i = options().indexOf(r); if (i !== S.active) highlight(i, false); } });
  const paste = $('#search-paste');
  if (!navigator.clipboard?.readText) paste.hidden = true;
  paste.addEventListener('click', pasteCa);
  $('#search-close').addEventListener('click', () => d.close());
  d.addEventListener('close', () => { clearTimeout(S.timer); S.seq++; });
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // a click on the backdrop
}

export function openSearch(prefill = '') {
  wire();
  const d = $('#search-dlg'), input = $('#search-q');
  input.value = typeof prefill === 'string' ? prefill : '';
  if (!d.open) d.showModal();
  input.focus(); input.select();
  run();
}
