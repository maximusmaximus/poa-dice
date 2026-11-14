import test from 'node:test';
import assert from 'node:assert/strict';
import { MinepoaClient } from '../src/minepoa-client.mjs';
import { LedgerProbe } from '../src/ledger-probe.mjs';

const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const routes = (map) => async (url) => {
  const u = new URL(url);
  const h = map[u.pathname];
  return h ? h(u) : json(401, { error: 'Unauthorized' });
};
const explorer = () => json(200, { txs: [{ id: 'c', ts: 30 }, { id: 'x', ts: 40, invalid: true }, { id: 'b', ts: 20 }, { id: 'a', ts: 10 }] });

test('getTipParents uses /api/txs when it answers', async () => {
  const c = new MinepoaClient({ fetchImpl: routes({ '/api/txs': () => json(200, { valid: [{ id: 'p', ts: 1 }, { id: 'q', ts: 2 }] }), '/api/explorer/txs': explorer }), retries: 1 });
  assert.deepEqual(await c.getTipParents(), ['p', 'q']);
});

test('getTipParents falls back to explorer feed when /api/txs is 503', async () => {
  const c = new MinepoaClient({ fetchImpl: routes({ '/api/txs': () => json(503, { error: 'busy' }), '/api/explorer/txs': explorer }), retries: 1 });
  assert.deepEqual(await c.getTipParents(), ['b', 'c']);
});

test('getTipParents throws when both routes refuse (401 maintenance)', async () => {
  const c = new MinepoaClient({ fetchImpl: routes({}), retries: 1 });
  await assert.rejects(() => c.getTipParents(), /401/);
});

test('probe: /api/txs down but explorer feed + submit up is OK', async () => {
  const p = new LedgerProbe({ fetchImpl: routes({ '/api/txs': () => json(503, 'error'), '/api/explorer/txs': explorer, '/api/submit': () => json(400, { error: 'bad tx' }) }) });
  await p.probe();
  assert.equal(p.lastChecks.txs.ok, true);
  assert.equal(p.lastChecks.txs.name, '/api/explorer/txs');
  assert.equal(p.status, 'OK');
});

test('probe: everything 401 (origin offline) is still a hard hold', async () => {
  const p = new LedgerProbe({ fetchImpl: routes({}), failThreshold: 1 });
  await p.probe();
  assert.equal(p.lastChecks.txs.hard, true);
  assert.equal(p.status, 'UNAVAILABLE');
});
