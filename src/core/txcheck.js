// The check every LOCAL wallet signature goes through (contract C3). wallet.js calls checkTx(tx, owner, expect) before
// a vault key signs, so a bad or compromised answer from Jupiter (or a bug in Nought) can't take more than the user
// agreed to, not even in unattended copy trades, armed orders or 25-wallet buys. External wallets show their own
// preview and are not checked here.
// One simulateTransaction does it. The RPC answers with the SOL and token balances of every account before and after,
// the lookup-table addresses it loaded and every inner instruction, all from the same run, so nothing can change
// between a separate read and the simulation. Nought refuses to sign when:
//   - the owner is not the fee payer (and so the first required signer);
//   - the simulation fails;
//   - the owner's SOL (lamports, plus wrapped SOL and token-account rent) drops, or SOL leaves the owner's accounts, by
//     more than the SOL it spends plus a fee allowance (expect.maxFeeLamports, default 0.02 SOL: priority + network
//     fees + rent for new accounts);
//   - any other token leaves the owner's accounts or decreases there, or more than maxSpendRaw of the spent one does;
//   - a token account of the owner's changes hands, or an instruction uses the owner's authority for something a trade
//     or a transfer never needs (approve a delegate, set an authority, close an account to someone else, mint, assign or
//     allocate the wallet, nonce / stake / loader / lookup-table actions);
//   - a swap delivers none of what it buys (or less than expect.minReceiveRaw when the caller passes it).
// Whatever it can't establish is refused too (fail closed). A simulation is a strong check, not a proof: a program that
// behaves differently later on-chain can't be seen in advance.
// expect: {purpose: 'swap'|'limit-create'|'limit-cancel'|'transfer', spendMint: 'SOL'|mint, maxSpendRaw: string (raw
// units of spendMint, fees excluded), receiveMint?: 'SOL'|mint, maxFeeLamports?: number, minReceiveRaw?: string}
import { rpc } from './rpc.js';
import { b58decode, b58encode } from './vault.js';
import { isMint, short } from './util.js';

const SYS = '11111111111111111111111111111111', ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const WSOL = 'So11111111111111111111111111111111111111112';
const PURPOSES = ['swap', 'limit-create', 'limit-cancel', 'transfer'];
const FEE_DEFAULT = 20_000_000, FEE_MAX = 100_000_000; // lamports: 0.02 SOL by default, never more than 0.1 SOL
const BUDGET_MS = 8000, PARALLEL = 4; // per check once it runs; how many simulations run at once (multi-wallet buys)
export const BUSY = 'Couldn\'t check this transaction before signing (the RPC is busy). Try again, or set your own RPC in Settings > Network.';
const refuse = (why) => Object.assign(new Error('Nought did not sign this transaction: ' + why), { refused: true });
const isToken = (pid) => pid === TOKEN || pid === TOKEN22;

// What the owner's own authority may be used for, by program. The RPC names the inner instructions it parses; top-level
// and unparsed ones are decoded here. Programs not listed are opaque (Jupiter, the pools): whatever they do to the
// owner's assets goes through the token and system programs, whose instructions are all checked.
const TOKEN_RAW = { 1: 'initializeAccount', 3: 'transfer', 4: 'approve', 5: 'revoke', 6: 'setAuthority', 7: 'mintTo', 8: 'burn', 9: 'closeAccount', 10: 'freezeAccount', 11: 'thawAccount', 12: 'transferChecked', 13: 'approveChecked', 14: 'mintToChecked', 15: 'burnChecked', 16: 'initializeAccount2', 17: 'syncNative', 18: 'initializeAccount3', 21: 'getAccountDataSize', 22: 'initializeImmutableOwner', 23: 'amountToUiAmount', 24: 'uiAmountToAmount' };
const TOKEN_OK = new Set(['initializeAccount', 'initializeAccount2', 'initializeAccount3', 'transfer', 'transferChecked', 'transferCheckedWithFee', 'revoke', 'burn', 'burnChecked', 'closeAccount', 'syncNative', 'getAccountDataSize', 'initializeImmutableOwner', 'amountToUiAmount', 'uiAmountToAmount']);
const TOKEN_MOVE = new Set(['transfer', 'transferChecked', 'transferCheckedWithFee', 'burn', 'burnChecked']);
const TOKEN_WHY = {
  approve: 'it would let another account spend your tokens.', approveChecked: 'it would let another account spend your tokens.',
  setAuthority: 'it would hand control of one of your token accounts (or a mint you control) to someone else.',
  mintTo: 'it would mint tokens with your wallet\'s authority.', mintToChecked: 'it would mint tokens with your wallet\'s authority.',
};
const SYS_RAW = ['createAccount', 'assign', 'transfer', 'createAccountWithSeed', 'advanceNonce', 'withdrawFromNonce', 'initializeNonce', 'authorizeNonce', 'allocate', 'allocateWithSeed', 'assignWithSeed', 'transferWithSeed', 'upgradeNonce'];
const SYS_OK = new Set(['transfer', 'createAccount', 'createAccountWithSeed']); // the lamports they move are counted
const ATA_OK = new Set(['create', 'createIdempotent']);
const NEVER = new Map([ // a trade or a transfer never touches the owner here
  ['Stake11111111111111111111111111111111111111', 'the stake program'], ['Vote111111111111111111111111111111111111111', 'the vote program'],
  ['BPFLoaderUpgradeab1e11111111111111111111111', 'the program loader'], ['BPFLoader2111111111111111111111111111111111', 'the program loader'],
  ['BPFLoader1111111111111111111111111111111111', 'the program loader'], ['LoaderV411111111111111111111111111111111111', 'the program loader'],
  ['AddressLookupTab1e1111111111111111111111111', 'the lookup-table program'], ['Config1111111111111111111111111111111111111', 'the config program'],
]);
function rawType(pid, d) {
  if (!d) return '?';
  if (isToken(pid)) return d[0] === 26 && d[1] === 1 ? 'transferCheckedWithFee' : TOKEN_RAW[d[0]] || `instruction ${d[0]}`;
  if (pid === SYS) return d.length >= 4 ? SYS_RAW[new DataView(d.buffer, d.byteOffset, 4).getUint32(0, true)] || 'unknown' : '?';
  if (pid === ATA) return !d.length || d[0] === 0 ? 'create' : d[0] === 1 ? 'createIdempotent' : 'recoverNested';
  return '';
}
// a raw instruction as {type, info} in the RPC's jsonParsed shape (only the fields the checks read)
function decode(pid, d, a) {
  const type = rawType(pid, d), at = (o) => (d && d.length >= o + 8 ? new DataView(d.buffer, d.byteOffset + o, 8).getBigUint64(0, true).toString() : '0');
  if (isToken(pid)) {
    if (type === 'transfer') return { type, info: { source: a[0], destination: a[1], authority: a[2], amount: at(1) } };
    if (type === 'transferChecked' || type === 'transferCheckedWithFee') return { type, info: { source: a[0], mint: a[1], destination: a[2], authority: a[3], amount: at(type === 'transferChecked' ? 1 : 2) } };
    if (type === 'burn' || type === 'burnChecked') return { type, info: { account: a[0], mint: a[1], authority: a[2], amount: at(1) } };
    if (type === 'closeAccount') return { type, info: { account: a[0], destination: a[1], owner: a[2] } };
    if (type === 'initializeAccount') return { type, info: { account: a[0], mint: a[1], owner: a[2] } };
    if ((type === 'initializeAccount2' || type === 'initializeAccount3') && d.length >= 33) return { type, info: { account: a[0], mint: a[1], owner: b58encode(d.subarray(1, 33)) } };
  }
  if (pid === SYS) {
    if (type === 'transfer') return { type, info: { source: a[0], destination: a[1], lamports: at(4) } };
    if (type === 'createAccount') return { type, info: { source: a[0], newAccount: a[1], lamports: at(4) } };
    if (type === 'createAccountWithSeed' && d.length >= 44) return { type, info: { source: a[0], newAccount: a[1], lamports: at(44 + Number(at(36))) } };
  }
  if (pid === ATA && ATA_OK.has(type)) return { type, info: { source: a[0], account: a[1], wallet: a[2], mint: a[3] } };
  return { type, info: { accounts: a } };
}
// every instruction in execution order as {pid, type, info}: top level decoded here, inner ones as the RPC sent them
function instructions(msg, v, keys) {
  const inner = new Map(v.innerInstructions.map((g) => [g.index, g.instructions || []])), out = [];
  const add = (i) => {
    const pid = i.programId ?? keys[i.programIdIndex];
    if (i.parsed && typeof i.parsed === 'object') { out.push({ pid, type: i.parsed.type, info: i.parsed.info || {} }); return; }
    let d = null; try { d = typeof i.data === 'string' ? b58decode(i.data) : null; } catch { /* unreadable: type '?' */ }
    out.push({ pid, ...decode(pid, d, (i.accounts || []).map((x) => (typeof x === 'number' ? keys[x] : x))) });
  };
  msg.compiledInstructions.forEach((ix, n) => {
    const pid = keys[ix.programIdIndex];
    out.push({ pid, ...decode(pid, ix.data, ix.accountKeyIndexes.map((k) => keys[k])) });
    (inner.get(n) || []).forEach(add); inner.delete(n);
  });
  inner.forEach((l) => l.forEach(add)); // (an inner group with no matching top-level index: still checked)
  return out;
}
const mentions = (x, a) => x === a || (!!x && typeof x === 'object' && Object.values(x).some((y) => mentions(y, a)));
// the owner's authority used for something a trade or a transfer never needs
function vet({ pid, type, info }, owner) {
  if (!(pid === SYS || isToken(pid) || pid === ATA || NEVER.has(pid)) || !mentions(info, owner)) return;
  if (NEVER.has(pid)) throw refuse(`it would act on your wallet through ${NEVER.get(pid)}.`);
  if (pid === SYS) { if (!SYS_OK.has(type)) throw refuse(`it would change your wallet account itself (${type}).`); return; }
  if (pid === ATA) { if (!ATA_OK.has(type)) throw refuse(`it would move tokens out of a nested account (${type}).`); return; }
  if (type === 'closeAccount') {
    if ((info.owner ?? info.multisigOwner) === owner && info.destination !== owner) throw refuse('it would close one of your token accounts and send its SOL to another wallet.');
    return;
  }
  if (!TOKEN_OK.has(type)) throw refuse(TOKEN_WHY[type] || `it would use your wallet's authority for a token instruction a trade never needs (${type}).`);
}
const amountOf = (info) => BigInt(String(info.amount ?? info.tokenAmount?.amount ?? info.lamports ?? 0));

// expect → {purpose, spend, recv, max, fee, minRecv} with mints as 'SOL' or an address and amounts as BigInt
const mintOf = (m) => (m === 'SOL' || m === WSOL ? 'SOL' : isMint(m) ? m : null);
const rawOf = (v) => { const s = typeof v === 'bigint' ? v.toString() : String(v ?? ''); return /^\d{1,30}$/.test(s) ? BigInt(s) : null; };
function norm(e) {
  if (!e || typeof e !== 'object') throw refuse('it came without a description of what it may spend.');
  if (!PURPOSES.includes(e.purpose)) throw refuse('its purpose is not one Nought signs for.');
  const spend = mintOf(e.spendMint), recv = e.receiveMint == null ? null : mintOf(e.receiveMint), max = rawOf(e.maxSpendRaw);
  const fee = e.maxFeeLamports == null ? FEE_DEFAULT : Number(e.maxFeeLamports), minRecv = e.minReceiveRaw == null ? null : rawOf(e.minReceiveRaw);
  if (!spend || (e.receiveMint != null && !recv) || max == null || !(fee >= 0) || (e.minReceiveRaw != null && minRecv == null)) throw refuse('its description of what it may spend is not valid.');
  return { purpose: e.purpose, spend, recv, max, fee: BigInt(Math.min(Math.ceil(fee), FEE_MAX)), minRecv };
}

const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const solStr = (l) => { const n = Number(l) / 1e9; return n >= 1 ? n.toFixed(3) : Number(n.toPrecision(3)).toFixed(9).replace(/\.?0+$/, ''); };
const lookupCount = (msg, k) => (msg.addressTableLookups || []).reduce((s, l) => s + (l[k]?.length || 0), 0);
// the simulation carries everything judge() needs (an older RPC may leave some of it out: then the next one is asked)
const complete = (v, msg) => !!v && ['preBalances', 'postBalances', 'preTokenBalances', 'postTokenBalances', 'innerInstructions', 'accounts'].every((k) => Array.isArray(v[k]))
  && (!lookupCount(msg, 'writableIndexes') && !lookupCount(msg, 'readonlyIndexes') || !!v.loadedAddresses);

// a few simulations at a time: a 25-wallet buy would otherwise burst the public RPCs into rate limits
let running = 0;
const waiting = [];
const slot = () => (running < PARALLEL ? (running++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

// resolves when the transaction does only what `expect` allows for `owner`; throws an Error with a reason to show
export async function checkTx(tx, owner, expect) {
  norm(expect); // a bad description fails before any network call
  const msg = tx?.message;
  if (!msg?.staticAccountKeys || !msg.header || !msg.compiledInstructions || typeof tx.serialize !== 'function') throw refuse('it is not a transaction Nought can read.');
  const keys = msg.staticAccountKeys.map(String);
  if (keys[0] !== owner || !(msg.header.numRequiredSignatures >= 1)) throw refuse(`it is paid for by ${short(keys[0])}, not by your wallet.`);
  if (keys.indexOf(owner, 1) !== -1) throw refuse('it lists your wallet twice.');
  const b64 = toB64(tx.serialize());
  await slot();
  let v;
  try {
    const cfg = { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', innerInstructions: true, accounts: { encoding: 'jsonParsed', addresses: [owner] } };
    v = (await rpc('simulateTransaction', [b64, cfg], 1, { until: Date.now() + BUDGET_MS, accept: (r) => !!r?.value?.err || complete(r?.value, msg) }))?.value;
  } catch (e) {
    // invalid params: the RPC can't read the transaction itself (too large, a lookup table that doesn't exist...)
    if (e?.code === -32602) throw refuse(`the RPC rejected it (${e.message}).`);
    throw new Error(BUSY);
  } finally { release(); }
  if (!v) throw new Error(BUSY);
  judge(msg, v, owner, expect);
}

// the verdict on one simulation result (pure: no network, for tests too). Throws refuse(...) or returns true.
export function judge(msg, v, owner, expect) {
  const x = norm(expect);
  if (v.err) throw refuse(`it would fail on-chain right now (${failure(v)}).`);
  if (!complete(v, msg)) throw new Error(BUSY);
  const lw = v.loadedAddresses?.writable || [], lr = v.loadedAddresses?.readonly || [];
  if (lw.length !== lookupCount(msg, 'writableIndexes') || lr.length !== lookupCount(msg, 'readonlyIndexes')) throw new Error(BUSY);
  const keys = [...msg.staticAccountKeys.map(String), ...lw, ...lr];
  if (v.preBalances.length !== keys.length || v.postBalances.length !== keys.length) throw new Error(BUSY);
  const verb = x.purpose === 'transfer' ? 'sending' : 'trading', spendSol = x.spend === 'SOL' ? x.max : 0n;
  const dec = new Map([...v.preTokenBalances, ...v.postTokenBalances].map((t) => [t.mint, t.uiTokenAmount?.decimals]));
  const ui = (raw, mint) => { const d = dec.get(mint) ?? 0; return (Number(raw) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: Math.min(d, 6) }); };

  // the owner's accounts: the wallet, its token accounts before or after, and token accounts it opens in this transaction
  const ixs = instructions(msg, v, keys), own = new Set([owner]), mints = new Map();
  for (const t of [...v.preTokenBalances, ...v.postTokenBalances]) { mints.set(keys[t.accountIndex], t.mint); if (t.owner === owner) own.add(keys[t.accountIndex]); }
  for (const { pid, type, info } of ixs) {
    const opened = isToken(pid) && /^initializeAccount/.test(type) ? info.owner : pid === ATA && ATA_OK.has(type) ? info.wallet : null;
    if (!opened || !info.account) continue;
    if (info.mint) mints.set(info.account, info.mint);
    if (opened === owner) own.add(info.account);
  }
  // 1. every instruction (top level and inner): what the owner's authority is used for, and what it sends elsewhere
  let solOut = 0n;
  const out = new Map();
  for (const op of ixs) {
    vet(op, owner);
    const { pid, type, info } = op;
    if (pid === SYS && SYS_OK.has(type) && info.source === owner && !own.has(info.destination ?? info.newAccount)) solOut += amountOf(info);
    if (isToken(pid) && TOKEN_MOVE.has(type) && info.authority === owner && !own.has(info.destination)) {
      const mint = info.mint ?? mints.get(info.source ?? info.account);
      if (!mint) throw refuse('it would move a token Nought could not identify out of your wallet.');
      if (mint === WSOL) solOut += amountOf(info); else out.set(mint, (out.get(mint) || 0n) + amountOf(info));
    }
  }
  for (const [mint, n] of out) {
    if (mint !== x.spend) throw refuse(`it would send ${ui(n, mint)} of a token you are not ${verb} (${short(mint)}) out of your wallet.`);
    if (n > x.max) throw refuse(`it would send ${ui(n, mint)} ${short(mint)} out of your wallet, more than the ${ui(x.max, mint)} you approved.`);
  }
  if (solOut > spendSol + x.fee) throw refuse(`it would send ${solStr(solOut)} SOL out of your wallet, more than the ${spendSol ? solStr(spendSol) + ' SOL it spends plus ' : ''}${solStr(x.fee)} SOL for fees and rent.`);

  // 2. the wallet account stays a plain system account
  const acct = v.accounts[0];
  if (!acct || acct.owner !== SYS || acct.executable || Number(acct.space || 0) !== 0) throw refuse('it would change who controls your wallet account.');

  // 3. balances after vs before. Token accounts of the owner's keep their owner; no token but the spent one decreases.
  const pre = v.preTokenBalances.filter((t) => t.owner === owner), post = v.postTokenBalances.filter((t) => t.owner === owner);
  const after = new Map(v.postTokenBalances.map((t) => [t.accountIndex, t.owner]));
  if (pre.some((t) => after.has(t.accountIndex) && after.get(t.accountIndex) !== owner)) throw refuse('it would hand one of your token accounts to another wallet.');
  const sums = (l) => l.reduce((m, t) => (t.mint === WSOL ? m : m.set(t.mint, (m.get(t.mint) || 0n) + BigInt(t.uiTokenAmount.amount))), new Map());
  const a = sums(pre), b = sums(post);
  for (const mint of new Set([...a.keys(), ...b.keys()])) {
    const d = (b.get(mint) || 0n) - (a.get(mint) || 0n);
    if (d >= 0n) continue;
    if (mint !== x.spend) throw refuse(`it would take ${ui(-d, mint)} of a token you are not ${verb} (${short(mint)}) from your wallet.`);
    if (-d > x.max) throw refuse(`it would take ${ui(-d, mint)} ${short(mint)} from your wallet, more than the ${ui(x.max, mint)} you approved.`);
  }
  // SOL: the wallet's lamports plus its token accounts' (wrapped SOL, rent). Opening or closing one of its own accounts
  // moves SOL between them and costs nothing here; what may go is the SOL spent plus fees and other accounts' rent.
  const lamports = (bal, l) => l.reduce((s, t) => s + BigInt(bal[t.accountIndex] ?? 0), BigInt(bal[0]));
  const drop = lamports(v.preBalances, pre) - lamports(v.postBalances, post);
  if (drop > spendSol + x.fee) throw refuse(`it would take ${solStr(drop)} SOL from your wallet, more than the ${spendSol ? solStr(spendSol) + ' SOL it spends plus ' : ''}${solStr(x.fee)} SOL for fees.`);

  // 4. a swap delivers what it buys: tokens by their balance, SOL as the change plus the fee and what it sent out
  if (x.purpose === 'swap' && x.recv) {
    const got = x.recv === 'SOL' ? solOut + BigInt(v.fee ?? 0) - drop : (b.get(x.recv) || 0n) - (a.get(x.recv) || 0n);
    const what = x.recv === 'SOL' ? 'SOL' : short(x.recv), fmt = (n) => (x.recv === 'SOL' ? solStr(n) : ui(n, x.recv));
    if (got <= 0n) throw refuse(`it would not deliver any ${what} to your wallet.`);
    if (x.minRecv != null && got < x.minRecv) throw refuse(`it would deliver ${fmt(got)} ${what}, less than the ${fmt(x.minRecv)} ${what} you were quoted.`);
  }
  return true;
}
// a short reason for a failed simulation
function failure(v) {
  const e = JSON.stringify(v.err), logs = (v.logs || []).join('\n');
  if (/InsufficientFundsForFee/.test(e)) return 'not enough SOL for the network fee';
  if (/InsufficientFundsForRent/.test(e)) return v.err.InsufficientFundsForRent?.account_index ? 'an account it pays into would hold less than the minimum balance Solana requires; send a bit more' : 'your wallet would drop below the minimum balance Solana requires';
  if (/insufficient lamports|insufficient funds/i.test(logs)) return 'not enough balance for this amount';
  if (/0x1771|"Custom":6001\b|SlippageToleranceExceeded/.test(e + logs)) return 'the price moved past your slippage';
  return e.length > 140 ? e.slice(0, 140) + '…' : e;
}
