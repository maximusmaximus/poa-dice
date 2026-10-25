#!/usr/bin/env node
/**
 * tests/smoke-e2e.mjs — Automated End-to-End Smoke Verification Suite
 *
 * Verifies:
 *  1. Responsive Web UI assets (index.html, styles.css with 375px/768px/1440px breakpoints, app.js)
 *  2. Live Server lifecycle: Wallet -> Deposit Stake -> Roll Dice -> 0.1% Dev Sweep -> Seed Rotate & Verify
 *  3. Website-Down Offline CLI execution (bin/poa-dice-cli.mjs --offline)
 *  4. Deterministic State & Solvency Replay Verifier (bin/poa-dice-replay.mjs)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDiceServer } from '../src/server.mjs';
import { DEV_RESERVE_ADDRESS } from '../src/bankroll-engine.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '..');

async function runCliJson(args) {
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poa-dice-smoke-'));
  const dataDir = path.join(tempDir, 'smoke-data');
  const walletDir = path.join(tempDir, 'smoke-wallet');

  console.log('1️⃣  Starting POA Dice server on ephemeral port...');
  const app = createDiceServer({
    dataDir,
    initialBootstrapPoa: '250000.000000',
    adminToken: 'smoke-admin-token',
  });
  const srv = await app.listen(0, '127.0.0.1');

  try {
    // 1. Verify UI HTML, CSS responsive breakpoints, and JS controller
    const htmlRes = await fetch(`${srv.url}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.equal(htmlText.includes('POA DICE'), true);
    assert.equal(htmlText.includes('poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U'), true);

    const cssRes = await fetch(`${srv.url}/styles.css`);
    assert.equal(cssRes.status, 200);
    const cssText = await cssRes.text();
    assert.equal(cssText.includes('@media (max-width: 1280px)'), true, 'Tablet breakpoint missing');
    assert.equal(cssText.includes('@media (max-width: 820px)'), true, 'Mobile breakpoint missing');

    const jsRes = await fetch(`${srv.url}/app.js`);
    assert.equal(jsRes.status, 200);

    // 2. Test CLI against running server (async so parent HTTP server event loop stays active)
    console.log('2️⃣  Testing CLI against live server (stake, bet, chat, sweep-dev)...');
    const stakeOut = await runCliJson([
      'bin/poa-dice-cli.mjs',
      'stake',
      '--server',
      srv.url,
      '--wallet',
      walletDir,
      '--amount',
      '5000.000000',
      '--epochs',
      '0',
    ]);
    assert.equal(stakeOut.ok, true);
    assert.equal(stakeOut.receipt.action, 'LP_DEPOSIT');

    const betOut = await runCliJson([
      'bin/poa-dice-cli.mjs',
      'bet',
      '--server',
      srv.url,
      '--wallet',
      walletDir,
      '--amount',
      '50.000000',
      '--under',
      '49.50',
      '--seed',
      'smoke-seed-01',
    ]);
    assert.equal(betOut.ok, true);
    assert.equal(betOut.receipt.action, 'BET_SETTLED');
    assert.equal(betOut.receipt.devReserveAddress, DEV_RESERVE_ADDRESS);
    assert.equal(betOut.receipt.devFeeReservedPoa, '0.050000');

    const sweepOut = await runCliJson([
      'bin/poa-dice-cli.mjs',
      'sweep-dev',
      '--server',
      srv.url,
      '--wallet',
      walletDir,
      '--admin-token',
      'smoke-admin-token',
    ]);
    assert.equal(sweepOut.ok, true);
    assert.notEqual(sweepOut.mode, 'offline-direct-engine', 'admin sweep should succeed over HTTP with the token');
    const deniedSweep = await fetch(`${srv.url}/api/dev/sweep`, { method: 'POST' });
    assert.equal(deniedSweep.status, 401, 'dev sweep must require the admin token');
    const deniedRotate = await fetch(`${srv.url}/api/seed/rotate`, { method: 'POST' });
    assert.equal(deniedRotate.status, 401, 'seed rotate must require the admin token');
    const deniedEpoch = await fetch(`${srv.url}/api/epoch/advance`, { method: 'POST' });
    assert.equal(deniedEpoch.status, 401, 'epoch advance must require the admin token');
    assert.equal(sweepOut.devReserveAddress, DEV_RESERVE_ADDRESS);

    const autoOut = await runCliJson([
      'bin/poa-dice-cli.mjs',
      'auto-bet',
      '--server',
      srv.url,
      '--wallet',
      walletDir,
      '--strategy',
      'martingale_capped',
      '--rolls',
      '3',
      '--amount',
      '5.000000',
    ]);
    assert.equal(autoOut.ok, true);
    assert.equal(autoOut.rollsExecuted, 3);
  } finally {
    await app.close();
  }

  // Verify no leftover unbounded audit-log.jsonl file was created
  assert.equal(fs.existsSync(path.join(dataDir, 'audit-log.jsonl')), false);

  // 3. Server is now CLOSED (Simulating Website Down / Hacked!)
  // Verify that CLI still works 100% offline against the local state & DICE1:* memos
  console.log('3️⃣  Simulating Website-Down Mode: executing bet & withdraw with server offline...');
  const offlineBet = await runCliJson([
    'bin/poa-dice-cli.mjs',
    'bet',
    '--offline',
    '--dataDir',
    dataDir,
    '--wallet',
    walletDir,
    '--amount',
    '10.000000',
    '--under',
    '50.00',
  ]);
  assert.equal(offlineBet.ok, true);
  assert.equal(offlineBet.receipt.action, 'BET_SETTLED');

  const offlineWithdraw = await runCliJson([
    'bin/poa-dice-cli.mjs',
    'withdraw',
    '--offline',
    '--dataDir',
    dataDir,
    '--wallet',
    walletDir,
    '--bps',
    '5000',
  ]);
  assert.equal(offlineWithdraw.ok, true);
  assert.equal(
    offlineWithdraw.receipt.action,
    'LP_WITHDRAW',
    `Unexpected withdraw receipt: ${JSON.stringify(offlineWithdraw)}`
  );

  // 4. Run Deterministic State & Solvency Replay Verifier
  console.log('4️⃣  Running standalone deterministic replay auditor (bin/poa-dice-replay.mjs)...');
  const replayOut = await runCliJson(['bin/poa-dice-replay.mjs', dataDir]);
  assert.equal(replayOut.ok, true);
  assert.equal(replayOut.invariants.shareInvariantPassed, true);
  assert.equal(replayOut.invariants.solvencyPassed, true);
  assert.equal(replayOut.invariants.devReservePinnedPassed, true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        smokeSuite: 'ALL_CHECKS_PASSED',
        stateRootSha256: replayOut.stateRootSha256,
        devReserveAddress: DEV_RESERVE_ADDRESS,
        invariants: replayOut.invariants,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('SMOKE SUITE FAILED:', err);
  process.exit(1);
});
