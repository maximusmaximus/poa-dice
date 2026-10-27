// @ts-nocheck
/**
 * fix/ord-memo-match. Live on 2026-10-26 (Vercel, pass mode): a bet-win payout (1.98 POA, memo
 * `...:ord=cc6c6ab82ed5`) was broadcast and landed on the ledger, but the vault document still had the
 * order as QUEUED with no txid: the pass that sent it lost the writer lease's last seconds, where saving
 * the document is a silent no-op, and broadcast anyway. The next writer saw a bank outflow its document
 * did not know and went read-only (STALE_STORE).
 *
 * Covered here (local mock minepoa only; nothing touches minepoa.com):
 *  - the write-ahead must be durable before a payout leaves the box (no broadcast when it cannot be saved);
 *  - a payout broadcast by a pass that was cut off before saving is matched to its order on the next
 *    takeover (by our own payout claim, or by the `:ord=` tag + recipient + exact amount), the order is
 *    CONFIRMED with that txid, nothing is paid again and the site does not go read-only;
 *  - a signed-but-unsent body is resumed with the same txid;
 *  - a tagged bank outflow with the wrong amount or recipient is never adopted: it still holds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-ord-${t}-`));
const ts = () => Math.floor(Date.now() / 1000);
const tx = (mock, wallet, to, amount, memo) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });

async function boot({ mock, bank, store, tag }) {
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
    adminToken: 'ord-test-admin',
    cronSecret: 'ord-test-cron',
    passMode: true,
    passEveryMs: 100,
    readPassBudgetMs: 3000,
    ledgerProbeIntervalMs: 0,
    ledgerProbeMinHoldMs: 0,
    sentGraceMs: 0,
    rejectCheckIntervalMs: 0
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  const pass = async (n = 1) => {
    for (let i = 0; i < n; i++) await app.settlement.tick();
    await app.settlement.idle();
  };
  return { app, s: app.settlement, pass, url: info.url, close: () => app.close() };
}

/** Bank with a 500 POA LP, and a second LP (q) that stakes 20 POA; returns everything plus a booted node. */
async function setup(tag) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  const q = genKeypair();
  mock.setBalance(p.address, '1000.000000');
  mock.setBalance(q.address, '100.000000');
  const store = createMemoryStore(null);
  const a = await boot({ mock, bank, store, tag: `${tag}-a` });
  mock.directSubmit(tx(mock, p, bank.address, '500.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  mock.directSubmit(tx(mock, q, bank.address, '20.000000', formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  mock.finalizeAll();
  await a.pass(3);
  assert.equal(a.s.writer.binding?.bankAddress, bank.address, 'store bound');
  const nodes = [a];
  return {
    mock,
    bank,
    p,
    q,
    store,
    a,
    boot: async (t) => {
      const x = await boot({ mock, bank, store, tag: `${tag}-${t}` });
      nodes.push(x);
      return x;
    },
    /** q asks to withdraw everything: the vault owes q one LP_WITHDRAW_PAYOUT. */
    withdraw: () => {
      mock.directSubmit(tx(mock, q, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' })).body);
      mock.finalizeAll();
    },
    close: async () => {
      for (const x of nodes) await x.close().catch(() => {});
      await mock.close();
    }
  };
}

const payoutsTo = (mock, bank, to) => mock.transfersFrom(bank.address).filter((t) => t.body.to === to);
const order = (s) => Object.values(s.state.outbound).find((o) => o.kind === 'LP_WITHDRAW_PAYOUT');
const storedOrder = (store) => Object.values(store.load().outbound).find((o) => o.kind === 'LP_WITHDRAW_PAYOUT');

/**
 * The stored document as the live one looked after the cut-off pass: the order is QUEUED with no txid and
 * no attempts, the engine item is still in settlement, and the document never indexed the payout tx.
 */
function forgetPayout(store, orderId, txid) {
  const doc = store.load();
  const o = doc.outbound[orderId];
  Object.assign(o, { status: 'QUEUED', txid: null, body: null, nonce: null, attempts: 0, sentAt: undefined, signedAt: undefined, confirmedAt: undefined, confirmedVia: undefined, lastError: null, superseded: [] });
  delete doc.ledgerOut[txid];
  if (doc.trustedBank) doc.trustedBank.listedOutIds = (doc.trustedBank.listedOutIds || []).filter((id) => id !== txid);
  for (const item of doc.engine.outboundQueue || []) {
    if (item.orderId === orderId) Object.assign(item, { status: 'IN_SETTLEMENT', ledgerTxid: null });
  }
  doc.savedAt = Date.now();
  store.save(doc);
}

async function payNormally(c) {
  c.withdraw();
  await c.a.pass(4);
  const rec = order(c.a.s);
  assert.ok(rec, 'the withdrawal created a payout order');
  assert.equal(rec.status, 'CONFIRMED', JSON.stringify(rec));
  assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1);
  return rec;
}

// ─── 1. write-ahead ─────────────────────────────────────────────────────────

test('write-ahead: a payout is never broadcast while its signed body cannot be saved (lease in its last seconds)', async () => {
  const c = await setup('wal');
  try {
    c.withdraw();
    const s = c.a.s;
    const realCanWrite = s.writer.canWrite.bind(s.writer);
    const realParents = s._parents.bind(s);
    let nearExpiry = false;
    // Signing took long enough that the lease is within its last seconds: _save() would be a silent no-op.
    s._parents = async () => {
      const r = await realParents();
      nearExpiry = true;
      return r;
    };
    s.writer.canWrite = () => (nearExpiry ? false : realCanWrite());
    const submitted = [];
    const realSubmit = s.client.submitTx.bind(s.client);
    s.client.submitTx = async (body) => {
      // whatever leaves the box must already be in the stored document
      const o = storedOrder(c.store);
      submitted.push({ body, storedTxid: o?.txid ?? null, storedStatus: o?.status ?? null });
      return realSubmit(body);
    };
    await c.a.pass(1);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 0, 'not broadcast: the write-ahead could not be saved');
    assert.equal(submitted.length, 0);
    assert.match(String(s.lastError), /write-ahead not saved/);
    // The lease is healthy again: the same order is signed (same claimed body) and paid exactly once.
    s._parents = realParents;
    nearExpiry = false;
    s.writer.canWrite = realCanWrite;
    await c.a.pass(4);
    const paid = payoutsTo(c.mock, c.bank, c.q.address);
    assert.equal(paid.length, 1, 'paid exactly once');
    assert.ok(submitted.length >= 1);
    for (const x of submitted) {
      assert.ok(x.storedTxid, 'the stored document had the txid before the broadcast');
      assert.equal(x.storedTxid, paid[0].id);
    }
    assert.equal(order(s).status, 'CONFIRMED');
  } finally {
    await c.close();
  }
});

// ─── 2. cut off before persisting: recovery on the next takeover ────────────

test('cut-off pass replay: the landed payout is matched by its payout claim on takeover; CONFIRMED, never re-sent, no read-only', async () => {
  const c = await setup('claim');
  try {
    const rec = await payNormally(c);
    const { orderId, txid } = rec;
    assert.ok(c.store.peek(`payout:${orderId}:0`), 'the payout claim (signed body) is in the store');
    await c.a.close();
    forgetPayout(c.store, orderId, txid);
    assert.equal(storedOrder(c.store).status, 'QUEUED');

    const b = await c.boot('b');
    const submitsBefore = c.mock.submits.length;
    await b.pass(3);
    assert.equal(b.s.writer.status !== 'STALE_STORE', true, `not read-only: ${JSON.stringify(b.s.writer.view().blocked)}`);
    assert.equal(b.s.writer.blocked, null);
    const got = order(b.s);
    assert.equal(got.status, 'CONFIRMED');
    assert.equal(got.txid, txid, 'matched to the transfer that landed');
    assert.match(got.matchedFromLedger.via, /payout-claim/);
    assert.equal(storedOrder(c.store).txid, txid, 'durable');
    // never paid again, nothing new broadcast for it
    for (let i = 0; i < 5; i++) await b.pass(1);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1, 'still exactly one payout');
    assert.equal(c.mock.submits.slice(submitsBefore).filter((x) => x?.to === c.q.address || x?.body?.to === c.q.address).length, 0, 'nothing re-submitted to the player');
    assert.equal(b.s.reconcile.status, 'OK', b.s.reconcile.reason);
    assert.deepEqual(b.s.foreign.filter((f) => !f.acknowledged), []);
    const audit = await b.s.auditAgainstChain();
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.equal(audit.internal.outboundNotYetSentPoa, '0.000000');
  } finally {
    await c.close();
  }
});

test('cut-off pass replay without a payout claim: matched by the ord= memo tag + recipient + exact amount', async () => {
  const c = await setup('tag');
  try {
    const rec = await payNormally(c);
    const { orderId, txid } = rec;
    await c.a.close();
    forgetPayout(c.store, orderId, txid);
    c.store.claims.delete(`payout:${orderId}:0`); // no claim to prove it: only the ledger memo tag

    const b = await c.boot('b');
    await b.pass(3);
    assert.equal(b.s.writer.blocked, null, 'not STALE_STORE');
    const got = order(b.s);
    assert.equal(got.status, 'CONFIRMED');
    assert.equal(got.txid, txid);
    assert.match(got.matchedFromLedger.via, /ord-tag/);
    for (let i = 0; i < 5; i++) await b.pass(1);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1, 'never paid twice');
    assert.equal(b.s.reconcile.status, 'OK', b.s.reconcile.reason);
  } finally {
    await c.close();
  }
});

test('a pass that sees the landed payout (without a takeover) matches it by ord= tag before reconciling: no hold, no second payout', async () => {
  const c = await setup('pass');
  try {
    const rec = await payNormally(c);
    const { orderId, txid } = rec;
    // The writer's own in-memory copy loses the record too (e.g. it reloads the stored copy): same pass flow.
    forgetPayout(c.store, orderId, txid);
    c.store.claims.delete(`payout:${orderId}:0`);
    const s = c.a.s;
    s._lastPass = null; // next pass re-takes the lease and reloads the stored document
    s._leaderToken = null;
    await c.a.pass(2);
    const got = order(s);
    assert.equal(got.txid, txid);
    assert.equal(got.status, 'CONFIRMED');
    assert.equal(s.writer.blocked, null);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1);
    assert.equal(s.reconcile.status, 'OK', s.reconcile.reason);
  } finally {
    await c.close();
  }
});

test('signed but never sent (cut off between claim and broadcast): resumes with the same body and txid, paid once', async () => {
  const c = await setup('resume');
  try {
    c.withdraw();
    const s = c.a.s;
    const realSubmit = s.client.submitTx.bind(s.client);
    s.client.submitTx = async () => {
      throw Object.assign(new Error('timeout'), { timeout: true }); // cut off: nothing reached minepoa
    };
    await c.a.pass(1);
    const claimed = c.store.peek(`payout:${order(s).orderId}:0`);
    assert.ok(claimed && claimed.txid, 'signed body claimed');
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 0);
    s.client.submitTx = realSubmit;
    await c.a.close();
    forgetPayout(c.store, claimed.body ? order(s).orderId : null, claimed.txid);

    const b = await c.boot('b');
    await b.pass(4);
    const paid = payoutsTo(c.mock, c.bank, c.q.address);
    assert.equal(paid.length, 1, 'paid exactly once');
    assert.equal(paid[0].id, claimed.txid, 'the same signed body (same txid, same nonce)');
    assert.equal(order(b.s).txid, claimed.txid);
    assert.ok(order(b.s).recoveredFromClaim, 'resumed from the stored claim');
  } finally {
    await c.close();
  }
});

// ─── 3. mismatches still hold ───────────────────────────────────────────────

async function queuedOrder(c) {
  c.withdraw();
  const s = c.a.s;
  const realNonce = s._chooseBankNonce.bind(s);
  s._chooseBankNonce = async () => {
    throw new Error('test: signing paused');
  };
  await c.a.pass(2);
  const rec = order(s);
  assert.equal(rec.status, 'QUEUED');
  assert.equal(rec.txid, null);
  return { rec, unpause: () => (s._chooseBankNonce = realNonce) };
}

for (const variant of ['amount', 'recipient']) {
  test(`a bank transfer tagged ord=<order> with the wrong ${variant} is NOT matched: held, the order is not paid again`, async () => {
    const c = await setup(`mis-${variant}`);
    try {
      const { rec, unpause } = await queuedOrder(c);
      const other = genKeypair();
      const to = variant === 'recipient' ? other.address : c.q.address;
      const amount = variant === 'amount' ? '1.000000' : rec.amountPoa;
      const bad = tx(c.mock, c.bank, to, amount, `${rec.memo}`); // same memo, ord= tag included
      assert.match(bad.body.memo, new RegExp(`:ord=${rec.orderId.slice(0, 12)}`));
      const badId = c.mock.directSubmit(bad.body);
      c.mock.finalizeAll();
      unpause();
      await c.a.pass(3);
      const s = c.a.s;
      const got = order(s);
      assert.notEqual(got.txid, badId, 'never adopted');
      assert.ok(!['SENT', 'CONFIRMED', 'SIGNED'].includes(got.status), `order stays unpaid (${got.status})`);
      assert.match(String(got.lastError), /not paid/);
      const f = s.foreign.find((x) => x.txid === badId);
      assert.ok(f, 'listed as a foreign outflow');
      assert.match(f.reason, /does not match/);
      assert.notEqual(s.reconcile.status, 'OK', 'trading is held');
      // only the bad transfer left the bank for this order; nothing else was sent
      const sent = c.mock.transfersFrom(c.bank.address).filter((t) => t.body.memo.includes(`:ord=${rec.orderId.slice(0, 12)}`));
      assert.equal(sent.length, 1);
      // A fresh writer whose stored document never indexed that transfer refuses to sign (as today):
      // a mismatched tag does not explain it.
      await c.a.close();
      const doc = c.store.load();
      delete doc.ledgerOut[badId];
      c.store.save(doc);
      const b = await c.boot('b');
      await b.pass(1);
      assert.equal(b.s.writer.status, 'STALE_STORE');
      assert.deepEqual(b.s.writer.blocked.outflows, [badId]);
      assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, variant === 'recipient' ? 0 : 1, 'nothing paid to the player by the vault');
    } finally {
      await c.close();
    }
  });
}

test('an order already CONFIRMED by one tx: a second identical tagged transfer is a foreign outflow (no double-book)', async () => {
  const c = await setup('second');
  try {
    const rec = await payNormally(c);
    const dup = tx(c.mock, c.bank, c.q.address, rec.amountPoa, rec.memo);
    const dupId = c.mock.directSubmit(dup.body);
    c.mock.finalizeAll();
    await c.a.pass(2);
    const s = c.a.s;
    assert.equal(order(s).txid, rec.txid, 'the order keeps its own payout');
    assert.ok(s.foreign.some((f) => f.txid === dupId), 'the extra transfer holds');
    assert.notEqual(s.reconcile.status, 'OK');
  } finally {
    await c.close();
  }
});

// ─── 4. audit: CONFIRMED payouts the ledger history never shows ─────────────

test('audit lists a CONFIRMED payout that a complete ledger read does not show (informational, never re-paid)', async () => {
  const c = await setup('notonledger');
  try {
    const rec = await payNormally(c);
    const s = c.a.s;
    s.stuckAfterMs = 0;
    let audit = await s.auditAgainstChain();
    assert.deepEqual(audit.confirmedNotOnLedger, [], 'listed on the ledger: nothing to report');
    c.mock.hide(rec.txid); // the ledger's history never shows it (live: payout 269433a2, receipt "included")
    delete s.state.bankHistory.txs[rec.txid]; // ...and the vault never recorded it as listed
    s.state.bankHistory.complete = false;
    const realRecent = s.client.getRecentTransfers.bind(s.client);
    s.client.getRecentTransfers = async (n) => {
      const m = await realRecent(n);
      m.delete(rec.txid);
      return m;
    };
    audit = await s.auditAgainstChain();
    assert.equal(audit.confirmedNotOnLedger.length, 1);
    assert.equal(audit.confirmedNotOnLedger[0].txid, rec.txid);
    await c.a.pass(3);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1, 'never re-paid automatically');
  } finally {
    await c.close();
  }
});
