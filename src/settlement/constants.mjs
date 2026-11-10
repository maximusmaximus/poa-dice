// @ts-nocheck
/**
 * settlement/constants.mjs — Shared constants and pure helpers for ChainSettlement.
 */
import { LEDGER_HOLD } from '../ledger-probe.mjs';

export const TERMINAL_OUT = new Set(['CONFIRMED', 'FAILED', 'REFUSED_DUPLICATE']);
export const OPEN_IN = new Set(['SUBMITTING', 'BROADCAST', 'SEEN']);
export const HOLD_ACTIONS = new Set(['BET', 'LP_WITHDRAW', 'WITHDRAW', 'CLAIM']);

/** Shared status row the bank writer publishes every tick (see _publishStatus). */
export const LEADER_STATUS_KEY = 'leader-status';
/** Trading hold when no bank writer has published a fresh status. */
export const NO_ACTIVE_LEADER = 'NO_ACTIVE_LEADER';
export const STANDBY_STATUS_REFRESH_MS = 2000;
export const REPLICA_RELOAD_MS = 30000;
/** Hold `writer` tag while the lease holder waits on minepoa to finish taking over (trading RECONCILING). */
export const LEADER_WAITING = 'LEADER_WAITING_ON_MINEPOA';
export const WRITER_LEASE_RENEWING_REASON =
  'The bank writer lease is being renewed or handed over between server instances. Try again in a few seconds.';

export function tradingLabel(hold) {
  if (!hold) return 'OPEN';
  if (hold.status === 'SIGNER_READ_ONLY') return 'READ_ONLY';
  if (hold.status === NO_ACTIVE_LEADER) return NO_ACTIVE_LEADER;
  return hold.status === LEDGER_HOLD ? 'PAUSED_LEDGER_UNAVAILABLE' : 'HOLD';
}

/** "bad nonce 5 (expected 6)" / "bad nonce: expected 6, got 5" -> 6; null when not a nonce error. */
export function parseExpectedNonce(error) {
  const m = /nonce[^0-9]*?(?:\d+\s*)?\(?\s*expected\s*:?\s*(\d+)/i.exec(String(error || ''));
  return m ? Number(m[1]) : null;
}

export function isRejectedReceipt(receipt) {
  return !!receipt && typeof receipt === 'object' && /^(rejected|invalid|failed)$/i.test(String(receipt.status || ''));
}

export function now() {
  return Date.now();
}

export function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
