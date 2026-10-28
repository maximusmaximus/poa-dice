// @ts-nocheck
/**
 * POA Dice — browser controller (public/app.js)
 *
 * The browser never signs and never holds a private key. Every action button builds a
 * ready-to-paste prompt for the user's own AI agent, which calls this site's MCP server
 * (/mcp) with exact arguments and a spend cap. Availability comes from the server
 * (/api/quote/batch, /api/quote/actions); buttons are disabled only when an action is
 * genuinely unavailable, with the reason shown inline. Results arrive live over SSE
 * (/api/stream) with reconnect + polling fallback.
 */

import { createChatFeed } from './chat/chat-feed.js';
import { buildChatJoinPrompt } from './chat/chat-join-prompt.js';
import { initDismissibleNotice } from './notice-dismiss.js';

const BATCH_COUNTS = [1, 5, 100, 1000];
const SEED_RE = /^[A-Za-z0-9._-]{1,48}$/;
const AMOUNT_RE = /^\d+(?:\.\d{1,6})?$/;
const ADDR_RE = /^poa1[1-9A-HJ-NP-Za-km-z]{30,60}$/;
const POLL_MS = 4000;
export const LEDGER_PAUSED_TEXT = "Betting is paused: the PoA ledger isn't accepting transactions right now. It resumes automatically.";
const POLL_MS_DISCONNECTED = 2000;

const state = {
  direction: 'under',
  targetBps: 4950,
  rollCount: 1,
  withdrawBps: 10000,
  playerAddress: '',
  summary: null,
  ledgerPaused: false,
  lastBetQuote: null,
  batchQuotes: null,
  actionQuotes: null,
  recentBets: [],
  stakers: [],
  sseConnected: false,
  batch: null,
};

const $ = (id) => document.getElementById(id) || document.createElement('div');

function api(path) {
  if (typeof window === 'undefined') return path;
  const host = window.location.hostname.toLowerCase();
  const previewHosts = new Set(['preview.grok.genai.mil', 'preview.grok.mil', 'preview.grokgsac.com']);
  if (!previewHosts.has(host)) return path;
  const match = window.location.pathname.match(/^\/hds-[a-z0-9]+-\d+-[a-z0-9]+/i);
  return match ? match[0] + path : path;
}

function mcpUrl() {
  return `${window.location.origin}${api('/mcp')}`;
}

function shortAddr(addr) {
  if (!addr || addr.length < 18) return addr || 'poa1...';
  return `${addr.slice(0, 9)}...${addr.slice(-5)}`;
}

function formatNum(poaStr, decimals = 4) {
  const num = Number(poaStr || 0);
  if (!Number.isFinite(num)) return '0.0000';
  return num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function wagerValue() {
  return String($('wagerInput').value || '').trim();
}
function randomClientSeed() {
  const bytes = new Uint8Array(6);
  window.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join('');
  return `poa-seed-${hex}-${Date.now().toString(36)}`;
}
function seedValue() {
  return String($('clientSeedInput').value || '').trim();
}

// ─── Prompt builder (shared by every action button) ─────────────────────────

export const ADDRESS_STORAGE_KEY = 'poaDice.playerAddress';
export const PROMPT_WAIT_SECONDS = 60;
const WITHDRAW_TRIGGER = '0.000001';
const VIP_LINE = 'Quotes without an address use the standard house edge; the final edge may be lower (payout slightly higher) if that address is a VIP staker.';

function loadSavedAddress() {
  try {
    const a = String(window.localStorage.getItem(ADDRESS_STORAGE_KEY) || '').trim();
    return ADDR_RE.test(a) ? a : '';
  } catch {
    return '';
  }
}

function saveAddress(a) {
  try {
    if (a) window.localStorage.setItem(ADDRESS_STORAGE_KEY, a);
    else window.localStorage.removeItem(ADDRESS_STORAGE_KEY);
  } catch {
    // storage blocked (private mode): the field still works for this visit
  }
}

/** Mirror of the server's formatDiceMemo (src/crypto-poa.mjs); tests assert they agree. */
export function diceMemo(spec) {
  const act = String(spec.action || '').toUpperCase();
  if (act === 'BET') return `DICE1:BET:${spec.direction === 'over' ? 'over' : 'under'}:${Number(spec.targetBps)}:${String(spec.clientSeed || 'default').replace(/[:\r\n]/g, '_').slice(0, 64)}`;
  if (act === 'LP_ADD') {
    const extras = [];
    if (spec.lockEpochs && Number(spec.lockEpochs) > 0) extras.push(`epochs=${Number(spec.lockEpochs)}`);
    if (spec.referrer && ADDR_RE.test(spec.referrer)) extras.push(`ref=${spec.referrer}`);
    return ['DICE1:LP_ADD', ...extras].join(':');
  }
  if (act === 'LP_WITHDRAW') {
    if (spec.shares) return `DICE1:LP_WITHDRAW:${spec.shares}`;
    if (spec.bps && Number(spec.bps) < 10000) return `DICE1:LP_WITHDRAW:BPS=${Number(spec.bps)}`;
    return 'DICE1:LP_WITHDRAW:ALL';
  }
  return '';
}

/** Fallback when the server quote did not carry a transferTemplate (same shape). */
function localTemplate({ amount, memo, count = 1 }) {
  const to = state.summary?.bankAddress;
  if (!to || !memo || !AMOUNT_RE.test(String(amount))) return null;
  const amt = Number(amount).toFixed(6);
  return { ok: true, kind: 'transfer', chainId: state.summary?.chainId || 'poa-mainnet-1', to, amount: amt, memo, count, totalPoa: (Number(amt) * count).toFixed(6) };
}

function transferLines(tpl) {
  return [
    `   - chain id (cid): ${tpl.chainId}`,
    `   - to (bank address): ${tpl.to}`,
    `   - amount: ${tpl.amount} POA${tpl.count > 1 ? ` each (${tpl.totalPoa} POA in total)` : ''}`,
    `   - memo (exact, byte for byte): ${tpl.memo}`,
    `   - count: ${tpl.count} transfer${tpl.count === 1 ? '' : 's'}${tpl.count > 1 ? ', one per roll, consecutive nonces, all from my address' : ''}`,
  ];
}

/**
 * signing: 'signed_tx' | 'signed_txs' (self-custody transfers from `transfer`),
 *          'privkey_only' (auto-bet), 'from_quote' (claim: memo comes from the dry run).
 */
export function buildAgentPrompt({ title, tool, args, quoteTool, quoteArgs, spendCapPoa, stop, report, transfer = null, signing = 'signed_tx', address = '' }) {
  const lines = [
    `Please run this POA Dice action for me through the POA Dice MCP server.`,
    ``,
    `MCP server: ${mcpUrl()} (Streamable HTTP, JSON-RPC 2.0). If you cannot add MCP servers, POST JSON-RPC "tools/call" requests to that URL.`,
    `Action: ${title}`,
    address
      ? `My PoA address: ${address}. Sign everything from this address; if your wallet has a different address, stop and tell me.`
      : `My PoA address: not given, so sign from your own PoA wallet. ${VIP_LINE}`,
    ``,
  ];
  let step = 1;
  if (quoteTool) {
    lines.push(`${step++}. First call the read-only tool \`${quoteTool}\` with:`, JSON.stringify(quoteArgs, null, 2), `   If it is not valid, stop and tell me the reason.`);
  }
  if ((signing === 'signed_tx' || signing === 'signed_txs') && transfer) {
    lines.push(
      `${step++}. Build and sign LOCALLY ${transfer.count === 1 ? 'exactly 1 minepoa transfer' : `exactly ${transfer.count} separate minepoa transfers`} from my wallet. Each one must contain exactly:`,
      ...transferLines(transfer),
      `   No fee field, no other transfers. The quote's "transferTemplate" (or the read-only tool \`tx_templates\`) returns these same values; if anything differs, stop and tell me.`,
      `${step++}. Then call \`${tool}\` with exactly these arguments, plus "${signing}": ${signing === 'signed_txs' ? `[the ${transfer.count} signed transfer${transfer.count === 1 ? '' : 's'}]` : '<the signed transfer>'}:`,
      JSON.stringify(args, null, 2)
    );
  } else if (signing === 'from_quote') {
    const to = transfer?.to || state.summary?.bankAddress || '<bank address from the quote>';
    lines.push(
      `${step++}. Build and sign LOCALLY exactly 1 minepoa transfer from my wallet: chain id ${transfer?.chainId || state.summary?.chainId || 'poa-mainnet-1'}, to ${to}, amount ${WITHDRAW_TRIGGER} POA, memo exactly as in the dry run's "transferTemplate" (it carries the exact share units). No fee field, no other transfers.`,
      `${step++}. Then call \`${tool}\` with exactly these arguments, plus "signed_tx": <the signed transfer>:`,
      JSON.stringify(args, null, 2)
    );
  } else if (signing === 'privkey_only') {
    lines.push(
      `${step++}. \`${tool}\` sizes and signs every roll on the server, so it only works with "privkey". Do this ONLY if I explicitly confirm that I accept sending my key to this server; otherwise stop and tell me (a roll batch with signed_txs needs no key). Then call it with exactly these arguments:`,
      JSON.stringify(args, null, 2)
    );
  } else {
    lines.push(`${step++}. Then call \`${tool}\` with exactly these arguments:`, JSON.stringify(args, null, 2));
  }
  lines.push(
    `Safety: never add "privkey" unless I confirm I accept sending it to this server, and never print a private key in chat.`,
    `Spend cap: never send more than ${spendCapPoa} POA in total for this action. Do not change any amount, count, target or cap.`,
    `Stop condition: ${stop}`,
    `${step++}. Report back: ${report}`,
    ``,
    `(Generated by the POA Dice page at ${window.location.origin}${window.location.pathname}. Governance-token utility only; no monetary value is exchanged.)`
  );
  return lines.join('\n');
}

function rollArgs() {
  const count = state.rollCount;
  const wager = wagerValue();
  const total = AMOUNT_RE.test(wager) ? (Number(wager) * count).toFixed(6) : '0';
  return {
    count,
    amount_poa: AMOUNT_RE.test(wager) ? Number(wager).toFixed(6) : wager,
    target_bps: state.targetBps,
    direction: state.direction,
    client_seed: seedValue(),
    max_total_spend_poa: total,
    wait_seconds: PROMPT_WAIT_SECONDS,
  };
}

function rollPrompt() {
  const args = rollArgs();
  const { max_total_spend_poa: cap } = args;
  const quoteArgs = { count: args.count, amount_poa: args.amount_poa, target_bps: args.target_bps, direction: args.direction, client_seed: args.client_seed, max_total_spend_poa: cap };
  if (state.playerAddress) quoteArgs.address = state.playerAddress;
  const cmp = state.direction === 'under' ? 'under' : 'over';
  const sel = state.batchQuotes?.find((x) => x.count === args.count);
  const transfer =
    (sel?.transferTemplate?.memo === diceMemo({ action: 'BET', direction: args.direction, targetBps: args.target_bps, clientSeed: args.client_seed }) && sel.transferTemplate) ||
    localTemplate({ amount: args.amount_poa, memo: diceMemo({ action: 'BET', direction: args.direction, targetBps: args.target_bps, clientSeed: args.client_seed }), count: args.count });
  return buildAgentPrompt({
    title: `${args.count} dice roll${args.count === 1 ? '' : 's'} · roll ${cmp} ${(state.targetBps / 100).toFixed(2)} · ${args.amount_poa} POA each`,
    tool: 'dice_batch_roll',
    args,
    quoteTool: 'dice_quote_batch',
    quoteArgs,
    spendCapPoa: cap,
    transfer,
    signing: 'signed_txs',
    address: state.playerAddress,
    stop: `stop after ${args.count} roll${args.count === 1 ? '' : 's'}, or immediately if the server rejects the batch or reports the bank cannot cover it. Do not retry with different numbers and never resend a transfer.`,
    report: `dice_batch_roll waits up to ${PROMPT_WAIT_SECONDS} s and returns wins, losses, net POA, each bet_txid with its roll, payout txids and the server seed hash. If its status is PENDING_CONFIRMATION (or waitStatus is not COMPLETE), poll \`tx_status\` for each bet_txid and payout txid every ~15 s until they are CONFIRMED, without resending anything. Then tell me: wins, losses, net POA, each bet_txid with its roll, each payout txid, and the server seed hash.`,
  });
}

function actionTemplate(kind) {
  const t = state.actionQuotes?.[kind]?.transferTemplate;
  return t && t.ok ? t : null;
}

function actionPrompt(kind) {
  const addr = state.playerAddress;
  if (kind === 'stake') {
    const amount = Number($('depositAmountInput').value || 0).toFixed(6);
    const lock = Number($('lockEpochsInput').value || 0);
    const ref = String($('referrerInput').value || '').trim();
    const args = { amount_poa: amount, lock_epochs: lock, max_total_spend_poa: amount };
    if (ref) args.referrer = ref;
    const memo = diceMemo({ action: 'LP_ADD', lockEpochs: lock, referrer: ref });
    const st = actionTemplate('stake');
    return buildAgentPrompt({
      title: `Stake ${amount} POA into the bankroll vault${lock ? ` (locked ${lock} epoch${lock === 1 ? '' : 's'})` : ''}${ref ? ' with a referrer' : ''}`,
      tool: 'bank_stake',
      args,
      quoteTool: 'bank_quote_deposit',
      quoteArgs: { amount_poa: amount, lock_epochs: lock, ...(ref ? { referrer: ref } : {}), ...(addr ? { address: addr } : {}) },
      spendCapPoa: amount,
      transfer: (st && st.memo === memo && st.amount === amount && st) || localTemplate({ amount, memo }),
      signing: 'signed_tx',
      address: addr,
      stop: 'one deposit only. Stop if the quote or deposit is rejected; never resend the transfer.',
      report: 'the deposit txid. Poll `tx_status` with it every ~15 s until it is CONFIRMED (booked), then tell me the shares minted, % of the bank owned, lock-until epoch and the deposit txid.',
    });
  }
  if (kind === 'withdraw') {
    const bps = state.withdrawBps;
    const args = bps === 10000 ? { mode: 'ALL' } : { mode: 'BPS', bps };
    const memo = diceMemo({ action: 'LP_WITHDRAW', bps });
    const wt = actionTemplate('withdraw');
    return buildAgentPrompt({
      title: `Withdraw ${(bps / 100).toFixed(0)}% of my bankroll shares`,
      tool: 'bank_withdraw',
      args,
      quoteTool: 'bank_quote_withdraw',
      quoteArgs: { address: addr || '<my poa1 address>', ...args },
      spendCapPoa: WITHDRAW_TRIGGER,
      transfer: (wt && wt.memo === memo && wt) || localTemplate({ amount: WITHDRAW_TRIGGER, memo }),
      signing: 'signed_tx',
      address: addr,
      stop: 'one withdrawal only. Stop if I hold no shares, the position is locked, or the quote is rejected; never resend the trigger.',
      report: 'the trigger txid. Poll `tx_status` with it every ~15 s until the payout is CONFIRMED, then tell me the shares redeemed, exit fee, net POA returned and the payout txid.',
    });
  }
  if (kind === 'claim') {
    const ct = actionTemplate('claim');
    return buildAgentPrompt({
      title: 'Claim my bankroll yield (keep principal staked)',
      tool: 'bank_claim_yield',
      args: {},
      quoteTool: 'bank_claim_yield',
      quoteArgs: { dry_run: true, address: addr || '<my poa1 address>' },
      spendCapPoa: WITHDRAW_TRIGGER,
      transfer: ct,
      signing: 'from_quote',
      address: addr,
      stop: 'one claim only. Stop if there is no position or no yield; never resend the trigger.',
      report: 'the trigger txid. Poll `tx_status` with it every ~15 s until the payout is CONFIRMED, then tell me the yield claimed in POA, shares redeemed and the payout txid.',
    });
  }
  if (kind === 'autoBet') {
    const wager = AMOUNT_RE.test(wagerValue()) ? Number(wagerValue()).toFixed(6) : wagerValue();
    const strategy = $('autoStrategySelect').value || 'flat';
    const rolls = Number($('autoRollsInput').value || 5);
    const cap = state.actionQuotes?.autoBet?.maxTotalSpendPoa || (Number(wager) * rolls).toFixed(6);
    return buildAgentPrompt({
      title: `Auto-bet: ${rolls} rolls, ${strategy} strategy from ${wager} POA, roll ${state.direction} ${(state.targetBps / 100).toFixed(2)}`,
      tool: 'dice_auto_strategy',
      args: { strategy, base_wager_poa: wager, target_bps: state.targetBps, direction: state.direction, rolls, client_seed: seedValue(), max_total_spend_poa: cap },
      quoteTool: 'dice_quote_bet',
      quoteArgs: { amount_poa: wager, target_bps: state.targetBps, direction: state.direction, ...(addr ? { address: addr } : {}) },
      spendCapPoa: cap,
      signing: 'privkey_only',
      address: addr,
      stop: `after ${rolls} rolls, when the spend cap is reached, or if any roll is rejected.`,
      report: 'rolls executed, wins/losses, net POA, stopped reason and each bet_txid.',
    });
  }
  return '';
}

// ─── Availability (server is the source of truth) ───────────────────────────

function localRollProblem() {
  const w = wagerValue();
  if (!AMOUNT_RE.test(w) || Number(w) <= 0) return 'Wager must be a positive number with up to 6 decimals';
  if (!SEED_RE.test(seedValue())) return 'Client seed must be 1–48 characters: letters, digits, dot, dash or underscore';
  const min = state.direction === 'under' ? 100 : 199;
  const max = state.direction === 'under' ? 9800 : 9899;
  if (!Number.isInteger(state.targetBps) || state.targetBps < min || state.targetBps > max) return 'Target is out of range';
  const a = String($('playerAddressInput').value || '').trim();
  if (a && !ADDR_RE.test(a)) return 'Your PoA address must be a valid poa1… address (or leave it empty)';
  return null;
}

function setReason(id, text) {
  const el = $(id);
  if (text) {
    el.textContent = text;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

function renderRollAvailability() {
  const local = localRollProblem();
  const quotes = state.batchQuotes;
  document.querySelectorAll('[data-roll-count]').forEach((btn) => {
    const n = Number(btn.getAttribute('data-roll-count'));
    const q = quotes?.find((x) => x.count === n);
    const ok = !state.ledgerPaused && !local && q && q.valid;
    btn.disabled = !ok;
    btn.title = ok ? `${n} roll(s): bank can cover every win` : local || q?.reason || 'Checking bank…';
    btn.classList.toggle('active', n === state.rollCount);
    btn.setAttribute('aria-checked', n === state.rollCount ? 'true' : 'false');
  });
  const sel = quotes?.find((x) => x.count === state.rollCount);
  $('batchTotalWager').textContent = sel ? `${formatNum(sel.totalWagerPoa, 2)} POA` : '—';
  $('batchExposure').textContent = sel ? `${formatNum(sel.maxBankExposurePoa, 2)} POA` : '—';
  $('batchBankAvail').textContent = sel ? `${formatNum(sel.availableBankrollPoa, 2)} POA` : '—';
  let reason = state.ledgerPaused ? LEDGER_PAUSED_TEXT : local;
  if (!reason && !quotes) reason = 'Waiting for the bank quote…';
  if (!reason && sel && !sel.valid) reason = sel.reason;
  if (!reason && quotes && !quotes.some((q) => q.valid)) reason = quotes[0]?.reason;
  const btn = $('btnCopyPrompt');
  btn.disabled = Boolean(reason);
  setReason('promptBlockReason', reason);
  $('promptPreview').textContent = rollPrompt();
  if (sel?.maxWagerForCountPoa) $('maxWagerHint').textContent = `Max for ${state.rollCount}: ${formatNum(sel.maxWagerForCountPoa, 2)} POA`;
}

async function fetchBatchQuotes() {
  const local = localRollProblem();
  if (local && local.startsWith('Wager')) {
    state.batchQuotes = null;
    renderRollAvailability();
    return;
  }
  try {
    const qs = new URLSearchParams({
      amountPoa: wagerValue(),
      targetBps: String(state.targetBps),
      direction: state.direction,
      clientSeed: seedValue(),
      address: state.playerAddress,
    });
    const res = await fetch(api(`/api/quote/batch?${qs}`));
    const data = await res.json();
    state.batchQuotes = Array.isArray(data.counts) ? data.counts : null;
  } catch {
    state.batchQuotes = BATCH_COUNTS.map((count) => ({ count, valid: false, reason: 'Server unreachable, so the bank cannot be checked' }));
  }
  renderRollAvailability();
}

const ACTIONS = [
  { kind: 'stake', btn: 'btnSubmitDeposit', reason: 'stakeReason', label: 'Copy stake prompt' },
  { kind: 'withdraw', btn: 'btnSubmitWithdraw', reason: 'withdrawReason', label: 'Copy withdraw prompt' },
  { kind: 'claim', btn: 'btnCopyClaim', reason: 'claimReason', label: 'Copy claim-yield prompt' },
  { kind: 'autoBet', btn: 'btnCopyAutoPrompt', reason: 'autoBetReason', label: 'Copy auto-bet prompt' },
];

function renderActionAvailability() {
  const q = state.actionQuotes;
  for (const a of ACTIONS) {
    const aq = q?.[a.kind];
    let reason = null;
    if (state.ledgerPaused) reason = LEDGER_PAUSED_TEXT;
    else if (!q) reason = 'Checking availability…';
    else if (q.addressError) reason = q.addressError;
    else if (!aq?.valid) reason = aq?.reason || 'Unavailable';
    if (a.kind === 'autoBet' && !reason) {
      const local = localRollProblem();
      if (local) reason = local;
    }
    $(a.btn).disabled = Boolean(reason);
    $(a.btn).dataset.prompt = reason ? '' : actionPrompt(a.kind);
    let note = reason;
    if (!reason && aq?.needsPositionCheck) note = 'Add your agent address above to check your position here; otherwise your agent checks it first.';
    setReason(a.reason, note);
    $(a.reason).classList.toggle('is-note', !reason && Boolean(note));
  }
}

async function fetchActionQuotes() {
  try {
    const qs = new URLSearchParams({
      address: String($('playerAddressInput').value || '').trim(),
      depositPoa: String($('depositAmountInput').value || ''),
      lockEpochs: String($('lockEpochsInput').value || 0),
      referrer: String($('referrerInput').value || '').trim(),
      withdrawBps: String(state.withdrawBps),
      amountPoa: wagerValue(),
      targetBps: String(state.targetBps),
      direction: state.direction,
      strategy: $('autoStrategySelect').value || 'flat',
      autoRolls: String($('autoRollsInput').value || 5),
      clientSeed: seedValue(),
    });
    const res = await fetch(api(`/api/quote/actions?${qs}`));
    state.actionQuotes = await res.json();
  } catch {
    const down = { valid: false, reason: 'Server unreachable' };
    state.actionQuotes = { stake: down, withdraw: down, claim: down, autoBet: down };
  }
  renderActionAvailability();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function flashCopied(btn, labelEl, label) {
  const target = labelEl || btn;
  target.textContent = 'Copied ✓';
  btn.dataset.state = 'copied';
  setTimeout(() => {
    target.textContent = label;
    delete btn.dataset.state;
  }, 2000);
}

// ─── Slider, quotes, state ──────────────────────────────────────────────────

function updateSliderVisuals() {
  const pct = (state.targetBps / 100).toFixed(2);
  const track = $('sliderTrackVisual');
  const win = 'rgba(16, 185, 129, 0.88)';
  const lose = 'rgba(244, 63, 94, 0.78)';
  track.style.background =
    state.direction === 'under'
      ? `linear-gradient(90deg, ${win} 0%, ${win} ${pct}%, ${lose} ${pct}%, ${lose} 100%)`
      : `linear-gradient(90deg, ${lose} 0%, ${lose} ${pct}%, ${win} ${pct}%, ${win} 100%)`;
  $('directionText').textContent = state.direction === 'under' ? 'Roll Under' : 'Roll Over';
  $('thresholdBadge').textContent = `ROLL ${state.direction === 'under' ? 'UNDER' : 'OVER'} ${pct} TO WIN`;
  const winBps = state.direction === 'under' ? state.targetBps : 9999 - state.targetBps;
  $('targetInput').value = pct;
  $('winChanceInput').value = (winBps / 100).toFixed(2);
  $('diceSlider').value = String(state.targetBps);
  updateOfflineCommandPreview();
}

function updateOfflineCommandPreview() {
  const bankAddr = state.summary?.bankAddress || (state.summary?.settlement?.readOnly ? '(bank offline)' : 'poa1...');
  $('bannerBankAddr').textContent = bankAddr;
  const clientSeed = seedValue().replace(/[^a-zA-Z0-9._-]/g, '') || 'client-seed-1';
  const memo = `DICE1:BET:${state.direction}:${state.targetBps}:${clientSeed}`;
  $('lastSignedMemoText').textContent = memo;
  $('liveOfflineCommand').textContent = `node poa.mjs send --node https://minepoa.com --wallet ~/.poa --to ${bankAddr} --amount ${wagerValue() || '1.000000'} --memo "${memo}"`;
}

async function fetchState() {
  try {
    const res = await fetch(api(`/api/state?address=${encodeURIComponent(state.playerAddress)}`));
    const data = await res.json();
    if (data && data.bankroll) applyStateSnapshot(data);
  } catch {
    const label = document.getElementById('sseStatusText');
    if (label && !state.sseConnected) label.textContent = 'OFFLINE';
  }
}

function setStatus(text, st) {
  $('sseStatusText').textContent = text;
  $('sseStatusBadge').dataset.state = st;
}

/** "Average play: 52 s (last 20 plays)" from /api/state playTime (server-side timings, most recent completed plays). */
export function avgPlayText(pt) {
  if (!pt || typeof pt.avgPlaySeconds !== 'number' || !Number.isFinite(pt.avgPlaySeconds) || !(pt.plays > 0)) return 'Average play: — (no timed plays yet)';
  const secs = pt.avgPlaySeconds >= 10 ? Math.round(pt.avgPlaySeconds) : Math.round(pt.avgPlaySeconds * 10) / 10;
  return `Average play: ${secs} s (last ${pt.plays === 1 ? 'play' : `${pt.plays} plays`})`;
}

function renderAvgPlayTime(pt) {
  const el = document.getElementById('avgPlayTime');
  if (!el || pt === undefined) return;
  el.textContent = avgPlayText(pt);
}

function applyStateSnapshot(data) {
  state.summary = data;
  const paused = data?.settlement ? data.settlement.trading === 'PAUSED_LEDGER_UNAVAILABLE' : state.ledgerPaused;
  if (paused !== state.ledgerPaused) {
    state.ledgerPaused = paused;
    $('ledgerPausedBanner').classList.toggle('hidden', !paused);
    renderRollAvailability();
    renderActionAvailability();
  }
  const b = data.bankroll;
  if (b) {
    $('topBankNav').textContent = `${formatNum(b.bankNavPoa, 4)} POA`;
    $('topBankAvail').textContent = `${formatNum(b.availableBankrollPoa, 4)} POA`;
    $('topKellyMax').textContent = `Kelly cap ${formatNum(b.kellyMaxProfitPoa, 2)} POA profit / roll`;
  }
  renderAvgPlayTime(data.playTime);
  if (data.stats) {
    $('statTotalBets').textContent = String(data.stats.totalBetsCount);
    $('statHouseNet').textContent = `House net ${formatNum(data.stats.netHouseProfitPoa, 4)} POA`;
  }
  const chain = data.chain;
  $('topBankChain').textContent = chain ? (chain.bank?.balance ? `Chain ${chain.bank.balance} POA` : 'Chain unavailable') : 'Local ledger';
  if (chain?.dev?.balance) {
    $('topDevChain').textContent = `Chain ${chain.dev.balance} POA`;
    $('topDevChain').title = `Live minepoa.com balance of ${chain.dev.address}. This is not vault fee accrual.`;
  } else {
    $('topDevChain').textContent = chain ? 'Chain unavailable' : 'Local ledger';
  }
  if (state.playerAddress) {
    $('chainBalanceText').textContent = chain?.player?.spendable != null ? `Spendable ${chain.player.spendable} POA` : chain && !chain.ok ? 'Chain balance unavailable' : 'Balance check needs a chain-backed server';
  } else {
    $('chainBalanceText').textContent = 'Add it to check your balance and LP position.';
  }
  if (data.settlement?.readOnly) setStatus(String(data.settlement.status || 'READ ONLY').replace(/_/g, ' '), 'down');
  else if (chain && !chain.ok) setStatus('CHAIN DOWN', 'down');
  else if (state.sseConnected) setStatus(chain ? 'CHAIN LIVE' : 'LIVE', 'live');

  if (data.devReserve) {
    $('topDevAddrShort').textContent = shortAddr(data.devReserve.address);
    $('topDevAddrShort').title = `${data.devReserve.address} (0.1% / 10 bps reserved earnings)`;
    $('topDevAccrued').textContent = `${formatNum(data.devReserve.accruedUnpaidPoa, 6)} POA`;
  }
  if (data.incentives) {
    $('incentivePoolBalText').textContent = `${formatNum(data.incentives.poolBalancePoa, 6)} POA`;
    $('currentEpochText').textContent = `E${data.currentEpoch}`;
  }
  const h = data.provablyFair?.serverSeedHash;
  if (h) {
    $('seedHashShort').textContent = `${h.slice(0, 10)}...${h.slice(-8)}`;
    $('seedHashShort').title = `Committed Server Seed SHA-256: ${h}`;
    if (!$('verifyServerSeedHash').value) $('verifyServerSeedHash').value = h;
  }
  if (Array.isArray(data.stakersLeaderboard)) {
    state.stakers = data.stakersLeaderboard;
    renderStakersTable();
  }
  renderUserLpPosition(data.userPosition);
  if (Array.isArray(data.recentBets)) {
    mergeBets(data.recentBets);
    renderBetsSoon();
  }
  chatFeed?.setSnapshot(data.recentChat);
  updateOfflineCommandPreview();
}

async function fetchBetQuote() {
  const amountPoa = AMOUNT_RE.test(wagerValue()) ? wagerValue() : '1.000000';
  try {
    const qs = new URLSearchParams({ amountPoa, targetBps: String(state.targetBps), direction: state.direction, address: state.playerAddress });
    const q = await (await fetch(api(`/api/quote/bet?${qs}`))).json();
    state.lastBetQuote = q;
    if (q.multiplierDisplay) {
      $('multiplierDisplay').textContent = q.multiplierDisplay;
      $('profitOnWinDisplay').textContent = `+${formatNum(q.profitOnWinPoa, 6)} POA`;
      $('edgeHintBadge').textContent = `${q.houseEdgePercent}% Edge`;
      $('walletVipBadge').textContent = `${q.vipTierName} (${q.houseEdgePercent}% Edge)`;
      $('payoutPreviewText').textContent = `Payout ${formatNum(q.payoutOnWinPoa, 4)} POA · EV ${q.expectedValuePoa} POA · 0.1% dev ${q.devReserveFeePoa} POA`;
    } else {
      $('multiplierDisplay').textContent = '—';
      $('profitOnWinDisplay').textContent = '—';
    }
  } catch {
    $('payoutPreviewText').textContent = 'Quote unavailable (server unreachable).';
  }
}

async function fetchDepositQuote() {
  const lockEpochs = Number($('lockEpochsInput').value || 0);
  $('convictionBoostPreview').textContent = `${lockEpochs} Epochs = ${(1 + Math.min(lockEpochs, 10) * 0.05).toFixed(2)}x Yield Weight`;
  const amountPoa = String($('depositAmountInput').value || '');
  if (!AMOUNT_RE.test(amountPoa)) return;
  try {
    const qs = new URLSearchParams({ amountPoa, lockEpochs: String(lockEpochs), address: state.playerAddress });
    const q = await (await fetch(api(`/api/quote/deposit?${qs}`))).json();
    if (!q.valid) return;
    $('quoteSharesMinted').textContent = Number(q.sharesMinted).toLocaleString('en-US');
    $('quoteBankPercent').textContent = `${q.shareOfLpPoolPercent}% of Bank`;
    $('quoteVipUnlocked').textContent = `${q.unlockedVipTier.name} (${q.unlockedVipTier.houseEdgePercent}% Dice Edge)`;
    $('depositProjectionsBody').innerHTML = (q.projections || [])
      .map((p) => `<tr><td>+${p.bankrollGrowthPercent}% Bank Growth</td><td class="highlight-cyan">${formatNum(p.projectedPositionValuePoa, 4)} POA</td><td class="highlight-emerald">+${formatNum(p.projectedNetProfitPoa, 4)} POA</td></tr>`)
      .join('');
  } catch {
    // offline
  }
}

async function fetchWithdrawQuote() {
  if (!state.playerAddress) return;
  try {
    const qs = new URLSearchParams({ address: state.playerAddress, mode: state.withdrawBps === 10000 ? 'ALL' : 'BPS', bpsToRedeem: String(state.withdrawBps) });
    const q = await (await fetch(api(`/api/quote/withdraw?${qs}`))).json();
    if (!q.valid) {
      $('withdrawQuoteShares').textContent = '0 (No Active Position)';
      return;
    }
    $('withdrawQuoteShares').textContent = Number(q.sharesRedeemed).toLocaleString('en-US');
    $('withdrawQuoteGross').textContent = `${formatNum(q.grossValuePoa, 6)} POA`;
    $('withdrawQuoteFee').textContent = `${formatNum(q.earlyExitFeePoa, 6)} POA (${q.earlyExitFeeBps} bps)`;
    $('withdrawQuoteNet').textContent = `${formatNum(q.netPayoutPoa, 6)} POA`;
    $('withdrawQuoteStatus').textContent = q.instant ? 'INSTANT' : 'QUEUED (FIFO)';
  } catch {
    // offline
  }
}

async function refreshQuotes() {
  await Promise.all([fetchBetQuote(), fetchBatchQuotes(), fetchActionQuotes(), fetchDepositQuote(), fetchWithdrawQuote()]);
}
const refreshQuotesSoon = debounce(refreshQuotes, 200);

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderUserLpPosition(pos) {
  if (!pos || !pos.hasPosition) {
    $('userSharePct').textContent = '0.0000%';
    $('userRedeemablePoa').textContent = '0.000000 POA';
    $('userNetPnlPoa').textContent = '0.000000 POA';
    $('userConvictionBadge').textContent = 'Conviction: 1.00x';
    return;
  }
  $('userSharePct').textContent = `${pos.shareOfLpPoolPercent}%`;
  $('userRedeemablePoa').textContent = `${formatNum(pos.currentValuePoa, 6)} POA`;
  const pnl = Number(pos.netPnlPoa || 0);
  $('userNetPnlPoa').textContent = `${pnl >= 0 ? '+' : ''}${formatNum(pos.netPnlPoa, 6)} POA`;
  $('userConvictionBadge').textContent = `Conviction: ${pos.convictionMultiplier} (${pos.vipTier?.tierName || 'Standard'})`;
}

function renderStakersTable() {
  $('stakersCountBadge').textContent = `${state.stakers.length} Staker${state.stakers.length === 1 ? '' : 's'}`;
  const tbody = $('stakersTableBody');
  if (state.stakers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4">No deposits yet. The vault only counts signed deposits.</td></tr>';
    return;
  }
  tbody.innerHTML = state.stakers
    .map((s) => `<tr><td title="${escapeHtml(s.address)}"><code>${escapeHtml(shortAddr(s.address))}</code>${s.address === state.playerAddress ? ' <span class="badge badge-cyan">YOU</span>' : ''}</td><td class="highlight-cyan"><strong>${escapeHtml(s.shareOfLpPoolPercent)}%</strong></td><td class="highlight-emerald">${formatNum(s.currentValuePoa, 4)} POA</td><td>${escapeHtml(s.convictionMultiplier)} &bull; ${escapeHtml(s.vipTier?.tierName || 'Standard')}</td></tr>`)
    .join('');
}

function mergeBets(bets) {
  for (const bet of [...bets].reverse()) upsertBet(bet);
  state.recentBets.sort((a, b) => (b.ts || 0) - (a.ts || 0) || 0);
  if (state.recentBets.length > 200) state.recentBets.length = 200;
}

function upsertBet(bet) {
  if (!bet || !bet.betTxid) return;
  const idx = state.recentBets.findIndex((b) => b.betTxid === bet.betTxid);
  if (idx === -1) state.recentBets.unshift(bet);
  else state.recentBets[idx] = { ...state.recentBets[idx], ...bet };
}

let renderQueued = false;
function renderBetsSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderLiveBetsTable();
    renderInlineHistory();
    const latest = state.recentBets[0];
    if (latest) paintSettledRoll(latest);
  });
}

function renderInlineHistory() {
  const list = $('inlineRollHistory');
  const bets = state.recentBets.filter((b) => b && b.rollDisplay);
  $('inlineHistoryCount').textContent = String(bets.length);
  if (bets.length === 0) {
    list.innerHTML = '<li class="roll-card roll-card-empty">Rolls your agent signs show up here live.</li>';
    return;
  }
  list.innerHTML = bets
    .slice(0, 8)
    .map((b) => {
      const cond = `${b.direction === 'under' ? 'Under' : 'Over'} ${b.targetDisplay || (b.targetBps / 100).toFixed(2)}`;
      return `<li class="roll-card ${b.won ? 'is-win' : 'is-loss'}" data-bet-txid="${escapeHtml(b.betTxid)}"><div class="roll-card-num">${escapeHtml(b.rollDisplay)}</div><div class="roll-card-meta"><strong>${b.won ? 'Win' : 'Loss'}</strong><span>${escapeHtml(cond)} · ${formatNum(b.wagerPoa, 2)} POA</span><span>${b.won ? '+' + formatNum(b.payoutPoa, 4) : '0.0000'} POA</span><code class="roll-card-sig">${escapeHtml(shortAddr(b.address))}</code></div></li>`;
    })
    .join('');
}

function renderLiveBetsTable() {
  $('betsCountBadge').textContent = String(state.recentBets.length);
  const tbody = $('liveBetsTableBody');
  if (state.recentBets.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8fa3c7;">No bets yet. Copy a roll prompt into your agent to place the first one.</td></tr>';
    return;
  }
  tbody.innerHTML = state.recentBets
    .slice(0, 35)
    .map((b) => {
      const cond = `${b.direction === 'under' ? '<' : '>'} ${b.targetDisplay || (b.targetBps / 100).toFixed(2)}`;
      return `<tr data-bet-txid="${escapeHtml(b.betTxid)}" style="cursor:pointer;" title="Click to load into the verifier"><td><code>${escapeHtml(shortAddr(b.address))}</code></td><td>${escapeHtml(cond)} (${escapeHtml(b.multiplierDisplay)})</td><td>${formatNum(b.wagerPoa, 4)} POA</td><td class="${b.won ? 'bet-win-pill' : 'bet-loss-pill'}">${escapeHtml(b.rollDisplay)}</td><td class="${b.won ? 'bet-win-pill' : ''}">${b.won ? '+' + formatNum(b.payoutPoa, 4) : '0.0000'} POA</td></tr>`;
    })
    .join('');
}

function paintSettledRoll(bet) {
  if (!bet || typeof bet.rollBps !== 'number') return;
  $('rollDigits').textContent = bet.rollDisplay;
  $('rollDigits').className = `roll-digits ${bet.won ? 'win-text' : 'loss-text'}`;
  $('rollStage').className = `roll-stage ${bet.won ? 'win-glow' : 'loss-glow'}`;
  $('rollStatusLabel').textContent = bet.won
    ? `WON +${formatNum(bet.netPlayerDeltaPoa, 4)} POA (${bet.multiplierDisplay})`
    : `ROLLED ${bet.rollDisplay} — HOUSE COLLECTS ${formatNum(bet.wagerPoa, 4)} POA`;
  const pin = $('lastRollPin');
  pin.style.left = `${Math.min(99, Math.max(1, bet.rollBps / 100))}%`;
  $('lastRollPinText').textContent = bet.rollDisplay;
  pin.classList.remove('hidden');
}

function renderBatchProgress() {
  const b = state.batch;
  const el = $('batchProgress');
  if (!b) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.dataset.state = b.done >= b.count || b.completed ? 'done' : 'running';
  const pct = Math.round((100 * (b.done || 0)) / Math.max(1, b.count));
  el.innerHTML = `<div class="batch-bar"><span style="width:${pct}%"></span></div><span id="batchProgressText">${b.completed ? 'Batch finished' : 'Agent batch running'}: ${b.done || 0}/${b.count} rolls · ${b.wins || 0} wins · net ${formatNum(b.netPoa || 0, 4)} POA${b.stoppedReason && b.stoppedReason !== 'completed_all_rolls' ? ` · stopped: ${escapeHtml(b.stoppedReason)}` : ''}</span>`;
}

// ─── Chat: read-only feed + "Join the chat with your agent" prompt ─────────

let chatFeed = null;

function chatJoinPrompt() {
  return buildChatJoinPrompt({ mcpUrl: mcpUrl(), address: state.playerAddress, pageUrl: `${window.location.origin}${window.location.pathname}` });
}

function renderChatJoin() {
  $('chatJoinMcpUrl').textContent = mcpUrl();
  $('chatJoinPreview').textContent = chatJoinPrompt();
}

async function runVerifyRoll() {
  const payload = {
    serverSeed: $('verifyServerSeed').value.trim(),
    serverSeedHash: $('verifyServerSeedHash').value.trim(),
    clientSeed: $('verifyClientSeed').value.trim(),
    nonce: Number($('verifyNonce').value || 1),
    betTxid: $('verifyBetTxid').value.trim() || '0'.repeat(64),
    targetBps: Number($('verifyTargetBps').value || 4950),
    direction: $('verifyDirection').value,
  };
  if (!payload.serverSeed) {
    $('verifyResultPre').textContent = 'Paste the revealed server_seed first. Seeds are revealed when the house rotates them.';
    return;
  }
  const res = await fetch(api('/api/verify'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  $('verifyResultPre').textContent = JSON.stringify(await res.json(), null, 2);
}

// ─── Live updates: SSE with reconnect + polling fallback ────────────────────

let bootGeneration = 0;
let eventSource = null;
let pollTimer = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const refreshStateSoon = debounce(() => fetchState(), 120);

const DEFAULT_EPOCH_SECONDS = 21600;

/**
 * What a stake of `amountPoa` with `lockEpochs` does to the staker's lock, mirroring
 * BankrollEngine.deposit: the lock is per position, so lockUntil = max(existing lock,
 * currentEpoch + lockEpochs) and it covers every share in the position.
 */
export function stakeLockPlan({ amountPoa, lockEpochs, epoch, position, addressKnown = false, nowMs = Date.now() }) {
  const current = Number(epoch?.current ?? 1);
  const lengthSeconds = Number(epoch?.lengthSeconds) > 0 ? Number(epoch.lengthSeconds) : DEFAULT_EPOCH_SECONDS;
  const lock = Math.max(0, Math.min(1000, Math.floor(Number(lockEpochs) || 0)));
  let shares = 0n;
  try { shares = BigInt(position?.shares || 0); } catch { shares = 0n; }
  const hasShares = Boolean(position?.hasPosition) && shares > 0n;
  const existingLock = hasShares ? Number(position.lockUntilEpoch || 0) : 0;
  const newLock = current + lock;
  const lockUntil = Math.max(hasShares ? existingLock : 0, lock > 0 ? newLock : 0);
  const locked = lockUntil > current;
  const epochsLeft = locked ? lockUntil - current : 0;
  const startedAtMs = Number(epoch?.startedAt) > 0 ? Math.min(Number(epoch.startedAt) * 1000, nowMs) : null;
  const unlockAtMs = locked ? Math.max(nowMs, (startedAtMs ?? nowMs) + epochsLeft * lengthSeconds * 1000) : null;
  return {
    amountPoa: String(amountPoa || '0'),
    lockEpochs: lock,
    currentEpoch: current,
    lengthSeconds,
    lockUntil,
    locked,
    epochsLeft,
    unlockAtMs,
    hasShares,
    shares: shares.toString(),
    existingValuePoa: hasShares ? String(position.currentValuePoa ?? '0') : '0',
    existingLock,
    existingLocked: hasShares && existingLock > current,
    relocksExisting: hasShares && lock > 0 && newLock > existingLock,
    joinsExistingLock: hasShares && existingLock > current && existingLock >= newLock,
    addressKnown: Boolean(addressKnown),
    earlyExitFeePercent: String(epoch?.earlyExitFeePercent ?? '0.10')
  };
}

export function formatLockDuration(seconds) {
  const hours = Math.round(seconds / 3600);
  if (hours < 1) return `about ${Math.max(1, Math.round(seconds / 60))} minutes`;
  if (hours < 48) return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round((hours / 24) * 10) / 10;
  return `about ${days} days (${hours} hours)`;
}

function formatLocalDateTime(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

/** Exact modal copy for a plan (kept pure so tests can assert the wording). */
export function stakeLockCopy(plan, { formatDate = formatLocalDateTime } = {}) {
  const amount = `${formatNum(plan.amountPoa, 6)} POA`;
  const epochHours = formatLockDuration(plan.lengthSeconds).replace(/^about /, '');
  const n = plan.lockUntil;
  const ep = (k) => `${k} epoch${k === 1 ? '' : 's'}`;
  if (!plan.locked) {
    const body = [`No lock: you can withdraw whenever you like. A ${plan.earlyExitFeePercent}% early-exit fee applies if you withdraw in the same epoch as your latest deposit (now epoch ${plan.currentEpoch}).`];
    if (!plan.addressKnown) body.push({ warn: true, text: 'If your address already holds a locked stake in the vault, this deposit joins that lock. Enter your PoA address above to check before you stake.' });
    return {
      variant: 'open',
      title: 'Confirm your stake',
      amount: `Staking ${amount}`,
      facts: [['Lock', 'None'], ['Withdraw', 'Any time'], ['Current epoch', `Epoch ${plan.currentEpoch}`]],
      body,
      confirm: 'Copy stake prompt'
    };
  }
  const facts = [
    ['Locked for', `${ep(plan.epochsLeft)} · ${formatLockDuration(plan.epochsLeft * plan.lengthSeconds)}`],
    ['Unlocks', `Epoch ${n} · about ${formatDate(plan.unlockAtMs)}`],
    ['Current epoch', `Epoch ${plan.currentEpoch}`]
  ];
  const body = [
    { strong: 'No early exit.', text: ` Until epoch ${n} the vault refuses every withdrawal and yield claim from this position, in full or in part.` },
    `From epoch ${n} you can withdraw your tokens again. You get back the redeemable value of your shares at that time, which moves with the bankroll's results, so it can be more or less than you staked.`
  ];
  if (plan.relocksExisting) {
    const was = plan.existingLocked ? ` (currently locked until epoch ${plan.existingLock})` : '';
    body.push({ warn: true, text: `This also locks your existing ${formatNum(plan.existingValuePoa, 6)} POA in the vault${was} until epoch ${n}. A lock covers your whole position, not just this deposit.` });
  } else if (plan.joinsExistingLock) {
    body.push({ warn: true, text: `Your position is already locked until epoch ${n}, so this deposit is locked until epoch ${n} too. A lock covers your whole position.` });
  } else if (!plan.addressKnown) {
    body.push({ warn: true, text: `If your address already holds shares in the vault, they are locked until epoch ${n} too: a lock covers your whole position. Enter your PoA address above to see it here.` });
  }
  body.push({ note: true, text: `Epochs are nominally ${epochHours} long and are advanced by the vault operator, so the real unlock time can differ from this estimate. Epoch ${n} is what counts.` });
  return {
    variant: 'lock',
    title: plan.lockEpochs > 0 ? 'Your POA will be locked' : 'This stake joins a locked position',
    amount: `Staking ${amount}`,
    facts,
    body,
    confirm: 'I understand, copy stake prompt'
  };
}

let stakeConfirmOpen = null;

function renderStakeConfirm(copy) {
  const root = $('stakeConfirm');
  root.dataset.variant = copy.variant;
  $('stakeConfirmTitle').textContent = copy.title;
  $('stakeConfirmAmount').textContent = copy.amount;
  const dl = $('stakeConfirmFacts');
  dl.replaceChildren();
  for (const [k, v] of copy.facts) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const body = $('stakeConfirmBody');
  body.replaceChildren();
  for (const item of copy.body) {
    const p = document.createElement('p');
    const it = typeof item === 'string' ? { text: item } : item;
    if (it.warn) p.className = 'modal-warn';
    if (it.note) p.className = 'modal-note';
    if (it.strong) {
      const b = document.createElement('strong');
      b.textContent = it.strong;
      p.append(b);
    }
    p.append(document.createTextNode(it.text));
    body.append(p);
  }
  $('stakeConfirmOk').textContent = copy.confirm;
  $('stakeConfirmIcon')?.replaceChildren(document.createTextNode(copy.variant === 'lock' ? '\u{1F512}' : '\u{2705}'));
}

/** Show the lock-up confirmation; resolves true on Confirm, false on Cancel / Esc / backdrop. */
async function confirmStake() {
  if (stakeConfirmOpen) return false;
  let snapshot = state.summary;
  try {
    const res = await fetch(api(`/api/state?address=${encodeURIComponent(state.playerAddress)}`));
    const data = await res.json();
    if (data && data.bankroll) {
      applyStateSnapshot(data);
      snapshot = data;
    }
  } catch {
    // fall back to the last snapshot
  }
  const plan = stakeLockPlan({
    amountPoa: $('depositAmountInput').value,
    lockEpochs: $('lockEpochsInput').value,
    epoch: snapshot?.epoch || { current: snapshot?.currentEpoch },
    position: state.playerAddress ? snapshot?.userPosition : null,
    addressKnown: Boolean(state.playerAddress)
  });
  renderStakeConfirm(stakeLockCopy(plan));
  const root = $('stakeConfirm');
  const card = root.querySelector('.modal-card');
  const opener = document.activeElement;
  root.classList.remove('hidden');
  document.body.classList.add('modal-open');
  return new Promise((resolve) => {
    const focusables = () => [...card.querySelectorAll('button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])')];
    const close = (ok) => {
      root.classList.add('hidden');
      document.body.classList.remove('modal-open');
      document.removeEventListener('keydown', onKey, true);
      root.removeEventListener('mousedown', onBackdrop);
      $('stakeConfirmOk').removeEventListener('click', onOk);
      $('stakeConfirmCancel').removeEventListener('click', onCancel);
      stakeConfirmOpen = null;
      if (opener && typeof opener.focus === 'function') opener.focus();
      resolve(ok);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBackdrop = (e) => { if (e.target === root) close(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !card.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !card.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    stakeConfirmOpen = close;
    document.addEventListener('keydown', onKey, true);
    root.addEventListener('mousedown', onBackdrop);
    $('stakeConfirmOk').addEventListener('click', onOk);
    $('stakeConfirmCancel').addEventListener('click', onCancel);
    $('stakeConfirmOk').focus();
  });
}

export function stopPoaDice() {
  bootGeneration += 1;
  if (eventSource) eventSource.close();
  eventSource = null;
  clearTimeout(pollTimer);
  clearTimeout(reconnectTimer);
}

// Emoji brand logo: a different dice/agent/proof combo on every page load.
export const BRAND_LOGO_COMBOS = [
  '🎲🤖', '🎲🔐', '🤖🎲✨', '🎲⚡', '🔮🎲', '🎲🧠', '🎰🤖', '🎲🛡️',
  '🤖🔗🎲', '🎲💎', '🧬🎲', '🎲🚀', '🦾🎲', '🎲🔍', '🎲🏦', '🎯🎲',
];
const BRAND_LOGO_KEY = 'poaDice.brandLogo';

export function pickBrandLogo(previous, rand = Math.random) {
  const pool = BRAND_LOGO_COMBOS.filter((c) => c !== previous);
  const list = pool.length ? pool : BRAND_LOGO_COMBOS;
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))];
}

function applyBrandLogo() {
  const el = document.getElementById('brandLogo');
  if (!el) return;
  let previous = null;
  try { previous = window.localStorage.getItem(BRAND_LOGO_KEY); } catch { previous = null; }
  const combo = pickBrandLogo(previous);
  el.textContent = combo;
  el.dataset.count = String((combo.match(/\p{Extended_Pictographic}/gu) || []).length);
  try { window.localStorage.setItem(BRAND_LOGO_KEY, combo); } catch { /* storage blocked: still random */ }
}

export function bootPoaDice() {
  const myGen = ++bootGeneration;
  const alive = () => myGen === bootGeneration && !!document.getElementById('btnCopyPrompt');
  try { applyBrandLogo(); } catch { /* keep the default logo */ }
  let storage = null;
  try { storage = window.localStorage; } catch { storage = null; }
  initDismissibleNotice({ noticeEl: document.getElementById('legalNotice'), closeEl: document.getElementById('legalNoticeClose'), storage, rootEl: document.documentElement });
  chatFeed = createChatFeed({ listEl: document.getElementById('chatMessagesList'), countEl: document.getElementById('chatCountBadge') });
  chatFeed.render();
  bindEvents();
  const saved = loadSavedAddress();
  if (saved && !String($('playerAddressInput').value || '').trim()) {
    $('playerAddressInput').value = saved;
    state.playerAddress = saved;
  }
  renderChatJoin();
  updateSliderVisuals();
  renderRollAvailability();
  void (async () => {
    await fetchState();
    if (!alive()) return;
    await refreshQuotes();
    if (!alive()) return;
    connectRealtimeStream(alive);
    schedulePoll(alive);
  })();
}

function schedulePoll(alive) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!alive()) return;
    await fetchState();
    if (!state.sseConnected) await Promise.all([fetchBatchQuotes(), fetchActionQuotes()]);
    schedulePoll(alive);
  }, state.sseConnected ? POLL_MS : POLL_MS_DISCONNECTED);
}

function connectRealtimeStream(alive) {
  if (eventSource) eventSource.close();
  try {
    eventSource = new EventSource(api('/api/stream'));
  } catch {
    setStatus('POLLING', 'down');
    return;
  }
  eventSource.onopen = () => {
    state.sseConnected = true;
    reconnectDelay = 1000;
    setStatus(state.summary?.chain ? (state.summary.chain.ok ? 'CHAIN LIVE' : 'CHAIN DOWN') : 'LIVE', state.summary?.chain && !state.summary.chain.ok ? 'down' : 'live');
  };
  eventSource.onmessage = (ev) => {
    if (!alive()) return;
    try {
      handleRealtimeEvent(JSON.parse(ev.data));
    } catch {
      // ignore malformed
    }
  };
  eventSource.onerror = () => {
    state.sseConnected = false;
    setStatus('RECONNECTING', 'down');
    if (eventSource && eventSource.readyState === 2) {
      eventSource.close();
      eventSource = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => alive() && connectRealtimeStream(alive), reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 2);
    }
  };
}

const seenEventIds = new Set();
const seenEventOrder = [];
function handleRealtimeEvent(msg) {
  if (!msg || !msg.type) return;
  if (msg.id) {
    if (seenEventIds.has(msg.id)) return; // dedupe: same event delivered twice
    seenEventIds.add(msg.id);
    seenEventOrder.push(msg.id);
    if (seenEventOrder.length > 1000) seenEventIds.delete(seenEventOrder.shift());
  }
  const p = msg.payload || {};
  switch (msg.type) {
    case 'bet.settled':
      upsertBet(p);
      if (state.batch && !state.batch.completed && p.address === state.batch.address) state.batch.done = Math.max(state.batch.done || 0, (state.batch.done || 0) + 1);
      renderBetsSoon();
      renderBatchProgress();
      refreshStateSoon();
      refreshQuotesSoon();
      break;
    case 'batch.started':
      state.batch = { ...p, done: 0, wins: 0, netPoa: '0', completed: false };
      renderBatchProgress();
      break;
    case 'batch.progress':
      state.batch = { ...(state.batch || {}), ...p };
      renderBatchProgress();
      break;
    case 'batch.completed':
      state.batch = { ...(state.batch || {}), ...p, completed: true };
      renderBatchProgress();
      refreshStateSoon();
      refreshQuotesSoon();
      break;
    case 'chat.message':
      chatFeed?.add(p);
      break;
    default:
      // bank.deposit / bank.withdraw / seed.rotated / dev.swept / epoch.advanced / refunds …
      refreshStateSoon();
      refreshQuotesSoon();
  }
}

// ─── Events ─────────────────────────────────────────────────────────────────

function switchTab(attr, prefix, names, tabName) {
  document.querySelectorAll(`[${attr}]`).forEach((btn) => btn.classList.toggle('active', btn.getAttribute(attr) === tabName));
  for (const n of names) $(`${prefix}${n[0].toUpperCase()}${n.slice(1)}`).classList.toggle('hidden', n !== tabName);
}

function bindEvents() {
  const onRollInput = () => {
    updateOfflineCommandPreview();
    renderRollAvailability();
    refreshQuotesSoon();
  };
  $('diceSlider').addEventListener('input', () => {
    state.targetBps = Number($('diceSlider').value);
    updateSliderVisuals();
    onRollInput();
  });
  $('targetInput').addEventListener('change', (e) => {
    const min = state.direction === 'under' ? 100 : 199;
    const max = state.direction === 'under' ? 9800 : 9899;
    state.targetBps = Math.max(min, Math.min(max, Math.round(Number(e.target.value) * 100) || 4950));
    updateSliderVisuals();
    onRollInput();
  });
  $('winChanceInput').addEventListener('change', (e) => {
    const winBps = Math.max(100, Math.min(9800, Math.round(Number(e.target.value) * 100) || 4950));
    state.targetBps = state.direction === 'under' ? winBps : 9999 - winBps;
    updateSliderVisuals();
    onRollInput();
  });
  $('btnFlipDirection').addEventListener('click', () => {
    state.direction = state.direction === 'under' ? 'over' : 'under';
    state.targetBps = Math.max(state.direction === 'under' ? 100 : 199, Math.min(state.direction === 'under' ? 9800 : 9899, 9999 - state.targetBps));
    updateSliderVisuals();
    onRollInput();
  });
  $('wagerInput').addEventListener('input', onRollInput);
  $('clientSeedInput').addEventListener('input', onRollInput);
  const setWager = (v) => {
    $('wagerInput').value = Math.max(1, v).toFixed(6);
    onRollInput();
  };
  $('btnBetMin').addEventListener('click', () => setWager(1));
  $('btnBetHalf').addEventListener('click', () => setWager((Number(wagerValue()) || 2) / 2));
  $('btnBetDouble').addEventListener('click', () => setWager((Number(wagerValue()) || 1) * 2));
  $('btnBetMax').addEventListener('click', () => {
    const sel = state.batchQuotes?.find((q) => q.count === state.rollCount);
    setWager(Math.floor(Number(sel?.maxWagerForCountPoa || 1) * 100) / 100);
  });
  $('btnRandomSeed').addEventListener('click', () => {
    $('clientSeedInput').value = randomClientSeed();
    onRollInput();
  });
  // Every visitor starts with their own random client seed (never a shared default).
  if (!String($('clientSeedInput').value || '').trim()) $('clientSeedInput').value = randomClientSeed();
  $('playerAddressInput').addEventListener('input', () => {
    const a = String($('playerAddressInput').value || '').trim();
    state.playerAddress = ADDR_RE.test(a) ? a : '';
    if (state.playerAddress || !a) saveAddress(state.playerAddress);
    renderChatJoin();
    onRollInput();
    refreshStateSoon();
  });
  document.querySelectorAll('[data-roll-count]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      state.rollCount = Number(btn.getAttribute('data-roll-count'));
      renderRollAvailability();
    });
  });
  $('btnCopyPrompt').addEventListener('click', async () => {
    if ($('btnCopyPrompt').disabled) return;
    const text = rollPrompt();
    $('promptPreview').textContent = text;
    if (await copyText(text)) flashCopied($('btnCopyPrompt'), $('btnCopyPromptText'), 'Copy prompt');
  });
  for (const a of ACTIONS) {
    $(a.btn).addEventListener('click', async (e) => {
      if (e.currentTarget.tagName === 'BUTTON' && e.currentTarget.form) e.preventDefault();
      if ($(a.btn).disabled) return;
      if (a.kind === 'stake' && !(await confirmStake())) return;
      const text = actionPrompt(a.kind);
      $(a.btn).dataset.prompt = text;
      if (await copyText(text)) flashCopied($(a.btn), null, a.label);
    });
  }
  const onActionInput = debounce(() => {
    fetchActionQuotes();
    fetchDepositQuote();
  }, 150);
  ['depositAmountInput', 'lockEpochsInput', 'referrerInput', 'autoStrategySelect', 'autoRollsInput'].forEach((id) => {
    $(id).addEventListener('input', onActionInput);
    $(id).addEventListener('change', onActionInput);
  });
  document.querySelectorAll('[data-set-deposit]').forEach((btn) =>
    btn.addEventListener('click', () => {
      $('depositAmountInput').value = btn.getAttribute('data-set-deposit');
      onActionInput();
    })
  );
  document.querySelectorAll('[data-withdraw-bps]').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-withdraw-bps]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.withdrawBps = Number(btn.getAttribute('data-withdraw-bps'));
      $('withdrawBpsLabel').textContent = `${(state.withdrawBps / 100).toFixed(0)}% OF YOUR BANK SHARES`;
      fetchWithdrawQuote();
      fetchActionQuotes();
    })
  );
  document.querySelectorAll('[data-bank-tab]').forEach((btn) =>
    btn.addEventListener('click', () => switchTab('data-bank-tab', 'bankTab', ['deposit', 'withdraw', 'incentives'], btn.getAttribute('data-bank-tab')))
  );
  document.querySelectorAll('[data-feed-tab]').forEach((btn) =>
    btn.addEventListener('click', () => switchTab('data-feed-tab', 'feedTab', ['chat', 'bets', 'verify'], btn.getAttribute('data-feed-tab')))
  );
  $('liveBetsTableBody').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-bet-txid]');
    const bet = row && state.recentBets.find((x) => x.betTxid === row.getAttribute('data-bet-txid'));
    if (!bet) return;
    $('verifyServerSeedHash').value = bet.provablyFair?.serverSeedHash || '';
    $('verifyClientSeed').value = bet.provablyFair?.clientSeed || '';
    $('verifyNonce').value = String(bet.provablyFair?.nonce || 1);
    $('verifyBetTxid').value = bet.betTxid || '';
    $('verifyTargetBps').value = String(bet.targetBps || 4950);
    $('verifyDirection').value = bet.direction || 'under';
    switchTab('data-feed-tab', 'feedTab', ['chat', 'bets', 'verify'], 'verify');
  });
  $('btnCopyOfflineCmd').addEventListener('click', async () => {
    if (await copyText($('liveOfflineCommand').textContent)) flashCopied($('btnCopyOfflineCmd'), null, 'Copy Command');
  });
  $('btnCopyChatJoin').addEventListener('click', async () => {
    const text = chatJoinPrompt();
    $('chatJoinPreview').textContent = text;
    if (await copyText(text)) flashCopied($('btnCopyChatJoin'), null, 'Copy prompt');
  });
  $('btnRunVerify').addEventListener('click', runVerifyRoll);
}

if (typeof document !== 'undefined' && document.body?.dataset.autoboot === 'true') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => bootPoaDice());
  else bootPoaDice();
}
