/**
 * tests/unit-math-edge-cases.test.mjs
 *
 * Comprehensive Unit & Edge-Case Tests for POA Dice & Shared Bankroll Vault:
 *  1. ERC-4626 Virtual-Offset Share Math & First-Depositor Inflation Defense
 *  2. Exact Deposit -> % of Bank -> Redeemable Return Projections
 *  3. Kelly Criterion 1.00% Max Profit Cap across extreme multipliers (1.0102x to 99.0000x)
 *  4. Concurrent In-Flight Bet Collateral Locking & Solvency Invariant
 *  5. LP Withdrawal FIFO Queueing under Locked Collateral & Auto-Flush on Settlement
 *  6. Anti-JIT Early-Exit Fee (10 bps <1 epoch vs 0 bps >=1 epoch)
 *  7. 0.1% (10 bps) Dev Reserve Isolation & Sweep for poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
 *  8. 4-Pillar Agent Staking Incentives (Conviction 1.00x..1.50x, VIP Edge Rebate, Miner Boost, Referral)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BankrollEngine,
  DEV_RESERVE_ADDRESS,
  DEV_FEE_BPS,
  KELLY_MAX_PROFIT_BPS,
} from '../src/bankroll-engine.mjs';
import { genKeypair, toMicros } from '../src/crypto-poa.mjs';

function makeTempDataDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `poa-dice-${tag}-`));
}

test('Edge Case 1 & 2: Deposit -> % of Bank -> Redeemable Return & Virtual-Offset Inflation Defense', () => {
  const engine = new BankrollEngine({
    dataDir: makeTempDataDir('lp-math'),
    initialBootstrapPoa: '100000.000000',
  });

  const alice = genKeypair();

  // If Alice deposits 25,000 POA into a 100,000 POA pool, she should own 20.0000% of the 125,000 POA bankroll
  const quote = engine.quoteDeposit({
    address: alice.address,
    amountPoa: '25000.000000',
    lockEpochs: 4,
  });

  assert.equal(quote.valid, true);
  assert.equal(quote.depositPoa, '25000.000000');
  assert.equal(quote.shareOfLpPoolPercent, '20.0000');
  assert.equal(quote.projections.length, 5);
  // At +0% bank growth, Alice gets back ~25,000 POA; at +100% bank growth (bank doubles), Alice gets ~50,000 POA
  assert.equal(quote.projections[0].projectedPositionValuePoa, '25000.000000');
  assert.equal(quote.projections[4].projectedPositionValuePoa, '49999.800001');

  // Execute deposit
  const depReceipt = engine.applyDeposit({
    txid: 'a'.repeat(64),
    address: alice.address,
    amountPoa: '25000.000000',
    lockEpochs: 4,
  });

  assert.equal(depReceipt.shareOfLpPoolPercent, '20.0000');
  assert.equal(engine.bankNavMicros, 125_000_000_000n);

  // Reject dust deposits below 10 POA minimum
  const dustQuote = engine.quoteDeposit({ address: alice.address, amountPoa: '1.000000' });
  assert.equal(dustQuote.valid, false);
  assert.match(dustQuote.error, /Minimum bank deposit is 10.000000 POA/);
});

test('Edge Case 3: Kelly Criterion 1.00% Max Profit Cap across 1% to 98% Win Probabilities', () => {
  const engine = new BankrollEngine({
    dataDir: makeTempDataDir('kelly'),
    initialBootstrapPoa: '100000.000000',
  });

  assert.equal(KELLY_MAX_PROFIT_BPS, 100n);

  // At 49.50% win chance (2.0000x multiplier), max profit = 1,000 POA -> 500 POA wager is within limits
  const q50 = engine.quoteBet({
    amountPoa: '500.000000',
    targetBps: 4950,
    direction: 'under',
  });
  assert.equal(q50.multiplierDisplay, '2.0000x');
  assert.equal(q50.withinLimits, true);
  assert.equal(q50.expectedValuePoa, '-5.000000');
  assert.equal(q50.kellySizing.quarterKellyPoa, '250.000000');
  assert.equal(q50.kellySizing.halfKellyPoa, '500.000000');
  assert.equal(q50.kellySizing.fullKellyCapPoa, '1000.000000');

  // A 1,500 POA wager at 2.0000x would risk 1,500 POA profit (> 1,000 POA Kelly cap) -> flagged & rejected on bet
  const qOver = engine.quoteBet({
    amountPoa: '1500.000000',
    targetBps: 4950,
    direction: 'under',
  });
  assert.equal(qOver.withinLimits, false);

  const player = genKeypair();
  assert.throws(
    () =>
      engine.placeAndSettleBet({
        betTxid: 'b'.repeat(64),
        address: player.address,
        amountPoa: '1500.000000',
        targetBps: 4950,
        direction: 'under',
        clientSeed: 'whale-test',
      }),
    /exceeds Kelly max profit cap/
  );

  // At 1.00% win chance (99.0000x multiplier), max wager should be ~10.204081 POA so net profit <= 1,000 POA
  const qExtreme = engine.quoteBet({
    amountPoa: '10.000000',
    targetBps: 100,
    direction: 'under',
  });
  assert.equal(qExtreme.multiplierDisplay, '99.0000x');
  assert.equal(qExtreme.withinLimits, true);
});

test('Edge Case 4 & 5: Concurrent In-Flight Collateral Locking & FIFO Withdrawal Queueing', () => {
  const engine = new BankrollEngine({
    dataDir: makeTempDataDir('collateral-fifo'),
    initialBootstrapPoa: '10000.000000',
  });

  const staker = genKeypair();
  engine.applyDeposit({
    txid: '1'.repeat(64),
    address: staker.address,
    amountPoa: '10000.000000',
    lockEpochs: 1,
  });
  // Advance 1 epoch so staker's lock expires and exit fee is 0%
  engine.advanceEpoch({ distributeIncentives: false });

  // Simulate locking large collateral (15,000 POA of the 20,000 POA pool) so only 5,000 POA is unencumbered
  engine.lockedCollateralMicros = 15_000_000_000n;
  assert.equal(engine.availableBankrollMicros, 5_000_000_000n);

  // Staker owns 50% of 20,000 POA = 10,000 POA, which exceeds availableBankrollMicros (5,000 POA)
  const wQuote = engine.quoteWithdraw({
    address: staker.address,
    mode: 'ALL',
  });
  assert.equal(wQuote.instant, false);
  assert.equal(wQuote.willQueueForInFlightBets, true);

  const wReceipt = engine.applyWithdraw({
    txid: '2'.repeat(64),
    address: staker.address,
    mode: 'ALL',
  });
  assert.equal(wReceipt.action, 'LP_WITHDRAW_QUEUED');
  assert.equal(engine.withdrawalQueue.length, 1);

  // Once in-flight bets settle and release collateral, processing the queue pays the staker in full
  engine.lockedCollateralMicros = 0n;
  const flushed = engine._processWithdrawalQueue();
  assert.equal(flushed.length, 1);
  assert.equal(engine.withdrawalQueue.length, 0);
  assert.equal(
    engine.outboundQueue.some((i) => i.kind === 'LP_WITHDRAW_PAYOUT' && i.to === staker.address),
    true
  );
});

test('Edge Case 6: Anti-JIT Early-Exit Fee (0.10% if <1 epoch vs 0.00% if >=1 epoch)', () => {
  const engine = new BankrollEngine({
    dataDir: makeTempDataDir('jit-fee'),
    initialBootstrapPoa: '100000.000000',
  });

  const jitStaker = genKeypair();
  engine.applyDeposit({
    txid: '3'.repeat(64),
    address: jitStaker.address,
    amountPoa: '10000.000000',
    lockEpochs: 0,
  });

  // Immediate withdrawal in same epoch incurs 10 bps (0.10%) fee = 10.000000 POA retained by pool
  const qSameEpoch = engine.quoteWithdraw({
    address: jitStaker.address,
    mode: 'ALL',
  });
  assert.equal(qSameEpoch.earlyExitFeeBps, 10);
  assert.equal(qSameEpoch.earlyExitFeePoa, '10.000000');
  assert.equal(qSameEpoch.netPayoutPoa, '9990.000000');

  // After advancing 1 epoch, exit fee drops to 0 bps (0.00%)
  engine.advanceEpoch({ distributeIncentives: false });
  const qNextEpoch = engine.quoteWithdraw({
    address: jitStaker.address,
    mode: 'ALL',
  });
  assert.equal(qNextEpoch.earlyExitFeeBps, 0);
  assert.equal(qNextEpoch.earlyExitFeePoa, '0.000000');
  assert.equal(qNextEpoch.netPayoutPoa, '10000.000000');

  // Aged-Shell Anti-JIT Defense: if jitStaker deposits fresh capital in Epoch 2 and immediately
  // attempts to withdraw in Epoch 2, lastDepositEpoch === 2 re-enables the 10 bps anti-JIT fee!
  engine.applyDeposit({
    txid: '3b'.padEnd(64, '0'),
    address: jitStaker.address,
    amountPoa: '50000.000000',
    lockEpochs: 0,
  });
  const qAgedShell = engine.quoteWithdraw({
    address: jitStaker.address,
    mode: 'ALL',
  });
  assert.equal(qAgedShell.earlyExitFeeBps, 10);
});

test('Edge Case 7: 0.1% (10 bps) Dev Reserve Isolation & Sweep for poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U', () => {
  assert.equal(DEV_RESERVE_ADDRESS, 'poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U');
  assert.equal(DEV_FEE_BPS, 10n);

  const engine = new BankrollEngine({
    dataDir: makeTempDataDir('dev-reserve'),
    initialBootstrapPoa: '250000.000000',
  });

  const player = genKeypair();
  // Place a 1,000 POA bet -> 0.1% (10 bps) = 1.000000 POA reserved for poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
  const betReceipt = engine.placeAndSettleBet({
    betTxid: '4'.repeat(64),
    address: player.address,
    amountPoa: '1000.000000',
    targetBps: 4950,
    direction: 'under',
    clientSeed: 'dev-reserve-check',
  });

  assert.equal(betReceipt.devFeeReservedPoa, '1.000000');
  assert.equal(betReceipt.devReserveAddress, 'poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U');
  assert.equal(engine.devReserveMicros, toMicros('1.000000'));

  // Sweep the dev reserve and verify outbound transfer is queued to poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
  const sweep = engine.sweepDevReserve();
  assert.equal(sweep.swept, true);
  assert.equal(sweep.devReserveAddress, 'poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U');
  assert.equal(sweep.sweptPoa, '1.000000');
  assert.equal(engine.devReserveMicros, 0n);
});

test('Edge Case 8: 4-Pillar Agent Staking Incentives (VIP Edge Rebate + Conviction Multiplier + Epoch Compounding)', () => {
  const engine = new BankrollEngine({
    dataDir: makeTempDataDir('incentives'),
    initialBootstrapPoa: '250000.000000',
  });

  const goldAgent = genKeypair();
  // Stake 100,000 POA with 10 epochs lock + active PoA miner status
  engine.applyDeposit({
    txid: '5'.repeat(64),
    address: goldAgent.address,
    amountPoa: '100000.000000',
    lockEpochs: 10,
    isPoaMiner: true,
  });

  const pos = engine.getLpPosition(goldAgent.address);
  assert.equal(pos.vipTier.tierName, 'Tessellate Gold');
  assert.equal(pos.vipTier.houseEdgeBps, 70);
  // 10 epochs = 1.50x conviction multiplier
  assert.equal(pos.convictionMultiplier, '1.50x');

  // Verify Gold Agent gets 0.70% house edge (multiplier at 50% win chance = (10000 - 70)/5000 = 1.9860x instead of 1.9800x)
  const quoteGold = engine.quoteBet({
    address: goldAgent.address,
    amountPoa: '100.000000',
    targetBps: 5000,
    direction: 'under',
  });
  assert.equal(quoteGold.houseEdgeBps, 70);
  assert.equal(quoteGold.multiplierDisplay, '1.9860x');

  // Place a bet to fund the incentive pool (5 bps of wager) and advance epoch to compound
  engine.placeAndSettleBet({
    betTxid: '6'.repeat(64),
    address: goldAgent.address,
    amountPoa: '1000.000000',
    targetBps: 5000,
    direction: 'under',
    clientSeed: 'compound-test',
  });
  assert.equal(engine.incentivePoolMicros, toMicros('0.500000'));

  const epochRes = engine.advanceEpoch({ distributeIncentives: true });
  assert.equal(epochRes.distribution.action, 'INCENTIVES_COMPOUNDED');
  assert.equal(engine.incentivePoolMicros <= 1n, true);
});
