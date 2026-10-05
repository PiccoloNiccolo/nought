// One active signer: an external wallet (Phantom, Solflare, Backpack: Nought never sees keys, the wallet signs and sends)
// or a local vault wallet (src/core/vault.js: Nought signs in this tab and sends through RPC). Listen for 'wallet' events.
// wallet.kind is 'external' | 'local' | null; wallet.selected lists local wallet addresses picked for multi-wallet trades.
// A local wallet signs nothing that txcheck.js hasn't simulated and held to the caller's `expect` (contract C3).
import { LS, emit, on, toast, esc, short, $ } from './util.js';
import { ju } from './jup.js';
import * as R from './rpc.js';
import * as V from './vault.js';
import { checkTx } from './txcheck.js';

export const WALLETS = [
  { id: 'phantom', name: 'Phantom', get: () => window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null), site: 'https://phantom.com' },
  { id: 'solflare', name: 'Solflare', get: () => (window.solflare?.isSolflare ? window.solflare : null), site: 'https://solflare.com' },
  { id: 'backpack', name: 'Backpack', get: () => window.backpack?.solana || null, site: 'https://backpack.app' },
];
export const MAX_SELECTED = 25;
export const wallet = { provider: null, owner: null, id: null, kind: null, name: '', selected: LS.get('wallet.selected', []).filter((a) => typeof a === 'string') };
const web3 = () => { if (!window.solanaWeb3) throw new Error('Solana library did not load. Reload the page.'); return window.solanaWeb3; };
const ui = () => import('../ui/wallets.js'); // lazy: the dialog imports this module
const keypairFor = V.claimSigner(); // the vault hands its signer to this module only, once

// ---- external wallets ----
const hooked = new WeakSet();
export async function connectWallet(id) {
  const w = WALLETS.find((x) => x.id === id), p = w?.get();
  if (!p) { window.open(w.site, '_blank', 'noopener'); return false; }
  const res = await p.connect();
  const owner = (res?.publicKey || p.publicKey)?.toString();
  if (!owner) throw new Error(`${w.name} did not share an address.`);
  Object.assign(wallet, { provider: p, owner, id, kind: 'external', name: w.name }); LS.set('wallet', id);
  if (!hooked.has(p)) { hooked.add(p); p.on?.('accountChanged', (pk) => { if (wallet.provider !== p) return; wallet.owner = pk?.toString() || null; emit('wallet', wallet); }); }
  toast(`Connected ${esc(w.name)} <span class="mono">${esc(short(owner))}</span>`, 'ok');
  emit('wallet', wallet);
  return true;
}
// external: disconnects the extension. local: just stops using it (the vault stays as it is)
export async function disconnectWallet() {
  if (wallet.kind === 'external') { try { await wallet.provider?.disconnect?.(); } catch { /* fine */ } }
  Object.assign(wallet, { provider: null, owner: null, id: null, kind: null, name: '' }); LS.set('wallet', null); emit('wallet', wallet);
}

// ---- local wallets ----
export async function useLocal(address) {
  const w = (await V.list()).find((x) => x.address === address);
  if (!w) throw new Error('That local wallet is not in this browser.');
  Object.assign(wallet, { provider: null, owner: w.address, id: w.address, kind: 'local', name: w.name }); LS.set('wallet', 'local:' + w.address);
  emit('wallet', wallet);
  return true;
}
// pick local wallets for multi-wallet trades (up to MAX_SELECTED)
export function selectWallet(address, yes = !wallet.selected.includes(address)) {
  const s = new Set(wallet.selected);
  if (yes) s.add(address); else s.delete(address);
  if (s.size > MAX_SELECTED) throw new Error(`Pick at most ${MAX_SELECTED} wallets for a trade.`);
  wallet.selected = [...s]; LS.set('wallet.selected', wallet.selected); emit('wallet', wallet);
}
// owners a trade should run on: the selected local wallets, or else just the active wallet
export const tradeOwners = () => (wallet.selected.length ? [...wallet.selected] : wallet.owner ? [wallet.owner] : []);
export const isLocal = (address) => V.list().then((l) => l.some((w) => w.address === address));
// keep the active wallet and the selection in step with the vault (renames, removals, erase, lock/unlock)
on('vault', async () => {
  const l = await V.list().catch(() => []), ids = new Map(l.map((w) => [w.address, w]));
  const sel = wallet.selected.filter((a) => ids.has(a));
  if (sel.length !== wallet.selected.length) { wallet.selected = sel; LS.set('wallet.selected', sel); }
  if (wallet.kind === 'local') {
    if (!ids.has(wallet.owner)) { await disconnectWallet(); return; }
    wallet.name = ids.get(wallet.owner).name;
  }
  emit('wallet', wallet);
});

export function openWalletPicker() {
  const list = $('#wallet-list');
  list.innerHTML = WALLETS.map((w) => `<button value="cancel" data-w="${w.id}">${w.name}<small>${w.get() ? 'Detected' : 'Install'}</small></button>`).join('')
    + '<button value="cancel" data-local>Local wallet<small>Lives in this browser · one-click trades</small></button>';
  list.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => connectWallet(b.dataset.w).catch((e) => toast(esc(e.message), 'err'))));
  list.querySelector('[data-local]').addEventListener('click', () => ui().then((m) => m.openWalletManager()));
  $('#wallets').showModal();
}
// true if a wallet is active; otherwise opens the picker and returns false
export function needWallet() { if (wallet.owner) return true; openWalletPicker(); return false; }

export async function reconnect() {
  const id = LS.get('wallet', null);
  if (typeof id === 'string' && id.startsWith('local:')) { try { await useLocal(id.slice(6)); } catch { LS.set('wallet', null); } return; }
  const p = WALLETS.find((w) => w.id === id)?.get();
  if (!p) return;
  try { const res = await p.connect({ onlyIfTrusted: true }); const owner = (res?.publicKey || p.publicKey)?.toString(); if (owner) { Object.assign(wallet, { provider: p, owner, id, kind: 'external', name: WALLETS.find((w) => w.id === id).name }); emit('wallet', wallet); } } catch { /* not trusted yet */ }
}

// ---- sending ----
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const blockhash = async () => (await R.latestBlockhash()).blockhash;
// sign + send a web3.js VersionedTransaction as `owner` (default: the active wallet); returns the signature string.
// External wallets show their own approval. A local wallet signs only after txcheck.js has simulated the transaction
// and found it does no more than `expect` allows (contract C3: {purpose, spendMint, maxSpendRaw, receiveMint?,
// maxFeeLamports?}); without `expect` it refuses. Transfers built below carry their own. If sending fails in a way
// that may still have landed, the error has err.sig and err.maybeSent = true (contract C4): confirm(err.sig), never retry.
export async function signAndSend(tx, owner = wallet.owner, expect) {
  if (!owner) throw new Error('Connect a wallet first.');
  if (wallet.kind === 'external' && owner === wallet.owner) {
    if (!wallet.provider) throw new Error('Connect a wallet first.');
    const res = await wallet.provider.signAndSendTransaction(tx);
    const sig = res?.signature || res;
    if (!sig) throw new Error('Your wallet did not send the transaction.');
    return typeof sig === 'string' ? sig : V.b58encode(sig);
  }
  await signLocal(tx, owner, expect);
  const sig = V.b58encode(tx.signatures[0]); // known before sending: kept even when the send errors
  try { await R.sendRaw(toB64(tx.serialize())); } catch (e) { if (e?.maybeSent) e.sig = sig; throw e; }
  return sig;
}
// sign without sending (Jupiter Ultra lands it); returns the signed VersionedTransaction. Same `expect` as signAndSend.
export async function signTx(tx, owner = wallet.owner, expect) {
  if (!owner) throw new Error('Connect a wallet first.');
  if (wallet.kind === 'external' && owner === wallet.owner) {
    if (!wallet.provider?.signTransaction) throw new Error('This wallet cannot sign without sending.');
    return wallet.provider.signTransaction(tx);
  }
  await signLocal(tx, owner, expect);
  return tx;
}
// local signing: unlock if needed, check (txcheck.js throws a reason to show when it refuses), then sign as owner only
const built = new WeakMap(); // transactions built by transfer()/transferToken() → what they may spend
async function signLocal(tx, owner, expect) {
  const exp = built.get(tx) || expect;
  if (!exp) throw new Error('Nought did not sign this transaction: it came without a description of what it may spend.');
  const kp = await localKeypair(owner);
  await checkTx(tx, owner, exp);
  tx.sign([kp]);
}
// the Keypair of a local wallet, asking to unlock the vault first when needed
async function localKeypair(owner) {
  let kp = keypairFor(owner);
  if (kp) return kp;
  if (!(await isLocal(owner))) throw new Error(`Nought cannot sign for ${short(owner)}.`);
  await (await ui()).requestUnlock('Unlock your local wallets to sign.');
  kp = keypairFor(owner);
  if (!kp) throw new Error('Your local wallets are still locked.');
  return kp;
}

// ---- transfers for Withdraw. Instructions are built by hand: web3.js's IIFE build has no global Buffer, so
// SystemProgram.transfer and ComputeBudgetProgram.setComputeUnitPrice throw in the browser. ----
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const CB_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const PRIO_MICRO = 200000; // micro-lamports per compute unit on transfers: a tiny priority fee, paid to validators
export const CU = { sol: 1000, token: 60000 };
export const feeLamports = (kind) => 5000 + Math.ceil((CU[kind] * PRIO_MICRO) / 1e6); // one signature + priority

const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const acct = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });
const pk = (s) => new (web3().PublicKey)(s);
const ix = (programId, keys, data) => new (web3().TransactionInstruction)({ programId: pk(programId), keys, data });
const budget = (units) => [ix(CB_PROGRAM, [], cat(Uint8Array.of(2), u32(units))), ix(CB_PROGRAM, [], cat(Uint8Array.of(3), u64(PRIO_MICRO)))];

// a PublicKey from user input, or a plain error
export function toPubkey(addr, what = 'Address') {
  const s = String(addr || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) throw new Error(`${what} is not a Solana address.`);
  try { return pk(s); } catch { throw new Error(`${what} is not a Solana address.`); }
}
// "1.5" with 9 decimals → 1500000000n (exact decimal parsing, no floats)
export function toRaw(amount, decimals) {
  const s = String(amount ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('Enter an amount like 0.25.');
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) throw new Error(`At most ${decimals} decimals for this token.`);
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}
// associated token account of owner for mint under a token program (classic or Token-2022)
export function ata(owner, mint, program) {
  return web3().PublicKey.findProgramAddressSync([pk(String(owner)).toBytes(), pk(String(program)).toBytes(), pk(String(mint)).toBytes()], pk(ATA_PROGRAM))[0];
}
async function build(payer, ixs) {
  const W = web3();
  return new W.VersionedTransaction(new W.TransactionMessage({ payerKey: payer, recentBlockhash: await blockhash(), instructions: ixs }).compileToV0Message());
}
const accountInfo = async (addr, parsed) => (await R.rpc('getAccountInfo', [String(addr), parsed ? { encoding: 'jsonParsed', commitment: 'confirmed' } : { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }])).value;
const notWallet = (info) => info && info.owner !== SYSTEM_PROGRAM;

// SOL transfer, unsigned. Show amount + destination, get an explicit yes, then signAndSend(tx, from): a local wallet
// signs it only for this amount plus the network fee.
export async function transfer(toAddress, solAmount, from = wallet.owner) {
  const fromPk = toPubkey(from, 'Your wallet'), toPk = toPubkey(toAddress, 'Destination');
  if (fromPk.equals(toPk)) throw new Error('That is the same wallet.');
  const lamports = typeof solAmount === 'bigint' ? solAmount : toRaw(solAmount, 9);
  if (lamports <= 0n) throw new Error('Enter an amount above zero.');
  if (notWallet(await accountInfo(toPk))) throw new Error('That address is a program or token account, not a wallet. Paste a wallet address.');
  const send = ix(SYSTEM_PROGRAM, [acct(fromPk, true, true), acct(toPk, false, true)], cat(u32(2), u64(lamports)));
  const tx = await build(fromPk, [...budget(CU.sol), send]);
  built.set(tx, { purpose: 'transfer', spendMint: 'SOL', maxSpendRaw: lamports.toString(), maxFeeLamports: 2 * feeLamports('sol') });
  return tx;
}
// SPL or Token-2022 transfer of rawAmount base units, unsigned. Creates the receiver's token account when it is missing
// (the sender pays its rent) and uses transferChecked under the mint's own token program. `decimals` is what the
// amount was entered with (contract C5): if the mint says otherwise the amount would be off by powers of ten, so refuse.
export async function transferToken(mint, toAddress, rawAmount, from = wallet.owner, decimals) {
  const mintPk = toPubkey(mint, 'Token'), ownerPk = toPubkey(from, 'Your wallet'), toPk = toPubkey(toAddress, 'Destination');
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('Nought needs the token\'s decimals to send it. Open Withdraw again and re-enter the amount.');
  if (ownerPk.equals(toPk)) throw new Error('That is the same wallet.');
  const amount = BigInt(rawAmount);
  if (amount <= 0n) throw new Error('Enter an amount above zero.');
  const m = await accountInfo(mintPk, true), program = m?.owner, info = m?.data?.parsed?.info;
  if ((program !== R.TOKEN_PROGRAM && program !== R.TOKEN_2022) || m.data?.parsed?.type !== 'mint') throw new Error('That address is not a token mint.');
  if (info.decimals !== decimals) throw new Error(`This token has ${info.decimals} decimals, not ${decimals}, so the amount would be wrong. Open Withdraw again and re-enter it.`);
  if (info.extensions?.some((e) => e.extension === 'transferHook' && e.state?.programId)) throw new Error('This token runs a transfer hook that Nought cannot route. Send it from your wallet app.');
  if (info.extensions?.some((e) => e.extension === 'nonTransferable')) throw new Error('This token cannot be transferred.');
  if (notWallet(await accountInfo(toPk))) throw new Error('That address is a program or token account, not a wallet. Paste the owner\'s wallet address.');
  const src = await sourceAccount(ownerPk, mintPk, program, amount), dst = ata(toPk, mintPk, program);
  const create = ix(ATA_PROGRAM, [acct(ownerPk, true, true), acct(dst, false, true), acct(toPk, false, false), acct(mintPk, false, false), acct(pk(SYSTEM_PROGRAM), false, false), acct(pk(program), false, false)], Uint8Array.of(1)); // CreateIdempotent
  const send = ix(program, [acct(src, false, true), acct(mintPk, false, false), acct(dst, false, true), acct(ownerPk, true, false)], cat(Uint8Array.of(12), u64(amount), Uint8Array.of(decimals))); // TransferChecked
  const tx = await build(ownerPk, [...budget(CU.token), create, send]);
  // fees plus the receiver's token-account rent when it is created (Token-2022 accounts with extensions cost a bit more)
  built.set(tx, { purpose: 'transfer', spendMint: mintPk.toBase58(), maxSpendRaw: amount.toString(), maxFeeLamports: 2 * feeLamports('token') + 5_000_000 });
  return tx;
}
// the account to send from: the owner's associated token account if it holds enough, else one Jupiter lists
async function sourceAccount(ownerPk, mintPk, program, amount) {
  const mine = ata(ownerPk, mintPk, program), a = await accountInfo(mine, true);
  if (BigInt(a?.data?.parsed?.info?.tokenAmount?.amount || 0) >= amount) return mine;
  try {
    const h = await ju.holdings(ownerPk.toBase58(), { prio: 'high' });
    const hit = (h.tokens?.[mintPk.toBase58()]?.tokenAccounts || []).find((x) => x.programId === program && !x.isFrozen && BigInt(x.amount || 0) >= amount);
    if (hit) return toPubkey(hit.account);
  } catch { /* fall through */ }
  throw new Error('Not enough of this token in one account to send that amount.');
}
