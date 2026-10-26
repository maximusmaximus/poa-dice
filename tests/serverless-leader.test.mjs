// @ts-nocheck
/**
 * fix/serverless-leader. On Vercel, requests land on many instances while one hidden instance holds the
 * bank writer lease. These tests pin the serverless rules: a standby validates and broadcasts player-signed
 * txs and records them for the writer (it never signs); the writer publishes its status to the shared
 * store every tick and every other instance refuses bets when that status is stale; the cron tick
 * endpoint settles a pending bet exactly once across instances; a foreign-outflow ack works from any
 * instance. Everything runs against the local mock minepoa; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-serverless-${t}-`));
const ADMIN = 'serverless-test-admin';
const CRON = 'serverless-test-cron';

async function boot({ mock, bank, store, tag, opts = {} }) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: store,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    adminToken: ADMIN,
    cronSecret: CRON,
    ...opts
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 15));
    }
    await app.settlement.idle();
  };
  const req = async (p, { method = 'GET', body, auth } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const r = await fetch(`${info.url}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { app, s: app.settlement, url: info.url, settle, req, close: () => app.close() };
}

const ts = () => Math.floor(Date.now() / 1000);
const tx = (mock, wallet, to, amount, memo) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });
const bet = (mock, p, bank, seed, target = 9500) => tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: target, clientSeed: seed }));

/** One shared store (the Postgres stand-in), a writer A and a standby B, 20 POA in the bank. */
async function pair(tag, { bOpts = {} } = {}) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const store = createMemoryStore(null);
  const a = await boot({ mock, bank, store, tag: `${tag}-a` });
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  await a.settle();
  const b = await boot({ mock, bank, store, tag: `${tag}-b`, opts: bOpts });
  await b.settle(2);
  assert.equal(a.s.writer.status, 'LEADER');
  assert.equal(b.s.writer.status, 'STANDBY');
  return { mock, bank, p, store, a, b, close: async () => { await a.close(); await b.close(); await mock.close(); } };
}

test('standby: accepts a player-signed bet, broadcasts it and records it for the writer without signing; the writer settles it', async () => {
  const t = await pair('accept');
  const { mock, bank, p, store, a, b } = t;
  try {
    const h = await b.req('/api/health');
    assert.equal(h.body.settlement.trading, 'OPEN', 'the standby follows the writer\'s published status');
    assert.equal(h.body.settlement.leader.active, true);
    assert.equal(h.body.settlement.leader.thisInstance, 'STANDBY');
    const x = bet(mock, p, bank, 'via-standby');
    const r = await b.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.receipt.txid, x.id);
    assert.equal(r.body.receipt.status, 'PENDING_CONFIRMATION');
    assert.equal(r.body.receipt.acceptedBy, 'standby');
    assert.ok(mock.tx(x.id), 'broadcast to minepoa');
    const acc = await store.peek(`accepted:${x.id}`);
    assert.ok(acc, 'recorded in the shared store for the writer');
    assert.equal(acc.seedCommit.hash, a.app.engine.seedManager.currentSeedHash, 'committed to the writer\'s seed');
    assert.equal(acc.coverage.key, x.id, 'worst case reserved in the shared coverage book');
    assert.equal(await store.peek(`bet:${x.id}`), null, 'the standby never rolls');
    // The standby alone never signs, settles or pays.
    await b.settle(6);
    assert.equal(b.s.writer.canWrite(), false);
    assert.equal(b.app.engine.processedTxids.has(x.id), false, 'not booked before the writer runs');
    assert.equal(mock.transfersFrom(bank.address).length, 0, 'the bank signed nothing');
    // Same tx again on the standby: not a second broadcast or reservation.
    const again = await b.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
    assert.equal(again.status, 202);
    assert.equal(again.body.receipt.duplicate, true);
    // The writer books it from the ledger with the standby's acceptance (seed + coverage).
    await a.settle(6);
    const booked = a.app.engine.processedTxids.get(x.id);
    assert.ok(booked, 'the writer rolled it');
    const rec = a.s.state.inbound[x.id];
    assert.equal(rec.acceptedBy, 'standby');
    assert.equal(rec.status, 'BOOKED');
    const paid = mock.transfersFrom(bank.address).filter((o) => String(o.body.memo).includes(x.id.slice(0, 16)));
    assert.equal(paid.length, booked.won ? 1 : 0, 'paid at most once, by the writer');
    // The standby mirror shows the result.
    await b.settle(2);
    assert.equal(b.s.getTxStatus(x.id).rawStatus, 'BOOKED');
  } finally {
    await t.close();
  }
});

test('stale writer status: every other instance reports no active writer and refuses bets (never opens trading)', async () => {
  const t = await pair('stale', { bOpts: { leaderStatusMaxAgeMs: 400 } });
  const { mock, bank, p, b, a } = t;
  try {
    assert.equal((await b.req('/api/health')).body.settlement.trading, 'OPEN');
    // The writer stops ticking (frozen instance) but its lease has not expired yet.
    await new Promise((r) => setTimeout(r, 600));
    await b.settle(1);
    assert.equal(b.s.writer.status, 'STANDBY', 'the lease is still held elsewhere');
    const h = await b.req('/api/health');
    assert.equal(h.body.settlement.trading, 'NO_ACTIVE_LEADER');
    assert.equal(h.body.settlement.leader.active, false);
    const x = bet(mock, p, bank, 'stale-writer');
    const r = await b.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(JSON.stringify(r.body), /No bank writer is active/);
    assert.equal(mock.tx(x.id), undefined, 'not broadcast');
    assert.equal(await t.store.peek(`accepted:${x.id}`), null, 'nothing recorded');
    const q = b.s.coverageLimit();
    assert.equal(q.known, false, 'no coverage while no writer is active');
    // The writer reports in again: trading follows its status.
    await a.settle(1);
    await b.settle(1);
    assert.equal((await b.req('/api/health')).body.settlement.trading, 'OPEN');
  } finally {
    await t.close();
  }
});

test('no writer status at all (fresh instance, nothing published): standby refuses bets', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const store = createMemoryStore(null);
  const a = await boot({ mock, bank, store, tag: 'nostatus-a' });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await a.settle();
    store.putStatus('leader-status', null); // wiped
    const b = await boot({ mock, bank, store, tag: 'nostatus-b' });
    try {
      await b.settle(1);
      assert.equal(b.s.writer.status, 'STANDBY');
      assert.equal(b.s.tradingHold().status, 'NO_ACTIVE_LEADER');
      const x = bet(mock, p, bank, 'no-status');
      await assert.rejects(() => b.s.submitInbound(x), (e) => e.status === 503 && e.code === 'NO_ACTIVE_LEADER');
      assert.equal(mock.tx(x.id), undefined);
    } finally {
      await b.close();
    }
  } finally {
    await a.close();
    await mock.close();
  }
});

test('cron tick endpoint: authenticated; a pending bet is settled exactly once across two instances and a lease handover', async () => {
  const t = await pair('tick');
  const { mock, bank, p, store, a, b } = t;
  try {
    assert.equal((await a.req('/api/settlement/tick')).status, 401);
    assert.equal((await a.req('/api/settlement/tick', { auth: 'wrong' })).status, 401);
    assert.equal((await b.req('/api/settlement/tick', { auth: CRON })).status, 200);
    assert.equal((await b.req('/api/settlement/tick', { method: 'POST', auth: ADMIN })).status, 200);
    const x = bet(mock, p, bank, 'cron-settled');
    const r = await b.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    // Vercel Cron hits whichever instance it lands on, possibly several at once.
    for (let i = 0; i < 4; i++) {
      const res = await Promise.all([a.req('/api/settlement/tick', { auth: CRON }), b.req('/api/settlement/tick', { auth: CRON })]);
      for (const x2 of res) assert.equal(x2.status, 200);
      assert.equal(res.filter((x2) => x2.body.writer.status === 'LEADER').length, 1, 'exactly one writer per pass');
    }
    const first = a.app.engine.processedTxids.get(x.id);
    assert.ok(first, 'settled by the lease holder');
    // Lease handover: the old writer goes away; the next cron pass on the other instance takes over.
    await a.s.writer.release();
    a.s.stop();
    for (let i = 0; i < 4; i++) assert.equal((await b.req('/api/settlement/tick', { auth: CRON })).status, 200);
    assert.equal(b.s.writer.status, 'LEADER');
    const again = b.app.engine.processedTxids.get(x.id);
    assert.ok(again);
    assert.equal(again.rollBps, first.rollBps, 'never re-rolled');
    const paid = mock.transfersFrom(bank.address).filter((o) => String(o.body.memo).includes(x.id.slice(0, 16)));
    assert.equal(paid.length, first.won ? 1 : 0, 'paid exactly once');
    assert.ok(await store.peek(`bet:${x.id}`), 'roll claimed once in the shared store');
    const status = store.getStatus('leader-status');
    assert.equal(status.holder, b.s.writer.holderId, 'the new writer publishes the status');
    assert.ok(Date.now() - status.at < 5000);
  } finally {
    await t.close();
  }
});

test('tick endpoint is disabled without CRON_SECRET or admin token', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const a = await boot({ mock, bank, store: createMemoryStore(null), tag: 'tick-off', opts: { cronSecret: null, adminToken: null } });
  try {
    assert.equal((await a.req('/api/settlement/tick', { auth: 'anything' })).status, 403);
  } finally {
    await a.close();
    await mock.close();
  }
});

test('foreign-outflow ack from a standby: recorded in the shared store, applied by the writer on its next pass', async () => {
  const t = await pair('ack');
  const { mock, bank, p, a, b } = t;
  try {
    const rogue = tx(mock, bank, p.address, '3.961584', 'DICE1:WIN:fd08906b0d6d5dd9:roll=83.42');
    mock.directSubmit(rogue.body);
    await a.settle();
    await b.settle(2);
    let h = await b.req('/api/health');
    assert.equal(h.body.settlement.trading, 'HOLD');
    assert.deepEqual(h.body.settlement.foreignOutflows.map((f) => f.txid), [rogue.id]);
    const held = bet(mock, p, bank, 'during-hold');
    const refused = await b.req('/api/tx/submit', { method: 'POST', body: { tx: held } });
    assert.equal(refused.status, 503, 'the standby applies the writer\'s hold');
    assert.equal(mock.tx(held.id), undefined, 'not broadcast');
    // unknown txid / bad mode / no token: refused
    assert.equal((await b.req('/api/admin/foreign-outflows/ack', { method: 'POST', auth: ADMIN, body: { txids: ['ff'.repeat(32)], mode: 'reimbursed' } })).status, 409);
    assert.equal((await b.req('/api/admin/foreign-outflows/ack', { method: 'POST', auth: ADMIN, body: { txids: [rogue.id], mode: 'ignore' } })).status, 409);
    assert.equal((await b.req('/api/admin/foreign-outflows/ack', { method: 'POST', body: { txids: [rogue.id], mode: 'reimbursed' } })).status, 401);
    // Reimbursed: the funds come back to the bank, then the ack.
    mock.directSubmit(tx(mock, p, bank.address, '3.961584', 'refund of foreign outflow').body);
    const ack = await b.req('/api/admin/foreign-outflows/ack', { method: 'POST', auth: ADMIN, body: { txids: [rogue.id], mode: 'reimbursed', note: 'returned to the bank' } });
    assert.equal(ack.status, 200, JSON.stringify(ack.body));
    assert.equal(ack.body.appliedBy, 'the bank writer on its next pass');
    assert.equal(b.s.writer.canWrite(), false);
    await a.settle();
    assert.equal(a.s.state.foreignAck[rogue.id].mode, 'reimbursed');
    assert.equal(a.s.reconcile.status, 'OK', JSON.stringify(a.s.reconcile));
    await b.settle(2);
    h = await b.req('/api/health');
    assert.equal(h.body.settlement.trading, 'OPEN');
    assert.equal(fromMicros(a.app.engine.bankNavMicros), fromMicros(toMicros('20.000000')), 'reimbursed: books unchanged');
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'the vault itself sent nothing');
  } finally {
    await t.close();
  }
});

test('real Postgres: the writer publishes a fenced status row; a standby reads it, accepts a bet and cannot write the status', { skip: !process.env.POA_DICE_TEST_PG_URL }, async () => {
  const { createPostgresStore } = await import('../src/settlement-store.mjs');
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const key = `test-${Date.now()}-${Math.random().toString(16).slice(2)}:vault`;
  const mk = () => createPostgresStore({ connectionString: process.env.POA_DICE_TEST_PG_URL, key });
  const sa = mk();
  const sb = mk();
  const a = await boot({ mock, bank, store: sa, tag: 'pg-a' });
  const b = await boot({ mock, bank, store: sb, tag: 'pg-b' });
  try {
    mock.directSubmit(tx(mock, p, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
    await a.settle();
    await b.settle(2);
    const [w, sby] = a.s.writer.status === 'LEADER' ? [a, b] : [b, a];
    assert.equal(sby.s.writer.status, 'STANDBY');
    const st = await (sby === b ? sb : sa).getStatus('leader-status');
    assert.equal(st.holder, w.s.writer.holderId);
    assert.equal(st.trading, 'OPEN');
    await assert.rejects(() => (sby === b ? sb : sa).putStatus('leader-status', { forged: true }), /fenced off/);
    const x = bet(mock, p, bank, 'pg-standby');
    const r = await sby.req('/api/tx/submit', { method: 'POST', body: { tx: x } });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    await w.settle(6);
    assert.ok(w.app.engine.processedTxids.get(x.id));
    assert.equal(w.s.state.inbound[x.id].acceptedBy, 'standby');
  } finally {
    await a.close();
    await b.close();
    await mock.close();
  }
});
