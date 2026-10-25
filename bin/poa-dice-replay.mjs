#!/usr/bin/env node
/**
 * bin/poa-dice-replay.mjs — Standalone Deterministic State & Ledger Replay Verifier
 *
 * Uses BankrollEngine.verifySystemInvariants() (single source of truth) to audit:
 *  1. Cryptographic SHA-256 State Root determinism
 *  2. LP Share Accounting Invariant (Sum of all lpPositions.shares === totalShares)
 *  3. Solvency Invariant (bankNavMicros >= lockedCollateralMicros >= 0n)
 *  4. 0.1% (10 bps) Dev Reserve conservation & address pinning (poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U)
 *  5. Provably Fair Commit-Reveal history (every revealed seed matches its committed SHA-256 hash)
 */

import path from 'node:path';
import { BankrollEngine } from '../src/bankroll-engine.mjs';

function main() {
  const dataDir = process.argv[2] || path.join(process.cwd(), 'data');
  const engine = new BankrollEngine({ dataDir });
  const report = engine.verifySystemInvariants();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
