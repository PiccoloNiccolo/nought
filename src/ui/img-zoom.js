// Hover a coin's picture to see it large (like Axiom): a 260 px copy appears beside it, first from the picture already
// on screen, then swapped for a sharper size when one loads. Pulse cards keep their own richer preview (ui/hover.js),
// so pictures inside a [data-hv] card are left alone. Mouse only; touch screens never see it.
import { tokens } from '../core/store.js';
import { imageSources } from '../core/jup.js';

const SIZE = 260, DELAY = 120;
let box = null, pic = null, target = null, timer = 0, want = '';

function ensure() {
  if (box) return;
  const st = document.createElement('style');
  st.textContent = `.imgzoom { position: fixed; z-index: 9000; width: ${SIZE}px; height: ${SIZE}px; padding: 6px; border-radius: 14px; border: 1px solid var(--line-2); background: var(--panel-2, var(--panel)); box-shadow: var(--shadow-lg, 0 18px 44px rgba(0,0,0,.6)); pointer-events: none; opacity: 0; transform: scale(.94); transition: opacity .12s ease, transform .12s ease; }
.imgzoom.on { opacity: 1; transform: none; }
.imgzoom img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 9px; background: var(--fill-1, rgba(255,255,255,.04)); }`;
  document.head.appendChild(st);
  box = document.createElement('div'); box.className = 'imgzoom'; box.setAttribute('aria-hidden', 'true');
  pic = document.createElement('img'); pic.alt = ''; pic.referrerPolicy = 'no-referrer'; pic.decoding = 'async';
  box.appendChild(pic); document.body.appendChild(box);
}
function place(el) {
  const r = el.getBoundingClientRect(), gap = 10, vw = innerWidth, vh = innerHeight, w = SIZE + 14;
  const left = r.right + gap + w <= vw ? r.right + gap : Math.max(8, r.left - gap - w);
  const top = Math.min(Math.max(8, r.top + r.height / 2 - w / 2), vh - w - 8);
  box.style.left = left + 'px'; box.style.top = top + 'px';
}
function show(el) {
  ensure();
  const now = el.currentSrc || el.src; if (!now) return;
  pic.src = now; place(el); box.classList.add('on');
  // a sharper copy of the same picture, when the coin's sources offer one
  const t = tokens.get(el.dataset.tokenImage || ''), better = t ? imageSources(t, 512)[0] : '';
  want = better || '';
  if (better && better !== now) { const im = new Image(); im.referrerPolicy = 'no-referrer'; im.onload = () => { if (want === better && target === el) pic.src = better; }; im.src = better; }
}
function hide() { clearTimeout(timer); target = null; want = ''; box?.classList.remove('on'); }

export function initImgZoom() {
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
  document.addEventListener('mouseover', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement) || !el.classList.contains('token-image') || el.closest('[data-hv]')) return;
    if (el === target) return;
    hide(); target = el;
    timer = setTimeout(() => { if (target === el && el.isConnected) show(el); }, DELAY);
  }, true);
  document.addEventListener('mouseout', (e) => { if (e.target === target && e.relatedTarget !== target) hide(); }, true);
  addEventListener('scroll', hide, true); addEventListener('hashchange', hide); addEventListener('blur', hide);
}
