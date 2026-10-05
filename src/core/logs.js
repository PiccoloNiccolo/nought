// Tracked-wallet trades, live over Solana RPC websockets: logsSubscribe {mentions: [wallet]} per wallet, then
// getTransaction for each successful transaction, decoded into a swap from the wallet's own balance changes.
//
// Websockets checked from headless Chrome (page origin http://nought.test) on 2026-10-04:
//   wss://rpc.solanatracker.io/public          opens; acked 119 of 120 logsSubscribe on ONE socket; notifications flow
//   wss://public.rpc.solanavibestation.com     same: 119 of 120 on one socket
//   wss://solana-rpc.publicnode.com            opens and answers getSlot, but silently ignores most logsSubscribe
//                                              (5 of 60 acked, none for quiet wallets). Last resort with a cap of 5;
//                                              any subscription not acked within ACK_MS moves to another host.
// Live subscriptions are capped at MAX_LIVE and spread over the healthy sockets (failover on close or refusal);
// the remaining wallets, and any live wallet without an acked subscription, are polled every 60 s with
// getSignaturesForAddress (limit 5). Sockets keep running while the tab is hidden; polling pauses.
//
// API
//   watch(list)        [{address, name, emoji, alert, sound}] wallets to follow, in priority order (first MAX_LIVE
//                      go live).
//                      An empty list closes every socket.
//   backfill(addrs, n) decode each wallet's last n transactions (sequential); emitted with backfill: true
//   recentTrades()     this session's decoded trades, newest first (≤ 400)
//   status()           {running, watching, live, pending, polled, queue, decoded, swaps, dropped, lastAt, hosts[]}
//   decodeSwap(tx, wallet)  pure decoder (exported for tests) → null | {side, mint, sol, tokens, dec, pctSold, quote}
//   verifyTrade(t)     → Promise<bool>: re-fetches t.sig from a different RPC host than the one that delivered it (t.host;
//                      two other hosts when unknown) and decodes it again; true only if wallet (a signer), side and
//                      mint match and the SOL amounts agree within 1%. Never throws. Copy trading awaits it first.
// Events (util emit): 'tracker-trade' {wallet, name, emoji, side, mint, sol, tokens, at, sig, quote, pctSold,
//   priceSol, mcUsd, symbol, image, backfill, alert, sound, silent, host (the RPC host that delivered the
//   transaction), slot} and 'tracker-status' (status()). The shell's alerts.js logs every trade in the bell and toasts
//   it unless silent (silent = the wallet's alert switch is off).
import { emit, isMint, sleep } from './util.js';
import { settings, RPCS } from './settings.js';
import { signaturesFor } from './rpc.js';
import { jt } from './jup.js';
import { tokens, upsert } from './store.js';
import { solUsd } from './price.js';

export const MAX_LIVE = 50, POLL_MS = 60000, ACK_MS = 8000;
// [url, max subscriptions on one socket, tier (1 = preferred)]
const HOSTS = [
  ['wss://rpc.solanatracker.io/public', 100, 1],
  ['wss://public.rpc.solanavibestation.com', 100, 1],
  ['wss://solana-rpc.publicnode.com', 5, 2],
];
export const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT' };
// programs that never make a swap on their own: a transaction that only touches these is skipped before getTransaction
const PLAIN = new Set(['11111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo', 'Vote111111111111111111111111111111111111111']);
const hidden = () => typeof document !== 'undefined' && document.hidden;
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

const want = new Map();     // address → {name, emoji, alert, sound}
let liveSet = new Set();    // addresses that should hold a live subscription
const subs = new Map();     // address → {sock, req, id (server subscription), sentAt}
const socks = new Map();    // url → socket record
const tried = new Map();    // address → {at, hosts: Set(url)} hosts that refused or ignored it
let reqSeq = 1, running = false, house = 0, pollTimer = 0, polling = false, pollCursor = 0;
const stats = { decoded: 0, swaps: 0, dropped: 0, skipped: 0, missed: 0, lastAt: 0 };

// ---- hosts and sockets ----
function hostList() {
  const own = /^https:\/\/\S+$/.test(settings.rpc || '') && !RPCS.includes(settings.rpc) ? [['wss://' + settings.rpc.slice(8), 100, 1]] : [];
  return [...own, ...HOSTS];
}
function sockFor(url, cap, tier) {
  let s = socks.get(url);
  if (!s) { s = { url, cap, tier, ws: null, open: false, backoff: 1000, downUntil: 0, last: 0, ping: 0, acks: 0, misses: 0, badUntil: 0, idleSince: 0, reqs: new Map(), ids: new Map() }; socks.set(url, s); }
  return s;
}
// a socket that closes (or never opens) rests for its backoff (1 s → 30 s) before assign() may pick it again
function down(s) { s.downUntil = Date.now() + s.backoff; s.backoff = Math.min(30000, s.backoff * 2); }
function connect(s) {
  if (!running || s.ws) return true;
  let ws;
  try { ws = new WebSocket(s.url); } catch { down(s); return false; }
  s.ws = ws; s.last = Date.now();
  ws.onopen = () => {
    if (s.ws !== ws) return;
    s.open = true; s.backoff = 1000; s.last = Date.now();
    for (const [a, x] of subs) if (x.sock === s) send(a, x);
    changed();
  };
  ws.onmessage = (e) => { if (s.ws === ws) onMsg(s, e.data); };
  ws.onerror = () => { try { ws.close(); } catch { /* closed */ } };
  ws.onclose = (e) => {
    if (s.ws !== ws) return;
    s.ws = null; s.open = false; s.reqs.clear(); s.ids.clear(); down(s);
    s.closed = { at: Date.now(), code: e?.code, why: s.why || '' }; s.why = '';
    for (const [a, x] of subs) if (x.sock === s) subs.delete(a); // failover: assign() moves them to another socket
    assign();
  };
  return true;
}
function closeSock(s) {
  const ws = s.ws; s.ws = null; s.open = false; s.reqs.clear(); s.ids.clear();
  if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; try { ws.close(); } catch { /* closed */ } }
}
const raw = (s, method, params) => { if (s.open && s.ws?.readyState === 1) { const id = reqSeq++; s.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); return id; } return 0; };
const load = (s) => { let n = 0; for (const x of subs.values()) if (x.sock === s) n++; return n; };

function send(a, x) {
  const id = raw(x.sock, 'logsSubscribe', [{ mentions: [a] }, { commitment: 'confirmed' }]);
  if (!id) return;
  x.req = id; x.sentAt = Date.now(); x.sock.reqs.set(id, a);
}
function refuse(a, s) {
  const t = tried.get(a) || { at: Date.now(), hosts: new Set() };
  t.hosts.add(s.url); tried.set(a, t);
  s.misses++;
  if (s.acks === 0 && s.misses >= 3) s.badUntil = Date.now() + 10 * 60e3; // this host ignores subscriptions: rest it
}
// pick a socket for a wallet: the least loaded preferred host that has room and hasn't refused it, else a tier-2 host
function pick(a) {
  const t = tried.get(a), now = Date.now();
  let best = null, bestKey = Infinity;
  for (const [url, cap, tier] of hostList()) {
    const s = sockFor(url, cap, tier);
    if (s.badUntil > now || s.downUntil > now || t?.hosts.has(url)) continue;
    const l = load(s); if (l >= cap) continue;
    const key = tier * 1e6 + l; // tier first, then load (spreads wallets across hosts)
    if (key < bestKey) { best = s; bestKey = key; }
  }
  return best;
}
function assign() {
  if (!running) return;
  for (const a of liveSet) {
    if (subs.has(a)) continue;
    const s = pick(a); if (!s) continue; // nowhere to go: the poller covers it
    const x = { sock: s, req: 0, id: null, sentAt: 0 };
    subs.set(a, x);
    if (s.open) send(a, x); else if (!connect(s)) subs.delete(a);
  }
  changed();
}
function unsub(a) {
  const x = subs.get(a); if (!x) return;
  subs.delete(a);
  if (x.id != null) { x.sock.ids.delete(x.id); raw(x.sock, 'logsUnsubscribe', [x.id]); }
  if (x.req) x.sock.reqs.delete(x.req);
}

function onMsg(s, data) {
  s.last = Date.now();
  let d; try { d = JSON.parse(data); } catch { return; }
  if (d.method === 'logsNotification') {
    const a = s.ids.get(d.params?.subscription), v = d.params?.result?.value;
    if (a && v) onLogs(a, v);
    return;
  }
  if (d.id == null) return;
  const a = s.reqs.get(d.id); if (!a) return; // keepalive replies and the like
  s.reqs.delete(d.id);
  const x = subs.get(a);
  if (d.error || typeof d.result !== 'number') { // refused: try the next host
    refuse(a, s);
    if (x?.sock === s) { subs.delete(a); assign(); }
    return;
  }
  if (!x || x.sock !== s || x.req !== d.id) { raw(s, 'logsUnsubscribe', [d.result]); return; } // late ack for a moved/removed wallet
  x.id = d.result; s.ids.set(d.result, a); s.acks++;
  changed();
}

// every 2 s: ack timeouts, keepalive, stale sockets, idle sockets
function housekeeping() {
  const now = Date.now();
  let moved = false;
  for (const [a, x] of subs) {
    if (x.id == null && x.sock.open && x.sentAt && now - x.sentAt > ACK_MS) { x.sock.reqs.delete(x.req); refuse(a, x.sock); subs.delete(a); moved = true; }
  }
  for (const [a, t] of tried) if (now - t.at > 10 * 60e3) tried.delete(a);
  for (const s of socks.values()) {
    if (!s.ws) continue;
    const n = load(s);
    if (!n) { s.idleSince ||= now; if (now - s.idleSince > 60e3) closeSock(s); continue; }
    s.idleSince = 0;
    if (!s.open) { if (now - s.last > 10e3) { s.why = 'stuck connecting'; try { s.ws.close(); } catch { /* closed */ } } continue; }
    if (now - s.ping > 30e3) { s.ping = now; raw(s, 'getVersion', []); } // all three hosts answer it: proof the socket is alive
    if (now - s.last > 75e3) { s.why = 'silent for 75 s'; try { s.ws.close(); } catch { /* closed */ } }
  }
  if (moved || [...liveSet].some((a) => !subs.has(a))) assign();
}

// ---- notifications → decode queue ----
function looksLikeSwap(logs) {
  if (!Array.isArray(logs) || !logs.length) return true; // unknown: let getTransaction decide
  let any = false;
  for (const l of logs) {
    if (typeof l !== 'string') continue;
    if (/truncated/i.test(l)) return true;
    const m = l.match(/^Program (\w{32,44}) invoke/);
    if (m) { any = true; if (!PLAIN.has(m[1])) return true; }
  }
  return !any;
}
const seen = new Set();
const remember = (sig) => { seen.add(sig); if (seen.size > 5000) { let i = 0; for (const s of seen) { seen.delete(s); if (++i >= 1000) break; } } };
// A wallet that fires constantly (a bot) would flood the queue: each wallet gets at most PER_WALLET decodes a minute.
const PER_WALLET = 12, QUEUE_MAX = 80, WORKERS = 2;
const budget = new Map(); // address → recent decode times
function onLogs(a, v) {
  if (v.err || typeof v.signature !== 'string' || seen.has(v.signature)) return;
  if (!looksLikeSwap(v.logs)) { stats.skipped++; remember(v.signature); return; }
  const now = Date.now(), times = (budget.get(a) || []).filter((t) => now - t < 60e3);
  if (times.length >= PER_WALLET) { budget.set(a, times); stats.dropped++; remember(v.signature); return; }
  times.push(now); budget.set(a, times);
  enqueue(v.signature, a, false);
}
// newest first (a live feed and copy trading care about now); a transaction the RPC has not indexed yet goes back in
// the queue for a retry 2 s later instead of blocking a worker
const queue = [];
let workers = 0;
function enqueue(sig, a, backfill) {
  if (seen.has(sig)) return;
  remember(sig);
  queue.push({ sig, a, backfill, tries: 0, after: 0 });
  if (queue.length > QUEUE_MAX) { stats.dropped += queue.length - QUEUE_MAX; queue.splice(0, queue.length - QUEUE_MAX); }
  work();
}
function next() {
  const now = Date.now();
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].after <= now) return queue.splice(i, 1)[0];
  return null;
}
async function work() {
  if (workers >= WORKERS) return;
  workers++;
  try {
    for (;;) {
      const job = next();
      if (!job) { if (!queue.length) break; await sleep(500); continue; }
      const got = await fetchTx(job.sig).catch(() => null), tx = got?.tx || null;
      if (!tx && ++job.tries < 3) { job.after = Date.now() + 2000; queue.unshift(job); continue; }
      stats.decoded++;
      const d = tx ? decodeSwap(tx, job.a) : null;
      if (!tx) stats.missed++;
      if (d) {
        stats.swaps++;
        out.push({ ...d, wallet: job.a, sig: job.sig, at: tx.blockTime ? tx.blockTime * 1000 : Date.now(), backfill: job.backfill || undefined, host: got.host, slot: Number(tx.slot) || undefined });
        flushSoon();
      }
      changed();
      await sleep(250);
    }
  } finally { workers--; }
  if (queue.length) work();
}

// ---- getTransaction, one host at a time, so every trade knows which RPC delivered it (verifyTrade asks another) ----
const TX_OPTS = { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' };
// host → url: the user's RPC first, then the public ones (https only, one url per host)
function httpHosts() {
  const out = new Map();
  for (const u of [settings.rpc, ...RPCS]) if (/^https:\/\/\S+$/.test(u || '') && !out.has(hostOf(u))) out.set(hostOf(u), u);
  return out;
}
const txCool = new Map(); // host → when it may be asked again
async function txAt(url, sig, ms = 12000) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, TX_OPTS] }), signal: AbortSignal.timeout(ms) }); }
  catch { throw Object.assign(new Error(`${hostOf(url)} did not answer`), { coolMs: 10000 }); } // (a 429 without CORS lands here too)
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  if (r.status === 429 || !r.ok || !j || j.error) throw Object.assign(new Error(String(j?.error?.message || r.status)), { coolMs: r.status === 429 ? (Number(r.headers.get('retry-after')) || 5) * 1000 : 5000 });
  return j.result ?? null;
}
// {tx (null = not indexed yet), host} from the first host that answers; null when none did
async function fetchTx(sig) {
  for (const [host, url] of httpHosts()) {
    if ((txCool.get(host) || 0) > Date.now()) continue;
    try { return { tx: await txAt(url, sig), host }; } catch (e) { txCool.set(host, Date.now() + (e.coolMs || 5000)); }
  }
  return null;
}

// ---- verifyTrade: copy trading never spends money on one RPC's word ----
const verified = new Map(); // key → Promise<bool> (a trade is checked once, however many copy rules ask)
export function verifyTrade(t) {
  const key = [t?.sig, t?.wallet, t?.side, t?.mint, t?.sol, t?.host].join('|');
  let p = verified.get(key);
  if (!p) {
    p = verifyOnce(t).catch(() => false);
    verified.set(key, p);
    p.then((ok) => { if (!ok && verified.get(key) === p) verified.delete(key); }); // a "no" may be a passing hiccup: ask again next time
    if (verified.size > 300) verified.delete(verified.keys().next().value);
  }
  return p;
}
async function verifyOnce(t) {
  if (!t || typeof t !== 'object' || !SIG_RE.test(t.sig) || !isMint(t.wallet) || !isMint(t.mint) || (t.side !== 'buy' && t.side !== 'sell') || !(Number(t.sol) > 0)) return false;
  const others = [...httpHosts()].filter(([h]) => h !== t.host).sort(([a], [b]) => (txCool.get(a) || 0) - (txCool.get(b) || 0));
  const need = typeof t.host === 'string' && t.host ? 1 : 2;
  if (others.length < need) return false;
  let agree = 0;
  for (const [, url] of others) {
    for (let i = 0; i < 3; i++) { // a host a slot or two behind may not have indexed it yet
      let tx; try { tx = await txAt(url, t.sig, 8000); } catch { break; } // this host can't answer: try the next one
      if (!tx) { await sleep(1500); continue; }
      if (!sameTrade(tx, t)) return false; // a host that tells a different story: fail closed
      agree++; break;
    }
    if (agree >= need) return true;
  }
  return false;
}
function sameTrade(tx, t) {
  const sigs = tx?.transaction?.signatures, keys = tx?.transaction?.message?.accountKeys;
  if (!Array.isArray(sigs) || !sigs.includes(t.sig) || !Array.isArray(keys)) return false;
  if (!keys.some((k) => k && typeof k === 'object' && k.pubkey === t.wallet && k.signer === true)) return false; // the wallet itself signed
  if (Number(t.at) > 0 && Number(tx.blockTime) > 0 && Math.abs(tx.blockTime * 1000 - Number(t.at)) > 60e3) return false;
  const d = decodeSwap(tx, t.wallet), sol = Number(t.sol);
  return !!d && d.side === t.side && d.mint === t.mint && Math.abs(d.sol - sol) <= 0.01 * Math.max(d.sol, sol);
}

// ---- decoding ----
const keyOf = (k) => (typeof k === 'string' ? k : k?.pubkey);
// A swap, from the wallet's point of view: exactly one non-SOL, non-stable token changed for accounts the wallet owns,
// and SOL (native + wrapped, fee added back when the wallet paid it) or one stablecoin moved the other way.
export function decodeSwap(tx, wallet) {
  const m = tx?.meta;
  if (!m || m.err || !isMint(wallet)) return null;
  const keys = (tx.transaction?.message?.accountKeys || []).map(keyOf);
  if (keys.length < (m.preBalances || []).length && m.loadedAddresses) keys.push(...(m.loadedAddresses.writable || []), ...(m.loadedAddresses.readonly || []));
  const i = keys.indexOf(wallet);
  let lamports = 0;
  if (i >= 0) { lamports = (Number(m.postBalances?.[i]) || 0) - (Number(m.preBalances?.[i]) || 0); if (i === 0) lamports += Number(m.fee) || 0; }
  const delta = new Map(); // mint → {raw (BigInt), pre (BigInt), dec}
  let bad = false; // a balance of the wallet's that can't be read: no guessing
  const add = (b, sign) => {
    if (b?.owner !== wallet) return;
    const dec = Number(b.uiTokenAmount?.decimals ?? 0);
    if (!isMint(b.mint) || !Number.isInteger(dec) || dec < 0 || dec > 19) { bad = true; return; }
    let amt; try { amt = BigInt(b.uiTokenAmount?.amount || '0'); } catch { bad = true; return; }
    const d = delta.get(b.mint) || { raw: 0n, pre: 0n, dec };
    d.raw += sign > 0 ? amt : -amt; if (sign < 0) d.pre += amt;
    delta.set(b.mint, d);
  };
  for (const b of m.preTokenBalances || []) add(b, -1);
  for (const b of m.postTokenBalances || []) add(b, 1);
  if (bad) return null;
  let solChange = lamports / 1e9;
  const w = delta.get(WSOL); if (w) { solChange += Number(w.raw) / 1e9; delta.delete(WSOL); }
  const changedMints = [...delta].filter(([, d]) => d.raw !== 0n);
  const others = changedMints.filter(([k]) => !STABLES[k]), stables = changedMints.filter(([k]) => STABLES[k]);
  if (others.length !== 1) return null;
  const [mint, tk] = others[0], tokUi = Number(tk.raw) / 10 ** tk.dec;
  if (!isMint(mint)) return null;
  let counter = solChange, quote = 'SOL';
  if (stables.length === 1 && Math.abs(solChange) < 0.01) {
    const [sm, sd] = stables[0], px = solUsd();
    if (!(px > 0)) return null;
    counter = Number(sd.raw) / 10 ** sd.dec / px; quote = STABLES[sm];
  } else if (stables.length) return null;
  const side = tokUi > 0 && counter < 0 ? 'buy' : tokUi < 0 && counter > 0 ? 'sell' : null;
  if (!side || Math.abs(counter) < 0.0005) return null; // transfers, airdrops, dust
  const pctSold = side === 'sell' && tk.pre > 0n ? Math.min(100, (Number(-tk.raw) / Number(tk.pre)) * 100) : undefined;
  return { side, mint, sol: Math.abs(counter), tokens: Math.abs(tokUi), dec: tk.dec, pctSold, quote };
}

// ---- enrichment and events ----
const out = [], recent = [], metaTried = new Map();
let flushTimer = 0, flushing = false;
function flushSoon() { if (!flushTimer) flushTimer = setTimeout(flush, 600); }
async function flush() {
  flushTimer = 0;
  if (flushing) { flushSoon(); return; }
  flushing = true;
  try {
    const batch = out.splice(0);
    const need = [...new Set(batch.map((t) => t.mint))].filter((mt) => isMint(mt) && !tokens.get(mt)?.symbol && !(Date.now() - (metaTried.get(mt) || 0) < 300e3));
    if (need.length) {
      // names and supply help the first render, but never hold a trade back more than 1.5 s (pages re-render on 'tokens')
      need.forEach((mt) => metaTried.set(mt, Date.now()));
      const look = jt.search(need, { prio: 'low' }).then((list) => { for (const t of list) upsert(t.mint, t); fill(need); }).catch(() => { /* names fill in later */ });
      await Promise.race([look, sleep(1500)]);
    }
    const su = solUsd();
    for (const t of batch.sort((a, b) => a.at - b.at)) {
      if (!isMint(t.mint) || !isMint(t.wallet) || !SIG_RE.test(t.sig)) continue;
      const tk = tokens.get(t.mint), meta = want.get(t.wallet) || {};
      if (tk && tk.decimals == null && Number.isInteger(t.dec)) tk.decimals = t.dec;
      const priceSol = t.tokens > 0 ? t.sol / t.tokens : 0, supply = tk?.circSupply || tk?.totalSupply;
      const ev = {
        wallet: t.wallet, name: meta.name || '', emoji: meta.emoji || '', side: t.side, mint: t.mint, sol: t.sol, tokens: t.tokens, at: t.at, sig: t.sig,
        quote: t.quote, pctSold: t.pctSold, priceSol, mcUsd: supply && su > 0 ? priceSol * su * supply : undefined,
        symbol: tk?.symbol, image: tk?.image, backfill: t.backfill, host: t.host, slot: t.slot,
        alert: !!meta.alert, sound: !!meta.sound, silent: !meta.alert, // alerts.js toasts only when silent is false
      };
      if (!recent.some((r) => r.sig === ev.sig && r.wallet === ev.wallet)) { recent.unshift(ev); if (recent.length > 400) recent.length = 400; }
      stats.lastAt = Math.max(stats.lastAt, ev.at);
      emit('tracker-trade', ev);
    }
    recent.sort((a, b) => b.at - a.at);
  } finally { flushing = false; }
}
// late names / market caps for trades emitted before their token lookup came back
function fill(mints) {
  const su = solUsd(), set = new Set(mints);
  for (const ev of recent) {
    if (!set.has(ev.mint)) continue;
    const tk = tokens.get(ev.mint); if (!tk) continue;
    ev.symbol ||= tk.symbol; ev.image ||= tk.image;
    const supply = tk.circSupply || tk.totalSupply;
    if (!(ev.mcUsd > 0) && supply && su > 0 && ev.priceSol > 0) ev.mcUsd = ev.priceSol * su * supply;
  }
}
export const recentTrades = () => recent.slice();

// ---- polling for wallets without a live subscription ----
const polled = new Map(); // address → last signature seen
async function pollTick() {
  if (!running || polling || hidden()) return;
  const list = [...want.keys()].filter((a) => subs.get(a)?.id == null);
  if (!list.length) return;
  polling = true;
  try {
    const n = Math.min(list.length, 40); // ≤ 40 wallets a minute, ~1 RPC call every 0.4 s
    for (let k = 0; k < n && running; k++) {
      const a = list[(pollCursor + k) % list.length];
      try {
        const sigs = (await signaturesFor(a, 5)) || [];
        const last = polled.get(a);
        if (sigs[0]?.signature) polled.set(a, sigs[0].signature);
        if (last !== undefined) {
          const fresh = [];
          for (const s of sigs) { if (s.signature === last) break; if (!s.err) fresh.push(s.signature); }
          fresh.reverse().forEach((sig) => enqueue(sig, a, false));
        } else if (!sigs.length) polled.set(a, null);
      } catch { /* next round */ }
      await sleep(400);
    }
    pollCursor = (pollCursor + n) % list.length;
  } finally { polling = false; }
}

// ---- public API ----
export function watch(list) {
  want.clear();
  for (const w of list || []) if (isMint(w?.address) && !want.has(w.address)) want.set(w.address, { name: String(w.name || '').slice(0, 40), emoji: String(w.emoji || '').slice(0, 8), alert: !!w.alert, sound: !!w.sound });
  const next = new Set([...want.keys()].slice(0, MAX_LIVE));
  for (const a of [...subs.keys()]) if (!next.has(a)) unsub(a);
  liveSet = next;
  for (const a of [...polled.keys()]) if (!want.has(a)) polled.delete(a);
  if (want.size && !running) start();
  else if (!want.size && running) stop();
  else assign();
  changed();
}
function start() {
  running = true;
  house = setInterval(housekeeping, 2000);
  pollTimer = setInterval(pollTick, POLL_MS);
  setTimeout(pollTick, 15000); // first pass once sockets had a chance to ack
  assign();
}
export function stop() {
  running = false;
  clearInterval(house); clearInterval(pollTimer);
  for (const s of socks.values()) closeSock(s);
  subs.clear(); liveSet = new Set();
  changed();
}
export async function backfill(addrs, n = 3) {
  for (const a of (addrs || []).filter(isMint).slice(0, 25)) {
    try { const sigs = (await signaturesFor(a, Math.min(10, n))) || []; sigs.filter((s) => !s.err).reverse().forEach((s) => enqueue(s.signature, a, true)); } catch { /* skip this wallet */ }
    work();
    await sleep(350);
  }
}
export function status() {
  let live = 0, pending = 0;
  for (const x of subs.values()) x.id != null ? live++ : pending++;
  const hosts = [...socks.values()].map((s) => {
    let n = 0; for (const x of subs.values()) if (x.sock === s && x.id != null) n++;
    return { url: s.url, host: hostOf(s.url), open: s.open, subs: n, bad: s.badUntil > Date.now(), closed: s.closed || null };
  });
  return { running, watching: want.size, live, pending, polled: Math.max(0, want.size - live), queue: queue.length, ...stats, hosts };
}
let stTimer = 0;
function changed() { if (!stTimer) stTimer = setTimeout(() => { stTimer = 0; emit('tracker-status', status()); }, 400); }
