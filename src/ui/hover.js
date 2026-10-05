// Hover previews for coin cards: point at a card's picture to get a bigger picture with reverse-image search
// link-outs, a one-hour market-cap chart (Jupiter charts, 1-minute candles) and, when Jupiter knows it, where the
// creator wallet got its SOL (only if the creator is among the top 100 holders). Both lookups are cached 30 s.
//   attachHover(root, {hold}) → detach()   Hovers any [data-hv="<mint>"] inside root. Does nothing on touch screens.
//   hold(true|false) is called while the pointer is inside the preview (Pulse keeps that column still).
import { esc, short, isMint } from '../core/util.js';
import { tokens, mcUsd } from '../core/store.js';
import { jc, jh } from '../core/jup.js';
import { img, cidPath, GATEWAYS } from '../core/meta.js';
import { imageSources } from '../core/jup.js';
import { tokenImage } from './token-image.js';
import { money, lpInfo } from './card.js';

const TTL = 30e3;
const charts = new Map(), holders = new Map(); // mint → {at, p}
function cached(map, mint, fn) {
  const hit = map.get(mint); if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = fn(); map.set(mint, { at: Date.now(), p }); p.catch(() => map.delete(mint));
  if (map.size > 150) map.delete(map.keys().next().value);
  return p;
}
const agoTxt = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 3600 ? Math.max(1, Math.floor(s / 60)) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; };
const solscan = (a) => `<a href="https://solscan.io/account/${esc(a)}" target="_blank" rel="noopener" class="mono">${esc(short(a))}</a>`;

// a public URL search engines can fetch: the IPFS original without resizing, or the picture's own address
function publicImage(u) { const c = cidPath(u); return c ? GATEWAYS[0] + c : img(u, 0); }
function reverseLinks(u) {
  const e = encodeURIComponent(u);
  return [['Google Lens', `https://lens.google.com/uploadbyurl?url=${e}`], ['Yandex', `https://yandex.com/images/search?rpt=imageview&url=${e}`], ['Bing', `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${e}`], ['TinEye', `https://tineye.com/search?url=${e}`]]
    .map(([l, h]) => `<a href="${esc(h)}" target="_blank" rel="noopener nofollow">${l}</a>`).join('');
}

// tiny candle chart as SVG (no library: it lives for a second or two)
function candles(bars) {
  const W = 276, H = 78, n = bars.length, lo = Math.min(...bars.map((b) => b.low)), hi = Math.max(...bars.map((b) => b.high)), span = hi - lo || hi || 1;
  const y = (v) => (H - 4 - ((v - lo) / span) * (H - 8)).toFixed(1), step = W / Math.max(n, 30), bw = Math.max(1.5, step * 0.62), x0 = W - n * step; // newest candle at the right edge
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true">${bars.map((b, i) => {
    const x = (x0 + i * step + step / 2).toFixed(1), up = b.close >= b.open, c = up ? 'var(--up)' : 'var(--down)', top = y(Math.max(b.open, b.close)), bot = y(Math.min(b.open, b.close));
    return `<line x1="${x}" x2="${x}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${c}" stroke-width="1"/><rect x="${(x - bw / 2).toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${Math.max(1, bot - top).toFixed(1)}" fill="${c}"/>`;
  }).join('')}</svg>`;
}

export function attachHover(root, { hold } = {}) {
  if (typeof matchMedia === 'function' && matchMedia('(hover: none)').matches) return () => {};
  const pop = document.createElement('div'); pop.className = 'hv-pop'; pop.hidden = true; pop.setAttribute('role', 'tooltip');
  document.body.appendChild(pop);
  let openT = 0, hideT = 0, anchor = null, cur = '', held = false;
  const setHold = (h) => { if (held === h) return; held = h; try { hold?.(h); } catch (e) { console.error(e); } };

  function place() {
    if (!anchor?.isConnected) return hide();
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, vw = innerWidth, vh = innerHeight;
    let left = r.right + 10; if (left + w > vw - 8) left = r.left - w - 10; if (left < 8) left = Math.max(8, Math.min(vw - w - 8, r.left));
    let top = r.top - 6; if (top + h > vh - 8) top = vh - h - 8; if (top < 8) top = 8;
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  function hide() { clearTimeout(openT); clearTimeout(hideT); pop.hidden = true; anchor = null; cur = ''; setHold(false); }
  const later = () => { clearTimeout(hideT); hideT = setTimeout(hide, 160); };

  function open(av) {
    const mint = av.dataset.hv, t = tokens.get(mint); if (!t || !isMint(mint)) return;
    anchor = av; cur = mint;
    const big = imageSources(t, 360).length > 0, pub = t.image ? publicImage(t.image) : '', lp = lpInfo(t.launchpad);
    const sym = (t.symbol || '').replace(/^\$/, '').slice(0, 2).toUpperCase() || '?';
    // The same image recovery and request budget apply to the larger preview.
    pop.className = 'hv-pop' + (big ? '' : ' noimg');
    pop.innerHTML = `<div class="hv-img">${tokenImage(t, 360)}<span>${esc(sym)}</span></div>
      <div class="hv-b">
        <div class="hv-t"><b>${esc(t.symbol || short(mint))}</b><span>${esc(t.name || '')}</span>${lp ? `<em style="--lp:${lp.color}">${esc(lp.label)}</em>` : ''}</div>
        ${pub ? `<div class="hv-links"><span>Find this picture</span>${reverseLinks(pub)}</div>` : '<div class="hv-links"><span>No picture yet</span></div>'}
        <div class="hv-chart"><div class="hv-ch">Market cap · last hour<b></b></div><div class="hv-svg"><span class="hv-note">Loading chart…</span></div></div>
        <div class="hv-dev">${isMint(t.dev) ? `Creator ${solscan(t.dev)} <span class="hv-fund dim">· checking funding…</span>` : '<span class="dim">Creator wallet unknown.</span>'}</div>
      </div>`;
    pop.hidden = false; place();

    cached(charts, mint, () => jc.chart(mint, { interval: '1_MINUTE', candles: 60, type: 'mcap', quote: 'usd' }))
      .then((bars) => {
        if (cur !== mint) return;
        const box = pop.querySelector('.hv-svg'), head = pop.querySelector('.hv-ch b');
        const recent = bars.filter((b) => b.time * 1000 > Date.now() - 3600e3);
        if (!recent.length) { box.innerHTML = '<span class="hv-note">No trades in the last hour.</span>'; box.classList.add('few'); place(); return; }
        if (recent.length < 3) { head.textContent = money(recent[recent.length - 1].close); box.innerHTML = '<span class="hv-note">Not enough trades yet for a chart.</span>'; box.classList.add('few'); place(); return; } // one or two bars read as a glitch
        const first = recent[0].open || recent[0].close, last = recent[recent.length - 1].close, ch = first ? ((last - first) / first) * 100 : 0;
        head.innerHTML = `${money(last)} <i class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${ch.toFixed(1)}%</i>`;
        box.innerHTML = candles(recent);
      })
      .catch(() => { if (cur === mint) pop.querySelector('.hv-svg').innerHTML = `<span class="hv-note">Chart unavailable right now. MC ${esc(money(mcUsd(t)))}</span>`; });

    if (isMint(t.dev)) cached(holders, mint, () => jh.holders(mint))
      .then(({ holders: hs }) => {
        if (cur !== mint) return;
        const el = pop.querySelector('.hv-fund'), h = hs.find((x) => x.wallet === t.dev);
        if (!h) { el.textContent = '· not among the top 100 holders, so funding is unknown.'; return; }
        const share = t.circSupply > 0 ? (h.amount / t.circSupply) * 100 : null;
        el.innerHTML = `· holds ${share != null ? share.toFixed(share < 10 ? 2 : 1) + '%' : 'some'}${h.sol ? ` · ${h.sol.toFixed(2)} SOL in wallet` : ''}<br>`
          + (h.funding?.from && isMint(h.funding.from) ? `Funded by ${solscan(h.funding.from)}${h.funding.amount ? ` with ${esc(h.funding.amount.toFixed(3))} SOL` : ''}${h.funding.at ? `, ${agoTxt(h.funding.at)} ago` : ''}.` : 'Funding source not reported.');
        el.classList.remove('dim'); place();
      })
      .catch(() => { if (cur === mint) pop.querySelector('.hv-fund').textContent = '· funding lookup failed.'; });
  }

  const over = (e) => {
    const av = e.target.closest?.('[data-hv]'); if (!av || !root.contains(av)) return;
    clearTimeout(hideT); if (anchor === av && !pop.hidden) return;
    clearTimeout(openT); openT = setTimeout(() => open(av), 260);
  };
  const out = (e) => { const av = e.target.closest?.('[data-hv]'); if (!av || av.contains(e.relatedTarget)) return; clearTimeout(openT); later(); };
  const popIn = () => { clearTimeout(hideT); setHold(true); };
  root.addEventListener('pointerover', over); root.addEventListener('pointerout', out);
  pop.addEventListener('pointerenter', popIn); pop.addEventListener('pointerleave', later);
  root.addEventListener('scroll', hide, true);
  return () => {
    hide(); root.removeEventListener('pointerover', over); root.removeEventListener('pointerout', out);
    root.removeEventListener('scroll', hide, true); pop.remove();
  };
}
