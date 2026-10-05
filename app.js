// Nought: an open-source, zero-fee memecoin terminal for Solana. No backend: everything runs in the browser.
// Boot order: shell, pages (each registers its route), router, live stream, SOL price → seed board, wallet, then the
// order engine (armed TP/SL and migration orders fire from an open tab; it is idempotent).
//   src/core   shared state and data: util, settings, store, price, meta, stream, seed, rpc, wallet, trade, orders, router
//   src/ui     the frame (shell), search, alerts, wallets, token cards
//   src/pages  one file per page, each with its own css/<page>.css
// Every module loads on its own and every step is guarded, so one broken page or one damaged stored value can't blank
// the whole app. If the router or the Settings page itself can't start, a bare rescue panel offers a backup and a reset
// of Nought's saved settings (local wallet keys live in IndexedDB and are never touched by it).
const PAGES = ['landing', 'pulse', 'token', 'discover', 'portfolio', 'track', 'watch', 'upkeep', 'perps', 'yield', 'settings'];
const failed = [];
const load = (path) => import(path).catch((e) => { failed.push(path); console.error(`Nought: ${path} did not load`, e); return null; });
const run = (name, fn) => { try { fn(); return true; } catch (e) { console.error(`Nought: ${name} did not start`, e); return false; } };

const [shell, router, price, seedM, stream, walletM, orders] = await Promise.all(
  ['./src/ui/shell.js', './src/core/router.js', './src/core/price.js', './src/core/seed.js', './src/core/stream.js', './src/core/wallet.js', './src/core/orders.js'].map(load));
const pages = await Promise.all(PAGES.map((p) => load(`./src/pages/${p}.js`)));

if (shell) run('the frame', () => shell.initShell());
const socialHover = await load('./src/ui/x-hover.js');
if (socialHover) run('social previews', () => socialHover.initXHover());
const routed = !!router && run('the router', () => router.start());
if (stream) run('the launch stream', () => stream.connect());
// Prices and the board are independent. A slow price provider must never hold up discovery.
if (price) price.refreshSol().catch((e) => console.error('Nought: SOL price unavailable', e));
if (seedM) seedM.seed().catch((e) => console.error('Nought: the board did not seed', e));
// start the order engine once the saved wallet is back (or definitely isn't), so its first look at open orders has an owner
Promise.resolve().then(() => walletM?.reconnect()).catch(() => {}).finally(() => { if (orders) run('the order engine', () => orders.startOrderEngine()); });

if (!routed) rescue();
else if (!pages[PAGES.indexOf('settings')]) { // the rest works: the rescue panel takes the Settings address only
  const atSettings = () => { if (/^#\/settings/.test(location.hash)) rescue(); };
  window.addEventListener('hashchange', atSettings); atSettings();
}

// Plain DOM only (no innerHTML, no other module): it has to work when everything else is broken.
function rescue() {
  const view = document.getElementById('view'); if (!view) return;
  const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt) n.textContent = txt; return n; };
  const keys = () => { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('nought.')) out.push(k); } } catch { /* storage off */ } return out; };
  const box = el('div', 'rescue'), acts = el('div', 'rescue-acts');
  box.append(el('h1', '', 'Nought could not start'), el('p', '', 'Part of the app did not load: a saved setting may be damaged, or a file did not download. Reload first. If this page comes back, save a backup and reset Nought\'s saved settings here. Local wallet keys are stored separately and are not affected.'));
  const again = el('button', 'btn btn-accent', 'Reload'), backup = el('button', 'btn', 'Download a backup (.json)'), reset = el('button', 'btn danger', 'Reset saved settings');
  for (const b of [again, backup, reset]) { b.type = 'button'; acts.append(b); }
  again.addEventListener('click', () => location.reload());
  backup.addEventListener('click', () => {
    const data = {}; for (const k of keys()) { try { data[k.slice(7)] = JSON.parse(localStorage.getItem(k)); } catch { /* skip an unreadable one */ } }
    const a = el('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'nought', version: 1, exported: new Date().toISOString(), data }, null, 2)], { type: 'application/json' }));
    a.download = 'nought-backup.json'; document.body.append(a); a.click(); a.remove();
  });
  reset.addEventListener('click', () => {
    if (!window.confirm('Remove every Nought setting, the watchlist, alerts, the trade journal and armed orders from this browser? Local wallet keys stay.')) return;
    for (const k of keys()) try { localStorage.removeItem(k); } catch { /* storage off */ }
    location.reload();
  });
  box.append(acts, el('p', 'rescue-note', `Not loaded: ${[...failed.map((f) => f.replace(/^\.\//, '')), routed ? '' : 'the router'].filter(Boolean).join(', ') || 'unknown'}.`));
  view.replaceChildren(box);
}
