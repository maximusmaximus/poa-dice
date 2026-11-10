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

import fs from 'node:fs';
import path from 'node:path';
import { BankrollEngine } from '../src/bankroll-engine.mjs';

function main() {
  const target = process.argv[2] || path.join(process.cwd(), 'data');
  const isFile = fs.existsSync(target) && fs.statSync(target).isFile();
  const dataDir = isFile ? path.dirname(target) : target;
  const engine = new BankrollEngine({ dataDir, externalPersistence: true });
  const settlementFile = isFile ? target : path.join(dataDir, 'settlement.json');
  const stateFile = path.join(dataDir, 'bankroll-state.json');
  if (fs.existsSync(settlementFile)) {
    try {
      const doc = JSON.parse(fs.readFileSync(settlementFile, 'utf8'));
      const settlementMtime = fs.statSync(settlementFile).mtimeMs;
      const stateMtime = fs.existsSync(stateFile) ? fs.statSync(stateFile).mtimeMs : 0;
      if (doc && doc.engine && (isFile || !fs.existsSync(stateFile) || settlementMtime >= stateMtime)) {
        engine.restoreState(doc.engine);
      }
    } catch {
      // fall back to bankroll-state.json loaded by BankrollEngine
    }
  }
  const report = engine.verifySystemInvariants();
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main();
