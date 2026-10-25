/**
 * provably-fair.mjs — Commit-Reveal Provably Fair Dice Engine for POA Dice.
 *
 * Roll space: 10,000 discrete basis-point outcomes R in {0, 1, ..., 9999} (displayed as 0.00 .. 99.99).
 * - Roll Under T (T in [100, 9800]): Wins iff R < T. Win probability = T / 10,000.
 * - Roll Over  T (T in [199, 9899]): Wins iff R > T. Win probability = (9999 - T) / 10,000.
 *
 * Entropy binding:
 *   message = `${clientSeed}:${nonce}:${betTxid}`
 *   digest  = HMAC-SHA256(key = serverSeed, message)
 *   Unbiased 64-bit extraction with rejection threshold 18446744073709550000n (exact multiple of 10,000).
 */

import crypto from 'node:crypto';
import { sha256hex } from './crypto-poa.mjs';

export const ROLL_MODULO = 10000n;
// Floor(2^64 / 10000) * 10000 = 18446744073709550000n -> eliminates modulo bias
export const UNBIASED_UINT64_MAX = 18446744073709550000n;

export function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashServerSeed(serverSeed) {
  return sha256hex(String(serverSeed).trim());
}

export function formatRollDisplay(rollBps) {
  const n = Number(rollBps);
  const whole = Math.floor(n / 100).toString().padStart(2, '0');
  const frac = (n % 100).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

export function validateTarget({ targetBps, direction }) {
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'under' && dir !== 'over') {
    return { valid: false, error: 'direction must be "under" or "over"' };
  }
  const t = Number(targetBps);
  if (!Number.isInteger(t)) {
    return { valid: false, error: 'targetBps must be an integer (100..9899)' };
  }
  if (dir === 'under') {
    if (t < 100 || t > 9800) {
      return { valid: false, error: 'For Roll Under, targetBps must be between 100 (1.00) and 9800 (98.00)' };
    }
    return {
      valid: true,
      direction: 'under',
      targetBps: t,
      targetDisplay: formatRollDisplay(t),
      winChanceBps: t,
      winChancePercent: (t / 100).toFixed(2)
    };
  } else {
    if (t < 199 || t > 9899) {
      return { valid: false, error: 'For Roll Over, targetBps must be between 199 (1.99) and 9899 (98.99)' };
    }
    const winChanceBps = 9999 - t;
    return {
      valid: true,
      direction: 'over',
      targetBps: t,
      targetDisplay: formatRollDisplay(t),
      winChanceBps,
      winChancePercent: (winChanceBps / 100).toFixed(2)
    };
  }
}

export function computeRoll({ serverSeed, clientSeed = 'default', nonce = 1, betTxid = '0' }) {
  if (!serverSeed || typeof serverSeed !== 'string') {
    throw new Error('serverSeed is required');
  }
  const cleanClient = String(clientSeed ?? 'default');
  const cleanNonce = Number(nonce);
  const cleanTxid = String(betTxid ?? '0');
  const message = `${cleanClient}:${cleanNonce}:${cleanTxid}`;
  const digest = crypto.createHmac('sha256', Buffer.from(serverSeed, 'utf8')).update(message, 'utf8').digest();
  const hmacHex = digest.toString('hex');

  // Walk 8-byte big-endian windows across the 32-byte HMAC digest for unbiased rejection sampling
  let selectedUint64 = null;
  for (let offset = 0; offset <= 24; offset += 8) {
    const candidate = digest.readBigUInt64BE(offset);
    if (candidate < UNBIASED_UINT64_MAX) {
      selectedUint64 = candidate;
      break;
    }
  }
  if (selectedUint64 === null) {
    selectedUint64 = digest.readBigUInt64BE(0);
  }
  const rollBps = Number(selectedUint64 % ROLL_MODULO);
  return {
    rollBps,
    rollDisplay: formatRollDisplay(rollBps),
    hmacHex,
    message,
    uint64Value: selectedUint64.toString()
  };
}

export function evaluateRoll({ rollBps, targetBps, direction }) {
  const v = validateTarget({ targetBps, direction });
  if (!v.valid) throw new Error(v.error);
  const r = Number(rollBps);
  const won = v.direction === 'under' ? r < v.targetBps : r > v.targetBps;
  return {
    won,
    rollBps: r,
    rollDisplay: formatRollDisplay(r),
    targetBps: v.targetBps,
    targetDisplay: v.targetDisplay,
    direction: v.direction,
    winChanceBps: v.winChanceBps,
    winChancePercent: v.winChancePercent
  };
}

export function verifyRoll({
  serverSeed,
  serverSeedHash,
  clientSeed = 'default',
  nonce = 1,
  betTxid = '0',
  targetBps = 5000,
  direction = 'under'
}) {
  const computedHash = hashServerSeed(serverSeed);
  const seedHashMatches = serverSeedHash ? computedHash === String(serverSeedHash).trim().toLowerCase() : true;
  const roll = computeRoll({ serverSeed, clientSeed, nonce, betTxid });
  const outcome = evaluateRoll({ rollBps: roll.rollBps, targetBps, direction });
  return {
    valid: seedHashMatches,
    seedHashMatches,
    serverSeedHash: computedHash,
    expectedServerSeedHash: serverSeedHash || computedHash,
    clientSeed,
    nonce: Number(nonce),
    betTxid,
    message: roll.message,
    hmacHex: roll.hmacHex,
    uint64Value: roll.uint64Value,
    ...outcome
  };
}

export class SeedCommitManager {
  constructor(initialState = null) {
    if (initialState && initialState.currentSeed) {
      this.epochId = initialState.epochId || 1;
      this.currentSeed = initialState.currentSeed;
      this.currentSeedHash = hashServerSeed(this.currentSeed);
      this.nextSeed = initialState.nextSeed || generateServerSeed();
      this.nextSeedHash = hashServerSeed(this.nextSeed);
      this.createdAt = initialState.createdAt || Math.floor(Date.now() / 1000);
      this.betsCount = initialState.betsCount || 0;
      this.history = Array.isArray(initialState.history) ? initialState.history : [];
    } else {
      this.epochId = 1;
      this.currentSeed = generateServerSeed();
      this.currentSeedHash = hashServerSeed(this.currentSeed);
      this.nextSeed = generateServerSeed();
      this.nextSeedHash = hashServerSeed(this.nextSeed);
      this.createdAt = Math.floor(Date.now() / 1000);
      this.betsCount = 0;
      this.history = [];
    }
  }

  publicCommitment() {
    return {
      seedEpochId: this.epochId,
      serverSeedHash: this.currentSeedHash,
      nextServerSeedHash: this.nextSeedHash,
      createdAt: this.createdAt,
      betsCount: this.betsCount,
      revealedHistory: this.history.slice(-20)
    };
  }

  rotateSeed() {
    const revealed = {
      seedEpochId: this.epochId,
      serverSeed: this.currentSeed,
      serverSeedHash: this.currentSeedHash,
      betsCount: this.betsCount,
      createdAt: this.createdAt,
      revealedAt: Math.floor(Date.now() / 1000)
    };
    this.history.push(revealed);
    this.epochId += 1;
    this.currentSeed = this.nextSeed;
    this.currentSeedHash = this.nextSeedHash;
    this.nextSeed = generateServerSeed();
    this.nextSeedHash = hashServerSeed(this.nextSeed);
    this.createdAt = Math.floor(Date.now() / 1000);
    this.betsCount = 0;
    return {
      revealed,
      active: this.publicCommitment()
    };
  }
}
