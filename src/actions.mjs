// @ts-nocheck
/**
 * actions.mjs — Server-side validation for every player action the browser can turn
 * into a copy-paste agent prompt (stake, unstake, claim yield, auto-bet).
 * Rolls/batches live in batch-roll.mjs. Each quote returns { valid, code, reason, ... }
 * and is shared by GET /api/quote/actions, the MCP tools and the HTTP action paths.
 */

import { fromMicros, isValidPoaAddress, toMicros } from './crypto-poa.mjs';
import { CLIENT_SEED_RE } from './batch-roll.mjs';

export const MAX_LOCK_EPOCHS = 10;
export const AUTO_STRATEGIES = Object.freeze(['flat', 'quarter_kelly', 'martingale_capped', 'paroli']);
export const WITHDRAW_TRIGGER_POA = '0.000001';

function bad(code, reason, extra = {}) {
  return { valid: false, code, reason, error: reason, ...extra };
}

function chainGate(chain, needMicros) {
  if (!chain?.required) return null;
  if (!chain.ok) return bad('chain_down', 'minepoa.com chain is unavailable (CHAIN DOWN), so signed actions are paused');
  if (needMicros !== null && chain.playerSpendableMicros !== undefined && chain.playerSpendableMicros !== null && needMicros > BigInt(chain.playerSpendableMicros)) {
    return bad('player_insufficient', `Player spendable balance ${fromMicros(chain.playerSpendableMicros)} POA cannot cover ${fromMicros(needMicros)} POA`);
  }
  return null;
}

/** Stake (deposit) into the shared bankroll, with optional conviction lock + referrer. */
export function quoteStake(engine, { address = '', amountPoa, lockEpochs = 0, referrer = '', chain = null } = {}) {
  let amountMicros;
  try {
    amountMicros = toMicros(String(amountPoa ?? '').trim());
  } catch {
    return bad('bad_amount', 'Deposit must be a positive number with up to 6 decimals');
  }
  const lock = Number(lockEpochs);
  if (!Number.isInteger(lock) || lock < 0 || lock > MAX_LOCK_EPOCHS) {
    return bad('bad_lock', `Lock must be a whole number of epochs from 0 to ${MAX_LOCK_EPOCHS}`);
  }
  const ref = String(referrer || '').trim();
  if (ref) {
    if (!isValidPoaAddress(ref)) return bad('bad_referrer', 'Referrer must be a valid poa1… address');
    if (address && ref === address) return bad('self_referral', 'You cannot refer yourself');
  }
  const q = engine.quoteDeposit({ address, amountPoa: fromMicros(amountMicros), lockEpochs: lock });
  if (!q.valid) return bad('deposit_rejected', q.error || 'Deposit rejected', { quote: q });
  const gate = chainGate(chain, amountMicros);
  if (gate) return { ...gate, quote: q };
  return {
    valid: true,
    code: 'ok',
    reason: null,
    error: null,
    amountPoa: fromMicros(amountMicros),
    lockEpochs: lock,
    referrer: ref || null,
    memo: ['DICE1:LP_ADD', ...(lock > 0 ? [`epochs=${lock}`] : []), ...(ref ? [`ref=${ref}`] : [])].join(':'),
    maxTotalSpendPoa: fromMicros(amountMicros),
    quote: q
  };
}

/** Unstake (withdraw) a % of LP shares. Needs a known position unless address is unknown. */
export function quoteUnstake(engine, { address = '', bps = 10000, chain = null } = {}) {
  const b = Number(bps);
  if (!Number.isInteger(b) || b < 1 || b > 10000) return bad('bad_bps', 'Withdraw share must be 1–10000 basis points (0.01%–100%)');
  const base = { bps: b, mode: b === 10000 ? 'ALL' : 'BPS', memo: b === 10000 ? 'DICE1:LP_WITHDRAW:ALL' : `DICE1:LP_WITHDRAW:BPS=${b}`, maxTotalSpendPoa: WITHDRAW_TRIGGER_POA };
  if (!address) {
    return { valid: true, code: 'unknown_position', reason: null, error: null, needsPositionCheck: true, ...base };
  }
  if (!isValidPoaAddress(address)) return bad('bad_address', 'Player address must be a valid poa1… address', base);
  const q = engine.quoteWithdraw({ address, mode: base.mode, bpsToRedeem: b === 10000 ? null : b });
  if (!q.valid) return bad('no_position', q.error, { ...base, quote: q });
  const gate = chainGate(chain, toMicros(WITHDRAW_TRIGGER_POA));
  if (gate) return { ...gate, ...base, quote: q };
  return { valid: true, code: 'ok', reason: null, error: null, ...base, quote: q };
}

/**
 * Claim yield: redeem only the shares worth the position's net gain (house-edge profit +
 * incentives above principal). Principal stays staked.
 */
export function quoteClaimYield(engine, { address = '', chain = null } = {}) {
  const base = { memo: 'DICE1:LP_WITHDRAW:<shares>', maxTotalSpendPoa: WITHDRAW_TRIGGER_POA };
  if (!address) return { valid: true, code: 'unknown_position', reason: null, error: null, needsPositionCheck: true, ...base };
  if (!isValidPoaAddress(address)) return bad('bad_address', 'Player address must be a valid poa1… address', base);
  const pos = engine.lpPositions.get(address);
  if (!pos || pos.shares <= 0n) return bad('no_position', 'Address holds no active LP shares in the bank', base);
  const value = engine.microsForShares(pos.shares);
  const principalLeft = pos.principalDepositedMicros - pos.principalWithdrawnMicros;
  const gain = value - (principalLeft > 0n ? principalLeft : 0n);
  if (gain <= 0n) return bad('no_yield', 'No yield to claim yet (position value is at or below principal)', base);
  let shares = (gain * engine.effectiveTotalShares) / engine.effectiveBankMicros;
  if (shares > pos.shares) shares = pos.shares;
  if (shares <= 0n) return bad('no_yield', 'Yield rounds to 0 shares', base);
  const q = engine.quoteWithdraw({ address, sharesToRedeem: shares.toString() });
  if (!q.valid) return bad('withdraw_rejected', q.error, { ...base, quote: q });
  const gate = chainGate(chain, toMicros(WITHDRAW_TRIGGER_POA));
  if (gate) return { ...gate, ...base, quote: q };
  return { valid: true, code: 'ok', reason: null, error: null, shares: shares.toString(), yieldPoa: fromMicros(gain), memo: `DICE1:LP_WITHDRAW:${shares}`, maxTotalSpendPoa: WITHDRAW_TRIGGER_POA, quote: q };
}

/** Auto-bet strategy: bounded 1..25 rolls with a hard total-spend cap. */
export function quoteAutoBet(engine, { address = '', strategy = 'flat', baseWagerPoa, targetBps, direction, rolls = 5, clientSeed = 'agent-auto', maxTotalSpendPoa = null, chain = null } = {}) {
  const strat = String(strategy || '').toLowerCase();
  if (!AUTO_STRATEGIES.includes(strat)) return bad('bad_strategy', `Strategy must be one of ${AUTO_STRATEGIES.join(', ')}`);
  const n = Number(rolls);
  if (!Number.isInteger(n) || n < 1 || n > 25) return bad('bad_rolls', 'Auto-bet rolls must be 1–25');
  if (!CLIENT_SEED_RE.test(String(clientSeed))) return bad('bad_seed', 'Client seed must be 1–48 characters: letters, digits, dot, dash or underscore');
  let base;
  try {
    base = toMicros(String(baseWagerPoa ?? '').trim());
  } catch {
    return bad('bad_wager', 'Wager must be a positive number with up to 6 decimals');
  }
  const q = engine.quoteBet({ address, amountPoa: fromMicros(base), targetBps: Number(targetBps), direction });
  if (q.multiplierMicros === undefined) return bad('bad_target', q.error || 'Invalid target or direction');
  if (!q.valid) return bad(engine.availableBankrollMicros <= 0n ? 'bank_empty' : 'bank_insufficient', q.error, { quote: q });
  // Worst-case spend: martingale doubles after each loss, so cap it explicitly.
  let worst = 0n;
  let cur = base;
  for (let i = 0; i < n; i++) {
    worst += cur;
    if (strat === 'martingale_capped') cur *= 2n;
    if (strat === 'paroli' && i < 2) cur *= 2n;
  }
  if (strat === 'quarter_kelly') {
    // quarter-Kelly resizes every roll; the full Kelly cap bounds it from above.
    const full = toMicros(q.kellySizing.fullKellyCapPoa);
    worst = (full > base ? full : base) * BigInt(n);
  }
  const cap = maxTotalSpendPoa ? toMicros(String(maxTotalSpendPoa)) : worst;
  const gate = chainGate(chain, cap);
  if (gate) return { ...gate, quote: q };
  return {
    valid: true,
    code: 'ok',
    reason: null,
    error: null,
    strategy: strat,
    rolls: n,
    baseWagerPoa: fromMicros(base),
    worstCaseSpendPoa: fromMicros(worst),
    maxTotalSpendPoa: fromMicros(cap),
    quote: q
  };
}
