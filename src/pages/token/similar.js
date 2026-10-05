// Similar tokens and OG mode: coins that share this one's ticker or name (Jupiter token search by symbol and by name,
// deduped). Sort by market cap, or OG mode: oldest first, to spot the original among copycats. Each row opens that coin.
// mountSimilar(el, ctx) → cleanup.
import { esc, isMint, short, usd, ago, LS } from '../../core/util.js';
import { jt } from '../../core/jup.js';
import { upsert, tokens } from '../../core/store.js';
import { avatar } from '../../ui/card.js';
import { tokOf, subscribe, int } from './tabs.js';

const norm = (s) => String(s || '').toLowerCase().replace(/^\$/, '').replace(/\s+/g, ' ').trim();

export function mountSimilar(el, ctx) {
  const mint = ctx.mint, offs = [];
  const S = { alive: true, q: '', busy: false, err: '', list: null, tries: 0, og: LS.get('similar.og', false) === true };
  let retry = 0;
  el.innerHTML = `<div class="tt tt-sim"><div class="tt-ah"><h3>Similar coins</h3>
    <div class="tt-seg"><button data-og="0" class="${S.og ? '' : 'on'}">Top MC</button><button data-og="1" class="${S.og ? 'on' : ''}" title="Oldest first: find the original">OG</button></div></div>
    <div class="tt-sim-in"></div></div>`;
  const root = el.querySelector('.tt-sim'), box = root.querySelector('.tt-sim-in');

  async function search() {
    const t = tokOf(ctx), sym = norm(t.symbol || ctx.pair?.()?.baseToken?.symbol), name = norm(t.name || ctx.pair?.()?.baseToken?.name);
    if (!sym && !name) return;
    const q = sym + '|' + name;
    if (q === S.q || S.busy) return;
    S.q = q; S.busy = true; S.err = ''; render();
    const found = new Map(), errs = [];
    for (const term of [...new Set([sym, name].filter(Boolean))]) {
      try { for (const x of await jt.search(term)) if (!found.has(x.mint)) found.set(x.mint, x); }
      catch (e) { errs.push(e.message || 'Search failed'); }
      if (!S.alive) return;
    }
    if (!found.has(mint)) found.set(mint, { ...t, mint });
    S.list = [...found.values()].map((x) => ({ ...x, sameSym: !!sym && norm(x.symbol) === sym, sameName: !!name && norm(x.name) === name, self: x.mint === mint }))
      .filter((x) => x.self || x.sameSym || x.sameName || norm(x.symbol).includes(sym) || (name && norm(x.name).includes(name)));
    S.err = !found.size || (errs.length && S.list.length <= 1) ? errs[0] || '' : '';
    S.busy = false;
    // a busy Jupiter (429) answers again a little later: retry twice on our own
    if (errs.length && S.tries < 2) { S.tries++; retry = setTimeout(() => { if (S.alive) { S.q = ''; search(); } }, 12000 * S.tries); }
    render();
  }
  function render() {
    if (!S.alive) return;
    root.querySelectorAll('[data-og]').forEach((b) => b.classList.toggle('on', (b.dataset.og === '1') === S.og));
    if (!S.list) { box.innerHTML = S.err ? `<div class="tt-msg down">${esc(S.err)} <button class="tt-link" data-retry>Retry</button></div>` : `<div class="tt-msg"><span class="tt-spin"></span>${S.q ? 'Searching for coins with the same ticker or name…' : 'Waiting for this coin\'s ticker…'}</div>`; return; }
    const list = [...S.list].sort(S.og ? (a, b) => (a.created || Infinity) - (b.created || Infinity) : (a, b) => (b.mcUsd || 0) - (a.mcUsd || 0));
    const oldestSame = S.list.filter((x) => x.sameSym && x.created).sort((a, b) => a.created - b.created)[0]?.mint;
    if (list.length <= 1) {
      box.innerHTML = S.err ? `<div class="tt-msg">The search did not finish: <span class="down">${esc(S.err)}</span>. ${S.tries < 2 ? 'Trying again shortly.' : ''} <button class="tt-link" data-retry>Retry now</button></div>`
        : S.busy ? `<div class="tt-msg"><span class="tt-spin"></span>Searching…</div>` : '<div class="tt-msg">No other coins share this ticker or name.</div>';
      return;
    }
    box.innerHTML = `<div class="tt-sim-list">${list.slice(0, 30).map((x) => {
      const flags = [x.self ? '<span class="tt-b you">this coin</span>' : '', x.mint === oldestSame ? '<span class="tt-b ok" title="Oldest coin with this ticker">OG</span>' : '', x.verified ? '<span class="tt-b kol" title="Verified on Jupiter">verified</span>' : '', x.sameSym && !x.self ? '' : !x.self && x.sameName ? '<span class="tt-b lbl">same name</span>' : ''].join('');
      return `<a class="tt-sim-row${x.self ? ' self' : ''}" href="#/t/${esc(x.mint)}" data-go="${esc(x.mint)}">
        ${avatar(x, 'sm')}
        <span class="tt-sim-t"><span class="l1"><b>${esc(x.symbol || short(x.mint))}</b><span class="nm">${esc((x.name || '').slice(0, 40))}</span>${flags}</span>
        <span class="l2"><span>${x.created ? ago(x.created) + ' old' : 'age —'}</span>${x.launchpad ? `<span class="lp">${esc(x.launchpad)}</span>` : ''}${x.holders != null ? `<span>${int(x.holders)} holder${x.holders === 1 ? '' : 's'}</span>` : ''}${x.migrated ? '<span>migrated</span>' : ''}</span></span>
        <span class="tt-sim-n"><b>${usd(x.mcUsd)}</b><small>liq ${usd(x.liquidity)}</small></span></a>`;
    }).join('')}</div>${S.busy ? '<div class="tt-foot"><span class="tt-spin"></span>Searching…</div>' : ''}`;
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-og], [data-retry], [data-go]'); if (!b) return;
    if (b.dataset.og != null) { S.og = b.dataset.og === '1'; LS.set('similar.og', S.og); return render(); }
    if ('retry' in b.dataset) { S.q = ''; S.tries = 0; clearTimeout(retry); return search(); }
    if (b.dataset.go && isMint(b.dataset.go)) {
      // hand the coin we already know to the store so its page paints at once
      const x = S.list?.find((y) => y.mint === b.dataset.go);
      if (x && !x.self && !tokens.get(x.mint)?.symbol) { const { sameSym, sameName, self, ...patch } = x; upsert(x.mint, patch); }
    }
  });
  offs.push(subscribe(ctx, 'tokens', () => { if (!S.q || !S.list) search(); }));

  render(); search();
  return () => { S.alive = false; clearTimeout(retry); offs.forEach((f) => { try { f(); } catch { /* gone */ } }); el.innerHTML = ''; };
}
