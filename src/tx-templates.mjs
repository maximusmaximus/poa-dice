// @ts-nocheck
/**
 * tx-templates.mjs — Exact UNSIGNED transfer templates for every signed POA Dice action.
 *
 * A self-custody agent signs locally and passes signed_tx / signed_txs. To build them
 * without guessing it needs: chain id, recipient (bank) address, amount, the exact DICE1
 * memo and how many transfers. These templates are what the server itself checks
 * (batch-roll.mjs checkSignedTxs, the memo parser in the settlement) so a transfer built
 * from one is accepted byte-for-byte. Read-only: nothing here signs or sends anything.
 */

import { formatDiceMemo, fromMicros, MAINNET_CHAIN_ID, toMicros } from './crypto-poa.mjs';
import { BATCH_COUNTS, CLIENT_SEED_RE } from './batch-roll.mjs';
import { WITHDRAW_TRIGGER_POA } from './actions.mjs';

export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 120;

/** Default client seeds used by the action tools when client_seed is omitted. */
export const DEFAULT_SEEDS = Object.freeze({ dice_place_bet: 'mcp-agent', dice_batch_roll: 'agent-batch' });

export const TRANSFER_FORMAT =
  'A normal minepoa transfer from your own wallet: {type:"transfer", from:<your poa1 address>, to, amount (string, 6 decimals), memo (exact, byte for byte), nonce (your next account nonce; consecutive when signing several), parents (current minepoa tips), ts, cid (chain id), sig (Ed25519)}. Pass the signed envelope {id, body} exactly as your PoA wallet/CLI builds it. There is no fee field and no other transfer.';

export const TEMPLATE_TOOLS = Object.freeze(['dice_place_bet', 'dice_batch_roll', 'bank_stake', 'bank_withdraw', 'bank_claim_yield', 'dice_auto_strategy', 'chat_send']);

function fail(reason, extra = {}) {
  return { ok: false, reason, error: reason, ...extra };
}

function amount6(v) {
  return fromMicros(toMicros(String(v ?? '').trim()));
}

/** Clamp a requested wait to [0, MAX_WAIT_SECONDS]; undefined -> default. */
export function clampWaitSeconds(v, def = DEFAULT_WAIT_SECONDS) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_WAIT_SECONDS, Math.floor(n));
}

/**
 * Build the exact unsigned transfer template(s) for one action tool call.
 * args use the MCP argument names (count, amount_poa, target_bps, direction, client_seed,
 * lock_epochs, referrer, mode, bps, shares, address, text).
 * opts.claimShares: share units for bank_claim_yield when the server could compute them.
 */
export function transferTemplates({ tool, args = {}, bankAddress, chainId = MAINNET_CHAIN_ID, claimShares = null } = {}) {
  if (!TEMPLATE_TOOLS.includes(tool)) return fail(`tool must be one of ${TEMPLATE_TOOLS.join(', ')}`);
  const from = args.address || '<your poa1 address>';
  const base = { ok: true, tool, chainId, from, transferFormat: TRANSFER_FORMAT };
  if (tool === 'chat_send') {
    const text = String(args.text ?? '').trim();
    return {
      ...base,
      kind: 'signature',
      signedField: 'signature',
      transfers: [],
      totalPoa: '0.000000',
      message: text,
      instructions: 'No transfer and no POA. Sign the exact UTF-8 chat text with your Ed25519 key and pass address + signature (Base58). Never pass privkey.'
    };
  }
  if (!bankAddress) return fail('The bank address is not available right now (bank offline), so no transfer can be built');
  let count = 1;
  let amount;
  let memo;
  let signedField = 'signed_tx';
  let note = null;
  try {
    if (tool === 'dice_place_bet' || tool === 'dice_batch_roll' || tool === 'dice_auto_strategy') {
      const seed = String(args.client_seed ?? DEFAULT_SEEDS[tool] ?? 'mcp-auto-strategy');
      if (!CLIENT_SEED_RE.test(seed)) return fail('client_seed must be 1–48 characters: letters, digits, dot, dash or underscore');
      const t = Number(args.target_bps);
      if (!Number.isInteger(t)) return fail('target_bps must be a whole number of basis points');
      if (args.direction !== 'under' && args.direction !== 'over') return fail('direction must be "under" or "over"');
      amount = amount6(tool === 'dice_auto_strategy' ? args.base_wager_poa ?? args.amount_poa : args.amount_poa);
      memo = formatDiceMemo({ action: 'BET', direction: args.direction, targetBps: t, clientSeed: seed });
      if (tool === 'dice_batch_roll') {
        count = Number(args.count);
        if (!BATCH_COUNTS.includes(count)) return fail(`count must be one of ${BATCH_COUNTS.join(', ')}`);
        signedField = 'signed_txs';
        note = `Exactly ${count} separate transfer${count === 1 ? '' : 's'}, all identical except the nonce (consecutive), all from one address.`;
      }
      if (tool === 'dice_auto_strategy') {
        signedField = 'privkey';
        note = 'dice_auto_strategy sizes every roll on the server, so it can only sign with privkey. Only use it if the user explicitly accepts sending the key; otherwise use dice_batch_roll with signed_txs.';
      }
    } else if (tool === 'bank_stake') {
      amount = amount6(args.amount_poa);
      memo = formatDiceMemo({ action: 'LP_ADD', lockEpochs: Number(args.lock_epochs || 0), referrer: args.referrer || null });
    } else if (tool === 'bank_withdraw') {
      amount = WITHDRAW_TRIGGER_POA;
      const mode = String(args.mode || 'ALL').toUpperCase();
      if (mode === 'SHARES') {
        if (!/^\d+$/.test(String(args.shares || ''))) return fail('shares must be a whole number of share units for mode=SHARES');
        memo = formatDiceMemo({ action: 'LP_WITHDRAW', shares: String(args.shares) });
      } else if (mode === 'BPS') {
        const b = Number(args.bps);
        if (!Number.isInteger(b) || b < 1 || b > 10000) return fail('bps must be 1–10000 for mode=BPS');
        memo = formatDiceMemo({ action: 'LP_WITHDRAW', bps: b });
      } else {
        memo = formatDiceMemo({ action: 'LP_WITHDRAW', bps: 10000 });
      }
      note = 'A 0.000001 POA trigger; the payout goes back to the signing address.';
    } else if (tool === 'bank_claim_yield') {
      amount = WITHDRAW_TRIGGER_POA;
      if (!claimShares) {
        return {
          ...base,
          ok: false,
          to: bankAddress,
          amount,
          memo: null,
          reason: 'The claim memo carries the exact share units of your yield. Call bank_claim_yield with {"dry_run": true, "address": <your address>} and use its transferTemplate.',
          error: null
        };
      }
      memo = formatDiceMemo({ action: 'LP_WITHDRAW', shares: String(claimShares) });
      note = 'Redeems only the shares worth your yield; principal stays staked. The shares change as the bank moves, so build it right after the dry run.';
    }
  } catch (err) {
    return fail(String(err.message || err));
  }
  const total = fromMicros(toMicros(amount) * BigInt(count));
  return {
    ...base,
    kind: 'transfer',
    signedField,
    to: bankAddress,
    amount,
    memo,
    count,
    totalPoa: total,
    transfers: [{ to: bankAddress, amount, memo, count }],
    note
  };
}

/** Human-readable lines (used by prompts and docs). */
export function templateLines(tpl) {
  if (!tpl || tpl.kind !== 'transfer') return [];
  return [
    `   - chain id (cid): ${tpl.chainId}`,
    `   - to (bank address): ${tpl.to}`,
    `   - amount: ${tpl.amount} POA${tpl.count > 1 ? ` each (${tpl.totalPoa} POA in total)` : ''}`,
    `   - memo (exact): ${tpl.memo}`,
    `   - count: ${tpl.count} transfer${tpl.count === 1 ? '' : 's'}${tpl.count > 1 ? ' (consecutive nonces)' : ''}`
  ];
}
