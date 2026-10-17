// Refreshes data/kol-wallets.json from kolscan.io's public leaderboard (run by pump.fun), where each KOL's wallet is
// listed with their name, X account and profile picture. Nought never guesses who owns a wallet: only wallets a public
// source names are listed. Run `node tools/kols.mjs` before a release; the file is read by the chart and Vision.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://kolscan.io/leaderboard';
const PFP = /^https:\/\/kolscan-images\.pump\.fun\/profiles\/[1-9A-HJ-NP-Za-km-z]{32,44}\/[\w.-]{1,80}$/;
const ROW = /\{"wallet_address":"([1-9A-HJ-NP-Za-km-z]{32,44})","name":"((?:[^"\\]|\\.)*)","pfp":(null|"[^"]*"),"telegram":(?:null|"[^"]*"),"twitter":(null|"[^"]*")/g;

export function parseKols(html) {
  const s = html.replace(/\\"/g, '"'), seen = new Set(), out = [];
  for (const [, address, rawName, pfp, tw] of s.matchAll(ROW)) {
    if (seen.has(address)) continue; seen.add(address);
    let name = ''; try { name = JSON.parse(`"${rawName}"`); } catch { name = rawName; }
    const x = (tw !== 'null' ? tw.slice(1, -1) : '').match(/^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/)?.[1] || '';
    const pic = pfp !== 'null' && PFP.test(pfp.slice(1, -1)) ? pfp.slice(1, -1) : '';
    out.push({ address, name: name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40), x, pfp: pic, tags: ['kolscan'] });
  }
  return out;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = await fetch(SOURCE, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`kolscan answered ${r.status}`);
  const list = parseKols(await r.text());
  if (list.length < 50) throw new Error(`only ${list.length} wallets found: the page layout may have changed, file left as it was`);
  await writeFile(new URL('../data/kol-wallets.json', import.meta.url), JSON.stringify(list, null, 1) + '\n');
  console.log(`data/kol-wallets.json: ${list.length} wallets, ${list.filter((k) => k.x).length} with an X account`);
}
