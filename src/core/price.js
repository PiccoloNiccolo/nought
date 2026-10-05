// Prices. SOL in USD from Jupiter (CoinGecko as a fallback), refreshed every 30 s; the last good value is kept in this
// browser so the first paint already has one. Token prices from Jupiter, then Dexscreener for whatever it misses.
import { LS, getJson, emit, sleep } from './util.js';
import { jp, ds } from './jup.js';

const SOL = 'So11111111111111111111111111111111111111112';
// a saved price is only trusted inside a sane range (storage can hold anything)
let price = ((p) => (p > 1 && p < 1e5 ? p : 0))(Number(LS.get('sol', 0))), inflight = null;
export const solUsd = () => price;
async function update() {
  let p = 0;
  try { p = (await jp.prices([SOL])).get(SOL)?.price || 0; } catch { /* try CoinGecko */ }
  if (!(p > 1)) try { p = (await getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd'))?.solana?.usd || 0; } catch { /* keep the last price */ }
  if (p > 1) { const moved = p !== price; price = p; LS.set('sol', price); if (moved) emit('sol', price); }
  return price;
}
// → the SOL price. With a price kept from last time it answers within 2.5 s even when Jupiter is slow (app.js waits
// on this before seeding the board); the update still lands and emits 'sol' when it does.
export function refreshSol() {
  if (!inflight) inflight = update().finally(() => { inflight = null; });
  return price > 0 ? Promise.race([inflight, sleep(2500).then(() => price)]) : inflight;
}
setInterval(() => { if (typeof document === 'undefined' || !document.hidden) refreshSol(); }, 30000);

// USD prices for many mints: Jupiter price/v3 (50 a call), then Dexscreener (30 a call) for the rest.
// Returns Map(mint → {priceUsd, change24h?, liquidity?, src: 'jup' | 'ds', pair?}). Partial results are fine.
// opts: {prio ('high'|'normal'|'low', jup.js queue priority), jupiter: false to go straight to Dexscreener}
export async function pricesFor(mints, { prio = 'normal', jupiter = true } = {}) {
  const out = new Map(), list = [...new Set(mints || [])];
  if (jupiter) try { for (const [m, p] of await jp.prices(list, { prio })) out.set(m, { priceUsd: p.price, change24h: p.change24h, liquidity: p.liquidity, src: 'jup' }); } catch { /* Dexscreener next */ }
  const rest = list.filter((m) => !out.has(m));
  if (rest.length) try { for (const [m, p] of await ds.tokens(rest, { prio })) if (Number(p.priceUsd) > 0) out.set(m, { priceUsd: Number(p.priceUsd), change24h: p.priceChange?.h24, liquidity: p.liquidity?.usd, src: 'ds', pair: p }); } catch { /* partial */ }
  return out;
}
