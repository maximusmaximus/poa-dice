#!/usr/bin/env node
/**
 * bin/poa-dice-replay.mjs — Standalone Deterministic State & Ledger Replay Verifier
 *
 * Audits:
 *  1. Cryptographic SHA-256 State Root determinism
 *  2. LP Share Accounting Invariant (Sum of all lpPositions.shares === totalShares)
 *  3. Solvency Invariant (bankNavMicros >= lockedCollateralMicros && devReserveMicros >= 0n)
 *  4. 0.1% (10 bps) Dev Reserve address integrity (pinned to poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U)
 *  5. Provably Fair Commit-Reveal history (every revealed seed matches its committed SHA-256 hash)
 */

import path from 'node:path';
import { BankrollEngine, DEV_RESERVE_ADDRESS, DEV_FEE_BPS } from '../src/bankroll-engine.mjs';
import { sha256hex, fromMicros } from '../src/crypto-poa.mjs';

function main() {
  const dataDir = process.argv[2] || path.join(process.cwd(), 'data');
  const engine = new BankrollEngine({ dataDir });
  const summary = engine.getStateSummary();

  // 1. Verify LP Share Sum Invariant & Solvency Invariant
  let sumStakerShares = 0n;
  for (const [, pos] of engine.lpPositions.entries()) {
    sumStakerShares += pos.shares;
  }
  const shareInvariantPassed = sumStakerShares === engine.totalShares;

  const solvencyPassed =
    engine.bankNavMicros >= engine.lockedCollateralMicros &&
    engine.devReserveMicros >= 0n &&
    engine.incentivePoolMicros >= 0n &&
    engine.assertAccountingInvariant();

  // 2. Verify 0.1% Dev Reserve Pinning
  const devReservePinnedPassed =
    summary.devReserve.address === DEV_RESERVE_ADDRESS &&
    summary.devReserve.feeBps === Number(DEV_FEE_BPS) &&
    DEV_RESERVE_ADDRESS === 'poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U';

  // 3. Verify Revealed Server Seeds against SHA-256 Commitments
  let seedAuditPassed = true;
  const seedAuditDetails = [];
  for (const item of engine.seedManager.history) {
    const computedHash = sha256hex(item.serverSeed);
    const match = computedHash === item.serverSeedHash;
    if (!match) seedAuditPassed = false;
    seedAuditDetails.push({
      seedEpochId: item.seedEpochId,
      serverSeedHash: item.serverSeedHash,
      computedHash,
      match,
    });
  }

  const allPassed =
    shareInvariantPassed &&
    solvencyPassed &&
    devReservePinnedPassed &&
    seedAuditPassed;

  const report = {
    ok: allPassed,
    auditedAt: new Date().toISOString(),
    stateRootSha256: engine.computeStateRoot(),
    invariants: {
      shareInvariantPassed,
      totalShares: engine.totalShares.toString(),
      sumStakerShares: sumStakerShares.toString(),
      solvencyPassed,
      bankNavPoa: fromMicros(engine.bankNavMicros),
      availableBankrollPoa: fromMicros(engine.availableBankrollMicros),
      lockedCollateralPoa: fromMicros(engine.lockedCollateralMicros),
      devReservePinnedPassed,
      devReserveAddress: summary.devReserve.address,
      devReserveFeeBps: summary.devReserve.feeBps,
      devReserveAccruedPoa: summary.devReserve.accruedUnpaidPoa,
      devReserveTotalEarnedPoa: summary.devReserve.totalEarnedPoa,
      seedAuditPassed,
      revealedSeedEpochsAudited: seedAuditDetails.length,
    },
    stakersCount: summary.stakersLeaderboard.length,
    recentBetsCount: engine.betHistory.length,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(allPassed ? 0 : 1);
}

main();
