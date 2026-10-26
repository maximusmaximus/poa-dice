// @ts-nocheck
/**
 * fix/payout-nonce-reconcile. Reproduces what poadice.grok.me did on 2026-10-25 (4:34 PM PT): a bet-win
 * payout (29178f16…) was signed with bank nonce 5, which an earlier payout (5bb0bf99…) had already used.
 * minepoa answered the submit, then its receipt said "bad nonce 5 (expected 6)" and the explorer said
 * "not in segments"; the vault kept the order as SENT forever and the solvency audit counted it as
 * "sent, unconfirmed". Everything here runs against the local mock minepoa; nothing touches minepoa.com.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair, buildSignedTransfer } from '../src/crypto-poa.mjs';
import { createMemoryStore, createClaimTable } from '../src/settlement-store.mjs';
import { parseExpectedNonce } from '../src/chain-settlement.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-nonce-${t}-`));

async function boot({ mock, bank, tag, store = null, extra = {} }) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    ...(store ? { settlementStore: store } : {}),
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    rejectCheckIntervalMs: 0,
    sentGraceMs: 0,
    ledgerProbe: false,
    ...extra
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
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
      await new Promise((r) => setTimeout(r, 20));
    }
    await app.settlement.idle();
  };
  return { app, url: info.url, mcp, settle, close: () => app.close() };
}

/** Stake, then withdraw everything: the vault owes the player one LP_WITHDRAW_PAYOUT. */
async function owePayout(srv, player) {
  const st = await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: player.privkey });
  assert.equal(st.isError, false, JSON.stringify(st.data));
  await srv.settle();
  const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
  assert.equal(wd.isError, false, JSON.stringify(wd.data));
  return wd.data.txid;
}

const payoutsTo = (mock, bank, to) => mock.transfersFrom(bank.address).filter((t) => t.body.to === to);
const outRec = (srv) => Object.values(srv.app.settlement.state.outbound)[0];

/** A bank transfer made outside the vault (e.g. another signer) that the explorer's address page has not listed yet. */
function hiddenBankSend(mock, bank) {
  const other = genKeypair();
  const tx = buildSignedTransfer({ wallet: bank, to: other.address, amount: '0.500000', memo: 'ops', nonce: mock.nextNonce(bank.address), parents: mock.parents() });
  const id = mock.directSubmit(tx.body);
  mock.hide(id);
  return { id, nonce: tx.body.nonce };
}

test('parseExpectedNonce reads both minepoa wordings', () => {
  assert.equal(parseExpectedNonce('bad nonce 5 (expected 6)'), 6);
  assert.equal(parseExpectedNonce('minepoa submit rejected: bad nonce: expected 6, got 5'), 6);
  assert.equal(parseExpectedNonce('stale parents'), null);
  assert.equal(parseExpectedNonce(''), null);
});

test('nonce collision: rejected "bad nonce N (expected N+1)" => confirmed absent repeatedly, re-signed once with the expected nonce, paid exactly once', async () => {
  const mock = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  mock.setBalance(bank.address, '5.000000'); // operating float, so the payout is never short of funds
  const srv = await boot({ mock, bank, tag: 'collide' });
  try {
    await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: player.privkey });
    await srv.settle();
    // The bank's nonce is consumed elsewhere and the address page lags: minepoa's explorer still says "next = N".
    const used = hiddenBankSend(mock, bank);
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    assert.equal(wd.isError, false);
    await srv.settle(2);
    let rec = outRec(srv);
    const firstTxid = rec.txid || rec.rejection?.txid;
    assert.equal(mock.receipt(firstTxid)?.error, `bad nonce ${used.nonce} (expected ${used.nonce + 1})`, 'reproduces the live rejection');
    assert.equal(rec.status, 'REJECTED', 'a rejected receipt is noticed (not left as SENT)');
    assert.equal(payoutsTo(mock, bank, player.address).length, 0);
    // Proof requirement: while the consuming tx is not visible, nothing is re-signed.
    await srv.settle(4);
    rec = outRec(srv);
    assert.equal(rec.superseded.length, 0, 'not re-signed without proof the old nonce is used');
    assert.equal(rec.rejection.kind, 'NONCE_USED_UNPROVEN');
    // The read node catches up: the old nonce is provably used by another final bank tx.
    mock.unhideAll();
    await srv.settle(6);
    rec = outRec(srv);
    assert.equal(rec.status, 'CONFIRMED', JSON.stringify(srv.app.settlement._outboundView(rec)));
    assert.equal(rec.superseded.length, 1);
    assert.equal(rec.superseded[0].txid, firstTxid, 'old txid kept for audit');
    assert.equal(rec.superseded[0].nonce, used.nonce);
    assert.equal(rec.superseded[0].reason, 'NONCE_USED');
    assert.equal(rec.superseded[0].consumedBy, used.id);
    assert.equal(rec.nonce, used.nonce + 1, 're-signed with the nonce minepoa expects');
    const paid = payoutsTo(mock, bank, player.address);
    assert.equal(paid.length, 1, 'exactly one payout landed');
    assert.equal(paid[0].body.amount, rec.amountPoa);
    assert.equal(paid[0].body.memo, rec.memo, 'same payout memo');
    // The rejected bytes were never resent once the receipt said rejected.
    const sends = mock.submits.filter((b) => b && b.from === bank.address && b.nonce === used.nonce);
    assert.equal(sends.length, 1, 'the rejected body was submitted once, not resent');
    const st = srv.app.settlement.getTxStatus(wd.data.txid);
    assert.equal(st.payouts[0].status, 'CONFIRMED');
    assert.equal(srv.app.settlement.stuckPayouts().length, 0);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('transient explorer errors ("origin busy", 503) never count as absence: no re-sign until minepoa answers cleanly', async () => {
  const mock = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  mock.setBalance(bank.address, '5.000000');
  const srv = await boot({ mock, bank, tag: 'transient', extra: { rejectConfirmations: 2 } });
  try {
    await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: player.privkey });
    await srv.settle();
    const used = hiddenBankSend(mock, bank);
    mock.unhideAll(); // proof is available; only the transient reads stand in the way
    // keep the explorer stale for the signing step only
    mock.hide(used.id);
    await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    await srv.settle(2);
    mock.unhideAll();
    let rec = outRec(srv);
    assert.equal(rec.status, 'REJECTED');
    // Every explorer / receipt read now fails transiently.
    mock.failReads(...Array.from({ length: 400 }, (_, i) => (i % 2 ? 'busy' : '503')));
    await srv.settle(8);
    rec = outRec(srv);
    assert.equal(rec.superseded.length, 0, 'never re-signed on transient answers');
    assert.equal(rec.rejection.checks, 0, 'transient answers reset the confirmation count');
    assert.ok(rec.rejection.lastTransient, 'the transient reason is recorded');
    assert.equal(payoutsTo(mock, bank, player.address).length, 0);
    assert.equal(srv.app.settlement.ledgerProbe, null);
    assert.notEqual(srv.app.settlement.tradingHold()?.status, 'LEDGER_UNAVAILABLE', 'a rejection is not an outage');
    // minepoa answers cleanly again: the rejection is confirmed and the payout is re-signed once.
    mock.clearReadFaults();
    await srv.settle(6);
    rec = outRec(srv);
    assert.equal(rec.status, 'CONFIRMED');
    assert.equal(rec.superseded.length, 1);
    assert.equal(payoutsTo(mock, bank, player.address).length, 1);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('already-final payout is never duplicated: a stale "rejected" view adopts the landed tx; a landed earlier body is adopted instead of signing again', async () => {
  const mock = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  const srv = await boot({ mock, bank, tag: 'final' });
  try {
    await owePayout(srv, player);
    await srv.settle(4);
    let rec = outRec(srv);
    assert.equal(rec.status, 'CONFIRMED');
    const landed = rec.txid;
    const nonce = rec.nonce;
    // (a) The vault wrongly believes the landed body was rejected (e.g. a stale receipt cached by a proxy).
    rec.status = 'REJECTED';
    rec.rejection = { txid: landed, nonce, error: `bad nonce ${nonce} (expected ${nonce + 1})`, source: 'receipt', expected: nonce + 1, kind: null, firstAt: Date.now(), lastCheckAt: 0, checks: 9, consumedBy: null, lastTransient: null };
    await srv.settle(4);
    rec = outRec(srv);
    assert.equal(rec.status, 'CONFIRMED', 'adopted: it is on the ledger');
    assert.equal(rec.txid, landed);
    assert.equal(rec.superseded.length, 0);
    assert.equal(payoutsTo(mock, bank, player.address).length, 1);
    // (b) The order was already queued for a re-sign, but its earlier body is on the ledger.
    rec.status = 'QUEUED';
    rec.superseded = [{ txid: landed, nonce, error: 'bad nonce', reason: 'NONCE_USED', at: Date.now() }];
    rec.txid = null;
    rec.body = null;
    rec.nonce = null;
    rec.resigns = 1;
    rec.nonceRule = { floor: nonce + 1 };
    await srv.settle(4);
    rec = outRec(srv);
    assert.equal(rec.txid, landed, 'the landed body is adopted');
    assert.equal(rec.status, 'CONFIRMED');
    assert.equal(payoutsTo(mock, bank, player.address).length, 1, 'no second payout');
    assert.equal(mock.transfersFrom(bank.address).length, 1);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('concurrent payouts get distinct nonces: across instances (shared nonce claims) and with a lagging explorer', async () => {
  const mock = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank = genKeypair();
  mock.setBalance(bank.address, '100.000000');
  const claims = createClaimTable();
  const a = await boot({ mock, bank, tag: 'ca', store: createMemoryStore(null, { claims }) });
  const b = await boot({ mock, bank, tag: 'cb', store: createMemoryStore(null, { claims }) });
  try {
    // Two instances choose nonces for six different orders at the same moment.
    const recs = Array.from({ length: 6 }, (_, i) => ({ orderId: `order${i}`.padEnd(24, '0'), resigns: 0 }));
    const picks = await Promise.all(recs.map((r, i) => (i % 2 ? b : a).app.settlement._chooseBankNonce(r)));
    assert.equal(new Set(picks).size, picks.length, `distinct nonces: ${picks}`);
    assert.deepEqual([...picks].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6]);
    // Re-asking for the same order returns its own nonce (same order + same nonce can never double-pay).
    assert.equal(await b.app.settlement._chooseBankNonce(recs[0]), picks[0]);
  } finally {
    await a.close();
    await b.close();
    await mock.close();
  }

  // One instance, two payouts back to back, while the address page has not listed the first one yet.
  const mock2 = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank2 = genKeypair();
  const p1 = genKeypair();
  const p2 = genKeypair();
  mock2.setBalance(p1.address, '50.000000');
  mock2.setBalance(p2.address, '50.000000');
  const srv = await boot({ mock: mock2, bank: bank2, tag: 'lag' });
  try {
    for (const p of [p1, p2]) await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: p.privkey });
    await srv.settle();
    await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: p1.privkey });
    await srv.settle(2);
    for (const t of mock2.transfersFrom(bank2.address)) mock2.hide(t.id); // explorer lag
    await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: p2.privkey });
    await srv.settle(4);
    mock2.unhideAll();
    await srv.settle(2);
    const outs = Object.values(srv.app.settlement.state.outbound);
    assert.equal(outs.length, 2);
    assert.ok(outs.every((o) => o.status === 'CONFIRMED' && o.superseded.length === 0), JSON.stringify(outs.map((o) => [o.status, o.nonce, o.lastError])));
    assert.deepEqual(outs.map((o) => o.nonce).sort(), [1, 2]);
    assert.equal(mock2.transfersFrom(bank2.address).length, 2);
  } finally {
    await srv.close();
    await mock2.close();
  }
});

test('solvency audit lists a rejected payout separately instead of counting it as "sent, unconfirmed"', async () => {
  const mock = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  mock.setBalance(bank.address, '5.000000');
  const srv = await boot({ mock, bank, tag: 'audit', extra: { rejectConfirmations: 1000 } });
  try {
    await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: player.privkey });
    await srv.settle();
    hiddenBankSend(mock, bank);
    await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    await srv.settle(3);
    const rec = outRec(srv);
    assert.equal(rec.status, 'REJECTED');
    const audit = await srv.app.settlement.auditAgainstChain();
    assert.equal(audit.internal.outboundSentUnconfirmedPoa, '0.000000', 'not counted as sent');
    assert.equal(audit.internal.outboundRejectedPoa, rec.amountPoa);
    assert.equal(audit.payoutsOk, false);
    assert.equal(audit.stuckPayouts.length, 1);
    assert.equal(audit.stuckPayouts[0].status, 'REJECTED');
    assert.match(audit.stuckPayouts[0].error, /bad nonce \d+ \(expected \d+\)/);
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    assert.equal(health.settlement.stuckPayouts.length, 1, 'health shows it too');
    assert.equal(health.settlement.trading, 'OPEN', 'a rejected payout is not a ledger outage');
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('LEDGER_UNAVAILABLE and rejections stay separate: a bad-nonce rejection never pauses trading; during an outage nothing counts as rejection evidence', async () => {
  const mock = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '50.000000');
  mock.setBalance(bank.address, '5.000000');
  const srv = await boot({ mock, bank, tag: 'probe', extra: { ledgerProbe: undefined, ledgerProbeIntervalMs: 0, ledgerProbeMinHoldMs: 0, ledgerOutageHoldMs: 0 } }); // outage window 0: every failed probe is "sustained"
  try {
    const probe = srv.app.settlement.ledgerProbe;
    assert.ok(probe, 'probe enabled');
    await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: player.privkey });
    await srv.settle();
    hiddenBankSend(mock, bank);
    await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    await srv.settle(2);
    let rec = outRec(srv);
    assert.equal(rec.status, 'REJECTED');
    assert.equal(probe.status, 'OK', 'a definitive rejection is not an outage');
    // minepoa can't accept txs: the hold starts, and the reconciler stops counting.
    mock.setOutage(503);
    for (let i = 0; i < 10 && probe.status !== 'UNAVAILABLE'; i++) await srv.settle(1);
    assert.equal(probe.status, 'UNAVAILABLE');
    const before = outRec(srv).rejection?.checks;
    await srv.settle(6);
    rec = outRec(srv);
    assert.equal(rec.status, 'REJECTED');
    assert.equal(rec.rejection.checks, before, 'no evidence gathered during an outage');
    assert.equal(rec.superseded.length, 0);
    mock.setOutage(0);
    mock.unhideAll();
    for (let i = 0; i < 12 && outRec(srv).status !== 'CONFIRMED'; i++) await srv.settle(2);
    rec = outRec(srv);
    assert.equal(probe.status, 'OK');
    assert.equal(rec.status, 'CONFIRMED');
    assert.equal(payoutsTo(mock, bank, player.address).length, 1);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('replay of the live incident: a payout signed with a stale stored nonce (already used by an earlier CONFIRMED payout) is repaired after deploy', async () => {
  const mock = await startMockMinepoa({ autoFinal: true, asyncReject: true });
  const bank = genKeypair();
  const p1 = genKeypair();
  const p2 = genKeypair();
  mock.setBalance(p1.address, '50.000000');
  mock.setBalance(p2.address, '50.000000');
  const srv = await boot({ mock, bank, tag: 'replay' });
  const s = srv.app.settlement;
  try {
    for (const p of [p1, p2]) await srv.mcp('bank_stake', { amount_poa: '20.000000', max_total_spend_poa: '20.000000', privkey: p.privkey });
    await srv.settle();
    await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: p1.privkey });
    await srv.settle(3);
    const first = Object.values(s.state.outbound)[0];
    assert.equal(first.status, 'CONFIRMED');
    // Old behaviour: the stored bank nonce was stale, so the next payout re-used first.nonce.
    const choose = s._chooseBankNonce;
    s._chooseBankNonce = async () => first.nonce;
    await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: p2.privkey });
    await srv.settle(1);
    s._chooseBankNonce = choose; // deploy the fix
    const stuck = Object.values(s.state.outbound).find((o) => o.to === p2.address);
    const stuckTxid = stuck.txid;
    assert.equal(mock.receipt(stuckTxid)?.error, `bad nonce ${first.nonce} (expected ${first.nonce + 1})`);
    await srv.settle(8);
    const rec = Object.values(s.state.outbound).find((o) => o.to === p2.address);
    assert.equal(rec.status, 'CONFIRMED', JSON.stringify(s._outboundView(rec)));
    assert.equal(rec.superseded[0].txid, stuckTxid);
    assert.equal(rec.superseded[0].consumedBy, first.txid, 'proof: the earlier payout used that nonce');
    assert.equal(rec.nonce, first.nonce + 1);
    assert.equal(payoutsTo(mock, bank, p2.address).length, 1);
    assert.equal(payoutsTo(mock, bank, p1.address).length, 1);
  } finally {
    await srv.close();
    await mock.close();
  }
});
