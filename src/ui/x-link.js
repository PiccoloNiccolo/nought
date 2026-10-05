import { esc } from '../core/util.js';
const HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com']);
const RESERVED = new Set(['home', 'search', 'explore', 'intent', 'share', 'i', 'settings', 'messages', 'notifications', 'compose', 'login', 'logout', 'signup']);
export function parseXLink(value) {
  let u; try { u = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port || !HOSTS.has(u.hostname.toLowerCase())) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  const status = u.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})(?:\/|$)/);
  if (status) return { kind: 'post', id: status[1], url: `https://x.com/i/status/${status[1]}`, label: 'Post on X' };
  if (parts[0] === 'i' && parts[1] === 'communities' && /^\d{1,25}$/.test(parts[2] || '')) return { kind: 'community', id: parts[2], url: `https://x.com/i/communities/${parts[2]}`, label: 'X community' };
  if (parts.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) && !RESERVED.has(parts[0].toLowerCase())) return { kind: 'profile', handle: parts[0], url: `https://x.com/${parts[0]}`, label: '@' + parts[0] };
  return null;
}
export function xPreviewAttrs(url, mint = '') {
  const link = parseXLink(url); if (!link) return '';
  return ` data-x-preview="${esc(link.url)}" data-x-mint="${esc(mint)}" aria-label="${esc(link.label)} · preview on hover or focus"`;
}

// X's public embed uses JSON-RPC under the "twttr.embed" message key.
// Callers must also verify the sending origin and the exact iframe Window.
export function xEmbedMessages(data) {
  try {
    let value = typeof data === 'string' ? JSON.parse(data.startsWith('twttr.embed') ? data.slice(11) : data) : data;
    value = value?.['twttr.embed'] || value;
    if (typeof value === 'string') value = JSON.parse(value);
    return (Array.isArray(value) ? value : [value]).slice(0, 16).filter(m => m?.jsonrpc === '2.0' && typeof m.method === 'string' && m.method.startsWith('twttr.private.'));
  } catch { return []; }
}
