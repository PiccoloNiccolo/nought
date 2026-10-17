import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMeta } from '../tools/meta-relay.mjs';

test('the relay refuses internal, insecure and malformed addresses without fetching them', async () => {
  for (const u of ['', 'http://example.com/m.json', 'https://127.0.0.1/m.json', 'https://localhost/m.json', 'https://[::1]/m.json', 'https://10.0.0.5/m.json', 'https://169.254.169.254/latest', 'https://user:pw@example.com/m.json', 'https://example.com:8443/m.json', 'file:///etc/passwd', 'x'.repeat(1200)]) {
    const r = await handleMeta('/meta?url=' + encodeURIComponent(u));
    assert.equal(r.status, 400, u); assert.deepEqual(Object.keys(r.body), ['error']);
  }
});
