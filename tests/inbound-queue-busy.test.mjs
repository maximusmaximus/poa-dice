// @ts-nocheck
/**
 * fix/inbound-queue-busy-unknown. Live on 2026-10-27: a bet (c9b155eb, final on the ledger at 8:55 PM PT)
 * was never rolled. An older record (daba9f3f) of a bet the site had REFUSED before broadcast ("vault write
 * fenced off") was in the store as BROADCAST. minepoa's explorer answered 503 "origin busy" for that
 * unknown txid (while it answered real txs normally), and the inbound loop stopped at the first lookup
 * error, so every later bet waited behind it and the 30-minute expiry never ran.
 *
 * Covered here (local mock minepoa only):
 *  - an older unknown tx (busy on the explorer, 404 "unknown txid" on the receipt) does not hold up a newer
 *    final bet, which is booked;
 *  - that unknown tx expires after the window, but never while an independent index (POAScan) has it;
 *  - a busy / unanswerable lookup for one tx skips only that tx;
 *  - a submit refused before broadcast (write-ahead failed) leaves no record in the store.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { BusyError } from '../src/minepoa-client.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-inq-${t}-`));
const ts = () => Math.floor(Date.now() / 1000);
const MIN = 60 * 1000;
const bet = (mock, wallet, to, amount, { nonce, targetBps = 5000 } = {}) =>
  buildSignedTransfer({ wallet, to, amount, memo: formatDiceMemo({ action: 'BET', direction: 'under', targetBps }), nonce: nonce ?? mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });

/** Memory store behind an async (write-behind) persist queue, like Postgres / KV; saves can be made to fail. */
function asyncStore() {
  const mem = createMemoryStore(null);
  const ctl = { failFor: null }; // txid: every save of a document that carries it is fenced off, once it fails

  const store = {
    ...mem,
    async: true,
    async save(d) {
      if (ctl.failFor && d.inbound && d.inbound[ctl.failFor]) {
        throw new Error('vault write fenced off: this instance no longer holds the bank writer lease');
      }
      mem.save(d);
    }
  };
  return { store, ctl };
}

async function setup(tag, { autoFinal = true, async = false } = {}) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal });
  const bank = genKeypair();
  const lp = genKeypair();
  const player = genKeypair();
  const player2 = genKeypair();
  mock.setBalance(lp.address, '1000.000000');
  mock.setBalance(player.address, '100.000000');
  mock.setBalance(player2.address, '100.000000');
  const st = async ? asyncStore() : { store: createMemoryStore(null), ctl: null };
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: st.store,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    adminToken: 'inq-admin',
    cronSecret: 'inq-cron',
    passMode: true,
    passEveryMs: 100,
    readPassBudgetMs: 3000,
    ledgerProbeIntervalMs: 0,
    ledgerProbeMinHoldMs: 0,
    sentGraceMs: 0,
    rejectCheckIntervalMs: 0
  });
  await app.listen(0, '127.0.0.1');
  const s = app.settlement;
  s.client.retryBaseMs = 5;
  await s.ready();
  const pass = async (n = 1) => {
    for (let i = 0; i < n; i++) await s.tick();
    await s.idle();
  };
  mock.directSubmit(buildSignedTransfer({ wallet: lp, to: bank.address, amount: '500.000000', memo: formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }), nonce: mock.nextNonce(lp.address), parents: mock.parents(), ts: ts() }).body);
  mock.finalizeAll();
  await pass(3);
  assert.equal(s.writer.binding?.bankAddress, bank.address, 'store bound');
  return {
    mock,
    bank,
    player,
    player2,
    s,
    store: st.store,
    ctl: st.ctl,
    pass,
    close: async () => {
      await app.close().catch(() => {});
      await mock.close();
    }
  };
}

/**
 * Put a never-broadcast bet into the STORED vault document as SUBMITTING, older than every other record:
 * what the live store held for daba9f3f after its submit was refused. The next pass reloads it.
 */
function plantGhost(c, signed, { ageMs }) {
  const doc = c.store.load();
  doc.inbound[signed.id] = {
    txid: signed.id,
    seq: 0,
    from: signed.body.from,
    amountPoa: signed.body.amount,
    memo: signed.body.memo,
    action: 'BET',
    seedCommit: null,
    status: 'SUBMITTING',
    submittedAt: Date.now() - ageMs,
    reserve: null,
    coverage: null,
    groupId: null,
    attempts: 0,
    error: null,
    result: null,
    ledger: null
  };
  c.store.save(doc);
  c.s._leaderToken = null; // the next pass starts from the stored document
}

test('an older unknown tx (explorer busy, receipt 404) does not hold up a newer final bet; it expires after the window', async () => {
  const c = await setup('ghost');
  try {
    const nonce = c.mock.nextNonce(c.player.address);
    const ghost = bet(c.mock, c.player, c.bank.address, '1.690000', { nonce });
    plantGhost(c, ghost, { ageMs: 1 * MIN });
    c.mock.setBusyForUnknownTx(60); // minepoa: 503 "origin busy" for unknown txids, real ones answer normally
    await c.pass(1);
    assert.equal(c.s.state.inbound[ghost.id]?.status, 'BROADCAST', 'stored SUBMITTING is reloaded as BROADCAST');
    assert.equal(c.s.state.inbound[ghost.id]?.recoveredFrom, 'SUBMITTING');

    // The same player signs again with the same nonce (as the runner did): final on the ledger at once.
    const real = bet(c.mock, c.player, c.bank.address, '1.690000', { nonce, targetBps: 7146 });
    assert.notEqual(real.id, ghost.id);
    await c.s.submitInbound(real);
    await c.pass(3);
    assert.equal(c.s.getTxStatus(real.id)?.rawStatus, 'BOOKED', `newer final bet is booked: ${JSON.stringify(c.s.getTxStatus(real.id))}`);
    assert.equal(c.s.state.inbound[ghost.id].status, 'BROADCAST', 'still inside the window: not expired yet');
    assert.ok(c.s.client.busy(`tx:${ghost.id}`), 'the busy answer for the unknown txid is kept for that txid only');

    // Past the window: an independent index that HAS the tx blocks the expiry (never expire a tx on the ledger).
    const doc = c.store.load();
    doc.inbound[ghost.id].submittedAt = Date.now() - 31 * MIN;
    c.store.save(doc);
    c.s._leaderToken = null;
    let asked = 0;
    c.s.indexer = { name: 'POAScan', lookupTx: async () => (asked++, { found: true, tx: { id: ghost.id, final: true } }) };
    await c.pass(1);
    assert.ok(asked >= 1, 'POAScan asked before expiring');
    assert.equal(c.s.state.inbound[ghost.id].status, 'BROADCAST', 'not expired while POAScan lists it');

    // POAScan cannot answer (as live: "node unavailable"): minepoa's definite "unknown txid" stands.
    c.s.indexer = { name: 'POAScan', lookupTx: async () => { throw new Error('POAScan gave no definite answer'); } };
    await c.pass(1);
    const g = c.s.state.inbound[ghost.id];
    assert.equal(g.status, 'EXPIRED', JSON.stringify(g));
    assert.match(g.error, /Not seen on the minepoa ledger in time/);
    assert.equal(c.store.load().inbound[ghost.id].status, 'EXPIRED', 'expiry is in the store');
    assert.equal(c.s.getTxStatus(real.id).rawStatus, 'BOOKED');
  } finally {
    await c.close();
  }
});

test('a final tx is never expired, however old its record is', async () => {
  const c = await setup('final-old');
  try {
    const nonce = c.mock.nextNonce(c.player.address);
    const ghost = bet(c.mock, c.player, c.bank.address, '1.000000', { nonce });
    // The planted record is for a tx that DID land (submitted straight to the ledger), 2 hours ago.
    c.mock.directSubmit(ghost.body);
    c.mock.finalizeAll();
    plantGhost(c, ghost, { ageMs: 120 * MIN });
    c.mock.setBusyForUnknownTx(60);
    await c.pass(3);
    assert.equal(c.s.getTxStatus(ghost.id)?.rawStatus, 'BOOKED', JSON.stringify(c.s.getTxStatus(ghost.id)));
  } finally {
    await c.close();
  }
});

test('a busy lookup for one tx skips only that tx; the rest of the queue is booked, and it is booked once it answers', async () => {
  const c = await setup('skip', { autoFinal: false });
  try {
    const a = bet(c.mock, c.player, c.bank.address, '1.000000');
    await c.s.submitInbound(a);
    const b = bet(c.mock, c.player2, c.bank.address, '1.000000');
    await c.s.submitInbound(b);
    assert.ok(c.s.state.inbound[a.id].seq < c.s.state.inbound[b.id].seq, 'a is older');
    c.mock.finalizeAll();
    // minepoa is busy for a only: the explorer throws busy, the receipt has no verdict either.
    const realGetTx = c.s.client.getTx.bind(c.s.client);
    const realReceipt = c.s.client.receiptLookup.bind(c.s.client);
    let busyForA = true;
    c.s.client.getTx = async (id, opts) => {
      if (busyForA && id === a.id) throw new BusyError(`minepoa /api/explorer/tx -> HTTP 503 busy: origin busy`, { retryAfterMs: 60000, scope: `tx:${id}` });
      return realGetTx(id, opts);
    };
    c.s.client.receiptLookup = async (id) => (busyForA && id === a.id ? { state: 'unavailable', error: 'minepoa /api/receipt -> HTTP 503: origin busy' } : realReceipt(id));
    await c.pass(2);
    assert.equal(c.s.getTxStatus(b.id)?.rawStatus, 'BOOKED', `b booked: ${JSON.stringify(c.s.getTxStatus(b.id))}`);
    assert.notEqual(c.s.getTxStatus(a.id)?.rawStatus, 'BOOKED', 'a waits');
    assert.ok(['BROADCAST', 'SEEN'].includes(c.s.state.inbound[a.id].status), 'a is still open (not expired, not failed)');
    busyForA = false;
    await c.pass(2);
    assert.equal(c.s.getTxStatus(a.id)?.rawStatus, 'BOOKED', 'a booked once minepoa answers');
  } finally {
    await c.close();
  }
});

test('a node-wide outage (no HTTP answer) still stops the pass at the first lookup', async () => {
  const c = await setup('down', { autoFinal: false });
  try {
    const a = bet(c.mock, c.player, c.bank.address, '1.000000');
    await c.s.submitInbound(a);
    const b = bet(c.mock, c.player2, c.bank.address, '1.000000');
    await c.s.submitInbound(b);
    c.mock.finalizeAll();
    const looked = [];
    const realGetTx = c.s.client.getTx.bind(c.s.client);
    c.s.client.getTx = async (id, opts) => {
      if (id === a.id || id === b.id) {
        looked.push(id);
        throw new Error('minepoa /api/explorer/tx -> fetch failed');
      }
      return realGetTx(id, opts);
    };
    await c.s._confirmInbound();
    assert.deepEqual(looked, [a.id], 'stopped at the first unreachable lookup');
  } finally {
    await c.close();
  }
});

test('a submit refused before broadcast (write-ahead fenced off) leaves no record in the store', async () => {
  const c = await setup('refused', { async: true });
  try {
    const submitted = [];
    const realSubmit = c.s.client.submitTx.bind(c.s.client);
    c.s.client.submitTx = async (body) => {
      submitted.push(body);
      return realSubmit(body);
    };
    const x = bet(c.mock, c.player, c.bank.address, '1.690000');
    assert.equal(await c.s.writer.refresh(), true, 'this instance is the bank writer (main submit path)');
    c.ctl.failFor = x.id; // the write-ahead of this bet is fenced off
    await assert.rejects(c.s.submitInbound(x), (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /Vault store unavailable; not broadcast: vault write fenced off/);
      return true;
    });
    assert.equal(submitted.length, 0, 'nothing broadcast');
    assert.equal(c.s.state.inbound[x.id], undefined, 'not in memory');
    c.ctl.failFor = null; // lease healthy again: any queued snapshot would land now
    // Whatever the queue retries next (the failed snapshot carried the SUBMITTING record), it must not land.
    await c.s.flush();
    assert.equal(c.store.load().inbound[x.id], undefined, 'not in the store');
    await c.pass(2);
    assert.equal(c.store.load().inbound[x.id], undefined, 'still not in the store after a pass');
    assert.equal(c.s.state.inbound[x.id], undefined, 'and not reloaded from it');
    // The same signed bet goes through normally afterwards.
    await c.s.writer.refresh();
    const ok = await c.s.submitInbound(x);
    assert.equal(ok.txid, x.id);
    assert.ok(submitted.length === 1, 'broadcast once');
  } finally {
    await c.close();
  }
});

test('refused while this instance may not write: the failed snapshot is dropped, never written later', async () => {
  const c = await setup('refused-ro', { async: true });
  try {
    const x = bet(c.mock, c.player, c.bank.address, '1.000000');
    assert.equal(await c.s.writer.refresh(), true);
    c.ctl.failFor = x.id;
    // The write-ahead fails, and by the time the refusal path runs this instance has lost the lease.
    const realFlush = c.s.flush.bind(c.s);
    let first = true;
    c.s.flush = async () => {
      try {
        return await realFlush();
      } finally {
        if (first) {
          first = false;
          c.s.writer.canWrite = () => false;
        }
      }
    };
    await assert.rejects(c.s.submitInbound(x), /not broadcast/);
    assert.equal(c.s._persist._pending, null, 'no snapshot left queued for retry');
    c.ctl.failFor = null;
    await realFlush().catch(() => {});
    assert.equal(c.store.load().inbound[x.id], undefined, 'not in the store');
  } finally {
    await c.close();
  }
});
