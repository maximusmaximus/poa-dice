// @ts-nocheck
/**
 * tests/vault-compaction.test.mjs
 *
 * Regression suite for H-08:
 *  - Unit test: compactBankHistory folds finalized txs beyond keepRecent into exact checkpoints
 *    with 0 micro-POA drift, preserves unfinalized entries, and guards recentCompactedIds against
 *    duplicate counting if minepoa re-lists a recently compacted txid.
 *  - Integration test: ChainSettlement._compactVault() strips bulky signed bodies on confirmed payouts,
 *    prunes terminal inbound/outbound records beyond hot limits, marks ledgerOut[txid].knownCompacted
 *    so compacted payouts never trigger FOREIGN_OUTFLOW_HOLD, cleans up aged standby `accepted:<txid>`
 *    claims, and preserves processedTxids replay protection & solvency invariants.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiceServer } from '../src/server.mjs';
import { emptyBankHistory, mergeBankTxs, bankHistoryTotals, compactBankHistory } from '../src/bank-history.mjs';
import { genKeypair, buildSignedTransfer, formatDiceMemo } from '../src/crypto-poa.mjs';
import { createMemoryStore } from '../src/settlement-store.mjs';
import { startMockMinepoa } from './helpers/mock-minepoa.mjs';

function makeTempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-compact-${tag}-`));
}

test('H-08 unit: compactBankHistory conserves exact finalIn, outAll, and count while bounding hot JSON size', () => {
  const bankAddr = genKeypair().address;
  const userAddr = genKeypair().address;
  const hist = emptyBankHistory();

  const synthetic = [];
  for (let i = 0; i < 600; i++) {
    const isOut = i % 3 === 0;
    synthetic.push({
      id: (i + 1).toString(16).padStart(64, '0'),
      type: 'transfer',
      from: isOut ? bankAddr : userAddr,
      to: isOut ? userAddr : bankAddr,
      amount: isOut ? '1.250000' : '2.500000',
      final: i !== 5, // tx #5 is unfinalized -> must NEVER be folded!
      ts: 1_700_000_000 + i,
    });
  }

  mergeBankTxs(hist, synthetic, bankAddr, 'minepoa');
  const before = bankHistoryTotals(hist);
  const jsonSizeBefore = JSON.stringify(hist).length;

  const folded = compactBankHistory(hist, { keepRecent: 100, guardWindow: 250 });
  assert.equal(folded, 500, 'folded 500 finalized entries');
  assert.equal(Object.keys(hist.txs).length, 100, '100 hot entries remain (99 newest + 1 unfinalized)');
  assert.ok(hist.txs[(6).toString(16).padStart(64, '0')], 'unfinalized tx #5 was preserved in hot map');

  const after = bankHistoryTotals(hist);
  assert.equal(after.finalIn, before.finalIn, 'exact finalInMicros conserved');
  assert.equal(after.outAll, before.outAll, 'exact outAllMicros conserved');
  assert.equal(after.count, before.count, 'exact lifetime tx count conserved');

  const jsonSizeAfter = JSON.stringify(hist).length;
  assert.ok(jsonSizeAfter < jsonSizeBefore * 0.45, `JSON size shrank (${jsonSizeBefore} -> ${jsonSizeAfter})`);

  // Re-merging a recently compacted txid (inside guardWindow) must be ignored (0 added, 0 drift)
  const recentlyFoldedTx = synthetic[450];
  const remerge = mergeBankTxs(hist, [recentlyFoldedTx], bankAddr, 'minepoa');
  assert.equal(remerge.added, 0, 'recentCompactedIds blocked double-counting');
  assert.equal(bankHistoryTotals(hist).finalIn, before.finalIn);
});

test('H-08 integration: ChainSettlement._compactVault bounds inbound/outbound/bankHistory without FOREIGN_OUTFLOW_HOLD or replay regressions', async () => {
  const mock = await startMockMinepoa({ realistic: true, autoFinal: true });
  const bank = genKeypair();
  const player = genKeypair();
  mock.setBalance(player.address, '500.000000');

  const store = createMemoryStore(null);
  const leaderDir = makeTempDir('leader');
  const standbyDir = makeTempDir('standby');

  const boot = async (dataDir, extra = {}) => {
    const app = createDiceServer({
      dataDir,
      watcherMode: 'live',
      nodeUrl: mock.url,
      bankEnv: {
        POA_DICE_BANK_PRIVKEY: bank.privkey,
        POA_DICE_BANK_SIGNER: '1',
        POA_DICE_BIND_STORE: bank.address,
      },
      storeEnv: {},
      settlementStore: store,
      chainCacheMs: 0,
      backoffBaseMs: 5,
      backoffMaxMs: 20,
      maxHotInbound: 15,
      maxHotOutbound: 15,
      maxBankHistoryRecent: 15,
      compactAgeMs: 0,
      ...extra,
    });
    const info = await app.listen(0, '127.0.0.1');
    app.settlement.client.retryBaseMs = 5;
    await app.settlement.ready();
    return { app, s: app.settlement, url: info.url };
  };

  const leader = await boot(leaderDir);
  const standby = await boot(standbyDir);

  const settleLeader = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) {
      await leader.s.tick();
      await new Promise((r) => setTimeout(r, 8));
    }
    await leader.s.idle();
  };

  try {
    // 1. Seed bank with 100 POA LP stake
    const lpTx = buildSignedTransfer({
      wallet: player,
      to: bank.address,
      amount: '100.000000',
      memo: formatDiceMemo({ action: 'LP_ADD', lockEpochs: 0 }),
      nonce: mock.nextNonce(player.address),
      parents: mock.parents(),
      ts: Math.floor(Date.now() / 1000),
    });
    mock.directSubmit(lpTx.body);
    await settleLeader();
    await standby.s.tick();

    // 2. Submit 28 high-win-rate (95%) bets — first 6 via standby so `accepted:<txid>` claims exist!
    const betTxs = [];
    for (let i = 0; i < 28; i++) {
      const btx = buildSignedTransfer({
        wallet: player,
        to: bank.address,
        amount: '0.500000',
        memo: formatDiceMemo({ action: 'BET', direction: 'under', targetBps: 9500, clientSeed: `cmp-${i}` }),
        nonce: mock.nextNonce(player.address),
        parents: mock.parents(),
        ts: Math.floor(Date.now() / 1000),
      });
      betTxs.push(btx);
      const targetUrl = i < 6 ? standby.url : leader.url;
      const r = await fetch(`${targetUrl}/api/tx/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tx: btx }),
      });
      assert.equal(r.status, 202);
      if ((i + 1) % 7 === 0) await settleLeader(4);
    }
    await settleLeader(6);

    assert.equal(leader.s.reconcile.status, 'OK');

    // Run compaction explicitly + another tick to ensure reconciliation stays OK after pruning!
    await leader.s._compactVault();
    await settleLeader(3);

    const inCount = Object.keys(leader.s.state.inbound).length;
    const outCount = Object.keys(leader.s.state.outbound).length;
    const histHotCount = Object.keys(leader.s.state.bankHistory.txs).length;

    assert.ok(inCount <= 15, `inbound pruned to <= 15 (got ${inCount})`);
    assert.ok(outCount <= 15, `outbound pruned to <= 15 (got ${outCount})`);
    assert.ok(histHotCount <= 15, `bankHistory hot map pruned to <= 15 (got ${histHotCount})`);
    assert.ok((leader.s.state.compacted?.inbound || 0) >= 13, 'compacted.inbound counter incremented');
    assert.ok((leader.s.state.compacted?.outbound || 0) >= 5, 'compacted.outbound counter incremented');

    // Confirmed outbound records still in hot map had their bulky `.body` stripped
    for (const o of Object.values(leader.s.state.outbound)) {
      if (o.status === 'CONFIRMED') {
        assert.equal(o.body, undefined, 'confirmed outbound body stripped');
      }
    }

    // Reconciler MUST remain OK (no FOREIGN_OUTFLOW_HOLD from compacted payouts, no SOLVENCY_HOLD)
    assert.equal(leader.s.reconcile.status, 'OK', `reconciler stayed OK after compaction: ${JSON.stringify(leader.s.reconcile)}`);
    assert.equal(leader.app.engine.verifySystemInvariants().ok, true);

    // ProcessedTxids still blocks replaying the oldest compacted bet!
    assert.equal(leader.app.engine.processedTxids.has(betTxs[0].id), true);

    // Standby accepted:<txid> claims for pruned older bets were cleaned up from shared store
    assert.equal(await store.peek(`accepted:${betTxs[0].id}`), null, 'aged accepted:<txid> claim deleted from store');
  } finally {
    await standby.app.close();
    await leader.app.close();
    await mock.close();
    fs.rmSync(leaderDir, { recursive: true, force: true });
    fs.rmSync(standbyDir, { recursive: true, force: true });
  }
});
