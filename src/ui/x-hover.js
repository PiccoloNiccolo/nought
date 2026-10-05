import { esc, ICON } from '../core/util.js';
import { tokens } from '../core/store.js';
import { parseXLink, xEmbedMessages } from './x-link.js';

// One shared social preview, with a small cache of live embeds for instant return.
// Public X embeds are isolated from wallet storage in sandboxed frames on X’s own origin.
export function initXHover(root = document) {
  const pop = document.createElement('aside'); pop.className = 'xh-pop'; pop.hidden = true; pop.id = 'x-hover-preview'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'X preview');
  document.body.appendChild(pop);
  const cache = new Map(); let anchor = null, current = null, openTimer = 0, closeTimer = 0, pinned = false;
  const resize = new ResizeObserver(() => place()); resize.observe(pop);
  function hold(value) { document.dispatchEvent(new CustomEvent('nought-social-hover', { detail: { held: value, col: anchor?.closest('[data-col]')?.dataset.col || '' } })); }
  function place() {
    if (pop.hidden || !anchor) return;
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = Math.min(pop.offsetHeight, innerHeight - 24);
    let left = r.right + 10; if (left + w > innerWidth - 10) left = r.left - w - 10;
    pop.style.left = Math.max(10, Math.min(innerWidth - w - 10, left)) + 'px';
    pop.style.top = Math.max(10, Math.min(innerHeight - h - 10, r.top - 20)) + 'px';
  }
  function hide() {
    clearTimeout(openTimer); clearTimeout(closeTimer); anchor?.removeAttribute('aria-describedby');
    pop.hidden = true; anchor = null; current = null; pinned = false; hold(false);
  }
  function later() { clearTimeout(closeTimer); if (!pinned) closeTimer = setTimeout(hide, 220); }
  function make(link, token) {
    const entry = document.createElement('section'); entry.className = 'xh-entry'; entry.dataset.key = link.url;
    entry.innerHTML = `<header>${link.kind === 'post' ? ICON.tweet : ICON.x}<b>${esc(link.kind === 'post' ? 'Tweet' : link.kind === 'profile' ? 'X profile' : 'X community')}</b><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">Open on X ↗</a><button type="button" class="xh-close" aria-label="Close X preview">×</button></header>`;
    if (link.kind === 'post') {
      const status = document.createElement('div'); status.className = 'xh-loading'; status.textContent = 'Loading post…'; entry.appendChild(status);
      const frame = document.createElement('iframe'); frame.title = 'Embedded X post'; frame.className = 'xh-frame'; frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
      const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      const embed = new URL('https://platform.twitter.com/embed/Tweet.html');
      embed.search = new URLSearchParams({ id: link.id, theme, dnt: 'true', hideThread: 'true', lang: 'en', width: '360', embedId: 'nought-' + link.id }).toString();
      frame.src = embed.href;
      frame.addEventListener('error', () => unavailable(entry));
      entry.appendChild(frame);
      // A blocked frame still leaves a useful outbound link.
      entry._timer = setTimeout(() => unavailable(entry), 11000);
    } else {
      const context = token?.symbol ? `Linked by ${token.symbol}` : 'Token social link';
      const followers = link.kind === 'profile' && token?.xHandle?.toLowerCase() === link.handle.toLowerCase() && Number(token.xFollowers) > 0 ? `<span>${Number(token.xFollowers).toLocaleString()} followers · token feed</span>` : '';
      const copy = link.kind === 'profile' ? 'This token links to a profile. Open it on X to see its posts.' : 'This token links to a community. Open it on X to read its posts.';
      entry.innerHTML += `<div class="xh-profile"><span class="xh-avatar">${ICON.x}</span><div><h3>${esc(link.label)}</h3><p>${esc(context)}</p>${followers}</div></div><p class="xh-note">${copy}</p>`;
    }
    return entry;
  }
  function unavailable(entry) {
    if (entry.dataset.ready) return;
    const status = entry.querySelector('.xh-loading'); if (status) { status.hidden = false; status.classList.add('xh-unavailable'); status.innerHTML = 'X could not load this post. It may be unavailable or blocked.<button type="button" class="xh-retry">Retry preview</button>'; }
    const frame = entry.querySelector('iframe'); if (frame) frame.style.height = '0px';
  }
  function open(target, pin = false) {
    const link = parseXLink(target.dataset.xPreview); if (!link) return;
    clearTimeout(closeTimer); anchor?.removeAttribute('aria-describedby'); anchor = target; pinned = pin; current = link.url;
    const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark', key = link.url + ':' + theme;
    let entry = cache.get(key);
    if (!entry) { entry = make(link, tokens.get(target.dataset.xMint)); cache.set(key, entry); pop.appendChild(entry); }
    for (const el of pop.children) el.hidden = el !== entry;
    while (cache.size > 6) { const oldest = [...cache.keys()].find(k => k !== key); const old = cache.get(oldest); clearTimeout(old._timer); old.remove(); cache.delete(oldest); }
    target.setAttribute('aria-describedby', pop.id); pop.hidden = false; hold(true); place();
  }
  function over(e) {
    if (e.pointerType === 'touch') return;
    const target = e.target.closest?.('[data-x-preview]'); if (!target || target.contains(e.relatedTarget)) return;
    clearTimeout(openTimer); clearTimeout(closeTimer);
    openTimer = setTimeout(() => open(target), 150);
  }
  function out(e) {
    const target = e.target.closest?.('[data-x-preview]'); if (!target || target.contains(e.relatedTarget) || pop.contains(e.relatedTarget)) return;
    clearTimeout(openTimer); later();
  }
  function focus(e) { const target = e.target.closest?.('[data-x-preview]'); if (target) { clearTimeout(openTimer); open(target); } }
  function blur(e) { if (!pop.contains(e.relatedTarget) && !e.relatedTarget?.closest?.('[data-x-preview]')) later(); }
  function click(e) {
    const target = e.target.closest?.('[data-x-preview]');
    if (target && matchMedia('(hover: none)').matches) { e.preventDefault(); e.stopPropagation(); open(target, true); return; }
    const retry = e.target.closest?.('.xh-retry');
    if (retry) {
      const entry = retry.closest('.xh-entry'), frame = entry.querySelector('iframe'), status = entry.querySelector('.xh-loading');
      delete entry.dataset.ready; status.classList.remove('xh-unavailable'); status.textContent = 'Loading post…'; frame.style.height = '300px'; frame.src = frame.src;
      clearTimeout(entry._timer); entry._timer = setTimeout(() => unavailable(entry), 11000); return;
    }
    if (e.target.closest?.('.xh-close')) { const previous = anchor; hide(); previous?.focus({ preventScroll: true }); hide(); return; }
    if (!pop.contains(e.target) && !target) hide();
  }
  function key(e) { if (e.key === 'Escape' && !pop.hidden) { hide(); e.preventDefault(); } }
  function message(e) {
    if (e.origin !== 'https://platform.twitter.com') return;
    for (const entry of cache.values()) {
      const frame = entry.querySelector('iframe'); if (!frame || e.source !== frame.contentWindow) continue;
      for (const message of xEmbedMessages(e.data)) {
        if (message.method === 'twttr.private.resize') {
          const size = Array.isArray(message.params) ? message.params[0] : message.params, height = Number(size?.height);
          if (Number.isFinite(height)) { entry.dataset.height = String(Math.max(150, Math.min(1800, height))); frame.style.height = entry.dataset.height + 'px'; }
        } else if (message.method === 'twttr.private.rendered') {
          entry.dataset.ready = 'true'; clearTimeout(entry._timer); entry.querySelector('.xh-loading').hidden = true; frame.style.height = (entry.dataset.height || '460') + 'px';
        } else if (message.method === 'twttr.private.no_results') {
          delete entry.dataset.ready; clearTimeout(entry._timer); unavailable(entry);
        }
        if (typeof message.id === 'number' || typeof message.id === 'string') e.source.postMessage({ 'twttr.embed': { jsonrpc: '2.0', id: message.id, result: null } }, e.origin);
      }
      place(); return;
    }
  }
  root.addEventListener('pointerover', over); root.addEventListener('pointerout', out);
  root.addEventListener('focusin', focus); root.addEventListener('focusout', blur); root.addEventListener('click', click); root.addEventListener('keydown', key);
  pop.addEventListener('pointerenter', () => clearTimeout(closeTimer)); pop.addEventListener('pointerleave', later);
  const scroll = e => {
    if (pop.contains(e.target)) return;
    // Keyboard focus may scroll its link into view after focusin has opened us.
    if (anchor && document.activeElement === anchor) place(); else hide();
  }; root.addEventListener('scroll', scroll, true);
  window.addEventListener('message', message); window.addEventListener('hashchange', hide); window.addEventListener('resize', hide);
  return () => { hide(); resize.disconnect(); for (const el of cache.values()) clearTimeout(el._timer); pop.remove(); root.removeEventListener('pointerover', over); root.removeEventListener('pointerout', out); root.removeEventListener('focusin', focus); root.removeEventListener('focusout', blur); root.removeEventListener('click', click); root.removeEventListener('keydown', key); root.removeEventListener('scroll', scroll, true); window.removeEventListener('message', message); window.removeEventListener('hashchange', hide); window.removeEventListener('resize', hide); };
}
