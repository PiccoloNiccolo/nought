// Metadata URIs read from the chain, for coins whose feed entry carries no picture and no URI (Jupiter often lists a
// brand-new pump.fun coin before it has an icon, or only with a gmgn.ai icon that refuses other sites). Token-2022
// mints keep their URI in the mint's own tokenMetadata extension; classic SPL mints keep it in the Metaplex metadata
// account. Lookups are batched (10 mints per getMultipleAccounts, the public-RPC limit), one batch in flight, and each
// mint is asked at most once a minute. A found URI goes through upsert(), which wakes the image and metadata queues.
import { rpc, TOKEN_PROGRAM, TOKEN_2022 } from './rpc.js';
import { tokens, upsert } from './store.js';
import { wantMeta } from './meta.js';

export const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bcd8kcrTd';
const BATCH = 10, RETRY = 60000, NONE = 600000;
const queue = new Set(), asked = new Map();
let busy = false, timer = 0;
const hidden = () => typeof document !== 'undefined' && document.hidden;

// Metaplex metadata account: key(1) update authority(32) mint(32) then name, symbol, uri as u32-length strings.
export function metaplexUri(bytes) {
  if (!ArrayBuffer.isView(bytes) || bytes.length < 69 || bytes[0] !== 4) return '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 65;
  for (let field = 0; field < 3; field++) {
    if (at + 4 > bytes.length) return '';
    const len = view.getUint32(at, true); at += 4;
    if (len > 512 || at + len > bytes.length) return '';
    if (field === 2) return new TextDecoder().decode(bytes.subarray(at, at + len)).replace(/\0+$/, '').trim();
    at += len;
  }
  return '';
}
const b64 = (s) => { try { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); } catch { return null; } };
const cleanUri = (u) => (typeof u === 'string' && u.length <= 500 && /^(https?|ipfs|ar):\/\//i.test(u.trim()) ? u.trim() : '');

function found(mint, uri) {
  asked.set(mint, Date.now() + (uri ? NONE : RETRY));
  const t = tokens.get(mint);
  if (!uri || !t || t.uri) return;
  wantMeta(upsert(mint, { uri }), { priority: true });
}
async function lookup(mints) {
  const res = await rpc('getMultipleAccounts', [mints, { encoding: 'jsonParsed' }], 1);
  const classic = [];
  (res?.value || []).forEach((account, i) => {
    const mint = mints[i];
    if (account?.owner === TOKEN_2022) {
      const ext = account.data?.parsed?.info?.extensions;
      const md = Array.isArray(ext) ? ext.find((e) => e?.extension === 'tokenMetadata')?.state : null;
      found(mint, cleanUri(md?.uri));
    } else if (account?.owner === TOKEN_PROGRAM && globalThis.solanaWeb3?.PublicKey) classic.push(mint);
    else found(mint, '');
  });
  if (!classic.length) return;
  const P = globalThis.solanaWeb3.PublicKey, program = new P(METAPLEX), seed = new TextEncoder().encode('metadata');
  const pdas = classic.map((m) => P.findProgramAddressSync([seed, program.toBytes(), new P(m).toBytes()], program)[0].toBase58());
  const meta = await rpc('getMultipleAccounts', [pdas, { encoding: 'base64' }], 1);
  (meta?.value || []).forEach((account, i) => {
    const raw = account?.owner === METAPLEX && Array.isArray(account.data) ? b64(account.data[0]) : null;
    found(classic[i], raw ? cleanUri(metaplexUri(raw)) : '');
  });
}
async function drain() {
  timer = 0;
  if (busy || hidden() || !queue.size) return;
  busy = true;
  const batch = [...queue].slice(0, BATCH); batch.forEach((m) => queue.delete(m));
  try { await lookup(batch); }
  catch { batch.forEach((m) => asked.set(m, Date.now() + RETRY)); }
  finally { busy = false; if (queue.size) schedule(); }
}
const schedule = () => { if (!timer) timer = setTimeout(drain, 400); };

// Ask the chain for a coin's metadata URI. No-op when the coin already has one or was asked recently.
export function wantUri(mint) {
  const t = tokens.get(mint);
  if (!t || t.uri || (asked.get(mint) || 0) > Date.now()) return;
  asked.set(mint, Infinity);
  if (asked.size > 5000) for (const [m, until] of asked) { if (until !== Infinity && until < Date.now()) asked.delete(m); }
  queue.add(mint);
  if (queue.size > 120) { const old = queue.values().next().value; queue.delete(old); asked.delete(old); }
  schedule();
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!hidden() && queue.size) schedule(); });
