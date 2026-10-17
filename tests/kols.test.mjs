import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKols } from '../tools/kols.mjs';
import { pickProfile, handleWho, handleCallouts } from '../tools/meta-relay.mjs';

const A = 'G3CaEuingKVjqsoHf7SpSQuLvRAJA69dikaQYxBqvwEr', B = '2tgUbS9UMoQD6GkDZBiqKYCURnGrSb6ocYwRABrSJUvY', C = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
test('the kolscan snapshot keeps wallet, name, X handle and only kolscan-hosted pictures', () => {
  const row = (w, name, pfp, tw) => `{\\"wallet_address\\":\\"${w}\\",\\"name\\":\\"${name}\\",\\"pfp\\":${pfp ? `\\"${pfp}\\"` : 'null'},\\"telegram\\":null,\\"twitter\\":${tw ? `\\"${tw}\\"` : 'null'}`;
  const html = row(A, 'Halo', `https://kolscan-images.pump.fun/profiles/${A}/1.jpg`, 'https://x.com/Halo100x') + row(B, 'Evil', 'https://evil.example/x.jpg', 'https://x.com/bad handle') + row(A, 'dupe', null, null);
  const out = parseKols(html);
  assert.equal(out.length, 2);
  assert.deepEqual({ ...out[0], tags: undefined }, { address: A, name: 'Halo', x: 'Halo100x', pfp: `https://kolscan-images.pump.fun/profiles/${A}/1.jpg`, tags: undefined });
  assert.equal(out[1].pfp, ''); assert.equal(out[1].x, '');
});
test('pump.fun profiles count only when the owner set them up', () => {
  assert.equal(pickProfile({ username: 'fineotter16558', last_username_update_timestamp: null, profile_image: null, x_username: null }), null);
  assert.deepEqual(pickProfile({ username: 'kuma', last_username_update_timestamp: 1, profile_image: null, x_username: 'kuma99999999' }), { name: 'kuma', x: 'kuma99999999', pfp: '' });
  assert.equal(pickProfile({ username: 'x', last_username_update_timestamp: 1, is_banned: true }), null);
  assert.equal(pickProfile({ profile_image: 'https://evil.example/a.png', last_username_update_timestamp: null })?.pfp ?? '', '');
});
test('/who batches wallets, drops junk and reports only real profiles', async () => {
  const asked = [];
  const fake = async (u) => { asked.push(u); const w = u.split('/').pop(); return { ok: true, status: 200, json: async () => (w === A ? { username: 'halo', last_username_update_timestamp: 5, x_username: 'Halo100x' } : { username: 'pastfish1', last_username_update_timestamp: null }) }; };
  const r = await handleWho(`/who?w=${A},${B},nope,${A}`, fake);
  assert.equal(r.status, 200); assert.equal(asked.length, 2);
  assert.deepEqual(Object.keys(r.body).sort(), [A, B].sort()); assert.equal(r.body[B], null, 'checked and none: reported as null');
  const busy = await handleWho(`/who?w=${C}`, async () => ({ ok: false, status: 429 }));
  assert.equal(C in busy.body, false, 'pump.fun busy: left out so the browser asks again');
  assert.equal((await handleWho('/who?w=bad', fake)).status, 400);
});

test('/callouts returns the pump.fun callouts on a coin with each caller profile, and drops junk', async () => {
  const M = 'EFb8GpUxeCGiUygQKt8WgwHDHX7Ntgm4f87jfDfmpump';
  const fake = async (u) => /callout\/coin/.test(u)
    ? { ok: true, status: 200, json: async () => ({ callouts: [{ calloutId: 'c1', userId: A, coinMint: M, createdAt: 1792186961997, marketCap: 18270, maxMultiplier: 7.9, thesis: 'good\u0007 feeling', likes: 1 }, { calloutId: 'c2', userId: 'nope', coinMint: M, createdAt: 1 }, { calloutId: 'c3', userId: B, coinMint: 'other', createdAt: 2 }] }) }
    : { ok: true, status: 200, json: async () => ({ username: 'halo', last_username_update_timestamp: 5, x_username: 'Halo100x' }) };
  const r = await handleCallouts('/callouts?mint=' + M, fake);
  assert.equal(r.status, 200); assert.equal(r.body.callouts.length, 1);
  const c = r.body.callouts[0];
  assert.equal(c.wallet, A); assert.equal(c.mc, 18270); assert.equal(c.max, 7.9); assert.equal(c.note, 'good  feeling'); assert.equal(c.x, 'Halo100x');
  assert.equal((await handleCallouts('/callouts?mint=bad', fake)).status, 400);
});
