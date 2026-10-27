// @ts-nocheck
/**
 * fix/bank-full-history. Live on 2026-10-27 at 11:22 AM PT: minepoa's /api/explorer/address/<bank> lists only
 * the newest 100 transfers, the bank passed 100, its three oldest (two deposits and a payout) fell off the list
 * and the balance built from that list came up 10.999999 POA short: a false SOLVENCY_HOLD.
 *
 * Covered here (local mock minepoa with a small address-page cap; nothing touches minepoa.com or POAScan):
 *  - transfers that fall off a capped list still count (the vault records every bank transfer it has seen);
 *  - a vault document with no recorded history (fresh DB, or the live upgrade) backfills from POAScan;
 *  - POAScan busy / gap / disagreement: no false clearance, the hold stays; it clears once POAScan answers;
 *  - dedupe: the same txid from minepoa, the recent feed and POAScan is counted once;
 *  - a CONFIRMED payout that fell off the list is no longer reported as "not on the ledger".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { bankHistoryTotals, emptyBankHistory, mergeBankTxs, poascanHistoryProblem } from '../src/bank-history.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const CAP = 5;
const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-hist-${t}-`));
const ts = () => Math.floor(Date.now() / 1000);
const tx = (mock, wallet, to, amount, memo) => buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts: ts() });

/** Stand-in for POAScan: the bank's whole history from the mock ledger. mode 'ok' | 'busy'; coverage / rows tweakable. */
function fakeIndexer(mock) {
  const ix = {
    name: 'POAScan',
    mode: 'ok',
    calls: 0,
    coverage: { nonce_gap: 0, complete: null },
    tweak: (rows) => rows,
    async lookupTx(id) {
      if (ix.mode === 'busy') throw new Error('POAScan /api/v1/tx -> HTTP 429');
      const t = mock.tx(id);
      return t ? { found: true, tx: { id, from: t.body.from, to: t.body.to, amount: t.body.amount, memo: t.body.memo, final: true } } : { found: false };
    },
    async addressTxs(addr) {
      ix.calls += 1;
      if (ix.mode === 'busy') throw new Error('POAScan /api/v1/address/<bank>/txs -> HTTP 503 (timeout)');
      const rows = ix.tweak(mock.transfersOf(addr).map((t) => ({ id: t.id, type: 'transfer', from: t.body.from, to: t.body.to, amount: t.body.amount, memo: t.body.memo, final: Boolean(t.final), ts: t.body.ts })));
      Object.defineProperty(rows, 'coverage', { value: ix.coverage, enumerable: false });
      return rows;
    }
  };
  return ix;
}

async function setup(tag, { indexer: withIndexer = true } = {}) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  mock.setFeedCap(0); // the recent feed never re-lists old transfers here: only the capped address page
  const bank = genKeypair();
  const p = genKeypair();
  const q = genKeypair();
  mock.setBalance(p.address, '1000.000000');
  mock.setBalance(q.address, '100.000000');
  const store = createMemoryStore(null);
  const indexer = withIndexer ? fakeIndexer(mock) : null;
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
    adminToken: 'hist-test-admin',
    indexer,
    addressListCap: CAP,
    historyBackfillEveryMs: 0,
    cronSecret: 'hist-test-cron',
    passMode: true,
    passEveryMs: 100,
    readPassBudgetMs: 3000,
    ledgerProbeIntervalMs: 0,
    ledgerProbeMinHoldMs: 0,
    sentGraceMs: 0,
    rejectCheckIntervalMs: 0
  });
  await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  const s = app.settlement;
  const pass = async (n = 1) => {
    for (let i = 0; i < n; i++) await s.tick();
    await s.idle();
  };
  const send = async (w, amt, memo) => {
    mock.directSubmit(tx(mock, w, bank.address, amt, memo).body);
    mock.finalizeAll();
    await pass(3);
  };
  const deposit = (w, amt) => send(w, amt, formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }));
  const withdrawAll = (w) => send(w, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' }));
  return { mock, bank, p, q, store, indexer, app, s, pass, deposit, withdrawAll, close: async () => { await app.close().catch(() => {}); await mock.close(); } };
}

/** 3 deposits (history complete from an uncapped list), q withdraws (a payout), then 5 more deposits push the oldest off. */
async function buildHistory(c, { capFromStart = true } = {}) {
  if (capFromStart) c.mock.setAddressCap(CAP);
  await c.deposit(c.p, '100.000000');
  await c.deposit(c.q, '20.000000');
  await c.withdrawAll(c.q);
  await c.pass(3);
  const payout = Object.values(c.s.state.outbound).find((o) => o.to === c.q.address && o.kind === 'LP_WITHDRAW_PAYOUT');
  assert.ok(payout && payout.status === 'CONFIRMED', JSON.stringify(payout));
  for (let i = 0; i < 5; i++) await c.deposit(c.p, '10.000000');
  return payout;
}

/** Make the vault document look like one written before this fix (no history record), in the store and in memory. */
function forgetHistory(c, { ledgerOut = [] } = {}) {
  for (const doc of [c.store.load(), c.s.state]) {
    delete doc.bankHistory;
    doc.trustedBank = null;
    for (const id of ledgerOut) delete doc.ledgerOut[id];
    if (doc !== c.s.state) {
      doc.savedAt = Date.now();
      c.store.save(doc);
    }
  }
}

const bankTxCount = (c) => c.mock.transfersOf(c.bank.address).length;

// ─── unit: merge / dedupe ───────────────────────────────────────────────────

test('mergeBankTxs: dedupes by txid, only upgrades final, flags conflicting amounts, skips other addresses', () => {
  const B = 'poa1Bank';
  const id = (n) => String(n).repeat(64).slice(0, 64);
  const h = emptyBankHistory();
  let r = mergeBankTxs(h, [{ id: id(1), from: 'x', to: B, amount: '10.000000', final: false }, { id: id(2), from: B, to: 'y', amount: '3.000000', final: true }, { id: id(3), from: 'x', to: 'y', amount: '5', final: true }, { id: id(4), from: B, to: B, amount: '1', final: true }], B, 'minepoa');
  assert.equal(r.added, 2);
  assert.equal(bankHistoryTotals(h).finalIn, 0n, 'non-final inbound does not count');
  r = mergeBankTxs(h, [{ id: id(1), from: 'x', to: B, amount: '10.000000', final: true }, { id: id(1).toUpperCase(), from: 'x', to: B, amount: '10', final: true }], B, 'poascan');
  assert.deepEqual([r.added, r.changed, r.conflicts.length], [0, 1, 0]);
  r = mergeBankTxs(h, [{ id: id(2), from: B, to: 'y', amount: '3.000000', final: false }], B, 'minepoa');
  assert.equal(h.txs[id(2)].f, true, 'final never goes back');
  r = mergeBankTxs(h, [{ id: id(2), from: B, to: 'y', amount: '4.000000', final: true }], B, 'poascan');
  assert.deepEqual(r.conflicts, [id(2)]);
  const t = bankHistoryTotals(h);
  assert.equal(fromMicros(t.finalIn - t.outAll), '7.000000');
  assert.equal(t.count, 2);
  assert.match(poascanHistoryProblem(Object.assign([], { coverage: { nonce_gap: 2 } }), [], B), /nonce gap/);
  assert.match(poascanHistoryProblem([{ id: id(1), from: 'x', to: B }], [{ id: id(9) }], B), /no transfer in common/);
  assert.equal(poascanHistoryProblem([{ id: id(1), from: 'x', to: B }], [{ id: id(1) }], B), null);
});

// ─── 1. capped list, older transfers missing: still the right balance ──────

test('a list capped at the newest N with older transfers missing still gives the full balance (no POAScan needed)', async () => {
  const c = await setup('capped', { indexer: false });
  try {
    await buildHistory(c);
    const truth = c.mock.balanceOf(c.bank.address);
    assert.equal(bankTxCount(c), 9, '9 bank transfers on the ledger');
    const h = c.s.bankHistoryView();
    assert.equal(h.minepoaListed, CAP, 'minepoa lists only the newest 5');
    assert.equal(h.txs, 9, 'all 9 recorded');
    assert.equal(h.complete, true);
    const audit = await c.s.auditAgainstChain();
    assert.equal(audit.onChainBankBalancePoa, truth, 'balance counts the transfers that fell off the list');
    assert.equal(audit.ok, true, JSON.stringify(audit.deltaPoa));
    assert.deepEqual(audit.confirmedNotOnLedger, [], 'the payout that fell off is still on the ledger');
    assert.equal(c.s.reconcile.status, 'OK', c.s.reconcile.reason);
    assert.equal(c.s.tradingHold(), null);
    // the recorded history is in the stored vault document
    assert.equal(Object.keys(c.store.load().bankHistory.txs).length, 9);
  } finally {
    await c.close();
  }
});

// ─── 2. fresh DB / live upgrade: no recorded history, list at the cap ──────

test('no recorded history and the list at its cap (fresh DB / the live upgrade): backfills from POAScan, exact balance, payout no longer flagged', async () => {
  const c = await setup('backfill');
  try {
    const payout = await buildHistory(c, { capFromStart: false }); // built with an uncapped list
    const truth = c.mock.balanceOf(c.bank.address);
    c.mock.setAddressCap(CAP);
    // the document as deployed before this fix: no history record, and minepoa never listed the old payout's index
    forgetHistory(c, { ledgerOut: [payout.txid] });
    c.s.stuckAfterMs = 0;
    await c.pass(2);
    assert.equal(c.indexer.calls, 1, 'POAScan read once');
    const h = c.s.bankHistoryView();
    assert.equal(h.complete, true, h.problem);
    assert.equal(h.via, 'poascan');
    assert.equal(h.txs, 9);
    const audit = await c.s.auditAgainstChain();
    assert.equal(audit.onChainBankBalancePoa, truth);
    assert.equal(audit.ourPayoutsNotOnLedgerPoa, '0.000000');
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.confirmedNotOnLedger, [], 'the CONFIRMED payout POAScan has is no longer reported missing');
    assert.equal(c.s.state.ledgerOut[payout.txid]?.via, 'poascan', 'the older payout is indexed again (with its memo)');
    assert.equal(c.s.reconcile.status, 'OK', c.s.reconcile.reason);
    // complete now: later passes do not need POAScan
    await c.deposit(c.p, '1.000000');
    assert.equal(c.indexer.calls, 1);
    assert.equal((await c.s.auditAgainstChain()).onChainBankBalancePoa, c.mock.balanceOf(c.bank.address));
  } finally {
    await c.close();
  }
});

// ─── 3. POAScan outage: no false clearance ─────────────────────────────────

test('POAScan busy (429/5xx/timeout), a nonce gap, or a disagreement: the hold stays and nothing is trusted; clears once POAScan answers', async () => {
  const c = await setup('outage');
  try {
    const payout = await buildHistory(c, { capFromStart: false });
    const truth = c.mock.balanceOf(c.bank.address);
    c.mock.setAddressCap(CAP);
    forgetHistory(c);
    const held = async (why) => {
      await c.pass(2);
      const h = c.s.bankHistoryView();
      assert.equal(h.complete, false, why);
      assert.match(h.problem, why);
      assert.equal(c.s.reconcile.status, 'SOLVENCY_HOLD', c.s.reconcile.reason);
      assert.match(c.s.reconcile.reason, /full ledger history could not be verified/);
      assert.equal(c.s.tradingHold()?.status, 'SOLVENCY_HOLD');
      assert.equal(c.s._lastRow, null, 'bets have no trusted balance');
      const audit = await c.s.auditAgainstChain();
      assert.equal(audit.ok, false, 'the audit never reports OK on an unverified history');
      assert.deepEqual(audit.confirmedNotOnLedger, [], 'no conclusions about payouts from an incomplete read');
    };
    c.indexer.mode = 'busy';
    await held(/POAScan could not supply.*503/);
    c.indexer.mode = 'ok';
    c.indexer.coverage = { nonce_gap: 1 };
    await held(/nonce gap/);
    c.indexer.coverage = { nonce_gap: 0 };
    c.indexer.tweak = (rows) => rows.map((r) => (r.id === payout.txid ? { ...r, amount: '0.000001' } : r));
    await held(/disagree/);
    c.indexer.tweak = (rows) => rows;
    await c.pass(2);
    assert.equal(c.s.bankHistoryView().complete, true);
    assert.equal(c.s.reconcile.status, 'OK', c.s.reconcile.reason);
    assert.equal((await c.s.auditAgainstChain()).onChainBankBalancePoa, truth);
  } finally {
    await c.close();
  }
});

test('no POAScan configured and no recorded history at the cap: holds (never fails open)', async () => {
  const c = await setup('noindex', { indexer: false });
  try {
    await buildHistory(c, { capFromStart: false });
    c.mock.setAddressCap(CAP);
    forgetHistory(c);
    await c.pass(2);
    assert.equal(c.s.reconcile.status, 'SOLVENCY_HOLD');
    assert.match(c.s.bankHistoryView().problem, /no independent index/);
  } finally {
    await c.close();
  }
});

// ─── 4. dedupe ─────────────────────────────────────────────────────────────

test('dedupe: the same transfers from minepoa, the recent feed and POAScan (even twice) are counted once', async () => {
  const c = await setup('dedupe');
  try {
    await buildHistory(c, { capFromStart: false });
    const truth = c.mock.balanceOf(c.bank.address);
    c.mock.setFeedCap(200); // the recent feed lists every transfer again
    c.mock.setAddressCap(CAP);
    c.indexer.tweak = (rows) => rows.concat(rows); // POAScan pages that overlap
    for (let i = 0; i < 3; i++) {
      forgetHistory(c); // force a POAScan read every pass
      await c.pass(1);
    }
    assert.equal(c.indexer.calls, 3);
    assert.ok(c.indexer.calls >= 1);
    assert.equal(c.s.bankHistoryView().txs, bankTxCount(c));
    const audit = await c.s.auditAgainstChain();
    assert.equal(audit.onChainBankBalancePoa, truth);
    assert.equal(audit.ok, true);
  } finally {
    await c.close();
  }
});

test('a gap (the site missed more than a full list): the recorded history no longer joins up, so POAScan is read again', async () => {
  const c = await setup('gap');
  try {
    await buildHistory(c);
    const calls = c.indexer.calls;
    // 6 transfers land while this vault is not reading: none of the newest 5 is in the recorded history
    const s = c.s;
    const realTick = s.tick.bind(s);
    s.tick = async () => {};
    for (let i = 0; i < 6; i++) {
      c.mock.directSubmit(tx(c.mock, c.p, c.bank.address, '1.000000', 'donation').body);
      c.mock.finalizeAll();
    }
    s.tick = realTick;
    await c.pass(2);
    assert.ok(c.indexer.calls > calls, 'POAScan read to fill the gap');
    assert.equal(c.s.bankHistoryView().txs, bankTxCount(c));
    assert.equal((await c.s.auditAgainstChain()).onChainBankBalancePoa, c.mock.balanceOf(c.bank.address));
    assert.equal(toMicros(c.mock.balanceOf(c.bank.address)) > 0n, true);
  } finally {
    await c.close();
  }
});
