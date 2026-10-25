/**
 * tests/crypto-and-offline.test.mjs
 *
 * Tests:
 *  - Ed25519 POA address & canonical transaction signing compatibility with minepoa.com/client/poa.mjs
 *  - DICE1:* On-Chain Memo Protocol parsing & formatting (Website-Down / Hack-Resilient execution)
 *  - Idempotent txid deduplication (prevents double-rolling or double-minting)
 *  - Automatic safe refund (REFUND_QUEUED) when an on-chain memo is malformed or exceeds Kelly cap
 *  - Provably fair commit-reveal HMAC-SHA256 verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  genKeypair,
  walletFromPrivkey,
  isValidPoaAddress,
  buildSignedTransfer,
  verifyBody,
  parseDiceMemo,
  formatDiceMemo,
  redactSecrets,
} from '../src/crypto-poa.mjs';
import { SeedCommitManager, computeRoll, verifyRoll } from '../src/provably-fair.mjs';
import { BankrollEngine, DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';
import { LedgerWatcher } from '../src/ledger-watcher.mjs';

function makeTempDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-crypto-${tag}-`));
}

test('Crypto 1: Ed25519 Keypair, poa1 Address Validation & Canonical Transaction Signing', () => {
  const kp = genKeypair();
  assert.equal(isValidPoaAddress(kp.address), true);
  assert.equal(isValidPoaAddress(DEV_RESERVE_ADDRESS), true);
  assert.equal(isValidPoaAddress('poa1invalid_address_000'), false);

  const recovered = walletFromPrivkey(kp.privkey);
  assert.equal(recovered.address, kp.address);
  assert.equal(recovered.pubkey, kp.pubkey);

  const signedTx = buildSignedTransfer({
    wallet: kp,
    to: DEV_RESERVE_ADDRESS,
    amount: '25.500000',
    memo: 'DICE1:BET:under:4950:seed-abc',
  });

  assert.equal(verifyBody(signedTx.body, kp.address), true);

  // Tamper with amount or memo -> signature verification must fail
  const tampered = { ...signedTx.body, amount: '25000.500000' };
  assert.equal(verifyBody(tampered, kp.address), false);
});

test('Crypto 2: Website-Down DICE1:* Memo Protocol Execution & Idempotent Replay Protection', () => {
  const engine = new BankrollEngine({
    dataDir: makeTempDataDir('offline-memo'),
    initialBootstrapPoa: '250000.000000',
  });
  const watcher = new LedgerWatcher({ engine, mode: 'simulated' });
  const agent = genKeypair();

  // 1. Agent stakes 5,000 POA purely via a signed POA transfer with DICE1:LP_ADD:epochs=4 memo
  const stakeMemo = formatDiceMemo({ action: 'LP_ADD', lockEpochs: 4 });
  assert.equal(stakeMemo, 'DICE1:LP_ADD:epochs=4');
  const stakeTx = buildSignedTransfer({
    wallet: agent,
    to: engine.bankAddress,
    amount: '5000.000000',
    memo: stakeMemo,
    nonce: 1,
    ts: 1700000001,
  });

  const stakeRes = watcher.processSignedTransaction(stakeTx);
  assert.equal(stakeRes.action, 'LP_DEPOSIT');

  // Replaying the exact same signed transaction is idempotent (no double-minting)
  const replayRes = watcher.processSignedTransaction(stakeTx);
  assert.equal(replayRes.idempotent, true);
  assert.equal(engine.bankNavMicros, 255_000_000_000n);

  // 2. Agent places a bet purely via a signed POA transfer with DICE1:BET:under:4950:agent-seed-99
  const betMemo = formatDiceMemo({
    action: 'BET',
    direction: 'under',
    targetBps: 4950,
    clientSeed: 'agent-seed-99',
  });
  const parsedBet = parseDiceMemo(betMemo);
  assert.equal(parsedBet.valid, true);
  assert.equal(parsedBet.action, 'BET');
  assert.equal(parsedBet.targetBps, 4950);

  const betTx = buildSignedTransfer({
    wallet: agent,
    to: engine.bankAddress,
    amount: '10.000000',
    memo: betMemo,
    nonce: 2,
    ts: 1700000002,
  });

  const betRes = watcher.processSignedTransaction(betTx);
  assert.equal(betRes.action, 'BET_SETTLED');
  assert.equal(typeof betRes.rollBps, 'number');

  // 3. Invalid memo transfer to bank address is never swallowed — triggers safe REFUND_QUEUED back to tx.from
  const badTx = buildSignedTransfer({
    wallet: agent,
    to: engine.bankAddress,
    amount: '15.000000',
    memo: 'DICE1:INVALID_COMMAND',
    nonce: 3,
    ts: 1700000003,
  });
  const badRes = watcher.processSignedTransaction(badTx);
  assert.equal(badRes.action, 'REFUND_QUEUED');
  assert.equal(badRes.address, agent.address);
});

test('Crypto 3: Provably Fair Commit-Reveal Seed Rotation & Verification + Secret Redaction', () => {
  const mgr = new SeedCommitManager({
    epochId: 1,
    currentSeed: 'fixed-test-server-seed-001',
    nextSeed: 'fixed-test-server-seed-002',
  });
  const commitment = mgr.publicCommitment();
  assert.equal(commitment.betsCount, 0);

  const roll = computeRoll({
    serverSeed: mgr.currentSeed,
    clientSeed: 'player-seed-xyz',
    nonce: 1,
    betTxid: 'c'.repeat(64),
  });

  const rotated = mgr.rotateSeed();
  const verification = verifyRoll({
    serverSeed: rotated.revealed.serverSeed,
    serverSeedHash: rotated.revealed.serverSeedHash,
    clientSeed: 'player-seed-xyz',
    nonce: 1,
    betTxid: 'c'.repeat(64),
    targetBps: 4950,
    direction: 'under',
  });

  assert.equal(verification.valid, true);
  assert.equal(verification.rollBps, roll.rollBps);

  // Verify secret redaction scrubs pk_* and psk_*
  const leaked = 'My key is pk_1234567890abcdefghijklmnop and psk_9876543210abcdefghijklmnop';
  const scrubbed = redactSecrets(leaked);
  assert.equal(scrubbed.includes('pk_1234567890'), false);
  assert.equal(scrubbed.includes('psk_9876543210'), false);
});
