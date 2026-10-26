// @ts-nocheck
/**
 * fix/reconcile-onchain-payouts. The exact live sequence on poadice.grok.me (2026-10-25):
 *   deposit 10 POA (DICE1:LP_ADD) -> bet 1 POA under 95.00 WON -> payout 1.042105 POA final on chain
 *   -> vault state lost (new store) -> rebuild from the ledger.
 * Before this fix the rebuilt vault booked the deposit, held the bet for review, and its books said
 * NAV 10.000000 vs 9.957895 on chain (audit SHORTFALL 0.042105) with an instant 9.99 withdrawal quote.
 * Everything runs against the local mock minepoa; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { computeRoll } from '../src/provably-fair.mjs';
import { createMemoryStore, createClaimTable } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-reconcile-${t}-`));

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
    backoffMaxMs: 20
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  // A rebuilt vault (new, empty store while the bank has ledger history) is never bound automatically:
  // the operator's one-time admin recovery binding is what lets it rebuild from the ledger.
  if (tag !== 'live') await app.settlement.bindStore({ via: 'admin', recovery: true });
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
  return { app, url: info.url, mcp, settle, close: () => app.close() };
}

const ts0 = () => Math.floor(Date.now() / 1000) - 600; // ledger history from before the rebuild

function tx(mock, wallet, to, amount, memo, ts = ts0()) {
  return buildSignedTransfer({ wallet, to, amount, memo, nonce: mock.nextNonce(wallet.address), parents: mock.parents(), ts });
}

/**
 * Play the live history on instance #1, then return everything needed to rebuild.
 * The bet's client seed is chosen so the roll wins (95% chance; we just pick a winning one).
 */
async function liveHistory({ wait = true } = {}) {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const max = genKeypair();
  mock.setBalance(max.address, '8949416.110000');
  const first = await boot({ mock, bank, store: createMemoryStore(null), tag: 'live' });
  const nowTs = () => Math.floor(Date.now() / 1000);
  const dep = tx(mock, max, bank.address, '10.000000', 'DICE1:LP_ADD', nowTs());
  mock.directSubmit(dep.body);
  await first.settle();
  assert.equal(first.app.engine.bankNavMicros, toMicros('10.000000'));
  const seed = first.app.engine.seedManager.currentSeed;
  let bet;
  for (let i = 0; i < 50; i++) {
    const cand = tx(mock, max, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 9500, clientSeed: `grokbot-1poa-test-${i}` }), nowTs());
    const r = computeRoll({ serverSeed: seed, clientSeed: `grokbot-1poa-test-${i}`, nonce: 1, betTxid: cand.id });
    if (r.rollBps < 9500) {
      bet = cand;
      break;
    }
  }
  mock.directSubmit(bet.body);
  await first.settle(8);
  const receipt = first.app.engine.processedTxids.get(bet.id);
  assert.equal(receipt.won, true);
  assert.equal(receipt.payoutPoa, '1.042105');
  const payouts = mock.transfersFrom(bank.address);
  assert.equal(payouts.length, 1, 'one payout on chain');
  assert.equal(payouts[0].body.amount, '1.042105');
  assert.equal(first.app.engine.bankNavMicros, toMicros('9.956395'), 'normal settle path: NAV');
  assert.equal(first.app.engine.devReserveMicros, toMicros('0.001000'));
  assert.equal(first.app.engine.incentivePoolMicros, toMicros('0.000500'));
  await first.close(); // the vault state is now "lost": the next instance gets a brand new store
  if (wait) await new Promise((r) => setTimeout(r, 1100)); // the rebuilt state is strictly newer than the history
  return { mock, bank, max, dep, bet, payoutTxid: payouts[0].id, receipt };
}

test('live scenario: rebuilt vault settles the reviewed bet from its on-chain payout; books match the chain; full withdrawal is payable once', async () => {
  const h = await liveHistory();
  const { mock, bank, max } = h;
  const srv = await boot({ mock, bank, store: createMemoryStore(null), tag: 'rebuilt' });
  try {
    await srv.settle(6);
    const eng = srv.app.engine;
    // deposit rebooked, bet settled from the chain, nothing new paid
    assert.equal((await (await fetch(`${srv.url}/api/tx/${h.dep.id}/status`)).json()).rawStatus, 'BOOKED');
    const st = await (await fetch(`${srv.url}/api/tx/${h.bet.id}/status`)).json();
    assert.equal(st.rawStatus, 'BOOKED', JSON.stringify(st));
    assert.equal(st.result.won, true);
    assert.equal(st.result.payoutTxid, h.payoutTxid);
    assert.equal(st.result.rollVerified, false, 'roll is the memo claim, not recomputable');
    assert.equal(st.result.rollDisplay, h.receipt.rollDisplay, 'memo roll recorded');
    const rec = eng.processedTxids.get(h.bet.id);
    assert.equal(rec.recovered, true);
    assert.equal(rec.rollSource, 'payout-memo');
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'never paid again');
    // numbers: same as the normal settle path
    assert.equal(fromMicros(eng.bankNavMicros), '9.956395');
    assert.equal(fromMicros(eng.devReserveMicros), '0.001000');
    assert.equal(fromMicros(eng.incentivePoolMicros), '0.000500');
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.settlement.onChainBankBalancePoa, '9.957895');
    assert.equal(health.settlement.trading, 'OPEN');
    assert.equal(health.settlement.reconcile.status, 'OK');
    const audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));
    assert.equal(audit.chain.deltaPoa, '0.000000');
    const pos = (await srv.mcp('bank_position', { address: max.address })).data;
    assert.equal(pos.currentValuePoa, '9.956395');
    mock.checkpoint(); // player balances as the explorer reports them
    // full withdrawal: instant, ~9.946439 net, payable from the on-chain balance
    const wq = (await srv.mcp('bank_quote_withdraw', { address: max.address, mode: 'ALL' })).data;
    assert.equal(wq.valid, true, JSON.stringify(wq));
    assert.equal(wq.instant, true);
    assert.equal(wq.grossValuePoa, '9.956395');
    assert.equal(wq.earlyExitFeePoa, '0.009956');
    assert.equal(wq.netPayoutPoa, '9.946439');
    const trig = buildSignedTransfer({ wallet: max, to: bank.address, amount: '0.000001', memo: formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' }), nonce: mock.nextNonce(max.address), parents: mock.parents() });
    const sub = (await srv.mcp('bank_withdraw', { mode: 'ALL', signed_tx: trig })).data;
    assert.ok(!sub.rejected, JSON.stringify(sub));
    await srv.settle(8);
    const outs = mock.transfersFrom(bank.address);
    assert.equal(outs.length, 2, 'exactly one withdrawal payout');
    assert.equal(outs[1].body.to, max.address);
    assert.equal(outs[1].body.amount, '9.946440', 'net + the 0.000001 trigger refunded');
    const after = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(after.chain.ok, true, JSON.stringify(after.chain));
    // session net for the player: -10 -1 +1.042105 -0.000001 +9.946440
    const net = -toMicros('10') - toMicros('1') + toMicros('1.042105') - toMicros('0.000001') + toMicros('9.946440');
    assert.equal(net, -toMicros('0.011456'));
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('idempotent: more ticks and a restart from the rebuilt store never book the payout twice', async () => {
  const h = await liveHistory();
  const store = createMemoryStore(null);
  let srv = await boot({ mock: h.mock, bank: h.bank, store, tag: 'idem1' });
  try {
    await srv.settle(10);
    assert.equal(fromMicros(srv.app.engine.bankNavMicros), '9.956395');
    await srv.app.settlement.flush();
  } finally {
    await srv.close();
  }
  srv = await boot({ mock: h.mock, bank: h.bank, store, tag: 'idem2' });
  try {
    await srv.settle(6);
    const e = srv.app.engine;
    assert.equal(fromMicros(e.bankNavMicros), '9.956395');
    assert.equal(fromMicros(e.devReserveMicros), '0.001000');
    assert.equal(e.recoveredOutflows.size, 1);
    assert.equal(e.totalBetsCount, 1);
    assert.equal(h.mock.transfersFrom(h.bank.address).length, 1);
  } finally {
    await srv.close();
    await h.mock.close();
  }
});

test('two rebuilt instances on one shared store: only the lease holder reconciles; the decision is claimed once; never paid again', async () => {
  const h = await liveHistory();
  const claims = createClaimTable();
  const a = await boot({ mock: h.mock, bank: h.bank, store: createMemoryStore(null, { claims }), tag: 'two-a' });
  const b = await boot({ mock: h.mock, bank: h.bank, store: createMemoryStore(null, { claims }), tag: 'two-b' });
  try {
    for (let i = 0; i < 6; i++) await Promise.all([a.app.settlement.tick(), b.app.settlement.tick()]);
    const leaders = [a, b].filter((s) => s.app.settlement.writer.status === 'LEADER');
    assert.equal(leaders.length, 1, 'exactly one writer');
    const [w] = leaders;
    const standby = w === a ? b : a;
    assert.equal(standby.app.settlement.writer.status, 'STANDBY');
    assert.equal(fromMicros(w.app.engine.bankNavMicros), '9.956395');
    assert.equal(w.app.engine.processedTxids.get(h.bet.id).payoutTxid, h.payoutTxid);
    assert.equal(w.app.settlement.tradingHold(), null);
    assert.equal(standby.app.engine.processedTxids.has(h.bet.id), false, 'standby copy books nothing');
    assert.equal(standby.app.settlement.tradingHold().status, 'SIGNER_READ_ONLY');
    assert.ok(claims.has(`reconcile:${h.payoutTxid}`), 'decision claimed once in the shared store');
    assert.equal(h.mock.transfersFrom(h.bank.address).length, 1);
  } finally {
    await a.close();
    await b.close();
    await h.mock.close();
  }
});

test('a reviewed bet with no payout on chain stays in review (never re-rolled); an unexplained bank outflow is booked so the audit passes', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  mock.setBalance(bank.address, '0.000000');
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', 'DICE1:LP_ADD').body);
  const lost = tx(mock, p, bank.address, '1.000000', formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 5000, clientSeed: 'lost-bet' }));
  mock.directSubmit(lost.body);
  // an old payout from the lost state (e.g. a refund made before the loss), not tied to any bet we know
  mock.directSubmit(tx(mock, bank, genKeypair().address, '0.500000', 'DICE1:REFUND:00000000deadbeef:old', ts0()).body);
  const srv = await boot({ mock, bank, store: createMemoryStore(null), tag: 'review' });
  try {
    await srv.settle(6);
    const st = await (await fetch(`${srv.url}/api/tx/${lost.id}/status`)).json();
    assert.equal(st.rawStatus, 'NEEDS_REVIEW');
    assert.equal(srv.app.engine.processedTxids.has(lost.id), false, 'not re-rolled');
    assert.equal(srv.app.engine.recoveredOutflows.size, 1);
    assert.equal(fromMicros(srv.app.engine.bankNavMicros), '19.500000');
    const audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));
    assert.equal(srv.app.settlement.tradingHold(), null, 'a loss-in-review alone does not block trading');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('trading hold: while a bank outflow is not final (books not reconciled), bets and withdrawals are refused and quotes are invalid; deposits stay open', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: false });
  const bank = genKeypair();
  const p = genKeypair();
  mock.setBalance(p.address, '100.000000');
  mock.directSubmit(tx(mock, p, bank.address, '20.000000', 'DICE1:LP_ADD').body);
  mock.finalizeAll();
  mock.directSubmit(tx(mock, bank, genKeypair().address, '5.000000', 'manual transfer', ts0()).body); // not final yet
  mock.checkpoint();
  const srv = await boot({ mock, bank, store: createMemoryStore(null), tag: 'hold' });
  try {
    await srv.settle(4);
    const hold = srv.app.settlement.tradingHold();
    assert.ok(hold, 'hold is on');
    assert.equal(hold.status, 'SOLVENCY_HOLD');
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.settlement.trading, 'HOLD');
    const wq = (await srv.mcp('bank_quote_withdraw', { address: p.address, mode: 'ALL' })).data;
    assert.equal(wq.valid, false);
    assert.equal(wq.instant, false, 'no instant quote above on-chain funds');
    assert.equal(wq.code, 'SOLVENCY_HOLD');
    const bq = (await srv.mcp('dice_quote_bet', { amount_poa: '1.000000', target_bps: 9500, direction: 'under' })).data;
    assert.equal(bq.valid, false);
    const wd = (await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: p.privkey })).data;
    assert.equal(wd.rejected, true);
    assert.equal(wd.code, 'SOLVENCY_HOLD');
    const qa = await (await fetch(`${srv.url}/api/quote/actions?address=${p.address}&depositPoa=10&amountPoa=1&targetBps=9500&direction=under`)).json();
    assert.equal(qa.withdraw.valid, false);
    assert.equal(qa.stake.valid, true, 'deposits stay open');
    // a withdrawal sent straight to the ledger waits; it is booked after the books reconcile
    const trig = tx(mock, p, bank.address, '0.000001', formatDiceMemo({ action: 'LP_WITHDRAW', mode: 'ALL' }), Math.floor(Date.now() / 1000) + 5);
    mock.directSubmit(trig.body);
    mock.finalizeAll();
    await srv.settle(3);
    // now the 5 POA outflow is final -> booked -> hold lifts -> the queued withdrawal is booked
    assert.equal(srv.app.settlement.tradingHold(), null);
    await srv.settle(6);
    mock.finalizeAll();
    await srv.settle(4);
    const st = await (await fetch(`${srv.url}/api/tx/${trig.id}/status`)).json();
    assert.equal(st.rawStatus, 'BOOKED', JSON.stringify(st));
    const outs = mock.transfersFrom(bank.address).filter((t) => t.body.to === p.address);
    assert.equal(outs.length, 1, 'one withdrawal payout');
    assert.equal(outs[0].body.amount, fromMicros(toMicros('14.985000') + 1n), '15 POA NAV less 0.10% fee, + trigger refund');
    const audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('state lost in the same second as the bet: the bank\'s on-chain payout (not the timestamp) marks it as already settled; never re-rolled or paid twice', async () => {
  const h = await liveHistory({ wait: false });
  const { mock, bank } = h;
  const srv = await boot({ mock, bank, store: createMemoryStore(null), tag: 'same-second' });
  try {
    await srv.settle(6);
    const st = await (await fetch(`${srv.url}/api/tx/${h.bet.id}/status`)).json();
    assert.equal(st.rawStatus, 'BOOKED', JSON.stringify(st));
    assert.equal(st.result.payoutTxid, h.payoutTxid);
    assert.equal(srv.app.engine.processedTxids.get(h.bet.id).recovered, true);
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'never re-rolled, never paid again');
    assert.equal(fromMicros(srv.app.engine.bankNavMicros), '9.956395');
    const audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));
  } finally {
    await srv.close();
    await mock.close();
  }
});
