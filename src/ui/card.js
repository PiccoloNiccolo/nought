// The token row used on Pulse, Watchlist and anywhere a coin is listed. Pure HTML strings; clicks go through the
// global delegate in shell.js ([data-copy] copies, [data-qb] quick-buys, [data-mint] opens the token page). Pulse
// handles its own extras ([data-hide], [data-bldev], [data-blx], [data-unhide], [data-rb], [data-rs]) itself.
//
//   cardHtml(t, opts?)  opts (all optional): qb (SOL for the quick-buy button; default the active preset's buy),
//     qbSize 's'|'l'|'m'|'u', ms (metric size) 's'|'m'|'l', compact, circle (round images), ring (bonding ring, default
//     on), grey (grey badges), nodec (no decimals), actions (hover hide / blacklist buttons), rapid (hover buy/sell bar),
//     blocked ({k, v, label}: render dimmed with an Unhide button), col (column id, stored as data-col)
//   Layout (css/pulse.css): picture in a launchpad-coloured frame with the short address under it; symbol, name and
//     copy; age, links and counts; the coin's X handle; stat pills. On the right V and MC, fees and TX, and the quick buy.
//   avatar(t, size)     the small picture used by the token page header
//   socials(t), qbButton(mint, sol?, size?, unit?, fill?), lpInfo(id), money(n, nodec)
// Pictures use token-image.js: visible-first loading, bounded concurrency,
// original/alternate source recovery and initials while artwork is unavailable.
import { esc, safeUrl, ago, short, isMint, ICON } from '../core/util.js';
import { mcUsd } from '../core/store.js';
import { solUsd } from '../core/price.js';
import { preset } from '../core/settings.js';
import { tokenImage } from './token-image.js';
import { parseXLink, xPreviewAttrs } from './x-link.js';

// launchpads by Jupiter id: a short badge label and a frame colour (pump.fun's badge is a small capsule)
export const LP = {
  'pump.fun': { label: 'pump.fun', short: '', color: '#54d38a' },
  'letsbonk.fun': { label: 'Bonk', short: 'BONK', color: '#ff9f3a' },
  'raydium-launchlab': { label: 'LaunchLab', short: 'LAB', color: '#8b7bff' },
  'met-dbc': { label: 'Meteora DBC', short: 'MET', color: '#ff6b9a' },
  'bags.fun': { label: 'Bags', short: 'BAGS', color: '#c6e05a' },
  moonshot: { label: 'Moonshot', short: 'MOON', color: '#f5d04b' },
  'jup-studio': { label: 'Jup Studio', short: 'STU', color: '#38d6f5' },
  stonkfun: { label: 'Stonk', short: 'STNK', color: '#ff7a59' },
  forge: { label: 'Forge', short: 'FRG', color: '#b9c0cf' },
};
export const lpInfo = (id) => LP[id] || (id ? { label: String(id), short: String(id).replace(/\.(fun|xyz|io)$/, '').slice(0, 4).toUpperCase(), color: '#7d8496' } : null);

// numbers: one decimal under 100 of a unit ($12.3K, $123K), none at all with nodec
export function money(n, nodec = false) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  const f = (v, u) => s + '$' + (nodec || v >= 100 ? Math.round(v) : v.toFixed(1)) + u;
  if (a >= 1e9) return f(a / 1e9, 'B');
  if (a >= 1e6) return f(a / 1e6, 'M');
  if (a >= 1e3) return f(a / 1e3, 'K');
  if (a >= 1) return s + '$' + (nodec || a >= 100 ? Math.round(a) : a.toFixed(2));
  return a === 0 ? '$0' : s + '$' + a.toPrecision(2);
}
const count = (n, nodec) => (n >= 1e6 ? (n / 1e6).toFixed(nodec ? 0 : 1) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(nodec ? 0 : 1) + 'K' : String(Math.round(n)));
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K' : String(Math.round(n)));
// an exact zero prints as "0%" (not "0.0%"), which keeps the stat pills short
const pctTxt = (n, nodec) => (nodec || n >= 10 || n === 0 ? Math.round(n) : n.toFixed(1)) + '%';
const solTxt = (v) => String(Math.round(Number(v) * 1e4) / 1e4);
// fees: no trailing zeros, so a coin with next to no fees reads "0", not a measured-looking "0.000"
const feeTxt = (v, nodec) => (v >= 100 || (nodec && v >= 1) ? String(Math.round(v)) : String(+v.toFixed(v >= 10 ? 1 : v >= 1 || nodec ? 2 : 3)));
// market-cap colour, as on the big terminals: light blue under $30K, yellow to $100K, green above
const mcTier = (mc) => (!(mc > 0) ? '' : mc < 3e4 ? ' mc-lo' : mc < 1e5 ? ' mc-mid' : ' mc-hi');
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

const IC = {
  user: '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M4 20c1.4-3.6 4.4-5.4 8-5.4s6.6 1.8 8 5.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  xs: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15 15 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m7.8 7.8 4.4 4.4m0-4.4-4.4 4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  hide: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M3 12s3.4-6 9-6 9 6 9 6-3.4 6-9 6-9-6-9-6Z" fill="none" stroke="currentColor" stroke-width="1.9"/><circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M4 20 20 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  dev: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="10" cy="8" r="3.6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 19.5c1.2-3.2 3.6-4.8 6.5-4.8 1 0 1.9.2 2.7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="m15.5 15.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  xban: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M11.2 2.5h2l-4.4 5 5.2 6.9H10l-3.1-4.1-3.6 4.1h-2l4.7-5.4L1 2.5h4.1l2.8 3.8 3.3-3.8Z"/><path d="m15.5 15.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  // the Solana mark next to fees (as shell.js solIcon; its gradient #n-sol is defined once in index.html)
  sol: '<svg class="sol-ic" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M6.8 4.5h14l-3.6 3.8h-14z"/><path d="M3.2 10.1h14l3.6 3.8h-14z"/><path d="M6.8 15.7h14l-3.6 3.8h-14z"/></svg>',
  // pump.fun's corner badge: a tilted capsule, one half filled
  pill: '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><g transform="rotate(-45 12 12)"><rect x="2.5" y="7.2" width="19" height="9.6" rx="4.8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7.2H7.3a4.8 4.8 0 0 0 0 9.6H12Z" fill="currentColor"/></g></svg>',
};

// Small picture for headers. The initials always sit
// under the picture (.av-x in css/pulse.css), so a loading, blank or broken picture never leaves an empty square.
export function avatar(t, size = '') {
  const sym = t.symbol || short(t.mint, 2), ini = String(sym).replace(/^\$/, '').slice(0, 2).toUpperCase();
  return `<div class="av av-x ${esc(size)}"><span class="av-i" aria-hidden="true">${esc(ini)}</span>${tokenImage(t)}${t.migrated || !(t.progress > 0) ? '' : `<span class="ring"><i style="width:${(t.progress * 100).toFixed(1)}%"></i></span>`}</div>`;
}
const xUrl = (t) => safeUrl(t.twitter) || (HANDLE.test(t.xHandle || '') ? 'https://x.com/' + t.xHandle : '');
function xSocial(t, url, showFollowers = false) {
  if (!url) return '';
  // quill = a tweet, person = an X account, two people = an X community, X logo = any other X link
  const kind = parseXLink(url)?.kind, post = kind === 'post';
  const who = `${HANDLE.test(t.xHandle || '') ? ' @' + t.xHandle : ''}${showFollowers && t.xFollowers ? ' · ' + count(t.xFollowers) + ' followers' : ''}`;
  const title = post ? 'Tweet · hover to preview' : kind === 'community' ? 'X community · hover to preview' : kind === 'profile' ? `X account${who} · hover to preview` : `X${who}`;
  const icon = post ? ICON.tweet : kind === 'profile' ? ICON.xProfile : kind === 'community' ? ICON.xCommunity : ICON.x;
  return `<a href="${esc(url)}"${xPreviewAttrs(url, t.mint)} target="_blank" rel="noopener nofollow" title="${esc(title)}">${icon}</a>`;
}
export function socials(t) {
  const x = xUrl(t), tg = safeUrl(t.telegram), web = safeUrl(t.website);
  return [xSocial(t, x),
    tg && `<a href="${esc(tg)}" target="_blank" rel="noopener nofollow" title="Telegram">${ICON.tg}</a>`,
    web && `<a href="${esc(web)}" target="_blank" rel="noopener nofollow" title="Website">${ICON.web}</a>`].filter(Boolean).join('');
}
// data-sol is exactly the amount the button shows: the shell's [data-qb] handler buys that (contract C7).
// unit: also print "SOL" after the amount (the Pulse cards)
export function qbButton(mint, sol = preset().buy, size = 'l', unit = false, fill = false) {
  const v = solTxt(Number(sol) > 0 && Number(sol) <= 1000 ? sol : preset().buy);
  return `<button class="qb${fill ? ' fill' : ''} nc-qb q-${esc(size)}" data-qb="${esc(mint)}" data-sol="${esc(v)}" title="Buy ${esc(v)} SOL now with preset ${esc(preset().name)}">${ICON.bolt}<span>${esc(v)}</span>${unit ? '<em>SOL</em>' : ''}</button>`;
}

// the square (or round) picture in a launchpad-coloured frame: the frame's bright part is the bonding curve so far,
// and a small launchpad badge sits on its bottom-right corner
function cardAvatar(t, o) {
  const sym = String(t.symbol || t.mint || '?').replace(/^\$/, '').slice(0, 2).toUpperCase();
  const lp = lpInfo(t.launchpad) || LP['pump.fun'];
  const p = t.migrated ? 100 : Math.max(0, Math.min(100, (Number(t.progress) || 0) * 100));
  const ring = o.ring === false ? '' : `<svg class="nc-ring" viewBox="0 0 60 60" aria-hidden="true">${o.circle
    ? `<circle class="bg" cx="30" cy="30" r="29.1" pathLength="100"/><circle class="fg" cx="30" cy="30" r="29.1" pathLength="100" stroke-dasharray="${p.toFixed(1)} 100" transform="rotate(-90 30 30)"/>`
    : `<rect class="bg" x=".9" y=".9" width="58.2" height="58.2" rx="4" pathLength="100"/><rect class="fg" x=".9" y=".9" width="58.2" height="58.2" rx="4" pathLength="100" stroke-dasharray="${p.toFixed(1)} 100"/>`}</svg>`;
  const title = t.migrated ? 'Migrated' : `Bonding curve ${p.toFixed(1)}%`;
  const badge = t.launchpad ? `<span class="nc-lp${lp.short ? '' : ' ic'}" aria-hidden="true">${lp.short ? esc(lp.short) : IC.pill}</span>` : '';
  return `<div class="nc-av${o.circle ? ' circ' : ''}${o.ring === false ? ' noring' : ''}${t.migrated ? ' done' : ''}" style="--lp:${lp.color}" title="${esc(title)} · ${esc(lp.label)}" data-hv="${esc(t.mint)}">${ring}`
    + `<div class="nc-img"><span>${esc(sym)}</span>${tokenImage(t)}</div>${badge}</div>`;
}

// a stat pill: level 'g' good, 'w' watch, 'b' risky ('' neutral); grey mode drops the colour
const lvl = (v, good, warn) => (v == null || !isFinite(v) ? '' : v < good ? 'g' : v < warn ? 'w' : 'b');
const pillIcons = {
  T10: '<path d="M3 17v-2a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v2M14 11a4 4 0 0 1 5 4v2"/><circle cx="8" cy="6" r="3"/><path d="M14 3a3 3 0 0 1 0 6"/>',
  Dev: '<path d="m7 6-5 5 5 5m8-10 5 5-5 5M13 3 9 19"/>',
  Snp: '<circle cx="11" cy="11" r="7"/><circle cx="11" cy="11" r="2"/><path d="M11 1v4m0 12v4M1 11h4m12 0h4"/>',
  Ins: '<path d="m11 2 8 5v8l-8 5-8-5V7l8-5Zm0 0v18M3 7l8 5 8-5"/>',
  DM: '<path d="M3 17 9 11l4 4 6-7M13.5 8H19v5.5"/>',
  Org: '<path d="M4 19c0-8.5 5-14 15-14 0 9.5-5.5 14-15 14Zm0 0 8.5-8.5"/>',
  Paid: '<circle cx="11" cy="11" r="8.5"/><path d="M14 8.3c-.5-.8-1.6-1.3-2.9-1.3-1.6 0-2.8.8-2.8 2s1 1.7 2.8 2.1 2.9.9 2.9 2.1-1.2 2-2.9 2c-1.3 0-2.5-.5-3-1.4M11 5v12"/>',
  Sold: '<path d="M5 5l12 12M17 8.5V17H8.5"/>',
};
const pillSvg = (k) => `<svg viewBox="0 0 22 22" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pillIcons[k]}</svg>`;
const badge = (label, val, level, title, o, extra = false) => `<span class="nb${o.grey || !level ? '' : ' ' + level}${extra ? ' nb-extra' : ''}" title="${esc(title)}" aria-label="${esc(title)}: ${esc(val)}">${pillSvg(label)}${val}</span>`;

const CARD_FIELDS = ['mint','symbol','name','created','migrated','migratedAt','volume24h','volSol','buys','sells','holders','progress','twitter','telegram','website','xHandle','xFollowers','top10Pct','devPct','sniperPct','insiderPct','devMigrations','devMints','organicLabel','organicScore','dexPaid','devSold','dev','launchpad','image','imageOriginal','imageAlt','liquidity','stats5m','fees'];
// Only fields that can change a row. Feed timestamps and metadata blobs do not
// invalidate a card; elapsed age text is updated separately by the shell.
export function cardKey(t, o = {}) {
  return JSON.stringify([CARD_FIELDS.map((k) => t[k]), t.traders?.size, mcUsd(t), solUsd(), preset().name, preset().buy, o]);
}
export function cardHtml(t, o = {}) {
  if (!t || !isMint(t.mint)) return '';
  if (typeof o !== 'object' || o === null) o = {}; // tolerate .map(cardHtml), which passes an index
  const nd = !!o.nodec, sym = t.symbol || short(t.mint), mc = mcUsd(t), at = (t.migrated && t.migratedAt) || t.created || Date.now();
  const vol = t.volume24h ?? (t.volSol || 0) * solUsd(), buys = Number(t.buys) || 0, sells = Number(t.sells) || 0, tx = buys + sells;
  const holders = Number(t.holders) || t.traders?.size || 0, prog = t.migrated ? 100 : (Number(t.progress) || 0) * 100;
  const amt = o.qb > 0 && o.qb <= 1000 ? o.qb : preset().buy, x = xUrl(t), tg = safeUrl(t.telegram), web = safeUrl(t.website);
  const soc = [xSocial(t, x, true),
    tg && `<a href="${esc(tg)}" target="_blank" rel="noopener nofollow" title="Telegram">${ICON.tg}</a>`,
    web && `<a href="${esc(web)}" target="_blank" rel="noopener nofollow" title="Website">${ICON.web}</a>`,
    `<a href="https://x.com/search?q=${encodeURIComponent(t.mint)}&amp;f=live" target="_blank" rel="noopener nofollow" title="Search X for this address">${IC.xs}</a>`].filter(Boolean).join('');

  // stat pills (only what we know). Jupiter leaves sniperPct out when it is zero.
  const snip = t.sniperPct ?? (t.devPct != null ? 0 : null), dm = t.devMigrations, dn = t.devMints;
  const org = typeof t.organicLabel === 'string' ? t.organicLabel.toLowerCase() : '';
  // the risk flag leads: pills that don't fit the row drop from the end
  const badges = [
    t.devSold && badge('Sold', 'Dev sold', 'b', 'The creator has sold', o),
    t.top10Pct != null && badge('T10', pctTxt(t.top10Pct, nd), lvl(t.top10Pct, 20, 35), 'Top 10 holders own this share', o),
    t.devPct != null && badge('Dev', pctTxt(t.devPct, nd), lvl(t.devPct, 5, 15), 'Share the creator still holds', o),
    snip != null && badge('Snp', pctTxt(snip, nd), lvl(snip, 5, 15), 'Held by wallets that bought in the first blocks', o),
    t.insiderPct != null && badge('Ins', pctTxt(t.insiderPct, nd), lvl(t.insiderPct, 5, 15), 'Held by wallets linked to the creator', o),
    t.dexPaid && badge('Paid', 'Paid', 'g', 'Someone paid Dexscreener for a profile or boost', o),
    (dm != null || dn != null) && badge('DM', `${Number(dm) || 0}/${Number(dn) || 0}`, dm > 0 ? 'g' : dn >= 20 ? 'w' : '', 'Creator history: coins migrated / coins launched', o, true),
    org && badge('Org', esc(org === 'medium' ? 'med' : org.slice(0, 4)), org === 'high' ? 'g' : org === 'medium' ? 'w' : '', `Organic activity: ${org}${t.organicScore != null ? ' (' + Math.round(t.organicScore) + '/100)' : ''}`, o, true),
  ].filter(Boolean).join('');

  const bp = tx ? Math.round((buys / tx) * 100) : 50;
  const change = t.stats5m?.priceChange, changeKnown = change != null && Number.isFinite(change);
  const activity = `<div class="nc-activity"><span title="Liquidity in USD"><em>LIQ</em><b>${money(t.liquidity, nd)}</b></span><span title="Trading volume over the last five minutes"><em>V 5m</em><b>${money(t.stats5m?.vol, nd)}</b></span><span class="nc-flow" title="${buys} buys / ${sells} sells, 24h"><em>TX</em><b>${count(tx, nd)}</b><i class="nc-bar"><i style="width:${bp}%"></i></i><small class="up">${count(buys, nd)}</small><small class="down">${count(sells, nd)}</small></span><span class="nc-change ${changeKnown ? change >= 0 ? 'up' : 'down' : 'dim'}" title="Price change over the last five minutes"><em>5m</em>${changeKnown ? (change >= 0 ? '+' : '') + pctTxt(change, false) : '—'}</span></div>`;
  const star = o.star ? `<button type="button" class="nc-star${o.watched ? ' on' : ''}" data-pu-star="${esc(t.mint)}" aria-label="${o.watched ? 'Remove from' : 'Add to'} watchlist" aria-pressed="${!!o.watched}" title="${o.watched ? 'Remove from' : 'Add to'} watchlist"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3L2.8 9.7l6.4-.9Z" fill="${o.watched ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7"/></svg></button>` : '';
  // big: Display → Card size → Large (Pulse's default); compact rows win over it
  const cls = ['card', 'nc', o.size === 'l' && !o.compact && 'big', o.detail && 'detail', o.compact && 'cmp', o.ms && o.ms !== 'm' && 'ms-' + o.ms, o.blocked && 'blk', o.rapid && 'rp'].filter(Boolean).join(' ');
  const blk = o.blocked ? `<div class="nc-blk"><span>Hidden · ${esc(o.blocked.label || o.blocked.k)}</span><button type="button" data-unhide="${esc(o.blocked.k)}" data-v="${esc(o.blocked.v)}">Unhide</button></div>` : '';
  const acts = o.actions && !o.blocked ? `<div class="nc-act" role="group" aria-label="Hide"><button type="button" data-hide="${esc(t.mint)}" title="Hide this coin (H)" aria-label="Hide this coin">${IC.hide}</button>${isMint(t.dev) ? `<button type="button" data-bldev="${esc(t.dev)}" title="Blacklist the creator wallet ${esc(short(t.dev))}">${IC.dev}</button>` : ''}${HANDLE.test(t.xHandle || '') ? `<button type="button" data-blx="${esc(t.xHandle)}" title="Blacklist @${esc(t.xHandle)}">${IC.xban}</button>` : ''}</div>` : '';
  const rapid = o.rapid && !o.blocked ? `<div class="nc-rapid"><button type="button" class="rb" data-rb="${esc(t.mint)}" data-sol="${esc(solTxt(amt))}" title="Buy ${esc(solTxt(amt))} SOL now (B)">Buy ${esc(solTxt(amt))}</button>${[25, 50, 100].map((p) => `<button type="button" class="rs" data-rs="${esc(t.mint)}" data-pct="${p}" title="Sell ${p}% of your holding now">${p}%</button>`).join('')}</div>` : '';
  // the coin's own X account, when Jupiter names one
  const hx = HANDLE.test(t.xHandle || '') ? t.xHandle : '', hxUrl = hx ? 'https://x.com/' + hx : '';
  const xh = hx ? `<a class="nc-h" href="${esc(hxUrl)}"${xPreviewAttrs(hxUrl, t.mint)} target="_blank" rel="noopener nofollow" title="@${esc(hx)} on X">@${esc(hx)}</a>${Number(t.xFollowers) > 0 ? `<span class="nc-fol" title="${esc(count(t.xFollowers))} followers on X">${IC.user}${esc(kfmt(Number(t.xFollowers)))}</span>` : ''}` : '';
  const fees = Number(t.fees);

  return `<div class="${cls}" data-mint="${esc(t.mint)}"${o.col ? ` data-col="${esc(o.col)}"` : ''}>
    <div class="nc-pic">${cardAvatar(t, o)}<button type="button" class="nc-ca" data-copy="${esc(t.mint)}" title="Copy address ${esc(t.mint)}">${esc(short(t.mint))}</button></div>
    ${acts}
    <div class="nc-l1"><span class="sym" title="${esc(sym)}">${esc(sym)}</span><span class="nm nc-name" title="${esc(t.name || '')}">${esc(t.name || short(t.mint))}</span><button class="copy" data-copy="${esc(t.mint)}" title="Copy address ${esc(short(t.mint))}">${ICON.copy}</button>${star}</div>
    <div class="nc-l2"><span class="age" data-age="${at}" title="${t.migrated ? 'Since migration' : 'Since launch'}">${ago(at)}</span><span class="soc">${soc}</span>${holders ? `<span class="nk" title="${t.holders ? 'Holders' : 'Wallets seen trading'}">${IC.user}<b>${count(holders, nd)}</b></span>` : ''}${t.migrated ? '<span class="nk nc-grad" title="Migrated to a liquidity pool">↗</span>' : `<span class="nk bc" title="Bonding curve">${pctTxt(prog, true)}</span>`}</div>
    <div class="nc-xh">${xh}</div>
    <div class="nc-l3">${badges || '<span class="nb nil">Holder data pending</span>'}</div>
    <div class="nc-side">
      <div class="nc-r1"><span class="nc-v" title="Volume, 24h"><em>V</em>${money(vol, nd)}</span><span class="nc-mc${mcTier(mc)}" title="Market cap"><em>MC</em>${money(mc, nd)}</span></div>
      <div class="nc-r2">${fees >= 0 && t.fees != null ? `<span class="nc-f" title="Fees traders have paid on this coin so far, in SOL"><em>F</em>${IC.sol}${feeTxt(fees, nd)}</span>` : ''}<span class="nc-tx" title="${buys} buys / ${sells} sells, 24h"><em>TX</em>${count(tx, nd)}<i class="nc-bar"><i style="width:${bp}%"></i></i></span></div>
    </div>
    ${qbButton(t.mint, amt, o.qbSize || 'l', true)}
    ${activity}
    ${rapid}${blk}
  </div>`;
}
