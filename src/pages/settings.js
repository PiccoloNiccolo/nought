// Settings page: #/settings[/wallets|presets|display|hotkeys|alerts|network|data]. Everything is kept in this browser.
//   wallets   the active wallet, local vault status, links into the wallet manager (src/ui/wallets.js)
//   presets   P1–P3: buy amount, sell %, slippage, priority, MEV mode
//   display   theme (Nought Dark, Grey, OLED black, Light), accent colour, watchlist strip, live PnL widget, compact rows
//   hotkeys   rebind the shell's keys (two-key sequences like "g p" work too)
//   alerts    desktop notifications, sounds + master volume, price / market-cap alerts
//   network   RPC choice with a live test; the Jupiter key slot (not wired: core sends no key yet)
//   data      export / import settings as JSON (an allowlist, each value checked like its own control; trading values
//             that would change are listed old → new and need a tick), wipe local data (wallet keys only through a
//             second confirmation)
import { register } from '../core/router.js';
import { $, esc, on, toast, LS, short, isMint, usd, parseAmount, parseTarget, ICON } from '../core/util.js';
import { settings, set, setPreset, PRIO, RPCS } from '../core/settings.js';
import { LAUNCHPADS } from '../core/jup.js';
import { wallet, openWalletPicker, disconnectWallet, MAX_SELECTED } from '../core/wallet.js';
import * as V from '../core/vault.js';
import { solBalance } from '../core/rpc.js';
import { tokens } from '../core/store.js';
import * as shellX from '../ui/shell.js'; // newer helpers (accentFor, solAmt): a namespace lookup can't break module linking
import { HOTKEYS, hotkeys, setHotkey, resetHotkeys, comboOf, comboLabel, keyState, THEMES, ACCENTS, theme, setTheme, probeRpc, toggleTicker, tickerHidden, togglePnl, pnlShown, openConvert,
  SLIPPAGES, SELL_PCTS, MAX_BUY, PRESET_RULES, PRESET_DEFAULTS, checkPreset, okRpc, savedFees } from '../ui/shell.js';
import { SOUNDS, prefs, setPrefs, playSound, enableDesktop, desktopState, listAlerts, addAlert, removeAlert, rearmAlert, alertQuote, alertLabel, fmtAlertValue } from '../ui/alerts.js';

const TABS = [['wallets', 'Wallets'], ['presets', 'Presets'], ['display', 'Display'], ['hotkeys', 'Hotkeys'], ['alerts', 'Alerts'], ['network', 'Network'], ['data', 'Data']];
const wui = () => import('../ui/wallets.js');
const fail = (e) => toast(esc(e?.message || 'Something went wrong.'), 'err');
const labelOf = (m) => { const s = tokens.get(m)?.symbol; return s ? (s.startsWith('$') ? s : '$' + s) : short(m); };
// re-render while keeping keyboard focus on the same control (controls carry data-fk)
function keepFocus(fn) {
  const k = document.activeElement?.dataset?.fk;
  fn();
  if (k) document.querySelector(`[data-fk="${CSS.escape(k)}"]`)?.focus();
}
// the swatch colour an accent really shows with in a theme (Light darkens bright picks so they read on white)
const shownAccent = (c, name) => (typeof shellX.accentFor === 'function' ? shellX.accentFor(c, name) : c);
// SOL amounts: "0", "<0.0001", or up to 4 decimals (the shell's rule)
const solAmt = (n) => (typeof shellX.solAmt === 'function' ? shellX.solAmt(n) : typeof n === 'number' && isFinite(n) ? String(Number(n.toFixed(4))) : '—');
const segBtns = (opts, cur, attrs, label) => `<div class="seg sm" role="group" aria-label="${esc(label)}">${opts.map(([v, l]) => `<button type="button" ${attrs(v)} aria-pressed="${String(v) === String(cur)}">${l}</button>`).join('')}</div>`;

register({
  id: 'settings', tab: 'settings', match: /^#\/settings(?:\/([a-z]+))?$/,
  title: ([sub]) => `${TABS.find(([k]) => k === sub)?.[1] || 'Wallets'} · Settings · Nought`,
  mount(view, [sub]) {
    const tab = TABS.some(([k]) => k === sub) ? sub : 'wallets';
    view.innerHTML = `<div class="setp"><div class="setp-in">
      <nav class="setp-nav subtabs hfade" aria-label="Settings sections">${TABS.map(([k, l]) => `<a href="#/settings/${k}"${k === tab ? ' aria-current="page" class="on"' : ''}>${l}</a>`).join('')}</nav>
      <section class="setp-body" id="setp-body" aria-labelledby="setp-h"></section>
    </div></div>`;
    const ctx = { offs: [], timers: [], alive: true, body: $('#setp-body', view) };
    try { PANES[tab](ctx); } catch (e) { console.error(e); ctx.body.innerHTML = '<div class="empty">This section could not load.</div>'; }
    view.querySelector('.setp-nav .on')?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
    return () => {
      ctx.alive = false;
      ctx.offs.forEach((f) => f());
      ctx.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
      ctx.cleanup?.();
      keyState.capturing = false;
    };
  },
});

// the accent the current theme uses (for the colour picker's starting value)
const themeAccent = () => { const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : '#38d6f5'; };
const head = (title, lede) => `<h1 id="setp-h">${title}</h1>${lede ? `<p class="setp-lede">${lede}</p>` : ''}`;

const PANES = {
  // ---------------------------------------------------------------- wallets
  wallets(ctx) {
    let solBal = null;
    const draw = async () => {
      const ok = V.supported(), list = ok ? await V.list().catch(() => []) : [], has = ok ? await V.hasVault().catch(() => false) : false, st = V.state();
      if (!ctx.alive) return;
      const fs = savedFees(), local = wallet.kind === 'local';
      keepFocus(() => {
        ctx.body.innerHTML = head('Wallets', 'Connect a browser wallet, or keep local hot wallets in this browser for one-click trades. An extension wallet keeps its keys to itself and asks you to approve each trade.')
          + `<div class="setp-card">
            <h2>Active wallet</h2>
            ${wallet.owner ? `<div class="setp-wallet">
                <div class="setp-wid"><b>${esc(wallet.name || 'Wallet')}</b><span class="setp-tag ${local ? 'warn' : ''}">${local ? 'Local' : 'Extension'}</span></div>
                <div class="setp-addr mono">${esc(wallet.owner)} <button type="button" class="btn btn-ghost sm" data-copy="${esc(wallet.owner)}">Copy</button></div>
                <div class="setp-kv"><span>Balance</span><b class="mono">${typeof solBal !== 'number' || !isFinite(solBal) ? '…' : solAmt(solBal) + ' SOL'}</b></div>
              </div>
              <div class="setp-acts">
                <button type="button" class="btn" data-w="manage" data-fk="w-manage">Manage wallets</button>
                <button type="button" class="btn" data-w="deposit" data-fk="w-dep">Deposit</button>
                <button type="button" class="btn" data-w="withdraw" data-fk="w-wd">Withdraw</button>
                <button type="button" class="btn" data-w="convert" data-fk="w-cv">Convert SOL ⇄ USDC</button>
                <button type="button" class="btn btn-ghost danger" data-w="disconnect" data-fk="w-off">${local ? 'Stop using it' : 'Disconnect'}</button>
              </div>`
            : `<p class="setp-note">No wallet is connected.</p><div class="setp-acts"><button type="button" class="btn btn-accent" data-w="connect" data-fk="w-con">Connect a wallet</button><button type="button" class="btn" data-w="new" data-fk="w-new">Create a local wallet</button><button type="button" class="btn" data-w="import" data-fk="w-imp">Import a key</button></div>`}
          </div>
          <div class="setp-card">
            <h2>Local wallets in this browser</h2>
            ${!ok ? '<p class="setp-note">Local wallets need a secure page (https) with WebCrypto and IndexedDB. Open Nought over https to use them.</p>'
              : `<div class="setp-grid3">
                  <div class="setp-kv"><span>Stored</span><b class="mono">${list.length}</b></div>
                  <div class="setp-kv"><span>Vault</span><b>${!has ? 'Not set up' : st.unlocked ? '<span class="up">Unlocked</span>' : 'Locked'}</b></div>
                  <div class="setp-kv"><span>Auto-lock</span><b class="mono">${V.autoLockMin() < 60 ? V.autoLockMin() + ' min' : V.autoLockMin() / 60 + ' h'}</b></div>
                  <div class="setp-kv"><span>Picked for multi-wallet trades</span><b class="mono">${wallet.selected.length} / ${MAX_SELECTED}</b></div>
                </div>
                ${list.length ? `<ul class="setp-list">${list.slice(0, 8).map((w) => `<li><b>${esc(w.name)}</b><span class="mono dim">${esc(short(w.address, 6))}</span>${wallet.owner === w.address ? '<span class="setp-tag">Active</span>' : ''}</li>`).join('')}${list.length > 8 ? `<li class="dim">and ${list.length - 8} more</li>` : ''}</ul>` : ''}
                <div class="setp-acts"><button type="button" class="btn" data-w="manage" data-fk="w-manage2">Open the wallet manager</button></div>`}
            <p class="setp-note warn">A local wallet is a hot wallet: its key is encrypted with your passphrase and stored only in this browser. Clearing site data or forgetting the passphrase loses it unless you saved the secret key. Keep only trading money in it.</p>
          </div>
          <div class="setp-card">
            <h2>Fees saved</h2>
            ${fs.trades > 0 ? `<div class="setp-grid3"><div class="setp-kv"><span>Saved</span><b class="mono up">${solAmt(fs.sol)} SOL</b></div><div class="setp-kv"><span>In dollars</span><b class="mono">${usd(fs.usd, 2)}</b></div><div class="setp-kv"><span>Trades</span><b class="mono">${fs.trades}</b></div></div>` : '<p class="setp-line">No trades from this browser yet</p>'}
            <p class="setp-note">What a typical ${(fs.rate * 100).toFixed(0)}% terminal fee would have cost on the trades made in this browser. Nought's fee is 0%; Jupiter, pools and the network still charge their own fees, which every quote lists.</p>
          </div>`;
      });
    };
    const loadBal = async () => { if (!wallet.owner) { solBal = null; return; } const o = wallet.owner; try { const s = await solBalance(o); if (o === wallet.owner && ctx.alive) { solBal = s; draw(); } } catch { /* keep … */ } };
    ctx.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-w]'); if (!b) return;
      const a = b.dataset.w;
      if (a === 'connect') openWalletPicker();
      else if (a === 'manage') wui().then((w) => w.openWalletManager()).catch(fail);
      else if (a === 'new' || a === 'import') wui().then((w) => w.openWalletManager(a)).catch(fail);
      else if (a === 'deposit') wui().then((w) => w.openDeposit(wallet.owner)).catch(fail);
      else if (a === 'withdraw') wui().then((w) => w.openWithdraw(wallet.owner)).catch(fail);
      else if (a === 'convert') openConvert();
      else if (a === 'disconnect') disconnectWallet();
    });
    ctx.offs.push(on('wallet', () => { solBal = null; draw(); loadBal(); }), on('vault', draw), on('traded', loadBal));
    draw(); loadBal();
  },

  // ---------------------------------------------------------------- presets
  presets(ctx) {
    const SELL = SELL_PCTS, SLIP = SLIPPAGES, QUICK = [0.05, 0.1, 0.25, 0.5, 1];
    const card = (p, i) => {
      const act = i === settings.preset, a = (k) => (v) => `data-i="${i}" data-k="${k}" data-v="${v}" data-fk="p${i}-${k}-${v}"`;
      return `<div class="setp-card setp-preset${act ? ' on' : ''}" data-card="${i}">
        <div class="setp-phead"><label class="setp-pname"><span class="sr-only">Name of preset ${i + 1}</span><input data-i="${i}" data-in="name" data-fk="p${i}-name" maxlength="6" value="${esc(p.name)}" spellcheck="false" autocomplete="off"></label>
          <button type="button" class="btn sm ${act ? 'btn-accent' : ''}" data-i="${i}" data-k="active" data-v="1" data-fk="p${i}-active" aria-pressed="${act}">${act ? 'Active' : 'Use this one'}</button></div>
        <label class="setp-field"><span>Buy amount <em>SOL per quick buy</em></span><input data-i="${i}" data-in="buy" data-fk="p${i}-buy" inputmode="decimal" autocomplete="off" spellcheck="false" value="${esc(String(p.buy))}" aria-describedby="p${i}-buy-msg"><span class="setp-fmsg" id="p${i}-buy-msg" role="status"></span></label>
        <div class="seg-fill c5">${segBtns(QUICK.map((v) => [v, String(v)]), p.buy, a('buy'), 'Quick amounts')}</div>
        <div class="setp-field"><span>Sell <em>% of the holding</em></span><div class="seg-fill c5">${segBtns(SELL.map((v) => [v, v + '%']), p.sellPct, a('sellPct'), 'Sell share')}</div></div>
        <div class="setp-field"><span>Slippage <em>standard route only</em></span><div class="seg-fill c7">${segBtns(SLIP.map((v) => [v, v + '%']), p.slippage, a('slippage'), 'Slippage')}</div></div>
        <div class="setp-field"><span>Priority fee <em>at most, paid to validators</em></span><div class="seg-fill c3 two">${segBtns(Object.entries(PRIO).map(([k, x]) => [k, `${esc(x.label)} <small>≤${esc(String(x.max))}</small>`]), p.prio, a('prio'), 'Priority fee')}</div></div>
        <div class="setp-field"><span>MEV protection</span><div class="seg-fill c2">${segBtns([['off', 'Off'], ['protected', 'Protected']], p.mev || 'off', a('mev'), 'MEV protection')}</div></div>
        <p class="setp-mini">${p.mev === 'protected' ? 'Trades go through Jupiter Ultra: Jupiter charges its own fee (about 0.1%) and sets slippage and priority itself. Nought 0%.' : 'Your wallet signs and sends a Jupiter route. Nought 0%; pool and network fees apply.'}</p>
      </div>`;
    };
    const draw = () => keepFocus(() => {
      ctx.body.innerHTML = head('Trade presets', 'Three presets you can switch between with the P1 / P2 / P3 buttons or keys 1, 2 and 3. Quick buys and the trade panel use the active one.')
        + `<div class="setp-presets">${settings.presets.map(card).join('')}</div>
        <p class="setp-note">MEV protection routes trades through Jupiter Ultra, which lands them privately and charges its own fee (about 0.1% on most coins, less on stable pairs). Nought's fee is 0% either way; every quote lists Jupiter's, the pool's and the network's fees separately.</p>`;
    });
    // every write goes through the shell's PRESET_RULES, the same rules Settings > Data import and the boot check use
    ctx.body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-k]'); if (!b) return;
      const i = Number(b.dataset.i), k = b.dataset.k, raw = b.dataset.v; if (!(i >= 0 && i <= 2)) return;
      if (k === 'active') { set({ preset: i }); return; }
      const v = k === 'buy' || k === 'sellPct' || k === 'slippage' ? Number(raw) : k === 'mev' ? (raw === 'protected' ? 'protected' : 'off') : raw;
      if (PRESET_RULES[k]?.(v)) setPreset(i, { [k]: v });
    });
    ctx.body.addEventListener('input', (e) => {
      const t = e.target, i = Number(t.dataset.i); if (!t.dataset.in || !(i >= 0 && i <= 2)) return;
      if (t.dataset.in === 'buy') {
        const v = parseAmount(t.value), ok = PRESET_RULES.buy(v), m = t.parentElement.querySelector('.setp-fmsg');
        t.setAttribute('aria-invalid', String(!ok));
        if (m) m.textContent = ok || !t.value.trim() ? '' : `Enter an amount above 0 and at most ${MAX_BUY} SOL, like 0.25.`;
        if (ok) setPreset(i, { buy: v });
      }
      if (t.dataset.in === 'name') { const v = t.value.trim().slice(0, 6); if (PRESET_RULES.name(v)) setPreset(i, { name: v }); }
    });
    // typing re-renders only on blur so the caret isn't lost; buttons re-render at once
    ctx.offs.push(on('settings', () => { if (!document.activeElement?.dataset?.in) draw(); }));
    ctx.body.addEventListener('focusout', (e) => { if (e.target.dataset?.in) setTimeout(() => { if (ctx.alive && !document.activeElement?.dataset?.in) draw(); }, 0); });
    draw();
  },

  // ---------------------------------------------------------------- display
  display(ctx) {
    const keyOf = (id) => { const k = hotkeys()[id]; return k ? `key ${esc(comboLabel(k))}, or ` : ''; };
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const draw = () => keepFocus(() => {
      const t = theme(), acc = t.accent;
      ctx.body.innerHTML = head('Display', 'Themes only change colours, so every page follows them. Saved in this browser.')
        + `<div class="setp-card"><h2 id="th-h">Theme</h2>
          <div class="setp-themes" role="radiogroup" aria-labelledby="th-h">${THEMES.map((x) => `<label class="setp-theme${t.name === x.id ? ' on' : ''}"><input type="radio" name="theme" value="${x.id}" data-fk="th-${x.id}" ${t.name === x.id ? 'checked' : ''}><span class="sw" aria-hidden="true">${x.sw.map((c) => `<i style="background:${c}"></i>`).join('')}</span><b>${x.name}</b></label>`).join('')}</div></div>
        <div class="setp-card"><h2 id="ac-h">Accent colour</h2>
          <div class="setp-accents" role="radiogroup" aria-labelledby="ac-h">
            <label class="setp-acc${!acc ? ' on' : ''}" title="Theme default"><input type="radio" name="accent" value="" data-fk="ac-def" ${!acc ? 'checked' : ''}><i class="def" aria-hidden="true"></i><span class="sr-only">Theme default</span></label>
            ${ACCENTS.map((c) => { const sc = shownAccent(c, t.name); return `<label class="setp-acc${acc === c ? ' on' : ''}" title="${c}${sc !== c ? ` (shown as ${sc} on Light)` : ''}"><input type="radio" name="accent" value="${c}" data-fk="ac-${c}" ${acc === c ? 'checked' : ''}><i style="background:${sc}" aria-hidden="true"></i><span class="sr-only">${c}</span></label>`; }).join('')}
            <label class="setp-custom">Custom <input type="color" data-fk="ac-custom" data-accent-custom value="${acc || themeAccent()}"></label>
          </div>
          ${t.name === 'light' && acc && shownAccent(acc, 'light') !== acc ? `<p class="setp-mini">On Light, ${esc(acc)} is darkened to ${esc(shownAccent(acc, 'light'))} so links and tabs stay readable on white.</p>` : ''}
          <div class="setp-preview" aria-hidden="true"><span class="btn btn-accent sm">Buy</span><span class="setp-pv-seg seg sm"><button type="button" tabindex="-1" class="on">1h</button><button type="button" tabindex="-1">24h</button></span><span class="qb">${ICON.bolt}0.1</span><span class="up mono">+12.4%</span><span class="down mono">-3.1%</span><a class="dlg-link">A link</a></div></div>
        <div class="setp-card"><h2>Layout</h2>
          <label class="setp-check"><input type="checkbox" data-fk="d-ticker" data-d="ticker" ${tickerHidden() ? '' : 'checked'}><span>Show the watchlist strip under the top bar<span class="setp-mini">${cap(keyOf('ticker'))}the star in the top bar. It only takes space once you star a coin.</span></span></label>
          <label class="setp-check"><input type="checkbox" data-fk="d-pnl" data-d="pnl" ${pnlShown() ? 'checked' : ''}><span>Show the live PnL widget<span class="setp-mini">${cap(keyOf('pnl'))}the chart button in the top bar. A small box with the active wallet's change this session.</span></span></label>
          <label class="setp-check"><input type="checkbox" data-fk="d-compact" data-d="compact" ${settings.compact ? 'checked' : ''}><span>Compact rows on Pulse</span></label></div>`;
    });
    ctx.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'theme') setTheme({ name: t.value });
      else if (t.name === 'accent') setTheme({ accent: t.value });
      else if (t.hasAttribute('data-accent-custom')) setTheme({ accent: t.value });
      else if (t.dataset.d === 'ticker') toggleTicker(t.checked);
      else if (t.dataset.d === 'pnl') { togglePnl(t.checked); return; } // redrawn by 'pnlwidget'
      else if (t.dataset.d === 'compact') set({ compact: t.checked });
      else return;
      draw();
    });
    ctx.body.addEventListener('input', (e) => { if (e.target.hasAttribute('data-accent-custom')) setTheme({ accent: e.target.value }); }); // live preview while dragging
    // 'theme' also covers a change made in another tab; skip it while the colour picker is being dragged
    ctx.offs.push(on('ticker', draw), on('pnlwidget', draw), on('theme', () => { if (!document.activeElement?.hasAttribute?.('data-accent-custom')) draw(); }));
    draw();
  },

  // ---------------------------------------------------------------- hotkeys
  hotkeys(ctx) {
    let cap = null, msg = '';
    const BLOCKED = ['Tab', 'Shift+Tab', 'Enter', 'Space', 'Escape'];
    const draw = () => keepFocus(() => {
      const map = hotkeys();
      ctx.body.innerHTML = head('Hotkeys', 'Keys work anywhere except while you type in a field or a dialog is open. ⌘K or Ctrl+K always opens search. Two-key sequences (like G then P) are allowed: press the second key within a second.')
        + `<div class="setp-card"><div class="setp-scroll flush"><table class="setp-table"><thead><tr><th scope="col">Action</th><th scope="col">Keys</th><th scope="col"><span class="sr-only">Change</span></th></tr></thead><tbody>
          ${HOTKEYS.map((h) => `<tr><td>${esc(h.label)}</td><td>${map[h.id] ? `<span class="keys">${comboLabel(map[h.id]).split(' then ').map((k) => `<kbd>${esc(k)}</kbd>`).join('<span class="dim"> then </span>')}</span>` : '<span class="dim">Not set</span>'}${map[h.id] !== h.def ? ' <span class="setp-tag">changed</span>' : ''}</td>
            <td class="r"><button type="button" class="btn btn-ghost sm" data-hk="${h.id}" data-fk="hk-${h.id}" aria-label="Change keys for ${esc(h.label)}">Change</button>${map[h.id] !== h.def ? ` <button type="button" class="btn btn-ghost sm" data-hk-reset="${h.id}" data-fk="hkr-${h.id}" aria-label="Reset ${esc(h.label)} to ${esc(comboLabel(h.def))}">Reset</button>` : ''}</td></tr>`).join('')}
          </tbody></table></div>
          <p class="setp-msg" role="status" aria-live="polite">${esc(msg)}</p>
          <div class="setp-acts"><button type="button" class="btn btn-ghost" data-hk-all data-fk="hk-all">Reset all to defaults</button></div></div>
        <div class="setp-card"><h2>Page keys</h2><p class="setp-note">Pages add their own keys while they are open (for example on Pulse and the token page). Those are listed on each page and are not changed here.</p></div>`;
    });
    const stop = () => { if (!cap) return; clearTimeout(cap.timer); window.removeEventListener('keydown', onCap, true); keyState.capturing = false; cap = null; };
    const finish = (combo) => {
      const id = cap.id; stop();
      if (BLOCKED.includes(combo)) { msg = `${comboLabel(combo)} is kept for moving around the page. Pick another key.`; draw(); $(`[data-fk="hk-${id}"]`)?.focus(); return; }
      const cleared = setHotkey(id, combo), label = HOTKEYS.find((h) => h.id === id)?.label;
      msg = combo ? `${label}: ${comboLabel(combo)}.${cleared.length ? ` Removed it from ${cleared.map((c) => HOTKEYS.find((h) => h.id === c)?.label).join(', ')}.` : ''}` : `${label}: no key.`;
      draw(); $(`[data-fk="hk-${id}"]`)?.focus();
    };
    function onCap(e) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { const id = cap.id; stop(); msg = 'Cancelled.'; draw(); $(`[data-fk="hk-${id}"]`)?.focus(); return; }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !cap.first) { finish(''); return; }
      const c = comboOf(e); if (!c) return;
      if (!cap.first) { cap.first = c; cap.btn.textContent = comboLabel(c) + ' …'; cap.timer = setTimeout(() => finish(cap.first), 1000); }
      else { clearTimeout(cap.timer); finish(cap.first + ' ' + c); }
    }
    ctx.body.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.hk) {
        stop();
        cap = { id: b.dataset.hk, btn: b, first: '', timer: 0 }; keyState.capturing = true;
        b.textContent = 'Press keys…'; b.classList.remove('btn-ghost'); b.classList.add('btn-accent');
        msg = 'Press the new keys. Esc cancels, Backspace removes the key.'; $('.setp-msg', ctx.body).textContent = msg;
        window.addEventListener('keydown', onCap, true);
      } else if (b.dataset.hkReset) { stop(); const h = HOTKEYS.find((x) => x.id === b.dataset.hkReset); const cleared = setHotkey(h.id, h.def); msg = `${h.label}: back to ${comboLabel(h.def)}.${cleared.length ? ` Removed it from ${cleared.map((c) => HOTKEYS.find((x) => x.id === c)?.label).join(', ')}.` : ''}`; draw(); $(`[data-fk="hk-${h.id}"]`)?.focus(); }
      else if (b.hasAttribute('data-hk-all')) { stop(); resetHotkeys(); msg = 'All keys are back to their defaults.'; draw(); }
    });
    ctx.cleanup = stop;
    draw();
  },

  // ---------------------------------------------------------------- alerts
  alerts(ctx) {
    const form = { mint: '', kind: 'price', op: 'above', value: '', err: '' };
    const fmtV = fmtAlertValue;
    const draw = () => keepFocus(() => {
      const p = prefs(), ds = desktopState(), list = listAlerts();
      ctx.body.innerHTML = head('Alerts', 'Fills, order triggers, tracked wallets and your price alerts go to the bell in the top bar. Choose what else should get your attention.')
        + `<div class="setp-card"><h2>Desktop notifications</h2>
            <p class="setp-note">Shown only while Nought is in a background tab. ${ds === 'unsupported' ? (globalThis.isSecureContext ? 'This browser does not support them.' : 'They need Nought to be opened over https.') : ds === 'denied' ? 'This site is blocked in your browser settings; allow notifications there first.' : ''}</p>
            <div class="setp-acts">${ds === 'unsupported' || ds === 'denied' ? '' : p.desktop && ds === 'granted' ? '<span class="setp-tag up">On</span><button type="button" class="btn btn-ghost sm" data-a="desk-off" data-fk="a-desk">Turn off</button>' : '<button type="button" class="btn" data-a="desk-on" data-fk="a-desk">Allow desktop notifications</button>'}</div>
            <label class="setp-check"><input type="checkbox" data-a="pos" data-fk="a-pos" ${p.positionToasts ? 'checked' : ''}> After a fill, show the updated position with quick Sell buttons</label></div>
          <div class="setp-card"><h2>Sounds</h2>
            <label class="setp-range"><span>Master volume</span><input type="range" min="0" max="100" step="5" value="${Math.round(p.volume * 100)}" data-a="vol" data-fk="a-vol" aria-valuetext="${Math.round(p.volume * 100)}%"><b class="mono">${Math.round(p.volume * 100)}%</b></label>
            <div class="setp-sounds">${Object.entries(SOUNDS).map(([k, l]) => `<div class="setp-sound"><label class="setp-check"><input type="checkbox" data-snd="${k}" data-fk="snd-${k}" ${p.sounds[k] ? 'checked' : ''}> ${esc(l)}</label><button type="button" class="btn btn-ghost sm" data-test="${k}" data-fk="sndt-${k}" aria-label="Play the ${esc(l.toLowerCase())} sound">Test</button></div>`).join('')}</div>
            <p class="setp-note">Sounds start after your first click or key press on the page (browsers require it).</p></div>
          <div class="setp-card"><h2>Price and market-cap alerts</h2>
            <form class="setp-alert-form" data-a="form" novalidate>
              <label class="setp-field grow"><span>Token address</span><input name="mint" data-fk="af-mint" placeholder="Paste a token address" spellcheck="false" autocomplete="off" value="${esc(form.mint)}"></label>
              <div class="setp-field"><span>Watch</span>${segBtns([['price', 'Price'], ['mc', 'Market cap']], form.kind, (v) => `data-af="kind" data-v="${v}" data-fk="af-k-${v}"`, 'Watch')}</div>
              <div class="setp-field"><span>When it goes</span>${segBtns([['above', 'Above'], ['below', 'Below']], form.op, (v) => `data-af="op" data-v="${v}" data-fk="af-o-${v}"`, 'Condition')}</div>
              <label class="setp-field"><span>${form.kind === 'mc' ? 'Market cap (USD)' : 'Price (USD)'}</span><input name="value" data-fk="af-val" inputmode="${form.kind === 'mc' ? 'text' : 'decimal'}" autocomplete="off" spellcheck="false" placeholder="${form.kind === 'mc' ? '1.5m' : '0.0012'}" value="${esc(form.value)}"></label>
              <button type="submit" class="btn btn-accent" data-fk="af-add">Add alert</button>
            </form>
            ${form.err ? `<p class="setp-err" role="alert">${esc(form.err)}</p>` : ''}
            ${list.length ? `<div class="setp-scroll"><table class="setp-table"><thead><tr><th scope="col">Token</th><th scope="col">Alert when</th><th scope="col">Now</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>
              ${list.slice().reverse().map((a) => { const q = alertQuote(a.mint), now = a.kind === 'mc' ? q?.mc : q?.price; return `<tr><td><a href="#/t/${esc(a.mint)}">${esc(alertLabel(a))}</a></td><td class="mono">${a.kind === 'mc' ? 'MC' : 'Price'} ${a.op === 'above' ? '≥' : '≤'} ${fmtV(a.kind, Number(a.value))}</td><td class="mono">${fmtV(a.kind, now)}</td><td>${a.fired ? `<span class="setp-tag warn">Fired${a.firedAt ? ' ' + new Date(a.firedAt).toLocaleTimeString() : ''}</span>` : '<span class="setp-tag up">Watching</span>'}</td><td class="r">${a.id ? `${a.fired ? `<button type="button" class="btn btn-ghost sm" data-rearm="${esc(a.id)}" data-fk="ar-${esc(a.id)}">Re-arm</button>` : ''}<button type="button" class="btn btn-ghost sm danger" data-rm="${esc(a.id)}" data-fk="rm-${esc(a.id)}" aria-label="Remove this alert">Remove</button>` : ''}</td></tr>`; }).join('')}
            </tbody></table></div>` : '<p class="setp-note">No alerts yet. Add one above, or from a coin\'s page.</p>'}
            <p class="setp-note">Checked every 10 seconds on Jupiter prices while a Nought tab is open (background tabs: about once a minute). Market cap uses the coin's circulating supply.</p></div>`;
    });
    ctx.body.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.a === 'desk-on') { try { const r = await enableDesktop(); toast(r === 'granted' ? 'Desktop notifications are on.' : 'The browser did not allow notifications.', r === 'granted' ? 'ok' : 'err'); } catch (err) { fail(err); } draw(); }
      else if (b.dataset.a === 'desk-off') { setPrefs({ desktop: false }); draw(); }
      else if (b.dataset.test) { if (!playSound(b.dataset.test === 'fills' ? 'fills' : b.dataset.test, { force: true })) toast(prefs().volume > 0 ? 'This browser has no audio support.' : 'The master volume is at 0.'); }
      else if (b.dataset.af) { form[b.dataset.af] = b.dataset.v; syncForm(); draw(); }
      else if (b.dataset.rm) { removeAlert(b.dataset.rm); draw(); $('[data-fk="af-mint"]')?.focus(); }
      else if (b.dataset.rearm) { rearmAlert(b.dataset.rearm); draw(); }
    });
    const syncForm = () => { const f = $('[data-a="form"]', ctx.body); if (f) { form.mint = f.elements.mint.value.trim(); form.value = f.elements.value.value.trim(); } };
    ctx.body.addEventListener('submit', (e) => {
      e.preventDefault(); syncForm();
      try {
        const v = parseTarget(form.value);
        if (!isMint(form.mint)) throw new Error('Paste a token address.');
        if (!(v > 0) || !isFinite(v)) throw new Error(form.kind === 'mc' ? 'Enter a market cap in USD, like 250k, 1.5m or 1,250,000.' : 'Enter a price in USD, like 0.0012.');
        addAlert({ mint: form.mint, kind: form.kind, op: form.op, value: v });
        toast(`Alert added for ${esc(labelOf(form.mint))}.`, 'ok');
        Object.assign(form, { mint: '', value: '', err: '' });
      } catch (err) { form.err = err.message; }
      draw(); $(form.err ? '[data-fk="af-mint"]' : '[data-fk="af-add"]')?.focus();
    });
    ctx.body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.a === 'pos') setPrefs({ positionToasts: t.checked });
      else if (t.dataset.snd) setPrefs({ sounds: { [t.dataset.snd]: t.checked } });
      else if (t.dataset.a === 'vol') { setPrefs({ volume: Number(t.value) / 100 }); playSound('fills', { force: true }); }
    });
    ctx.body.addEventListener('input', (e) => { const t = e.target; if (t.dataset.a === 'vol') { t.nextElementSibling.textContent = t.value + '%'; t.setAttribute('aria-valuetext', t.value + '%'); } });
    const redraw = () => { if (!ctx.body.contains(document.activeElement) || !document.activeElement.matches('input:not([type="checkbox"]):not([type="range"])')) { syncForm(); draw(); } };
    ctx.offs.push(on('alerts-list', redraw));
    ctx.offs.push(on('alerts-quotes', redraw));
    draw();
  },

  // ---------------------------------------------------------------- network
  network(ctx) {
    const results = new Map(); // url → {ok, ms, error} | 'busy'
    const NAMES = { 'solana-rpc.publicnode.com': 'PublicNode', 'rpc.solanatracker.io': 'Solana Tracker', 'public.rpc.solanavibestation.com': 'Solana Vibe Station' };
    const host = (u) => { try { return new URL(u).host; } catch { return u; } };
    let custom = settings.rpc && !RPCS.includes(settings.rpc) ? settings.rpc : '', err = '';
    // green under 400 ms, amber under 1.2 s, red from there
    const res = (u) => { const r = results.get(u); return r === 'busy' ? '<span class="dim">Testing…</span>' : !r ? '' : r.ok ? `<span class="${r.ms < 400 ? 'up' : r.ms < 1200 ? 'warn' : 'down'}">${r.ms} ms</span>` : `<span class="down">${esc(r.error)}</span>`; };
    const row = (val, title, sub, fk) => `<label class="setp-rpc${settings.rpc === val ? ' on' : ''}"><input type="radio" name="rpc" value="${esc(val)}" data-fk="${fk}" ${settings.rpc === val ? 'checked' : ''}><span class="t"><b>${title}</b><span class="mono dim">${esc(sub)}</span></span><span class="res mono" aria-live="polite">${val ? res(val) : ''}</span>${val ? `<button type="button" class="btn btn-ghost sm" data-test="${esc(val)}" data-fk="${fk}-t">Test</button>` : ''}</label>`;
    const draw = () => keepFocus(() => {
      ctx.body.innerHTML = head('Network', 'Nought talks to public, keyless services straight from your browser. There is no Nought server in between.')
        + `<div class="setp-card"><h2 id="rpc-h">Solana RPC</h2>
          <p class="setp-note">The RPC reads balances and sends transactions signed by local wallets. Extension wallets send through their own RPC. If the chosen one fails, Nought falls back to the public ones.</p>
          <div class="setp-rpcs" role="radiogroup" aria-labelledby="rpc-h">
            ${row('', 'Automatic', 'PublicNode first, then Solana Tracker and Vibe Station', 'rpc-auto')}
            ${RPCS.map((u, i) => row(u, NAMES[host(u)] || host(u), u, 'rpc-' + i)).join('')}
            ${custom ? row(custom, 'Custom', custom, 'rpc-custom') : ''}
          </div>
          <form class="setp-inline" data-n="custom" novalidate><label class="setp-field grow"><span>Custom RPC URL <em>https only, e.g. your own provider key. Stored only in this browser.</em></span><input name="url" data-fk="rpc-url" placeholder="https://…" spellcheck="false" autocomplete="off" value="${esc(custom)}"></label><button type="submit" class="btn" data-fk="rpc-use">Test and use</button></form>
          ${err ? `<p class="setp-err" role="alert">${esc(err)}</p>` : ''}</div>
        <div class="setp-card"><h2>Jupiter API key</h2>
          <label class="setp-field"><span>Your own key <em>optional</em></span><input disabled placeholder="Coming later" aria-describedby="jk-note"></label>
          <p class="setp-note" id="jk-note">Not available yet: Nought's data layer doesn't send a Jupiter key today, so this slot is off. When it is wired, a key you enter will stay in this browser and go only to api.jup.ag, never to Nought.</p></div>
        <div class="setp-card"><h2>Data sources</h2>
          <ul class="setp-list plain"><li><b>Jupiter</b><span class="dim">tokens, prices, Pulse lists, trades, holders, charts, quotes and swaps</span></li><li><b>Dexscreener</b><span class="dim">pairs, search fallback, boosts</span></li><li><b>PumpPortal</b><span class="dim">live launch and migration stream</span></li><li><b>Hyperliquid</b><span class="dim">perps and BTC / ETH prices</span></li><li><b>GeckoTerminal</b><span class="dim">slow fallback for the Pulse board</span></li></ul></div>`;
    });
    const test = async (u) => { results.set(u, 'busy'); draw(); const r = await probeRpc(u); if (!ctx.alive) return r; results.set(u, r); draw(); return r; };
    ctx.body.addEventListener('change', (e) => { if (e.target.name === 'rpc') { set({ rpc: e.target.value }); err = ''; draw(); if (e.target.value) test(e.target.value); } });
    ctx.body.addEventListener('click', (e) => { const b = e.target.closest('[data-test]'); if (b) { e.preventDefault(); test(b.dataset.test); } });
    ctx.body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = String(e.target.elements.url.value || '').trim();
      let u; try { u = new URL(v); } catch { u = null; }
      if (!u || u.protocol !== 'https:' || /api\.mainnet(-beta)?\.solana\.com$/i.test(u.host)) { err = !u || u.protocol !== 'https:' ? 'Enter a full https:// address.' : 'Solana\'s own public RPC refuses browser requests. Pick another.'; draw(); $('[data-fk="rpc-url"]')?.focus(); return; }
      const r = await test(u.href);
      if (!ctx.alive) return;
      if (!r.ok) { err = `That RPC did not answer from this page: ${r.error}.`; draw(); return; }
      custom = u.href; err = ''; set({ rpc: u.href }); toast('Using your RPC.', 'ok'); draw();
    });
    draw();
    for (const u of RPCS) test(u);
  },

  // ---------------------------------------------------------------- data
  data(ctx) {
    let pendingImport = null, msg = '', armedCount = 0;
    const keys = () => { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('nought.')) out.push(k.slice(7)); } } catch { /* storage off */ } return out.sort(); };
    const exportable = () => keys().filter((k) => Object.hasOwn(IMPORT, k));
    const list = (l) => l.map((k) => `<span class="mono">${esc(k)}</span>`).join(', ');
    const draw = () => keepFocus(() => {
      const pi = pendingImport;
      ctx.body.innerHTML = head('Your data', 'Everything Nought keeps lives in this browser: settings, presets, hotkeys, theme, watchlist, alerts, the trade journal and orders armed here. Local wallet keys are stored separately, encrypted.')
        + `<div class="setp-card"><h2>Export</h2>
            <p class="setp-note">Downloads your settings (presets, hotkeys, theme, watchlist, alerts, tracked wallets, Pulse setup) as a JSON file you can import here or in another browser. Wallets, wallet keys, copy-trading rules, the trade journal, notifications and a custom RPC address (it can hold a provider key) are never in it.</p>
            <div class="setp-acts"><button type="button" class="btn" data-d="export" data-fk="d-export">Download settings (.json)</button></div></div>
          <div class="setp-card"><h2>Import</h2>
            <label class="setp-field"><span>Settings file <em>a .json exported from Nought</em></span><input type="file" accept="application/json,.json" data-d="file" data-fk="d-file"></label>
            <p class="setp-note">Only settings are read from a file, and each value is checked like the control that normally sets it. Before anything changes you see every trading value that would change.</p>
            ${pi ? `<div class="setp-preview-box">
              <p>This file sets ${pi.keys.length} item${pi.keys.length === 1 ? '' : 's'}: ${list(pi.keys)}. Existing values with the same names are replaced, then the page reloads.</p>
              ${pi.unsafe.length ? `<p class="setp-mini">Never imported, for safety: ${list(pi.unsafe)}.</p>` : ''}
              ${pi.other.length ? `<p class="setp-mini">Not settings, left out: ${list(pi.other)}.</p>` : ''}
              ${pi.dropped.length ? `<p class="setp-mini warn">Values outside what Nought allows were dropped (your current value stays): ${list(pi.dropped)}.</p>` : ''}
              ${pi.trading.length ? `<div class="setp-diff"><h3>Trading values that change</h3>
                <div class="setp-scroll"><table class="setp-table"><thead><tr><th scope="col">Value</th><th scope="col">Now</th><th scope="col">From the file</th></tr></thead><tbody>
                ${pi.trading.map(([l, a, b]) => `<tr><td>${esc(l)}</td><td class="mono dim">${esc(a)}</td><td class="mono setp-new">${esc(b)}</td></tr>`).join('')}</tbody></table></div>
                <label class="setp-check"><input type="checkbox" data-d="ack" data-fk="d-ack"${pi.ack ? ' checked' : ''}> I checked these trading values and want them</label></div>`
                : '<p class="setp-mini">No trading values change (presets, quick-buy amounts and the RPC stay as they are).</p>'}
              ${pi.rpc ? `<p class="setp-note warn">This file also sets your RPC to <span class="mono">${esc(pi.rpc)}</span>. Only apply it if you trust that address: it will read your balances and send transactions from local wallets.</p>` : ''}
              <div class="setp-acts"><button type="button" class="btn btn-accent" data-d="apply" data-fk="d-apply"${pi.trading.length && !pi.ack ? ' disabled' : ''}>Apply and reload</button><button type="button" class="btn btn-ghost" data-d="cancel" data-fk="d-cancel">Cancel</button></div></div>` : ''}
            ${msg ? `<p class="setp-err" role="alert">${esc(msg)}</p>` : ''}</div>
          <div class="setp-card danger"><h2>Wipe local data</h2>
            <p class="setp-note">Removes every Nought setting, the watchlist, alerts, notifications, recent searches, the trade journal${armedCount ? ` and <b>${armedCount} armed order${armedCount === 1 ? '' : 's'}</b>` : ' and armed orders'} from this browser. Your local wallets are kept unless you tick the box below.</p>
            <form class="setp-wipe" data-d="wipe" novalidate>
              <label class="setp-field"><span>Type WIPE to confirm</span><input name="word" data-fk="d-word" autocomplete="off" spellcheck="false"></label>
              <label class="setp-check"><input type="checkbox" name="vault" data-fk="d-vault"> Also erase my local wallets (asks again before deleting any key)</label>
              <div class="setp-acts"><button type="submit" class="btn danger" data-fk="d-wipe">Wipe this browser</button></div>
            </form></div>`;
    });
    ctx.body.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-d]'); if (!b) return;
      if (b.dataset.d === 'export') {
        const data = {};
        for (const k of exportable()) { const v = LS.get(k, undefined); if (v !== undefined) data[k] = v; }
        // a custom RPC URL often carries a provider key: it stays in this browser (the public ones are fine to share)
        if (isObj(data.settings) && data.settings.rpc && !RPCS.includes(data.settings.rpc)) data.settings = { ...data.settings, rpc: undefined };
        const blob = new Blob([JSON.stringify({ app: 'nought', version: 1, exported: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nought-settings-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast('Settings exported.', 'ok');
      } else if (b.dataset.d === 'apply' && pendingImport) {
        if (pendingImport.trading.length && !pendingImport.ack) return;
        for (const [k, v] of Object.entries(pendingImport.data)) LS.set(k, k === 'settings' ? { ...settings, ...v } : v);
        location.reload();
      } else if (b.dataset.d === 'cancel') { pendingImport = null; msg = ''; draw(); $('[data-fk="d-file"]')?.focus(); }
    });
    ctx.body.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.dataset.d === 'ack' && pendingImport) { pendingImport.ack = t.checked; const ap = $('[data-d="apply"]', ctx.body); if (ap) ap.disabled = !t.checked; return; }
      if (t.dataset.d !== 'file' || !t.files?.[0]) return;
      pendingImport = null; msg = '';
      const f = t.files[0];
      try {
        if (f.size > 2e6) throw new Error('That file is too big to be a Nought settings file.');
        let j; try { j = JSON.parse(await f.text()); } catch { throw new Error('That file is not valid JSON.'); }
        if (j?.app !== 'nought' || !j.data || typeof j.data !== 'object' || Array.isArray(j.data)) throw new Error('That is not a Nought settings file.');
        pendingImport = await readImport(j.data);
        if (!pendingImport.keys.length) { pendingImport = null; throw new Error('Nothing in that file can be imported.'); }
      } catch (err) { msg = err.message; }
      draw(); $(pendingImport ? (pendingImport.trading.length ? '[data-fk="d-ack"]' : '[data-fk="d-apply"]') : '[data-fk="d-file"]')?.focus();
    });
    ctx.body.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target; if (f.dataset.d !== 'wipe') return;
      if (String(f.elements.word.value).trim() !== 'WIPE') { toast('Type WIPE in capitals to confirm.', 'err'); f.elements.word.focus(); return; }
      const alsoVault = f.elements.vault.checked;
      for (const k of keys()) try { localStorage.removeItem('nought.' + k); } catch { /* storage off */ }
      if (!alsoVault) { location.reload(); return; }
      // the wallet manager's own erase screen asks for a second, typed confirmation before any key is deleted
      try {
        if (!V.supported() || !(await V.hasVault())) { location.reload(); return; }
        const w = await wui();
        w.openWalletManager('erase');
        const dlg = document.getElementById('wallet-mgr');
        if (!dlg) { location.reload(); return; }
        dlg.addEventListener('close', () => location.reload(), { once: true });
      } catch { location.reload(); }
    });
    try { const l = JSON.parse(localStorage.getItem('nought.armed') || '[]'); armedCount = Array.isArray(l) ? l.filter((a) => a?.status === 'armed').length : 0; } catch { armedCount = 0; }
    draw();
  },
};

// ---------------------------------------------------------------- Settings > Data import rules
// An import writes only the keys below, each through a check that mirrors the control that normally writes it: a check
// gets the file's value and returns the clean value to store, or undefined to leave the key alone, and pushes a short
// name for every value it had to drop. Wallets, copy trading, the trade journal, notifications, armed orders, PnL
// snapshots, recent searches and caches never come from a file (UNSAFE), and every other key is left out as well.
const UNSAFE = /^(tracked\.copy|notes$|trades$|pnlw\.|pf\.meta$|recent$|armed$|wallet|board$|sol$|vault|keys?$)/;
const COLS = ['new', 'stretch', 'migrated'];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const inRange = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
const text = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n) : '');
const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const BLOCKED_KEYS = ['Tab', 'Shift+Tab', 'Enter', 'Space', 'Escape'];
const MAX_TIME = 8.64e15;
// quick-amount chips (instant trade window, token page panel): four buys in SOL (≤ MAX_BUY) and four sells in % (≤ 100)
function chipsOf(v, why, key) {
  if (!isObj(v)) { why.push(key); return; }
  const side = (a, max) => (Array.isArray(a) && a.length === 4 && a.every((x) => inRange(x, 1e-9, max)) ? a.slice() : undefined);
  const buy = side(v.buy, MAX_BUY), sell = side(v.sell, 100), cur = LS.get(key, null);
  if (v.buy !== undefined && !buy) why.push(key + '.buy');
  if (v.sell !== undefined && !sell) why.push(key + '.sell');
  if (!buy && !sell) return;
  return { buy: buy || (isObj(cur) ? cur.buy : undefined), sell: sell || (isObj(cur) ? cur.sell : undefined) };
}
const IMPORT = {
  async settings(v, why) {
    if (!isObj(v)) { why.push('settings'); return; }
    const out = {};
    if (v.preset !== undefined) { if ([0, 1, 2].includes(v.preset)) out.preset = v.preset; else why.push('settings.preset'); }
    if (v.presets !== undefined) {
      if (!Array.isArray(v.presets) || v.presets.length !== 3) why.push('settings.presets');
      else out.presets = v.presets.map((p, i) => { const { value, bad } = checkPreset(p, settings.presets[i] || PRESET_DEFAULTS[i]); bad.forEach((k) => why.push(`P${i + 1} ${k}`)); return value; });
    }
    if (v.rpc !== undefined) { if (v.rpc === '') out.rpc = ''; else if (okRpc(v.rpc)) out.rpc = new URL(v.rpc).href; else why.push('settings.rpc'); }
    if (v.stretch !== undefined) { if (inRange(v.stretch, 1, 99)) out.stretch = v.stretch; else why.push('settings.stretch'); }
    for (const k of ['sounds', 'compact']) if (v[k] !== undefined) { if (typeof v[k] === 'boolean') out[k] = v[k]; else why.push('settings.' + k); }
    if (isObj(v.filters)) { try { const PF = await import('../ui/pulse-filters.js'); out.filters = Object.fromEntries(PF.COL_IDS.map((c) => [c, PF.clean(v.filters[c])])); } catch { why.push('settings.filters'); } }
    else if (v.filters !== undefined) why.push('settings.filters');
    return Object.keys(out).length ? out : undefined;
  },
  hotkeys(v, why) {
    if (!isObj(v)) { why.push('hotkeys'); return; }
    const out = {};
    for (const [id, c] of Object.entries(v)) {
      if (!HOTKEYS.some((h) => h.id === id)) continue; // an action this version doesn't have
      if (typeof c === 'string' && c.length <= 40 && !/[\u0000-\u001f]/.test(c) && !BLOCKED_KEYS.includes(c)) out[id] = c; else why.push('hotkeys.' + id);
    }
    return out;
  },
  theme(v, why) {
    if (!isObj(v)) { why.push('theme'); return; }
    return { name: THEMES.some((x) => x.id === v.name) ? v.name : 'dark', accent: /^#[0-9a-f]{6}$/i.test(v.accent || '') ? v.accent.toLowerCase() : '' };
  },
  'ticker.hidden': (v, why) => (typeof v === 'boolean' ? v : void why.push('ticker.hidden')),
  watch: (v, why) => (Array.isArray(v) ? [...new Set(v.filter(isMint))].slice(0, 500) : void why.push('watch')),
  alerts(v, why) {
    if (!Array.isArray(v)) { why.push('alerts'); return; }
    const out = [];
    for (const a of v.slice(0, 200)) {
      const value = Number(a?.value);
      if (!isObj(a) || !isMint(a.mint) || !['mc', 'price'].includes(a.kind) || !['above', 'below'].includes(a.op) || !(value > 0) || !isFinite(value)) { why.push('an alert'); continue; }
      const al = { id: typeof a.id === 'string' && /^[a-z0-9]{1,24}$/i.test(a.id) ? a.id : rid(), mint: a.mint, kind: a.kind, op: a.op, value, fired: a.fired === true, created: inRange(a.created, 1, MAX_TIME) ? a.created : Date.now() };
      if (inRange(a.firedAt, 1, MAX_TIME)) al.firedAt = a.firedAt;
      if (text(a.symbol, 24)) al.symbol = text(a.symbol, 24);
      out.push(al);
    }
    return out;
  },
  'alerts.prefs'(v, why) {
    if (!isObj(v)) { why.push('alerts.prefs'); return; }
    const s = isObj(v.sounds) ? v.sounds : {};
    // desktop notifications need this browser's permission, so that switch stays as it is here
    return { desktop: prefs().desktop, volume: inRange(v.volume, 0, 1) ? v.volume : prefs().volume, positionToasts: v.positionToasts !== false, sounds: Object.fromEntries(['fills', 'orders', 'tracker', 'alerts'].map((k) => [k, s[k] !== false])) };
  },
  'search.sort': (v, why) => (['rel', 'mc', 'vol', 'age'].includes(v) ? v : void why.push('search.sort')),
  // Pulse's per-column quick-buy amounts: the column header field allows above 0 and up to 100 SOL
  'pulse.qb'(v, why) {
    if (!isObj(v)) { why.push('pulse.qb'); return; }
    const out = {};
    for (const c of COLS) if (v[c] !== undefined) { const n = inRange(v[c], 1e-4, 100) ? Math.round(v[c] * 1e4) / 1e4 : NaN; if (n > 0) out[c] = n; else why.push('pulse.qb.' + c); }
    return out;
  },
  'pulse.lps': (v, why) => (Array.isArray(v) ? [...new Set(v.filter((x) => LAUNCHPADS.includes(x)))] : void why.push('pulse.lps')),
  'pulse.mute': (v, why) => (isObj(v) ? Object.fromEntries(COLS.filter((c) => typeof v[c] === 'boolean').map((c) => [c, v[c]])) : void why.push('pulse.mute')),
  // display switches: Pulse checks each against its own defaults when it reads them; only plain values get this far
  'pulse.display'(v, why) {
    if (!isObj(v)) { why.push('pulse.display'); return; }
    return Object.fromEntries(Object.entries(v).slice(0, 30).filter(([k, x]) => /^[a-zA-Z]{1,20}$/.test(k) && (typeof x === 'boolean' || inRange(x, 0, 1) || (typeof x === 'string' && /^[a-z]{1,2}$/.test(x)))));
  },
  async 'pulse.blacklist'(v, why) {
    if (!Array.isArray(v)) { why.push('pulse.blacklist'); return; }
    try {
      const BL = await import('../ui/blacklist.js');
      return v.slice(0, 20000).map((it) => ({ k: it?.k, v: Object.hasOwn(BL.KINDS, it?.k) ? BL.norm(it.k, it.v) : '', at: inRange(it?.at, 1, MAX_TIME) ? it.at : Date.now(), note: text(it?.note, 40) })).filter((it) => it.v);
    } catch { why.push('pulse.blacklist'); }
  },
  'instant.chips': (v, why) => chipsOf(v, why, 'instant.chips'),
  'tp.chips': (v, why) => chipsOf(v, why, 'tp.chips'),
  // tracked wallets only: copy-trading rules (tracked.copy*) are never imported, and a wallet that has a switched-on
  // rule left from earlier but isn't tracked now is left out, so an import can't quietly restart copying it
  tracked(v, why) {
    if (!Array.isArray(v)) { why.push('tracked'); return; }
    const seen = new Set(), out = [], rules = LS.get('tracked.copy', {}), cur = LS.get('tracked', []);
    const now = new Set(Array.isArray(cur) ? cur.map((w) => w?.address) : []);
    for (const w of v.slice(0, 1000)) {
      const a = text(w?.address, 44);
      if (!isMint(a) || seen.has(a)) continue;
      if (isObj(rules) && rules[a]?.on && !now.has(a)) { why.push(`tracked ${short(a)} (copy trading rule)`); continue; }
      seen.add(a);
      out.push({ address: a, name: text(w.name, 40), emoji: text(w.emoji, 8), group: text(w.group, 24), alert: w.alert === true, sound: w.sound === true, feed: w.feed !== false });
    }
    return out;
  },
  'audit.thresholds'(v, why) {
    if (!isObj(v)) { why.push('audit.thresholds'); return; }
    const out = {}, ok = (x) => x === '' || inRange(x, -1e12, 1e12);
    for (const [k, t] of Object.entries(v).slice(0, 30)) if (/^[a-zA-Z0-9]{1,24}$/.test(k) && isObj(t) && ok(t.amber ?? '') && ok(t.red ?? '')) out[k] = { amber: t.amber ?? '', red: t.red ?? '' };
    return out;
  },
  'track.filters'(v, why) {
    if (!isObj(v)) { why.push('track.filters'); return; }
    const out = { side: ['all', 'buy', 'sell'].includes(v.side) ? v.side : 'all' };
    for (const k of ['minSol', 'maxSol', 'minMc', 'maxMc']) out[k] = typeof v[k] === 'string' && /^[\d.,\s$kmb]{0,12}$/i.test(v[k]) ? v[k] : '';
    return out;
  },
};

// Reads a file's data object: {data (clean values to write), keys, unsafe, other, dropped, trading [[label, now, new]], rpc, ack}
async function readImport(raw) {
  const data = {}, unsafe = [], other = [], dropped = [];
  for (const [k, v] of Object.entries(raw)) {
    const name = String(k).slice(0, 40);
    if (UNSAFE.test(k)) { unsafe.push(name); continue; }
    if (!Object.hasOwn(IMPORT, k)) { other.push(name); continue; }
    const why = [], clean = await IMPORT[k](v, why);
    dropped.push(...why);
    if (clean !== undefined) data[k] = clean;
  }
  const rpc = data.settings?.rpc && data.settings.rpc !== settings.rpc ? data.settings.rpc : '';
  return { data, keys: Object.keys(data), unsafe, other, dropped: [...new Set(dropped)].slice(0, 40), trading: tradingChanges(data), rpc, ack: false };
}

// every value that decides what a trade spends or how it is routed, as [label, now, from the file] where they differ
function tradingChanges(data) {
  const rows = [], show = (v) => (v === undefined || v === null || v === '' ? '—' : Array.isArray(v) ? v.join(' / ') : String(v));
  const add = (label, a, b) => { if (show(a) !== show(b)) rows.push([label, show(a), show(b)]); };
  const s = data.settings;
  if (s?.preset !== undefined) add('Active preset', settings.presets[settings.preset]?.name, (s.presets || settings.presets)[s.preset]?.name);
  if (s?.presets) s.presets.forEach((p, i) => {
    const o = settings.presets[i] || {}, n = `Preset ${i + 1}`;
    add(`${n} name`, o.name, p.name); add(`${n} buy (SOL)`, o.buy, p.buy); add(`${n} sell (%)`, o.sellPct, p.sellPct);
    add(`${n} slippage (%)`, o.slippage, p.slippage); add(`${n} priority`, PRIO[o.prio]?.label || o.prio, PRIO[p.prio]?.label); add(`${n} MEV protection`, o.mev || 'off', p.mev);
  });
  if (s?.rpc !== undefined) add('RPC', settings.rpc || 'Automatic', s.rpc || 'Automatic');
  if (data['pulse.qb']) { const cur = LS.get('pulse.qb', {}), c0 = isObj(cur) ? cur : {}; for (const c of COLS) add(`Pulse ${c === 'new' ? 'New pairs' : c === 'stretch' ? 'Final stretch' : 'Migrated'} quick buy (SOL)`, c0[c] ?? 'preset', data['pulse.qb'][c] ?? 'preset'); }
  for (const [k, label] of [['instant.chips', 'Instant trade'], ['tp.chips', 'Token page']]) {
    const d = data[k]; if (!d) continue;
    const cur = LS.get(k, null), c0 = isObj(cur) ? cur : {};
    add(`${label} buy chips (SOL)`, c0.buy ?? 'default', d.buy ?? 'default'); add(`${label} sell chips (%)`, c0.sell ?? 'default', d.sell ?? 'default');
  }
  return rows;
}
