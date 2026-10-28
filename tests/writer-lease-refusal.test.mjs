// @ts-nocheck
/**
 * fix/writer-hold-null-refusal. Live on 2026-10-27: a bet was refused with HTTP 400
 * "Cannot read properties of null (reading 'reason')". The instance was the bank writer (LEADER), so
 * writer.hold() returned null, but canWrite() was false because the writer lease was in its last
 * seconds / being handed over between the two server instances. The refusal happens before broadcast,
 * so nothing was sent or booked; it just read like a permanent rejection instead of "try again".
 *
 * Covered here (local mock minepoa only): with writer.hold() === null and canWrite() === false,
 *  - POST /api/tx/submit answers a retryable 503 with a clear reason (no TypeError, no 400), nothing broadcast;
 *  - the bet goes through normally once the lease is healthy again;
 *  - ackForeignOutflows refuses with the same clear, retryable reason (503 on the admin route).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { WRITER_LEASE_RENEWING_REASON } from '../src/chain-settlement.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-lease-${t}-`));
const ts = () => Math.floor(Date.now() / 1000);
const tx = (mock, wallet, to, amount, memo) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });
const ADMIN = 'lease-test-admin';

async function setup(tag) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const player = genKeypair();
  mock.setBalance(lp.address, '1000.000000');
  mock.setBalance(player.address, '100.000000');
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: createMemoryStore(null),
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    adminToken: ADMIN,
    cronSecret: 'lease-test-cron',
    passMode: true,
    passEveryMs: 100,
    readPassBudgetMs: 3000,
    ledgerProbeIntervalMs: 0,
    ledgerProbeMinHoldMs: 0,
    sentGraceMs: 0,
    rejectCheckIntervalMs: 0
  });
  const info = await app.listen(0, '127.0.0.1');
  const s = app.settlement;
  s.client.retryBaseMs = 5;
  await s.ready();
  const pass = async (n = 1) => {
    for (let i = 0; i < n; i++) await s.tick();
    await s.idle();
  };
  mock.directSubmit(tx(mock, lp, bank.address, '500.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  mock.finalizeAll();
  await pass(3);
  assert.equal(s.writer.binding?.bankAddress, bank.address, 'store bound');
  return {
    mock,
    bank,
    player,
    app,
    s,
    pass,
    url: info.url,
    close: async () => {
      await app.close().catch(() => {});
      await mock.close();
    }
  };
}

/**
 * The lease handoff window: this instance is still LEADER (so writer.hold() is null) but its lease is in
 * its last seconds, so canWrite() is false; the renewing pass has not landed yet (tick is a no-op here).
 */
function leaseRenewing(s) {
  const real = { tick: s.tick, _observe: s._observe, status: s.writer.status, lease: s.writer.lease };
  s.tick = async () => {};
  s._observe = async () => {};
  s.writer.status = 'LEADER';
  s.writer.lease = { ...(s.writer.lease || {}), held: true, token: s.writer.lease?.token ?? 1, expiresAt: s.writer.now() + 1000 };
  return () => {
    s.tick = real.tick;
    s._observe = real._observe;
    s.writer.status = real.status;
    s.writer.lease = real.lease;
  };
}

const post = async (url, body, headers = {}) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

test('lease renewing: a bet is refused with a retryable 503 and a clear reason, never a TypeError/400; nothing is broadcast', async () => {
  const c = await setup('bet');
  try {
    const restore = leaseRenewing(c.s);
    assert.equal(c.s.writer.hold(), null, 'hold() is null while LEADER');
    assert.equal(c.s.writer.canWrite(), false, 'lease in its last seconds');
    const bet = tx(c.mock, c.player, c.bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 5000 }));
    const submitted = [];
    const realSubmit = c.s.client.submitTx.bind(c.s.client);
    c.s.client.submitTx = async (body) => {
      submitted.push(body);
      return realSubmit(body);
    };

    // Directly: no throw of a TypeError, a 503 marked retryable.
    await assert.rejects(c.s.submitInbound(bet), (err) => {
      assert.ok(!(err instanceof TypeError), `not a TypeError: ${err.message}`);
      assert.equal(err.status, 503);
      assert.equal(err.code, 'SIGNER_READ_ONLY');
      assert.equal(err.retryable, true);
      assert.ok(err.message.includes(WRITER_LEASE_RENEWING_REASON), err.message);
      assert.match(err.message, /Not broadcast; nothing was booked\./);
      assert.doesNotMatch(err.message, /Cannot read properties of null/);
      return true;
    });

    // Over HTTP: 503, not 400.
    const r = await post(`${c.url}/api/tx/submit`, { tx: bet.body });
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /Try again in a few seconds/);
    assert.doesNotMatch(r.json.error, /Cannot read properties/);
    assert.equal(submitted.length, 0, 'nothing broadcast while the lease is renewing');

    // Lease healthy again: the same signed bet is accepted.
    restore();
    await c.pass(1);
    const ok = await post(`${c.url}/api/tx/submit`, { tx: bet.body });
    assert.equal(ok.status, 202, JSON.stringify(ok.json));
    const fromPlayer = submitted.filter((b) => b.from === c.player.address); // a win also sends the bank's payout
    assert.ok(fromPlayer.length >= 1, 'broadcast once the lease is healthy');
    assert.equal(new Set(fromPlayer.map((b) => JSON.stringify(b))).size, 1, 'only that one signed bet');
  } finally {
    await c.close();
  }
});

test('lease renewing: ackForeignOutflows refuses with the clear reason and the admin route answers 503', async () => {
  const c = await setup('ack');
  try {
    leaseRenewing(c.s);
    await assert.rejects(c.s.ackForeignOutflows({ txids: ['abc'], mode: 'book_loss' }), (err) => {
      assert.ok(!(err instanceof TypeError));
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      assert.equal(err.message, WRITER_LEASE_RENEWING_REASON);
      return true;
    });
    const r = await post(`${c.url}/api/admin/foreign-outflows/ack`, { txids: ['abc'], mode: 'book_loss' }, { Authorization: `Bearer ${ADMIN}` });
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error, WRITER_LEASE_RENEWING_REASON);
  } finally {
    await c.close();
  }
});
