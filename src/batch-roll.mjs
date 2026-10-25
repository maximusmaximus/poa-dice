// @ts-nocheck
/**
 * batch-roll.mjs — Multi-roll batches (1, 5, 100 or 1000 rolls) for POA Dice.
 *
 * One validation function (quoteBatch) is shared by the browser prompt builder
 * (GET /api/quote/batch), the HTTP batch path (POST /api/action/batch-roll) and the
 * MCP tools (dice_quote_batch / dice_batch_roll), so the client never decides alone.
 *
 * Bank safety rule: a batch of N flat rolls is accepted only when the bank can pay
 * N consecutive wins. Exposure per roll = profit on win + 0.1% dev fee + 0.05% pool fee
 * (exactly what lockBetCollateral locks). The whole N × exposure is reserved before the
 * first roll and released roll by roll, so a concurrent batch can never be quoted against
 * POA this batch may still owe. The per-roll 1% Kelly cap is checked against the worst
 * bankroll the batch can see (available − (N−1) × exposure), so no roll fails mid-batch.
 */

import crypto from 'node:crypto';
import { buildSignedTransfer, formatDiceMemo, fromMicros, genKeypair, isValidPoaAddress, toMicros, walletFromPrivkey } from './crypto-poa.mjs';

export const BATCH_COUNTS = Object.freeze([1, 5, 100, 1000]);
export const CLIENT_SEED_RE = /^[A-Za-z0-9._-]{1,48}$/;
const FULL_ROLL_LIST_LIMIT = 100;

function invalid(code, reason, extra = {}) {
  return { valid: false, code, reason, error: reason, ...extra };
}

/**
 * Validate a batch against the engine (and, when supplied, live chain balances).
 * chain: { required, ok, bankMicros?, playerSpendableMicros?, error? }
 */
export function quoteBatch(engine, {
  address = '',
  amountPoa,
  targetBps,
  direction,
  count,
  clientSeed = null,
  maxTotalSpendPoa = null,
  chain = null
} = {}) {
  const n = Number(count);
  if (!BATCH_COUNTS.includes(n)) {
    return invalid('bad_count', `count must be one of ${BATCH_COUNTS.join(', ')}`, { count: n });
  }
  if (clientSeed !== null && clientSeed !== undefined && !CLIENT_SEED_RE.test(String(clientSeed))) {
    return invalid('bad_seed', 'Client seed must be 1–48 characters: letters, digits, dot, dash or underscore', { count: n });
  }
  let wagerMicros;
  try {
    wagerMicros = toMicros(String(amountPoa ?? '').trim());
  } catch {
    return invalid('bad_wager', 'Wager must be a positive number with up to 6 decimals', { count: n });
  }
  const t = Number(targetBps);
  if (!Number.isInteger(t)) {
    return invalid('bad_target', 'Target must be a whole number of basis points (e.g. 4950 = 49.50)', { count: n });
  }
  const q = engine.quoteBet({ address, amountPoa: fromMicros(wagerMicros), targetBps: t, direction });
  if (q.multiplierMicros === undefined) {
    return invalid('bad_target', q.error || 'Invalid target or direction', { count: n });
  }
  const minBet = toMicros(q.minAllowedWagerPoa);
  if (wagerMicros < minBet) {
    return invalid('below_min', `Minimum wager is ${q.minAllowedWagerPoa} POA per roll`, { count: n });
  }

  const profit = BigInt(q.profitOnWinMicros);
  const lockPerRoll = profit + toMicros(q.devReserveFeePoa) + toMicros(q.incentivePoolFeePoa);
  const nBig = BigInt(n);
  const exposure = lockPerRoll * nBig;
  const totalWager = wagerMicros * nBig;
  const avail = engine.availableBankrollMicros;
  const kellyBps = engine.kellyMaxProfitBps;
  const worstAvail = avail - lockPerRoll * (nBig - 1n);
  const worstKellyCap = worstAvail > 0n ? (worstAvail * kellyBps) / 10000n : 0n;

  // Largest flat wager this count could carry (display hint only).
  const mult = Number(q.multiplierMicros) / 1e6;
  const p = Math.max(mult - 1, 1e-6);
  const l = p + 0.0015;
  const k = Number(kellyBps) / 10000;
  const A = Number(avail) / 1e6;
  const maxWagerHint = Math.max(0, Math.min(A / (n * l), (k * A) / (p + k * (n - 1) * l)));

  const base = {
    count: n,
    direction: q.direction,
    targetBps: q.targetBps,
    targetDisplay: q.targetDisplay,
    winChancePercent: q.winChancePercent,
    multiplierDisplay: q.multiplierDisplay,
    houseEdgePercent: q.houseEdgePercent,
    wagerPoa: fromMicros(wagerMicros),
    payoutOnWinPoa: q.payoutOnWinPoa,
    profitOnWinPoa: q.profitOnWinPoa,
    totalWagerPoa: fromMicros(totalWager),
    maxTotalSpendPoa: maxTotalSpendPoa ? String(maxTotalSpendPoa) : fromMicros(totalWager),
    exposurePerRollPoa: fromMicros(lockPerRoll),
    maxBankExposurePoa: fromMicros(exposure),
    maxPotentialPayoutPoa: fromMicros(BigInt(q.payoutOnWinMicros) * nBig),
    availableBankrollPoa: fromMicros(avail),
    worstCaseKellyCapPoa: fromMicros(worstKellyCap),
    maxWagerForCountPoa: maxWagerHint.toFixed(6),
    expectedValuePoa: `-${fromMicros((wagerMicros * BigInt(q.houseEdgeBps) * nBig) / 10000n)}`,
    chainRequired: Boolean(chain?.required)
  };

  if (avail <= 0n) return invalid('bank_empty', 'Bankroll has 0 available POA, so no rolls can be covered', base);
  if (exposure > avail) {
    return invalid(
      'bank_insufficient',
      `${n} roll${n === 1 ? '' : 's'} could owe up to ${fromMicros(exposure)} POA, but the bank only has ${fromMicros(avail)} POA available`,
      base
    );
  }
  if (profit > worstKellyCap) {
    return invalid(
      'kelly_cap',
      `Profit per roll ${q.profitOnWinPoa} POA exceeds the 1% Kelly cap (${fromMicros(worstKellyCap)} POA) left after reserving the rest of the batch. Max wager for ${n} rolls ≈ ${maxWagerHint.toFixed(2)} POA`,
      base
    );
  }
  if (maxTotalSpendPoa !== null && maxTotalSpendPoa !== undefined && maxTotalSpendPoa !== '') {
    let cap;
    try {
      cap = toMicros(String(maxTotalSpendPoa));
    } catch {
      return invalid('bad_cap', 'max_total_spend_poa must be a positive number with up to 6 decimals', base);
    }
    if (totalWager > cap) {
      return invalid('over_cap', `Total wager ${fromMicros(totalWager)} POA exceeds max_total_spend_poa ${fromMicros(cap)} POA`, base);
    }
  }
  if (chain?.required) {
    if (!chain.ok) return invalid('chain_down', 'minepoa.com chain is unavailable (CHAIN DOWN), so rolls are paused', base);
    if (chain.bankMicros !== undefined && chain.bankMicros !== null && exposure > BigInt(chain.bankMicros)) {
      return invalid(
        'chain_bank_insufficient',
        `On-chain bank balance ${fromMicros(chain.bankMicros)} POA cannot cover the ${fromMicros(exposure)} POA worst case`,
        base
      );
    }
    if (chain.playerSpendableMicros !== undefined && chain.playerSpendableMicros !== null && totalWager > BigInt(chain.playerSpendableMicros)) {
      return invalid(
        'player_insufficient',
        `Player spendable balance ${fromMicros(chain.playerSpendableMicros)} POA cannot cover ${fromMicros(totalWager)} POA of wagers`,
        base
      );
    }
  }
  return { valid: true, code: 'ok', reason: null, error: null, ...base };
}

/** Quote all four counts at once (what the browser renders as enabled/disabled buttons). */
export function quoteAllCounts(engine, params) {
  return BATCH_COUNTS.map((count) => quoteBatch(engine, { ...params, count }));
}

function compactRoll(i, r) {
  return {
    i,
    betTxid: r.betTxid,
    rollDisplay: r.rollDisplay,
    won: r.won,
    wagerPoa: r.wagerPoa,
    payoutPoa: r.payoutPoa,
    verify: {
      serverSeedHash: r.provablyFair?.serverSeedHash,
      clientSeed: r.provablyFair?.clientSeed,
      nonce: r.provablyFair?.nonce,
      betTxid: r.betTxid,
      targetBps: r.targetBps,
      direction: r.direction
    }
  };
}

/** Validate pre-signed BET transfers supplied by a self-custody agent. */
function checkSignedTxs(signedTxs, { count, wagerPoa, memo, bankAddress }) {
  if (!Array.isArray(signedTxs) || signedTxs.length !== count) {
    throw Object.assign(new Error(`signed_txs must contain exactly ${count} pre-signed BET transfers`), { status: 400 });
  }
  let from = null;
  for (const tx of signedTxs) {
    const body = tx?.body || tx;
    if (!body || body.to !== bankAddress) throw Object.assign(new Error('Every signed tx must pay the bank address'), { status: 400 });
    if (toMicros(body.amount) !== toMicros(wagerPoa)) throw Object.assign(new Error('Every signed tx amount must equal amount_poa'), { status: 400 });
    if (body.memo !== memo) throw Object.assign(new Error(`Every signed tx memo must be exactly ${memo}`), { status: 400 });
    if (from && body.from !== from) throw Object.assign(new Error('All signed txs must come from one address'), { status: 400 });
    from = body.from;
  }
  if (!isValidPoaAddress(from)) throw Object.assign(new Error('Invalid signer address in signed_txs'), { status: 400 });
  return from;
}

/**
 * Execute a validated batch. Throws (status 409/400) when the batch cannot be covered.
 * Wallet resolution: signed_txs (preferred, no key leaves the agent) > privkey > fresh throwaway key.
 */
export async function executeBatch({ engine, watcher, hooks = {}, args = {} }) {
  const count = Number(args.count);
  const amountPoa = String(args.amount_poa ?? args.amountPoa ?? '');
  const targetBps = Number(args.target_bps ?? args.targetBps);
  const direction = args.direction;
  const clientSeed = String(args.client_seed ?? args.clientSeed ?? 'agent-batch');
  const maxTotalSpendPoa = args.max_total_spend_poa ?? args.maxTotalSpendPoa;
  const stopOnLoss = args.stop_on_loss_poa ?? args.stopOnLossPoa ?? null;
  const stopOnProfit = args.stop_on_profit_poa ?? args.stopOnProfitPoa ?? null;
  const includeAll = Boolean(args.include_all_rolls ?? args.includeAllRolls);

  if (maxTotalSpendPoa === undefined || maxTotalSpendPoa === null || maxTotalSpendPoa === '') {
    throw Object.assign(new Error('max_total_spend_poa is required for a batch'), { status: 400 });
  }
  if (!CLIENT_SEED_RE.test(clientSeed)) {
    throw Object.assign(new Error('Client seed must be 1–48 characters: letters, digits, dot, dash or underscore'), { status: 400 });
  }
  const memo = formatDiceMemo({ action: 'BET', direction, targetBps, clientSeed });

  let wallet = null;
  let address;
  if (Array.isArray(args.signed_txs)) {
    address = checkSignedTxs(args.signed_txs, { count, wagerPoa: amountPoa, memo, bankAddress: engine.bankAddress });
  } else {
    wallet = args.privkey ? walletFromPrivkey(args.privkey) : genKeypair();
    address = wallet.address;
  }

  const chain = hooks.chainContext ? await hooks.chainContext(address) : null;
  const quote = quoteBatch(engine, { address, amountPoa, targetBps, direction, count, clientSeed, maxTotalSpendPoa, chain });
  if (!quote.valid) {
    throw Object.assign(new Error(quote.reason), { status: 409, quote });
  }

  const batchId = `batch_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const wagerMicros = toMicros(quote.wagerPoa);
  const lockPerRoll = toMicros(quote.exposurePerRollPoa);
  const totalWager = toMicros(quote.totalWagerPoa);
  // Synchronous from here on: reservation + every roll happen in one tick, so no other
  // request can interleave. Player spend is reserved too for the async chain check.
  if (hooks.reserveSpend) hooks.reserveSpend(address, totalWager);
  engine.reserveExposure(batchId, lockPerRoll * BigInt(count));
  engine._emit('batch.started', { batchId, address, count, wagerPoa: quote.wagerPoa, targetBps: quote.targetBps, direction: quote.direction, maxBankExposurePoa: quote.maxBankExposurePoa });

  const receipts = [];
  let wins = 0;
  let losses = 0;
  let net = 0n;
  let wagered = 0n;
  let stoppedReason = 'completed_all_rolls';
  const capMicros = toMicros(String(maxTotalSpendPoa));
  const stopLossMicros = stopOnLoss ? toMicros(String(stopOnLoss)) : null;
  const stopProfitMicros = stopOnProfit ? toMicros(String(stopOnProfit)) : null;
  const progressEvery = Math.max(1, Math.floor(count / 20));
  const baseNonce = Math.floor(Date.now() / 1000) * 1000 + Math.floor(Math.random() * 500);
  engine._deferSave = true;
  try {
    for (let i = 0; i < count; i++) {
      if (wagered + wagerMicros > capMicros) {
        stoppedReason = 'max_total_spend_reached';
        break;
      }
      engine.releaseExposure(batchId, lockPerRoll);
      const tx = wallet
        ? buildSignedTransfer({ wallet, to: engine.bankAddress, amount: quote.wagerPoa, memo, nonce: baseNonce + i })
        : args.signed_txs[i];
      const receipt = watcher.processSignedTransaction(tx);
      if (receipt?.action !== 'BET_SETTLED') {
        stoppedReason = receipt?.reason || receipt?.action || 'bet_not_settled';
        break;
      }
      receipts.push(receipt);
      wagered += wagerMicros;
      if (receipt.won) {
        wins += 1;
        net += toMicros(receipt.payoutPoa) - wagerMicros;
      } else {
        losses += 1;
        net -= wagerMicros;
      }
      if (hooks.noteDebit) hooks.noteDebit(address, receipt.betTxid, receipt.wagerPoa);
      if ((i + 1) % progressEvery === 0 && i + 1 < count) {
        engine._emit('batch.progress', { batchId, address, count, done: i + 1, wins, losses, netPoa: fromMicros(net) });
      }
      if (stopLossMicros !== null && net <= -stopLossMicros) {
        stoppedReason = 'stop_loss_reached';
        break;
      }
      if (stopProfitMicros !== null && net >= stopProfitMicros) {
        stoppedReason = 'take_profit_reached';
        break;
      }
    }
  } finally {
    engine.releaseExposure(batchId, null);
    engine._deferSave = false;
    engine._saveToDisk();
    if (hooks.releaseSpend) hooks.releaseSpend(address, totalWager);
  }

  const summary = {
    batchId,
    address,
    count,
    done: receipts.length,
    wins,
    losses,
    totalWageredPoa: fromMicros(wagered),
    netPoa: fromMicros(net),
    stoppedReason,
    bankNavPoa: fromMicros(engine.bankNavMicros),
    availableBankrollPoa: fromMicros(engine.availableBankrollMicros)
  };
  engine._emit('batch.completed', summary);

  const all = receipts.map((r, i) => compactRoll(i + 1, r));
  const rolls = includeAll || all.length <= FULL_ROLL_LIST_LIMIT ? all : [...all.slice(0, 25), ...all.slice(-25)];
  return {
    ok: true,
    action: 'BATCH_COMPLETED',
    ...summary,
    signer: wallet ? (args.privkey ? 'privkey' : 'throwaway_key') : 'signed_txs',
    quote,
    serverSeedHash: engine.seedManager.currentSeedHash,
    rollsOmitted: all.length - rolls.length,
    rolls,
    verifyHow:
      'Roll = first 8-byte big-endian window w (offsets 0,8,16,24) of HMAC_SHA256(key=server_seed, msg="client_seed:nonce:bet_txid") with w < 18446744073709550000 (falls back to offset 0), then w % 10000 / 100. Call dice_verify_roll after the server seed is revealed.'
  };
}
