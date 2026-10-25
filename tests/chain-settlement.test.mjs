// @ts-nocheck
/**
 * Chain settlement e2e: persistent bank key, real (mock) minepoa broadcast + confirmation,
 * durable outbound queue with retries/idempotency, restarts, solvency vs on-chain balance.
 * Everything runs against tests/helpers/mock-minepoa.mjs on 127.0.0.1; nothing touches minepoa.com.
 * All keys are throwaway keys generated here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo, toMicros, fromMicros } from '../src/crypto-poa.mjs';
import { loadBankWallet } from '../src/bank-key.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-chain-${t}-`));

async function boot({ mock, dataDir, bank, env = null, extra = {} }) {
  const app = createDiceServer({
    dataDir,
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: env || { POA_DICE_BANK_PRIVKEY: bank.privkey },
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    adminToken: 'chain-test-admin',
    ...extra
  });
  const info = await app.listen(0, '127.0.0.1');
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
  const settle = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 25));
    }
    await app.settlement.idle();
  };
  return { app, url: info.url, mcp, settle, close: () => app.close() };
}

function stakeTx(mock, wallet, bankAddress, amount = '10.000000', lockEpochs = 0) {
  return buildSignedTransfer({
    wallet,
    to: bankAddress,
    amount,
    memo: formatDiceMemo({ action: 'LP_ADD', lockEpochs }),
    nonce: mock.nextNonce(wallet.address),
    parents: mock.parents()
  });
}

test('bank key: missing key => read-only, no random key, nothing accepted', async () => {
  const mock = await startMockMinepoa();
  const player = genKeypair();
  const srv = await boot({ mock, dataDir: tmp('nokey'), bank: null, env: {} });
  try {
    assert.equal(srv.app.settlement, null);
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.bankAddress, null, 'no bank address is advertised');
    assert.equal(health.settlement.status, 'BANK_KEY_MISSING');
    assert.equal(health.settlement.readOnly, true);
    const state = await (await fetch(`${srv.url}/api/state`)).json();
    assert.equal(state.bankAddress, null);
    const sub = await fetch(`${srv.url}/api/tx/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stakeTx(mock, player, genKeypair().address)) });
    assert.equal(sub.status, 503);
    assert.match((await sub.json()).status, /BANK_KEY_MISSING/);
    const r = await srv.mcp('bank_stake', { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: player.privkey });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /Bank key missing/);
    const qb = await (await fetch(`${srv.url}/api/quote/batch?amountPoa=1&targetBps=4950&direction=under&clientSeed=x`)).json();
    assert.ok(qb.counts.every((c) => c.valid === false && c.code === 'BANK_KEY_MISSING'), 'roll buttons disabled with the reason');
    const qa = await (await fetch(`${srv.url}/api/quote/actions?depositPoa=10&amountPoa=1&targetBps=4950&direction=under`)).json();
    assert.equal(qa.stake.valid, false);
    assert.match(qa.stake.reason, /read-only/);
    assert.equal(mock.submits.length, 0, 'nothing broadcast');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('bank key: loader rules (invalid, address pin, ephemeral only when allowed, never serialized)', () => {
  const k = genKeypair();
  assert.equal(loadBankWallet({ env: {} }).status, 'BANK_KEY_MISSING');
  assert.equal(loadBankWallet({ env: {}, allowEphemeral: true }).status, 'EPHEMERAL');
  assert.equal(loadBankWallet({ env: { POA_DICE_BANK_PRIVKEY: 'not-a-key' } }).status, 'BANK_KEY_INVALID');
  const pinned = loadBankWallet({ env: { POA_DICE_BANK_PRIVKEY: k.privkey, POA_DICE_BANK_ADDRESS: genKeypair().address } });
  assert.equal(pinned.status, 'BANK_ADDRESS_MISMATCH');
  assert.ok(!JSON.stringify(pinned).includes(k.privkey));
  const ok = loadBankWallet({ env: { POA_DICE_BANK_PRIVKEY: k.privkey, POA_DICE_BANK_ADDRESS: k.address } });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.wallet.address, k.address);
  assert.ok(!JSON.stringify(ok).includes(k.privkey), 'key never serialized');
  const dir = tmp('keyfile');
  fs.writeFileSync(path.join(dir, 'wallet.json'), JSON.stringify({ address: k.address, privkey: k.privkey }));
  const fromFile = loadBankWallet({ env: { POA_DICE_BANK_KEY_FILE: path.join(dir, 'wallet.json') } });
  assert.equal(fromFile.status, 'OK');
  assert.equal(fromFile.source, 'file');
});

test('stored vault for another bank => refuses to mix (BANK_ADDRESS_MISMATCH)', async () => {
  const mock = await startMockMinepoa();
  const bankA = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const dataDir = tmp('mismatch');
  let srv = await boot({ mock, dataDir, bank: bankA });
  await srv.mcp('bank_stake', { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: player.privkey });
  mock.finalizeAll();
  await srv.settle();
  assert.equal(srv.app.engine.bankNavMicros, toMicros('10.000000'));
  await srv.close();
  srv = await boot({ mock, dataDir, bank: genKeypair() });
  try {
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.settlement.status, 'BANK_ADDRESS_MISMATCH');
    assert.equal(health.bankAddress, null);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('round trip: stake 10 POA (lock 0) -> confirmed -> withdraw 100% -> payout broadcast + confirmed', async () => {
  const mock = await startMockMinepoa();
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const dataDir = tmp('roundtrip');
  const srv = await boot({ mock, dataDir, bank });
  try {
    const state0 = await (await fetch(`${srv.url}/api/state`)).json();
    assert.equal(state0.bankAddress, bank.address, 'bank address comes from the configured key');
    assert.equal(state0.settlement.status, 'OK');

    const q = await srv.mcp('bank_quote_deposit', { amount_poa: '10.000000', lock_epochs: 0 });
    assert.equal(q.data.valid, true);

    // 1. Stake: broadcast, NOT booked until confirmed
    const st = await srv.mcp('bank_stake', { amount_poa: '10.000000', lock_epochs: 0, max_total_spend_poa: '10.000000', privkey: player.privkey });
    assert.equal(st.isError, false, JSON.stringify(st.data));
    assert.equal(st.data.status, 'PENDING_CONFIRMATION');
    const depositTxid = st.data.txid;
    assert.ok(mock.tx(depositTxid), 'deposit is on the (mock) ledger');
    assert.equal(mock.balanceOf(bank.address), '10.000000');
    await srv.settle();
    assert.equal(srv.app.engine.bankNavMicros, 0n, 'included but not final => not booked');
    assert.equal((await srv.mcp('bank_position', { address: player.address })).data.hasPosition, false);

    mock.finalizeAll();
    await srv.settle();
    const pos = (await srv.mcp('bank_position', { address: player.address })).data;
    assert.equal(pos.hasPosition, true);
    assert.equal(srv.app.engine.bankNavMicros, toMicros('10.000000'));
    const dStatus = (await srv.mcp('tx_status', { txid: depositTxid })).data;
    assert.equal(dStatus.status, 'CONFIRMED');
    assert.equal(dStatus.result.action, 'LP_DEPOSIT');
    let audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.checked, true);
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));

    // 2. Withdraw ALL: trigger tx confirmed, then the bank payout is signed, broadcast, confirmed
    const wq = (await srv.mcp('bank_quote_withdraw', { address: player.address, mode: 'ALL' })).data;
    assert.equal(wq.valid, true);
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    assert.equal(wd.isError, false, JSON.stringify(wd.data));
    assert.equal(wd.data.status, 'PENDING_CONFIRMATION');
    mock.finalizeAll();
    await srv.settle();
    let ws = (await srv.mcp('tx_status', { txid: wd.data.txid })).data;
    assert.equal(ws.status, 'CONFIRMED');
    assert.equal(ws.payouts.length, 1);
    assert.equal(ws.payouts[0].status, 'SENT');
    const payoutTxid = ws.payouts[0].txid;
    assert.ok(mock.tx(payoutTxid), 'payout is on the ledger');
    mock.finalizeAll();
    await srv.settle();
    ws = (await srv.mcp('tx_status', { txid: wd.data.txid })).data;
    assert.equal(ws.payouts[0].status, 'CONFIRMED');

    const paid = mock.tx(payoutTxid).body;
    assert.equal(paid.from, bank.address);
    assert.equal(paid.to, player.address);
    // payout = quoted net + the 0.000001 trigger refunded
    assert.equal(paid.amount, fromMicros(toMicros(wq.netPayoutPoa) + toMicros('0.000001')), 'paid the quoted net + trigger refund');
    const expected = toMicros('100.000000') - toMicros('10.000000') + toMicros(wq.netPayoutPoa);
    assert.equal(mock.balanceOf(player.address), fromMicros(expected));
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'exactly one payout');
    audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));
    console.log(`# round trip: deposit ${depositTxid.slice(0, 12)}…, payout ${payoutTxid.slice(0, 12)}… net ${wq.netPayoutPoa} POA (fee ${wq.earlyExitFeePoa}), player ${mock.balanceOf(player.address)} POA`);
    // secrets never leak into state, health, settlement or files
    for (const p of ['/api/state', '/api/health', '/api/settlement']) assert.ok(!(await (await fetch(srv.url + p)).text()).includes(bank.privkey));
    for (const f of fs.readdirSync(dataDir)) assert.ok(!fs.readFileSync(path.join(dataDir, f), 'utf8').includes(bank.privkey), f);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('broadcast failures are retried with backoff; lost responses never double-pay', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const srv = await boot({ mock, dataDir: tmp('retry'), bank });
  try {
    await srv.mcp('bank_stake', { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: player.privkey });
    await srv.settle();
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    assert.equal(wd.isError, false, JSON.stringify(wd.data));
    // next three payout submits: 503, dropped connection, accepted-but-503 (lost response)
    mock.inject({ kind: '503' }, { kind: 'drop' }, { kind: 'lost' });
    for (let i = 0; i < 12; i++) await srv.settle(1);
    const ws = (await srv.mcp('tx_status', { txid: wd.data.txid })).data;
    assert.equal(ws.payouts[0].status, 'CONFIRMED', JSON.stringify(ws.payouts[0]));
    assert.ok(ws.payouts[0].attempts >= 3);
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'exactly one payout despite retries');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('definitive rejection => safe re-sign with a fresh nonce, still exactly one payout', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  const srv = await boot({ mock, dataDir: tmp('resign'), bank });
  try {
    await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: player.privkey });
    await srv.settle();
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    mock.inject({ kind: 'reject', message: 'stale parents' });
    for (let i = 0; i < 10; i++) await srv.settle(1);
    const out = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
    assert.equal(out.status, 'CONFIRMED', JSON.stringify(out));
    assert.equal(out.superseded.length, 1, 'the rejected body was superseded');
    // A re-sign may reproduce the identical body (same nonce/parents/second); otherwise the old one never landed.
    if (out.superseded[0].txid !== out.txid) assert.equal(mock.tx(out.superseded[0].txid), undefined, 'superseded body never landed');
    assert.equal(mock.transfersFrom(bank.address).length, 1);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('restart mid-queue: signed payout survives, is rebroadcast once, no loss and no double-pay', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const dataDir = tmp('restart');
  try {
    let srv = await boot({ mock, dataDir, bank });
    await srv.mcp('bank_stake', { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: player.privkey });
    await srv.settle();
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    mock.inject(...Array.from({ length: 100 }, () => ({ kind: '503' })));
    await srv.settle(3);
    const before = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
    assert.equal(before.rawStatus, 'SIGNED', 'payout signed + persisted while the node is down');
    await srv.close(); // "crash"
    mock.clearFaults();

    srv = await boot({ mock, dataDir, bank });
    await srv.settle();
    const after = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
    assert.equal(after.status, 'CONFIRMED');
    assert.equal(after.txid, before.txid, 'the SAME signed tx was broadcast after restart');
    assert.equal(mock.transfersFrom(bank.address).length, 1);
    await srv.close();

    srv = await boot({ mock, dataDir, bank }); // second restart after it was paid
    await srv.settle();
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'no double-pay after another restart');
    assert.equal(srv.app.engine.lpPositions.get(player.address)?.shares ?? 0n, 0n);
    await srv.close();
  } finally {
    await mock.close();
  }
});

test('restart after a lost response: node already has the payout => marked sent, not resent', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const dataDir = tmp('lost');
  try {
    let srv = await boot({ mock, dataDir, bank });
    await srv.mcp('bank_stake', { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: player.privkey });
    await srv.settle();
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    mock.inject({ kind: 'lost' });
    // one tick: trigger confirms, payout signed, broadcast "fails" (but the node accepted it)
    await srv.app.settlement.tick();
    await srv.app.settlement.tick();
    await srv.close();
    const submitsBefore = mock.submits.length;
    srv = await boot({ mock, dataDir, bank });
    await srv.settle();
    const out = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
    assert.equal(out.status, 'CONFIRMED');
    assert.equal(mock.transfersFrom(bank.address).length, 1);
    assert.equal(mock.submits.length, submitsBefore, 'not resubmitted: the explorer already had it');
    await srv.close();
  } finally {
    await mock.close();
  }
});

test('inbound is booked only from the ledger: rejected broadcast books nothing; direct poa.mjs-style transfer booked once final', async () => {
  const mock = await startMockMinepoa();
  const bank = genKeypair();
  const poor = genKeypair();
  const direct = genKeypair();
  mock.setBalance(poor.address, '5.000000');
  mock.setBalance(direct.address, '30.000000');
  const srv = await boot({ mock, dataDir: tmp('inbound'), bank });
  try {
    // signed tx for more than the ledger balance: node rejects -> nothing booked
    const tx = stakeTx(mock, poor, bank.address, '10.000000');
    const r = await fetch(`${srv.url}/api/tx/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tx) });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /insufficient balance/);
    assert.equal(srv.app.engine.bankNavMicros, 0n);

    // valid signed tx via /api/tx/submit: 202 pending, idempotent on resubmit
    mock.setBalance(poor.address, '50.000000');
    const tx2 = stakeTx(mock, poor, bank.address, '10.000000');
    const a = await fetch(`${srv.url}/api/tx/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tx2) });
    assert.equal(a.status, 202);
    const b = await (await fetch(`${srv.url}/api/tx/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tx2) })).json();
    assert.equal(b.receipt.duplicate, true);

    // direct ledger transfer to the bank (not through the API)
    const dtx = stakeTx(mock, direct, bank.address, '25.000000');
    mock.directSubmit(dtx.body);
    await srv.settle();
    assert.equal(srv.app.engine.bankNavMicros, 0n, 'nothing final yet');
    mock.finalizeAll();
    await srv.settle();
    assert.equal(srv.app.engine.bankNavMicros, toMicros('35.000000'), '10 + 25 booked once each');
    await srv.settle();
    assert.equal(srv.app.engine.bankNavMicros, toMicros('35.000000'), 'no double credit on later scans');
    assert.equal(srv.app.engine.getLpPosition(direct.address).hasPosition, true);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('solvency: payouts only from confirmed on-chain balance; audit reports a shortfall', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '100.000000');
  const srv = await boot({ mock, dataDir: tmp('solvency'), bank });
  try {
    await srv.mcp('bank_stake', { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: player.privkey });
    await srv.settle();
    // The on-chain bank no longer holds what the books say: someone spent 9 POA with the bank key
    // outside the vault (a ledger can only lose funds through a signed transfer).
    const thief = genKeypair();
    const leak = buildSignedTransfer({ wallet: bank, to: thief.address, amount: '9.000000', memo: 'outside the vault', nonce: mock.nextNonce(bank.address), parents: mock.parents() });
    mock.directSubmit(leak.body);
    const audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, false);
    assert.match(audit.chain.note, /SHORTFALL/);
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    await srv.settle();
    let out = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
    assert.equal(out.rawStatus, 'WAITING_FUNDS');
    assert.equal(mock.transfersFrom(bank.address).length, 1, 'nothing paid beyond the on-chain balance (only the outside leak)');
    // Topped back up by a plain (non-DICE1) transfer to the bank.
    const donor = genKeypair();
    mock.setBalance(donor.address, '20.000000');
    const top = buildSignedTransfer({ wallet: donor, to: bank.address, amount: '9.000001', memo: 'top-up', nonce: mock.nextNonce(donor.address), parents: mock.parents() });
    mock.directSubmit(top.body);
    await srv.settle();
    out = srv.app.settlement.getTxStatus(wd.data.txid).payouts[0];
    assert.equal(out.status, 'CONFIRMED');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('bets on chain: single bet + 5-roll batch settle only after confirmation; wins are paid on chain', async () => {
  const mock = await startMockMinepoa();
  const bank = genKeypair();
  const lp = genKeypair();
  const player = genKeypair();
  mock.setBalance(lp.address, '20000.000000');
  mock.setBalance(player.address, '100.000000');
  const srv = await boot({ mock, dataDir: tmp('bets'), bank });
  try {
    await srv.mcp('bank_stake', { amount_poa: '10000.000000', max_total_spend_poa: '10000.000000', privkey: lp.privkey });
    mock.finalizeAll();
    await srv.settle();
    const availBefore = srv.app.engine.availableBankrollMicros;
    const one = await srv.mcp('dice_place_bet', { amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'chain1', privkey: player.privkey });
    assert.equal(one.isError, false, JSON.stringify(one.data));
    assert.equal(one.data.status, 'PENDING_CONFIRMATION');
    assert.ok(srv.app.engine.availableBankrollMicros < availBefore, 'exposure reserved while pending');
    const batch = await srv.mcp('dice_batch_roll', { count: 5, amount_poa: '1.000000', target_bps: 4950, direction: 'under', client_seed: 'chain5', max_total_spend_poa: '5.000000', privkey: player.privkey });
    assert.equal(batch.isError, false, JSON.stringify(batch.data));
    assert.equal(batch.data.submitted, 5);
    assert.equal(srv.app.engine.totalBetsCount, 0, 'no roll before confirmation');
    const events = [];
    srv.app.engine.onEvent((e) => events.push(e.type));
    mock.finalizeAll();
    await srv.settle();
    assert.equal(srv.app.engine.totalBetsCount, 6);
    assert.ok(events.includes('batch.completed'));
    assert.equal(srv.app.engine.reservedExposureMicros, 0n, 'all reservations released');
    const wins = [one.data.txid, ...batch.data.txids].map((t) => srv.app.settlement.getTxStatus(t)).filter((s) => s.result?.won);
    mock.finalizeAll();
    await srv.settle();
    for (const w of wins) {
      const st = srv.app.settlement.getTxStatus(w.txid);
      assert.equal(st.payouts.length, 1);
      assert.equal(st.payouts[0].status, 'CONFIRMED');
      assert.equal(mock.tx(st.payouts[0].txid).body.to, player.address);
    }
    assert.equal(mock.transfersFrom(bank.address).length, wins.length);
    const audit = (await srv.mcp('dice_audit_solvency')).data;
    assert.equal(audit.chain.ok, true, JSON.stringify(audit.chain));
    // auto strategy is refused on a chain-settled server
    const auto = await srv.mcp('dice_auto_strategy', { strategy: 'flat', base_wager_poa: '1.000000', rolls: 2, max_total_spend_poa: '2.000000', client_seed: 'a', privkey: player.privkey });
    assert.equal(auto.isError, true);
  } finally {
    await srv.close();
    await mock.close();
  }
});
