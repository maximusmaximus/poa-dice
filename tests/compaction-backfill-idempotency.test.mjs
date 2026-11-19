// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createDiceServer } from '../src/server.mjs';
import { buildSignedTransfer, formatDiceMemo, genKeypair } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-comp-idemp-${t}-`));

test('P0-1: _assertSenderCanCoverBet is strictly read-only and never posts player txs to /api/submit before coverage/flush', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  const fundedPlayer = genKeypair();
  const unfunded = genKeypair();
  mock.setBalance(lp.address, '20.000000');
  mock.setBalance(fundedPlayer.address, '500.000000');

  const app = createDiceServer({
    dataDir: tmp('no-prebroadcast'),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: createMemoryStore(null),
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    ledgerProbe: false
  });
  const info = await app.listen(0, '127.0.0.1');
  await app.settlement.ready();
  try {
    // Fund bank with only 5 POA
    mock.directSubmit(
      buildSignedTransfer({
        wallet: lp,
        to: bank.address,
        amount: '5.000000',
        memo: formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }),
        nonce: mock.nextNonce(lp.address),
        parents: mock.parents()
      }).body
    );
    await app.settlement.tick();
    await app.settlement.idle();

    mock.requests.length = 0;

    // 1. Unfunded attacker rejected with 400 without EVER calling POST /api/submit
    const spamBet = buildSignedTransfer({
      wallet: unfunded,
      to: bank.address,
      amount: '1.000000',
      memo: formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 5000, clientSeed: 'spam' }),
      nonce: 1,
      parents: mock.parents()
    });
    const spamRes = await fetch(`${info.url}/api/tx/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: spamBet })
    });
    assert.equal(spamRes.status, 400);
    assert.equal(
      mock.requests.filter((r) => r.method === 'POST' && r.path === '/api/submit').length,
      0,
      'unfunded pre-check must NEVER hit POST /api/submit'
    );

    // 2. Funded player bet rejected by bank limits / coverage must NEVER hit POST /api/submit either
    const hugeBet = buildSignedTransfer({
      wallet: fundedPlayer,
      to: bank.address,
      amount: '100.000000',
      memo: formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 5000, clientSeed: 'oversized' }),
      nonce: mock.nextNonce(fundedPlayer.address),
      parents: mock.parents()
    });
    const hugeRes = await fetch(`${info.url}/api/tx/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx: hugeBet })
    });
    assert.ok(hugeRes.status === 400 || hugeRes.status === 409, `got ${hugeRes.status}`);
    assert.equal(
      mock.requests.filter((r) => r.method === 'POST' && r.path === '/api/submit').length,
      0,
      'rejected funded bet must NEVER pre-broadcast via POST /api/submit'
    );
  } finally {
    await app.close();
    await mock.close();
  }
});

test('P0-4: post-compaction full POAScan backfill never double-credits historical LP_ADD deposits', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const lp = genKeypair();
  mock.setBalance(lp.address, '500.000000');

  const allTransfers = [];
  const fakeIndexer = {
    name: 'FakePOAScan',
    async lookupTx() {
      return { found: false };
    },
    async addressTxs() {
      return allTransfers.map((t) => ({ ...t }));
    }
  };

  const app = createDiceServer({
    dataDir: tmp('comp-backfill'),
    watcherMode: 'live',
    nodeUrl: mock.url,
    bankEnv: { POA_DICE_BANK_PRIVKEY: bank.privkey, POA_DICE_BANK_SIGNER: '1', POA_DICE_BIND_STORE: bank.address },
    storeEnv: {},
    settlementStore: createMemoryStore(null),
    indexer: fakeIndexer,
    addressListCap: 5,
    chainCacheMs: 0,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
    ledgerProbe: false
  });
  await app.listen(0, '127.0.0.1');
  await app.settlement.ready();
  try {
    const s = app.settlement;
    s.maxHotInbound = 3;
    s.maxBankHistoryRecent = 3;
    s.compactAgeMs = 0;

    // Submit 8 historical LP_ADD deposits of 10 POA each (total 80 POA) with ascending timestamps
    for (let i = 0; i < 8; i++) {
      const tx = buildSignedTransfer({
        wallet: lp,
        to: bank.address,
        amount: '10.000000',
        memo: formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }),
        nonce: mock.nextNonce(lp.address),
        parents: mock.parents(),
        ts: 1790000100 + i * 10
      });
      mock.directSubmit(tx.body);
      allTransfers.push({
        id: tx.id,
        type: 'transfer',
        from: lp.address,
        to: bank.address,
        amount: '10.000000',
        memo: tx.body.memo,
        ts: tx.body.ts,
        atts: 8,
        final: true,
        checkpointHeight: 100 + i
      });
      await s.tick();
      await s.idle();
    }

    assert.equal(app.engine.getStateSummary().bankroll.bankNavPoa, '80.000000');
    assert.ok((s.state.compacted?.inbound || 0) >= 4, 'older inbound records compacted');

    // Simulate processedTxids eviction of the oldest deposits (like exceeding the 1,000-entry cap)
    const oldestId = allTransfers[0].id;
    app.engine.processedTxids.delete(oldestId);
    delete s.state.inbound[oldestId];

    // Force a full POAScan genesis-to-tip backfill containing all 8 transfers
    s._historyBackfill.lastTryAt = 0;
    const bf = await s._backfillBankHistory(s.state.bankHistory, allTransfers.slice(-5));
    assert.equal(bf.ok, true, JSON.stringify(bf));
    assert.equal(s.state.inbound[oldestId], undefined, 'compacted historical LP_ADD must NOT be re-queued as inbound');
    await s.tick();
    await s.idle();
    assert.equal(app.engine.getStateSummary().bankroll.bankNavPoa, '80.000000', 'bank NAV must remain exactly 80 POA (no double-credit)');
  } finally {
    await app.close();
    await mock.close();
  }
});

test('P2-3: offline-tx CLI parses --parents into signedTransaction.body.parents', () => {
  const bank = genKeypair();
  const p1 = 'a'.repeat(64);
  const p2 = 'b'.repeat(64);
  const out = execFileSync(
    process.execPath,
    [
      'bin/poa-dice-cli.mjs',
      'offline-tx',
      '--offline',
      '--to',
      bank.address,
      '--amount',
      '1.000000',
      '--under',
      '49.50',
      '--nonce',
      '7',
      '--parents',
      `${p1},${p2}`
    ],
    { encoding: 'utf8', cwd: process.cwd() }
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.signedTransaction.body.nonce, 7);
  assert.deepEqual(parsed.signedTransaction.body.parents, [p1, p2]);
});
