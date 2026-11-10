#!/usr/bin/env node
/**
 * bin/poa-dice-cli.mjs — Website-Independent & Non-Custodial CLI for POA Dice & Shared Bankroll Vault
 *
 * Works against a live poa-dice server (--server https://poadice.grok.me) with 100% local Ed25519 signing
 * (private key never leaves ~/.poa-dice-wallet) OR 100% offline/headless directly against local state
 * (--offline) OR builds pure DICE1:* on-chain transfer memos (offline-tx).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAINNET_CHAIN_ID,
  buildSignedTransfer,
  formatDiceMemo,
  fromMicros,
  genKeypair,
  isValidPoaAddress,
  redactSecrets,
  signRaw,
  toMicros,
  walletFromPrivkey
} from '../src/crypto-poa.mjs';
import { BankrollEngine, DEV_RESERVE_ADDRESS, MIN_BET_MICROS } from '../src/bankroll-engine.mjs';
import { LedgerWatcher } from '../src/ledger-watcher.mjs';
import { MinepoaClient } from '../src/minepoa-client.mjs';
import { formatChatSigningPayloadV2 } from '../src/chat.mjs';
import { verifyRoll } from '../src/provably-fair.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(tok);
    }
  }
  return args;
}

function loadOrCreateLocalWallet(walletDir) {
  const dir = walletDir || path.join(os.homedir(), '.poa-dice-wallet');
  const keyFile = path.join(dir, 'key');
  const addrFile = path.join(dir, 'address');
  if (fs.existsSync(keyFile)) {
    const priv = fs.readFileSync(keyFile, 'utf8').trim();
    return walletFromPrivkey(priv);
  }
  fs.mkdirSync(dir, { recursive: true });
  const kp = genKeypair();
  fs.writeFileSync(keyFile, kp.privkey + '\n', { mode: 0o600 });
  fs.writeFileSync(addrFile, kp.address + '\n', { mode: 0o644 });
  return kp;
}

async function tryHttp(serverUrl, endpoint, options = {}) {
  const url = `${serverUrl.replace(/\/$/, '')}${endpoint}`;
  const res = await fetch(url, options);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error || body?.reason || `HTTP ${res.status}`;
    throw Object.assign(new Error(detail), { status: res.status, body });
  }
  return body;
}

async function callMcpTool(serverUrl, name, toolArgs = {}) {
  const res = await tryHttp(serverUrl, '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: toolArgs }
    })
  });
  if (res?.error) throw new Error(res.error.message || JSON.stringify(res.error));
  const text = res?.result?.content?.[0]?.text || '{}';
  const parsed = JSON.parse(text);
  if (res?.result?.isError) {
    throw new Error(parsed?.error || parsed?.reason || text);
  }
  return parsed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signForServer({ wallet, state, nodeOverride, to, amount, memo, count = 1 }) {
  const isChain = state?.settlement?.mode === 'chain';
  const cid = state?.chainId || MAINNET_CHAIN_ID;
  if (!to || !isValidPoaAddress(to)) {
    throw new Error('Server bankAddress is unavailable; refusing to sign transfer');
  }
  if (!isChain) {
    const baseNonce = Math.floor(Date.now() / 1000) * 100 + Math.floor(Math.random() * 50);
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(buildSignedTransfer({ wallet, to, amount, memo, nonce: baseNonce + i, cid }));
    }
    return count === 1 ? out[0] : out;
  }
  const nodeUrl = nodeOverride || state?.chain?.node || process.env.POA_MINEPOA_NODE || 'https://minepoa.com';
  const client = new MinepoaClient({ nodeUrl, chainId: cid });
  const [firstNonce, parents] = await Promise.all([client.nextNonce(wallet.address), client.getTipParents()]);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      buildSignedTransfer({
        wallet,
        to,
        amount,
        memo,
        nonce: firstNonce + i,
        parents,
        cid
      })
    );
  }
  return count === 1 ? out[0] : out;
}

/**
 * Non-custodial sequential confirm-per-roll strategy execution on a live chain-settled (or HTTP) server.
 * Sizes each roll AFTER the previous roll settles on-chain, keeping the Ed25519 key strictly local.
 */
async function executeSequentialRemoteStrategy({
  serverUrl,
  wallet,
  nodeOverride,
  strategy = 'quarter_kelly',
  baseWagerPoa = '1.000000',
  targetBps = 4950,
  direction = 'under',
  rolls = 5,
  clientSeed = 'cli-seq-strategy',
  stopOnProfitPoa = null,
  stopOnLossPoa = null,
  maxTotalSpendPoa = null,
  waitSeconds = 90
}) {
  const state = await tryHttp(serverUrl, `/api/state?address=${encodeURIComponent(wallet.address)}`);
  const maxRolls = Math.max(1, Math.min(100, Number(rolls || 5)));
  const strat = String(strategy || 'flat').toLowerCase();
  const baseMicros = toMicros(baseWagerPoa);
  const stopProfitMicros = stopOnProfitPoa ? toMicros(String(stopOnProfitPoa)) : null;
  const stopLossMicros = stopOnLossPoa ? toMicros(String(stopOnLossPoa)) : null;
  const capMicros = maxTotalSpendPoa ? toMicros(String(maxTotalSpendPoa)) : null;

  let currentMicros = baseMicros;
  let spentMicros = 0n;
  let cumulativeNetMicros = 0n;
  let winStreak = 0;
  let wins = 0;
  let losses = 0;
  let stoppedReason = 'completed_all_rolls';
  const receipts = [];

  for (let i = 0; i < maxRolls; i++) {
    const q = await tryHttp(
      serverUrl,
      `/api/quote/bet?amountPoa=${encodeURIComponent(fromMicros(currentMicros))}&targetBps=${targetBps}&direction=${direction}&address=${encodeURIComponent(wallet.address)}`
    );
    if (q.trading === 'HOLD') {
      stoppedReason = q.code || 'trading_hold';
      break;
    }
    const maxAllowedMicros = toMicros(q.maxAllowedWagerPoa || '0');
    if (maxAllowedMicros < MIN_BET_MICROS) {
      stoppedReason = 'bankroll_kelly_limit_reached';
      break;
    }
    if (strat === 'quarter_kelly' && q.kellySizing?.quarterKellyPoa) {
      currentMicros = toMicros(q.kellySizing.quarterKellyPoa);
    }
    if (currentMicros > maxAllowedMicros) currentMicros = maxAllowedMicros;
    if (currentMicros < MIN_BET_MICROS) currentMicros = MIN_BET_MICROS;
    if (capMicros !== null && spentMicros + currentMicros > capMicros) {
      stoppedReason = 'max_total_spend_reached';
      break;
    }

    const wagerPoa = fromMicros(currentMicros);
    const rollSeed = `${clientSeed}-r${i + 1}`.slice(0, 48);
    const memo = formatDiceMemo({ action: 'BET', direction, targetBps, clientSeed: rollSeed });
    const signedTx = await signForServer({
      wallet,
      state,
      nodeOverride,
      to: state.bankAddress,
      amount: wagerPoa,
      memo
    });

    const res = await callMcpTool(serverUrl, 'dice_place_bet', {
      amount_poa: wagerPoa,
      target_bps: targetBps,
      direction,
      client_seed: rollSeed,
      max_total_spend_poa: wagerPoa,
      signed_tx: signedTx,
      wait_seconds: waitSeconds
    });

    let settledRoll = res?.rolls?.[0] || (res?.action === 'BET_SETTLED' ? res : null);
    const txid = signedTx.id;
    const pollDeadline = Date.now() + Math.max(5, Number(waitSeconds || 90)) * 1000;
    while (!settledRoll && Date.now() < pollDeadline) {
      await sleep(1500);
      const st = await tryHttp(serverUrl, `/api/tx/status/${txid}`).catch(() => null);
      if (st?.result?.action === 'BET_SETTLED') {
        settledRoll = st.result;
        break;
      }
      if (st && (st.status === 'FAILED' || st.status === 'EXPIRED' || st.rawStatus === 'REFUNDED')) {
        stoppedReason = `roll_${st.rawStatus || st.status}`.toLowerCase();
        break;
      }
    }
    if (!settledRoll) {
      if (stoppedReason === 'completed_all_rolls') stoppedReason = 'awaiting_chain_confirmation';
      receipts.push({ i: i + 1, betTxid: txid, status: 'PENDING_CONFIRMATION', wagerPoa });
      break;
    }

    spentMicros += currentMicros;
    const won = Boolean(settledRoll.won);
    const payoutPoa = settledRoll.payoutPoa || '0.000000';
    const delta = won ? toMicros(payoutPoa) - currentMicros : -currentMicros;
    cumulativeNetMicros += delta;
    receipts.push({
      i: i + 1,
      betTxid: settledRoll.betTxid || txid,
      rollDisplay: settledRoll.rollDisplay,
      won,
      wagerPoa,
      payoutPoa
    });

    if (won) {
      wins += 1;
      winStreak += 1;
      if (strat === 'martingale_capped') currentMicros = baseMicros;
      else if (strat === 'paroli') currentMicros = winStreak < 3 ? currentMicros * 2n : baseMicros;
    } else {
      losses += 1;
      winStreak = 0;
      if (strat === 'martingale_capped') currentMicros = currentMicros * 2n;
      else if (strat === 'paroli') currentMicros = baseMicros;
    }

    if (stopProfitMicros !== null && cumulativeNetMicros >= stopProfitMicros) {
      stoppedReason = 'take_profit_reached';
      break;
    }
    if (stopLossMicros !== null && cumulativeNetMicros <= -stopLossMicros) {
      stoppedReason = 'stop_loss_reached';
      break;
    }
  }

  return {
    ok: true,
    action: 'SEQUENTIAL_STRATEGY_COMPLETED',
    signer: 'local_ed25519_signed_tx',
    playerAddress: wallet.address,
    strategy: strat,
    rollsRequested: maxRolls,
    rollsExecuted: wins + losses,
    wins,
    losses,
    totalWageredPoa: fromMicros(spentMicros),
    cumulativeNetPoa:
      (cumulativeNetMicros < 0n ? '-' : '') +
      fromMicros(cumulativeNetMicros < 0n ? -cumulativeNetMicros : cumulativeNetMicros),
    stoppedReason,
    receipts
  };
}

const SUPPORTED_COMMANDS = [
  'status',
  'quote-bet',
  'bet',
  'quote-batch',
  'batch-roll',
  'auto-bet',
  'verify-roll',
  'audit',
  'quote-deposit',
  'stake',
  'quote-withdraw',
  'withdraw',
  'claim-yield',
  'position',
  'incentives',
  'chat',
  'chat-read',
  'feed',
  'tx-templates',
  'tx-status',
  'wallet-balance',
  'sweep-dev',
  'offline-tx'
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'status';
  const serverUrl = args.server || process.env.POA_DICE_URL || 'http://127.0.0.1:3080';
  const forceOffline = Boolean(args.offline);
  const adminToken = args['admin-token'] || process.env.POA_DICE_ADMIN_TOKEN || '';
  const dataDir = args.dataDir || args.state || path.join(process.cwd(), 'data');
  const waitSeconds = args.wait !== undefined ? Number(args.wait) : 60;

  const wallet = loadOrCreateLocalWallet(args.wallet);

  async function withOfflineFallback(httpFn, localFn) {
    if (!forceOffline) {
      try {
        return await httpFn();
      } catch (err) {
        // Only fall back when the server is genuinely unreachable, NOT when the server returned an HTTP rejection!
        if (err && err.status) throw err;
      }
    }
    const engine = new BankrollEngine({
      dataDir,
      initialBootstrapPoa: '250000.000000',
      bootstrapAddress: DEV_RESERVE_ADDRESS
    });
    const watcher = new LedgerWatcher({ engine, mode: 'simulated' });
    return await localFn(engine, watcher);
  }

  let output;

  if (cmd === 'status') {
    output = await withOfflineFallback(
      () => tryHttp(serverUrl, `/api/state?address=${encodeURIComponent(wallet.address)}`),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        walletAddress: wallet.address,
        state: engine.getStateSummary(wallet.address)
      })
    );
  } else if (cmd === 'quote-bet') {
    const amountPoa = String(args.amount || '10.000000');
    const direction = args.over ? 'over' : 'under';
    const targetBps = Math.round(Number(args.over || args.under || 49.5) * 100);
    output = await withOfflineFallback(
      () =>
        tryHttp(
          serverUrl,
          `/api/quote/bet?amountPoa=${encodeURIComponent(amountPoa)}&targetBps=${targetBps}&direction=${direction}&address=${wallet.address}`
        ),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        quote: engine.quoteBet({ address: wallet.address, amountPoa, targetBps, direction })
      })
    );
  } else if (cmd === 'bet') {
    const amountPoa = String(args.amount || '10.000000');
    const direction = args.over ? 'over' : 'under';
    const targetBps = Math.round(Number(args.over || args.under || 49.5) * 100);
    const clientSeed = String(args.seed || 'cli-agent-seed-01');
    const memo = formatDiceMemo({ action: 'BET', direction, targetBps, clientSeed });

    output = await withOfflineFallback(
      async () => {
        const state = await tryHttp(serverUrl, '/api/state');
        const signedTx = await signForServer({
          wallet,
          state,
          nodeOverride: args.node,
          to: state.bankAddress,
          amount: amountPoa,
          memo
        });
        const receipt = await callMcpTool(serverUrl, 'dice_place_bet', {
          amount_poa: amountPoa,
          target_bps: targetBps,
          direction,
          client_seed: clientSeed,
          max_total_spend_poa: args['max-spend'] || amountPoa,
          signed_tx: signedTx,
          wait_seconds: waitSeconds
        });
        return receipt?.rejected ? { ok: false, ...receipt } : { ok: true, receipt, ...receipt };
      },
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: amountPoa,
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000)
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx)
        };
      }
    );
  } else if (cmd === 'quote-batch') {
    const amountPoa = String(args.amount || '1.000000');
    const direction = args.over ? 'over' : 'under';
    const targetBps = Math.round(Number(args.over || args.under || 49.5) * 100);
    const count = Number(args.count || args.rolls || 5);
    const clientSeed = String(args.seed || 'agent-batch');
    output = await callMcpTool(serverUrl, 'dice_quote_batch', {
      count,
      amount_poa: amountPoa,
      target_bps: targetBps,
      direction,
      client_seed: clientSeed,
      address: wallet.address
    });
  } else if (cmd === 'batch-roll') {
    const amountPoa = String(args.amount || '1.000000');
    const direction = args.over ? 'over' : 'under';
    const targetBps = Math.round(Number(args.over || args.under || 49.5) * 100);
    const count = Number(args.count || args.rolls || 5);
    const clientSeed = String(args.seed || 'agent-batch');
    if (args.sequential || args.takeProfit || args['stop-on-profit'] || args.stopLoss || args['stop-on-loss']) {
      output = await executeSequentialRemoteStrategy({
        serverUrl,
        wallet,
        nodeOverride: args.node,
        strategy: 'flat',
        baseWagerPoa: amountPoa,
        targetBps,
        direction,
        rolls: count,
        clientSeed,
        stopOnProfitPoa: args.takeProfit || args['stop-on-profit'] || null,
        stopOnLossPoa: args.stopLoss || args['stop-on-loss'] || null,
        maxTotalSpendPoa: args['max-spend'] || null,
        waitSeconds
      });
    } else {
      const memo = formatDiceMemo({ action: 'BET', direction, targetBps, clientSeed });
      const state = await tryHttp(serverUrl, '/api/state');
      const signedList = await signForServer({
        wallet,
        state,
        nodeOverride: args.node,
        to: state.bankAddress,
        amount: amountPoa,
        memo,
        count
      });
      const totalPoa = fromMicros(toMicros(amountPoa) * BigInt(count));
      output = await callMcpTool(serverUrl, 'dice_batch_roll', {
        count,
        amount_poa: amountPoa,
        target_bps: targetBps,
        direction,
        client_seed: clientSeed,
        max_total_spend_poa: args['max-spend'] || totalPoa,
        signed_txs: Array.isArray(signedList) ? signedList : [signedList],
        wait_seconds: waitSeconds
      });
    }
  } else if (cmd === 'auto-bet') {
    const baseWagerPoa = String(args.amount || '10.000000');
    const direction = args.over ? 'over' : 'under';
    const targetBps = Math.round(Number(args.over || args.under || 49.5) * 100);
    const strategy = String(args.strategy || 'quarter_kelly');
    const rolls = Number(args.rolls || 5);
    const clientSeed = String(args.seed || 'cli-auto-strategy');
    output = await withOfflineFallback(
      () =>
        executeSequentialRemoteStrategy({
          serverUrl,
          wallet,
          nodeOverride: args.node,
          strategy,
          baseWagerPoa,
          targetBps,
          direction,
          rolls,
          clientSeed,
          stopOnProfitPoa: args.takeProfit || args['stop-on-profit'] || null,
          stopOnLossPoa: args.stopLoss || args['stop-on-loss'] || null,
          maxTotalSpendPoa: args['max-spend'] || null,
          waitSeconds
        }),
      (engine, watcher) => ({
        mode: 'offline-direct-engine',
        ...watcher.executeAutoStrategy({
          wallet,
          strategy,
          baseWagerPoa,
          targetBps,
          direction,
          rolls,
          clientSeed,
          stopOnProfitPoa: args.takeProfit || args['stop-on-profit'] || null,
          stopOnLossPoa: args.stopLoss || args['stop-on-loss'] || null,
          maxTotalSpendPoa: args['max-spend'] || null
        })
      })
    );
  } else if (cmd === 'verify-roll') {
    output = verifyRoll({
      serverSeed: String(args['server-seed'] || ''),
      expectedSeedHash: args['seed-hash'] ? String(args['seed-hash']) : null,
      clientSeed: String(args['client-seed'] || args.seed || ''),
      nonce: Number(args.nonce || 1),
      betTxid: String(args.txid || '')
    });
  } else if (cmd === 'quote-deposit') {
    const amountPoa = String(args.amount || '1000.000000');
    const lockEpochs = Number(args.epochs || 4);
    output = await withOfflineFallback(
      () =>
        tryHttp(
          serverUrl,
          `/api/quote/deposit?amountPoa=${encodeURIComponent(amountPoa)}&lockEpochs=${lockEpochs}&address=${wallet.address}`
        ),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        quote: engine.quoteDeposit({ address: wallet.address, amountPoa, lockEpochs })
      })
    );
  } else if (cmd === 'stake') {
    const amountPoa = String(args.amount || '1000.000000');
    const lockEpochs = args.epochs !== undefined ? Number(args.epochs) : 4;
    const memo = formatDiceMemo({ action: 'LP_ADD', lockEpochs, referrer: args.ref || null });

    output = await withOfflineFallback(
      async () => {
        const state = await tryHttp(serverUrl, '/api/state');
        const signedTx = await signForServer({
          wallet,
          state,
          nodeOverride: args.node,
          to: state.bankAddress,
          amount: amountPoa,
          memo
        });
        const receipt = await callMcpTool(serverUrl, 'bank_stake', {
          amount_poa: amountPoa,
          lock_epochs: lockEpochs,
          referrer: args.ref || undefined,
          max_total_spend_poa: args['max-spend'] || amountPoa,
          signed_tx: signedTx,
          wait_seconds: waitSeconds
        });
        return receipt?.rejected ? { ok: false, ...receipt } : { ok: true, receipt, ...receipt };
      },
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: amountPoa,
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000)
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx)
        };
      }
    );
  } else if (cmd === 'quote-withdraw') {
    const mode = args.shares ? 'SHARES' : args.bps ? 'BPS' : 'ALL';
    output = await callMcpTool(serverUrl, 'bank_quote_withdraw', {
      address: args.address || wallet.address,
      mode,
      bps: args.bps ? Number(args.bps) : undefined,
      shares: args.shares ? String(args.shares) : undefined
    });
  } else if (cmd === 'withdraw') {
    const bps = Number(args.bps || 10000);
    const shares = args.shares ? String(args.shares) : null;
    const memo = shares ? formatDiceMemo({ action: 'LP_WITHDRAW', shares }) : formatDiceMemo({ action: 'LP_WITHDRAW', bps });

    output = await withOfflineFallback(
      async () => {
        const state = await tryHttp(serverUrl, '/api/state');
        const signedTx = await signForServer({
          wallet,
          state,
          nodeOverride: args.node,
          to: state.bankAddress,
          amount: '0.000001',
          memo
        });
        const receipt = await callMcpTool(serverUrl, 'bank_withdraw', {
          mode: shares ? 'SHARES' : bps === 10000 ? 'ALL' : 'BPS',
          bps: shares ? undefined : bps,
          shares: shares || undefined,
          signed_tx: signedTx,
          wait_seconds: waitSeconds
        });
        return receipt?.rejected ? { ok: false, ...receipt } : { ok: true, receipt, ...receipt };
      },
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: '0.000001',
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000)
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx)
        };
      }
    );
  } else if (cmd === 'claim-yield') {
    const dry = await callMcpTool(serverUrl, 'bank_claim_yield', {
      address: wallet.address,
      dry_run: true
    });
    if (args['dry-run'] || !dry?.transferTemplate?.memo) {
      output = dry;
    } else {
      const state = await tryHttp(serverUrl, '/api/state');
      const signedTx = await signForServer({
        wallet,
        state,
        nodeOverride: args.node,
        to: state.bankAddress,
        amount: dry.transferTemplate.amount || '0.000001',
        memo: dry.transferTemplate.memo
      });
      output = await callMcpTool(serverUrl, 'bank_claim_yield', {
        address: wallet.address,
        signed_tx: signedTx,
        wait_seconds: waitSeconds
      });
    }
  } else if (cmd === 'position') {
    output = await callMcpTool(serverUrl, 'bank_position', {
      address: args.address || wallet.address
    });
  } else if (cmd === 'incentives') {
    output = await callMcpTool(serverUrl, 'bank_incentives_info', {
      compound_now: Boolean(args.compound)
    });
  } else if (cmd === 'chat') {
    const text = String(args.message || 'Hello from poa-dice CLI!');
    const senderName = String(args.name || 'CLI-Agent').slice(0, 32);
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(8).toString('hex');
    const envelope = formatChatSigningPayloadV2({
      address: wallet.address,
      senderName,
      timestamp,
      nonce,
      text
    });
    const memo = formatDiceMemo({ action: 'CHAT', text });
    output = await withOfflineFallback(
      () =>
        tryHttp(serverUrl, '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: wallet.address,
            sender_name: senderName,
            timestamp,
            nonce,
            text,
            // Replay-safe v2 envelope signed locally; private key never leaves this machine.
            signature: signRaw(envelope, wallet.privRaw)
          })
        }),
      (engine, watcher) => {
        const signedTx = buildSignedTransfer({
          wallet,
          to: engine.bankAddress,
          amount: '0.000001',
          memo,
          nonce: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1000)
        });
        return {
          ok: true,
          mode: 'offline-direct-engine',
          receipt: watcher.processSignedTransaction(signedTx)
        };
      }
    );
  } else if (cmd === 'chat-read') {
    output = await callMcpTool(serverUrl, 'chat_read', { limit: Number(args.limit || 25) });
  } else if (cmd === 'feed') {
    output = await callMcpTool(serverUrl, 'feed_recent', { limit: Number(args.limit || 25) });
  } else if (cmd === 'tx-templates') {
    const tool = String(args.tool || 'dice_place_bet');
    output = await callMcpTool(serverUrl, 'tx_templates', {
      tool,
      address: args.address || wallet.address,
      amount_poa: args.amount,
      target_bps: args.over || args.under ? Math.round(Number(args.over || args.under) * 100) : 4950,
      direction: args.over ? 'over' : 'under',
      count: args.count ? Number(args.count) : undefined,
      client_seed: args.seed,
      lock_epochs: args.epochs !== undefined ? Number(args.epochs) : undefined,
      bps: args.bps !== undefined ? Number(args.bps) : undefined,
      shares: args.shares !== undefined ? String(args.shares) : undefined,
      text: args.message
    });
  } else if (cmd === 'tx-status') {
    const txid = String(args.txid || args._[1] || '');
    if (!txid) throw new Error('Pass --txid <64-hex-txid>');
    output = await callMcpTool(serverUrl, 'tx_status', { txid });
  } else if (cmd === 'wallet-balance') {
    const address = String(args.address || args._[1] || wallet.address);
    output = await callMcpTool(serverUrl, 'wallet_balance', { address });
  } else if (cmd === 'sweep-dev') {
    output = await withOfflineFallback(
      () =>
        tryHttp(serverUrl, '/api/dev/sweep', {
          method: 'POST',
          headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {}
        }),
      (engine) => ({
        ok: true,
        mode: 'offline-direct-engine',
        ...engine.sweepDevReserve()
      })
    );
  } else if (cmd === 'audit') {
    output = await withOfflineFallback(
      () => tryHttp(serverUrl, '/api/audit'),
      (engine) => ({
        mode: 'offline-direct-engine',
        ...engine.verifySystemInvariants()
      })
    );
  } else if (cmd === 'offline-tx') {
    const action = String(args.action || 'BET').toUpperCase();
    const amountPoa = String(args.amount || (action === 'LP_WITHDRAW' ? '0.000001' : '10.000000'));
    const direction = args.over ? 'over' : 'under';
    const targetBps = Math.round(Number(args.over || args.under || 49.5) * 100);
    const memo = formatDiceMemo({
      action,
      direction,
      targetBps,
      clientSeed: args.seed || 'offline-seed-01',
      lockEpochs: Number(args.epochs || 0),
      bps: Number(args.bps || 10000),
      shares: args.shares ? String(args.shares) : undefined,
      text: args.message || 'Offline memo'
    });
    let toAddr = args.to || process.env.POA_DICE_BANK_ADDRESS || null;
    if (!toAddr && !forceOffline) {
      const st = await tryHttp(serverUrl, '/api/state').catch(() => null);
      if (st?.bankAddress) toAddr = st.bankAddress;
    }
    if (!toAddr || !isValidPoaAddress(toAddr)) {
      throw new Error(
        'Bank vault address required for offline-tx: pass --to <poa1BankAddress> or set POA_DICE_BANK_ADDRESS (never defaults to the dev reserve address).'
      );
    }
    const nodeUrl = args.node || process.env.POA_MINEPOA_NODE || 'https://minepoa.com';
    let nonce = args.nonce !== undefined ? Number(args.nonce) : 1;
    let parents = [];
    if (!forceOffline && args.nonce === undefined) {
      const client = new MinepoaClient({ nodeUrl });
      const [liveNonce, liveParents] = await Promise.all([
        client.nextNonce(wallet.address).catch(() => 1),
        client.getTipParents().catch(() => [])
      ]);
      nonce = liveNonce;
      parents = liveParents;
    }
    const signedTx = buildSignedTransfer({
      wallet,
      to: toAddr,
      amount: amountPoa,
      memo,
      nonce,
      parents
    });
    output = {
      ok: true,
      mode: 'pure-on-chain-memo-builder',
      walletAddress: wallet.address,
      bankAddress: toAddr,
      memo,
      signedTransaction: signedTx,
      poaCliCommand: `node poa.mjs send --node ${nodeUrl} --wallet ~/.poa --to ${toAddr} --amount ${amountPoa} --memo "${memo}"`
    };
  } else {
    throw new Error(`Unknown command: ${cmd}. Supported: ${SUPPORTED_COMMANDS.join(', ')}`);
  }

  console.log(redactSecrets(JSON.stringify(output, null, 2), wallet.privkey));
}

main().catch((err) => {
  console.error(redactSecrets(JSON.stringify({ ok: false, error: err.message })));
  process.exit(1);
});
