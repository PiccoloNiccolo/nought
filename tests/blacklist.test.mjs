import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAt } from './helpers.mjs';

const mint = 'So11111111111111111111111111111111111111112';
async function bl() {
  const { api: util } = await moduleAt('src/core/util.js');
  const store = new Map();
  return (await moduleAt('src/ui/blacklist.js', { '../core/util.js': { esc: util.esc, short: (s) => s.slice(0, 4), isMint: util.isMint, LS: { get: (k, d) => store.get(k) ?? d, set: (k, v) => { store.set(k, v); return true; } }, toast() {}, ICON: {} } }, { document: { addEventListener() {} } })).api;
}
test('hiding a coin that is already in Migrated hides it, even with "unhide on migration" on', async () => {
  const B = await bl(), t = { mint, migrated: true, migratedAt: Date.now() - 60000 };
  assert.ok(B.add('mint', mint));
  assert.ok(B.blocked(t, { ignoreMint: true }), 'hidden after it migrated: stays hidden in Migrated');
});
test('a coin hidden before it migrated comes back in Migrated when "unhide on migration" is on', async () => {
  const B = await bl();
  assert.ok(B.add('mint', mint));
  const t = { mint, migrated: true, migratedAt: Date.now() + 60000 };
  assert.equal(B.blocked(t, { ignoreMint: true }), null, 'migrated later: shown again');
  assert.ok(B.blocked(t, { ignoreMint: false }), 'the other columns still hide it');
  assert.ok(B.blocked({ mint, migrated: true }, { ignoreMint: true }), 'unknown migration time: stays hidden');
});
