// Local hot wallets: Solana keypairs made in this browser, encrypted under one passphrase and kept in IndexedDB
// (database 'nought', store 'vault'). PBKDF2-SHA256 (600k iterations, random 16-byte salt) derives an AES-GCM-256 key;
// every secret is sealed with its own random 12-byte IV and its address as additional data, so records can't be swapped.
// Decrypted secrets live only in memory while unlocked; lock() zeroes them. Nothing here writes a plaintext secret to
// storage or the console. Needs a secure page (https or localhost) for WebCrypto. Emits 'vault' on every change.
import { LS, emit } from './util.js';

const DB = 'nought', STORE = 'vault', META = '_meta', ITER = 600000, CHECK = 'nought-vault-v1';
const keys = new Map(); // address → Uint8Array(64) secret, only while unlocked
let aes = null;         // the derived CryptoKey (non-extractable), only while unlocked
let lastActive = Date.now();
const web3 = () => { if (!window.solanaWeb3) throw new Error('Solana library did not load. Reload the page.'); return window.solanaWeb3; };

export const supported = () => !!(globalThis.isSecureContext && globalThis.crypto?.subtle && globalThis.indexedDB);
export const isUnlocked = () => !!aes;
export const state = () => ({ unlocked: !!aes, count: keys.size });

// ---- base58 (web3.js's IIFE does not expose bs58) ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58encode(bytes) {
  let n = 0n, s = '';
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = '1' + s; }
  return s;
}
export function b58decode(str) {
  let n = 0n; const out = [];
  for (const c of str) { const i = B58.indexOf(c); if (i < 0) throw new Error('Not base58.'); n = n * 58n + BigInt(i); }
  while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of str) { if (c !== '1') break; out.unshift(0); }
  return Uint8Array.from(out);
}

// ---- IndexedDB. Other modules may share the 'nought' database: if our store is missing, bump the version to add it,
// and close on 'versionchange' so theirs can upgrade too. ----
let dbp = null;
function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const go = (ver) => {
      const rq = ver ? indexedDB.open(DB, ver) : indexedDB.open(DB);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE, { keyPath: 'id' }); };
      rq.onsuccess = () => {
        const d = rq.result;
        if (!d.objectStoreNames.contains(STORE)) { const v = d.version + 1; d.close(); go(v); return; }
        d.onversionchange = () => { d.close(); dbp = null; };
        res(d);
      };
      rq.onerror = () => rej(rq.error || new Error('This browser blocked local storage.'));
    };
    go(0);
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const read = async (fn) => req(fn((await openDb()).transaction(STORE, 'readonly').objectStore(STORE)));
async function write(fn) {
  const t = (await openDb()).transaction(STORE, 'readwrite');
  fn(t.objectStore(STORE));
  return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error || new Error('Could not save to this browser.')); });
}
const getRec = (id) => read((s) => s.get(id));
const allRecs = () => read((s) => s.getAll());

// ---- crypto ----
const enc = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function derive(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(pass).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, bytes, ad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(ad) }, key, bytes));
  return { iv: b64(iv), ct: b64(ct) };
}
const unseal = async (key, box, ad) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: enc.encode(ad) }, key, unb64(box.ct)));
// derive the key from a passphrase and prove it against the vault's check value; throws 'Wrong passphrase.'
async function keyFor(pass) {
  const m = await getRec(META);
  if (!m) throw new Error('There are no local wallets yet.');
  const key = await derive(pass, unb64(m.salt), m.iter);
  try { if (new TextDecoder().decode(await unseal(key, m.check, META)) !== CHECK) throw 0; } catch { throw new Error('Wrong passphrase.'); }
  return key;
}
function need() {
  if (!supported()) throw new Error('Local wallets need a secure (https) page and IndexedDB.');
  if (!aes) throw new Error('Unlock your local wallets first.');
}

// ---- public API ----
export async function hasVault() { return supported() && !!(await getRec(META)); }
// public info only: [{id, address, name, created}] (id === address)
export async function list() {
  if (!supported()) return [];
  return (await allRecs()).filter((r) => r.id !== META).map(({ id, name, created }) => ({ id, address: id, name, created })).sort((a, b) => a.created - b.created);
}
// first run: choose the passphrase that encrypts every local wallet in this browser
export async function setup(pass) {
  if (!supported()) throw new Error('Local wallets need a secure (https) page and IndexedDB.');
  if (String(pass).length < 8) throw new Error('Use a passphrase of at least 8 characters.');
  if (await getRec(META)) throw new Error('A passphrase is already set. Unlock instead.');
  const salt = crypto.getRandomValues(new Uint8Array(16)), key = await derive(pass, salt, ITER);
  const meta = { id: META, v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: b64(salt), check: await seal(key, enc.encode(CHECK), META) };
  await write((s) => s.put(meta));
  aes = key; touch(); emit('vault', state());
}
export async function unlock(pass) {
  if (!supported()) throw new Error('Local wallets need a secure (https) page and IndexedDB.');
  const key = await keyFor(pass), W = web3(), next = new Map();
  for (const r of (await allRecs()).filter((x) => x.id !== META)) {
    try {
      const sk = await unseal(key, r, r.id);
      if (W.Keypair.fromSecretKey(sk).publicKey.toBase58() === r.id) next.set(r.id, sk); else sk.fill(0);
    } catch { /* a damaged record stays locked; the others still open */ }
  }
  wipe(); next.forEach((v, k) => keys.set(k, v));
  aes = key; touch(); emit('vault', state());
}
function wipe() { for (const k of keys.values()) k.fill(0); keys.clear(); }
export function lock() { const was = !!aes; wipe(); aes = null; if (was) emit('vault', state()); }

async function add(sk, name) {
  const W = web3(), id = W.Keypair.fromSecretKey(sk).publicKey.toBase58();
  if (await getRec(id)) { sk.fill(0); throw new Error('That wallet is already in this browser.'); }
  const n = (await list()).length + 1, label = String(name || '').trim().slice(0, 32) || `Wallet ${n}`;
  const box = await seal(aes, sk, id);
  await write((s) => s.put({ id, v: 1, name: label, created: Date.now(), ...box }));
  keys.set(id, sk); touch(); emit('vault', state());
  return { id, address: id, name: label };
}
// new random keypair; the result carries `secret` (base58) to show ONCE, then forget
export async function create(name) {
  need();
  const sk = web3().Keypair.generate().secretKey; // a copy we own
  const w = await add(sk, name);
  return { ...w, secret: b58encode(sk) };
}
// a base58 secret key (64 bytes, or a 32-byte seed), or a JSON byte array like a Solana CLI id.json
function parseSecret(input) {
  const s = String(input || '').trim(), W = web3();
  let bytes;
  if (s.startsWith('[')) {
    let a; try { a = JSON.parse(s); } catch { throw new Error('That is not a valid JSON byte array.'); }
    if (!Array.isArray(a) || !a.every((x) => Number.isInteger(x) && x >= 0 && x < 256)) throw new Error('The JSON array must hold numbers from 0 to 255.');
    bytes = Uint8Array.from(a);
  } else {
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) throw new Error('Paste a base58 secret key or a JSON byte array.');
    bytes = b58decode(s);
  }
  if (bytes.length === 32) { const sk = W.Keypair.fromSeed(bytes).secretKey; bytes.fill(0); return sk; }
  if (bytes.length !== 64) { bytes.fill(0); throw new Error('A Solana secret key is 64 bytes (or a 32-byte seed).'); }
  try { W.Keypair.fromSecretKey(bytes); } catch { bytes.fill(0); throw new Error('That secret key does not match its public key.'); }
  return bytes;
}
export async function importWallet(secret, name) { need(); return add(parseSecret(secret), name); }
// reveal a secret: must be unlocked AND re-enter the passphrase (the UI also asks for an explicit confirmation)
export async function exportWallet(id, pass) {
  need();
  const key = await keyFor(pass), r = await getRec(id);
  if (!r || id === META) throw new Error('That wallet is not in this browser.');
  const sk = await unseal(key, r, r.id), out = b58encode(sk);
  sk.fill(0);
  return out;
}
export async function rename(id, name) {
  const r = await getRec(id), label = String(name || '').trim().slice(0, 32);
  if (!r || id === META) throw new Error('That wallet is not in this browser.');
  if (!label) throw new Error('Give it a name.');
  await write((s) => s.put({ ...r, name: label }));
  emit('vault', state());
}
// deletes the encrypted key for good (the UI confirms first)
export async function remove(id) {
  if (id === META) return;
  await write((s) => s.delete(id));
  keys.get(id)?.fill(0); keys.delete(id);
  emit('vault', { ...state(), removed: id });
}
// forgot the passphrase: erase every local wallet and the passphrase (the UI demands a typed confirmation)
export async function erase() {
  lock();
  await write((s) => s.clear());
  emit('vault', { ...state(), erased: true });
}
// a Keypair for an unlocked local wallet, or null. Not exported: wallet.js claims it once with claimSigner() when it
// loads, so no other module can get a key to sign arbitrary bytes or read it; every signature goes through wallet.js,
// which simulates and checks the transaction first (txcheck.js).
function keypairFor(address) {
  const sk = aes && keys.get(address);
  if (!sk) return null; // signing is not user activity: it never postpones the auto-lock
  return web3().Keypair.fromSecretKey(sk, { skipValidation: true });
}
let claimed = false;
export function claimSigner() {
  if (claimed) throw new Error('The local wallet signer is already in use.');
  claimed = true;
  return keypairFor;
}

// ---- auto-lock after N idle minutes (default 15) and when the tab closes ----
export const AUTOLOCK = [5, 15, 30, 60, 240];
export const autoLockMin = () => { const m = Number(LS.get('vault.autolock', 15)); return AUTOLOCK.includes(m) ? m : 15; };
export function setAutoLock(min) { LS.set('vault.autolock', AUTOLOCK.includes(Number(min)) ? Number(min) : 15); touch(); }
function touch() { lastActive = Date.now(); }
const idleCheck = () => { if (aes && Date.now() - lastActive > autoLockMin() * 60000) lock(); };
if (typeof window !== 'undefined') {
  for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(e, touch, { passive: true, capture: true });
  setInterval(idleCheck, 20000);
  document.addEventListener('visibilitychange', idleCheck); // timers sleep with the laptop; check on return
  addEventListener('pagehide', lock);
}
