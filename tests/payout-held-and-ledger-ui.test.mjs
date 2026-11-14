import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { genKeypair } from '../src/crypto-poa.mjs';
import { ledgerUiState } from '../src/ledger-ui.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-held-${t}-`));

async function boot({ mock, bank, tag, extra = {} }) {
  const { startMockMinepoa } = await import('./helpers/mock-minepoa.mjs');
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
    stuckAfterMs: 0,
    ledgerProbe: false,
    ...extra
  });
  const info = await app.listen(0, '127.0.0.1');
  app.settlement.client.retryBaseMs = 5;
  await app.settlement.ready();
  return { app, url: info.url, startMockMinepoa, close: () => app.close() };
}

test('C: header, CHAIN DOWN, betting paused and NAV come from one ledger decision', () => {
  const nav = '7409.327225';
  const live = ledgerUiState({ probeStatus: 'OK', trading: 'OPEN', chainOk: false, navPoa: nav });
  assert.equal(live.header, 'CHAIN LIVE');
  assert.equal(live.chainDown, false);
  assert.equal(live.bettingPaused, false);
  assert.equal(live.navPoa, nav);
  const down = ledgerUiState({ probeStatus: 'UNAVAILABLE', trading: 'PAUSED_LEDGER_UNAVAILABLE', chainOk: true, navPoa: nav });
  assert.equal(down.header, 'CHAIN DOWN');
  assert.equal(down.chainDown, true);
  assert.equal(down.bettingPaused, true);
  assert.equal(down.up, false);
  assert.equal(down.navPoa, nav);
  assert.deepEqual(
    [live.header, live.chainDown, live.bettingPaused],
    live.up ? ['CHAIN LIVE', false, false] : ['CHAIN DOWN', true, true]
  );
});

test('A/B: chain next nonce is used, rejected stale payouts are HELD and not subtracted or repaid', async () => {
  const { startMockMinepoa } = await import('./helpers/mock-minepoa.mjs');
  const mock = await startMockMinepoa({ autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(bank.address, '7409.327225');
  mock.setBalance(player.address, '50.000000');
  const srv = await boot({ mock, bank, tag: 'held' });
  try {
    const s = srv.app.settlement;
    s.state.bankNonce = 999;
    const stuck = [
      { id: 'stuck-bad-1', amount: '1.500000', nonce: 400, receipt: { status: 'rejected', error: 'bad nonce 400 (expected 130)' } },
      { id: 'stuck-bad-2', amount: '2.000000', nonce: 401, receipt: { status: 'rejected', error: 'bad_nonce' } },
      { id: 'stuck-plain', amount: '0.250000', nonce: 402, receipt: { status: 'rejected' } }
    ];
    for (const row of stuck) {
      mock.setReceipt(row.id, row.receipt);
      s.state.outbound[row.id] = {
        orderId: row.id,
        status: 'SENT',
        sentAt: 1,
        txid: row.id,
        amountPoa: row.amount,
        nonce: row.nonce,
        to: player.address,
        kind: 'BET_WIN_PAYOUT',
        memo: 'DICE1:WIN:test',
        superseded: []
      };
    }
    const before = mock.transfersFrom(bank.address).length;
    const subtracted = s._inFlightOutMicros();
    assert.equal(subtracted > 0n, true);
    await s.tick();
    await s.idle();
    for (const row of stuck) {
      const rec = s.state.outbound[row.id];
      assert.equal(rec.status, 'REJECTED', row.id);
      assert.equal(rec.repayment?.status, 'HELD', row.id);
      assert.equal(rec.txid, row.id, 'not re-signed');
    }
    assert.equal(s.repaymentQueueView().count, 3);
    assert.equal(s.repaymentQueueView().totalPoa, '3.750000');
    assert.equal(s.repaymentQueueView().status, 'HELD');
    assert.equal(s._inFlightOutMicros(), 0n);
    assert.equal(mock.transfersFrom(bank.address).length, before, 'nothing was signed or repaid');
    const health = await (await fetch(`${srv.url}/api/health`)).json();
    const status = await (await fetch(`${srv.url}/api/status`)).json();
    assert.equal(health.settlement.repaymentQueue.count, 3);
    assert.equal(health.settlement.repaymentQueue.totalPoa, '3.750000');
    assert.equal(status.settlement.repaymentQueue.count, 3);
    assert.equal(status.ledgerUi.header, status.ledgerUi.chainDown ? 'CHAIN DOWN' : 'CHAIN LIVE');
    assert.equal(status.ledgerUi.bettingPaused, status.ledgerUi.chainDown);
    assert.equal(status.ledgerUi.navPoa, status.bankroll.bankNavPoa);
    const owed = player;
    const st = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bank_stake', arguments: { amount_poa: '10.000000', max_total_spend_poa: '10.000000', privkey: owed.privkey } } })
    });
    const stake = await st.json();
    assert.equal(stake.result.isError, false, JSON.stringify(stake));
    await s.tick();
    await s.idle();
    const wd = await fetch(`${srv.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bank_withdraw', arguments: { mode: 'ALL', privkey: owed.privkey } } })
    });
    const withdrawn = await wd.json();
    assert.equal(withdrawn.result.isError, false, JSON.stringify(withdrawn));
    s.state.bankNonce = 999;
    const expectNonce = mock.nextNonce(bank.address);
    await s.tick();
    await s.idle();
    const signed = Object.values(s.state.outbound).filter((o) => o.repayment?.status !== 'HELD' && Number.isInteger(o.nonce));
    assert.ok(signed.length >= 1, JSON.stringify(Object.values(s.state.outbound).map((o) => ({ id: o.orderId, nonce: o.nonce, status: o.status, kind: o.kind }))));
    assert.ok(signed.some((o) => o.nonce === expectNonce), `expected chain nonce ${expectNonce}, got ${signed.map((o) => o.nonce).join(',')}`);
    for (const rec of signed) assert.ok(rec.nonce < 100 && rec.nonce !== 999, `used local counter ${rec.nonce}`);
    assert.equal(s.state.outbound['stuck-bad-1'].repayment.status, 'HELD');
    assert.equal(s.state.outbound['stuck-bad-1'].nonce, 400, 'held payout was not re-signed');
  } finally {
    await srv.close();
    await mock.close();
  }
});
