import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAt } from './helpers.mjs';
const { api } = await moduleAt('src/ui/x-link.js', { '../core/util.js': { esc: s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') } });
test('post links normalize both X and Twitter hosts and retain full string IDs', () => {
  for (const url of ['https://x.com/example/status/2106880755108647356?s=20', 'https://twitter.com/i/web/status/2106880755108647356', 'https://mobile.twitter.com/example/status/2106880755108647356/photo/1']) {
    const p = api.parseXLink(url); assert.equal(p.kind, 'post'); assert.equal(p.id, '2106880755108647356'); assert.equal(p.url, 'https://x.com/i/status/2106880755108647356');
  }
});
test('profiles and communities are distinct from actual posts', () => {
  assert.equal(api.parseXLink('https://x.com/example').kind, 'profile');
  assert.equal(api.parseXLink('https://x.com/i/communities/123456789').kind, 'community');
  for (const url of ['https://x.com/search?q=test', 'https://x.com/home', 'https://x.com/intent/tweet', 'https://x.com/settings']) assert.equal(api.parseXLink(url), null);
});
test('embeds reject spoofed hosts, credentials, ports and nonnumeric post IDs', () => {
  for (const url of ['https://x.com.evil.test/a/status/123', 'https://user:secret@x.com/a/status/123', 'https://x.com:444/a/status/123', 'javascript:alert(1)', 'https://x.com/a/status/<script>', 'https://evil.test/x.com/a/status/123']) assert.equal(api.parseXLink(url), null, url);
  assert.equal(api.xPreviewAttrs('https://evil.test/a/status/123'), '');
  assert.ok(api.xPreviewAttrs('https://x.com/a/status/123', 'a"<b').includes('a&quot;&lt;b'));
});
test('X embed sizing messages parse object and legacy string envelopes without execution', () => {
  const message = { jsonrpc: '2.0', method: 'twttr.private.resize', params: [{ height: 480, width: 360 }] };
  for (const data of [{ 'twttr.embed': message }, JSON.stringify({ 'twttr.embed': message }), 'twttr.embed' + JSON.stringify(message)]) {
    const messages = api.xEmbedMessages(data); assert.equal(messages.length, 1); assert.equal(messages[0].params[0].height, 480);
  }
  for (const data of ['not json', { method: 'twttr.private.resize' }, { jsonrpc: '2.0', method: 'eval', params: ['alert(1)'] }]) assert.equal(api.xEmbedMessages(data).length, 0);
});
