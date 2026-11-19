// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { buildSignedTransfer, formatDiceMemo, genKeypair, toMicros } from '../src/crypto-poa.mjs';
import { MinepoaClient } from '../src/minepoa-client.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-repay-nonce-${t}-`));

async function boot({ mock, bank, tag, adminToken = 'test-admin-secret', store = null, extra = {} }) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    ...(store ? { settlementStore: store } : {}),
    adminToken,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    rejectCheckIntervalMs: 0,
    sentGraceMs: 0,
    stuckAfterMs: 0,
    ledgerProbe: false,
    ...extra
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  const req = async (p, { method = 'GET', body = null, token = null } = {}) => {
    const res = await fetch(`${info.url}${p}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { app, url: info.url, req, close: () => app.close() };
}

test('P0-2: HELD repayments reserve spendable/coverage and resolve via dry-run / approve / dismiss', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const winner = genKeypair();
  const lp = genKeypair();
  mock.setBalance(bank.address, '0.000000');
  mock.setBalance(lp.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'held-resolve' });
  try {
    const s = srv.app.settlement;
    // Fund bank with 20 POA via real LP deposit
    const dep = buildSignedTransfer({
      wallet: lp,
      to: bank.address,
      amount: '20.000000',
      memo: formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }),
      nonce: mock.nextNonce(lp.address),
      parents: mock.parents()
    });
    mock.directSubmit(dep.body);
    await s.tick();
    await s.idle();

    // Inject two HELD repayments (8 POA + 5 POA = 13 POA)
    const held1 = 'aaaa1111bbbb2222cccc3333';
    const held2 = 'dddd4444eeee5555ffff6666';
    s.state.outbound[held1] = {
      orderId: held1,
      seq: ++s.state.seq,
      sourceTxid: '1'.repeat(64),
      kind: 'BET_WIN_PAYOUT',
      to: winner.address,
      amountPoa: '8.000000',
      memo: `DICE1:WIN:1111111111111111:ord=${held1.slice(0, 12)}`,
      status: 'REJECTED',
      txid: '2'.repeat(64),
      nonce: 1,
      superseded: [],
      repayment: { status: 'HELD', orderId: held1, amountPoa: '8.000000', txid: '2'.repeat(64), nonce: 1, reason: 'bad nonce', code: 'bad_nonce', heldAt: Date.now(), approved: false }
    };
    s.state.outbound[held2] = {
      orderId: held2,
      seq: ++s.state.seq,
      sourceTxid: '3'.repeat(64),
      kind: 'BET_WIN_PAYOUT',
      to: winner.address,
      amountPoa: '5.000000',
      memo: `DICE1:WIN:3333333333333333:ord=${held2.slice(0, 12)}`,
      status: 'REJECTED',
      txid: '4'.repeat(64),
      nonce: 2,
      superseded: [],
      repayment: { status: 'HELD', orderId: held2, amountPoa: '5.000000', txid: '4'.repeat(64), nonce: 2, reason: 'bad nonce', code: 'bad_nonce', heldAt: Date.now(), approved: false }
    };
    s._save();

    // Coverage limit MUST subtract the 13 POA held repayment liability from on-chain 20 POA -> <= 7 POA
    const lim = s.coverageLimit();
    assert.equal(lim.known, true);
    assert.equal(lim.heldRepaymentMicros, toMicros('13.000000'));
    assert.ok(lim.limitMicros <= toMicros('7.000000'), `expected coverage <= 7 POA, got ${lim.limitMicros}`);

    // repaymentQueue exposes individual items; audit exposes heldRepaymentsPoa & deltaAfterHeldRepaymentsPoa
    const rq = s.repaymentQueueView();
    assert.equal(rq.count, 2);
    assert.equal(rq.totalPoa, '13.000000');
    assert.equal(rq.items.length, 2);
    const audit = await s.auditAgainstChain();
    assert.equal(audit.heldRepaymentsPoa, '13.000000');
    assert.equal(audit.deltaAfterHeldRepaymentsPoa, '-13.000000');

    // Unauthenticated call is denied
    const unauth = await srv.req('/api/admin/repayments/resolve', { method: 'POST', body: { orderId: held1, action: 'approve' } });
    assert.equal(unauth.status, 401);

    // Dry-run preview does not mutate state
    const preview = await srv.req('/api/admin/repayments/resolve', {
      method: 'POST',
      token: 'test-admin-secret',
      body: { orderId: held1, action: 'approve', confirm: false }
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.mode, 'preview');
    assert.equal(preview.body.eligible, true);
    assert.equal(s.state.outbound[held1].repayment.status, 'HELD');

    // Approve held1 -> re-queued with :repay=1 and paid on next tick
    const approved = await srv.req('/api/admin/repayments/resolve', {
      method: 'POST',
      token: 'test-admin-secret',
      body: { orderId: held1, action: 'approve', confirm: true, note: 'verified missing' }
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(s.state.outbound[held1].status, 'QUEUED');
    assert.match(s.state.outbound[held1].memo, /:repay=1$/);
    await s.tick();
    await s.tick();
    await s.idle();
    assert.equal(s.state.outbound[held1].status, 'CONFIRMED');
    assert.equal(mock.balanceOf(winner.address), '8.000000');

    // Dismiss held2 -> terminal DISMISSED, never paid, released from repaymentQueue
    const dismissed = await srv.req('/api/admin/repayments/resolve', {
      method: 'POST',
      token: 'test-admin-secret',
      body: { orderId: held2, action: 'dismiss', confirm: true, note: 'settled out of band' }
    });
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    assert.equal(s.state.outbound[held2].status, 'DISMISSED');
    assert.equal(s.repaymentQueueView().count, 0);
    assert.equal(mock.balanceOf(winner.address), '8.000000', 'dismissed order was never paid');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('P0-5 & P2-1: exact O(1) nonce release avoids prefix collision, compaction prunes old nonce claims, same-second nextNonce & multi-payout draining work', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const r1 = genKeypair();
  const r2 = genKeypair();
  const r3 = genKeypair();
  mock.setBalance(bank.address, '50.000000');
  const store = createMemoryStore(null);
  const srv = await boot({ mock, bank, store, tag: 'multi-drain' });
  try {
    const s = srv.app.settlement;
    await s.tick();
    await s.idle();

    // Verify releasing bank-nonce:1 NEVER deletes bank-nonce:10 or bank-nonce:11 (LIKE prefix regression)
    await s._persist.claim('bank-nonce:1', { orderId: 'ord-1', gen: 0, at: 1 });
    await s._persist.claim('bank-nonce:10', { orderId: 'ord-10', gen: 0, at: 1 });
    await s._persist.claim('bank-nonce:11', { orderId: 'ord-11', gen: 0, at: 1 });
    await s._releaseNonceClaim(1, 'ord-1');
    assert.equal(await s.store.peek('bank-nonce:1'), null);
    assert.equal((await s.store.peek('bank-nonce:10'))?.orderId, 'ord-10', 'bank-nonce:10 must NOT be touched');
    assert.equal((await s.store.peek('bank-nonce:11'))?.orderId, 'ord-11', 'bank-nonce:11 must NOT be touched');
    await s._persist.deleteClaim('bank-nonce:10');
    await s._persist.deleteClaim('bank-nonce:11');

    // Queue 3 payouts simultaneously and verify ONE tick drains all 3 with sequential nonces 1, 2, 3
    const orders = [
      { id: '111111111111111111111111', to: r1.address, amt: '1.000000' },
      { id: '222222222222222222222222', to: r2.address, amt: '2.000000' },
      { id: '333333333333333333333333', to: r3.address, amt: '3.000000' }
    ];
    for (const o of orders) {
      s.state.outbound[o.id] = {
        orderId: o.id,
        seq: ++s.state.seq,
        sourceTxid: o.id.padEnd(64, '0'),
        kind: 'BET_WIN_PAYOUT',
        to: o.to,
        amountPoa: o.amt,
        memo: `DICE1:WIN:test:ord=${o.id.slice(0, 12)}`,
        status: 'QUEUED',
        txid: null,
        body: null,
        nonce: null,
        claimedNonce: null,
        attempts: 0,
        resigns: 0,
        nextAttemptAt: 0,
        lastError: null,
        superseded: [],
        createdAt: Date.now()
      };
    }
    s._save();

    await s.tick();
    await s.idle();
    const sentOrders = orders.map((o) => s.state.outbound[o.id]);
    assert.deepEqual(
      sentOrders.map((o) => o.status),
      ['SENT', 'SENT', 'SENT'],
      'all 3 queued payouts drained in a single tick'
    );
    assert.deepEqual(
      sentOrders.map((o) => o.nonce),
      [1, 2, 3],
      'strict sequential nonces without collision'
    );

    // Next tick confirms all 3 and compacts confirmed bank-nonce claims below confirmedFloor (4)
    await s.tick();
    await s.idle();
    assert.deepEqual(
      orders.map((o) => s.state.outbound[o.id].status),
      ['CONFIRMED', 'CONFIRMED', 'CONFIRMED']
    );
    const remainingNonceClaims = await s._persist.listClaims('bank-nonce:');
    assert.equal(remainingNonceClaims.length, 0, `expected confirmed nonce claims pruned, got ${JSON.stringify(remainingNonceClaims)}`);

    // Verify MinepoaClient.nextNonce resolves same-second timestamp ties by taking highest nonce
    const sameSec = 1790000000;
    const fakeClient = new MinepoaClient({
      nodeUrl: 'http://fake.local',
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('/api/explorer/address/')) {
          return new Response(
            JSON.stringify({
              address: bank.address,
              balance: '10.000000',
              txs: [
                { id: 'a'.repeat(64), from_addr: bank.address, to_addr: r1.address, amount: '1.000000', ts: sameSec, height: 10 },
                { id: 'b'.repeat(64), from_addr: bank.address, to_addr: r2.address, amount: '1.000000', ts: sameSec, height: 12 },
                { id: 'c'.repeat(64), from_addr: bank.address, to_addr: r3.address, amount: '1.000000', ts: sameSec, height: 11 }
              ]
            }),
            { status: 200 }
          );
        }
        if (u.includes('/api/receipt/' + 'a'.repeat(64))) return new Response(JSON.stringify({ next_nonce: 5 }), { status: 200 });
        if (u.includes('/api/receipt/' + 'b'.repeat(64))) return new Response(JSON.stringify({ next_nonce: 7 }), { status: 200 });
        if (u.includes('/api/receipt/' + 'c'.repeat(64))) return new Response(JSON.stringify({ next_nonce: 6 }), { status: 200 });
        return new Response('{}', { status: 404 });
      }
    });
    assert.equal(await fakeClient.nextNonce(bank.address), 7);
  } finally {
    await srv.close();
    await mock.close();
  }
});
