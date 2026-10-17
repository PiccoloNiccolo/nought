// Direct pump.fun trades, with no aggregator in between (no Jupiter quote, no Jupiter rate limit, no third-party fee):
// coins still on the bonding curve trade through pump.fun's own program with buy_exact_quote_in_v3 / sell_v3
// (pump-fun/pump-public-docs, docs/instructions/TRADE_V3.md: 17 accounts, the same for every coin; the SOL spent
// includes pump.fun's protocol and creator fee). Quotes come from the curve account itself (one RPC read), so they
// are instant. Coins that migrated trade on their canonical PumpSwap pool the same way (buy_exact_quote_in_v2 /
// sell_v2, docs/instructions/PUMP_SWAP_TRADE_V2.md), wrapping and unwrapping SOL in the same transaction. Cashback
// coins and coins paired with anything but SOL go through Jupiter as before.
// The transaction is signed and sent like any other (wallet.js: a Nought wallet checks it with txcheck first).
import { rpc } from './rpc.js';

export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const AMM_GLOBAL = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw', AMM_FEE_CONFIG = '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx';
// PumpSwap: LP 20 bps + protocol 5 bps + creator fee; estimated for quotes, the minimum covers the rest
export const AMM_FEE_BPS_ESTIMATE = 40n;
const FEE_CONFIG = '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt';
const WSOL = 'So11111111111111111111111111111111111111112', SYS = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', CB = 'ComputeBudget111111111111111111111111111111';
// docs/FEE_RECIPIENTS.md: any of these takes the buyback part of the fee (SOL-paired coins pass the wallet itself)
const BUYBACK = ['5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7', 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR', '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL', '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'];
const DISC = { buyIn: [225, 247, 80, 30, 213, 179, 132, 136], sell: [28, 146, 222, 119, 38, 196, 105, 213], ammBuyIn: [194, 171, 28, 70, 104, 77, 91, 47], ammSell: [93, 246, 130, 60, 231, 233, 64, 178] };
const POOL_DISC = [241, 154, 109, 4, 17, 177, 109, 188];
// protocol + creator fee used to estimate what a trade returns (the real figure depends on the coin's fee tier; the
// slippage minimum covers the difference, and the program charges the real fee)
export const FEE_BPS_ESTIMATE = 125n;
const CU_LIMIT = 160000;

const W = () => { if (!globalThis.solanaWeb3) throw new Error('Solana library did not load. Reload the page.'); return globalThis.solanaWeb3; };
const pk = (s) => new (W().PublicKey)(s);
const pda = (seeds, program) => W().PublicKey.findProgramAddressSync(seeds, pk(program))[0];
const enc = (s) => new TextEncoder().encode(s);
const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b58 = (bytes) => new (W().PublicKey)(bytes).toBase58();
export const ata = (owner, mint, tokenProgram) => pda([pk(owner).toBytes(), pk(tokenProgram).toBytes(), pk(mint).toBytes()], ATA_PROGRAM).toBase58();

// BondingCurve (idl/pump.json): disc(8) virtual_token u64, virtual_quote u64, real_token u64, real_quote u64, supply u64,
// complete bool, creator pubkey, is_mayhem bool, is_cashback bool, quote_mint pubkey, ... (older curves are shorter)
export function decodeCurve(bytes) {
  if (!bytes || bytes.length < 81) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), r = (o) => v.getBigUint64(o, true);
  return {
    virtualToken: r(8), virtualQuote: r(16), realToken: r(24), realQuote: r(32), supply: r(40), complete: bytes[48] === 1,
    creator: b58(bytes.subarray(49, 81)), mayhem: bytes.length > 81 && bytes[81] === 1, cashback: bytes.length > 82 && bytes[82] === 1,
    quoteMint: bytes.length >= 115 ? b58(bytes.subarray(83, 115)) : WSOL,
  };
}
// tokens out for lamports in (fees included in the lamports), capped at what the curve still sells
export function curveBuyOut(c, lamportsIn, feeBps = FEE_BPS_ESTIMATE) {
  const inNet = (BigInt(lamportsIn) * 10000n) / (10000n + feeBps);
  if (inNet <= 0n || c.virtualQuote <= 0n) return 0n;
  const out = (c.virtualToken * inNet) / (c.virtualQuote + inNet);
  return out > c.realToken ? c.realToken : out;
}
// lamports out (after fees) for tokens in
export function curveSellOut(c, tokensIn, feeBps = FEE_BPS_ESTIMATE) {
  const t = BigInt(tokensIn); if (t <= 0n) return 0n;
  const gross = (c.virtualQuote * t) / (c.virtualToken + t);
  return (gross * (10000n - feeBps)) / 10000n;
}

const curveCache = new Map(); // mint → {at, c, tokenProgram}
// The coin's curve and token program in one RPC call. → null when the coin can't be traded here (migrated, unusual).
export async function pumpCurve(mint, maxAgeMs = 1500) {
  const hit = curveCache.get(mint); if (hit && Date.now() - hit.at < maxAgeMs) return hit.v;
  const curve = pda([enc('bonding-curve'), pk(mint).toBytes()], PUMP_PROGRAM).toBase58();
  const r = await rpc('getMultipleAccounts', [[curve, mint], { encoding: 'base64', commitment: 'processed' }]);
  const [ca, ma] = r?.value || [];
  let v = null;
  if (ca?.owner === PUMP_PROGRAM && Array.isArray(ca.data)) {
    const c = decodeCurve(b64(ca.data[0])), tokenProgram = ma?.owner;
    // SOL-paired curves store the quote mint as wrapped SOL or as the empty key
    if (c && !c.complete && !c.cashback && (c.quoteMint === WSOL || c.quoteMint === SYS) && (tokenProgram === TOKEN || tokenProgram === TOKEN22)) v = { c, curve, tokenProgram };
  }
  curveCache.set(mint, { at: Date.now(), v });
  if (curveCache.size > 200) curveCache.delete(curveCache.keys().next().value);
  return v;
}

// The coin's canonical PumpSwap pool (index 0, created by migration): its vaults and reserves. → null when there is
// none, it is a cashback pool (v2 trades refuse those) or it is not paired with SOL.
const poolCache = new Map(); // mint → {at, v} (vault addresses are fixed; reserves are re-read each time)
const i128 = (b, o) => { const v = new DataView(b.buffer, b.byteOffset, b.byteLength); const lo = v.getBigUint64(o, true), hi = v.getBigInt64(o + 8, true); return (hi << 64n) + lo; };
export async function pumpPool(mint, maxAgeMs = 1500) {
  const hit = poolCache.get(mint); if (hit && Date.now() - hit.at < maxAgeMs) return hit.v;
  let v = null;
  const authority = pda([enc('pool-authority'), pk(mint).toBytes()], PUMP_PROGRAM);
  const idx = new Uint8Array(2); // u16 index 0
  const pool = pda([enc('pool'), idx, authority.toBytes(), pk(mint).toBytes(), pk(WSOL).toBytes()], PUMP_AMM).toBase58();
  const r = await rpc('getMultipleAccounts', [[pool, mint], { encoding: 'base64', commitment: 'processed' }]);
  const [pa, ma] = r?.value || [];
  if (pa?.owner === PUMP_AMM && Array.isArray(pa.data) && (ma?.owner === TOKEN || ma?.owner === TOKEN22)) {
    const b = b64(pa.data[0]);
    if (b.length >= 245 && POOL_DISC.every((x, i) => b[i] === x) && b58(b.subarray(43, 75)) === mint && b58(b.subarray(75, 107)) === WSOL && b[244] !== 1) {
      const baseVault = b58(b.subarray(139, 171)), quoteVault = b58(b.subarray(171, 203)), virtualQuote = b.length >= 261 ? i128(b, 245) : 0n;
      const vr = await rpc('getMultipleAccounts', [[baseVault, quoteVault], { encoding: 'jsonParsed', commitment: 'processed' }]);
      const [bv, qv] = vr?.value || [], base = BigInt(bv?.data?.parsed?.info?.tokenAmount?.amount ?? -1), quote = BigInt(qv?.data?.parsed?.info?.tokenAmount?.amount ?? -1);
      if (base > 0n && quote >= 0n && quote + virtualQuote > 0n) v = { pool, baseVault, quoteVault, base, quote: quote + virtualQuote, tokenProgram: ma.owner };
    }
  }
  poolCache.set(mint, { at: Date.now(), v });
  if (poolCache.size > 200) poolCache.delete(poolCache.keys().next().value);
  return v;
}
// constant product on the pool with the fee taken from the quote side (estimate)
export function poolBuyOut(p, lamportsIn, feeBps = AMM_FEE_BPS_ESTIMATE) { const net = (BigInt(lamportsIn) * 10000n) / (10000n + feeBps); return net > 0n ? (p.base * net) / (p.quote + net) : 0n; }
export function poolSellOut(p, tokensIn, feeBps = AMM_FEE_BPS_ESTIMATE) { const t = BigInt(tokensIn); if (t <= 0n) return 0n; return ((p.quote * t) / (p.base + t) * (10000n - feeBps)) / 10000n; }

// A quote in the shape the trade panel reads from Jupiter ({inAmount, outAmount, otherAmountThreshold, ...}).
export async function pumpQuote(side, mint, amountRaw, slippagePct) {
  const p = await pumpCurve(mint), pool = p ? null : await pumpPool(mint);
  if (!p && !pool) return null;
  const inRaw = BigInt(amountRaw), out = p ? (side === 'buy' ? curveBuyOut(p.c, inRaw) : curveSellOut(p.c, inRaw)) : side === 'buy' ? poolBuyOut(pool, inRaw) : poolSellOut(pool, inRaw);
  if (out <= 0n) return null;
  const bps = BigInt(Math.max(0, Math.min(9900, Math.round((Number(slippagePct) || 0) * 100))));
  // price impact: how far this trade moves the curve (or pool) price
  const spot = p ? Number(p.c.virtualQuote) / Number(p.c.virtualToken) : Number(pool.quote) / Number(pool.base), exec = side === 'buy' ? Number(inRaw) / Number(out) : Number(out) / Number(inRaw);
  const impact = spot > 0 ? Math.max(0, side === 'buy' ? exec / spot - 1 : 1 - exec / spot) * 100 : 0;
  return {
    pumpDirect: true, side, inputMint: side === 'buy' ? WSOL : mint, outputMint: side === 'buy' ? mint : WSOL,
    inAmount: inRaw.toString(), outAmount: out.toString(), otherAmountThreshold: ((out * (10000n - bps)) / 10000n).toString(),
    slippageBps: Number(bps), priceImpactPct: String(impact / 100), swapMode: 'ExactIn', routePlan: [{ swapInfo: { label: p ? 'Pump.fun' : 'PumpSwap' }, percent: 100 }], tokenProgram: (p || pool).tokenProgram, amm: !p,
  };
}

const ixOf = (programId, keys, data) => new (W().TransactionInstruction)({ programId: pk(programId), keys: keys.map(([k, w, s]) => ({ pubkey: pk(k), isWritable: !!w, isSigner: !!s })), data });
// The trade transaction for a quote from pumpQuote(): compute budget, the buyer's token account (idempotent), the trade.
export async function pumpTx(q, owner, prioLamports) {
  if (q.amm) return ammTx(q, owner, prioLamports);
  const p = await pumpCurve(q.side === 'buy' ? q.outputMint : q.inputMint, 0); if (!p) throw new Error('This coin left the bonding curve. Trading it through Jupiter.');
  const mint = q.side === 'buy' ? q.outputMint : q.inputMint, tp = p.tokenProgram;
  const userAta = ata(owner, mint, tp), curveAta = ata(p.curve, mint, tp);
  const keys = [
    [pda([enc('global')], PUMP_PROGRAM).toBase58()], [mint], [WSOL], [tp], [TOKEN],
    [p.curve, 1], [curveAta, 1], [ata(p.curve, WSOL, TOKEN), 1],
    [owner, 1, 1], [userAta, 1], [ata(owner, WSOL, TOKEN), 1],
    [pda([enc('user_volume_accumulator'), pk(owner).toBytes()], PUMP_PROGRAM).toBase58(), 1], [FEE_CONFIG],
    [BUYBACK[Math.floor(Math.random() * BUYBACK.length)], 1], [SYS], [pda([enc('__event_authority')], PUMP_PROGRAM).toBase58()], [PUMP_PROGRAM],
  ];
  const data = q.side === 'buy'
    ? cat(Uint8Array.from(DISC.buyIn), u64(q.inAmount), u64(q.otherAmountThreshold), Uint8Array.of(0))
    : cat(Uint8Array.from(DISC.sell), u64(q.inAmount), u64(q.otherAmountThreshold));
  const micro = Math.max(1, Math.floor((Number(prioLamports) || 0) * 1e6 / CU_LIMIT));
  const ixs = [ixOf(CB, [], cat(Uint8Array.of(2), u32(CU_LIMIT))), ixOf(CB, [], cat(Uint8Array.of(3), u64(micro)))];
  if (q.side === 'buy') ixs.push(ixOf(ATA_PROGRAM, [[owner, 1, 1], [userAta, 1], [owner], [mint], [SYS], [tp]], Uint8Array.of(1)));
  ixs.push(ixOf(PUMP_PROGRAM, keys, data));
  const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const msg = new (W().TransactionMessage)({ payerKey: pk(owner), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return { tx: new (W().VersionedTransaction)(msg), blockhash, lastValidBlockHeight };
}
// PumpSwap pool trade. SOL pools trade wrapped SOL: a buy wraps the SOL it spends into the owner's wrapped-SOL account
// first, and both sides close that account at the end so the SOL comes back unwrapped.
async function ammTx(q, owner, prioLamports) {
  const mint = q.side === 'buy' ? q.outputMint : q.inputMint, pool = await pumpPool(mint, 0);
  if (!pool) throw new Error('This coin has no PumpSwap pool Nought can trade directly. Trading it through Jupiter.');
  const tp = pool.tokenProgram, userBase = ata(owner, mint, tp), userWsol = ata(owner, WSOL, TOKEN);
  const keys = [
    [pool.pool, 1], [owner, 1, 1], [AMM_GLOBAL], [mint], [WSOL], [userBase, 1], [userWsol, 1], [pool.baseVault, 1], [pool.quoteVault, 1], [tp], [TOKEN], [SYS],
    [pda([enc('user_volume_accumulator'), pk(owner).toBytes()], PUMP_AMM).toBase58(), 1], [AMM_FEE_CONFIG],
    [ata(BUYBACK[Math.floor(Math.random() * BUYBACK.length)], WSOL, TOKEN), 1], [pda([enc('__event_authority')], PUMP_AMM).toBase58()], [PUMP_AMM],
  ];
  const micro = Math.max(1, Math.floor((Number(prioLamports) || 0) * 1e6 / CU_LIMIT));
  const ixs = [ixOf(CB, [], cat(Uint8Array.of(2), u32(CU_LIMIT))), ixOf(CB, [], cat(Uint8Array.of(3), u64(micro)))];
  const createAta = (a, m, prog) => ixOf(ATA_PROGRAM, [[owner, 1, 1], [a, 1], [owner], [m], [SYS], [prog]], Uint8Array.of(1));
  ixs.push(createAta(userWsol, WSOL, TOKEN));
  if (q.side === 'buy') {
    ixs.push(createAta(userBase, mint, tp));
    // wrap: move the SOL into the wrapped-SOL account and sync its token balance
    ixs.push(ixOf(SYS, [[owner, 1, 1], [userWsol, 1]], cat(u32(2), u64(q.inAmount))));
    ixs.push(ixOf(TOKEN, [[userWsol, 1]], Uint8Array.of(17)));
    ixs.push(ixOf(PUMP_AMM, keys, cat(Uint8Array.from(DISC.ammBuyIn), u64(q.inAmount), u64(q.otherAmountThreshold))));
  } else {
    ixs.push(ixOf(PUMP_AMM, keys, cat(Uint8Array.from(DISC.ammSell), u64(q.inAmount), u64(q.otherAmountThreshold))));
  }
  // unwrap: close the wrapped-SOL account back into the wallet
  ixs.push(ixOf(TOKEN, [[userWsol, 1], [owner, 1], [owner, 0, 1]], Uint8Array.of(9)));
  const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const msg = new (W().TransactionMessage)({ payerKey: pk(owner), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  return { tx: new (W().VersionedTransaction)(msg), blockhash, lastValidBlockHeight };
}
