// A strip that scrolls (page tabs, group pills): marks each edge that hides more with .fade-l / .fade-r (sideways) or
// .fade-t / .fade-b (down), so the page's CSS can fade that edge out and show there is more to scroll to. Follows
// scrolling, resizing and new children. edgeFade(el) → stop()
export function edgeFade(el) {
  if (!el) return () => {};
  const upd = () => {
    const mx = el.scrollWidth - el.clientWidth, my = el.scrollHeight - el.clientHeight;
    el.classList.toggle('fade-l', mx > 2 && el.scrollLeft > 2);
    el.classList.toggle('fade-r', mx > 2 && el.scrollLeft < mx - 2);
    el.classList.toggle('fade-t', my > 2 && el.scrollTop > 2);
    el.classList.toggle('fade-b', my > 2 && el.scrollTop < my - 2);
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(upd) : null;
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(upd) : null;
  ro?.observe(el); mo?.observe(el, { childList: true });
  el.addEventListener('scroll', upd, { passive: true });
  upd(); document.fonts?.ready.then(upd);
  return () => { ro?.disconnect(); mo?.disconnect(); el.removeEventListener('scroll', upd); };
}
