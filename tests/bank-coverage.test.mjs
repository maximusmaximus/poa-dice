// @ts-nocheck
/**
 * Bets are accepted only when the bank's REAL free funds cover their worst-case payout:
 *   free = min(confirmed on-chain balance - pending/queued payouts - dev reserve - pool, NAV)
 *          - LP withdrawal liabilities - reserved worst case of every unsettled bet (store-wide)
 * Enforced in quotes (UI + MCP), dice_place_bet, dice_batch_roll and direct DICE1:BET transfers.
 * Fails closed when the balance is unknown / stale or reconciliation is not OK.
 * Direct ledger bets that cannot be covered are REFUNDED IN FULL (never rolled); when the balance is
 * unknown they are HELD (not rolled, not refunded) until it is known again.
 * Several tests lift the 1% Kelly cap so the coverage rule is what decides.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { createMemoryStore, createClaimTable } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-cover-${t}-`));

async function boot({ mock, bank, store = createMemoryStore(null), tag, noKelly = false }) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: store,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  if (noKelly) app.engine.kellyMaxProfitBps = 10000n;
  let id = 0;
  const mcp = async (name, args = {}) => {
    const r = await fetch(`${info.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })
    });
    const j = await r.json();
    if (j.error) return { isError: true, data: { error: j.error.message } };
    return { isError: j.result.isError, data: JSON.parse(j.result.content[0].text) };
  };
  const settle = async (rounds = 5) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 15));
    }
    await app.settlement.idle();
  };
  return { app, url: info.url, mcp, settle, store, close: () => app.close() };
}

const betTx = (mock, w, bank, amount, target = 4950, seed = 'cover') =>
  buildSignedTransfer({ wallet: w, to: bank.address, amount, memo: formatDiceMemo({ action: 'BET', direction: 'under', targetBps: target, clientSeed: seed }), nonce: mock.nextNonce(w.address), parents: mock.parents() });

async function fundedBank(mock, bank, lp, amount, srv) {
  const dep = buildSignedTransfer({ wallet: lp, to: bank.address, amount, memo: 'DICE1:LP_ADD', nonce: mock.nextNonce(lp.address), parents: mock.parents() });
  mock.directSubmit(dep.body);
  await srv.settle();
  assert.equal(fromMicros(srv.app.engine.bankNavMicros), amount);
}

test('empty bank: every bet quote is invalid and a signed bet is refused before broadcast', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'empty', noKelly: true });
  try {
    await srv.settle(2);
    const q = (await srv.mcp('dice_quote_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under' })).data;
    assert.equal(q.valid, false);
    const qb = await (await fetch(`${srv.url}/api/quote/batch?amountPoa=1&targetBps=9500&direction=under&clientSeed=x`)).json();
    assert.ok(qb.counts.every((c) => c.valid === false), 'every roll button disabled');
    const r = (await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under', signed_tx: betTx(mock, p, bank, '1.000000', 9500) })).data;
    assert.ok(r.rejected || r.error, JSON.stringify(r));
    assert.equal(mock.submits.length, 0, 'nothing broadcast');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('bank smaller than the worst-case payout: refused (quote + place); a covered bet is accepted', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const p = genKeypair();
  mock.setBalance(lp.address, '100.000000');
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'small', noKelly: true });
  try {
    await fundedBank(mock, bank, lp, '10.000000', srv);
    const big = (await srv.mcp('dice_quote_bet', { amount_poa: '6.000000', target_bps: 4950, direction: 'under' })).data;
    assert.equal(big.payoutOnWinPoa, '12.000000');
    assert.equal(big.valid, false);
    assert.equal(big.code, 'BANK_INSUFFICIENT');
    assert.equal(big.coverage.freePoa, '10.000000');
    const before = mock.submits.length;
    const r = (await srv.mcp('dice_place_bet', { amount_poa: '6.000000', target_bps: 4950, direction: 'under', signed_tx: betTx(mock, p, bank, '6.000000') })).data;
    assert.ok(r.rejected || /cannot cover/.test(r.error || ''), JSON.stringify(r));
    assert.equal(mock.submits.length, before, 'not broadcast');
    const ok = (await srv.mcp('dice_quote_bet', { amount_poa: '4.000000', target_bps: 4950, direction: 'under' })).data;
    assert.equal(ok.valid, true, JSON.stringify(ok));
    const placed = (await srv.mcp('dice_place_bet', { amount_poa: '4.000000', target_bps: 4950, direction: 'under', signed_tx: betTx(mock, p, bank, '4.000000'), wait_seconds: 0 })).data;
    assert.equal(placed.status, 'PENDING_CONFIRMATION', JSON.stringify(placed));
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('concurrent bets on two instances that together exceed the bank: exactly one is accepted', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const p1 = genKeypair();
  const p2 = genKeypair();
  for (const w of [lp, p1, p2]) mock.setBalance(w.address, '100.000000');
  const claims = createClaimTable();
  const storeA = createMemoryStore(null, { claims });
  const a = await boot({ mock, bank, store: storeA, tag: 'conc-a', noKelly: true });
  await fundedBank(mock, bank, lp, '10.000000', a);
  await a.app.settlement.flush();
  const b = await boot({ mock, bank, store: createMemoryStore(storeA.load(), { claims }), tag: 'conc-b', noKelly: true });
  try {
    await b.settle(2);
    // each bet alone fits (worst case 6 <= 10); together (12) they do not
    const [r1, r2] = await Promise.all([
      a.mcp('dice_place_bet', { amount_poa: '3.000000', target_bps: 4950, direction: 'under', signed_tx: betTx(mock, p1, bank, '3.000000'), wait_seconds: 0 }),
      b.mcp('dice_place_bet', { amount_poa: '3.000000', target_bps: 4950, direction: 'under', signed_tx: betTx(mock, p2, bank, '3.000000'), wait_seconds: 0 })
    ]);
    const accepted = [r1.data, r2.data].filter((d) => d.status === 'PENDING_CONFIRMATION');
    assert.equal(accepted.length, 1, JSON.stringify([r1.data, r2.data]));
    const bets = mock.submits.filter((s) => String(s.memo || s.body?.memo || '').startsWith('DICE1:BET'));
    assert.equal(bets.length, 1, 'only one bet broadcast');
  } finally {
    await a.close();
    await b.close();
    await mock.close();
  }
});

test('a batch whose combined worst case exceeds the bank is refused as a whole (quote + roll)', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const p = genKeypair();
  mock.setBalance(lp.address, '100.000000');
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'batch', noKelly: true });
  try {
    await fundedBank(mock, bank, lp, '10.000000', srv);
    // 5 x 1.5 POA at 49.5%: each roll's worst case 3.0, combined 15.0 > 10.0
    const q = (await srv.mcp('dice_quote_batch', { count: 5, amount_poa: '1.500000', target_bps: 4950, direction: 'under', client_seed: 'b', address: p.address, max_total_spend_poa: '7.5' })).data;
    assert.equal(q.valid, false, JSON.stringify(q));
    const before = mock.submits.length;
    const r = (await srv.mcp('dice_batch_roll', { count: 5, amount_poa: '1.500000', target_bps: 4950, direction: 'under', client_seed: 'b', max_total_spend_poa: '7.5', privkey: p.privkey })).data;
    assert.ok(r.rejected || r.valid === false || r.error, JSON.stringify(r).slice(0, 400));
    assert.equal(mock.submits.length, before, 'no roll broadcast');
    // directly at the settlement layer: the combined reservation is refused, nothing is held
    await assert.rejects(srv.app.settlement.reserveBetCoverage('batch-x', toMicros('15.000000')), /cannot cover/);
    assert.equal(await srv.app.settlement._persist.capacityUsed('bets'), '0');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('stale or unknown bank balance: fail closed (quotes invalid, bets refused, direct bets held then booked)', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const p = genKeypair();
  mock.setBalance(lp.address, '300.000000');
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'stale' });
  try {
    await fundedBank(mock, bank, lp, '200.000000', srv);
    const s = srv.app.settlement;
    // stale: the last read is too old and refreshing does not help (threshold 0)
    s.balanceStaleMs = -1;
    let q = (await srv.mcp('dice_quote_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under' })).data;
    assert.equal(q.valid, false);
    assert.equal(q.code, 'BANK_BALANCE_STALE');
    s.balanceStaleMs = 60000;
    // unknown: minepoa address reads fail
    const real = s.client.getAddress.bind(s.client);
    s.client.getAddress = async () => {
      throw new Error('minepoa down');
    };
    await s.tick();
    q = (await srv.mcp('dice_quote_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under' })).data;
    assert.equal(q.valid, false);
    assert.ok(['BANK_BALANCE_UNKNOWN', 'RECONCILING'].includes(q.code), q.code); // minepoa down => books can't be reconciled either
    // with reconciliation otherwise OK, an unknown balance alone still fails closed
    s.reconcile.status = 'OK';
    s._lastRow = null;
    assert.equal(s.coverageLimit().code, 'BANK_BALANCE_UNKNOWN');
    assert.equal((await s.betCoverage(1n)).unknown, true);
    const r = (await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under', signed_tx: betTx(mock, p, bank, '1.000000', 9500) })).data;
    assert.ok(r.rejected || /unknown|paused|trustworthy/i.test(r.error || ''), JSON.stringify(r));
    // a bet sent straight to the ledger while the balance is unknown is HELD (not rolled, not refunded)
    const direct = betTx(mock, p, bank, '1.000000', 9500, 'direct');
    mock.directSubmit(direct.body);
    s._lastRow = null;
    // ledger scan can't run without getAddress, so feed the record the way the scan would
    s.state.inbound[direct.id] = { txid: direct.id, seq: ++s.state.seq, from: p.address, amountPoa: '1.000000', memo: direct.body.memo, action: 'BET', status: 'SEEN', submittedAt: Date.now(), ledgerTs: direct.body.ts, discoveredBy: 'ledger-scan', reserve: null, groupId: null, attempts: 0, error: null, result: null, ledger: null };
    s.reconcile.status = 'OK';
    await s._confirmInbound();
    assert.equal(s.state.inbound[direct.id].status, 'SEEN', 'held');
    assert.equal(srv.app.engine.processedTxids.has(direct.id), false, 'not rolled, not refunded');
    // balance known again -> booked normally
    s.client.getAddress = real;
    await srv.settle(4);
    assert.equal(s.state.inbound[direct.id].status, 'BOOKED');
    assert.equal(srv.app.engine.processedTxids.get(direct.id).action, 'BET_SETTLED');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('overfunded direct DICE1:BET transfer the bank cannot cover: refunded in full, never rolled', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const p = genKeypair();
  mock.setBalance(lp.address, '100.000000');
  mock.setBalance(p.address, '100.000000');
  const srv = await boot({ mock, bank, tag: 'overfunded', noKelly: true });
  try {
    await fundedBank(mock, bank, lp, '10.000000', srv);
    const direct = betTx(mock, p, bank, '8.000000', 4950, 'too-big'); // worst case 16 > free 10
    mock.directSubmit(direct.body);
    await srv.settle(6);
    const rec = srv.app.engine.processedTxids.get(direct.id);
    assert.equal(rec.action, 'REFUND_QUEUED', JSON.stringify(rec));
    assert.equal(rec.refundedPoa, '8.000000', 'full wager, nothing deducted');
    assert.equal(srv.app.engine.betHistory.length, 0, 'never rolled');
    const refunds = mock.transfersFrom(bank.address).filter((t) => t.body.to === p.address);
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].body.amount, '8.000000');
    assert.equal(fromMicros(srv.app.engine.bankNavMicros), '10.000000', 'bankroll untouched');
    assert.equal(await srv.app.settlement._persist.capacityUsed('bets'), '0', 'no reservation left behind');
    const audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('capacity adapters: memory and file stores never let reservations exceed the limit', async () => {
  const claims = createClaimTable();
  const m1 = createMemoryStore(null, { claims });
  const m2 = createMemoryStore(null, { claims });
  assert.equal(m1.reserveCapacity('bets', 'a', '6', '10').ok, true);
  assert.equal(m2.reserveCapacity('bets', 'b', '6', '10').ok, false, 'second instance sees the first reservation');
  m1.releaseCapacity('bets', 'a', '2');
  assert.equal(m2.reserveCapacity('bets', 'b', '6', '10').ok, true, 'after a partial release 4+6 fits');
  assert.equal(m1.capacityUsed('bets'), '10');
  assert.equal(m1.reserveCapacity('bets', 'c', '1', '100', -1).ok, true);
  assert.equal(m1.capacityUsed('bets'), '10', 'expired reservations do not count');
  const { createFileStore } = await import('../src/settlement-store.mjs');
  const dir = tmp('capfile');
  const f1 = createFileStore(dir);
  const f2 = createFileStore(dir);
  assert.equal(f1.reserveCapacity('bets', 'a', '6', '10').ok, true);
  assert.equal(f2.reserveCapacity('bets', 'b', '6', '10').ok, false);
  f2.releaseCapacity('bets', 'a');
  assert.equal(f2.reserveCapacity('bets', 'b', '6', '10').ok, true);
});
