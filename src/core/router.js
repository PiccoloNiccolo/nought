// Hash router. Each page module registers { path, title, mount(view, params) -> cleanup? }.
// Routes (sub-tabs live in the path, e.g. #/discover/surge; pages read params from their match groups):
//   #/                landing        #/pulse            Pulse board       #/discover[/tab]   Discover
//   #/t/<mint>        token page     #/portfolio[/tab]  Portfolio         #/track[/tab]      Trackers + Vision
//   #/watch           Watchlist      #/upkeep           0% fees / upkeep  #/perps[/coin]     Perps
//   #/yield           Yield          #/settings[/tab]   Settings
import { $, $$, emit } from './util.js';

const routes = [];
let cleanup = null, current = null;
export function register(route) { routes.push(route); }
export const currentRoute = () => current;

export function parse(hash = location.hash || '#/') {
  for (const r of routes) {
    const m = r.match ? hash.match(r.match) : hash === r.path || (r.path === '#/' && (hash === '' || hash === '#'));
    if (m) return { route: r, params: Array.isArray(m) ? m.slice(1) : [] };
  }
  return { route: routes.find((r) => r.path === '#/pulse') || routes[0], params: [] };
}
export function go() {
  const { route, params } = parse();
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null; current = route;
  document.body.dataset.page = route.id;
  $$('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === route.tab));
  const view = $('#view'); view.innerHTML = ''; view.scrollTop = 0;
  document.title = (typeof route.title === 'function' ? route.title(params) : route.title) || 'Nought';
  try { cleanup = route.mount(view, params) || null; } catch (e) { console.error(e); view.innerHTML = '<div class="empty">Something went wrong loading this page.</div>'; }
  emit('route', route);
}
export function start() { window.addEventListener('hashchange', go); go(); }
