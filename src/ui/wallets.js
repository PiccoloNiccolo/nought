// The wallet manager dialog: browser-extension wallets, local hot wallets (create, import, unlock/lock, rename, export,
// remove), the active wallet, which local wallets join multi-wallet trades, Deposit (address, copy, QR, live balance) and
// Withdraw (SOL or any token, with an explicit review of amount + destination before anything is signed).
// Builds its own <dialog id="wallet-mgr"> and <style> on first open. Secrets are shown only on explicit request and
// leave the DOM on lock (manual or idle), when the dialog closes and when the page is hidden; a copied secret is
// cleared from the clipboard 60 s later (best effort: only while this tab has focus).
import { $, esc, safeUrl, short, toast, on, ICON, parseAmount } from '../core/util.js';
import * as V from '../core/vault.js';
import * as R from '../core/rpc.js';
import * as J from '../core/jup.js';
import { tokens } from '../core/store.js';
import { wallet, WALLETS, MAX_SELECTED, SYSTEM_PROGRAM, connectWallet, disconnectWallet, useLocal, selectWallet, signAndSend, transfer, transferToken, toPubkey, toRaw, ata, feeLamports } from '../core/wallet.js';

const QR_SRC = 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js'; // MIT, Kazuhiko Arase
const QR_SRI = 'sha384-e9EFD6BGC90bkW9aDV5xbbBfzwN7G8YImHao2lfLVKV/hPB0E0go+H3I64h7oHtA';
const HOT_WHY = 'If you forget the passphrase or clear this site\'s data, the funds are gone for good unless you saved the secret key.';
const HOT_WARNING = 'A local wallet is a hot wallet that lives only in this browser. ' + HOT_WHY;
// SOL amounts for display: exactly 0 → "0", dust → "<0.0001", else up to 4 decimals without trailing zeros
const solTxt = (n) => (n == null || !isFinite(n) ? '—' : n === 0 ? '0' : n < 0.0001 ? '<0.0001' : String(+n.toFixed(4)));

let dlg = null, view = 'home', arg = null, timer = 0, wd = null, clipTimer = 0;
const waiters = [];          // requestUnlock() promises
const bal = new Map();       // address → SOL, for the list

// ---- public ----
// view: 'home' | 'deposit' | 'withdraw' | 'new' | 'import' | 'unlock'
export function openWalletManager(v = 'home', a = null) {
  mount();
  if (['new', 'import'].includes(v)) gate(v, a); else go(v, a);
  if (!dlg.open) { dlg.showModal(); focusView(); } // not the close button: a view drawn before the dialog opened focuses here
}
export const openDeposit = (address = wallet.owner) => openWalletManager('deposit', address);
export const openWithdraw = (address = wallet.owner) => openWalletManager('withdraw', { from: address });
// resolves once the vault is unlocked; rejects if the person closes the dialog
export function requestUnlock(msg = 'Unlock your local wallets.') {
  if (V.isUnlocked()) return Promise.resolve();
  // if the dialog is already open (e.g. Withdraw → Send), come back to that view afterwards instead of closing
  const back = dlg?.open && view !== 'unlock' ? { view, arg } : dlg?.open ? arg?.back : null;
  return new Promise((res, rej) => { waiters.push({ res, rej }); openWalletManager('unlock', { msg, close: !back, back }); });
}

// ---- frame ----
function mount() {
  if (dlg) return;
  const st = document.createElement('style'); st.id = 'wallet-mgr-css'; st.textContent = CSS; document.head.appendChild(st);
  dlg = document.createElement('dialog'); dlg.id = 'wallet-mgr';
  dlg.innerHTML = `<div class="dlg wm"><div class="wm-head"><h2 id="wm-title">Wallets</h2><button type="button" class="btn btn-ghost icon" data-act="close" aria-label="Close">${ICON.close}</button></div><div id="wm-body" class="wm-body" tabindex="-1"></div></div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('click', onClick);
  dlg.addEventListener('submit', onSubmit);
  dlg.addEventListener('change', onChange);
  dlg.addEventListener('close', () => { if (dlg.open) return; /* reopened before this queued event ran */ clearInterval(timer); wipeSecrets(); $('#wm-body', dlg).innerHTML = ''; wd = null; arg = null; waiters.splice(0).forEach((w) => w.rej(new Error('Unlock cancelled.'))); });
  on('vault', (s) => { if (s?.unlocked === false && wipeSecrets()) return; if (dlg.open && view === 'home') draw(); });
  on('wallet', () => { if (dlg.open && view === 'home') draw(); });
  window.addEventListener('pagehide', wipeSecrets);
}
// Take every secret key out of the DOM; a dialog showing one (or the export form) goes back home. → true if it did.
function wipeSecrets() {
  if (!dlg) return false;
  const shown = dlg.querySelectorAll('.wm-secret');
  shown.forEach((el) => { el.textContent = ''; el.remove(); });
  if (!dlg.open || (view !== 'created' && view !== 'export')) return false;
  if (view === 'created' && shown.length) toast('The new wallet\'s secret key is hidden now. If you did not save it yet, unlock and use Export key to see it again.');
  go('home');
  return true;
}
function go(v, a = null) { view = v; arg = a; clearInterval(timer); draw(); }
// each view focuses its own [autofocus] field, else the view itself, so the close button never opens with a focus ring
const focusView = () => { const b = $('#wm-body', dlg); (b.querySelector('[autofocus]') || b).focus({ preventScroll: true }); };
const body = (html) => { $('#wm-body', dlg).innerHTML = html; dlg.querySelectorAll('.wm-sel select').forEach(syncSel); focusView(); };
const title = (t) => { $('#wm-title', dlg).textContent = t; };
async function draw() {
  try { await (VIEWS[view] || VIEWS.home)(); } catch (e) { body(`<p class="wm-err">${esc(e.message || 'Something went wrong.')}</p><div class="row-end"><button type="button" class="btn" data-act="back">Back</button></div>`); }
}
// create/import need a passphrase set and the vault unlocked first
async function gate(next, a) {
  if (!V.supported()) { go('home'); return; }
  if (!(await V.hasVault())) go('setup', { then: next, a });
  else if (!V.isUnlocked()) go('unlock', { then: next, a });
  else go(next, a);
}
const after = (a) => go(a?.then || 'home', a?.a ?? null);
const err = '<p class="wm-err" role="alert"></p>';
const backBtn = '<button type="button" class="btn btn-ghost" data-act="back">Back</button>';
const fmtUnits = (raw, dec, group) => {
  const s = BigInt(raw).toString().padStart(dec + 1, '0'), i = s.slice(0, s.length - dec), f = s.slice(s.length - dec).replace(/0+$/, '');
  return (group ? i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : i) + (f ? '.' + f : '');
};
// <select> whose closed state shows the option's name in sans and its address or amount in mono: the select's own text
// is transparent and a label laid over it copies the chosen option's data-n / data-m (textContent, so nothing is parsed)
const opt = (value, name, mono = '', on = false) => `<option value="${esc(value)}" data-n="${esc(name)}" data-m="${esc(mono)}"${on ? ' selected' : ''}>${esc(name)}${mono ? ' · ' + esc(mono) : ''}</option>`;
const sel = (attrs, opts) => `<span class="wm-sel"><select ${attrs}>${opts}</select><span class="wm-sel-v" aria-hidden="true"><span></span><span class="mono"></span></span></span>`;
function syncSel(s) {
  const o = s.selectedOptions[0], v = s.parentElement?.querySelector('.wm-sel-v');
  if (!v) return;
  v.children[0].textContent = o?.dataset.n ?? o?.textContent ?? ''; v.children[1].textContent = o?.dataset.m || ''; v.classList.toggle('ph', !s.value);
}
const accountInfo = async (addr) => (await R.rpc('getAccountInfo', [addr, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }])).value;
const rentExempt = (bytes) => R.rpc('getMinimumBalanceForRentExemption', [bytes]);
async function ownAddresses() {
  const l = (await V.list()).map((w) => ({ address: w.address, name: w.name, kind: 'local' }));
  if (wallet.kind === 'external' && wallet.owner) l.unshift({ address: wallet.owner, name: wallet.name || 'Extension wallet', kind: 'external' });
  return l;
}
async function loadBalances(addrs) {
  for (let i = 0; i < addrs.length; i += 100) {
    const chunk = addrs.slice(i, i + 100);
    const r = await R.rpc('getMultipleAccounts', [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
    r.value.forEach((v, j) => bal.set(chunk[j], (v?.lamports || 0) / 1e9));
  }
  dlg.querySelectorAll('[data-bal]').forEach((el) => { if (bal.has(el.dataset.bal)) el.textContent = solTxt(bal.get(el.dataset.bal)) + ' SOL'; });
}

// ---- views ----
const VIEWS = {
  async home() {
    title('Wallets');
    const ok = V.supported(), has = ok && (await V.hasVault()), list = ok ? await V.list() : [], unlocked = V.isUnlocked();
    // a connected or detected extension gets a row; the ones not installed share one line of install links
    const isAct = (w) => wallet.kind === 'external' && wallet.id === w.id, shown = WALLETS.filter((w) => isAct(w) || w.get()), missing = WALLETS.filter((w) => !shown.includes(w));
    const ext = shown.map((w) => {
      const act = isAct(w);
      return `<div class="wm-row ${act ? 'on' : ''}"><div class="wm-id"><b>${esc(w.name)}${act ? ' <span class="wm-tag">Active</span>' : ''}</b><span class="wm-addr">${act ? `<span class="mono">${esc(short(wallet.owner, 6))}</span><button type="button" class="wm-ic" data-copy="${esc(wallet.owner)}" aria-label="Copy address">${ICON.copy}</button>` : 'Detected in this browser'}</span></div>
        <div class="wm-side">${act ? `<span class="wm-bal mono" data-bal="${esc(wallet.owner)}">— SOL</span><button type="button" class="btn btn-ghost sm" data-act="ext-off">Disconnect</button>` : `<button type="button" class="btn sm" data-act="ext" data-id="${esc(w.id)}">Connect</button>`}</div></div>`;
    }).join('') + (missing.length ? `<div class="wm-noext"><span>Not installed:</span>${missing.map((w) => `<a class="wm-get" href="${esc(safeUrl(w.site))}" target="_blank" rel="noopener noreferrer" title="Get ${esc(w.name)}">${esc(w.name)}<span aria-hidden="true">↗</span></a>`).join('<i aria-hidden="true">·</i>')}</div>` : '');
    const row = (w) => {
      const act = wallet.kind === 'local' && wallet.owner === w.address, picked = wallet.selected.includes(w.address), a = esc(w.address);
      return `<div class="wm-row ${act ? 'on' : ''}">
        <div class="wm-id"><b>${esc(w.name)}${act ? ' <span class="wm-tag">Active</span>' : ''}</b><span class="wm-addr"><span class="mono">${esc(short(w.address, 6))}</span><button type="button" class="wm-ic" data-copy="${a}" aria-label="Copy address">${ICON.copy}</button></span></div>
        <div class="wm-side"><span class="wm-bal mono" data-bal="${a}">${bal.has(w.address) ? solTxt(bal.get(w.address)) : '—'} SOL</span>${act ? '' : `<button type="button" class="btn sm" data-act="use" data-id="${a}">Use</button>`}</div>
        <div class="wm-acts"><label class="check wm-pick" title="Include in multi-wallet trades"><input type="checkbox" data-pick="${a}" ${picked ? 'checked' : ''}> Multi-wallet</label><span class="wm-grow"></span>
          <button type="button" class="btn btn-ghost sm" data-act="deposit" data-id="${a}">Deposit</button><button type="button" class="btn btn-ghost sm" data-act="withdraw" data-id="${a}">Withdraw</button><button type="button" class="btn btn-ghost sm" data-act="rename" data-id="${a}">Rename</button><button type="button" class="btn btn-ghost sm" data-act="export" data-id="${a}">Export key</button><button type="button" class="btn btn-ghost sm danger" data-act="remove" data-id="${a}">Remove</button></div></div>`;
    };
    // once a wallet exists the warning shrinks to one line; the reason stays one click away
    const warn = list.length
      ? `<details class="wm-warn wm-why"><summary><span>Hot wallets: keys live only in this browser.</span><span class="wm-why-l">Why?</span></summary><p>${esc(HOT_WHY)} Back up each one with Export key.</p></details>`
      : `<div class="wm-warn">${esc(HOT_WARNING)}</div>`;
    const local = !ok
      ? '<div class="wm-warn bad">Local wallets need this page to load over https with storage allowed. Extension wallets still work.</div>'
      : !has
        ? `<p class="hint">Make a wallet that lives in this browser. Trades sign instantly, with no pop-up for each one.</p>${warn}`
        : `<div class="wm-lock"><span class="wm-dot ${unlocked ? 'on' : ''}"></span><span>${unlocked ? 'Unlocked' : 'Locked'}</span><span class="wm-auto"><span class="hint">Auto-lock after</span><select data-autolock aria-label="Auto-lock after">${V.AUTOLOCK.map((m) => `<option value="${m}" ${m === V.autoLockMin() ? 'selected' : ''}>${m < 60 ? m + ' min' : m / 60 + ' h'}</option>`).join('')}</select><span class="hint">idle</span></span><span class="wm-grow"></span>${unlocked ? '<button type="button" class="btn btn-ghost sm" data-act="lock">Lock now</button>' : '<button type="button" class="btn btn-accent sm" data-act="unlock">Unlock</button>'}</div>
          ${list.length ? list.map(row).join('') : '<p class="hint">No local wallets yet.</p>'}
          ${list.length ? `<p class="hint">Tick Multi-wallet on up to ${MAX_SELECTED} local wallets to split trades across them. ${wallet.selected.length} picked.</p>` : ''}
          ${warn}`;
    const extSec = `<section class="wm-sec"><h3>Browser extensions</h3>${ext}<p class="hint">Extensions sign every trade in their own pop-up. Nought never sees their keys.</p></section>`;
    const localSec = `<section class="wm-sec"><h3>Local wallets</h3>${local}
      ${ok ? '<div class="row-end"><button type="button" class="btn btn-ghost" data-act="import">Import</button><button type="button" class="btn btn-accent" data-act="new">New wallet</button></div>' : ''}</section>`;
    body(list.length ? localSec + extSec : extSec + localSec); // your own wallets first once you have some
    const addrs = list.map((w) => w.address).concat(wallet.kind === 'external' && wallet.owner ? [wallet.owner] : []);
    if (addrs.length) loadBalances(addrs).catch(() => {});
  },
  setup() {
    title('Choose a passphrase');
    body(`<form data-form="setup" class="wm-form">
      <p class="hint">This passphrase encrypts every local wallet in this browser. Nought has no server and no reset link: nobody can recover it for you.</p>
      <label>Passphrase<input type="password" name="pass" minlength="8" autocomplete="new-password" required autofocus></label>
      <label>Type it again<input type="password" name="pass2" minlength="8" autocomplete="new-password" required></label>
      <div class="wm-warn">${esc(HOT_WARNING)}</div>
      <label class="check"><input type="checkbox" name="ack" required> I understand that Nought cannot recover my passphrase or my funds.</label>
      ${err}<div class="row-end">${backBtn}<button class="btn btn-accent" type="submit">Continue</button></div></form>`);
  },
  unlock() {
    title('Unlock local wallets');
    body(`<form data-form="unlock" class="wm-form">
      <p class="hint">${esc(arg?.msg || 'Enter your passphrase. Keys stay decrypted in this tab only, until you lock, go idle or close it.')}</p>
      <label>Passphrase<input type="password" name="pass" autocomplete="current-password" required autofocus></label>
      ${err}<div class="row-end"><button type="button" class="btn btn-ghost wm-left" data-act="erase">Forgot it?</button>${backBtn}<button class="btn btn-accent" type="submit">Unlock</button></div></form>`);
  },
  new() {
    title('New local wallet');
    body(`<form data-form="new" class="wm-form">
      <label>Name <span class="hint">only you see it</span><input name="name" maxlength="32" placeholder="Sniper 1" autocomplete="off" autofocus></label>
      <p class="hint">Nought makes a new keypair in this browser and stores it encrypted under your passphrase. You will see the secret key once, right after this.</p>
      ${err}<div class="row-end">${backBtn}<button class="btn btn-accent" type="submit">Create wallet</button></div></form>`);
  },
  created() {
    title('Save your secret key');
    const w = arg || {};
    body(`<div class="wm-form">
      <div class="wm-warn bad"><b>Shown once.</b> Write this key down or store it in a password manager, offline if you can. Anyone who sees it can take everything in this wallet. Without it, clearing this browser's data or forgetting the passphrase loses the funds.</div>
      <label>Address<span class="wm-addrbox mono">${esc(w.address)}</span></label>
      <label>Secret key<div class="wm-secret blur" id="wm-secret">${esc(w.secret)}</div></label>
      <div class="row-end"><button type="button" class="btn btn-ghost" data-act="reveal">Show</button><button type="button" class="btn" data-act="copy-secret">${ICON.copy} Copy secret key</button></div>
      <label class="check"><input type="checkbox" data-ack-saved> I saved the secret key somewhere safe.</label>
      <div class="row-end"><button type="button" class="btn btn-accent" data-act="done-created" disabled>Done</button></div></div>`);
    arg = { address: w.address }; w.secret = ''; // the secret now lives only in the DOM, which wipeSecrets() clears
  },
  import() {
    title('Import a wallet');
    body(`<form data-form="import" class="wm-form" autocomplete="off">
      <label>Name<input name="name" maxlength="32" placeholder="Imported" autocomplete="off"></label>
      <label>Secret key <span class="hint">base58 (as Phantom or Solflare export it) or a JSON byte array like a Solana CLI id.json. Seed phrases are not supported yet.</span>
        <textarea name="secret" rows="3" spellcheck="false" autocapitalize="off" autocomplete="off" required autofocus></textarea></label>
      <div class="wm-warn">Only import a key you are happy to keep hot in this browser. It is encrypted with your passphrase and never leaves this device.</div>
      ${err}<div class="row-end">${backBtn}<button class="btn btn-accent" type="submit">Import</button></div></form>`);
  },
  async export() {
    title('Export secret key');
    const w = (await V.list()).find((x) => x.address === arg);
    if (!w) return go('home');
    body(`<form data-form="export" class="wm-form" id="wm-export">
      <p><b>${esc(w.name)}</b> <span class="mono hint">${esc(w.address)}</span></p>
      <div class="wm-warn bad">Anyone with this key controls the wallet. Nought will never ask you for it. Never paste it into a website, a chat or a support form.</div>
      <label>Passphrase <span class="hint">enter it again to reveal the key</span><input type="password" name="pass" autocomplete="current-password" required autofocus></label>
      <label class="check"><input type="checkbox" name="ack" required> I am alone and nobody can see my screen.</label>
      ${err}<div class="row-end">${backBtn}<button class="btn btn-accent" type="submit">Reveal secret key</button></div></form>`);
  },
  async rename() {
    title('Rename wallet');
    const w = (await V.list()).find((x) => x.address === arg);
    if (!w) return go('home');
    body(`<form data-form="rename" class="wm-form"><p class="mono hint">${esc(w.address)}</p>
      <label>Name<input name="name" maxlength="32" value="${esc(w.name)}" required autofocus></label>
      ${err}<div class="row-end">${backBtn}<button class="btn btn-accent" type="submit">Save</button></div></form>`);
  },
  async remove() {
    title('Remove wallet');
    const w = (await V.list()).find((x) => x.address === arg);
    if (!w) return go('home');
    body(`<form data-form="remove" class="wm-form">
      <p><b>${esc(w.name)}</b> <span class="mono hint">${esc(w.address)}</span></p>
      <p>Balance <b class="mono" data-bal="${esc(w.address)}">… SOL</b> <span class="hint">plus any tokens</span></p>
      <div class="wm-warn bad">This deletes the encrypted key from this browser. If the wallet still holds anything and you have no copy of the secret key, it is gone for good.</div>
      <label class="check"><input type="checkbox" name="ack" required> I saved the secret key, or this wallet is empty.</label>
      ${err}<div class="row-end">${backBtn}<button class="btn danger" type="submit">Remove for good</button></div></form>`);
    loadBalances([w.address]).catch(() => {});
  },
  async erase() {
    title('Erase local wallets');
    const n = (await V.list()).length;
    body(`<form data-form="erase" class="wm-form">
      <div class="wm-warn bad">A forgotten passphrase cannot be reset. The only way forward is to erase all ${n} local wallet${n === 1 ? '' : 's'} in this browser and start over. Funds in them are lost unless you saved their secret keys.</div>
      <label>Type ERASE to confirm<input name="word" autocomplete="off" spellcheck="false" required autofocus></label>
      ${err}<div class="row-end">${backBtn}<button class="btn danger" type="submit">Erase everything</button></div></form>`);
  },
  async deposit() {
    title('Deposit');
    const own = await ownAddresses(), a = own.some((o) => o.address === arg) ? arg : wallet.owner || own[0]?.address;
    if (!a) return body(`<p class="hint">Connect an extension or create a local wallet first.</p><div class="row-end">${backBtn}</div>`);
    body(`<div class="wm-form wm-dep">
      ${own.length > 1 ? `<label>Wallet${sel('data-dep', own.map((o) => opt(o.address, o.name, short(o.address), o.address === a)).join(''))}</label>` : ''}
      <div class="wm-qr" id="wm-qr" aria-label="QR code of the address"><span class="hint">Loading QR…</span></div>
      <span class="wm-addrbox mono">${esc(a)}</span>
      <div class="wm-center"><button type="button" class="btn btn-accent" data-copy="${esc(a)}" autofocus>${ICON.copy} Copy address</button></div>
      <p class="wm-center">Balance <b class="mono" id="wm-dep-bal">…</b> SOL <span class="hint">· refreshes every 5 s</span></p>
      <p class="hint">Send SOL or Solana tokens on the Solana network only. Coins sent from another network to this address are lost.</p>
      <div class="row-end">${backBtn}</div></div>`);
    qr(a).then((svg) => { const el = $('#wm-qr', dlg); if (el) el.innerHTML = svg; }).catch(() => { const el = $('#wm-qr', dlg); if (el) el.innerHTML = '<span class="hint">QR code unavailable. Copy the address instead.</span>'; });
    const tick = async () => { try { const b = await R.solBalance(a); const el = $('#wm-dep-bal', dlg); if (el) el.textContent = solTxt(b); } catch { /* next tick */ } };
    tick(); timer = setInterval(tick, 5000);
  },
  async withdraw() {
    title('Withdraw');
    const own = await ownAddresses(), from = [arg?.from, wallet.owner, own[0]?.address].find((x) => x && own.some((o) => o.address === x));
    if (!from) return body(`<p class="hint">Connect an extension or create a local wallet first.</p><div class="row-end">${backBtn}</div>`);
    wd = { from, lamports: null, tokens: new Map() };
    const others = own.filter((o) => o.address !== from);
    body(`<form data-form="withdraw" class="wm-form" autocomplete="off">
      <label>From${sel('name="from" data-wd-from', own.map((o) => opt(o.address, o.name, short(o.address), o.address === from)).join(''))}</label>
      <label>Asset${sel('name="asset" id="wd-asset"', opt('SOL', 'SOL'))}</label>
      <span class="hint" id="wd-bal">Loading balances…</span>
      <label>To<input name="to" placeholder="Destination wallet address" spellcheck="false" autocomplete="off" required autofocus></label>
      ${others.length ? sel('id="wd-pick" aria-label="Pick one of your wallets"', opt('', 'Or pick one of your wallets…') + others.map((o) => opt(o.address, o.name, short(o.address))).join('')) : ''}
      <label>Amount<div class="wm-amt"><input name="amount" inputmode="decimal" placeholder="0.0" autocomplete="off" required><button type="button" class="btn btn-ghost sm" data-act="max">Max</button></div></label>
      ${err}<div class="row-end">${backBtn}<button class="btn btn-accent" type="submit">Review</button></div></form>`);
    loadWithdraw(from);
  },
  review() {
    title('Confirm withdrawal');
    const a = arg, amt = `${fmtUnits(a.raw, a.dec, true)} ${esc(a.sym)}`;
    body(`<form data-form="send" class="wm-form">
      <div class="wm-big">Send ${amt}</div>
      <div class="wm-sum">
        <div><span>From</span><span>${esc(a.fromName)}<br><span class="mono">${esc(a.from)}</span></span></div>
        <div><span>To</span><span class="mono wm-dest">${esc(a.to)}</span></div>
        ${a.toName ? `<div><span></span><span class="up">One of your wallets: ${esc(a.toName)}</span></div>` : ''}
        ${a.asset !== 'SOL' ? `<div><span>Token</span><span class="mono">${esc(a.asset)}</span></div>` : ''}
        <div><span>Network fee</span><span class="mono">≈ ${fmtUnits(BigInt(a.fee), 9)} SOL</span></div>
        ${a.rent ? `<div><span>Their token account</span><span class="mono">≈ ${fmtUnits(BigInt(a.rent), 9)} SOL <span class="hint">rent you pay once</span></span></div>` : ''}
        <div><span>Nought fee</span><span class="mono up">0</span></div>
      </div>
      ${a.destNew ? '<div class="wm-warn">This address has never been used on Solana. Double-check it.</div>' : ''}
      ${a.onCurve ? '' : '<div class="wm-warn bad">This is not a normal wallet address (it belongs to a program). Funds sent here may be unrecoverable.</div>'}
      <label class="check"><input type="checkbox" name="ack" required> I checked the amount and the full destination address. Transfers cannot be undone.</label>
      ${err}<div class="row-end"><button type="button" class="btn btn-ghost" data-act="withdraw" data-id="${esc(a.from)}">Back</button><button class="btn btn-accent" type="submit">Send ${amt}</button></div></form>`);
  },
  sent() {
    const a = arg, link = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(a.sig)) ? ` · <a href="https://solscan.io/tx/${esc(a.sig)}" target="_blank" rel="noopener">View on Solscan</a>` : '';
    title(a.unsure ? 'Checking the transfer' : 'Sent');
    body(`<div class="wm-form"><div class="wm-big">${fmtUnits(a.raw, a.dec, true)} ${esc(a.sym)}</div>
      <p>to <span class="mono wm-dest">${esc(a.to)}</span></p>
      ${a.unsure ? '<div class="wm-warn">The network did not confirm that it received this transfer, but it may still land. Nought is checking; do not send it again until this says Failed or Not found.</div>' : ''}
      <p>Status: <b id="wm-st">${a.unsure ? 'Checking…' : 'Confirming…'}</b>${link}</p>
      <div class="row-end"><button type="button" class="btn btn-accent" data-act="back">Done</button></div></div>`);
    let n = 0;
    timer = setInterval(async () => {
      const el = $('#wm-st', dlg);
      if (!el || ++n > 40) { clearInterval(timer); if (el) el.textContent = a.unsure ? 'Not found yet. Check Solscan before you send again.' : 'Still confirming. Check Solscan.'; return; }
      try {
        const s = await R.signatureStatus(a.sig);
        if (s?.err) { el.textContent = 'Failed on-chain'; el.className = 'down'; clearInterval(timer); }
        else if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') { el.textContent = 'Confirmed'; el.className = 'up'; clearInterval(timer); }
      } catch { /* keep polling */ }
    }, 1500);
  },
};

// ---- withdraw data ----
async function loadWithdraw(from) {
  const [lam, toks] = await Promise.all([
    R.rpc('getBalance', [from, { commitment: 'confirmed' }]).then((r) => BigInt(r.value)).catch(() => null),
    holdings(from).catch(() => R.allTokenBalances(from, { jupiter: false }).then((l) => l.map((t) => ({ mint: t.mint, raw: t.raw, dec: t.dec, program: null })))).catch(() => null),
  ]);
  if (!wd || wd.from !== from || view !== 'withdraw') return;
  wd.lamports = lam;
  const list = toks || [];
  await symbols(list).catch(() => {});
  if (!wd || wd.from !== from) return;
  wd.tokens = new Map(list.map((t) => [t.mint, t]));
  const box = $('#wd-asset', dlg); if (!box) return;
  box.innerHTML = opt('SOL', 'SOL', lam != null ? fmtUnits(lam, 9, true) : '') + list.map((t) => opt(t.mint, t.sym, fmtUnits(t.raw, t.dec, true))).join('');
  syncSel(box);
  if (!toks) $('#wd-bal', dlg).textContent = 'Could not load your tokens right now. SOL still works; reopen to retry.';
  balHint();
}
// JU holdings → [{mint, raw, dec, program}] (non-zero, not frozen), through jup.js's queue at 'high' priority (the
// user is waiting on the Withdraw form), so background polling can't hold it up
async function holdings(owner) {
  const h = await J.ju.holdings(owner, { prio: 'high' });
  return Object.entries(h.tokens || {}).map(([mint, t]) => ({ mint, raw: BigInt(t.raw || 0), dec: Number(t.dec ?? 0), program: t.program || null, frozen: t.frozen })).filter((t) => t.raw > 0n && !t.frozen);
}
// symbols from the board store, then one Jupiter token search for the rest
async function symbols(list) {
  for (const t of list) t.sym = tokens.get(t.mint)?.symbol || '';
  const miss = list.filter((t) => !t.sym).slice(0, 20);
  if (miss.length) {
    const r = await J.jt.search(miss.map((t) => t.mint), { prio: 'high' });
    for (const x of r) { const t = miss.find((m) => m.mint === x.mint); if (t && x.symbol) t.sym = String(x.symbol); }
  }
  for (const t of list) if (!t.sym) t.sym = short(t.mint);
}
function balHint() {
  const el = $('#wd-bal', dlg), asset = $('#wd-asset', dlg)?.value;
  if (!el || !wd) return;
  if (asset === 'SOL') el.textContent = wd.lamports == null ? 'Could not read the SOL balance.' : `Available ${fmtUnits(wd.lamports, 9, true)} SOL. Keep a little for fees.`;
  else { const t = wd.tokens.get(asset); el.textContent = t ? `Available ${fmtUnits(t.raw, t.dec, true)} ${t.sym}. Network fees are paid in SOL.` : ''; }
}
// what was typed ("0,5", ".5", "2.") → "0.5" for toRaw's exact parsing; parseAmount (util) decides what is readable
function plainAmount(v) {
  const t = String(v ?? '').trim();
  if (!(parseAmount(t) >= 0)) throw new Error('Enter an amount like 0.25: digits and one decimal point, no thousands separators.');
  const s = t.replace(',', '.');
  return (s.startsWith('.') ? '0' + s : s).replace(/\.$/, '');
}
// validate everything, then show the review screen (the transaction itself is built fresh when you press Send)
async function review(fd) {
  const from = String(fd.get('from')), asset = String(fd.get('asset')), to = String(fd.get('to') || '').trim(), amount = plainAmount(fd.get('amount'));
  const toPk = toPubkey(to, 'Destination');
  if (to === from) throw new Error('That is the wallet you are sending from.');
  if (!wd || wd.lamports == null) throw new Error('Could not read your SOL balance. Try again in a moment.');
  const [dest, rent0] = await Promise.all([accountInfo(to), rentExempt(0)]);
  if (dest && dest.owner !== SYSTEM_PROGRAM) throw new Error('That address is a program or token account, not a wallet. Paste a wallet address.');
  const own = await ownAddresses(), base = { from, fromName: own.find((o) => o.address === from)?.name || short(from), to, toName: own.find((o) => o.address === to)?.name || '', asset, destNew: !dest, onCurve: window.solanaWeb3.PublicKey.isOnCurve(toPk.toBytes()) };
  if (asset === 'SOL') {
    const raw = toRaw(amount, 9), fee = feeLamports('sol'), left = wd.lamports - raw - BigInt(fee);
    if (raw <= 0n) throw new Error('Enter an amount above zero.');
    if (left < 0n) throw new Error('Not enough SOL for that amount plus the network fee. Try Max.');
    if (left > 0n && left < BigInt(rent0)) throw new Error(`Leave at least ${fmtUnits(BigInt(rent0), 9)} SOL behind, or press Max to send everything.`);
    if (!dest && raw < BigInt(rent0)) throw new Error(`A brand-new address needs at least ${fmtUnits(BigInt(rent0), 9)} SOL to exist on Solana.`);
    return go('review', { ...base, raw, dec: 9, sym: 'SOL', fee, rent: 0 });
  }
  const t = wd.tokens.get(asset);
  if (!t) throw new Error('Pick a token you hold.');
  const raw = toRaw(amount, t.dec), fee = feeLamports('token');
  if (raw <= 0n) throw new Error('Enter an amount above zero.');
  if (raw > t.raw) throw new Error(`You hold ${fmtUnits(t.raw, t.dec, true)} ${t.sym}.`);
  const program = t.program || (await R.rpc('getAccountInfo', [asset, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }])).value?.owner;
  const theirs = await accountInfo(ata(to, asset, program).toBase58());
  const rent = theirs ? 0 : await rentExempt(program === R.TOKEN_2022 ? 170 : 165);
  if (BigInt(fee + rent) > wd.lamports) throw new Error(`You need about ${fmtUnits(BigInt(fee + rent), 9)} SOL in this wallet for fees${rent ? ' and their token account' : ''}.`);
  go('review', { ...base, raw, dec: t.dec, sym: t.sym, fee, rent });
}

// ---- forms ----
const FORMS = {
  async setup(f, fd) {
    const p = String(fd.get('pass')), p2 = String(fd.get('pass2'));
    if (p.length < 8) throw new Error('Use at least 8 characters. A short sentence is best.');
    if (p !== p2) throw new Error('The two passphrases do not match.');
    await V.setup(p); f.reset(); after(arg);
  },
  async unlock(f, fd) {
    await V.unlock(String(fd.get('pass'))); f.reset();
    waiters.splice(0).forEach((w) => w.res());
    if (arg?.back) go(arg.back.view, arg.back.arg); else if (arg?.close) dlg.close(); else after(arg);
  },
  async new(f, fd) {
    const w = await V.create(String(fd.get('name') || ''));
    if (!wallet.owner) await useLocal(w.address);
    go('created', w);
  },
  async import(f, fd) {
    const w = await V.importWallet(String(fd.get('secret') || ''), String(fd.get('name') || ''));
    f.reset();
    if (!wallet.owner) await useLocal(w.address);
    toast(`Imported <b>${esc(w.name)}</b> <span class="mono">${esc(short(w.address))}</span>`, 'ok');
    go('home');
  },
  async export(f, fd) {
    if (!fd.get('ack')) throw new Error('Tick the box first.');
    const secret = await V.exportWallet(arg, String(fd.get('pass'))); f.reset();
    f.outerHTML = `<div class="wm-form"><div class="wm-warn bad">Anyone with this key controls the wallet. Hide it as soon as you have saved it.</div>
      <div class="wm-secret" id="wm-secret">${esc(secret)}</div>
      <div class="row-end"><button type="button" class="btn" data-act="copy-secret">${ICON.copy} Copy secret key</button><button type="button" class="btn btn-accent" data-act="back">Hide and go back</button></div></div>`;
  },
  async rename(f, fd) { await V.rename(arg, String(fd.get('name'))); go('home'); },
  async remove(f, fd) { if (!fd.get('ack')) throw new Error('Tick the box first.'); await V.remove(arg); toast('Wallet removed from this browser.'); go('home'); },
  async erase(f, fd) { if (String(fd.get('word')).trim() !== 'ERASE') throw new Error('Type ERASE in capitals.'); await V.erase(); toast('Local wallets erased.'); go('home'); },
  withdraw: (f, fd) => review(fd),
  async send(f, fd) {
    if (!fd.get('ack')) throw new Error('Tick the box to confirm.');
    const a = arg;
    // a local sender must be unlocked first; then come back here and press Send again
    if (!(wallet.kind === 'external' && a.from === wallet.owner) && !V.isUnlocked()) return go('unlock', { msg: 'Unlock your local wallets, then confirm the withdrawal again.', then: 'review', a });
    const tx = a.asset === 'SOL' ? await transfer(a.to, a.raw, a.from) : await transferToken(a.asset, a.to, a.raw, a.from, a.dec);
    // what a local wallet's signer checks the transaction against: exactly the reviewed amount; fees as reviewed plus one
    // signature's worth of slack, and the receiver's token-account rent with a margin (its size varies with the mint)
    const expect = { purpose: 'transfer', spendMint: a.asset === 'SOL' ? 'SOL' : a.asset, maxSpendRaw: String(a.raw), maxFeeLamports: Number(a.fee) + 5000 + Math.ceil(Number(a.rent || 0) * 1.25) };
    let sig;
    try { sig = await signAndSend(tx, a.from, expect); }
    catch (e) { if (e?.maybeSent && e.sig) return go('sent', { ...a, sig: e.sig, unsure: true }); throw e; } // it may still land: never resend
    go('sent', { ...a, sig });
  },
};
async function onSubmit(e) {
  e.preventDefault();
  const f = e.target, fn = FORMS[f.dataset.form];
  if (!fn) return;
  const btn = f.querySelector('[type="submit"]'), out = f.querySelector('.wm-err');
  if (btn) btn.disabled = true;
  if (out) out.textContent = '';
  try { await fn(f, new FormData(f)); }
  catch (x) { const m = x?.message || 'Something went wrong.'; if (out?.isConnected) out.textContent = m; else toast(esc(m), 'err'); }
  finally { if (btn?.isConnected) btn.disabled = false; }
}

// ---- clicks and changes ----
async function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id, act = b.dataset.act;
  try {
    if (act === 'close') dlg.close();
    else if (act === 'back') go('home');
    else if (act === 'ext') { if (await connectWallet(id)) go('home'); }
    else if (act === 'ext-off') await disconnectWallet();
    else if (act === 'use') { await useLocal(id); toast('Active wallet: <span class="mono">' + esc(short(id)) + '</span>', 'ok'); }
    else if (act === 'lock') V.lock();
    else if (act === 'unlock') go('unlock');
    else if (act === 'new' || act === 'import') gate(act);
    else if (act === 'export') gate('export', id);
    else if (['deposit', 'rename', 'remove', 'erase'].includes(act)) go(act, id);
    else if (act === 'withdraw') go('withdraw', { from: id });
    else if (act === 'reveal') { const s = $('#wm-secret', dlg); s?.classList.toggle('blur'); b.textContent = s?.classList.contains('blur') ? 'Show' : 'Hide'; }
    else if (act === 'copy-secret') copySecret($('#wm-secret', dlg)?.textContent || '');
    else if (act === 'done-created') go('home');
    else if (act === 'max') {
      const asset = $('#wd-asset', dlg)?.value, inp = dlg.querySelector('input[name="amount"]');
      if (!wd || !inp) return;
      if (asset === 'SOL') { if (wd.lamports != null) inp.value = fmtUnits(wd.lamports > BigInt(feeLamports('sol')) ? wd.lamports - BigInt(feeLamports('sol')) : 0n, 9); }
      else { const t = wd.tokens.get(asset); if (t) inp.value = fmtUnits(t.raw, t.dec); }
    }
  } catch (x) { toast(esc(x?.message || 'Something went wrong.'), 'err'); }
}
function onChange(e) {
  const t = e.target;
  try {
    if (t.dataset.pick) selectWallet(t.dataset.pick, t.checked);
    else if (t.hasAttribute('data-autolock')) V.setAutoLock(Number(t.value));
    else if (t.hasAttribute('data-ack-saved')) $('[data-act="done-created"]', dlg).disabled = !t.checked;
    else if (t.hasAttribute('data-dep')) go('deposit', t.value);
    else if (t.hasAttribute('data-wd-from')) go('withdraw', { from: t.value });
    else if (t.id === 'wd-asset') { balHint(); const inp = dlg.querySelector('input[name="amount"]'); if (inp) inp.value = ''; }
    else if (t.id === 'wd-pick' && t.value) { dlg.querySelector('input[name="to"]').value = t.value; t.value = ''; }
  } catch (x) { if (t.dataset.pick) t.checked = !t.checked; toast(esc(x.message), 'err'); }
  if (t.matches?.('.wm-sel select')) syncSel(t);
}
// the secret never goes through the shared copy() helper, which echoes what it copied in a toast
async function copySecret(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Secret key copied. Paste it somewhere safe now: Nought empties the clipboard in 60 s if this tab still has focus.', 'ok');
    clearTimeout(clipTimer);
    clipTimer = setTimeout(() => { if (document.hasFocus()) navigator.clipboard.writeText('').catch(() => { /* best effort */ }); }, 60000);
  } catch { toast('Copy failed. Select the key and copy it by hand.', 'err'); }
}

// ---- QR (qrcode-generator, MIT, loaded on first use with a pinned version and SRI) ----
let qrLib = null;
function loadQr() {
  return qrLib ||= new Promise((res, rej) => {
    if (window.qrcode) return res(window.qrcode);
    const s = document.createElement('script');
    s.src = QR_SRC; s.integrity = QR_SRI; s.crossOrigin = 'anonymous';
    s.onload = () => (window.qrcode ? res(window.qrcode) : rej(new Error('QR library missing')));
    s.onerror = () => { qrLib = null; rej(new Error('QR library did not load')); };
    document.head.appendChild(s);
  });
}
async function qr(text) {
  const q = (await loadQr())(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" width="100%" height="100%" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

const CSS = `
#wallet-mgr { width: min(600px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); }
#wallet-mgr .wm { gap: 14px; }
.wm-head { display: flex; align-items: center; gap: 10px; } .wm-head h2 { flex: 1; }
.wm-body, .wm-form { display: grid; gap: 12px; min-width: 0; }
.wm-sec { display: grid; gap: 8px; min-width: 0; }
.wm-sec + .wm-sec { padding-top: 6px; border-top: 1px solid var(--line); }
.wm-sec h3 { margin: 0; color: var(--muted); font: 600 10.5px/1.2 var(--sans); text-transform: uppercase; letter-spacing: .07em; }
#wm-body:focus-visible { outline: 0; } /* focused on open so the close button doesn't wear a ring; not a control */
.wm p { margin: 0; line-height: 1.5; }
.wm-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--bg); }
.wm-row.on { border-color: var(--accent-2); }
.wm-id { display: grid; gap: 3px; min-width: 0; }
.wm-id b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.wm-addr { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11.5px; }
.wm-side { display: flex; align-items: center; gap: 8px; }
.wm-bal { color: var(--fg); font-size: 12px; white-space: nowrap; }
.wm-acts { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.wm-grow { flex: 1; }
.wm-tag { margin-left: 4px; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); font: 600 10px/1.4 var(--mono); vertical-align: 1px; }
.wm-ic { display: inline-flex; padding: 2px; border: 0; background: none; color: var(--muted); }
.wm-ic:hover { color: var(--fg); }
.wm-noext { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 7px; padding: 9px 12px; border: 1px dashed var(--line-2); border-radius: 9px; color: var(--muted); font-size: 12px; }
.wm-noext i { font-style: normal; color: var(--dim); }
.wm-get { display: inline-flex; align-items: baseline; gap: 2px; color: var(--accent); font-weight: 600; white-space: nowrap; }
.wm-get:hover { text-decoration: underline; text-underline-offset: 3px; }
.wm-get span { font-size: 10px; }
#wallet-mgr .btn.sm { height: 26px; padding: 0 9px; font-size: 11.5px; }
#wallet-mgr .btn.danger { color: var(--down); border-color: color-mix(in srgb, var(--down) 45%, transparent); }
#wallet-mgr .btn.danger:hover { background: color-mix(in srgb, var(--down) 12%, transparent); }
#wallet-mgr .dlg .wm-pick { font-weight: 500; font-size: 12px; color: var(--muted); gap: 6px; }
#wallet-mgr select, #wallet-mgr textarea { width: 100%; min-width: 0; padding: 0 9px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--bg); color: var(--fg); font: 12px var(--mono); outline: 0; }
#wallet-mgr select { height: 36px; padding: 0 28px 0 11px; appearance: none; -webkit-appearance: none; cursor: pointer;
  background: var(--bg) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%237d8496' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center / 10px; }
:root[data-theme="light"] #wallet-mgr select { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23596073' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }
#wallet-mgr select:hover { border-color: var(--dim); }
#wallet-mgr select option { color: var(--fg); background: var(--panel); }
#wallet-mgr textarea { padding: 9px 11px; resize: vertical; line-height: 1.45; }
#wallet-mgr .wm-lock select { width: auto; height: 26px; padding: 0 24px 0 8px; background-position: right 8px center; }
.wm-sel { position: relative; display: block; min-width: 0; }
#wallet-mgr .wm-sel select { color: transparent; } /* the label laid over it shows the choice */
.wm-sel-v { position: absolute; inset: 0 32px 0 12px; display: flex; align-items: center; gap: 8px; overflow: hidden; white-space: nowrap; pointer-events: none; color: var(--fg); font: 500 12.5px/1 var(--sans); }
.wm-sel-v > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.wm-sel-v .mono { flex: none; color: var(--muted); font-size: 12px; font-weight: 400; }
.wm-sel-v.ph > span:first-child { color: var(--muted); font-weight: 400; }
#wallet-mgr input:focus, #wallet-mgr select:focus, #wallet-mgr textarea:focus { border-color: var(--accent-2); }
.wm-lock { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
.wm-lock > .btn { margin-left: auto; } /* stays on the right when the row wraps on a phone */
.wm-auto { display: flex; align-items: center; gap: 6px; margin-left: 6px; padding-left: 10px; border-left: 1px solid var(--line-2); }
.wm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }
.wm-dot.on { background: var(--up); box-shadow: 0 0 0 3px color-mix(in srgb, var(--up) 22%, transparent); }
.wm-warn { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--warn) 7%, transparent); font-size: 12px; line-height: 1.5; }
.wm-warn.bad { border-color: color-mix(in srgb, var(--down) 45%, transparent); background: color-mix(in srgb, var(--down) 8%, transparent); }
.wm-why { padding: 0; }
.wm-why summary { display: flex; align-items: center; gap: 10px; padding: 7px 12px; cursor: pointer; list-style: none; }
.wm-why summary::-webkit-details-marker { display: none; }
.wm-why summary > span:first-child { flex: 1; min-width: 0; }
.wm-why-l { flex: none; color: color-mix(in srgb, var(--warn) 80%, var(--fg)); font-weight: 600; text-decoration: underline dotted; text-underline-offset: 3px; }
.wm-why[open] .wm-why-l { text-decoration: none; opacity: .7; }
.wm-why p { padding: 0 12px 9px; color: var(--muted); }
.wm-err { min-height: 0; margin: 0; color: var(--down); font-size: 12px; }
.wm-err:empty { display: none; }
.wm-secret { padding: 10px 12px; border: 1px dashed var(--warn); border-radius: 8px; background: var(--bg); font: 500 12px/1.5 var(--mono); word-break: break-all; user-select: all; }
.wm-secret.blur { filter: blur(6px); user-select: none; }
.wm-addrbox { display: block; padding: 9px 11px; border: 1px solid var(--line-2); border-radius: 7px; background: var(--bg); font-size: 12px; font-weight: 500; word-break: break-all; text-align: center; }
.wm-qr { display: grid; place-items: center; width: min(220px, 70vw); aspect-ratio: 1; margin: 0 auto; border-radius: 10px; overflow: hidden; background: #fff; color: #333; text-align: center; }
.wm-center { text-align: center; justify-self: center; }
.wm-amt { position: relative; display: block; }
#wallet-mgr .wm-amt input { width: 100%; padding-right: 58px; }
#wallet-mgr .wm-amt .btn { position: absolute; right: 5px; top: 5px; height: 26px; background: var(--panel-2); }
.wm-big { font: 600 20px/1.25 var(--mono); word-break: break-word; }
.wm-sum { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--bg); font-size: 12.5px; }
.wm-sum > div { display: flex; justify-content: space-between; gap: 14px; }
.wm-sum > div > span:first-child { flex: none; color: var(--muted); }
.wm-sum > div > span:last-child { min-width: 0; text-align: right; word-break: break-all; }
.wm-dest { color: var(--fg); font-weight: 600; word-break: break-all; }
.wm-left { margin-right: auto; }
/* phone: Multi-wallet shares its line with Remove (set apart from the everyday actions), then the four actions fill the
   next row evenly; the lock row keeps status and Lock now together and puts the auto-lock choice underneath */
@media (max-width: 560px) {
  .wm-row { padding: 9px 10px; }
  .wm-acts { gap: 5px; }
  .wm-acts .wm-grow { order: 2; flex-basis: 100%; height: 0; }
  .wm-acts .btn { order: 3; flex: 1 1 auto; }
  .wm-acts .btn.danger { order: 1; flex: none; margin-left: auto; }
  .wm-auto { order: 3; flex-basis: 100%; margin: 0; padding: 0; border: 0; }
  .wm-why summary { padding: 7px 10px; }
}
@media (max-width: 440px) { .wm-noext > span { flex-basis: 100%; } } /* the label sits above the links rather than splitting them */
@media (max-width: 380px) { .wm-acts .btn:not(.danger) { flex-basis: calc(50% - 3px); } } /* two by two, never one left over */
`;
