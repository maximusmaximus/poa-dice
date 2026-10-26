// @ts-nocheck
/**
 * fix/repay-missing-payout. Live on 2026-10-26: order 7e189a652cf97de836433a64 (BET_WIN_PAYOUT, 1.320176 POA)
 * was marked CONFIRMED from an `included` receipt (payout 269433a2, nonce 10, height 2358), but that payout is
 * in neither the bank's nor the recipient's ledger history: the player was probably never paid.
 *
 * Covered here (local mock minepoa only; nothing touches minepoa.com):
 *  - an admin-only endpoint previews (dry run, the default) and, with confirm, re-pays such an order ONCE with
 *    a new transaction (new nonce, memo `...:ord=<id12>:repay=1`), through the normal save-before-send path;
 *  - every check is made fresh and refuses when the original is on the ledger, when anything else already
 *    paid the order, or when the ledger read is busy / degraded / incomplete;
 *  - recipient, amount and memo come from the stored order, never from the request;
 *  - a receipt alone no longer confirms a payout;
 *  - /api/health and /api/audit/chain report the same bank balance.
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

const ADMIN = 'repay-test-admin';
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-repay-${t}-`));
const ts = () => Math.floor(Date.now() / 1000);
const tx = (mock, wallet, to, amount, memo, nonce = null) => buildSignedTransfer({ wallet, to, amount, memo, nonce: nonce ?? mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });

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
    adminToken: ADMIN,
    cronSecret: 'repay-test-cron',
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
  const req = async (p, { method = 'GET', body, token } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(info.url + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const repay = (body, token = ADMIN) => req('/api/admin/payouts/repay', { method: 'POST', body, token });
  return { app, s: app.settlement, pass, req, repay, close: () => app.close() };
}

/** Bank with three LPs: p 500, q 20 (the player whose payout went missing), r 30 (whose payout used the nonce). */
async function setup(tag) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  const q = genKeypair();
  const r = genKeypair();
  mock.setBalance(p.address, '1000.000000');
  mock.setBalance(q.address, '100.000000');
  mock.setBalance(r.address, '100.000000');
  const store = createMemoryStore(null);
  const a = await boot({ mock, bank, store, tag: `${tag}-a` });
  for (const [w, amt] of [[p, '500.000000'], [q, '20.000000'], [r, '30.000000']]) mock.directSubmit(tx(mock, w, bank.address, amt, formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 })).body);
  mock.finalizeAll();
  await a.pass(3);
  assert.equal(a.s.writer.binding?.bankAddress, bank.address, 'store bound');
  const nodes = [a];
  const withdraw = (w) => {
    mock.directSubmit(tx(mock, w, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' })).body);
    mock.finalizeAll();
  };
  return {
    mock,
    bank,
    p,
    q,
    r,
    store,
    a,
    withdraw,
    boot: async (t) => {
      const x = await boot({ mock, bank, store, tag: `${tag}-${t}` });
      nodes.push(x);
      return x;
    },
    close: async () => {
      for (const x of nodes) await x.close().catch(() => {});
      await mock.close();
    }
  };
}

const payoutsTo = (mock, bank, to) => mock.transfersFrom(bank.address).filter((t) => t.body.to === to);
const orderTo = (s, to) => Object.values(s.state.outbound).find((o) => o.kind === 'LP_WITHDRAW_PAYOUT' && o.to === to);
const storedOrderTo = (store, to) => Object.values(store.load().outbound).find((o) => o.kind === 'LP_WITHDRAW_PAYOUT' && o.to === to);

/** Make the stored order look like the live one: CONFIRMED from an `included` receipt an hour ago, with this txid/body/nonce. */
function markReceiptConfirmed(store, orderId, { txid, body, nonce }) {
  const doc = store.load();
  const o = doc.outbound[orderId];
  Object.assign(o, { status: 'CONFIRMED', txid, body, nonce, sentAt: Date.now() - 3600_000, confirmedAt: Date.now() - 3600_000, confirmedVia: 'receipt', receipt: { status: 'included', height: 2358, ts: ts() - 3600 }, lastError: null });
  delete o.matchedFromLedger;
  delete o.recoveredFromLedger;
  for (const item of doc.engine.outboundQueue || []) if (item.orderId === orderId) Object.assign(item, { status: 'CONFIRMED', ledgerTxid: txid });
  doc.savedAt = Date.now();
  store.save(doc);
}

/**
 * The live case: r's payout lands normally (bank nonce N). q's payout order is then recorded as paid by a body
 * with that same nonce N that never reached the ledger (it lost the nonce to r's payout), confirmed from a receipt.
 */
async function missingPayout(c) {
  c.withdraw(c.r);
  await c.a.pass(4);
  const rOrder = orderTo(c.a.s, c.r.address);
  assert.equal(rOrder.status, 'CONFIRMED');
  const nonce = c.mock.tx(rOrder.txid).body.nonce;
  // q's withdrawal is booked, but its payout is not signed in this pass
  const s = c.a.s;
  const realChoose = s._chooseBankNonce.bind(s);
  s._chooseBankNonce = async () => {
    throw new Error('test: not signing yet');
  };
  c.withdraw(c.q);
  await c.a.pass(3);
  s._chooseBankNonce = realChoose;
  const q = orderTo(s, c.q.address);
  assert.ok(q && ['QUEUED', 'WAITING_FUNDS'].includes(q.status), JSON.stringify(q));
  const ghost = tx(c.mock, c.bank, q.to, q.amountPoa, q.memo, nonce);
  c.store.claim(`payout:${q.orderId}:0`, { txid: ghost.id, body: ghost.body, nonce });
  markReceiptConfirmed(c.store, q.orderId, { txid: ghost.id, body: ghost.body, nonce });
  await c.a.pass(2);
  const rec = orderTo(c.a.s, c.q.address);
  assert.equal(rec.status, 'CONFIRMED');
  assert.equal(rec.txid, ghost.id);
  assert.equal(c.a.s.writer.blocked, null, 'not read-only');
  assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 0, 'q was never paid');
  assert.equal(c.mock.tx(ghost.id), undefined, 'the ghost body is not on the ledger');
  return { rec, ghost, nonce, rOrder };
}

// ─── 1. preview (dry run) ───────────────────────────────────────────────────

test('preview (default): shows exactly what would be sent and every check; sends nothing, records nothing', async () => {
  const c = await setup('preview');
  try {
    const { rec, ghost, nonce } = await missingPayout(c);
    const audit = await c.a.req('/api/audit/chain');
    assert.equal(audit.body.confirmedNotOnLedger.length, 1);
    assert.equal(audit.body.confirmedNotOnLedger[0].orderId, rec.orderId);
    assert.equal(audit.body.confirmedNotOnLedger[0].repayable, true);
    const submits = c.mock.submits.length;
    const r = await c.a.repay({ orderId: rec.orderId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'preview');
    assert.equal(r.body.eligible, true, JSON.stringify(r.body.checks));
    assert.equal(r.body.refusal, null);
    assert.ok(r.body.checks.length >= 8 && r.body.checks.every((x) => x.ok), JSON.stringify(r.body.checks));
    assert.equal(r.body.order.originalTxid, ghost.id);
    assert.equal(r.body.order.originalNonce, nonce);
    assert.equal(r.body.order.confirmedVia, 'receipt');
    const w = r.body.wouldSend;
    assert.equal(w.from, c.bank.address);
    assert.equal(w.to, c.q.address);
    assert.equal(w.amountPoa, rec.amountPoa);
    assert.ok(w.memo.includes(`:ord=${rec.orderId.slice(0, 12)}`), w.memo);
    assert.ok(w.memo.endsWith(':repay=1'), w.memo);
    assert.match(w.nonce, new RegExp(`never ${nonce}`));
    assert.equal(c.mock.submits.length, submits, 'a preview never submits anything');
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 0);
    assert.equal(c.store.peek(`repay:${rec.orderId}`), null, 'a preview records nothing');
    assert.equal(storedOrderTo(c.store, c.q.address).status, 'CONFIRMED');
    // confirm: false is a preview too
    const r2 = await c.a.repay({ orderId: rec.orderId, confirm: false });
    assert.equal(r2.body.mode, 'preview');
    assert.equal(c.store.peek(`repay:${rec.orderId}`), null);
  } finally {
    await c.close();
  }
});

// ─── 2. admin only; the request cannot choose recipient or amount ───────────

test('refuses without the admin token (and never takes recipient/amount from the request)', async () => {
  const c = await setup('auth');
  try {
    const { rec } = await missingPayout(c);
    for (const token of [null, 'wrong-token', `${ADMIN}x`]) {
      const r = await c.a.repay({ orderId: rec.orderId, confirm: true }, token);
      assert.equal(r.status, 401, `token ${token}`);
      assert.equal(r.body.ok, false);
      assert.ok(!JSON.stringify(r.body).includes(ADMIN), 'the token is never echoed');
    }
    const extra = await c.a.repay({ orderId: rec.orderId, confirm: true, to: c.p.address, amountPoa: '999.000000' });
    assert.equal(extra.status, 400);
    assert.match(extra.body.error, /only orderId and confirm/);
    const badConfirm = await c.a.repay({ orderId: rec.orderId, confirm: 'yes' });
    assert.equal(badConfirm.status, 400);
    const unknown = await c.a.repay({ orderId: 'f'.repeat(24) });
    assert.equal(unknown.status, 404);
    assert.equal(c.store.peek(`repay:${rec.orderId}`), null);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 0, 'nothing paid');
    assert.equal(payoutsTo(c.mock, c.bank, c.p.address).length, 0, 'nothing paid to the address in the request body');
  } finally {
    await c.close();
  }
});

// ─── 3. confirm: re-paid once, new tx, save-before-send ─────────────────────

test('confirm: re-paid exactly once with a new tx (new nonce, ord= + repay marker), original superseded; a second request is refused', async () => {
  const c = await setup('once');
  try {
    const { rec, ghost, nonce } = await missingPayout(c);
    const s = c.a.s;
    const submitted = [];
    const realSubmit = s.client.submitTx.bind(s.client);
    s.client.submitTx = async (body) => {
      const o = storedOrderTo(c.store, c.q.address);
      if (body.to === c.q.address) submitted.push({ body, storedTxid: o?.txid ?? null });
      return realSubmit(body);
    };
    const r = await c.a.repay({ orderId: rec.orderId, confirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.mode, 'confirm');
    assert.equal(r.body.applied, true, JSON.stringify(r.body));
    assert.equal(c.store.peek(`repay:${rec.orderId}`).originalTxid, ghost.id, 'the request is recorded once in the store');
    await c.a.pass(3);
    const paid = payoutsTo(c.mock, c.bank, c.q.address);
    assert.equal(paid.length, 1, 'q is paid exactly once');
    assert.notEqual(paid[0].id, ghost.id);
    assert.notEqual(paid[0].body.nonce, nonce, 'a new nonce');
    assert.equal(paid[0].body.amount, rec.amountPoa);
    assert.ok(paid[0].body.memo.includes(`:ord=${rec.orderId.slice(0, 12)}`));
    assert.ok(paid[0].body.memo.endsWith(':repay=1'));
    for (const x of submitted) assert.equal(x.storedTxid, paid[0].id, 'saved in the store before it was broadcast');
    const done = orderTo(s, c.q.address);
    assert.equal(done.status, 'CONFIRMED');
    assert.equal(done.txid, paid[0].id);
    assert.notEqual(done.confirmedVia, 'receipt');
    assert.equal(done.repay.original.txid, ghost.id);
    assert.ok(done.superseded.some((x) => x.txid === ghost.id && x.reason === 'REPAY_NOT_ON_LEDGER'), 'the original txid is recorded as superseded');
    // only once: another confirm (or preview) is refused, and nothing more is ever sent
    const again = await c.a.repay({ orderId: rec.orderId, confirm: true });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyRequested, true);
    assert.match(again.body.refusal, /already re-paid once/);
    const prev = await c.a.repay({ orderId: rec.orderId });
    assert.equal(prev.body.eligible, false);
    await c.a.pass(3);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1);
    // the audit agrees: nothing missing, the books balance, health and audit report the same bank balance
    const au = (await c.a.req('/api/audit/chain')).body;
    assert.equal(au.ok, true, JSON.stringify(au));
    assert.deepEqual(au.confirmedNotOnLedger, []);
    assert.equal(au.repaidPayouts.length, 1);
    assert.equal(au.repaidPayouts[0].originalTxid, ghost.id);
    const h = (await c.a.req('/api/health')).body.settlement;
    assert.equal(h.onChainBankBalancePoa, au.onChainBalancePoa);
    assert.equal(s.reconcile.status, 'OK', JSON.stringify(s.reconcile));
  } finally {
    await c.close();
  }
});

test('only once across instances: two confirms race on two nodes; one request recorded, one payment', async () => {
  const c = await setup('race');
  try {
    const { rec } = await missingPayout(c);
    const b = await c.boot('b');
    const [r1, r2] = await Promise.all([c.a.repay({ orderId: rec.orderId, confirm: true }), b.repay({ orderId: rec.orderId, confirm: true })]);
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal([r1.body, r2.body].filter((x) => x.alreadyRequested).length, 1, 'exactly one request recorded');
    await c.a.pass(2);
    await b.pass(2);
    await c.a.pass(2);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1);
  } finally {
    await c.close();
  }
});

// ─── 4. refusals ────────────────────────────────────────────────────────────

test('refuses when the original payout is actually on the ledger (even when the bank listing hides it)', async () => {
  const c = await setup('onledger');
  try {
    c.withdraw(c.q);
    await c.a.pass(4);
    const rec = orderTo(c.a.s, c.q.address);
    assert.equal(rec.status, 'CONFIRMED');
    const landed = c.mock.tx(rec.txid);
    markReceiptConfirmed(c.store, rec.orderId, { txid: rec.txid, body: landed.body, nonce: landed.body.nonce });
    await c.a.pass(1);
    let r = await c.a.repay({ orderId: rec.orderId });
    assert.equal(r.body.eligible, false);
    assert.match(r.body.refusal, /on the ledger/);
    // the listing and the recent feed no longer show it (read-node lag): the explorer still knows the txid
    c.mock.hide(rec.txid);
    const s = c.a.s;
    const realRecent = s.client.getRecentTransfers.bind(s.client);
    s.client.getRecentTransfers = async (n) => {
      const m = await realRecent(n);
      m.delete(rec.txid);
      return m;
    };
    const doc = c.store.load();
    delete doc.ledgerOut[rec.txid];
    doc.savedAt = Date.now();
    c.store.save(doc);
    r = await c.a.repay({ orderId: rec.orderId });
    assert.equal(r.body.eligible, false, JSON.stringify(r.body.checks));
    assert.match(r.body.refusal, /on the ledger|explorer knows/);
    r = await c.a.repay({ orderId: rec.orderId, confirm: true });
    assert.equal(r.status, 409);
    assert.equal(r.body.ok, false);
    assert.equal(c.store.peek(`repay:${rec.orderId}`), null);
    await c.a.pass(2);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1, 'never paid twice');
  } finally {
    await c.close();
  }
});

test('no double pay: another bank transfer tagged with the order (ord=, recipient, amount) already on the ledger => refused', async () => {
  const c = await setup('tagged');
  try {
    const { rec } = await missingPayout(c);
    // someone paid it another way (same recipient, exact amount, the order's ord= tag)
    const other = tx(c.mock, c.bank, rec.to, rec.amountPoa, rec.memo);
    c.mock.directSubmit(other.body);
    c.mock.finalizeAll();
    const r = await c.a.repay({ orderId: rec.orderId });
    assert.equal(r.body.eligible, false, JSON.stringify(r.body.checks));
    assert.match(r.body.refusal, /tagged for this order|already received/);
    const r2 = await c.a.repay({ orderId: rec.orderId, confirm: true });
    assert.equal(r2.status, 409);
    await c.a.pass(2);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 1, 'only the other transfer: never re-paid');
  } finally {
    await c.close();
  }
});

test('refuses on a stale or degraded ledger (explorer busy => only the last trusted read; probe degraded)', async () => {
  const c = await setup('stale');
  try {
    const { rec } = await missingPayout(c);
    c.mock.setReadBusy(60);
    let r = await c.a.repay({ orderId: rec.orderId });
    assert.equal(r.body.eligible, false, JSON.stringify(r.body.checks));
    assert.match(r.body.refusal, /complete ledger history|could not/);
    r = await c.a.repay({ orderId: rec.orderId, confirm: true });
    assert.equal(r.status, 409);
    c.mock.setReadBusy(0);
    c.a.s.client._busyUntil.read = 0;
    c.mock.setOutage(503, ['/api/txs']);
    r = await c.a.repay({ orderId: rec.orderId, confirm: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /DEGRADED|UNAVAILABLE/);
    assert.equal(c.store.peek(`repay:${rec.orderId}`), null);
    c.mock.setOutage(0);
    await c.a.pass(2);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 0, 'nothing paid while the ledger could not be trusted');
    // healthy again: the preview is eligible
    r = await c.a.repay({ orderId: rec.orderId });
    assert.equal(r.body.eligible, true, JSON.stringify(r.body.checks));
  } finally {
    await c.close();
  }
});

test('a recorded request is re-checked by the writer: if the original shows up before it is applied, nothing is re-paid', async () => {
  const c = await setup('recheck');
  try {
    const { rec, ghost } = await missingPayout(c);
    // the request is recorded (as a standby would), but before the writer applies it the original is found
    c.store.claim(`repay:${rec.orderId}`, { orderId: rec.orderId, originalTxid: ghost.id, originalNonce: rec.nonce, to: rec.to, amountPoa: rec.amountPoa, requestedAt: new Date().toISOString() });
    const s = c.a.s;
    const realGetTx = s.client.getTx.bind(s.client);
    s.client.getTx = async (id) => (id === ghost.id ? { id, final: true, atts: 5, body: ghost.body, from: c.bank.address, to: rec.to, amount: rec.amountPoa, memo: rec.memo } : realGetTx(id));
    await c.a.pass(3);
    const o = orderTo(s, c.q.address);
    assert.equal(o.status, 'CONFIRMED');
    assert.equal(o.txid, ghost.id);
    assert.ok(!o.repay);
    assert.match(o.repayBlocked.reason, /explorer knows/);
    assert.equal(payoutsTo(c.mock, c.bank, c.q.address).length, 0);
  } finally {
    await c.close();
  }
});

// ─── 5. root cause: a receipt alone never confirms ──────────────────────────

test('a payout with an `included` receipt that the ledger never shows stays SENT (in flight), never CONFIRMED', async () => {
  const c = await setup('receiptonly');
  try {
    c.mock.inject({ kind: 'blackhole' }); // the node says queued, the tx never reaches the ledger
    c.withdraw(c.q);
    await c.a.pass(2);
    const rec = orderTo(c.a.s, c.q.address);
    assert.ok(rec.txid, JSON.stringify(rec));
    c.mock.setReceipt(rec.txid, { txid: rec.txid, ts: ts(), status: 'included', height: 2358 });
    // no rebroadcast while the receipt says included: keep the body off the ledger for this test
    const s = c.a.s;
    s.client.submitTx = async () => ({ ok: true, queued: true });
    await c.a.pass(4);
    const o = orderTo(s, c.q.address);
    assert.equal(o.status, 'SENT', 'a receipt alone does not confirm');
    assert.equal(o.receipt.height, 2358, 'the receipt is recorded');
    s.stuckAfterMs = 0;
    const stuck = s.stuckPayouts();
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].receiptOnly, true);
    const au = (await c.a.req('/api/audit/chain')).body;
    assert.equal(au.ok, true);
    assert.equal(au.internal.outboundSentUnconfirmedPoa, rec.amountPoa, 'counted once, as in flight');
    assert.deepEqual(au.confirmedNotOnLedger, []);
    // not a re-pay candidate either (it is not marked paid)
    const r = await c.a.repay({ orderId: rec.orderId });
    assert.equal(r.body.eligible, false);
    assert.match(r.body.refusal, /SENT, not CONFIRMED/);
  } finally {
    await c.close();
  }
});

// ─── 6. one bank balance everywhere ─────────────────────────────────────────

test('/api/health, /api/settlement and /api/audit/chain report the same bank balance (a missing payout counted once)', async () => {
  const c = await setup('balance');
  try {
    const { rec } = await missingPayout(c);
    const au = (await c.a.req('/api/audit/chain')).body;
    const h = (await c.a.req('/api/health')).body.settlement;
    const st = (await c.a.req('/api/settlement')).body;
    assert.equal(au.onChainBankBalancePoa, au.onChainBalancePoa);
    assert.equal(h.onChainBankBalancePoa, au.onChainBalancePoa, 'health = audit');
    assert.equal(st.onChainBankBalancePoa, au.onChainBalancePoa, 'settlement = audit');
    assert.equal(h.bankBalance.balance, au.onChainBalancePoa);
    assert.equal(au.ourPayoutsNotOnLedgerPoa, rec.amountPoa, 'the missing payout is the difference');
    const diff = Math.round((Number(au.ledgerBalancePoa) - Number(au.onChainBalancePoa)) * 1e6);
    assert.equal(diff, Math.round(Number(rec.amountPoa) * 1e6));
    assert.equal(h.bankBalance.ledgerBalancePoa, au.ledgerBalancePoa);
  } finally {
    await c.close();
  }
});
