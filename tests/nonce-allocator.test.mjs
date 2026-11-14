import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair } from '../src/crypto-poa.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-alloc-${t}-`));

async function boot(mock, bank, tag, extra = {}) {
  const app = createDiceServer({
    dataDir: tmp(tag),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    rejectCheckIntervalMs: 0,
    sentGraceMs: 0,
    stuckAfterMs: 60 * 60 * 1000,
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
    return { isError: Boolean(j.error) || Boolean(j.result?.isError), data: j.result ? JSON.parse(j.result.content[0].text) : j.error };
  };
  const settle = async (rounds = 3) => {
    for (let i = 0; i < rounds; i++) {
      await app.settlement.tick();
      await new Promise((r) => setTimeout(r, 15));
    }
    await app.settlement.idle();
  };
  return { app, mcp, settle, close: () => app.close() };
}

test('rejected payouts release their nonce claims; the next payout takes the chain next nonce and HELD repayments stay put', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  mock.setBalance(bank.address, '100.000000');
  const srv = await boot(mock, bank, 'release');
  try {
    const s = srv.app.settlement;
    s.client.nextNonce = async () => 130;
    const held = {};
    for (let n = 130; n <= 200; n++) {
      const orderId = `rejected-${n}`;
      s.state.outbound[orderId] = {
        orderId,
        status: 'REJECTED',
        nonce: n,
        txid: `tx${n}`,
        amountPoa: '1.000000',
        to: 'poa1held',
        superseded: [],
        repayment: { status: 'HELD', amountPoa: '1.000000', approved: false, code: n % 7 === 0 ? null : 'bad_nonce' }
      };
      held[orderId] = JSON.stringify(s.state.outbound[orderId]);
      await s._persist.claim(`bank-nonce:${n}`, { orderId, gen: 0, at: 1 });
    }
    const nonce = await s._chooseBankNonce({ orderId: 'queued-live', resigns: 0 });
    assert.equal(nonce, 130);
    for (const [orderId, snap] of Object.entries(held)) {
      assert.equal(JSON.stringify(s.state.outbound[orderId]), snap, orderId);
      assert.equal(s.state.outbound[orderId].repayment.status, 'HELD');
      assert.equal(s.state.outbound[orderId].repayment.approved, false);
    }
    const claims = await s._persist.listClaims('bank-nonce:');
    assert.equal(claims.some((c) => c.key === 'bank-nonce:130' && c.value.orderId === 'queued-live'), true);
    assert.equal(claims.some((c) => c.value?.orderId?.startsWith('rejected-')), false);
  } finally {
    await srv.close();
    await mock.close();
  }
});

test('a busy submit retries the same payout and the same nonce, and a nonce failure does not drop the leader', async () => {
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '40.000000');
  mock.setBalance(bank.address, '20.000000');
  const srv = await boot(mock, bank, 'busy');
  try {
    const s = srv.app.settlement;
    const st = await srv.mcp('bank_stake', { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: player.privkey });
    assert.equal(st.isError, false, JSON.stringify(st.data));
    await srv.settle();
    const wd = await srv.mcp('bank_withdraw', { mode: 'ALL', privkey: player.privkey });
    assert.equal(wd.isError, false, JSON.stringify(wd.data));
    const orig = s.client.nextNonce.bind(s.client);
    s.client.nextNonce = async () => {
      throw new Error('no free bank nonce within 64 of the ledger tip');
    };
    const beforeGood = s.lastGoodTick || 0;
    await s.tick();
    await s.idle();
    assert.equal(s.writer.status, 'LEADER');
    assert.equal(s.tradingHold(), null);
    assert.equal(s.summary().trading, 'OPEN');
    assert.ok(s.lastGoodTick >= beforeGood);
    assert.equal(s._tickErrors.length, 0);
    const queued = Object.values(s.state.outbound).find((o) => o.status === 'QUEUED' || o.status === 'WAITING_FUNDS');
    assert.ok(queued, 'the payout is still the same queued order');
    assert.equal(queued.nonce ?? null, null);
    s.client.nextNonce = orig;
    queued.nextAttemptAt = 0;
    mock.inject({ kind: '503' });
    await s.tick();
    await s.idle();
    const signed = Object.values(s.state.outbound).find((o) => o.orderId === queued.orderId);
    assert.equal(signed.nonce, mock.nextNonce(bank.address));
    const nonce = signed.nonce;
    assert.ok(signed.status === 'SIGNED' || signed.status === 'SENT');
    await srv.settle(3);
    const done = s.state.outbound[queued.orderId];
    assert.equal(done.nonce, nonce, 'retried with the same nonce');
    assert.ok(done.status === 'SENT' || done.status === 'CONFIRMED');
    const bodies = mock.transfersFrom(bank.address).filter((t) => t.body.nonce === nonce);
    assert.equal(bodies.length, 1);
    assert.equal(s.writer.status, 'LEADER');
    assert.equal(s.summary().trading, 'OPEN');
  } finally {
    await srv.close();
    await mock.close();
  }
});
