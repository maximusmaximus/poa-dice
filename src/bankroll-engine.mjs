// @ts-nocheck
/**
 * bankroll-engine.mjs — Bulletproof BigInt Micro-POA Bankroll Vault & Dice Settlement Engine.
 *
 * Key Guarantees:
 *   1. Pure BigInt micro-POA math (1 POA = 1,000,000 micros). Zero floating-point arithmetic in accounting.
 *   2. 0.1% (10 bps) Dev Earnings Reserve strictly segregated under:
 *      poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
 *   3. ERC-4626 style share accounting with virtual offset (B_offset = 1 POA, S_offset = 10^12 units)
 *      to make first-depositor / share-inflation donation attacks mathematically impossible.
 *   4. Kelly Criterion max-profit cap (default 1.00% of available unencumbered bankroll B_avail) +
 *      strict in-flight collateral locking (B_locked) so concurrent bets can never over-commit the bank.
 *   5. Safe automatic refund queue (REFUND_QUEUED) for out-of-bounds or malformed on-chain memo bets.
 *   6. 4-Pillar Agent Staking Incentives:
 *      - Time-weighted Conviction Multiplier (1.00x -> 1.50x over 10 epochs)
 *      - Stake-to-Play VIP House Edge Rebate (1.00% -> 0.90% / 0.80% / 0.70%)
 *      - PoA Active Miner / Attester Bonus (+10% incentive weight)
 *      - Agent Syndicate Referral Staking Bonus (+10% referral slice from incentive pool)
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MICROS_PER_POA,
  canonical,
  fromMicros,
  isValidPoaAddress,
  sanitizeUntrustedText,
  sha256hex,
  toMicros
} from './crypto-poa.mjs';
import { SeedCommitManager, computeRoll, evaluateRoll, validateTarget, hashServerSeed } from './provably-fair.mjs';

export const DEV_RESERVE_ADDRESS = 'poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U';
export const DEFAULT_BANK_ADDRESS = 'poa1BankVaultTessellateArmyDicePool1111111111111';

export const VIRTUAL_BANK_OFFSET_MICROS = 1_000_000n; // 1.000000 POA virtual offset
export const VIRTUAL_SHARE_OFFSET = 1_000_000_000_000n; // 10^12 share units per 1 POA initial price

export const MIN_DEPOSIT_MICROS = 10_000_000n; // 10.000000 POA minimum LP stake
export const DEFAULT_MAX_BANKROLL_MICROS = 500_000_000_000_000n; // 500,000,000.000000 POA cap
export const MIN_BET_MICROS = 1_000_000n; // 1.000000 POA minimum wager

export const BASE_HOUSE_EDGE_BPS = 100n; // 1.00% base house edge
export const DEV_FEE_BPS = 10n; // 0.10% (10 bps) reserved for poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
export const INCENTIVE_POOL_BPS = 5n; // 0.05% (5 bps) allocated to Agent Staking Incentive Pool
export const KELLY_MAX_PROFIT_BPS = 100n; // Max profit per bet = 1.00% (100 bps) of B_avail
export const EARLY_EXIT_FEE_BPS = 10n; // 0.10% exit fee if withdrawn in < 1 epoch (retained by pool)

// Stake-to-Play VIP Rebate Tiers (based on LP stake value in micro-POA)
export const VIP_TIERS = [
  { name: 'Tessellate Gold', minStakeMicros: 100_000n * MICROS_PER_POA, houseEdgeBps: 70n, rebateBps: 30n },
  { name: 'Silver Agent', minStakeMicros: 10_000n * MICROS_PER_POA, houseEdgeBps: 80n, rebateBps: 20n },
  { name: 'Bronze Staker', minStakeMicros: 1_000n * MICROS_PER_POA, houseEdgeBps: 90n, rebateBps: 10n },
  { name: 'Standard', minStakeMicros: 0n, houseEdgeBps: 100n, rebateBps: 0n }
];

export class BankrollEngine {
  constructor(options = {}) {
    this.dataDir = options.dataDir || null;
    this.bankAddress = options.bankAddress || DEFAULT_BANK_ADDRESS;
    this.devReserveAddress = DEV_RESERVE_ADDRESS; // Locked to Max's PoA address
    this.devFeeMode = options.devFeeMode || 'gross_and_earnings'; // 'gross_and_earnings' | 'net_profit_only'
    this.maxBankrollCapMicros = toMicros(options.maxBankrollCapPoa ?? '500000000.000000');
    this.kellyMaxProfitBps = BigInt(options.kellyMaxProfitBps ?? KELLY_MAX_PROFIT_BPS);
    this.currentEpoch = Number(options.currentEpoch ?? 1);
    // Nominal epoch length (seconds). Epochs advance only when the operator calls advanceEpoch
    // (POST /api/epoch/advance); this length is what lock-up estimates use.
    this.epochLengthSeconds = Math.max(1, Number(options.epochLengthSeconds ?? process.env.POA_DICE_EPOCH_SECONDS ?? 21600));
    this.epochStartedAt = Math.floor(Date.now() / 1000); // unix seconds; null when unknown (restored legacy state)

    // Core accounting buckets (all in BigInt micro-POA or share units)
    this.bankNavMicros = 0n; // Net LP equity (excluding devReserve, incentivePool, and pending payouts)
    this.lockedCollateralMicros = 0n; // Locked max profit + fees for in-flight unsettled bets
    this.totalShares = 0n; // Total active LP shares issued

    // Segregated 0.1% Dev Reserve under poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
    this.devReserveMicros = 0n;
    this.totalDevEarnedMicros = 0n;
    this.totalDevSweptMicros = 0n;

    // Agent Staking Incentive Pool
    this.incentivePoolMicros = 0n;
    this.totalIncentivesDistributedMicros = 0n;

    // Lifetime telemetry
    this.totalBetsCount = 0;
    this.totalVolumeMicros = 0n;
    this.totalPlayerWinsCount = 0;
    this.totalPlayerLossesCount = 0;
    this.netHouseProfitMicros = 0n; // Cumulative net profit added to LP bankroll

    // State maps
    this.lpPositions = new Map(); // address -> LP position object
    this.inFlightBets = new Map(); // betTxid -> locked bet object
    this.processedTxids = new Map(); // txid -> receipt summary (idempotency guard)
    this.playerNonces = new Map(); // address -> provably fair bet count
    this.playerClientSeeds = new Map(); // address -> clientSeed string
    this.withdrawalQueue = []; // FIFO queue when withdrawal > B_avail during in-flight bets
    this.outboundQueue = []; // Serialized outbound POA payout/refund/withdraw/dev-sweep txs
    this.betHistory = []; // Recent settled bets
    this.bankHistory = []; // Recent LP deposits/withdrawals/incentives
    this.chatMessages = []; // Verified human + agent chat messages
    this.batchReservations = new Map(); // batchId -> reserved bank exposure (micros), transient
    // betTxid -> settlement ticket claimed in the shared store (transient). When present, settleBet
    // uses the ticket's nonce / seed / roll instead of computing its own, so every instance agrees.
    this.settlementTickets = new Map();
    // Ledger-first reconciliation: bank outflows found on chain that this state did not create
    // (txid -> record). Each is booked exactly once (see applyRecoveredBetWin / applyRecoveredOutflow).
    this.recoveredOutflows = new Map();
    this._deferSave = false; // batch execution writes state once at the end

    this.seedManager = new SeedCommitManager(options.seedState || null);
    this.eventListeners = new Set();

    if (this.dataDir) {
      this._loadFromDisk();
    }
    if (options.initialBootstrapPoa && this.bankNavMicros === 0n && this.totalShares === 0n) {
      const bootstrapAddr = options.bootstrapAddress || DEV_RESERVE_ADDRESS;
      this.applyDeposit({
        txid: 'genesis_bootstrap_deposit_tx',
        address: bootstrapAddr,
        amountPoa: String(options.initialBootstrapPoa),
        lockEpochs: 0,
        isPoaMiner: true,
        ts: Math.floor(Date.now() / 1000)
      });
    }
  }

  onEvent(listener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  _emit(type, payload) {
    const evt = {
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      ts: Math.floor(Date.now() / 1000),
      payload
    };
    for (const fn of this.eventListeners) {
      try {
        fn(evt);
      } catch {
        // ignore listener errors
      }
    }
    return evt;
  }

  // -------------------------------------------------------------------------
  // Accounting Invariants & Share Math
  // -------------------------------------------------------------------------
  /**
   * Locked collateral is DERIVED, never accumulated: the lock of every bet being settled in this
   * process (inFlightBets) plus every exposure reservation held here (batchReservations). Nothing else
   * can be locked, so it can never drift (e.g. across a reload of the shared vault) or go negative.
   */
  derivedLockedMicros() {
    let sum = 0n;
    for (const b of this.inFlightBets.values()) sum += BigInt(b.lockAmountMicros || 0n);
    return sum + this.reservedExposureMicros;
  }

  _syncLocked() {
    this.lockedCollateralMicros = this.derivedLockedMicros();
    return this.lockedCollateralMicros;
  }

  get availableBankrollMicros() {
    const avail = this.bankNavMicros - this.lockedCollateralMicros;
    return avail > 0n ? avail : 0n;
  }

  get effectiveBankMicros() {
    return this.bankNavMicros + VIRTUAL_BANK_OFFSET_MICROS;
  }

  get effectiveTotalShares() {
    return this.totalShares + VIRTUAL_SHARE_OFFSET;
  }

  assertAccountingInvariant() {
    if (this.bankNavMicros < 0n) {
      throw new Error(`Accounting invariant failed: bankNavMicros (${this.bankNavMicros}) < 0`);
    }
    if (this.lockedCollateralMicros < 0n) {
      throw new Error(`Accounting invariant failed: lockedCollateralMicros (${this.lockedCollateralMicros}) < 0`);
    }
    if (this.lockedCollateralMicros > this.bankNavMicros) {
      throw new Error(
        `Accounting invariant failed: lockedCollateralMicros (${this.lockedCollateralMicros}) > bankNavMicros (${this.bankNavMicros})`
      );
    }
    if (this.devReserveMicros < 0n) {
      throw new Error(`Accounting invariant failed: devReserveMicros (${this.devReserveMicros}) < 0`);
    }
    if (this.incentivePoolMicros < 0n) {
      throw new Error(`Accounting invariant failed: incentivePoolMicros (${this.incentivePoolMicros}) < 0`);
    }
    let sumShares = 0n;
    for (const pos of this.lpPositions.values()) {
      if (pos.shares < 0n) throw new Error(`Negative LP shares for ${pos.address}`);
      sumShares += pos.shares;
    }
    if (sumShares !== this.totalShares) {
      throw new Error(`Share invariant failed: sum(lpPositions.shares)=${sumShares} !== totalShares=${this.totalShares}`);
    }
    return true;
  }

  /**
   * Shares minted for a deposit. While real shares and real NAV exist, mint at the real price
   * (totalShares / NAV, rounded down, so existing LPs are never diluted). The virtual offset is used
   * only to price the first deposit (or a fully drained bank), which is what it is for.
   */
  sharesForDepositMicros(depositMicros) {
    const d = BigInt(depositMicros);
    if (d <= 0n) return 0n;
    if (this.totalShares > 0n && this.bankNavMicros > 0n) return (d * this.totalShares) / this.bankNavMicros;
    return (d * this.effectiveTotalShares) / this.effectiveBankMicros;
  }

  /**
   * POA value of LP shares: exactly NAV * shares / totalShares, rounded down. The sum over all LPs can
   * never exceed NAV (the old virtual-offset formula overstated value whenever the share price fell
   * below its initial 1.0, e.g. 9.960359 for a 9.956395 NAV after one player win).
   */
  microsForShares(shares) {
    const s = BigInt(shares);
    if (s <= 0n) return 0n;
    if (this.totalShares > 0n) return (s * this.bankNavMicros) / this.totalShares;
    return (s * this.effectiveBankMicros) / this.effectiveTotalShares;
  }

  convictionMultiplierBps(pos) {
    if (!pos || pos.shares <= 0n) return 10000n; // 1.00x = 10000 bps
    const epochsHeld = Math.max(0, this.currentEpoch - (pos.stakedAtEpoch || this.currentEpoch));
    const lockBonusEpochs = Math.max(0, (pos.lockUntilEpoch || 0) - this.currentEpoch);
    const effectiveEpochs = epochsHeld + lockBonusEpochs;
    // +5% (500 bps) per epoch up to 1.50x (15000 bps)
    const mult = 10000n + BigInt(Math.min(10, effectiveEpochs)) * 500n;
    return mult;
  }

  getVipTierForAddress(address) {
    const pos = this.lpPositions.get(address);
    const stakeValueMicros = pos ? this.microsForShares(pos.shares) : 0n;
    for (const tier of VIP_TIERS) {
      if (stakeValueMicros >= tier.minStakeMicros) {
        return {
          tierName: tier.name,
          stakeValueMicros: stakeValueMicros.toString(),
          stakeValuePoa: fromMicros(stakeValueMicros),
          houseEdgeBps: Number(tier.houseEdgeBps),
          houseEdgePercent: (Number(tier.houseEdgeBps) / 100).toFixed(2),
          rebateBps: Number(tier.rebateBps)
        };
      }
    }
    return {
      tierName: 'Standard',
      stakeValueMicros: '0',
      stakeValuePoa: '0.000000',
      houseEdgeBps: 100,
      houseEdgePercent: '1.00',
      rebateBps: 0
    };
  }

  // -------------------------------------------------------------------------
  // LP Bankroll Deposits & Withdrawals
  // -------------------------------------------------------------------------
  quoteDeposit({ address = '', amountPoa, lockEpochs = 0 }) {
    const amountMicros = toMicros(amountPoa);
    if (amountMicros < MIN_DEPOSIT_MICROS) {
      return {
        valid: false,
        error: `Minimum bank deposit is ${fromMicros(MIN_DEPOSIT_MICROS)} POA`,
        minDepositPoa: fromMicros(MIN_DEPOSIT_MICROS)
      };
    }
    if (this.bankNavMicros + amountMicros > this.maxBankrollCapMicros) {
      return {
        valid: false,
        error: `Deposit exceeds bankroll cap (${fromMicros(this.maxBankrollCapMicros)} POA)`,
        maxRemainingDepositPoa: fromMicros(
          this.maxBankrollCapMicros > this.bankNavMicros ? this.maxBankrollCapMicros - this.bankNavMicros : 0n
        )
      };
    }

    const mintedShares = this.sharesForDepositMicros(amountMicros);
    if (mintedShares <= 0n) {
      return {
        valid: false,
        error: 'Deposit amount too small to mint positive bank shares'
      };
    }

    const existingPos = address ? this.lpPositions.get(address) : null;
    const prevShares = existingPos ? existingPos.shares : 0n;
    const newAddressShares = prevShares + mintedShares;
    const newTotalShares = this.totalShares + mintedShares;
    const newEffectiveTotalShares = newTotalShares + VIRTUAL_SHARE_OFFSET;
    const newBankNavMicros = this.bankNavMicros + amountMicros;
    const newEffectiveBankMicros = newBankNavMicros + VIRTUAL_BANK_OFFSET_MICROS;

    // Ownership % of LP shares and of total pool (with virtual offset)
    const ownershipOfLpPct = newTotalShares > 0n ? Number((newAddressShares * 1000000n) / newTotalShares) / 10000 : 0;
    const ownershipEffectivePct = Number((newAddressShares * 1000000n) / newEffectiveTotalShares) / 10000;

    // Immediate redemption value if redeemed right after deposit (before exit fee): NAV * shares / total
    const immediateRedeemableMicros = (newAddressShares * newBankNavMicros) / newTotalShares;

    // Projected redemption value at various bankroll growth levels (+0%, +10%, +25%, +50%, +100%)
    const projections = [0, 10, 25, 50, 100].map((growthPct) => {
      const projectedBank = newBankNavMicros + (newBankNavMicros * BigInt(growthPct)) / 100n;
      const projectedValueMicros = (newAddressShares * projectedBank) / newTotalShares;
      const netGainMicros =
        projectedValueMicros > (existingPos ? existingPos.netInvestedMicros : 0n) + amountMicros
          ? projectedValueMicros - ((existingPos ? existingPos.netInvestedMicros : 0n) + amountMicros)
          : 0n;
      return {
        bankrollGrowthPercent: growthPct,
        projectedBankNavPoa: fromMicros(newBankNavMicros + (newBankNavMicros * BigInt(growthPct)) / 100n),
        projectedPositionValuePoa: fromMicros(projectedValueMicros),
        projectedNetProfitPoa: fromMicros(netGainMicros)
      };
    });

    // VIP tier after deposit
    let unlockedVip = VIP_TIERS[VIP_TIERS.length - 1];
    for (const tier of VIP_TIERS) {
      if (immediateRedeemableMicros >= tier.minStakeMicros) {
        unlockedVip = tier;
        break;
      }
    }

    const lockE = Math.max(0, Math.min(1000, Number(lockEpochs || 0)));
    const initialConvictionMultiplier = (1 + Math.min(10, lockE) * 0.05).toFixed(2);

    return {
      valid: true,
      depositPoa: fromMicros(amountMicros),
      depositMicros: amountMicros.toString(),
      sharesMinted: mintedShares.toString(),
      newAddressShares: newAddressShares.toString(),
      newTotalShares: newTotalShares.toString(),
      shareOfLpPoolPercent: ownershipOfLpPct.toFixed(4),
      shareOfEffectiveBankPercent: ownershipEffectivePct.toFixed(4),
      immediateRedeemablePoa: fromMicros(immediateRedeemableMicros),
      earlyExitFeePercent: '0.10',
      afterOneEpochExitFeePercent: '0.00',
      lockEpochs: lockE,
      initialConvictionMultiplier: `${initialConvictionMultiplier}x`,
      unlockedVipTier: {
        name: unlockedVip.name,
        houseEdgePercent: (Number(unlockedVip.houseEdgeBps) / 100).toFixed(2),
        rebateBps: Number(unlockedVip.rebateBps)
      },
      projections
    };
  }

  applyDeposit({
    txid,
    address,
    amountPoa,
    lockEpochs = 0,
    referrer = null,
    isPoaMiner = false,
    ts = Math.floor(Date.now() / 1000)
  }) {
    if (!txid) throw new Error('txid is required for deposit idempotency');
    if (this.processedTxids.has(txid)) {
      return { idempotent: true, ...this.processedTxids.get(txid) };
    }
    if (!isValidPoaAddress(address)) {
      throw new Error(`Invalid depositor POA address: ${address}`);
    }
    const quote = this.quoteDeposit({ address, amountPoa, lockEpochs });
    if (!quote.valid) {
      throw new Error(quote.error);
    }

    const amountMicros = toMicros(amountPoa);
    const mintedShares = BigInt(quote.sharesMinted);
    const lockE = Math.max(0, Math.min(1000, Number(lockEpochs || 0)));

    let pos = this.lpPositions.get(address);
    if (!pos) {
      pos = {
        address,
        shares: 0n,
        principalDepositedMicros: 0n,
        principalWithdrawnMicros: 0n,
        netInvestedMicros: 0n,
        incentivesEarnedMicros: 0n,
        referralEarnedMicros: 0n,
        stakedAtEpoch: this.currentEpoch,
        lastDepositEpoch: this.currentEpoch,
        lockUntilEpoch: this.currentEpoch + lockE,
        referrer: referrer && isValidPoaAddress(referrer) && referrer !== address ? referrer : null,
        isPoaMiner: Boolean(isPoaMiner),
        updatedAt: ts
      };
      this.lpPositions.set(address, pos);
    } else {
      // Share-weighted conviction epoch blending + strict anti-JIT lastDepositEpoch stamp
      if (pos.shares === 0n) {
        pos.stakedAtEpoch = this.currentEpoch;
      } else {
        const weightedEpoch =
          (pos.shares * BigInt(pos.stakedAtEpoch || this.currentEpoch) +
            mintedShares * BigInt(this.currentEpoch)) /
          (pos.shares + mintedShares);
        pos.stakedAtEpoch = Number(weightedEpoch);
      }
      pos.lastDepositEpoch = this.currentEpoch;
      if (this.currentEpoch + lockE > pos.lockUntilEpoch) {
        pos.lockUntilEpoch = this.currentEpoch + lockE;
      }
      if (!pos.referrer && referrer && isValidPoaAddress(referrer) && referrer !== address) {
        pos.referrer = referrer;
      }
      if (isPoaMiner) pos.isPoaMiner = true;
      pos.updatedAt = ts;
    }

    pos.shares += mintedShares;
    pos.principalDepositedMicros += amountMicros;
    pos.netInvestedMicros += amountMicros;

    this.bankNavMicros += amountMicros;
    this.totalShares += mintedShares;

    this.assertAccountingInvariant();
    this._processWithdrawalQueue();

    const receipt = {
      action: 'LP_DEPOSIT',
      txid,
      address,
      depositPoa: fromMicros(amountMicros),
      sharesMinted: mintedShares.toString(),
      totalAddressShares: pos.shares.toString(),
      shareOfLpPoolPercent: quote.shareOfLpPoolPercent,
      bankNavPoa: fromMicros(this.bankNavMicros),
      availableBankrollPoa: fromMicros(this.availableBankrollMicros),
      lockUntilEpoch: pos.lockUntilEpoch,
      ts
    };
    this.processedTxids.set(txid, receipt);
    this.bankHistory.unshift(receipt);
    if (this.bankHistory.length > 200) this.bankHistory.pop();

    this._saveToDisk();
    this._emit('bank.deposit', receipt);
    return receipt;
  }

  quoteWithdraw({ address, sharesToRedeem = null, bpsToRedeem = null, mode = 'ALL' }) {
    const pos = this.lpPositions.get(address);
    if (!pos || pos.shares <= 0n) {
      return { valid: false, error: 'Address holds no active LP shares in the bank' };
    }
    if (this.currentEpoch < (pos.lockUntilEpoch || 0)) {
      return {
        valid: false,
        error: `Position is conviction-locked until epoch ${pos.lockUntilEpoch} (current epoch: ${this.currentEpoch})`
      };
    }

    let redeemShares = pos.shares;
    const upperMode = String(mode || 'ALL').toUpperCase();
    if (sharesToRedeem !== null && sharesToRedeem !== undefined && String(sharesToRedeem) !== '') {
      redeemShares = BigInt(sharesToRedeem);
    } else if (bpsToRedeem !== null && bpsToRedeem !== undefined) {
      const bps = BigInt(Math.max(1, Math.min(10000, Number(bpsToRedeem))));
      redeemShares = (pos.shares * bps) / 10000n;
    } else if (upperMode !== 'ALL') {
      return { valid: false, error: 'Specify mode="ALL", sharesToRedeem, or bpsToRedeem (1..10000)' };
    }

    if (redeemShares <= 0n || redeemShares > pos.shares) {
      return {
        valid: false,
        error: `Invalid sharesToRedeem (${redeemShares}); you hold ${pos.shares} shares`
      };
    }

    const grossMicros = this.microsForShares(redeemShares);
    if (grossMicros <= 0n) {
      return { valid: false, error: 'Redeemable value rounds to 0 micro-POA' };
    }

    const lastDepEpoch = pos.lastDepositEpoch ?? pos.stakedAtEpoch ?? this.currentEpoch;
    const sameEpochExit = this.currentEpoch <= lastDepEpoch;
    const exitFeeBps = sameEpochExit ? EARLY_EXIT_FEE_BPS : 0n;
    const exitFeeMicros = (grossMicros * exitFeeBps) / 10000n;
    const netPayoutMicros = grossMicros - exitFeeMicros;
    const instant = grossMicros <= this.availableBankrollMicros;

    const remainingShares = pos.shares - redeemShares;
    const remainingTotalShares = this.totalShares - redeemShares;
    const newShareOfLpPercent =
      remainingTotalShares > 0n ? Number((remainingShares * 1000000n) / remainingTotalShares) / 10000 : 0;

    return {
      valid: true,
      address,
      sharesRedeemed: redeemShares.toString(),
      remainingShares: remainingShares.toString(),
      grossValuePoa: fromMicros(grossMicros),
      grossValueMicros: grossMicros.toString(),
      earlyExitFeeBps: Number(exitFeeBps),
      earlyExitFeePoa: fromMicros(exitFeeMicros),
      netPayoutPoa: fromMicros(netPayoutMicros),
      netPayoutMicros: netPayoutMicros.toString(),
      instant,
      willQueueForInFlightBets: !instant,
      newShareOfLpPercent: newShareOfLpPercent.toFixed(4)
    };
  }

  applyWithdraw({
    txid,
    address,
    sharesToRedeem = null,
    bpsToRedeem = null,
    mode = 'ALL',
    triggerRefundMicros = 0n,
    ts = Math.floor(Date.now() / 1000)
  }) {
    if (!txid) throw new Error('txid is required for withdrawal idempotency');
    if (this.processedTxids.has(txid)) {
      return { idempotent: true, ...this.processedTxids.get(txid) };
    }
    if (!isValidPoaAddress(address)) {
      throw new Error(`Invalid withdrawer POA address: ${address}`);
    }

    const quote = this.quoteWithdraw({ address, sharesToRedeem, bpsToRedeem, mode });
    if (!quote.valid) {
      throw new Error(quote.error);
    }

    const redeemShares = BigInt(quote.sharesRedeemed);
    if (!quote.instant) {
      // Queue FIFO until in-flight bets release lockedCollateralMicros
      const queuedItem = {
        action: 'LP_WITHDRAW_QUEUED',
        txid,
        address,
        sharesToRedeem: redeemShares.toString(),
        triggerRefundMicros: BigInt(triggerRefundMicros).toString(),
        estimatedNetPayoutPoa: quote.netPayoutPoa,
        queuedAt: ts,
        status: 'QUEUED'
      };
      this.withdrawalQueue.push(queuedItem);
      this.processedTxids.set(txid, queuedItem);
      this._saveToDisk();
      this._emit('bank.withdraw_queued', queuedItem);
      return queuedItem;
    }

    return this._executeImmediateWithdraw({
      txid,
      address,
      redeemShares,
      triggerRefundMicros: BigInt(triggerRefundMicros),
      ts
    });
  }

  _executeImmediateWithdraw({ txid, address, redeemShares, triggerRefundMicros = 0n, ts }) {
    const pos = this.lpPositions.get(address);
    const grossMicros = this.microsForShares(redeemShares);
    const lastDepEpoch = pos.lastDepositEpoch ?? pos.stakedAtEpoch ?? this.currentEpoch;
    const sameEpochExit = this.currentEpoch <= lastDepEpoch;
    const exitFeeBps = sameEpochExit ? EARLY_EXIT_FEE_BPS : 0n;
    const exitFeeMicros = (grossMicros * exitFeeBps) / 10000n;
    const netPayoutMicros = grossMicros - exitFeeMicros;

    pos.shares -= redeemShares;
    pos.principalWithdrawnMicros += netPayoutMicros;
    pos.netInvestedMicros = pos.netInvestedMicros > netPayoutMicros ? pos.netInvestedMicros - netPayoutMicros : 0n;
    pos.updatedAt = ts;

    this.totalShares -= redeemShares;
    // Notice: exitFeeMicros stays inside bankNavMicros, increasing share value for remaining LPs!
    this.bankNavMicros -= netPayoutMicros;

    const totalOutboundMicros = netPayoutMicros + triggerRefundMicros;
    const outboundTx = this._enqueueOutboundTransfer({
      sourceTxid: txid,
      kind: 'LP_WITHDRAW_PAYOUT',
      to: address, // Strictly pinned to LP's own poa1... address
      amountMicros: totalOutboundMicros,
      memo: `DICE1:PAYOUT:LP_WITHDRAW:${txid.slice(0, 16)}:net=${fromMicros(netPayoutMicros)}`
    });

    this.assertAccountingInvariant();

    const receipt = {
      action: 'LP_WITHDRAW',
      status: 'COMPLETED',
      txid,
      address,
      sharesRedeemed: redeemShares.toString(),
      remainingShares: pos.shares.toString(),
      grossValuePoa: fromMicros(grossMicros),
      exitFeeRetainedByPoolPoa: fromMicros(exitFeeMicros),
      netPayoutPoa: fromMicros(netPayoutMicros),
      triggerRefundPoa: fromMicros(triggerRefundMicros),
      totalSentPoa: fromMicros(totalOutboundMicros),
      payoutOrderId: outboundTx.orderId,
      bankNavPoa: fromMicros(this.bankNavMicros),
      ts
    };

    this.processedTxids.set(txid, receipt);
    this.bankHistory.unshift(receipt);
    if (this.bankHistory.length > 200) this.bankHistory.pop();

    this._saveToDisk();
    this._emit('bank.withdraw', receipt);
    return receipt;
  }

  _processWithdrawalQueue() {
    if (!this.withdrawalQueue.length) return [];
    const executed = [];
    const remaining = [];
    for (const item of this.withdrawalQueue) {
      const pos = this.lpPositions.get(item.address);
      if (!pos || pos.shares <= 0n) continue;
      const reqShares = BigInt(item.sharesToRedeem);
      const redeemShares = reqShares > pos.shares ? pos.shares : reqShares;
      const grossMicros = this.microsForShares(redeemShares);
      if (grossMicros <= this.availableBankrollMicros) {
        const res = this._executeImmediateWithdraw({
          txid: item.txid,
          address: item.address,
          redeemShares,
          triggerRefundMicros: BigInt(item.triggerRefundMicros || 0),
          ts: Math.floor(Date.now() / 1000)
        });
        executed.push(res);
      } else {
        remaining.push(item);
      }
    }
    this.withdrawalQueue = remaining;
    return executed;
  }

  getLpPosition(address) {
    const pos = this.lpPositions.get(address);
    if (!pos || pos.shares <= 0n) {
      return {
        address,
        hasPosition: false,
        shares: '0',
        shareOfLpPoolPercent: '0.0000',
        currentValuePoa: '0.000000',
        principalDepositedPoa: pos ? fromMicros(pos.principalDepositedMicros) : '0.000000',
        principalWithdrawnPoa: pos ? fromMicros(pos.principalWithdrawnMicros) : '0.000000',
        unrealizedPnlPoa: '0.000000',
        convictionMultiplier: '1.00x',
        vipTier: this.getVipTierForAddress(address)
      };
    }
    const currentValueMicros = this.microsForShares(pos.shares);
    const shareOfLpPct = this.totalShares > 0n ? Number((pos.shares * 1000000n) / this.totalShares) / 10000 : 0;
    const totalRealizedAndCurrent = currentValueMicros + pos.principalWithdrawnMicros;
    const netPnlMicros = totalRealizedAndCurrent - pos.principalDepositedMicros;
    const convBps = this.convictionMultiplierBps(pos);

    return {
      address,
      hasPosition: true,
      shares: pos.shares.toString(),
      shareOfLpPoolPercent: shareOfLpPct.toFixed(4),
      currentValuePoa: fromMicros(currentValueMicros),
      currentValueMicros: currentValueMicros.toString(),
      principalDepositedPoa: fromMicros(pos.principalDepositedMicros),
      principalWithdrawnPoa: fromMicros(pos.principalWithdrawnMicros),
      netPnlPoa: fromMicros(netPnlMicros),
      incentivesEarnedPoa: fromMicros(pos.incentivesEarnedMicros),
      referralEarnedPoa: fromMicros(pos.referralEarnedMicros),
      stakedAtEpoch: pos.stakedAtEpoch,
      lockUntilEpoch: pos.lockUntilEpoch,
      convictionMultiplier: `${(Number(convBps) / 10000).toFixed(2)}x`,
      isPoaMiner: pos.isPoaMiner,
      referrer: pos.referrer,
      vipTier: this.getVipTierForAddress(address)
    };
  }

  // -------------------------------------------------------------------------
  // Dice Bet Quoting, Collateral Locking, Settlement & Safe Refunds
  // -------------------------------------------------------------------------
  quoteBet({ address = '', amountPoa = '10.000000', targetBps = 4950, direction = 'under' }) {
    const tVal = validateTarget({ targetBps, direction });
    if (!tVal.valid) {
      return { valid: false, error: tVal.error };
    }

    const vip = address ? this.getVipTierForAddress(address) : this.getVipTierForAddress('');
    const houseEdgeBps = BigInt(vip.houseEdgeBps);
    const winChanceBps = BigInt(tVal.winChanceBps);

    // Exact multiplier in micros: floor(((10000 - houseEdgeBps) * 10^6) / winChanceBps)
    const multiplierMicros = ((10000n - houseEdgeBps) * MICROS_PER_POA) / winChanceBps;
    const multiplierDisplay = (Number(multiplierMicros) / 1_000_000).toFixed(4);

    // Kelly Criterion Max Profit & Max Wager for this target
    const availMicros = this.availableBankrollMicros;
    const maxProfitMicros = (availMicros * this.kellyMaxProfitBps) / 10000n;
    const netMultMicros = multiplierMicros > MICROS_PER_POA ? multiplierMicros - MICROS_PER_POA : 1n;
    const maxWagerMicros = (maxProfitMicros * MICROS_PER_POA) / netMultMicros;

    let amountMicros;
    try {
      amountMicros = toMicros(amountPoa);
    } catch (e) {
      return { valid: false, error: e.message };
    }

    const payoutMicros = (amountMicros * multiplierMicros) / MICROS_PER_POA;
    const profitMicros = payoutMicros > amountMicros ? payoutMicros - amountMicros : 0n;

    // 0.1% (10 bps) Dev Reserve for poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
    const devFeeMicros = amountMicros > 0n ? (amountMicros * DEV_FEE_BPS >= 10000n ? (amountMicros * DEV_FEE_BPS) / 10000n : 1n) : 0n;
    // 0.05% (5 bps) Agent Staking Incentive Pool
    const incentiveFeeMicros = (amountMicros * INCENTIVE_POOL_BPS) / 10000n;
    const requiredBankLockMicros = profitMicros + devFeeMicros + incentiveFeeMicros;

    const minBetOk = amountMicros >= MIN_BET_MICROS;
    const maxProfitOk = profitMicros <= maxProfitMicros && requiredBankLockMicros <= availMicros && availMicros > 0n;
    const withinLimits = minBetOk && maxProfitOk;

    let limitReason = null;
    if (!minBetOk) {
      limitReason = `Minimum bet is ${fromMicros(MIN_BET_MICROS)} POA`;
    } else if (availMicros <= 0n) {
      limitReason = 'Bankroll has 0 available unencumbered POA';
    } else if (!maxProfitOk) {
      limitReason = `Bet profit (${fromMicros(profitMicros)} POA) exceeds Kelly max profit cap (${fromMicros(maxProfitMicros)} POA; max wager ${fromMicros(maxWagerMicros)} POA at ${multiplierDisplay}x)`;
    }

    const expectedLossMicros = (amountMicros * houseEdgeBps) / 10000n;
    const quarterKellyMicros = maxWagerMicros / 4n >= MIN_BET_MICROS ? maxWagerMicros / 4n : MIN_BET_MICROS;
    const halfKellyMicros = maxWagerMicros / 2n >= MIN_BET_MICROS ? maxWagerMicros / 2n : MIN_BET_MICROS;

    return {
      valid: withinLimits,
      withinLimits,
      error: limitReason,
      direction: tVal.direction,
      targetBps: tVal.targetBps,
      targetDisplay: tVal.targetDisplay,
      winChanceBps: tVal.winChanceBps,
      winChancePercent: tVal.winChancePercent,
      houseEdgeBps: Number(houseEdgeBps),
      houseEdgePercent: vip.houseEdgePercent,
      vipTierName: vip.tierName,
      multiplierMicros: multiplierMicros.toString(),
      multiplierDisplay: `${multiplierDisplay}x`,
      wagerPoa: fromMicros(amountMicros),
      wagerMicros: amountMicros.toString(),
      payoutOnWinPoa: fromMicros(payoutMicros),
      payoutOnWinMicros: payoutMicros.toString(),
      profitOnWinPoa: fromMicros(profitMicros),
      profitOnWinMicros: profitMicros.toString(),
      expectedValuePoa: `-${fromMicros(expectedLossMicros)}`,
      devReserveFeePoa: fromMicros(devFeeMicros),
      devReserveAddress: this.devReserveAddress,
      incentivePoolFeePoa: fromMicros(incentiveFeeMicros),
      maxAllowedWagerPoa: fromMicros(maxWagerMicros),
      maxAllowedProfitPoa: fromMicros(maxProfitMicros),
      minAllowedWagerPoa: fromMicros(MIN_BET_MICROS),
      kellySizing: {
        quarterKellyPoa: fromMicros(quarterKellyMicros),
        halfKellyPoa: fromMicros(halfKellyMicros),
        fullKellyCapPoa: fromMicros(maxWagerMicros)
      },
      availableBankrollPoa: fromMicros(availMicros)
    };
  }

  lockBetCollateral({
    betTxid,
    address,
    amountPoa,
    targetBps,
    direction,
    clientSeed = 'default',
    fromOnChainMemo = false,
    playerSig = null,
    ts = Math.floor(Date.now() / 1000)
  }) {
    if (!betTxid) throw new Error('betTxid required');
    if (this.processedTxids.has(betTxid)) {
      return { idempotent: true, ...this.processedTxids.get(betTxid) };
    }
    if (this.inFlightBets.has(betTxid)) {
      return { inFlight: true, ...this.inFlightBets.get(betTxid) };
    }
    if (!isValidPoaAddress(address)) {
      throw new Error(`Invalid player POA address: ${address}`);
    }

    const quote = this.quoteBet({ address, amountPoa, targetBps, direction });
    if (!quote.valid) {
      if (fromOnChainMemo) {
        return this.queueRefund({
          sourceTxid: betTxid,
          to: address,
          amountPoa,
          reason: quote.error || 'out_of_bounds_bet',
          ts
        });
      }
      throw new Error(quote.error || 'Bet outside allowed limits');
    }

    const wagerMicros = BigInt(quote.wagerMicros);
    const payoutMicros = BigInt(quote.payoutOnWinMicros);
    const profitMicros = BigInt(quote.profitOnWinMicros);
    const devFeeMicros = toMicros(quote.devReserveFeePoa);
    const incentiveFeeMicros = toMicros(quote.incentivePoolFeePoa);
    const lockAmountMicros = profitMicros + devFeeMicros + incentiveFeeMicros;

    const cleanSeed = sanitizeUntrustedText(
      clientSeed || this.playerClientSeeds.get(address) || 'default',
      64
    );
    this.playerClientSeeds.set(address, cleanSeed);

    const lockedBet = {
      betTxid,
      address,
      wagerMicros,
      payoutMicros,
      profitMicros,
      devFeeMicros,
      incentiveFeeMicros,
      lockAmountMicros,
      targetBps: quote.targetBps,
      targetDisplay: quote.targetDisplay,
      direction: quote.direction,
      winChanceBps: quote.winChanceBps,
      winChancePercent: quote.winChancePercent,
      multiplierDisplay: quote.multiplierDisplay,
      houseEdgePercent: quote.houseEdgePercent,
      vipTierName: quote.vipTierName,
      clientSeed: cleanSeed,
      playerSig: typeof playerSig === 'string' && playerSig.length > 0 ? playerSig.slice(0, 128) : null,
      lockedAt: ts
    };

    this.inFlightBets.set(betTxid, lockedBet);
    this._syncLocked();
    this._emit('bet.locked', {
      betTxid,
      address,
      wagerPoa: fromMicros(wagerMicros),
      targetDisplay: quote.targetDisplay,
      direction: quote.direction,
      lockedCollateralPoa: fromMicros(this.lockedCollateralMicros)
    });
    return { status: 'LOCKED', ...lockedBet };
  }

  /**
   * Deterministic settlement ticket for a bet: the nonce, seed epoch and roll are fixed here, from the
   * active committed seed. In chain mode the ticket is claimed atomically in the shared store before
   * settling, so a second instance settling the same bet adopts the first ticket instead of re-rolling.
   */
  prepareBetTicket({ betTxid, address, clientSeed = 'default', targetBps, direction }) {
    const cleanSeed = sanitizeUntrustedText(clientSeed || this.playerClientSeeds.get(address) || 'default', 64);
    const nonce = (this.playerNonces.get(address) || 0) + 1;
    const roll = computeRoll({ serverSeed: this.seedManager.currentSeed, clientSeed: cleanSeed, nonce, betTxid });
    const outcome = evaluateRoll({ rollBps: roll.rollBps, targetBps: Number(targetBps), direction });
    return {
      v: 1,
      betTxid,
      address,
      clientSeed: cleanSeed,
      nonce,
      seedEpochId: this.seedManager.epochId,
      serverSeedHash: this.seedManager.currentSeedHash,
      targetBps: outcome.targetBps,
      direction: outcome.direction,
      rollBps: roll.rollBps,
      rollDisplay: roll.rollDisplay,
      won: outcome.won,
      message: roll.message,
      hmacHex: roll.hmacHex
    };
  }

  /** Seed record shared across instances (claimed per epoch in the store). */
  seedRecord() {
    return {
      epochId: this.seedManager.epochId,
      currentSeed: this.seedManager.currentSeed,
      nextSeed: this.seedManager.nextSeed,
      createdAt: this.seedManager.createdAt
    };
  }

  /** Adopt the seed pair another instance committed first for this epoch. Returns true if it changed. */
  adoptSeedRecord(rec) {
    if (!rec || !rec.currentSeed || Number(rec.epochId) !== Number(this.seedManager.epochId)) return false;
    if (rec.currentSeed === this.seedManager.currentSeed && rec.nextSeed === this.seedManager.nextSeed) return false;
    const sm = this.seedManager;
    sm.currentSeed = rec.currentSeed;
    sm.currentSeedHash = hashServerSeed(rec.currentSeed);
    sm.nextSeed = rec.nextSeed || sm.nextSeed;
    sm.nextSeedHash = hashServerSeed(sm.nextSeed);
    if (rec.createdAt) sm.createdAt = rec.createdAt;
    return true;
  }

  settleBet(betTxid, ts = Math.floor(Date.now() / 1000)) {
    if (this.processedTxids.has(betTxid)) {
      return { idempotent: true, ...this.processedTxids.get(betTxid) };
    }
    const locked = this.inFlightBets.get(betTxid);
    if (!locked) {
      throw new Error(`No locked in-flight bet found for txid: ${betTxid}`);
    }
    // All-or-nothing up to the invariant check: if anything below throws, every change made here is
    // undone, so a bet that is refused (and refunded by the caller) never also moves the books.
    const snap = this._betSnapshot(betTxid, locked.address);
    let outcome;
    let roll;
    let ticket;
    let nextNonce;
    let serverSeedHash;
    let actualDevFeeMicros;
    let payoutOrderId = null;
    let netPlayerDeltaMicros = -locked.wagerMicros;
    try {

    // 1. Release locked collateral
    this.inFlightBets.delete(betTxid);
    this._syncLocked();

    // 2. Fix the provably-fair inputs. If a settlement ticket was claimed for this bet in the shared
    //    store (chain mode), it is authoritative: its nonce, seed epoch and roll were fixed when the bet
    //    was first booked, by whichever instance got there first. Otherwise compute the ticket here.
    const claimed = this.settlementTickets.get(betTxid) || null;
    this.settlementTickets.delete(betTxid);
    ticket = claimed;
    if (ticket && (ticket.address !== locked.address || Number(ticket.targetBps) !== Number(locked.targetBps) || ticket.direction !== locked.direction)) {
      throw new Error(`Settlement ticket for ${betTxid} does not match the locked bet; refusing to settle`);
    }
    if (!ticket) {
      ticket = this.prepareBetTicket({
        betTxid,
        address: locked.address,
        clientSeed: locked.clientSeed,
        targetBps: locked.targetBps,
        direction: locked.direction
      });
    }
    nextNonce = Number(ticket.nonce);
    this.playerNonces.set(locked.address, Math.max(this.playerNonces.get(locked.address) || 0, nextNonce));
    this.seedManager.betsCount += 1;

    serverSeedHash = ticket.serverSeedHash;
    roll = {
      rollBps: Number(ticket.rollBps),
      rollDisplay: ticket.rollDisplay,
      message: ticket.message,
      hmacHex: ticket.hmacHex
    };
    outcome = evaluateRoll({
      rollBps: roll.rollBps,
      targetBps: locked.targetBps,
      direction: locked.direction
    });

    // 3. Allocate 0.1% Dev Reserve to poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U
    actualDevFeeMicros = locked.devFeeMicros;
    if (this.devFeeMode === 'net_profit_only' && outcome.won) {
      actualDevFeeMicros = 0n;
    }
    this.devReserveMicros += actualDevFeeMicros;
    this.totalDevEarnedMicros += actualDevFeeMicros;

    // 4. Allocate Agent Staking Incentive Pool fee
    this.incentivePoolMicros += locked.incentiveFeeMicros;

    // 5. Update LP Bankroll Equity (bankNavMicros) and enqueue player payout if won

    if (outcome.won) {
      this.totalPlayerWinsCount += 1;
      // Bankroll pays net profit + devFee + incentiveFee
      const bankDeduction = locked.profitMicros + actualDevFeeMicros + locked.incentiveFeeMicros;
      this.bankNavMicros -= bankDeduction;
      this.netHouseProfitMicros -= bankDeduction;
      netPlayerDeltaMicros = locked.profitMicros;

      const outbound = this._enqueueOutboundTransfer({
        sourceTxid: betTxid,
        kind: 'BET_WIN_PAYOUT',
        to: locked.address, // Strictly pinned to player's poa1... address
        amountMicros: locked.payoutMicros,
        memo: `DICE1:WIN:${betTxid.slice(0, 16)}:roll=${roll.rollDisplay}:payout=${fromMicros(locked.payoutMicros)}`
      });
      payoutOrderId = outbound.orderId;
    } else {
      this.totalPlayerLossesCount += 1;
      const netBankAddition = locked.wagerMicros - actualDevFeeMicros - locked.incentiveFeeMicros;
      this.bankNavMicros += netBankAddition;
      this.netHouseProfitMicros += netBankAddition;
    }

    this.totalBetsCount += 1;
    this.totalVolumeMicros += locked.wagerMicros;

    this.assertAccountingInvariant();
    } catch (err) {
      this._restoreBetSnapshot(snap);
      throw err;
    }
    this._processWithdrawalQueue();

    const receipt = {
      action: 'BET_SETTLED',
      betTxid,
      address: locked.address,
      won: outcome.won,
      rollBps: roll.rollBps,
      rollDisplay: roll.rollDisplay,
      direction: locked.direction,
      targetBps: locked.targetBps,
      targetDisplay: locked.targetDisplay,
      winChancePercent: locked.winChancePercent,
      multiplierDisplay: locked.multiplierDisplay,
      houseEdgePercent: locked.houseEdgePercent,
      vipTierName: locked.vipTierName,
      wagerPoa: fromMicros(locked.wagerMicros),
      payoutPoa: outcome.won ? fromMicros(locked.payoutMicros) : '0.000000',
      netPlayerDeltaPoa: fromMicros(netPlayerDeltaMicros),
      devFeeReservedPoa: fromMicros(actualDevFeeMicros),
      devReserveAddress: this.devReserveAddress,
      devReserveTotalPoa: fromMicros(this.devReserveMicros),
      incentiveFeePoa: fromMicros(locked.incentiveFeeMicros),
      bankNavPoa: fromMicros(this.bankNavMicros),
      availableBankrollPoa: fromMicros(this.availableBankrollMicros),
      payoutOrderId,
      provablyFair: {
        seedEpochId: ticket.seedEpochId,
        serverSeedHash,
        clientSeed: ticket.clientSeed,
        nonce: nextNonce,
        betTxid,
        message: roll.message,
        hmacHex: roll.hmacHex
      },
      playerSig: locked.playerSig || null,
      ts
    };

    this.processedTxids.set(betTxid, receipt);
    this.betHistory.unshift(receipt);
    if (this.betHistory.length > 200) this.betHistory.pop();

    this._saveToDisk();
    this._emit('bet.settled', receipt);
    return receipt;
  }

  /**
   * Undo the books effects of a LOST bet whose settlement threw at the invariant check AFTER changing the
   * books (before 2026-10-26 settleBet was not all-or-nothing) and which was then refunded: the wager
   * was booked into NAV and fees AND is owed back as a refund. Only the loss branch is undone here
   * (a half-applied WIN would have queued a payout; the caller refuses to repair that case).
   */
  revertHalfAppliedLoss({ betTxid, wagerMicros }) {
    const w = BigInt(wagerMicros);
    const { devFeeMicros, incentiveFeeMicros } = this.feesForWager(w, false);
    const net = w - devFeeMicros - incentiveFeeMicros;
    this.bankNavMicros -= net;
    this.netHouseProfitMicros -= net;
    this.devReserveMicros -= devFeeMicros;
    this.totalDevEarnedMicros -= devFeeMicros;
    this.incentivePoolMicros -= incentiveFeeMicros;
    if (this.totalPlayerLossesCount > 0) this.totalPlayerLossesCount -= 1;
    if (this.totalBetsCount > 0) this.totalBetsCount -= 1;
    this.totalVolumeMicros -= w;
    this._syncLocked();
    this.assertAccountingInvariant();
    this._saveToDisk();
    const rec = { betTxid, wagerPoa: fromMicros(w), navPoa: fromMicros(net), devFeePoa: fromMicros(devFeeMicros), incentiveFeePoa: fromMicros(incentiveFeeMicros) };
    this._emit('bank.half_applied_bet_reverted', rec);
    return rec;
  }

  /** Fees the normal settle path charges on a wager (same formulas as quoteBet / settleBet). */
  feesForWager(wagerMicros, won) {
    const w = BigInt(wagerMicros);
    let devFeeMicros = w > 0n ? (w * DEV_FEE_BPS >= 10000n ? (w * DEV_FEE_BPS) / 10000n : 1n) : 0n;
    if (this.devFeeMode === 'net_profit_only' && won) devFeeMicros = 0n;
    const incentiveFeeMicros = (w * INCENTIVE_POOL_BPS) / 10000n;
    return { devFeeMicros, incentiveFeeMicros };
  }

  /**
   * Book a WON bet whose payout is already final on chain but whose settlement record was lost
   * (vault state lost; the bet was marked NEEDS_REVIEW). Same bankroll effects as settleBet's win
   * branch, using the ON-CHAIN payout amount; nothing is enqueued, so it is never paid again.
   * The roll comes from the payout memo and is recorded as an unverified claim (its seed is gone).
   */
  applyRecoveredBetWin({ betTxid, address, wagerMicros, payoutMicros, payoutTxid, targetBps = null, direction = null, memoRollDisplay = null, ts = Math.floor(Date.now() / 1000) }) {
    if (this.processedTxids.has(betTxid)) return { idempotent: true, ...this.processedTxids.get(betTxid) };
    const wager = BigInt(wagerMicros);
    const payout = BigInt(payoutMicros);
    const { devFeeMicros, incentiveFeeMicros } = this.feesForWager(wager, true);
    const profitMicros = payout - wager;
    const bankDeduction = profitMicros + devFeeMicros + incentiveFeeMicros;
    this.bankNavMicros -= bankDeduction;
    this.netHouseProfitMicros -= bankDeduction;
    this.devReserveMicros += devFeeMicros;
    this.totalDevEarnedMicros += devFeeMicros;
    this.incentivePoolMicros += incentiveFeeMicros;
    this.totalPlayerWinsCount += 1;
    this.totalBetsCount += 1;
    this.totalVolumeMicros += wager;
    const rollBps = memoRollDisplay && /^\d{1,2}\.\d{2}$/.test(memoRollDisplay) ? Math.round(parseFloat(memoRollDisplay) * 100) : null;
    const receipt = {
      action: 'BET_SETTLED',
      recovered: true,
      betTxid,
      address,
      won: true,
      rollBps,
      rollDisplay: memoRollDisplay,
      rollSource: 'payout-memo',
      rollVerified: false,
      rollNote: 'Recovered from the on-chain payout after the vault state was lost. The roll is the payout memo\'s claim; its server seed was not preserved, so it cannot be recomputed.',
      direction,
      targetBps,
      wagerPoa: fromMicros(wager),
      payoutPoa: fromMicros(payout),
      netPlayerDeltaPoa: fromMicros(profitMicros),
      devFeeReservedPoa: fromMicros(devFeeMicros),
      devReserveAddress: this.devReserveAddress,
      devReserveTotalPoa: fromMicros(this.devReserveMicros),
      incentiveFeePoa: fromMicros(incentiveFeeMicros),
      bankNavPoa: fromMicros(this.bankNavMicros),
      availableBankrollPoa: fromMicros(this.availableBankrollMicros),
      payoutOrderId: null,
      payoutTxid,
      provablyFair: null,
      ts
    };
    this.recoveredOutflows.set(payoutTxid, { kind: 'BET_WIN', betTxid, to: address, amountPoa: fromMicros(payout), bankDeductionPoa: fromMicros(bankDeduction), at: ts });
    this.processedTxids.set(betTxid, receipt);
    this.betHistory.unshift(receipt);
    if (this.betHistory.length > 200) this.betHistory.pop();
    this.assertAccountingInvariant();
    this._saveToDisk();
    this._emit('bet.settled', receipt);
    return receipt;
  }

  /** A bet whose on-chain refund was found: no bankroll effect (wager in, refund out). */
  applyRecoveredBetRefund({ betTxid, address, refundMicros, refundTxid, ts = Math.floor(Date.now() / 1000) }) {
    if (this.processedTxids.has(betTxid)) return { idempotent: true, ...this.processedTxids.get(betTxid) };
    const receipt = { action: 'REFUND_QUEUED', recovered: true, betTxid, address, refundedPoa: fromMicros(refundMicros), payoutTxid: refundTxid, reason: 'Recovered from the on-chain refund', ts };
    this.recoveredOutflows.set(refundTxid, { kind: 'BET_REFUND', betTxid, to: address, amountPoa: fromMicros(refundMicros), bankDeductionPoa: '0.000000', at: ts });
    this.processedTxids.set(betTxid, receipt);
    this._saveToDisk();
    this._emit('bet.refunded', receipt);
    return receipt;
  }

  /**
   * A final bank outflow that matches nothing this state knows (e.g. a payout made before the state
   * was lost). Booked once, against the dev reserve first when it went to the dev reserve address
   * with a sweep memo, otherwise against the LP bankroll, so the books match the chain again.
   */
  applyRecoveredOutflow({ txid, to, amountMicros, memo = '', ts = Math.floor(Date.now() / 1000) }) {
    if (this.recoveredOutflows.has(txid)) return { idempotent: true, ...this.recoveredOutflows.get(txid) };
    let remaining = BigInt(amountMicros);
    let fromDev = 0n;
    if (to === this.devReserveAddress && String(memo).startsWith('DICE1:DEV_RESERVE')) {
      fromDev = remaining > this.devReserveMicros ? this.devReserveMicros : remaining;
      this.devReserveMicros -= fromDev;
      this.totalDevSweptMicros += fromDev;
      remaining -= fromDev;
    }
    let fromNav = remaining > this.bankNavMicros ? this.bankNavMicros : remaining;
    this.bankNavMicros -= fromNav;
    this.netHouseProfitMicros -= fromNav;
    const uncovered = remaining - fromNav;
    const rec = {
      kind: 'UNMATCHED_OUTFLOW',
      to,
      memo: sanitizeUntrustedText(String(memo), 160),
      amountPoa: fromMicros(BigInt(amountMicros)),
      fromDevReservePoa: fromMicros(fromDev),
      bankDeductionPoa: fromMicros(fromNav),
      uncoveredPoa: fromMicros(uncovered),
      at: ts
    };
    this.recoveredOutflows.set(txid, rec);
    if (this.lockedCollateralMicros > this.bankNavMicros) this.lockedCollateralMicros = this.bankNavMicros;
    this.assertAccountingInvariant();
    this._saveToDisk();
    this._emit('bank.reconciled', { txid, ...rec });
    return rec;
  }

  placeAndSettleBet(params) {
    const lockRes = this.lockBetCollateral(params);
    if (lockRes.idempotent || lockRes.action === 'REFUND_QUEUED') {
      return lockRes;
    }
    try {
      return this.settleBet(params.betTxid, params.ts);
    } catch (err) {
      // Refused at settlement (the caller refunds it): the books are exactly as before the bet.
      this.inFlightBets.delete(params.betTxid);
      this._syncLocked();
      throw err;
    }
  }

  /** Everything settleBet changes before its invariant check (restored if that check fails). */
  _betSnapshot(betTxid, address) {
    return {
      betTxid,
      address,
      locked: this.inFlightBets.get(betTxid),
      ticket: this.settlementTickets.get(betTxid),
      hadNonce: this.playerNonces.has(address),
      nonce: this.playerNonces.get(address),
      betsCount: this.seedManager.betsCount,
      outboundLen: this.outboundQueue.length,
      n: {
        bankNavMicros: this.bankNavMicros,
        devReserveMicros: this.devReserveMicros,
        totalDevEarnedMicros: this.totalDevEarnedMicros,
        incentivePoolMicros: this.incentivePoolMicros,
        netHouseProfitMicros: this.netHouseProfitMicros,
        totalPlayerWinsCount: this.totalPlayerWinsCount,
        totalPlayerLossesCount: this.totalPlayerLossesCount,
        totalBetsCount: this.totalBetsCount,
        totalVolumeMicros: this.totalVolumeMicros
      }
    };
  }

  _restoreBetSnapshot(snap) {
    Object.assign(this, snap.n);
    if (snap.locked) this.inFlightBets.set(snap.betTxid, snap.locked);
    if (snap.ticket) this.settlementTickets.set(snap.betTxid, snap.ticket);
    if (snap.hadNonce) this.playerNonces.set(snap.address, snap.nonce);
    else this.playerNonces.delete(snap.address);
    this.seedManager.betsCount = snap.betsCount;
    this.outboundQueue.length = snap.outboundLen;
    this._syncLocked();
  }

  queueRefund({ sourceTxid, to, amountPoa, reason, full = false, ts = Math.floor(Date.now() / 1000) }) {
    if (!sourceTxid) throw new Error('sourceTxid required');
    if (this.processedTxids.has(sourceTxid)) {
      return { idempotent: true, ...this.processedTxids.get(sourceTxid) };
    }
    const grossMicros = toMicros(amountPoa);
    // Deduct 1 micro-POA anti-spam dust floor if > 1 micro-POA
    // (full=true: uncovered bets are refunded in full, nothing deducted)
    const refundMicros = !full && grossMicros > 1n ? grossMicros - 1n : grossMicros;
    let outboundOrderId = null;
    if (refundMicros > 0n && isValidPoaAddress(to)) {
      const outbound = this._enqueueOutboundTransfer({
        sourceTxid,
        kind: 'SAFE_REFUND',
        to,
        amountMicros: refundMicros,
        memo: `DICE1:REFUND:${sourceTxid.slice(0, 16)}:${sanitizeUntrustedText(reason, 80)}`
      });
      outboundOrderId = outbound.orderId;
    }
    const receipt = {
      action: 'REFUND_QUEUED',
      betTxid: sourceTxid,
      address: to,
      refundedPoa: fromMicros(refundMicros),
      reason: sanitizeUntrustedText(reason, 140),
      payoutOrderId: outboundOrderId,
      ts
    };
    this.processedTxids.set(sourceTxid, receipt);
    this._saveToDisk();
    this._emit('bet.refunded', receipt);
    return receipt;
  }

  // -------------------------------------------------------------------------
  // 0.1% Dev Reserve Sweep (Strictly to poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U)
  // -------------------------------------------------------------------------
  sweepDevReserve({ triggerTxid = null, ts = Math.floor(Date.now() / 1000) } = {}) {
    const sweepTxid = triggerTxid || `dev_sweep_${ts}_${this.totalDevSweptMicros}`;
    if (this.processedTxids.has(sweepTxid)) {
      return { idempotent: true, ...this.processedTxids.get(sweepTxid) };
    }
    if (this.devReserveMicros <= 0n) {
      return { swept: false, reason: 'devReserveMicros is currently 0.000000 POA', devReserveAddress: this.devReserveAddress };
    }
    const sweepAmountMicros = this.devReserveMicros;
    this.devReserveMicros = 0n;
    this.totalDevSweptMicros += sweepAmountMicros;

    const outbound = this._enqueueOutboundTransfer({
      sourceTxid: sweepTxid,
      kind: 'DEV_RESERVE_SWEEP',
      to: DEV_RESERVE_ADDRESS,
      amountMicros: sweepAmountMicros,
      memo: `DICE1:DEV_RESERVE_0.1PCT:${sweepTxid.slice(0, 16)}`
    });

    this.assertAccountingInvariant();

    const receipt = {
      action: 'DEV_RESERVE_SWEEP',
      swept: true,
      txid: sweepTxid,
      devReserveAddress: DEV_RESERVE_ADDRESS,
      sweptPoa: fromMicros(sweepAmountMicros),
      totalDevEarnedPoa: fromMicros(this.totalDevEarnedMicros),
      totalDevSweptPoa: fromMicros(this.totalDevSweptMicros),
      payoutOrderId: outbound.orderId,
      ts
    };
    this.processedTxids.set(sweepTxid, receipt);
    this.bankHistory.unshift(receipt);
    this._saveToDisk();
    this._emit('dev.swept', receipt);
    return receipt;
  }

  // -------------------------------------------------------------------------
  // Epoch Progression & 4-Pillar Agent Staking Incentive Distribution
  // -------------------------------------------------------------------------
  /** Epoch clock facts for lock-up warnings (what is live: operator-advanced, nominal length). */
  epochInfo() {
    return {
      current: this.currentEpoch,
      lengthSeconds: this.epochLengthSeconds,
      startedAt: this.epochStartedAt,
      advancedBy: 'operator',
      lockRule: 'position',
      withdrawWhileLocked: false,
      earlyExitFeePercent: (Number(EARLY_EXIT_FEE_BPS) / 100).toFixed(2)
    };
  }

  advanceEpoch({ distributeIncentives = true, ts = Math.floor(Date.now() / 1000) } = {}) {
    this.currentEpoch += 1;
    this.epochStartedAt = ts;
    let distribution = null;
    if (distributeIncentives && this.incentivePoolMicros > 0n && this.totalShares > 0n) {
      distribution = this.distributeEpochIncentives({ ts });
    }
    this._saveToDisk();
    this._emit('epoch.advanced', {
      currentEpoch: this.currentEpoch,
      distribution,
      ts
    });
    return {
      currentEpoch: this.currentEpoch,
      distribution
    };
  }

  distributeEpochIncentives({ ts = Math.floor(Date.now() / 1000) } = {}) {
    if (this.incentivePoolMicros <= 0n || this.totalShares <= 0n) {
      return { distributedPoa: '0.000000', recipients: 0 };
    }
    const poolToDistribute = this.incentivePoolMicros;
    const weights = [];
    let totalWeight = 0n;

    for (const pos of this.lpPositions.values()) {
      if (pos.shares <= 0n) continue;
      const convBps = this.convictionMultiplierBps(pos); // 10000..15000
      const minerBps = pos.isPoaMiner ? 11000n : 10000n; // +10% for active PoA miners
      const w = (pos.shares * convBps * minerBps) / 100000000n;
      if (w > 0n) {
        weights.push({ pos, weight: w });
        totalWeight += w;
      }
    }

    if (totalWeight <= 0n) {
      return { distributedPoa: '0.000000', recipients: 0 };
    }

    let totalAllocated = 0n;
    const payouts = [];
    for (const { pos, weight } of weights) {
      const rewardMicros = (poolToDistribute * weight) / totalWeight;
      if (rewardMicros <= 0n) continue;
      totalAllocated += rewardMicros;
      pos.incentivesEarnedMicros += rewardMicros;

      // Syndicate Referral Bonus: if referred, referrer gets 10% bonus carved from remaining pool/protocol
      let refBonusMicros = 0n;
      if (pos.referrer && this.lpPositions.has(pos.referrer)) {
        const refPos = this.lpPositions.get(pos.referrer);
        refBonusMicros = rewardMicros / 10n;
        if (totalAllocated + refBonusMicros <= poolToDistribute) {
          totalAllocated += refBonusMicros;
          refPos.referralEarnedMicros += refBonusMicros;
        } else {
          refBonusMicros = 0n;
        }
      }

      payouts.push({
        address: pos.address,
        rewardPoa: fromMicros(rewardMicros),
        convictionMultiplier: `${(Number(this.convictionMultiplierBps(pos)) / 10000).toFixed(2)}x`,
        referralBonusPoa: fromMicros(refBonusMicros)
      });
    }

    // Reinvest distributed incentives directly into bankNavMicros so all LP shares appreciate compounding!
    this.incentivePoolMicros -= totalAllocated;
    this.bankNavMicros += totalAllocated;
    this.totalIncentivesDistributedMicros += totalAllocated;

    this.assertAccountingInvariant();

    const summary = {
      action: 'INCENTIVES_COMPOUNDED',
      epoch: this.currentEpoch,
      distributedPoa: fromMicros(totalAllocated),
      remainingIncentivePoolPoa: fromMicros(this.incentivePoolMicros),
      recipientsCount: payouts.length,
      payouts,
      ts
    };
    this.bankHistory.unshift(summary);
    this._saveToDisk();
    this._emit('incentives.distributed', summary);
    return summary;
  }

  // -------------------------------------------------------------------------
  // Verified Human & Agent Chat
  // -------------------------------------------------------------------------
  postChatMessage({
    address = 'anonymous',
    senderName = '',
    text,
    isAgent = false,
    signature = null,
    verified = false,
    onChainTxid = null,
    ts = Math.floor(Date.now() / 1000)
  }) {
    const cleanText = sanitizeUntrustedText(text, 280);
    if (!cleanText) {
      throw new Error('Chat message cannot be empty');
    }
    const validAddr = isValidPoaAddress(address);
    const reallyVerified = Boolean(verified && validAddr && signature);
    const msg = {
      id: `chat_${ts}_${Math.random().toString(36).slice(2, 8)}`,
      address: validAddr ? address : 'guest',
      senderName: sanitizeUntrustedText(
        senderName || (validAddr ? `${address.slice(0, 10)}...${address.slice(-4)}` : 'Guest'),
        40
      ),
      text: cleanText,
      isAgent: Boolean(isAgent),
      verified: reallyVerified,
      signature: reallyVerified ? signature : null,
      vipTier: validAddr ? this.getVipTierForAddress(address).tierName : 'Guest',
      onChainTxid: onChainTxid || null,
      ts
    };
    this.chatMessages.unshift(msg);
    if (this.chatMessages.length > 150) this.chatMessages.pop();
    this._saveToDisk();
    this._emit('chat.message', msg);
    return msg;
  }

  // -------------------------------------------------------------------------
  // Outbound POA Transaction Queue (Single-Writer Idempotency)
  // -------------------------------------------------------------------------
  _enqueueOutboundTransfer({ sourceTxid, kind, to, amountMicros, memo }) {
    const orderId = sha256hex(`${sourceTxid}:${kind}:${to}:${amountMicros.toString()}`).slice(0, 24);
    const existing = this.outboundQueue.find((x) => x.orderId === orderId);
    if (existing) return existing;

    const item = {
      orderId,
      sourceTxid,
      kind,
      to,
      amountPoa: fromMicros(amountMicros),
      amountMicros: amountMicros.toString(),
      memo,
      status: 'PENDING',
      ledgerTxid: null,
      createdAt: Math.floor(Date.now() / 1000)
    };
    this.outboundQueue.push(item);
    return item;
  }

  markOutboundSent(orderId, ledgerTxid, status = 'SENT') {
    const item = this.outboundQueue.find((x) => x.orderId === orderId);
    if (!item) return null;
    item.ledgerTxid = ledgerTxid;
    item.status = status;
    item.sentAt = Math.floor(Date.now() / 1000);
    this._saveToDisk();
    return item;
  }

  // -------------------------------------------------------------------------
  // Cryptographic State Root & Full State Snapshot
  // -------------------------------------------------------------------------
  computeStateRoot() {
    const lpSnapshot = [...this.lpPositions.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([addr, p]) => ({
        address: addr,
        shares: p.shares.toString(),
        stakedAtEpoch: p.stakedAtEpoch,
        lockUntilEpoch: p.lockUntilEpoch
      }));

    const canonicalState = {
      bankAddress: this.bankAddress,
      devReserveAddress: this.devReserveAddress,
      currentEpoch: this.currentEpoch,
      bankNavMicros: this.bankNavMicros.toString(),
      lockedCollateralMicros: this.lockedCollateralMicros.toString(),
      totalShares: this.totalShares.toString(),
      devReserveMicros: this.devReserveMicros.toString(),
      totalDevEarnedMicros: this.totalDevEarnedMicros.toString(),
      totalDevSweptMicros: this.totalDevSweptMicros.toString(),
      incentivePoolMicros: this.incentivePoolMicros.toString(),
      totalBetsCount: this.totalBetsCount,
      totalVolumeMicros: this.totalVolumeMicros.toString(),
      seedServerHash: this.seedManager.currentSeedHash,
      lpPositions: lpSnapshot
    };
    return sha256hex(canonical(canonicalState));
  }

  verifySystemInvariants() {
    let sumStakerShares = 0n;
    for (const [, pos] of this.lpPositions.entries()) {
      sumStakerShares += pos.shares;
    }
    const shareInvariantPassed = sumStakerShares === this.totalShares;

    const solvencyPassed =
      this.bankNavMicros >= this.lockedCollateralMicros &&
      this.lockedCollateralMicros >= 0n &&
      this.devReserveMicros >= 0n &&
      this.incentivePoolMicros >= 0n &&
      this.assertAccountingInvariant();

    const devReservePinnedPassed =
      this.devReserveAddress === DEV_RESERVE_ADDRESS &&
      DEV_RESERVE_ADDRESS === 'poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U' &&
      this.devReserveMicros + this.totalDevSweptMicros === this.totalDevEarnedMicros;

    let seedAuditPassed = true;
    const seedAuditDetails = [];
    for (const item of this.seedManager.history) {
      const computedHash = sha256hex(item.serverSeed);
      const match = computedHash === item.serverSeedHash;
      if (!match) seedAuditPassed = false;
      seedAuditDetails.push({
        seedEpochId: item.seedEpochId,
        serverSeedHash: item.serverSeedHash,
        computedHash,
        match
      });
    }

    const allPassed =
      shareInvariantPassed &&
      solvencyPassed &&
      devReservePinnedPassed &&
      seedAuditPassed;

    return {
      ok: allPassed,
      auditedAt: new Date().toISOString(),
      stateRootSha256: this.computeStateRoot(),
      invariants: {
        shareInvariantPassed,
        totalShares: this.totalShares.toString(),
        sumStakerShares: sumStakerShares.toString(),
        solvencyPassed,
        bankNavPoa: fromMicros(this.bankNavMicros),
        availableBankrollPoa: fromMicros(this.availableBankrollMicros),
        lockedCollateralPoa: fromMicros(this.lockedCollateralMicros),
        devReservePinnedPassed,
        devReserveAddress: this.devReserveAddress,
        devReserveFeeBps: Number(DEV_FEE_BPS),
        devReserveAccruedPoa: fromMicros(this.devReserveMicros),
        devReserveTotalSweptPoa: fromMicros(this.totalDevSweptMicros),
        devReserveTotalEarnedPoa: fromMicros(this.totalDevEarnedMicros),
        seedAuditPassed,
        revealedSeedEpochsAudited: seedAuditDetails.length
      },
      stakersCount: [...this.lpPositions.values()].filter((p) => p.shares > 0n).length,
      recentBetsCount: this.betHistory.length
    };
  }

  getStateSummary(queryAddress = '') {
    const availMicros = this.availableBankrollMicros;
    const maxProfitMicros = (availMicros * this.kellyMaxProfitBps) / 10000n;
    const sharePricePoa = fromMicros(this.microsForShares(VIRTUAL_SHARE_OFFSET));

    const lps = [...this.lpPositions.keys()]
      .map((addr) => this.getLpPosition(addr))
      .filter((p) => p.hasPosition)
      .sort((a, b) => (BigInt(b.shares) > BigInt(a.shares) ? 1 : -1));

    return {
      protocol: 'poa-dice/v1',
      chainId: 'poa-mainnet-1',
      bankAddress: this.bankAddress,
      currentEpoch: this.currentEpoch,
      epoch: this.epochInfo(),
      stateRootSha256: this.computeStateRoot(),
      bankroll: {
        bankNavPoa: fromMicros(this.bankNavMicros),
        bankNavMicros: this.bankNavMicros.toString(),
        lockedCollateralPoa: fromMicros(this.lockedCollateralMicros),
        lockedCollateralMicros: this.lockedCollateralMicros.toString(),
        availableBankrollPoa: fromMicros(availMicros),
        availableBankrollMicros: availMicros.toString(),
        totalShares: this.totalShares.toString(),
        sharePricePerUnitPoa: sharePricePoa,
        kellyMaxProfitBps: Number(this.kellyMaxProfitBps),
        kellyMaxProfitPoa: fromMicros(maxProfitMicros),
        minBetPoa: fromMicros(MIN_BET_MICROS),
        minDepositPoa: fromMicros(MIN_DEPOSIT_MICROS),
        maxBankrollCapPoa: fromMicros(this.maxBankrollCapMicros),
        activeStakersCount: lps.length,
        inFlightBetsCount: this.inFlightBets.size,
        queuedWithdrawalsCount: this.withdrawalQueue.length
      },
      devReserve: {
        address: DEV_RESERVE_ADDRESS,
        feeBps: Number(DEV_FEE_BPS),
        feePercent: '0.10%',
        mode: this.devFeeMode,
        accruedUnpaidPoa: fromMicros(this.devReserveMicros),
        accruedUnpaidMicros: this.devReserveMicros.toString(),
        totalEarnedPoa: fromMicros(this.totalDevEarnedMicros),
        totalSweptPoa: fromMicros(this.totalDevSweptMicros),
        purpose: 'Reserved 0.1% of earnings for future development under Max / Tessellate Army address'
      },
      incentives: {
        poolBalancePoa: fromMicros(this.incentivePoolMicros),
        totalDistributedPoa: fromMicros(this.totalIncentivesDistributedMicros),
        poolAllocationBps: Number(INCENTIVE_POOL_BPS),
        convictionMaxMultiplier: '1.50x',
        poaMinerBonus: '+10%',
        syndicateReferralBonus: '+10%',
        vipTiers: VIP_TIERS.map((t) => ({
          name: t.name,
          minStakePoa: fromMicros(t.minStakeMicros),
          houseEdgePercent: (Number(t.houseEdgeBps) / 100).toFixed(2),
          rebateBps: Number(t.rebateBps)
        }))
      },
      stats: {
        totalBetsCount: this.totalBetsCount,
        totalVolumePoa: fromMicros(this.totalVolumeMicros),
        totalPlayerWinsCount: this.totalPlayerWinsCount,
        totalPlayerLossesCount: this.totalPlayerLossesCount,
        netHouseProfitPoa: fromMicros(this.netHouseProfitMicros)
      },
      provablyFair: this.seedManager.publicCommitment(),
      stakersLeaderboard: lps.slice(0, 25),
      userPosition: queryAddress ? this.getLpPosition(queryAddress) : null,
      recentBets: this.betHistory.slice(0, 30),
      recentBankActions: this.bankHistory.slice(0, 30),
      recentChat: this.chatMessages.slice(0, 50),
      offlineMemoGuide: {
        bet: `DICE1:BET:<under|over>:<targetBps>:<clientSeed> (send wager POA to ${this.bankAddress})`,
        deposit: `DICE1:LP_ADD:epochs=<0..10>:ref=<poa1...> (send deposit POA to ${this.bankAddress})`,
        withdraw: `DICE1:LP_WITHDRAW:ALL (send 0.000001 POA trigger from your LP address to ${this.bankAddress})`,
        chat: `DICE1:CHAT:<message>`
      }
    };
  }

  // -------------------------------------------------------------------------
  // Atomic Disk Persistence
  // -------------------------------------------------------------------------
  /**
   * Reserve worst-case bank exposure for a whole multi-roll batch before the first roll.
   * Reserved micros count as locked collateral, so a concurrent batch or single bet can
   * never be quoted against POA that this batch may still need to pay out.
   */
  reserveExposure(batchId, micros) {
    const amount = BigInt(micros);
    if (amount <= 0n) throw new Error('Reservation must be positive');
    if (this.batchReservations.has(batchId)) throw new Error(`Batch ${batchId} already reserved`);
    if (amount > this.availableBankrollMicros) {
      const error = new Error(
        `Bank cannot cover this batch: worst-case exposure ${fromMicros(amount)} POA exceeds available ${fromMicros(this.availableBankrollMicros)} POA`
      );
      error.status = 409;
      throw error;
    }
    this.batchReservations.set(batchId, amount);
    this._syncLocked();
    return amount;
  }

  /** Release part (or all, when micros is null) of a batch reservation. Returns micros released. */
  releaseExposure(batchId, micros = null) {
    const held = this.batchReservations.get(batchId);
    if (held === undefined) return 0n;
    let amount = micros === null ? held : BigInt(micros);
    if (amount > held) amount = held;
    const left = held - amount;
    if (left > 0n) this.batchReservations.set(batchId, left);
    else this.batchReservations.delete(batchId);
    this._syncLocked();
    return amount;
  }

  get reservedExposureMicros() {
    let sum = 0n;
    for (const v of this.batchReservations.values()) sum += v;
    return sum;
  }

  /** Plain-JSON snapshot of everything the vault must not lose (used by the file and KV stores). */
  serializeState() {
    return {
      bankAddress: this.bankAddress,
      currentEpoch: this.currentEpoch,
      epochStartedAt: this.epochStartedAt,
      devFeeMode: this.devFeeMode,
      bankNavMicros: this.bankNavMicros.toString(),
      // Locks of bets being settled right now; reservations are rebuilt from the open bets on load.
      lockedCollateralMicros: (this.derivedLockedMicros() - this.reservedExposureMicros).toString(),
      totalShares: this.totalShares.toString(),
      devReserveMicros: this.devReserveMicros.toString(),
      totalDevEarnedMicros: this.totalDevEarnedMicros.toString(),
      totalDevSweptMicros: this.totalDevSweptMicros.toString(),
      incentivePoolMicros: this.incentivePoolMicros.toString(),
      totalIncentivesDistributedMicros: this.totalIncentivesDistributedMicros.toString(),
      totalBetsCount: this.totalBetsCount,
      totalVolumeMicros: this.totalVolumeMicros.toString(),
      totalPlayerWinsCount: this.totalPlayerWinsCount,
      totalPlayerLossesCount: this.totalPlayerLossesCount,
      netHouseProfitMicros: this.netHouseProfitMicros.toString(),
      lpPositions: [...this.lpPositions.entries()].map(([k, v]) => [
        k,
        {
          ...v,
          shares: v.shares.toString(),
          principalDepositedMicros: v.principalDepositedMicros.toString(),
          principalWithdrawnMicros: v.principalWithdrawnMicros.toString(),
          netInvestedMicros: v.netInvestedMicros.toString(),
          incentivesEarnedMicros: v.incentivesEarnedMicros.toString(),
          referralEarnedMicros: v.referralEarnedMicros.toString()
        }
      ]),
      playerNonces: [...this.playerNonces.entries()],
      playerClientSeeds: [...this.playerClientSeeds.entries()],
      processedTxids: [...this.processedTxids.entries()].slice(-1000),
      recoveredOutflows: [...this.recoveredOutflows.entries()],
      withdrawalQueue: this.withdrawalQueue,
      // Never drop an unsettled order: keep every non-final item plus recent history.
      outboundQueue: this.outboundQueue.filter((x, i, all) => !['SENT_SIGNED', 'CONFIRMED', 'FAILED'].includes(x.status) || i >= all.length - 500),
      betHistory: this.betHistory.slice(0, 100),
      bankHistory: this.bankHistory.slice(0, 100),
      chatMessages: this.chatMessages.slice(0, 100),
      seedState: {
        epochId: this.seedManager.epochId,
        currentSeed: this.seedManager.currentSeed,
        nextSeed: this.seedManager.nextSeed,
        createdAt: this.seedManager.createdAt,
        betsCount: this.seedManager.betsCount,
        history: this.seedManager.history.slice(-20)
      }
    };
  }

  _saveToDisk() {
    if (this._deferSave) return;
    if (typeof this.onStateSaved === 'function') {
      try {
        this.onStateSaved();
      } catch {
        // the settlement store reports its own errors
      }
    }
    if (!this.dataDir) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const file = path.join(this.dataDir, 'bankroll-state.json');
      const tmp = file + '.tmp';
      const serialized = this.serializeState();
      const jsonStr = JSON.stringify(serialized, null, 2);
      try {
        fs.writeFileSync(tmp, jsonStr, 'utf8');
        fs.renameSync(tmp, file);
      } catch {
        fs.writeFileSync(file, jsonStr, 'utf8');
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore persistence errors in read-only environments
    }
  }

  /** Inverse of serializeState(). */
  restoreState(raw) {
    if (!raw || typeof raw !== 'object') return;
    this.bankAddress = raw.bankAddress || this.bankAddress;
    this.currentEpoch = Number(raw.currentEpoch ?? 1);
    this.epochStartedAt = raw.epochStartedAt === undefined || raw.epochStartedAt === null ? null : Number(raw.epochStartedAt);
    this.devFeeMode = raw.devFeeMode || this.devFeeMode;
    this.bankNavMicros = BigInt(raw.bankNavMicros || 0);
    // Self-heal: the stored value is only checked, never trusted. Locked collateral is derived from what
    // is actually open here (see derivedLockedMicros); a disagreeing stored value (e.g. the negative
    // value left by the reload double-subtraction fixed on 2026-10-26) is corrected and recorded.
    let storedLocked = 0n;
    try {
      storedLocked = BigInt(raw.lockedCollateralMicros || 0);
    } catch {
      storedLocked = null;
    }
    this._syncLocked();
    const storedExpected = this.derivedLockedMicros() - this.reservedExposureMicros;
    if (storedLocked !== storedExpected) {
      this.lockHeal = { at: Date.now(), storedMicros: storedLocked === null ? null : storedLocked.toString(), correctedMicros: storedExpected.toString() };
      this._emit('bank.locked_collateral_healed', this.lockHeal);
      if (typeof this.logger === 'function') this.logger(`locked collateral corrected on load: stored ${this.lockHeal.storedMicros} -> ${this.lockHeal.correctedMicros} micros`);
    }
    this.totalShares = BigInt(raw.totalShares || 0);
    this.devReserveMicros = BigInt(raw.devReserveMicros || 0);
    this.totalDevEarnedMicros = BigInt(raw.totalDevEarnedMicros || 0);
    this.totalDevSweptMicros = BigInt(raw.totalDevSweptMicros || 0);
    this.incentivePoolMicros = BigInt(raw.incentivePoolMicros || 0);
    this.totalIncentivesDistributedMicros = BigInt(raw.totalIncentivesDistributedMicros || 0);
    this.totalBetsCount = Number(raw.totalBetsCount || 0);
    this.totalVolumeMicros = BigInt(raw.totalVolumeMicros || 0);
    this.totalPlayerWinsCount = Number(raw.totalPlayerWinsCount || 0);
    this.totalPlayerLossesCount = Number(raw.totalPlayerLossesCount || 0);
    this.netHouseProfitMicros = BigInt(raw.netHouseProfitMicros || 0);

    this.lpPositions = new Map(
      (raw.lpPositions || []).map(([k, v]) => [
        k,
        {
          ...v,
          shares: BigInt(v.shares || 0),
          principalDepositedMicros: BigInt(v.principalDepositedMicros || 0),
          principalWithdrawnMicros: BigInt(v.principalWithdrawnMicros || 0),
          netInvestedMicros: BigInt(v.netInvestedMicros || 0),
          incentivesEarnedMicros: BigInt(v.incentivesEarnedMicros || 0),
          referralEarnedMicros: BigInt(v.referralEarnedMicros || 0)
        }
      ])
    );
    this.playerNonces = new Map(raw.playerNonces || []);
    this.playerClientSeeds = new Map(raw.playerClientSeeds || []);
    this.processedTxids = new Map(raw.processedTxids || []);
    this.recoveredOutflows = new Map(raw.recoveredOutflows || []);
    this.withdrawalQueue = raw.withdrawalQueue || [];
    this.outboundQueue = raw.outboundQueue || [];
    this.betHistory = raw.betHistory || [];
    this.bankHistory = raw.bankHistory || [];
    this.chatMessages = (raw.chatMessages || []).filter(
      (m) => m && m.signature !== 'genesis_welcome_sig' && m.text
    );
    if (raw.seedState) {
      this.seedManager = new SeedCommitManager(raw.seedState);
    }
  }

  _loadFromDisk() {
    if (!this.dataDir) return;
    const file = path.join(this.dataDir, 'bankroll-state.json');
    if (!fs.existsSync(file)) return;
    try {
      this.restoreState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // ignore corrupt or partial file
    }
  }
}
