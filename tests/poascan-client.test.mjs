// @ts-nocheck
/** POAScan client: only an explicit not-found counts as not found; anything else throws (callers refuse). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PoaScanClient } from '../src/poascan-client.mjs';

const ID = '269433a21ec8de992d221bfd43670e4e627440e32f45e670e1f365dfaf9e5bcc';
const mk = (...answers) => {
  const seen = [];
  const c = new PoaScanClient({
    baseUrl: 'https://ps.test',
    retries: 3,
    retryBaseMs: 1,
    fetchImpl: async (url) => {
      seen.push(url);
      const a = answers.length > 1 ? answers.shift() : answers[0];
      if (a instanceof Error) throw a;
      return { status: a.status, json: async () => a.body };
    }
  });
  c.seen = seen;
  return c;
};

test('200 with the same id => found (final, atts, checkpoint, nonce)', async () => {
  const c = mk({ status: 200, body: { id: ID, from_addr: 'poa1B', to_addr: 'poa1W', amount: '1.320176', memo: 'DICE1:WIN:x:ord=7e189a652cf9', atts: 8, final: 1, body: { nonce: 10 }, checkpointed: { height: 63150 }, found: true } });
  const r = await c.lookupTx(ID);
  assert.equal(r.found, true);
  assert.deepEqual([r.tx.final, r.tx.atts, r.tx.checkpointHeight, r.tx.nonce, r.tx.amount], [true, 8, 63150, 10, '1.320176']);
  assert.equal(c.seen[0], `https://ps.test/api/v1/tx/${ID}`);
});

test('404 found:false node:not_found for the same txid => not found', async () => {
  const c = mk({ status: 404, body: { error: 'transaction not found', found: false, tx: ID, node: 'not_found' } });
  assert.deepEqual(await c.lookupTx(ID), { found: false });
});

test('anything else throws: unknown endpoint 404, other txid, 429 / 5xx / network after retries, junk', async () => {
  await assert.rejects(mk({ status: 404, body: { error: 'unknown endpoint' } }).lookupTx(ID));
  await assert.rejects(mk({ status: 404, body: { found: false, tx: 'ff'.repeat(32), node: 'not_found' } }).lookupTx(ID));
  await assert.rejects(mk({ status: 404, body: { found: false, tx: ID, node: 'unreachable' } }).lookupTx(ID));
  const busy = mk({ status: 429, body: { error: 'upstream budget for this lookup spent' } });
  await assert.rejects(busy.lookupTx(ID), /429/);
  assert.equal(busy.seen.length, 3, 'retried');
  await assert.rejects(mk({ status: 503, body: null }).lookupTx(ID), /503/);
  await assert.rejects(mk(new Error('ECONNRESET')).lookupTx(ID), /network error/);
  await assert.rejects(mk({ status: 200, body: { id: 'other' } }).lookupTx(ID));
  await assert.rejects(mk({ status: 200, body: null }).lookupTx(ID));
  await assert.rejects(mk({ status: 200, body: {} }).lookupTx('nothex'));
});

test('a 429 then a definite answer: the retry gets the answer', async () => {
  const c = mk({ status: 429, body: { error: 'busy' } }, { status: 404, body: { found: false, tx: ID, node: 'not_found' } });
  assert.deepEqual(await c.lookupTx(ID), { found: false });
});

test('addressTxs follows next_cursor and throws on an unreadable page', async () => {
  const c = mk(
    { status: 200, body: { txs: [{ id: 'A'.repeat(64), from_addr: 'x', to_addr: 'y', amount: '1', memo: 'm', final: 1 }], next_cursor: 'c1' } },
    { status: 200, body: { txs: [{ id: 'b'.repeat(64) }], next_cursor: null } }
  );
  const rows = await c.addressTxs('poa1W');
  assert.deepEqual(rows.map((r) => r.id), ['a'.repeat(64), 'b'.repeat(64)]);
  assert.match(c.seen[1], /cursor=c1/);
  await assert.rejects(mk({ status: 200, body: { error: 'x' } }).addressTxs('poa1W'));
  await assert.rejects(mk({ status: 503, body: null }).addressTxs('poa1W'));
});
