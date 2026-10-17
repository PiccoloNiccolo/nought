import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleAt } from './helpers.mjs';

const load = async (saved) => (await moduleAt('src/core/settings.js', { './util.js': { LS: { get: (k, d) => (k === 'settings' && saved !== undefined ? saved : d), set: () => true }, emit() {} } })).api.settings.metaRelay;
test('the hosted relay is the default, empty turns it off, and only safe addresses are kept', async () => {
  assert.equal(await load(undefined), 'https://nought-relay-production.up.railway.app', 'a new visitor uses Nought\'s relay');
  assert.equal(await load({}), 'https://nought-relay-production.up.railway.app', 'settings saved before the relay existed get it too');
  assert.equal(await load({ metaRelay: '' }), '', 'empty means off and stays off');
  assert.equal(await load({ metaRelay: 'http://127.0.0.1:3320' }), 'http://127.0.0.1:3320');
  assert.equal(await load({ metaRelay: 'https://relay.example/path?x=1' }), 'https://nought-relay-production.up.railway.app', 'paths and queries are refused');
  for (const bad of ['http://relay.example', 'javascript:alert(1)', 'https://user:pw@relay.example']) assert.equal(await load({ metaRelay: bad }), 'https://nought-relay-production.up.railway.app', bad);
});
